/**
 * Redmine MCP-сервер — этап 1 (read-only, аналитика neurodeck).
 *
 * Аутентификация: ЭКСКЛЮЗИВНО Basic Auth (логин+пароль). API-ключ шлётся только
 * если Basic не задан — одновременно их слать нельзя: Redmine при наличии
 * X-Redmine-API-Key аутентифицируется по ключу и отдаёт 401, игнорируя Basic.
 * На <YOUR_REDMINE_HOST> nginx требует Basic Auth. Все фильтры (assigned_to_id,
 * status_id, project_id, due_date) работают без admin-прав — проверено
 * scripts/redmine-discover.py (никаких 401).
 *
 * Дизайн: MCP отдаёт ДАННЫЕ, анализ/группировку делает агент. Исключение —
 * analyze_team_load: компактный счётчик по конфигурируемому списку разрабов
 * (использует total_count, не тянет тела задач лишний раз).
 *
 * Запуск: node dist/index.js  (stdio transport)
 * Env: REDMINE_BASE_URL + (REDMINE_API_KEY | REDMINE_LOGIN + REDMINE_PASSWORD)
 *      REDMINE_PROJECT       — slug дефолтного проекта (neurodeck)
 *      REDMINE_TEAM_CONFIG   — путь к config/team.json (реестр команды + статусы)
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from "node:fs";
import { join, resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { fetch as diFetch, ProxyAgent } from "undici";  // для team_digest: DeepInfra через прокси
import JSON5 from "json5";                               // для compile_task: парс реестра projects.json5

// ─── Config ───────────────────────────────────────────────────────────────────

// OpenClaw оставляет ${VAR} как литерал, если переменная резолвится в пустоту.
// Такой нерезолвнутый плейсхолдер (и пустую строку) считаем отсутствующим значением —
// иначе, например, "${REDMINE_API_KEY}" уедет в X-Redmine-API-Key и сломает auth.
const clean = (v?: string): string => {
  const s = (v ?? "").trim();
  return /^\$\{.*\}$/.test(s) ? "" : s;
};

const BASE_URL = clean(process.env.REDMINE_BASE_URL);
const API_KEY  = clean(process.env.REDMINE_API_KEY);
const LOGIN    = clean(process.env.REDMINE_LOGIN);
const PASSWORD = clean(process.env.REDMINE_PASSWORD);
const DEFAULT_PROJECT = clean(process.env.REDMINE_PROJECT);
const TEAM_CONFIG_PATH = clean(process.env.REDMINE_TEAM_CONFIG);

if (!BASE_URL) {
  console.error("[redmine-mcp] REDMINE_BASE_URL не задан");
  process.exit(1);
}
const useBasicAuth = Boolean(LOGIN && PASSWORD);
if (!useBasicAuth && !API_KEY) {
  console.error("[redmine-mcp] нужно REDMINE_API_KEY или REDMINE_LOGIN + REDMINE_PASSWORD");
  process.exit(1);
}

// ─── Team registry (config/team.json) ──────────────────────────────────────────

type Developer = { id: number; name: string; login?: string; role?: string };
type StatusGroup = { ids: number[]; names: string[]; meaning: string; closed?: boolean };
type RoleBucket = { ids: number[]; label: string };
type TeamConfig = {
  project?: { slug: string; id: number; name: string };
  core_developers?: Developer[];
  dev_pool_account?: { id: number; name: string };
  agent_account?: { id: number; name: string };          // служебный Redmine-аккаунт агентов-исполнителей (ADR-0026, Agent <ID>)
  roles?: Record<string, RoleBucket>;
  pipeline_order?: string[];
  statuses?: Record<string, StatusGroup>;
  overdue_scope?: { status_ids: number[]; meaning?: string };
  trackers?: Record<string, { ids: number[]; names: string[]; meaning: string }>;
  priorities?: Array<{ id: number; name: string; default?: boolean }>;
};

let TEAM: TeamConfig = {};
if (TEAM_CONFIG_PATH) {
  try {
    TEAM = JSON.parse(readFileSync(TEAM_CONFIG_PATH, "utf-8")) as TeamConfig;
  } catch (e) {
    console.error(`[redmine-mcp] не прочитал REDMINE_TEAM_CONFIG (${TEAM_CONFIG_PATH}): ${e}`);
  }
}

/** ID первого статуса из группы реестра, либо fallback. */
function statusIds(group: string, fallback: number[]): number[] {
  return TEAM.statuses?.[group]?.ids ?? fallback;
}
const IN_PROGRESS = statusIds("in_progress", [2]);
const PAUSED      = statusIds("paused", [10]);
const CODE_REVIEW = statusIds("code_review", [13]);
const EXECUTED    = statusIds("executed_dev", [27]);
const REWORK      = statusIds("rework", [8]);
const FAILED_TEST = statusIds("failed", [26]);
// Просрочку считаем ТОЛЬКО по статусам, где задача в активных руках разраба
// (В работе / На исполнение / На доработке / Приостановлена / Не пройдено).
// status_id=open ловил бы Исполнено/ревью/тестирование — там due_date про доставку, не про разраба.
const OVERDUE_SCOPE = TEAM.overdue_scope?.status_ids ?? [2, 20, 8, 10, 26];

// id→имя статуса (из реестра); неизвестный id → "#id". Для таймлайна истории.
const statusNameById = (() => {
  const m = new Map<number, string>();
  for (const g of Object.values(TEAM.statuses ?? {})) {
    (g.ids ?? []).forEach((id, i) => m.set(id, g.names?.[i] ?? `#${id}`));
  }
  return (id: number | null | undefined): string => (id == null ? "?" : m.get(id) ?? `#${id}`);
})();

// Закрытые статусы (для детекции переоткрытия): из групп с closed:true (Решена/В пуле/Протухло).
const CLOSED_STATUS_IDS = new Set<number>(
  Object.values(TEAM.statuses ?? {}).filter((g) => g.closed).flatMap((g) => g.ids ?? []),
);

// Касты: ids по роли + обратная разметка id→лейбл касты (для группировок/детейла).
function roleIds(role: string): number[] { return TEAM.roles?.[role]?.ids ?? []; }
const idToRoleLabel = (() => {
  const m = new Map<number, string>();
  for (const r of Object.values(TEAM.roles ?? {})) {
    for (const id of r.ids ?? []) if (!m.has(id)) m.set(id, r.label);
  }
  return (id: number | null | undefined): string | null => (id == null ? null : m.get(id) ?? null);
})();

// ─── HTTP ────────────────────────────────────────────────────────────────────

function authHeaders(): Record<string, string> {
  const h: Record<string, string> = { Accept: "application/json" };
  // Basic Auth имеет приоритет и идёт ЭКСКЛЮЗИВНО: если шлём ещё и X-Redmine-API-Key,
  // Redmine аутентифицируется по ключу и отвечает 401, игнорируя валидный Basic.
  if (useBasicAuth) {
    h["Authorization"] = `Basic ${Buffer.from(`${LOGIN}:${PASSWORD}`).toString("base64")}`;
  } else if (API_KEY) {
    h["X-Redmine-API-Key"] = API_KEY;
  }
  return h;
}

// Глобальный семафор: <YOUR_REDMINE_HOST> отдаёт пустой 500 при всплеске коннектов
// (analyze_team_load шлёт десятки count-запросов). Держим поток вежливым.
const MAX_CONCURRENT = 6;
let active = 0;
const waiters: Array<() => void> = [];
async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= MAX_CONCURRENT) await new Promise<void>((r) => waiters.push(r));
  active++;
  try {
    return await fn();
  } finally {
    active--;
    waiters.shift()?.();
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function redmineGet(path: string, params: Record<string, string> = {}, retries = 2): Promise<Record<string, unknown>> {
  const qs = new URLSearchParams(params).toString();
  const url = `${BASE_URL!.replace(/\/$/, "")}${path}${qs ? "?" + qs : ""}`;
  for (let attempt = 0; ; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15_000);
    try {
      const res = await withSlot(() => fetch(url, { headers: authHeaders(), signal: ctrl.signal }));
      // 5xx — обычно транзиентная икота Redmine/nginx под нагрузкой: retry с бэкоффом.
      // (Детерминированный 500 на multi-status_id мы НЕ генерим — шлём по одному статусу.)
      if (res.status >= 500 && attempt < retries) {
        clearTimeout(timer);
        await sleep(300 * (attempt + 1));
        continue;
      }
      if (!res.ok) throw new Error(`Redmine ${res.status} ${res.statusText}: ${await res.text()}`);
      return (await res.json()) as Record<string, unknown>;
    } catch (e) {
      // сетевой сбой/таймаут — тоже ретраим, дальше пробрасываем
      if (attempt < retries && (e instanceof TypeError || (e as Error)?.name === "AbortError")) {
        clearTimeout(timer);
        await sleep(300 * (attempt + 1));
        continue;
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }
}

// ВНИМАНИЕ: <YOUR_REDMINE_HOST> отдаёт 500 на список статусов в одном запросе
// (status_id=a,b,c и status_id[]=...). Поэтому везде, где нужно несколько статусов,
// шлём по одному и склеиваем/бакетим локально (search_issues, analyze_team_load).

/** Постранично тянет все записи (limit/offset), с защитным капом по страницам. */
async function redmineGetAll(path: string, key: string, params: Record<string, string> = {}, maxPages = 10): Promise<Array<Record<string, unknown>>> {
  const out: Array<Record<string, unknown>> = [];
  let offset = 0;
  const limit = 100;
  for (let page = 0; page < maxPages; page++) {
    const data = await redmineGet(path, { ...params, limit: String(limit), offset: String(offset) });
    const items = (data[key] ?? []) as Array<Record<string, unknown>>;
    out.push(...items);
    const total = (data["total_count"] as number) ?? items.length;
    offset += items.length;
    if (offset >= total || items.length === 0) break;
  }
  return out;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const todayStr = () => new Date().toISOString().slice(0, 10);
/** YYYY-MM-DD ровно N дней назад (для фильтра updated_on>=). */
const daysAgoStr = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

/** Дней с даты (ISO/YYYY-MM-DD) до сегодня; null если дата пустая/кривая. */
function daysSince(iso?: string | null): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? null : Math.floor((Date.now() - t) / 86_400_000);
}

/**
 * Чистит текст для контекста модели. Тестировщики вставляют картинки прямо в текст
 * примечаний/описаний как base64 data-URI — без вычистки они переполняют окно.
 * Режем `data:<mime>;base64,<...>` (обрамление )/"/!/пробелом обрывает совпадение) и
 * «голые» длинные base64-блоки. Плюс схлопываем лишние пустые строки.
 */
function cleanText(s: unknown): string {
  let t = typeof s === "string" ? s : s == null ? "" : String(s);
  t = t.replace(/data:[^;\s)]*;base64,[A-Za-z0-9+/=\r\n]+/g, "[картинка]");
  t = t.replace(/[A-Za-z0-9+/]{500,}={0,2}/g, "[вложение]");
  return t.replace(/\n{3,}/g, "\n\n").trim();
}

/** Скоуп проекта: явный → дефолтный. include_subprojects=false добавляет subproject_id=!*. */
function projectScope(projectId: string | undefined, includeSubprojects: boolean): Record<string, string> {
  const proj = projectId || DEFAULT_PROJECT;
  const p: Record<string, string> = {};
  if (proj) {
    p["project_id"] = proj;
    if (!includeSubprojects) p["subproject_id"] = "!*"; // Redmine: исключить подпроекты
  }
  return p;
}

const ok = (obj: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(obj, null, 2) }] });

// ── Компактизация (контекст модели мал — сырой Redmine-JSON переполняет окно) ──
const nameOf = (o: unknown): string | null => ((o as Record<string, unknown> | undefined)?.["name"] as string) ?? null;
const idOf   = (o: unknown): number | null => ((o as Record<string, unknown> | undefined)?.["id"] as number) ?? null;

/**
 * Один компактный ряд задачи — только поля для аналитики (без description/journals/custom_fields).
 * done_ratio НЕ включаем намеренно: на проекте «проценты готовности» ничего не значат —
 * прогресс судим по статусу и истории (get_issue_detail), не по проценту.
 */
function compactIssue(i: Record<string, unknown>) {
  return {
    id:              i["id"],
    subject:         i["subject"],
    status:          nameOf(i["status"]),
    status_id:       idOf(i["status"]),
    tracker:         nameOf(i["tracker"]),
    priority:        nameOf(i["priority"]),
    assigned_to:     nameOf(i["assigned_to"]),
    assigned_to_id:  idOf(i["assigned_to"]),
    fixed_version:   nameOf(i["fixed_version"]),
    due_date:        i["due_date"] ?? null,
    start_date:      i["start_date"] ?? null,
    estimated_hours: i["estimated_hours"] ?? null,
    updated_on:      i["updated_on"] ?? null,
  };
}

// ── История задачи (journals → анализ): таймлайн статусов + счётчики пинг-понга + примечания ──
type JournalDetail = { property?: string; name?: string; old_value?: string | null; new_value?: string | null };
type Journal = { user?: { id?: number; name?: string }; notes?: string; created_on?: string; details?: JournalDetail[] };

/** Сворачивает журнал в анализ: смены статуса, счётчики доработок/тестов/ревью/переоткрытий, чистые примечания. */
function summarizeJournals(journals: Journal[]) {
  const statusChanges: Array<{ date: string; by: string; from: number | null; to: number | null }> = [];
  let assignee_changes = 0;
  for (const j of journals) {
    for (const d of j.details ?? []) {
      if (d.property === "attr" && d.name === "status_id") {
        statusChanges.push({
          date: (j.created_on ?? "").slice(0, 10),
          by: j.user?.name ?? "?",
          from: d.old_value != null && d.old_value !== "" ? Number(d.old_value) : null,
          to:   d.new_value != null && d.new_value !== "" ? Number(d.new_value) : null,
        });
      } else if (d.property === "attr" && d.name === "assigned_to_id") {
        assignee_changes++;
      }
    }
  }
  const enteredCount = (ids: number[]) => statusChanges.filter((c) => c.to != null && ids.includes(c.to)).length;
  const counters = {
    rework:        enteredCount(REWORK),
    failed_test:   enteredCount(FAILED_TEST),
    review_rounds: enteredCount(CODE_REVIEW),
    reopened:      statusChanges.filter((c) => c.from != null && CLOSED_STATUS_IDS.has(c.from) && c.to != null && !CLOSED_STATUS_IDS.has(c.to)).length,
    assignee_changes,
  };
  const flags: string[] = [];
  if (counters.rework > 0)        flags.push(`↩ ${counters.rework}× на доработке`);
  if (counters.failed_test > 0)   flags.push(`❌ ${counters.failed_test}× не прошла тестирование`);
  if (counters.review_rounds > 2) flags.push(`🔁 ${counters.review_rounds} раундов ревью`);
  if (counters.reopened > 0)      flags.push(`♻ переоткрывалась ${counters.reopened}×`);
  if (counters.assignee_changes > 3) flags.push(`👥 переназначалась ${counters.assignee_changes}×`);

  const status_timeline = statusChanges.map((c) => ({
    date: c.date, by: c.by, from: statusNameById(c.from), to: statusNameById(c.to),
  }));
  const recent_notes = journals
    .filter((j) => (j.notes ?? "").trim())
    .slice(-5)
    .map((j) => ({ date: (j.created_on ?? "").slice(0, 10), by: j.user?.name ?? "?", note: cleanText(j.notes).slice(0, 400) }));

  const lastStatusDate = statusChanges.length ? statusChanges[statusChanges.length - 1].date : null;
  return { counters, flags, status_timeline, recent_notes, lastStatusDate };
}

// ─── Server ───────────────────────────────────────────────────────────────────

const server = new McpServer({ name: "redmine-mcp", version: "0.5.0" });

// ── get_issue ──────────────────────────────────────────────────────────────────
server.tool(
  "get_issue",
  "Получить задачу Redmine по номеру (без журнала)",
  { id: z.number().int().positive() },
  async ({ id }) => ok(await redmineGet(`/issues/${id}.json`)),
);

// ── get_issue_detail ────────────────────────────────────────────────────────────
server.tool(
  "get_issue_detail",
  `Задача + АНАЛИЗ истории (не сырой дамп журнала). Возвращает: компактные поля, возраст,
сколько дней в текущем статусе, таймлайн смен статуса, счётчики пинг-понга (rework=сколько
раз на доработке, failed_test=сколько раз не прошла тестирование, review_rounds, reopened),
флаги и последние примечания (base64-картинки вычищены). Для «что с задачей», «почему
застряла», «сколько раз гоняли». done_ratio НЕ показываем — он на проекте ничего не значит.`,
  { id: z.number().int().positive() },
  async ({ id }) => {
    const data = await redmineGet(`/issues/${id}.json`, { include: "journals" });
    const it = (data["issue"] ?? {}) as Record<string, unknown>;
    const s = summarizeJournals((it["journals"] as Journal[]) ?? []);
    const createdDay = (it["created_on"] as string | undefined)?.slice(0, 10) ?? null;
    return ok({
      ...compactIssue(it),
      role_of_assignee: idToRoleLabel(idOf(it["assigned_to"])),
      age_days:       daysSince(it["created_on"] as string),
      days_in_status: daysSince(s.lastStatusDate ?? createdDay),
      last_activity:  it["updated_on"] ?? null,
      description:    cleanText(it["description"]).slice(0, 1200),
      flags:          s.flags,
      counters:       s.counters,
      status_timeline: s.status_timeline,
      recent_notes:   s.recent_notes,
    });
  },
);

// ── list_issues ─────────────────────────────────────────────────────────────────
server.tool(
  "list_issues",
  `Список задач Redmine с фильтрами. Проект по умолчанию — neurodeck (из конфига).
Фильтры дат принимают: YYYY-MM-DD | >=YYYY-MM-DD | <=YYYY-MM-DD | ><A|B (диапазон).
Сортировка sort: "due_date:asc", "priority:desc", "updated_on:desc".
status_id: "open" | "closed" | "*" | ОДИН числовой ID. ВАЖНО: список статусов через
запятую этот Redmine НЕ принимает (отдаёт 500) — для нескольких статусов делай
отдельные вызовы. Для нагрузки по разрабам используй analyze_team_load.`,
  {
    status_id:           z.string().optional().describe("open | closed | * | один ID (НЕ список через запятую — Redmine 500-ит)"),
    assigned_to_id:      z.string().optional().describe("ID пользователя или 'me'"),
    priority_id:         z.string().optional(),
    fixed_version_id:    z.string().optional().describe("ID релиза/версии"),
    tracker_id:          z.string().optional(),
    project_id:          z.string().optional().describe("slug/ID проекта (иначе дефолтный)"),
    include_subprojects: z.boolean().default(true).describe("включать подпроекты (AER/BRS/регионы)"),
    due_date:            z.string().optional(),
    created_on:          z.string().optional(),
    updated_on:          z.string().optional(),
    sort:                z.string().optional(),
    limit:               z.number().int().min(1).max(100).default(25),
  },
  async (a) => {
    const p = projectScope(a.project_id, a.include_subprojects);
    p["limit"] = String(a.limit);
    for (const k of ["status_id", "assigned_to_id", "priority_id", "fixed_version_id", "tracker_id", "due_date", "created_on", "updated_on", "sort"] as const) {
      const v = a[k];
      if (v) p[k] = v;
    }
    const data = await redmineGet("/issues.json", p);
    const issues = ((data["issues"] as Array<Record<string, unknown>>) ?? []).map(compactIssue);
    // total_count — всего под фильтр (может быть > limit); issues — текущая страница, компактно.
    return ok({ total_count: data["total_count"], offset: data["offset"], limit: data["limit"], returned: issues.length, issues });
  },
);

// ── search_issues ────────────────────────────────────────────────────────────────
server.tool(
  "search_issues",
  `Широкий поиск/агрегация задач ОДНИМ вызовом — вместо цикла «дёрни по каждому исполнителю».
Пагинирует ВНУТРИ (fetch_all:true — проходит все страницы, не только первую), принимает
НЕСКОЛЬКО статусов/исполнителей (Redmine 500-ит на список статусов через запятую — тул шлёт
по одному и склеивает с дедупом) и группирует результат по выбранному полю на своей стороне.
Используй для «задачи по статусам X,Y с группировкой по исполнителям/релизам», обзоров беклога,
охвата сотен задач. detail:"counts" (дефолт) — счётчики групп + по ~5 примеров (узкий вывод);
detail:"rows" — компактные ряды, когда нужны конкретные задачи.`,
  {
    status_id:           z.string().optional().describe("один: open|closed|*|числовой ID. Для нескольких — status_ids"),
    status_ids:          z.array(z.number()).optional().describe("несколько статусов (шлются по одному, склеиваются)"),
    assigned_to_id:      z.string().optional().describe("один исполнитель (ID или 'me')"),
    assigned_to_ids:     z.array(z.number()).optional().describe("несколько исполнителей (по одному + дедуп)"),
    priority_id:         z.string().optional(),
    fixed_version_id:    z.string().optional().describe("ID релиза/версии"),
    tracker_id:          z.string().optional(),
    project_id:          z.string().optional().describe("slug/ID проекта (иначе дефолтный)"),
    include_subprojects: z.boolean().default(true),
    due_date:            z.string().optional().describe("YYYY-MM-DD | >=… | <=… | ><A|B"),
    created_on:          z.string().optional(),
    updated_on:          z.string().optional(),
    sort:                z.string().optional().describe('"updated_on:desc" | "due_date:asc" | "priority:desc"'),
    group_by:            z.enum(["assigned_to", "status", "fixed_version", "tracker", "priority", "none"]).default("none"),
    fetch_all:           z.boolean().default(false).describe("пройти ВСЕ страницы (кап ~2000); иначе одна страница limit"),
    detail:              z.enum(["counts", "rows"]).default("counts"),
    limit:               z.number().int().min(1).max(100).default(50).describe("размер одной страницы (если fetch_all=false)"),
  },
  async (a) => {
    const base = projectScope(a.project_id, a.include_subprojects);
    for (const k of ["priority_id", "fixed_version_id", "tracker_id", "due_date", "created_on", "updated_on", "sort"] as const) {
      const v = a[k];
      if (v) base[k] = v;
    }
    // Раскрутка по статусам × исполнителям: каждый — отдельный запрос (список статусов = 500),
    // результаты склеиваем с дедупом по id.
    const statusList: Array<string | undefined> = a.status_ids?.length ? a.status_ids.map(String) : [a.status_id];
    const assigneeList: Array<string | undefined> = a.assigned_to_ids?.length ? a.assigned_to_ids.map(String) : [a.assigned_to_id];

    const seen = new Map<number, Record<string, unknown>>();
    const MAX = 2000;
    let truncated = false;
    outer: for (const sid of statusList) {
      for (const aid of assigneeList) {
        const params = { ...base };
        if (sid) params["status_id"] = sid;
        if (aid) params["assigned_to_id"] = aid;
        const rows = a.fetch_all
          ? await redmineGetAll("/issues.json", "issues", params, 20)
          : ((await redmineGet("/issues.json", { ...params, limit: String(a.limit) }))["issues"] as Array<Record<string, unknown>>) ?? [];
        for (const r of rows) {
          const id = r["id"] as number;
          if (!seen.has(id)) seen.set(id, r);
          if (seen.size >= MAX) { truncated = true; break outer; }
        }
      }
    }

    const all = [...seen.values()].map(compactIssue);
    const total = all.length;

    if (a.group_by === "none") {
      const issues = a.detail === "rows" ? all : all.slice(0, 25);
      return ok({ total, truncated, detail: a.detail, returned: issues.length, issues });
    }

    const keyOf = (i: ReturnType<typeof compactIssue>): string => {
      switch (a.group_by) {
        case "assigned_to":   return i.assigned_to ? `${i.assigned_to} (#${i.assigned_to_id})` : "— не назначен —";
        case "status":        return i.status ?? "—";
        case "fixed_version": return i.fixed_version ?? "— без версии —";
        case "tracker":       return i.tracker ?? "—";
        case "priority":      return i.priority ?? "—";
        default:              return "—";
      }
    };
    const buckets = new Map<string, Array<ReturnType<typeof compactIssue>>>();
    for (const i of all) {
      const k = keyOf(i);
      let arr = buckets.get(k);
      if (!arr) { arr = []; buckets.set(k, arr); }
      arr.push(i);
    }
    const groups = [...buckets.entries()]
      .map(([key, items]) => ({
        key,
        count: items.length,
        ...(a.group_by === "assigned_to" ? { role: idToRoleLabel(items[0].assigned_to_id) } : {}),
        samples: a.detail === "rows" ? items : items.slice(0, 5),
      }))
      .sort((x, y) => y.count - x.count);

    return ok({ total, truncated, group_by: a.group_by, detail: a.detail, groups });
  },
);

// ── discover ─────────────────────────────────────────────────────────────────────
server.tool(
  "discover",
  "Справочники Redmine одним вызовом: статусы (с is_closed), трекеры, приоритеты, проекты. Для первичной ориентации.",
  {},
  async () => {
    const [statuses, trackers, priorities, projects] = await Promise.all([
      redmineGet("/issue_statuses.json"),
      redmineGet("/trackers.json"),
      redmineGet("/enumerations/issue_priorities.json").catch(() => ({ issue_priorities: [] })),
      redmineGetAll("/projects.json", "projects"),
    ]);
    return ok({
      issue_statuses:  statuses["issue_statuses"],
      trackers:        trackers["trackers"],
      issue_priorities: (priorities as Record<string, unknown>)["issue_priorities"],
      projects: projects.map(p => ({ id: p["id"], identifier: p["identifier"], name: p["name"], parent: (p["parent"] as Record<string, unknown> | undefined)?.["id"] })),
    });
  },
);

// ── get_current_time ─────────────────────────────────────────────────────────
// Заземление по времени. ОРКЕСТРАТОР может не получать дату от OpenClaw, а изолированные
// тулзы (team_digest/review_mr) её не получают ВОВСЕ — без неё нельзя верно судить «просрочено»,
// «застряла N дней», планировать cron «по будням». Возвращаем МСК (Europe/Moscow, +03:00 —
// рабочий tz проекта/cron), ISO-дату для фильтров Redmine и день недели (для «по будням»).
server.tool(
  "get_current_time",
  `Текущие дата и время (МСК, Europe/Moscow). Зови, когда нужно заземлиться во времени:
оценить «просрочено / застряла N дней», посчитать окно (updated_within_days), запланировать cron
«по будням / в 9:00». Не угадывай дату — бери отсюда.`,
  {},
  async () => {
    const now = new Date();
    const tz = "Europe/Moscow";
    const parts = new Intl.DateTimeFormat("ru-RU", {
      timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", weekday: "long", hour12: false,
    }).formatToParts(now);
    const p = (t: string) => parts.find((x) => x.type === t)?.value ?? "";
    const date = `${p("year")}-${p("month")}-${p("day")}`;        // YYYY-MM-DD (для фильтров Redmine)
    const time = `${p("hour")}:${p("minute")}:${p("second")}`;    // HH:MM:SS МСК
    const weekday = p("weekday");                                  // понедельник…воскресенье
    // 1=Пн … 7=Вс (ISO), удобно для cron-логики «по будням» (1–5). Считаем из МСК-даты `date`
    // (чистая Y-M-D → UTC-интерпретация даёт верный день недели; getUTCDay(now) был бы НЕ согласован
    // с `weekday` у границы суток UTC↔МСК).
    const isoDow = ((new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7) + 1;
    return ok({
      timezone: tz, utc_offset: "+03:00",
      date, time, weekday, iso_dow: isoDow,
      datetime_msk: `${date} ${time} +03:00`,
      iso_utc: now.toISOString(),
    });
  },
);

// ── get_issue_statuses ─────────────────────────────────────────────────────────
server.tool("get_issue_statuses", "Справочник статусов Redmine (с флагом is_closed)", {}, async () => ok(await redmineGet("/issue_statuses.json")));

// ── list_trackers ──────────────────────────────────────────────────────────────
server.tool("list_trackers", "Справочник трекеров (типов задач)", {}, async () => ok(await redmineGet("/trackers.json")));

// ── list_projects ──────────────────────────────────────────────────────────────
server.tool("list_projects", "Список проектов Redmine", {}, async () => ok(await redmineGetAll("/projects.json", "projects")));

// ── list_versions ──────────────────────────────────────────────────────────────
server.tool(
  "list_versions",
  `Версии/релизы проекта. По умолчанию ТОЛЬКО открытые (status=open) — Redmine API
не фильтрует версии по статусу и отдаёт весь закрытый архив с 2020 (переполняет контекст),
поэтому фильтруем на нашей стороне. Передай status="all" если нужны закрытые/заблокированные.`,
  {
    project_id: z.string().optional().describe("slug/ID (иначе дефолтный)"),
    status:     z.enum(["open", "locked", "closed", "all"]).default("open"),
  },
  async ({ project_id, status }) => {
    const proj = project_id || DEFAULT_PROJECT;
    if (!proj) return ok({ error: "project_id не задан и REDMINE_PROJECT не настроен" });
    const data = await redmineGet(`/projects/${proj}/versions.json`);
    let versions = (data["versions"] as Array<Record<string, unknown>>) ?? [];
    if (status !== "all") versions = versions.filter(v => v["status"] === status);
    const rows = versions.map(v => ({
      id:          v["id"],
      name:        v["name"],
      status:      v["status"],
      due_date:    v["due_date"] ?? null,
      description: typeof v["description"] === "string" ? (v["description"] as string).slice(0, 160) : "",
    }));
    // По сроку: версии без due_date — в конец.
    rows.sort((a, b) => (a.due_date ? String(a.due_date) : "9999-99-99").localeCompare(b.due_date ? String(b.due_date) : "9999-99-99"));
    return ok({ project: proj, status_filter: status, total: rows.length, versions: rows });
  },
);

// ── list_project_members ─────────────────────────────────────────────────────────
server.tool(
  "list_project_members",
  "Участники проекта с ролями и user_id. Для поиска задач по ВСЕМ разработчикам (фильтр по роли 'Разработчик'/'Ведущий разработчик').",
  { project_id: z.string().optional().describe("slug/ID (иначе дефолтный)") },
  async ({ project_id }) => {
    const proj = project_id || DEFAULT_PROJECT;
    if (!proj) return ok({ error: "project_id не задан и REDMINE_PROJECT не настроен" });
    const members = await redmineGetAll(`/projects/${proj}/memberships.json`, "memberships");
    // Компактно: user_id, имя, роли
    const rows = members
      .filter(m => m["user"])
      .map(m => ({
        id:    (m["user"] as Record<string, unknown>)["id"],
        name:  (m["user"] as Record<string, unknown>)["name"],
        roles: (m["roles"] as Array<Record<string, unknown>> ?? []).map(r => r["name"]),
      }));
    return ok({ total: rows.length, members: rows });
  },
);

// ── bottleneck_analysis ─────────────────────────────────────────────────────
server.tool(
  "bottleneck_analysis",
  `Анализ бутылочных горлышек: на какой стадии pipeline (В работе / Code Review / Тестирование / …)
больше всего застрявших задач. Для каждой стадии: счётчик задач + сколько висят >7 и >14 дней +
топ-5 самых давно не двигавшихся. Самая забитая стадия выделяется как "bottleneck".
Параметры: project_id (по умолч. neurodeck), updated_within_days (быстрый срез).`,
  {
    project_id:          z.number().optional().describe("id проекта Redmine; по умолчанию — neurodeck"),
    updated_within_days: z.number().optional().describe("смотреть только задачи с активностью за N дн (быстрее)"),
  },
  async ({ project_id, updated_within_days }) => {
    try {
      return ok(await fnBottleneck({ project_id, updated_within_days }));
    } catch (e: any) { return ok({ error: e?.message ?? String(e) }); }
  },
);

// ── pipeline_velocity ───────────────────────────────────────────────────────
server.tool(
  "pipeline_velocity",
  `Тренды и скорость: сколько задач ЗАКРЫТО за последние N дней (throughput), среднее время цикла
(от создания до закрытия), % задач побывавших в "На доработке" (rework rate), недельные срезы.
Параметры: days — окно в днях (7/14/30/90, по умолч. 30), project_id.`,
  {
    days:       z.number().optional().describe("окно в днях: 7 (неделя), 14, 30 (месяц, по умолч.), 90 (квартал)"),
    project_id: z.number().optional().describe("id проекта Redmine; по умолчанию — neurodeck"),
  },
  async ({ days, project_id }) => {
    try {
      return ok(await fnVelocity({ days, project_id }));
    } catch (e: any) { return ok({ error: e?.message ?? String(e) }); }
  },
);

// ── get_team ───────────────────────────────────────────────────────────────────
server.tool(
  "get_team",
  "Реестр команды neurodeck из конфига: проект, ключевые разработчики (name→id), служебный аккаунт пула, семантика статусов и трекеров. Вызови это, чтобы знать ID разрабов и смысл статусов перед анализом.",
  {},
  async () => {
    if (!TEAM.core_developers) return ok({ error: "team config не загружен (REDMINE_TEAM_CONFIG не задан или файл не прочитан)" });
    return ok(TEAM);
  },
);

// ── analyze_team_load ────────────────────────────────────────────────────────────
server.tool(
  "analyze_team_load",
  `Нагрузка по касте (по умолчанию core_developers == backend_web). На КАЖДОГО — ОДИН
постраничный запрос его открытых задач, статусы бакетятся локально (раньше слал 6 count-
запросов на разраба → ловил 500 под всплеском). Счётчики: В работе / Приостановлена /
Code Review / Исполнено + просроченные + всего открытых, + флаги отчётности (0 в работе =
красный флаг, >1 паузы = тревога). role: backend_web|android|analysts|qa|devops (из get_team().roles);
если каста в конфиге пустая — вернёт это, не выдумывает людей. Компактно, без тел задач.
СКОРОСТЬ: на проекте у задач огромные описания — полный проход по всем открытым медленный.
updated_within_days=N (напр. 14) считает ТОЛЬКО задачи, обновлённые за N дней — кратно быстрее,
но пропускает давно застывшие (зависшее «Исполнено», протухшее «В работе»). Без него — полный срез.`,
  {
    role:                z.string().optional().describe("каста из team.roles (backend_web|android|analysts|qa|devops); иначе core_developers"),
    developer_ids:       z.array(z.number()).optional().describe("явный список (приоритетнее role)"),
    updated_within_days: z.number().int().positive().optional().describe("считать только задачи, обновлённые за последние N дней (быстрый срез). Без параметра — все открытые (полный, медленнее)"),
    include_subprojects: z.boolean().default(true),
    project_id:          z.string().optional(),
  },
  async ({ role, developer_ids, updated_within_days, include_subprojects, project_id }) => {
    // Кого считаем: явный список > роль > core_developers.
    let ids: number[];
    if (developer_ids?.length) ids = developer_ids;
    else if (role)            ids = roleIds(role);
    else                      ids = (TEAM.core_developers ?? []).map((d) => d.id);
    if (ids.length === 0) {
      return ok({ error: role ? `каста "${role}" пуста в team.json (заполни roles.${role}.ids)` : "нет списка разработчиков (core_developers пуст и не передан developer_ids/role)" });
    }
    const nameById = new Map<number, string>();
    for (const d of TEAM.core_developers ?? []) nameById.set(d.id, d.name);

    const scope = projectScope(project_id, include_subprojects);
    const today = todayStr();
    const inSet = (sid: number | null, arr: number[]) => sid != null && arr.includes(sid);
    // Свежесть: фильтр updated_on>= режет застывший хвост (главный источник тяжёлых описаний) → кратно быстрее.
    const recentFilter: Record<string, string> = updated_within_days ? { updated_on: `>=${daysAgoStr(updated_within_days)}` } : {};

    // На каждого — один постраничный проход его открытых задач; локальная бакетизация.
    // try/catch на разраба: сбой по одному не роняет весь тул.
    const developers = await Promise.all(ids.map(async (id) => {
      let name = nameById.get(id) ?? `user#${id}`;
      try {
        const issues = await redmineGetAll("/issues.json", "issues", { ...scope, ...recentFilter, status_id: "open", assigned_to_id: String(id) }, 10);
        let total_open = 0, in_progress = 0, paused = 0, code_review = 0, executed = 0, overdue = 0;
        for (const raw of issues) {
          const sid = idOf(raw["status"]);
          total_open++;
          if (inSet(sid, IN_PROGRESS)) in_progress++;
          if (inSet(sid, PAUSED))      paused++;
          if (inSet(sid, CODE_REVIEW)) code_review++;
          if (inSet(sid, EXECUTED))    executed++;
          const due = raw["due_date"] as string | null;
          if (due && due <= today && inSet(sid, OVERDUE_SCOPE)) overdue++;
        }
        if (!nameById.has(id) && issues.length) name = nameOf(issues[0]["assigned_to"]) ?? name;
        const flags: string[] = [];
        if (in_progress === 0)    flags.push("🔴 0 задач в работе (халатность с отчётностью)");
        else if (in_progress > 3) flags.push(`⚠ ${in_progress} задач в работе (много)`);
        if (paused > 1)           flags.push(`⚠ ${paused} приостановленных (кандидаты в похороненные)`);
        if (overdue > 0)          flags.push(`⏰ ${overdue} просроченных`);
        return { id, name, total_open, in_progress, paused, code_review, executed, overdue, flags };
      } catch (e) {
        return { id, name, error: String((e as Error)?.message ?? e).slice(0, 200), flags: ["⚠ счётчики не получены (ошибка Redmine, см. error)"] };
      }
    }));

    return ok({
      generated: today,
      scope: scope["project_id"] ?? "global",
      role: developer_ids?.length ? "explicit" : role ?? "core_developers",
      include_subprojects,
      window: updated_within_days ? `только обновлённые за ${updated_within_days} дн (с ${daysAgoStr(updated_within_days)}) — застывшее НЕ учтено` : "все открытые (полный срез)",
      legend: "in_progress=В работе, paused=Приостановлена, code_review=ждёт ревью тимлида, executed=Исполнено (на develop, не на проде). done_ratio игнорируем.",
      developers,
    });
  },
);

// ═══ team_digest — АГЕНТНЫЙ аналитик (мини-агент внутри тула, своя модель) ════════
// Внутренний агент сам решает, по кому пройтись и куда углубиться, зовя redmine-функции
// ниже как СВОИ tools (function-calling), и пишет интерпретированный дайджест. Сырьё живёт
// здесь — наружу (в оркестратор) уходит только нарратив. Свой бюджет шагов (поводок).
const DI_BASE       = clean(process.env.DEEPINFRA_BASE_URL);
const DI_KEY        = clean(process.env.DEEPINFRA_API_KEY);
const ANALYST_MODEL = clean(process.env.REDMINE_ANALYST_MODEL) || clean(process.env.DEEPINFRA_MODEL);
const DI_PROXY      = clean(process.env.DEEPINFRA_PROXY) || clean(process.env.HTTPS_PROXY) || clean(process.env.HTTP_PROXY);
const ANALYST_MAX_STEPS = Math.max(2, Number(clean(process.env.ANALYST_MAX_STEPS) || "6"));
const ANALYST_TEMP  = Number(clean(process.env.ANALYST_TEMPERATURE) || "0.6");
const diDispatcher  = DI_PROXY ? new ProxyAgent(DI_PROXY) : undefined;

let ANALYST_PROMPT = "Ты — Redmine-аналитик neurodeck. Собери данные функциями (team_load/search_issues/issue_detail/get_team) и напиши краткий интерпретированный дайджест: что в работе, на что обратить внимание, риски. Опирайся ТОЛЬКО на данные функций — не выдумывай номера/статусы/причины.";
const ANALYST_PROMPT_PATH = clean(process.env.ANALYST_PROMPT_PATH);
if (ANALYST_PROMPT_PATH) {
  try { ANALYST_PROMPT = readFileSync(ANALYST_PROMPT_PATH, "utf-8"); }
  catch (e) { console.error(`[redmine-mcp] team_digest: не прочитал ANALYST_PROMPT_PATH (${ANALYST_PROMPT_PATH}): ${e}`); }
}
// _base.md — общая фактура (проект/статусы/команда), разделяемая с оркестратором. Если задан
// BASE_PROMPT_PATH — склеиваем base + ролевой, как deploy-config.sh для оркестратора (cat _base system).
// Единый источник правды по статусам/людям → один файл. Не задан → ролевой держит свою копию (фолбэк).
const BASE_PROMPT_PATH = clean(process.env.BASE_PROMPT_PATH);
if (BASE_PROMPT_PATH) {
  try { ANALYST_PROMPT = readFileSync(BASE_PROMPT_PATH, "utf-8") + "\n\n" + ANALYST_PROMPT; }
  catch (e) { console.error(`[redmine-mcp] team_digest: не прочитал BASE_PROMPT_PATH (${BASE_PROMPT_PATH}): ${e}`); }
}

// — Функции внутреннего агента (переиспользуют helpers основных тулзов) —
async function fnTeamLoad(a: { role?: string; developer_ids?: number[]; updated_within_days?: number }) {
  let ids: number[];
  if (a.developer_ids?.length) ids = a.developer_ids;
  else if (a.role)             ids = roleIds(a.role);
  else                         ids = (TEAM.core_developers ?? []).map((d) => d.id);
  if (ids.length === 0) return { error: a.role ? `каста "${a.role}" пуста в team.json` : "core_developers пуст" };
  const nameById = new Map<number, string>();
  for (const d of TEAM.core_developers ?? []) nameById.set(d.id, d.name);
  const scope = projectScope(undefined, true);
  const today = todayStr();
  const inSet = (sid: number | null, arr: number[]) => sid != null && arr.includes(sid);
  const recent: Record<string, string> = a.updated_within_days ? { updated_on: `>=${daysAgoStr(a.updated_within_days)}` } : {};
  const developers = await Promise.all(ids.map(async (id) => {
    let name = nameById.get(id) ?? `user#${id}`;
    try {
      const issues = await redmineGetAll("/issues.json", "issues", { ...scope, ...recent, status_id: "open", assigned_to_id: String(id) }, 10);
      let total_open = 0, in_progress = 0, paused = 0, code_review = 0, executed = 0, overdue = 0;
      for (const raw of issues) {
        const sid = idOf(raw["status"]); total_open++;
        if (inSet(sid, IN_PROGRESS)) in_progress++;
        if (inSet(sid, PAUSED))      paused++;
        if (inSet(sid, CODE_REVIEW)) code_review++;
        if (inSet(sid, EXECUTED))    executed++;
        const due = raw["due_date"] as string | null;
        if (due && due <= today && inSet(sid, OVERDUE_SCOPE)) overdue++;
      }
      if (!nameById.has(id) && issues.length) name = nameOf(issues[0]["assigned_to"]) ?? name;
      const flags: string[] = [];
      if (in_progress === 0)    flags.push("🔴 0 в работе");
      else if (in_progress > 3) flags.push(`⚠ ${in_progress} в работе (много)`);
      if (paused > 1)           flags.push(`⚠ ${paused} приостановленных`);
      if (overdue > 0)          flags.push(`⏰ ${overdue} просроченных`);
      return { id, name, total_open, in_progress, paused, code_review, executed, overdue, flags };
    } catch (e) { return { id, name, error: String((e as Error)?.message ?? e).slice(0, 150) }; }
  }));
  return { generated: today, window: a.updated_within_days ? `обновлённые за ${a.updated_within_days} дн` : "все открытые (полный, медленнее)", developers };
}

async function fnSearch(a: { status_ids?: number[]; status_id?: string; assigned_to_ids?: number[]; group_by?: string; updated_within_days?: number; sort?: string; fetch_all?: boolean }) {
  const base = projectScope(undefined, true);
  if (a.sort) base["sort"] = a.sort;
  if (a.updated_within_days) base["updated_on"] = `>=${daysAgoStr(a.updated_within_days)}`;
  const statusList: Array<string | undefined> = a.status_ids?.length ? a.status_ids.map(String) : [a.status_id ?? "open"];
  const assigneeList: Array<string | undefined> = a.assigned_to_ids?.length ? a.assigned_to_ids.map(String) : [undefined];
  const seen = new Map<number, Record<string, unknown>>();
  const MAX = 1500;
  outer: for (const sid of statusList) {
    for (const aid of assigneeList) {
      const params = { ...base };
      if (sid) params["status_id"] = sid;
      if (aid) params["assigned_to_id"] = aid;
      const rows = a.fetch_all
        ? await redmineGetAll("/issues.json", "issues", params, 15)
        : ((await redmineGet("/issues.json", { ...params, limit: "50" }))["issues"] as Array<Record<string, unknown>>) ?? [];
      for (const r of rows) { const id = r["id"] as number; if (!seen.has(id)) seen.set(id, r); if (seen.size >= MAX) break outer; }
    }
  }
  const all = [...seen.values()].map(compactIssue);
  if (!a.group_by || a.group_by === "none") return { total: all.length, issues: all.slice(0, 60) };
  const keyOf = (i: ReturnType<typeof compactIssue>): string => {
    switch (a.group_by) {
      case "assigned_to":   return i.assigned_to ? `${i.assigned_to} (#${i.assigned_to_id})` : "— не назначен —";
      case "status":        return i.status ?? "—";
      case "fixed_version": return i.fixed_version ?? "— без версии —";
      default:              return "—";
    }
  };
  const buckets = new Map<string, Array<ReturnType<typeof compactIssue>>>();
  for (const i of all) { const k = keyOf(i); let arr = buckets.get(k); if (!arr) { arr = []; buckets.set(k, arr); } arr.push(i); }
  const groups = [...buckets.entries()].map(([key, items]) => ({ key, count: items.length, samples: items.slice(0, 6) })).sort((x, y) => y.count - x.count);
  return { total: all.length, group_by: a.group_by, groups };
}

async function fnIssueDetail(a: { id: number }) {
  const data = await redmineGet(`/issues/${a.id}.json`, { include: "journals" });
  const it = (data["issue"] ?? {}) as Record<string, unknown>;
  const s = summarizeJournals((it["journals"] as Journal[]) ?? []);
  const createdDay = (it["created_on"] as string | undefined)?.slice(0, 10) ?? null;
  return {
    ...compactIssue(it),
    age_days: daysSince(it["created_on"] as string),
    days_in_status: daysSince(s.lastStatusDate ?? createdDay),
    description: cleanText(it["description"]).slice(0, 800),
    flags: s.flags, counters: s.counters, status_timeline: s.status_timeline, recent_notes: s.recent_notes,
  };
}

// ── fnBottleneck — анализ бутылочных горлышек (ADR-0025 доп.) ─────────────────
// Сканирует pipeline-стадии: в какой ступени больше всего застрявших задач.
// Для каждой стадии: счётчик задач + топ-5 самых давно не двигавшихся.
async function fnBottleneck(a: { project_id?: number; updated_within_days?: number; stages?: string[] }) {
  const today = todayStr();
  const scope = projectScope(a.project_id != null ? String(a.project_id) : undefined, true);
  const recent: Record<string, string> = a.updated_within_days ? { updated_on: `>=${daysAgoStr(a.updated_within_days)}` } : {};
  // Стадии из pipeline_order, исключая закрытые (Решена/В пуле/Протухло)
  const stages = a.stages ?? TEAM.pipeline_order?.filter((s) => !["Решена", "В пуле", "Протухло"].includes(s));
  if (!stages?.length) return { error: "pipeline_order не задан в team.json" };
  const result: { stage: string; status_id: number; count: number; stuck_gt_7d: number; stuck_gt_14d: number; top_stuck: Array<{ id: number; subject: string; days_stuck: number; dev: string }> }[] = [];
  for (const stageName of stages) {
    const grp = TEAM.statuses && Object.values(TEAM.statuses).find((g) => g.names?.includes(stageName));
    if (!grp?.ids?.length) continue;
    const sid = grp.ids[0];  // берём первый id из группы
    try {
      const params: Record<string, string> = { ...scope, ...recent, status_id: String(sid), sort: "updated_on:asc", limit: "100" };
      const data = await redmineGet("/issues.json", params);
      const issues = ((data["issues"] ?? []) as Array<Record<string, unknown>>).slice(0, 100);
      let stuck7 = 0, stuck14 = 0;
      const topStuck: Array<{ id: number; subject: string; days_stuck: number; dev: string }> = [];
      for (const iss of issues) {
        const upd = (iss["updated_on"] as string)?.slice(0, 10) ?? "";
        const days = upd ? Math.ceil((new Date(today).getTime() - new Date(upd).getTime()) / 86_400_000) : 0;
        if (days > 7) stuck7++;
        if (days > 14) stuck14++;
        if (topStuck.length < 5 && days > 3) {
          topStuck.push({ id: iss["id"] as number, subject: (iss["subject"] as string ?? "").slice(0, 120), days_stuck: days, dev: nameOf(iss["assigned_to"]) ?? "—" });
        }
      }
      result.push({ stage: stageName, status_id: sid, count: issues.length, stuck_gt_7d: stuck7, stuck_gt_14d: stuck14, top_stuck: topStuck });
    } catch (e) { result.push({ stage: stageName, status_id: sid, count: -1, stuck_gt_7d: 0, stuck_gt_14d: 0, top_stuck: [], }); }
  }
  // Сортируем: самая забитая стадия первой
  result.sort((a, b) => b.count - a.count);
  const bottleneck = result[0];
  return { generated: today, window: a.updated_within_days ? `обновлённые за ${a.updated_within_days} дн` : "все открытые", stages: result, bottleneck: bottleneck ? `${bottleneck.stage}: ${bottleneck.count} задач(и), ${bottleneck.stuck_gt_7d} висят >7 дн` : "нет данных" };
}

// ── fnVelocity — тренды: throughput, cycle time, rework rate ──────────────────
// Смотрит на НЕДАВНО закрытые задачи (Решена/В пуле) и считает:
//   - сколько закрыто за период (throughput)
//   - среднее время от создания до закрытия
//   - % задач, побывавших в «На доработке»
async function fnVelocity(a: { days?: number; project_id?: number }) {
  const windowDays = a.days ?? 30;
  const since = daysAgoStr(windowDays);
  const scope = projectScope(a.project_id != null ? String(a.project_id) : undefined, true);
  const today = todayStr();
  // Закрытые статусы (из team.json): resolved + in_pool
  const closedIds = [...(TEAM.statuses?.resolved?.ids ?? [3]), ...(TEAM.statuses?.in_pool?.ids ?? [12, 18])];
  const REWORK_ID = TEAM.statuses?.rework?.ids?.[0] ?? 8;
  let closed = 0, withRework = 0, totalCycleDays = 0;
  const perWeek: { week: string; closed: number; rework_pct: number; avg_cycle: number }[] = [];

  // Собираем закрытые задачи за период (пагинация — до 500)
  const params: Record<string, string> = { ...scope, sort: "updated_on:desc", limit: "100" };
  const allClosed: Array<{ id: number; created: string; closed: string; had_rework: boolean }> = [];
  for (const sid of closedIds) {
    try {
      const data = await redmineGet("/issues.json", { ...params, status_id: String(sid) });
      const issues = (data["issues"] ?? []) as Array<Record<string, unknown>>;
      for (const iss of issues) {
        const updated = (iss["updated_on"] as string)?.slice(0, 10) ?? "";
        if (updated < since) continue;  // закрыто до окна — пропускаем
        const created = (iss["created_on"] as string)?.slice(0, 10) ?? "";
        const cycle = created ? Math.ceil((new Date(updated).getTime() - new Date(created).getTime()) / 86_400_000) : 0;
        allClosed.push({ id: iss["id"] as number, created, closed: updated, had_rework: false, });
      }
    } catch { /* */ }
  }
  // Для top-N проверяем историю на реворк (первые 50 — чтобы не грузить Redmine 500 запросами)
  const toCheck = allClosed.slice(0, 50);
  if (toCheck.length > 0) {
    const reworkChecks = await Promise.all(toCheck.map(async (c) => {
      try {
        const data = await redmineGet(`/issues/${c.id}.json`, { include: "journals" });
        const journals = ((data as any)?.["issue"]?.["journals"] ?? []) as Journal[];
        const hadRework = journals.some((j) => j.details?.some((d) => d.name === "status_id" && String(d.new_value) === String(REWORK_ID)));
        return { ...c, had_rework: hadRework };
      } catch { return c; }
    }));
    for (const c of reworkChecks) {
      closed++;
      if (c.had_rework) withRework++;
      const cycle = c.created ? Math.ceil((new Date(c.closed).getTime() - new Date(c.created).getTime()) / 86_400_000) : 0;
      totalCycleDays += cycle;
    }
    // Недельные бакеты
    const weekMap = new Map<string, { closed: number; rework: number; cycle: number }>();
    for (const c of reworkChecks) {
      const d = new Date(c.closed);
      const weekStart = new Date(d.getTime() - d.getDay() * 86_400_000).toISOString().slice(0, 10);
      let w = weekMap.get(weekStart);
      if (!w) { w = { closed: 0, rework: 0, cycle: 0 }; weekMap.set(weekStart, w); }
      w.closed++;
      if (c.had_rework) w.rework++;
      const cycle = c.created ? Math.ceil((new Date(c.closed).getTime() - new Date(c.created).getTime()) / 86_400_000) : 0;
      w.cycle += cycle;
    }
    for (const [week, w] of weekMap) perWeek.push({ week, closed: w.closed, rework_pct: w.closed ? Math.round((w.rework / w.closed) * 100) : 0, avg_cycle: w.closed ? Math.round(w.cycle / w.closed) : 0 });
    perWeek.sort((a, b) => a.week.localeCompare(b.week));
  }
  const avgCycle = closed > 0 ? Math.round(totalCycleDays / closed) : 0;
  const reworkPct = closed > 0 ? Math.round((withRework / closed) * 100) : 0;
  const throughput = windowDays > 0 ? (closed / windowDays).toFixed(1) : "0";
  return { generated: today, window_days: windowDays, since, closed_total: closed, throughput_per_day: throughput, avg_cycle_days: avgCycle, rework_pct: reworkPct, rework_count: withRework, weekly: perWeek.slice(-6), _note: "rework проверен на top-50 закрытых (ограничение API). Полный охват — увеличь выборку." };
}

const ANALYST_TOOLS = [
  { type: "function", function: { name: "team_load", description: "Нагрузка по касте: на каждого разраба счётчики (в работе/пауза/ревью/исполнено/просрочено) + флаги. Без role — core_developers (5 ключевых backend). updated_within_days=N — быстрый срез по активным за N дн (без — полный, медленнее).", parameters: { type: "object", properties: { role: { type: "string", description: "backend_web|android|analysts|qa|devops; иначе core_developers" }, developer_ids: { type: "array", items: { type: "number" } }, updated_within_days: { type: "number" } } } } },
  { type: "function", function: { name: "search_issues", description: "Поиск/группировка задач. Для «список задач разраба» — assigned_to_ids:[id] + status_ids. group_by: assigned_to|status|fixed_version. sort напр. 'updated_on:asc' (давно не двигались). updated_within_days — окно.", parameters: { type: "object", properties: { status_ids: { type: "array", items: { type: "number" } }, status_id: { type: "string", description: "open|closed|* если без списка" }, assigned_to_ids: { type: "array", items: { type: "number" } }, group_by: { type: "string", enum: ["assigned_to", "status", "fixed_version", "none"] }, updated_within_days: { type: "number" }, sort: { type: "string" }, fetch_all: { type: "boolean" } } } } },
  { type: "function", function: { name: "issue_detail", description: "История/пинг-понг задачи: счётчики доработок/непрошедших тестов, дни в статусе, последние примечания. Для «почему застряла».", parameters: { type: "object", properties: { id: { type: "number" } }, required: ["id"] } } },
  { type: "function", function: { name: "get_team", description: "Реестр команды: касты (id разрабов по ролям), семантика статусов, pipeline. Зови, если нужны id или смысл статусов.", parameters: { type: "object", properties: {} } } },
  { type: "function", function: { name: "bottleneck", description: "Бутылочные горлышки: на какой стадии pipeline больше всего застрявших задач. Счётчики на стадию + топ-5 самых давних.", parameters: { type: "object", properties: { project_id: { type: "number" }, updated_within_days: { type: "number" } } } } },
  { type: "function", function: { name: "velocity", description: "Тренды: throughput (задач/день), среднее время цикла (создание→закрытие), % доработок. Недельные срезы за последние N дней (по умолч. 30).", parameters: { type: "object", properties: { days: { type: "number", description: "Окно, дн. 7/14/30 (по умолч.)/90." }, project_id: { type: "number" } } } } },
];
const ANALYST_FNS: Record<string, (a: any) => Promise<unknown> | unknown> = {
  team_load: fnTeamLoad, search_issues: fnSearch, issue_detail: fnIssueDetail, get_team: () => ({ core_developers: TEAM.core_developers, roles: TEAM.roles, statuses: TEAM.statuses, pipeline_order: TEAM.pipeline_order }),
  bottleneck: fnBottleneck, velocity: fnVelocity,
};

async function diChat(messages: unknown[], withTools: boolean): Promise<any> {
  const res = await diFetch(`${DI_BASE}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${DI_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: ANALYST_MODEL, messages, temperature: ANALYST_TEMP, max_tokens: 2500, ...(withTools ? { tools: ANALYST_TOOLS, tool_choice: "auto" } : {}) }),
    dispatcher: diDispatcher,
  });
  if (!res.ok) throw new Error(`DeepInfra ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = (await res.json()) as any;
  return data?.choices?.[0]?.message;
}

async function runAnalyst(query: string): Promise<string> {
  if (!DI_BASE || !DI_KEY || !ANALYST_MODEL) return "team_digest недоступен: в env redmine-MCP нет DEEPINFRA_BASE_URL / DEEPINFRA_API_KEY / REDMINE_ANALYST_MODEL.";
  const messages: any[] = [{ role: "system", content: ANALYST_PROMPT }, { role: "user", content: query }];
  for (let step = 0; step < ANALYST_MAX_STEPS; step++) {
    const msg = await diChat(messages, step < ANALYST_MAX_STEPS - 1);  // последний шаг — без тулзов: заставляем дать финальный ответ
    const toolCalls = msg?.tool_calls;
    if (!toolCalls?.length) return (msg?.content as string) || "(аналитик не дал ответа)";
    messages.push({ role: "assistant", content: msg.content ?? null, tool_calls: toolCalls });
    for (const tc of toolCalls) {
      const name = tc?.function?.name as string;
      let args: any = {};
      try { args = JSON.parse(tc?.function?.arguments || "{}"); } catch { /* битые args — пустые */ }
      let result: unknown;
      try { result = ANALYST_FNS[name] ? await ANALYST_FNS[name](args) : { error: `неизвестная функция ${name}` }; }
      catch (e) { result = { error: String((e as Error)?.message ?? e).slice(0, 300) }; }
      messages.push({ role: "tool", tool_call_id: tc.id, content: JSON.stringify(result).slice(0, 12000) });
    }
  }
  return "(аналитик исчерпал бюджет шагов без финального ответа)";
}

server.tool(
  "team_digest",
  `АГЕНТНЫЙ аналитик: САМ решает, по кому из разрабов пройтись и куда углубиться (история/пинг-понг),
и возвращает ГОТОВЫЙ интерпретированный дайджест-нарратив. Внутри — своя модель; сырьё в чат НЕ течёт.
Зови на «дайджест», «как загружены», «что протухает», «пройдись по <людям>». Передавай и контекст
из запроса пользователя (напр. «Эрик из отпуска завтра») — аналитик его учтёт.`,
  { query: z.string().describe("суть + контекст: «дайджест нагрузки за 2 нед», «пройдись по разработчикам — у кого затык», «что протухает в беклоге»") },
  async ({ query }) => ({ content: [{ type: "text" as const, text: await runAnalyst(query) }] }),
);

// ═══ compile_task — компилятор Redmine-задачи → ЧЕРНОВИК TaskSpec (ADR-0015) ══════
// agent-as-MCP (как team_digest): своя модель, изолирован. Переиспользует fnIssueDetail +
// DeepInfra-инфру (DI_BASE/DI_KEY/diDispatcher/diFetch — объявлены в блоке team_digest выше).
// Выход — черновик файлов TaskSpec в harness/tasks/ («?<id>.json» + «<id>.prompt.md»), которые
// подхватывает harness-MCP preview_task/run_task. НЕ запускает прогон (это делает тимлид после
// preview+апрува). Хранилище черновиков = harness/tasks/ с draft-префиксом «?» (легенда статусов);
// выделенное БД/redis-хранилище — горизонт (ADR-0015 §открытые вопросы).

// Корень репо агента: из env (OpenClaw раскрывает ${AGENT_REPO_ROOT}); фолбэк — от dist/index.js.
const ROOT = (() => {
  const env = clean(process.env.AGENT_REPO_ROOT);
  if (env) return env;
  try { return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", ".."); }  // dist → mcp-servers/redmine/dist → корень
  catch { return process.cwd(); }
})();
// Единая точка хранения черновиков compile_task (ADR-0015) — harness/queue/ (gitignored;
// горизонт — БД/redis). harness-MCP читает её первой при резолве TaskSpec по id.
const QUEUE_DIR      = clean(process.env.HARNESS_QUEUE_DIR) || join(ROOT, "harness", "queue");
const REGISTRY_PATH  = clean(process.env.PROJECTS_REGISTRY) || join(ROOT, "config", "projects.json5");
const DAG_PATH       = clean(process.env.HARNESS_DAG_PATH) || join(ROOT, "harness", "docs", "h1-module-dag.md");
const COMPILER_MODEL = clean(process.env.COMPILER_MODEL) || ANALYST_MODEL;  // ANALYST_MODEL = REDMINE_ANALYST_MODEL||DEEPINFRA_MODEL
const COMPILER_TEMP  = Number(clean(process.env.COMPILER_TEMPERATURE) || "0.3");

let COMPILER_PROMPT = "Ты — компилятор Redmine-задачи в черновик TaskSpec для harness. Верни СТРОГО один JSON-объект по схеме из инструкции. Не выдумывай scope/файлы; задача неясна → needs_clarification.";
const COMPILER_PROMPT_PATH = clean(process.env.COMPILER_PROMPT_PATH);
if (COMPILER_PROMPT_PATH) {
  try { COMPILER_PROMPT = readFileSync(COMPILER_PROMPT_PATH, "utf-8"); }
  catch (e) { console.error(`[redmine-mcp] compile_task: не прочитал COMPILER_PROMPT_PATH (${COMPILER_PROMPT_PATH}): ${e}`); }
}

// ── Figma helper: извлечь топ-уровневые фреймы с текстовым описанием ───────
type FigmaFrameInfo = { name: string; type: string; size: string; children: number; elements: string[] };
function extractTopFrames(node: any, depth: number): FigmaFrameInfo[] {
  if (!node || depth > 2) return [];
  const frames: FigmaFrameInfo[] = [];
  const isContainer = ["FRAME", "COMPONENT", "COMPONENT_SET", "SECTION"].includes(node.type);
  if (isContainer && depth <= 1) {
    const b = node.absoluteBoundingBox;
    const size = b ? `${Math.round(b.width)}×${Math.round(b.height)}` : "?";
    const elements: string[] = [];
    for (const child of (node.children ?? [])) {
      const el = describeFigmaChild(child);
      if (el) elements.push(el);
    }
    frames.push({ name: node.name, type: node.type, size, children: (node.children ?? []).length, elements: elements.slice(0, 15) });
  }
  for (const child of (node.children ?? [])) {
    frames.push(...extractTopFrames(child, depth + 1));
  }
  return frames;
}
function describeFigmaChild(node: any): string {
  const name = node.name || "";
  switch (node.type) {
    case "TEXT": {
      const txt = (node.characters || "").replace(/\n/g, " ").slice(0, 60);
      const fs = node.style?.fontSize ? `${node.style.fontSize}px` : "";
      const fw = node.style?.fontWeight ? ` w${node.style.fontWeight}` : "";
      return `TEXT "${txt}"${fs ? ` ${fs}${fw}` : ""}`;
    }
    case "RECTANGLE": case "ELLIPSE": case "LINE": {
      const b = node.absoluteBoundingBox;
      const s = b ? `${Math.round(b.width)}×${Math.round(b.height)}` : "?";
      return `${node.type} ${name} [${s}]`;
    }
    case "INSTANCE": return `INSTANCE ${name}`;
    case "FRAME": {
      const b = node.absoluteBoundingBox;
      const s = b ? `${Math.round(b.width)}×${Math.round(b.height)}` : "?";
      const n = (node.children ?? []).length;
      return `FRAME ${name} [${s}] (${n} эл.)`;
    }
    case "COMPONENT": return `COMPONENT ${name}`;
    case "VECTOR": case "STAR": case "POLYGON": case "BOOLEAN_OPERATION": return `${node.type} ${name}`;
    default: return "";
  }
}

// — Реестр репо (ADR-0006/0013): defaults.harness + per-project override + workRoots (services/libraries).
type RepoReg = { repoPath: string; scopeMode: string; target: boolean; contextMd?: string; models: Record<string, string> };
function loadRegistry(): { baseDir: string; repos: Record<string, RepoReg>; workRoots: string[]; workRootScope: string; models: Record<string, string> } {
  const raw = JSON5.parse(readFileSync(REGISTRY_PATH, "utf-8")) as any;
  const dh = raw?.defaults?.harness ?? {};
  const repos: Record<string, RepoReg> = {};
  for (const [name, p] of Object.entries<any>(raw?.projects ?? {})) {
    const h = p?.harness ?? {};
    repos[name] = {
      repoPath: String(p?.repoPath ?? ""),
      scopeMode: String(h.scopeMode ?? dh.scopeMode ?? "files"),
      target: Boolean(h.target ?? dh.target ?? false),
      contextMd: h.contextMd ? String(h.contextMd) : undefined,
      models: { ...(dh.models ?? {}), ...(h.models ?? {}) },
    };
  }
  return {
    baseDir: String(raw?.baseDir ?? ""),
    repos,
    workRoots: Array.isArray(dh.workRoots) ? dh.workRoots.map(String) : [],
    workRootScope: String(dh.workRootScope ?? "full"),
    models: dh.models ?? {},
  };
}
// Авто-допущенные репо под workRoots (services/*, libraries/*): каждый подкаталог = target=true, scope=full.
// Это гибрид-решение тимлида (контроль = апрув задачи в preview, не per-repo запись).
function discoverWorkRootRepos(reg: { baseDir: string; workRoots: string[]; workRootScope: string; models: Record<string, string> }): Record<string, RepoReg> {
  const out: Record<string, RepoReg> = {};
  for (const root of reg.workRoots) {
    const rootPath = join(reg.baseDir, root);
    let names: string[] = [];
    try { names = readdirSync(rootPath, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith(".")).map((d) => d.name); } catch { /* нет корня */ }
    for (const name of names) {
      if (out[name]) continue;                              // первый корень выигрывает при коллизии имён
      out[name] = { repoPath: join(rootPath, name), scopeMode: reg.workRootScope, target: true, models: reg.models };
    }
  }
  return out;
}

function loadDagExcerpt(maxChars = 6000): string {
  try { return readFileSync(DAG_PATH, "utf-8").slice(0, maxChars); } catch { return ""; }
}
// Структура верхнего уровня репо (папки/ключевые файлы) — заземление scope_paths под ЛЮБОЙ репо
// (Go-сервис, PHP-монолит, либа), без допущения о packages/modules.
function listTopLevel(repoPath: string): string[] {
  try {
    return readdirSync(repoPath, { withFileTypes: true })
      .filter((d) => !d.name.startsWith(".") && d.name !== "vendor" && d.name !== "node_modules")
      .map((d) => (d.isDirectory() ? d.name + "/" : d.name))
      .sort().slice(0, 40);
  } catch { return []; }
}

// Модель может вернуть JSON в ```-обёртке/с прозой — вытаскиваем первый сбалансированный {…}.
function extractJson(text: string): any | null {
  if (!text) return null;
  const t = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
  const start = t.indexOf("{");
  if (start < 0) { try { return JSON.parse(t); } catch { return null; } }
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < t.length; i++) {
    const c = t[i];
    if (inStr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}") { if (--depth === 0) { try { return JSON.parse(t.slice(start, i + 1)); } catch { return null; } } }
  }
  return null;
}
const kebab = (s: string): string =>
  s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "task";

async function diChatCompiler(messages: unknown[]): Promise<string> {
  const res = await diFetch(`${DI_BASE}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${DI_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: COMPILER_MODEL, messages, temperature: COMPILER_TEMP, max_tokens: 4000 }),
    dispatcher: diDispatcher,
  });
  if (!res.ok) throw new Error(`DeepInfra ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = (await res.json()) as any;
  return (data?.choices?.[0]?.message?.content as string) || "";
}

type CompileInput = { redmine_id: number; repo?: string; module?: string; category?: string; model?: string; extra?: string; write_to?: string; custom_path?: string; dry_run?: boolean; task_spec?: any };

// Сборка TaskSpec из черновика модели БЕЗ записи на диск и БЕЗ оценки (model/budget/attempts).
// Оценка — отдельный тул task_estimate. Запись — saveTaskSpec.
function buildTaskSpec(draft: any, input: CompileInput, reg: { repos: Record<string, RepoReg> }): Record<string, unknown> {
  const repoKey: string = draft.repo && reg.repos[draft.repo] ? draft.repo : "";
  const entry = reg.repos[repoKey];
  const lang: string = String(draft.lang ?? "").toLowerCase() || "?";
  const rawId = String(draft.id ?? "").trim();
  const safeId = rawId && /^[a-z0-9][a-z0-9-]*$/i.test(rawId) ? rawId.toLowerCase() : `redmine-${input.redmine_id}-${kebab(String(draft.title ?? ""))}`;
  const sources: string[] = [];
  for (const s of (draft.source_repos ?? []) as string[]) { const r = reg.repos[s]; if (r?.repoPath) sources.push(r.repoPath); }

  return {
    id: safeId,
    title: String(draft.title ?? "").slice(0, 120),
    redmine_id: String(input.redmine_id),
    repo: repoKey || "(не в реестре)",
    target: entry?.repoPath ?? "",
    lang,
    scope_paths: draft.scope_paths ?? [],
    sources: [...new Set(sources)],
    prompt_md: String(draft.prompt_md ?? "").trim(),
    rationale: draft.rationale ?? "",
    harness_target_allowed: Boolean(entry?.target),
    append_system_prompt_path: "harness/tasks/guardrails-product.md",
    suggested_category: input.category ?? draft.category ?? "medium",
    suggested_model: input.model || draft.suggested_model || null,
    estimated: false,
    compiled_at: new Date().toISOString(),
  };
}

function saveTaskSpec(spec: Record<string, unknown>, writeTo: string, customPath?: string): { spec_path: string; prompt_path: string } {
  const safeId = spec.id as string;
  const promptMd = (spec.prompt_md as string) || "";
  const targetDir = writeTo === "custom" && customPath ? dirname(customPath) : QUEUE_DIR;
  const specPath = writeTo === "custom" && customPath ? customPath : join(QUEUE_DIR, `?${safeId}.json`);
  const promptPath = writeTo === "custom" && customPath ? customPath.replace(/\.json$/, ".prompt.md") : join(QUEUE_DIR, `${safeId}.prompt.md`);

  const harnessSpec: Record<string, unknown> = {
    id: safeId,
    redmine_id: spec.redmine_id,
    target: spec.target,
    scopeMode: (spec.harness_target_allowed as boolean) ? "files" : "full",
    paths: spec.scope_paths ?? [],
    sources: spec.sources ?? [],
    model: spec.model ?? (spec.estimated ? null : "minimax-m3"),
    maxBudgetUsd: spec.maxBudgetUsd ?? 3,
    maxAttempts: spec.maxAttempts ?? 1,
    promptPath: `harness/queue/${safeId}.prompt.md`,
    appendSystemPromptPath: spec.append_system_prompt_path,
    tier: spec.tier || undefined,
    estimated: spec.estimated ?? false,
  };

  mkdirSync(dirname(specPath), { recursive: true });
  writeFileSync(specPath, JSON.stringify(harnessSpec, null, 2));
  writeFileSync(promptPath, promptMd + "\n");

  return { spec_path: specPath, prompt_path: promptPath };
}

async function runCompiler(input: CompileInput): Promise<any> {
  if (!DI_BASE || !DI_KEY || !COMPILER_MODEL) return { error: "compile_task недоступен: в env redmine-MCP нет DEEPINFRA_BASE_URL / DEEPINFRA_API_KEY / COMPILER_MODEL (фолбэк REDMINE_ANALYST_MODEL/DEEPINFRA_MODEL тоже пуст)." };

  // Если передан готовый task_spec — пропускаем LLM-компиляцию, сразу пишем
  if (input.task_spec) {
    const spec = typeof input.task_spec === "string" ? (() => { try { return JSON.parse(readFileSync(input.task_spec, "utf8")); } catch { return null; } })() : input.task_spec;
    if (!spec || !spec.id) return { error: "task_spec невалиден (нет поля id). Передай JSON-объект или путь к .json." };
    const wto = input.write_to || "harness_queue";
    if (input.dry_run) return ok({ dry_run: true, task_spec: spec, note: "Запись пропущена (dry_run=true)." });
    const sv = saveTaskSpec(spec, wto, input.custom_path);
    return ok({ saved: true, ...sv, task_id: spec.id, repo: spec.repo ?? "?", note: "TaskSpec записан. Для оценки: task_estimate." });
  }

  let issue: any;
  try { issue = await fnIssueDetail({ id: input.redmine_id }); }
  catch (e) { return { error: `не удалось получить задачу #${input.redmine_id}: ${String((e as Error)?.message ?? e).slice(0, 200)}` }; }

  // ── Figma: ищем ссылки на макеты в описании задачи ───────────────────────
  const FIGMA_TOKEN = clean(process.env.FIGMA_TOKEN);
  let figmaContext = "";
  if (FIGMA_TOKEN) {
    const descText = JSON.stringify(issue);  // description + notes в одном тексте
    const figmaUrls = descText.match(/https?:\/\/[^\s]*?figma\.com\/(?:design|file)\/[A-Za-z0-9_-]+[^\s)]*/gi) || [];
    const seen = new Set<string>();
    for (const url of figmaUrls.slice(0, 3)) {  // макс 3 макета
      const m = url.match(/figma\.com\/(?:design|file)\/([A-Za-z0-9_-]+)/);
      if (!m) continue;
      const fileKey = m[1];
      if (seen.has(fileKey)) continue;
      seen.add(fileKey);
      try {
        // Читаем структуру макета (diFetch = undici fetch через прокси, внешний хост)
        const figmaR = await diFetch(`https://api.figma.com/v1/files/${fileKey}?depth=3`, {
          headers: { "X-Figma-Token": FIGMA_TOKEN, Accept: "application/json" },
          dispatcher: diDispatcher,
        });
        if (!figmaR.ok) { console.error(`[redmine-mcp] Figma ${figmaR.status} для ${fileKey}`); continue; }
        const figmaData: any = await figmaR.json();
        const doc = figmaData?.document;
        if (!doc) continue;
        // Текстовое описание структуры макета
        const descLines: string[] = [`## Макет Figma: ${figmaData.name ?? fileKey}`, `Файл: \`${fileKey}\``, ""];
        const pages = (doc.children ?? []).filter((c: any) => c.type === "CANVAS");
        for (const page of pages) {
          descLines.push(`### Страница: ${page.name}`);
          const frames = extractTopFrames(page, 0);
          for (const f of frames.slice(0, 30)) {
            descLines.push(`- ${f.type === "COMPONENT" ? "🧩" : "📐"} **${f.name}** [${f.type}] ${f.size} — ${f.children} эл.`);
            for (const el of (f.elements ?? []).slice(0, 8)) descLines.push(`  - ${el}`);
          }
        }
        figmaContext += descLines.join("\n") + "\n\n";
      } catch (e: any) { console.error(`[redmine-mcp] Figma fetch: ${e?.message ?? e}`); }
    }
    if (figmaContext) console.error(`[redmine-mcp] compile: +figma (${seen.size} макет(ов) из задачи)`);
  }

  // ── Реестр репо ──────────────────────────────────────────────────────────
  let reg;
  try { reg = loadRegistry(); }
  catch (e) { return { error: `не прочитал реестр ${REGISTRY_PATH}: ${String((e as Error)?.message ?? e).slice(0, 200)}` }; }

  // Все допущенные репо = авто под workRoots (services/*, libraries/*) + явные per-repo (explicit
  // перебивает). КРОМЕ <personal-monorepo> (личный трек, не цель Redmine-задач). Модель САМА выбирает repo.
  const allRepos: Record<string, RepoReg> = { ...discoverWorkRootRepos(reg), ...reg.repos };
  delete allRepos["<personal-monorepo>"];

  // Заземление scope: top_level подгружаем ТОЛЬКО для репо, чьё имя встречается в задаче/подсказках
  // (иначе payload раздулся бы на ~70 репо). Остальные — имя+путь, модель выберет по имени/контексту.
  const hay = (JSON.stringify(issue) + " " + (input.repo ?? "") + " " + (input.module ?? "") + " " + (input.extra ?? "")).toLowerCase();
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const likely = new Set(
    Object.keys(allRepos)
      .filter((n) => n.length >= 4 && new RegExp(`\\b${esc(n.toLowerCase())}\\b`).test(hay))
      .sort((a, b) => b.length - a.length).slice(0, 6),
  );
  const candidates: Record<string, unknown> = {};
  for (const [name, r] of Object.entries(allRepos)) {
    candidates[name] = { path: r.repoPath, scopeMode: r.scopeMode, ...(likely.has(name) ? { top_level: listTopLevel(r.repoPath) } : {}) };
  }

  const userPayload = {
    issue,
    hints: { repo: input.repo ?? null, module: input.module ?? null, category: input.category ?? null, model: input.model ?? null, extra: input.extra ?? null },
    registry: candidates,
    figma_designs: figmaContext || null,
    note_for_model: "registry = допущенные target-репо (имя→путь). top_level дан только для вероятных. <personal-monorepo> исключён (не цель). figma_designs — структура макета из Figma, учти при формировании ТЗ (фронтенд-задача). Выбери repo по задаче; нет подходящего → needs_clarification.",
  };
  const messages = [
    { role: "system", content: COMPILER_PROMPT },
    { role: "user", content: "Скомпилируй задачу в черновик TaskSpec. Верни СТРОГО один JSON-объект.\n\n" + JSON.stringify(userPayload).slice(0, 24000) },
  ];

  let content = "";
  try { content = await diChatCompiler(messages); }
  catch (e) { return { error: `DeepInfra (компилятор): ${String((e as Error)?.message ?? e).slice(0, 200)}` }; }
  const draft = extractJson(content);
  if (!draft) return { error: "компилятор не вернул валидный JSON", raw: content.slice(0, 800) };

  if (draft.needs_clarification) {
    return {
      needs_clarification: true,
      redmine_id: input.redmine_id,
      questions: draft.clarification_questions ?? [],
      rationale: draft.rationale ?? "",
      note: "Черновик НЕ записан — задача недоспецифицирована.",
    };
  }

  const wto = input.write_to || "inline";
  const spec = buildTaskSpec(draft, input, { repos: allRepos });

  if (wto === "inline" && !input.write_to) {
    // По умолчанию: возвращаем TaskSpec без записи (пользователь сам решит что делать)
    return ok({
      draft: true,
      task_id: spec.id,
      task_spec: spec,
      note: "TaskSpec скомпилирован (без оценки). Для оценки: task_estimate. Для сохранения: compile_task с write_to='harness_queue' или 'custom'.",
    });
  }

  if (input.dry_run) {
    return ok({
      dry_run: true,
      task_id: spec.id,
      task_spec: spec,
      would_save_to: wto === "custom" ? input.custom_path : `harness/queue/?${spec.id}.json`,
      note: "Запись пропущена (dry_run=true). Для реальной записи убери dry_run.",
    });
  }

  const sv = saveTaskSpec(spec, wto, input.custom_path);
  const targetAllowed = Boolean(spec.harness_target_allowed);
  return ok({
    saved: true,
    task_id: spec.id,
    ...sv,
    task_spec: spec,
    harness_target_allowed: targetAllowed,
    note: spec.estimated ? "" : "Внимание: TaskSpec не оценён. Вызови task_estimate для подбора model/budget/attempts.",
    next: targetAllowed
      ? `Черновик: «?${spec.id}». Покажи тимлиду → правки → task_estimate → апрув.`
      : `⚠ репо не в реестре как harness-target.`,
  });
}

server.tool(
  "compile_task",
  `Компилятор Redmine-задачи → TaskSpec для harness. По умолчанию возвращает inline (без записи на диск).
1. LLM-компиляция: тянет историю задачи, маппит на репо, scope, формирует prompt_md.
2. write_to="inline" (по умолчанию): возвращает TaskSpec без модели/бюджета — оценка отдельно через task_estimate.
3. write_to="harness_queue": пишет в harness/queue/, оценка консервативная (minimax-m3, $3, 1 попытка).
4. task_spec (опционально): если передан готовый (оценённый) TaskSpec — пропускает LLM, просто пишет.
5. dry_run: показать что будет записано без реальной записи.`,
  {
    redmine_id: z.number().int().positive().describe("номер задачи Redmine"),
    repo:     z.string().optional().describe("ключ реестра проектов"),
    module:   z.string().optional().describe("бизнес-модуль"),
    category: z.enum(["simple", "medium", "complex"]).optional().describe("категория сложности (подсказка компилятору)"),
    model:    z.string().optional().describe("подсказка модели для прогона"),
    extra:    z.string().optional().describe("доп. контекст тимлида"),
    write_to: z.enum(["inline", "harness_queue", "custom"]).optional().describe("куда писать (по умолчанию inline)"),
    custom_path: z.string().optional().describe("путь для write_to=custom"),
    dry_run:  z.boolean().optional().describe("показать без записи"),
    task_spec: z.any().optional().describe("готовый TaskSpec (JSON или путь к .json) — пропустить LLM-компиляцию"),
  },
  async (a) => ok(await runCompiler(a)),
);

server.tool(
  "compile_batch",
  "Скомпилировать пачку задач в черновики TaskSpec.",
  { redmine_ids: z.array(z.number().int().positive()), repo: z.string().optional(), category: z.enum(["simple", "medium", "complex"]).optional() },
  async ({ redmine_ids, repo, category }) => {
    const compiled: unknown[] = [];
    for (const id of redmine_ids) {
      try { compiled.push(await runCompiler({ redmine_id: id, repo, category })); }
      catch (e) { compiled.push({ redmine_id: id, error: String((e as Error)?.message ?? e).slice(0, 200) }); }
    }
    return ok({ compiled });
  },
);

// ═══ task_estimate — оценка TaskSpec: модель/бюджет/попытки ═══════════════════
// Отделена от компиляции: compile_task → технический TaskSpec, task_estimate → экономика прогона.
// Два режима: heuristic (быстрый, детерминированный) и llm (точнее, но дороже).

function estimateHeuristic(taskSpec: Record<string, unknown>, mode: string): Record<string, unknown> {
  const promptMd = String(taskSpec.prompt_md ?? "");
  const promptLen = promptMd.length;
  const scopePaths = (taskSpec.scope_paths as string[]) ?? [];
  const lang = String(taskSpec.lang ?? "");
  const promptLow = promptMd.toLowerCase();
  const hasFigma = promptLow.includes("figma") || promptLow.includes("макет") || promptLow.includes("вёрстк");
  const hasMigrations = promptLow.includes("миграци") || promptLow.includes("schema") || promptLow.includes("бд") || promptLow.includes("баз данных");
  const stepCount = (promptMd.match(/^\d+\./gm)?.length ?? 0);

  let score = 0;
  score += Math.min(promptLen / 100, 40);
  score += Math.min(scopePaths.length * 8, 24);
  score += hasFigma ? 12 : 0;
  score += hasMigrations ? 10 : 0;
  score += Math.min(stepCount * 3, 20);
  score += lang === "php" ? 8 : 0;
  score = Math.round(score);

  const suggested = String(taskSpec.suggested_model ?? "");
  let model: string, budget: number, attempts: number, tier: string;

  switch (mode) {
    case "cheap":
      model = "minimax-m3"; budget = 3; attempts = 1; tier = "weak";
      break;
    case "manual":
      if (score < 30) { model = "minimax-m3"; budget = 3; attempts = 1; tier = "weak"; }
      else if (score < 60) { model = "deepseek-v4-pro"; budget = 6; attempts = 1; tier = "weak"; }
      else { model = "deepseek-v4-pro"; budget = 10; attempts = 2; tier = "strong"; }
      break;
    case "autonomous":
      if (score < 30) { model = "kimi-k2.7-code"; budget = 5; attempts = 3; tier = "strong"; }
      else if (score < 60) { model = "deepseek-v4-pro"; budget = 12; attempts = 3; tier = "strong"; }
      else { model = "deepseek-v4-pro"; budget = 18; attempts = 5; tier = "strong"; }
      break;
    case "thorough":
      model = "glm-5.2"; budget = 20; attempts = 5; tier = "strong";
      break;
    default:
      model = "deepseek-v4-pro"; budget = 10; attempts = 2; tier = "strong";
  }

  if (suggested && !["manual", "cheap"].includes(mode)) model = suggested;

  return {
    model,
    maxBudgetUsd: budget,
    maxAttempts: attempts,
    tier,
    estimation_mode: mode,
    estimation_score: score,
    estimation_rationale: [
      `Сложность: ${score}/100`,
      `prompt=${promptLen}с, scope_paths=${scopePaths.length}, шагов=${stepCount}`,
      hasFigma ? "figma" : "", hasMigrations ? "migrations" : "",
      lang ? `lang=${lang}` : "", `mode=${mode}`,
    ].filter(Boolean).join("; "),
  };
}

async function estimateLLM(taskSpec: Record<string, unknown>, mode: string): Promise<Record<string, unknown>> {
  if (!DI_BASE || !DI_KEY) return estimateHeuristic(taskSpec, mode); // fallback to heuristic
  try {
    const messages = [
      { role: "system", content: "Ты — оценщик задач для AI-агента. Оцени сложность TaskSpec и предложи модель/бюджет/попытки. Режим: " + mode + ". Ответь СТРОГО JSON: { model, maxBudgetUsd, maxAttempts, tier, score, rationale }." },
      { role: "user", content: JSON.stringify({ mode, prompt_md: (taskSpec.prompt_md as string)?.slice(0, 3000), lang: taskSpec.lang, scope_paths: taskSpec.scope_paths, suggested_model: taskSpec.suggested_model }).slice(0, 4000) },
    ];
    const body = JSON.stringify({ model: COMPILER_MODEL, messages, temperature: 0.2, max_tokens: 400, response_format: { type: "json_object" } });
    const res = await diFetch(`${DI_BASE}/chat/completions`, {
      method: "POST", headers: { Authorization: `Bearer ${DI_KEY}`, "Content-Type": "application/json" },
      body, dispatcher: diDispatcher,
    });
    if (!res.ok) throw new Error(`DeepInfra ${res.status}`);
    const data = (await res.json()) as any;
    const content = data?.choices?.[0]?.message?.content;
    const j = typeof content === "string" ? (() => { try { return JSON.parse(content); } catch { return null; } })() : content;
    if (j && j.model) return { ...j, estimation_mode: mode, estimation_llm: COMPILER_MODEL };
  } catch (e: any) { console.error(`[redmine-mcp] estimate LLM: ${e?.message ?? e}`); }
  return estimateHeuristic(taskSpec, mode);
}

async function _taskEstimate(args: {
  task_spec: any;
  mode?: string;
  use_llm?: boolean;
  model_override?: string;
  budget_override?: number;
  attempts_override?: number;
}): Promise<ReturnType<typeof ok>> {
  const { task_spec, mode, use_llm, model_override, budget_override, attempts_override } = args;

  let spec: Record<string, unknown>;
  if (typeof task_spec === "string") {
    try { spec = JSON.parse(readFileSync(task_spec, "utf8")) as Record<string, unknown>; }
    catch { return ok({ error: `не прочитал файл: ${task_spec}` }); }
  } else if (typeof task_spec === "object" && task_spec !== null) {
    spec = task_spec as Record<string, unknown>;
  } else {
    return ok({ error: "task_spec должен быть JSON-объектом или путём к .json файлу" });
  }

  if (!spec.prompt_md) return ok({ error: "TaskSpec не содержит prompt_md — нечего оценивать." });

  const estimateMode = mode ?? "manual";
  let estimation: Record<string, unknown>;

  if (use_llm) {
    estimation = await estimateLLM(spec, estimateMode);
  } else {
    estimation = estimateHeuristic(spec, estimateMode);
  }

  if (model_override) estimation.model = model_override;
  if (budget_override != null) estimation.maxBudgetUsd = budget_override;
  if (attempts_override != null) estimation.maxAttempts = attempts_override;

  const estimated = {
    ...spec,
    ...estimation,
    estimated: true,
    estimated_at: new Date().toISOString(),
    model: estimation.model,  // ensure model is set for harness compatibility
  };

  return ok({
    task_id: spec.id,
    task_spec: estimated,
    estimation: {
      model: estimation.model,
      maxBudgetUsd: estimation.maxBudgetUsd,
      maxAttempts: estimation.maxAttempts,
      tier: estimation.tier,
      score: estimation.estimation_score,
      rationale: estimation.estimation_rationale,
      mode: estimateMode,
      llm: use_llm || undefined,
    },
    note: "TaskSpec оценён. Для сохранения: compile_task(task_spec=<оценённый>, write_to='harness_queue'). Для ручного запуска: npm run harness -- path/to/spec.json",
  });
}

(server as any).tool("task_estimate",
  `Оценить скомпилированный TaskSpec: подобрать модель, бюджет, количество попыток.
Отделена от compile_task для эмерджентности:
- compile_task → технический TaskSpec (ЧТО делать)
- task_estimate → экономика прогона (КАК запускать: модель, бюджет, попытки)
Два режима:
- heuristic (по умолчанию): быстрая оценка по сложности prompt'а, scope, языку
- use_llm=true: LLM-оценка (точнее, но тратит токены)
Режимы оценки:
- manual: дешёвая модель, 1 попытка (пользователь в цикле)
- autonomous: лучшая модель, 3-5 попыток (без человека в цикле)
- cheap: минимальная стоимость
- thorough: максимальное качество`,
  {
    task_spec: z.any().describe("TaskSpec: JSON-объект или путь к .json файлу"),
    mode: z.enum(["manual", "autonomous", "cheap", "thorough"]).optional().describe("режим оценки (по умолчанию manual)"),
    use_llm: z.boolean().optional().describe("использовать LLM вместо эвристики"),
    model_override: z.string().optional().describe("принудительная модель"),
    budget_override: z.number().optional().describe("принудительный бюджет"),
    attempts_override: z.number().optional().describe("принудительное число попыток"),
  },
  _taskEstimate,
);

// plan_executor_pickups — ДЕТЕРМИНИРОВАННЫЙ поллинг задач для агентов-исполнителей (ADR-0026).
server.tool(
  "plan_executor_pickups",
  `ДЕТЕРМИНИРОВАННЫЙ поллинг задач для агентов-исполнителей (ADR-0026): задачи в статусе «На исполнение» (20),
назначенные на служебный аккаунт (по умолчанию team.agent_account = Agent <ID>). Возвращает БАТЧ кандидатов —
оркестратор показывает тимлиду, тот выбирает, какие запускать → дальше по каждой: compile_task(#id) → preview →
апрув → run_task. Тул НЕ компилит и НЕ запускает (детерминированный скан; прогоны/мутации — отдельно, за гейтом).`,
  {
    assigned_to_id: z.number().optional().describe("служебный аккаунт; по умолчанию team.agent_account.id"),
    status_id:      z.number().optional().describe("статус-фильтр; по умолчанию 20 (На исполнение)"),
  },
  async ({ assigned_to_id, status_id }) => {
    const agentId = assigned_to_id ?? TEAM.agent_account?.id;
    if (!agentId) return ok({ error: "не задан служебный аккаунт: param assigned_to_id или team.json agent_account.id (Agent <ID>)" });
    // fnSearch добавляет project_id=DEFAULT_PROJECT → не видит задачи из других проектов (напр. <sandbox-project>).
    // Поэтому идём напрямую в Redmine БЕЗ project_id — агент должен видеть задачи во ВСЕХ доступных проектах.
    const params: Record<string, string> = { assigned_to_id: String(agentId), status_id: String(status_id ?? 20), sort: "updated_on:desc" };
    const rows = await redmineGetAll("/issues.json", "issues", params, 15);
    const res = { total: rows.length, issues: rows.map(compactIssue) };
    return ok({
      agent_account: TEAM.agent_account ?? { id: agentId },
      status_filter: status_id ?? 20,
      pickups: res,
      note: "Кандидаты на подбор агентами-исполнителями. Тимлид выбирает → по каждой: compile_task(#id) → preview_task → апрув → run_task. Агент потом сам двигает 20→2→13 (redmine-write).",
    });
  },
);

// ── rag_query — интерфейс к офисному RagFlow (ADR-0027 этап 5) ──────────────
// Тонкий прокси: принимает запрос → форвардит в RagFlow API → возвращает результат.
// Конфиг: RAGFLOW_BASE_URL, RAGFLOW_API_KEY (оба должны быть заданы для работы).
const RAG_BASE = clean(process.env.RAGFLOW_BASE_URL);
const RAG_KEY  = clean(process.env.RAGFLOW_API_KEY);
const ragAvailable = Boolean(RAG_BASE && RAG_KEY);

async function ragQuery(query: string, topK = 5): Promise<{ query: string; results: { content: string; score: number; source: string }[] } | { error: string }> {
  if (!ragAvailable) return { error: "RagFlow не настроен (RAGFLOW_BASE_URL + RAGFLOW_API_KEY)" };
  try {
    const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 30_000);
    const opts: any = { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${RAG_KEY}` }, body: JSON.stringify({ query, top_k: topK }), signal: ctrl.signal };
    if (RAG_BASE?.includes("192.168")) {
      // Офисная сеть — без прокси, прямой доступ
    } else if (diDispatcher) {
      opts.dispatcher = diDispatcher;
    }
    const r = await fetch(`${RAG_BASE!.replace(/\/$/, "")}/api/search`, opts);
    clearTimeout(t);
    if (!r.ok) return { error: `RagFlow ${r.status}: ${(await r.text()).slice(0, 200)}` };
    const data: any = await r.json();
    const results = (data?.results ?? data?.chunks ?? data?.data ?? []).slice(0, topK).map((c: any) => ({
      content: (c.content ?? c.text ?? c.chunk ?? "").slice(0, 2000),
      score: c.score ?? c.similarity ?? 0,
      source: c.source ?? c.document_name ?? c.metadata?.source ?? "?",
    }));
    return { query, results };
  } catch (e: any) { return { error: `RagFlow: ${e?.message ?? e}` }; }
}

server.tool(
  "rag_query",
  `Поиск по офисной базе знаний RagFlow: документация, стандарты, история задач, архитектура.
Используется компилятором для грунтовки TaskSpec'ов и аналитиком для контекста.`,
  {
    query: z.string().describe("поисковый запрос на русском"),
    top_k: z.number().optional().describe("сколько результатов (по умолч. 5)"),
  },
  async ({ query, top_k }) => ok(await ragQuery(query, top_k ?? 5)),
);

// ─── State inspect (спек 06): прозрачность хранилищ состояния ───────────────
function readJson(p: string): unknown {
  try { if (existsSync(p)) return JSON.parse(readFileSync(p, "utf8")); } catch { /* */ }
  return null;
}
function readJsonDir(dir: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  try {
    if (!existsSync(dir)) return out;
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".json")) continue;
      out[f] = readJson(join(dir, f));
    }
  } catch { /* */ }
  return out;
}
const OPENCLAW_HOME = process.env.OPENCLAW_HOME || join(process.env.HOME || "~", ".openclaw");
const STATE_PATHS: Record<string, string | string[]> = {
  executor: join(OPENCLAW_HOME, "executor", "state.json"),
  harness: [join(OPENCLAW_HOME, "harness", "index.json"), join(OPENCLAW_HOME, "harness", "jobs")],
  "git-egress": join(OPENCLAW_HOME, "git-egress", "state.json"),
  "release-manager": join(OPENCLAW_HOME, "release-manager", "state.json"),
  cron: join(OPENCLAW_HOME, "cron", "runs.json"),
  telegram: join(OPENCLAW_HOME, "telegram", "delivery-queue.json"),
};
const WS_STATE_DIR = join(resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", ".."), "workspace", "state");

async function stateInspect(component: string): Promise<unknown> {
  if (component === "all") {
    const out: Record<string, unknown> = {};
    for (const c of Object.keys(STATE_PATHS)) out[c] = await stateInspect(c);
    return out;
  }
  const paths = STATE_PATHS[component];
  if (!paths) return { error: `неизвестный компонент: ${component}` };
  if (Array.isArray(paths)) {
    return { index: readJson(paths[0]), jobs: readJsonDir(paths[1]), workspace_mirror: readJsonDir(join(WS_STATE_DIR, "jobs")) };
  }
  const data = readJson(paths);
  const mirrorName = component === "release-manager" ? "release-manager-state.json" : `${component}-state.json`;
  return { data, workspace_mirror: readJson(join(WS_STATE_DIR, mirrorName)) };
}

server.tool(
  "state_inspect",
  "Прочитать состояние системы: executor, harness, git-egress, release-manager, cron, telegram. Для диагностики используй state_inspect('all') — покажет сводку по всем компонентам.",
  { component: z.enum(["executor", "harness", "git-egress", "release-manager", "cron", "telegram", "all"]) },
  async ({ component }) => ok(await stateInspect(component)),
);

// ─────────────────────────────────────────────────────────────────────────────
// TODO(этап 4): add_note, update_status — только за approval-gate.
// ─────────────────────────────────────────────────────────────────────────────

await server.connect(new StdioServerTransport());
console.error(`[redmine-mcp] v0.5.0 (auth=${useBasicAuth ? "basic" : "api-key"}, project=${DEFAULT_PROJECT || "all"}, team=${TEAM.core_developers?.length ?? 0} devs, roles=${Object.keys(TEAM.roles ?? {}).length}, compiler=${COMPILER_MODEL || "off"}, rag=${ragAvailable ? "on" : "OFF"})`);
