/**
 * Redmine WRITE MCP-сервер — этап 4 (ADR-0022). Прод-МУТАЦИИ за approval-гейтом.
 *
 * Тулзы: add_note / update_status / create_issue. КАЖДАЯ гейтится нативным плагином
 * approval-gate (config.sensitiveTools) — LLM не само-апрувит; здесь гейта НЕ ставим,
 * это второй рубеж: структурные whitelist'ы (DEFAULT-DENY) + DRY_RUN + атрибуция + анти-дубль.
 *
 * Раздельные привилегии (ADR-0007): это ОТДЕЛЬНЫЙ сервер от read-MCP. Аутентификация —
 * Basic Auth (та же учётка, что read — фаза тестов, NB-5; позже отдельная урезанная).
 * Сеть: <YOUR_REDMINE_HOST> — ВНУТРЕННИЙ хост, ходим НАПРЯМУЮ (нативный fetch, без прокси).
 *
 * Env: REDMINE_BASE_URL, REDMINE_LOGIN, REDMINE_PASSWORD (или REDMINE_API_KEY),
 *      REDMINE_TEAM_CONFIG (team.json — id↔имена статусов/трекеров/приоритетов/проекта),
 *      REDMINE_WRITE_CONFIG (config/redmine-write.json5 — whitelist'ы/маппинг/атрибуция),
 *      DRY_RUN ("false" → реальная запись; иначе — только лог намерения, FAIL-SAFE),
 *      REDMINE_WRITE_MODEL (метка модели для подписи), REDMINE_WRITE_ON_BEHALF (по чьему поручению),
 *      AGENT_REPO_ROOT (для аудит-лога docs/approval-history.md).
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { readFileSync, appendFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import JSON5 from "json5";

// ─── Config / env ───────────────────────────────────────────────────────────
// OpenClaw оставляет ${VAR} литералом при пустой подстановке → считаем отсутствующим.
const clean = (v?: string): string => {
  const s = (v ?? "").trim();
  return /^\$\{.*\}$/.test(s) ? "" : s;
};

const BASE_URL  = clean(process.env.REDMINE_BASE_URL);
const API_KEY   = clean(process.env.REDMINE_API_KEY);
// Предпочитаем REDMINE_WRITE_LOGIN/PASSWORD — отдельная учётка для мутаций.
// Если не заданы — фолбэк на REDMINE_LOGIN/PASSWORD (read-учётка).
const LOGIN     = clean(process.env.REDMINE_WRITE_LOGIN) || clean(process.env.REDMINE_LOGIN);
const PASSWORD  = clean(process.env.REDMINE_WRITE_PASSWORD) || clean(process.env.REDMINE_PASSWORD);
const REPO_ROOT = clean(process.env.AGENT_REPO_ROOT);
const MODEL     = clean(process.env.REDMINE_WRITE_MODEL) || "неизвестная модель";
const ON_BEHALF = clean(process.env.REDMINE_WRITE_ON_BEHALF) || "тимлида";
// DRY_RUN — FAIL-SAFE: реальная запись ТОЛЬКО при явном "false". Иначе (true/пусто/${...}) — сухой прогон.
const DRY_RUN = clean(process.env.DRY_RUN).toLowerCase() !== "false";

if (!BASE_URL) { console.error("[redmine-write] REDMINE_BASE_URL не задан"); process.exit(1); }
const useBasicAuth = Boolean(LOGIN && PASSWORD);
if (!useBasicAuth && !API_KEY) {
  console.error("[redmine-write] нужно REDMINE_API_KEY или REDMINE_LOGIN + REDMINE_PASSWORD");
  process.exit(1);
}

// ─── team.json: id↔имена статусов/трекеров/приоритетов/проекта ────────────────
type StatusGroup = { ids: number[]; names: string[]; closed?: boolean };
type TeamConfig = {
  project?: { slug: string; id: number; name: string };
  core_developers?: Array<{ id: number; name: string; login?: string }>;
  statuses?: Record<string, StatusGroup>;
  trackers?: Record<string, { ids: number[]; names: string[] }>;
  priorities?: Array<{ id: number; name: string; default?: boolean }>;
};
let TEAM: TeamConfig = {};
{
  const p = clean(process.env.REDMINE_TEAM_CONFIG);
  if (p) { try { TEAM = JSON.parse(readFileSync(p, "utf-8")) as TeamConfig; }
    catch (e) { console.error(`[redmine-write] не прочитал REDMINE_TEAM_CONFIG: ${e}`); } }
}
// Плоские карты имя→id (регистронезависимо) из групп team.json.
const lc = (s: string) => s.trim().toLowerCase();
function flatNameToId(groups: Array<{ ids: number[]; names: string[] }>): Map<string, number> {
  const m = new Map<string, number>();
  for (const g of groups) (g.ids ?? []).forEach((id, i) => { const n = g.names?.[i]; if (n) m.set(lc(n), id); });
  return m;
}
const STATUS_NAME_TO_ID  = flatNameToId(Object.values(TEAM.statuses ?? {}));
const STATUS_ID_TO_NAME  = new Map<number, string>([...STATUS_NAME_TO_ID].map(([n, id]) => [id, n] as [number, string]));
const TRACKER_NAME_TO_ID = flatNameToId(Object.values(TEAM.trackers ?? {}));
const PRIORITY_NAME_TO_ID = new Map<string, number>((TEAM.priorities ?? []).map((p) => [lc(p.name), p.id] as [string, number]));

// ─── write-config (whitelist'ы/маппинг/атрибуция) ─────────────────────────────
type TrackerFields = { required?: string[]; defaults?: Record<string, string | number> };
type WriteConfig = {
  allowedStatusTransitions?: Record<string, string[]>;
  allowedProjects?: string[];
  trackerFields?: Record<string, TrackerFields>;
  attribution?: string;
  antiDuplicate?: { enabled?: boolean; scanOpenLimit?: number; minKeywordHits?: number };
};
let WCFG: WriteConfig = {};
{
  const p = clean(process.env.REDMINE_WRITE_CONFIG);
  if (p) { try { WCFG = JSON5.parse(readFileSync(p, "utf-8")) as WriteConfig; }
    catch (e) { console.error(`[redmine-write] не прочитал REDMINE_WRITE_CONFIG: ${e}`); } }
}

// ─── HTTP (нативный fetch, <YOUR_HOST> напрямую) ──────────────────────────────────
function authHeaders(): Record<string, string> {
  const h: Record<string, string> = { Accept: "application/json", "Content-Type": "application/json" };
  if (useBasicAuth) h["Authorization"] = `Basic ${Buffer.from(`${LOGIN}:${PASSWORD}`).toString("base64")}`;
  else if (API_KEY) h["X-Redmine-API-Key"] = API_KEY;
  return h;
}
type RedmineResp = { status: number; json: any; text: string };
async function redmineReq(method: string, path: string, body?: unknown): Promise<RedmineResp> {
  const url = `${BASE_URL.replace(/\/$/, "")}${path}`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 15_000);
  try {
    const res = await fetch(url, { method, headers: authHeaders(), body: body ? JSON.stringify(body) : undefined, signal: ctrl.signal });
    const text = await res.text();
    let json: any = null; try { json = text ? JSON.parse(text) : null; } catch { /* 204/empty */ }
    return { status: res.status, json, text };
  } finally { clearTimeout(t); }
}

// ─── Резолв id (team.json → ленивый фолбэк в Redmine) ─────────────────────────
let projCache: Map<string, number> | null = null;   // slug+name(lc) → id
async function projectSlugToId(slug: string): Promise<number | null> {
  if (TEAM.project && lc(TEAM.project.slug) === lc(slug)) return TEAM.project.id;
  if (!projCache) {
    projCache = new Map();
    try {
      const r = await redmineReq("GET", "/projects.json?limit=100");
      for (const p of (r.json?.projects ?? []) as Array<any>) {
        if (p.identifier) projCache.set(lc(String(p.identifier)), p.id);
        if (p.name) projCache.set(lc(String(p.name)), p.id);
      }
    } catch { /* best-effort */ }
  }
  return projCache.get(lc(slug)) ?? null;
}
let statusCache: Map<string, number> | null = null;
async function resolveStatusId(input: string | number): Promise<{ id: number; name: string } | null> {
  if (typeof input === "number") return { id: input, name: STATUS_ID_TO_NAME.get(input) ?? `#${input}` };
  const byTeam = STATUS_NAME_TO_ID.get(lc(input));
  if (byTeam) return { id: byTeam, name: input };
  if (!statusCache) {
    statusCache = new Map();
    try {
      const r = await redmineReq("GET", "/issue_statuses.json");
      for (const s of (r.json?.issue_statuses ?? []) as Array<any>) statusCache.set(lc(String(s.name)), s.id);
    } catch { /* best-effort */ }
  }
  const id = statusCache.get(lc(input));
  return id ? { id, name: input } : null;
}
function resolveTrackerId(name: string): number | null { return TRACKER_NAME_TO_ID.get(lc(name)) ?? null; }
function resolvePriorityId(name: string): number | null { return PRIORITY_NAME_TO_ID.get(lc(name)) ?? null; }
function resolveAssignee(input: string | number): number | null {
  if (typeof input === "number") return input;
  const dev = (TEAM.core_developers ?? []).find((d) => lc(d.name) === lc(input) || lc(d.login ?? "") === lc(input));
  return dev?.id ?? null;
}

// ─── Атрибуция / аудит-лог ────────────────────────────────────────────────────
function attribution(): string {
  const tpl = WCFG.attribution ?? "\n\n---\n_Составлено моделью {model} через neurodeck-agent по поручению {onBehalf}._";
  return tpl.replace(/\{model\}/g, MODEL).replace(/\{onBehalf\}/g, ON_BEHALF);
}
function logHistory(action: string, detail: Record<string, unknown>): void {
  if (!REPO_ROOT) return;
  try {
    const dir = join(REPO_ROOT, "docs");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const line = `- **${new Date().toISOString()}** · \`${action}\` · ${DRY_RUN ? "DRY_RUN" : "LIVE"} · ${JSON.stringify(detail)}\n`;
    appendFileSync(join(dir, "approval-history.md"), line);
  } catch { /* аудит best-effort, не роняем тул */ }
}

const ok = (obj: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(obj, null, 2) }] });
const issueUrl = (id: number) => `${BASE_URL.replace(/\/$/, "")}/issues/${id}`;

// ─── Анти-дубль для create_issue (NB-4) ───────────────────────────────────────
const STOP = new Set(["для","при","или","это","как","что","над","под","без","про","the","and","for","with","из","на","по","в","и","с"]);
function keywords(subject: string): string[] {
  return [...new Set(subject.toLowerCase().split(/[^a-zа-я0-9]+/i).filter((w) => w.length >= 4 && !STOP.has(w)))];
}
async function findDuplicates(projectId: number, subject: string): Promise<Array<{ id: number; subject: string; status: string }>> {
  const ad = WCFG.antiDuplicate ?? {};
  if (ad.enabled === false) return [];
  const kws = keywords(subject);
  if (kws.length === 0) return [];
  const limit = ad.scanOpenLimit ?? 100;
  const minHits = ad.minKeywordHits ?? 2;
  let issues: Array<any> = [];
  try {
    const r = await redmineReq("GET", `/issues.json?project_id=${projectId}&status_id=open&sort=updated_on:desc&limit=${limit}`);
    issues = (r.json?.issues ?? []) as Array<any>;
  } catch { return []; }
  return issues
    .map((i) => {
      const subj = String(i.subject ?? "");
      const hits = kws.filter((k) => subj.toLowerCase().includes(k)).length;
      return { id: i.id as number, subject: subj, status: String(i.status?.name ?? "?"), hits };
    })
    .filter((x) => x.hits >= minHits)
    .sort((a, b) => b.hits - a.hits)
    .slice(0, 5)
    .map(({ id, subject, status }) => ({ id, subject, status }));
}

// ─── MCP сервер ───────────────────────────────────────────────────────────────
const server = new McpServer({ name: "redmine-write-mcp", version: "0.1.0" });

// add_note — примечание к задаче (с подписью модели).
server.tool(
  "add_note",
  `Добавить ПРИМЕЧАНИЕ к задаче Redmine (прод-мутация, за approval-гейтом). К тексту автоматически
добавляется подпись (какая модель составила, по чьему поручению). DRY_RUN → только лог намерения.`,
  { issue_id: z.number(), text: z.string(), private: z.boolean().optional().describe("приватное примечание") },
  async ({ issue_id, text, private: priv }) => {
    const full = text + attribution();
    logHistory("add_note", { issue_id, private: !!priv, preview: text.slice(0, 120) });
    if (DRY_RUN) return ok({ dry_run: true, would_post: { issue_id, text: full, private: !!priv }, note: "DRY_RUN — не записано. Включить запись: DRY_RUN=false." });
    const r = await redmineReq("PUT", `/issues/${issue_id}.json`, { issue: { notes: full, private_notes: !!priv } });
    if (r.status !== 200 && r.status !== 204) return ok({ error: `Redmine PUT ${r.status}: ${r.text.slice(0, 300)}` });
    return ok({ ok: true, issue_id, url: issueUrl(issue_id), posted: "примечание добавлено" });
  },
);

// update_status — смена статуса (whitelist переходов из стандарта ЖЦ, DEFAULT-DENY).
server.tool(
  "update_status",
  `Сменить СТАТУС задачи Redmine (прод-мутация, за approval-гейтом). Разрешённые переходы — из whitelist
(config/redmine-write.json5 allowedStatusTransitions, наполняется из xwiki-стандарта ЖЦ). Переход вне
whitelist ОТКЛОНЯЕТСЯ. Можно приложить примечание (note). DRY_RUN → только лог.`,
  { issue_id: z.number(), status: z.union([z.string(), z.number()]), note: z.string().optional() },
  async ({ issue_id, status, note }) => {
    const target = await resolveStatusId(status);
    if (!target) return ok({ error: `статус "${status}" не распознан (см. team.json/issue_statuses)` });
    // Текущий статус — для проверки перехода from→to.
    const cur = await redmineReq("GET", `/issues/${issue_id}.json`);
    if (cur.status !== 200) return ok({ error: `не прочитал задачу #${issue_id}: Redmine ${cur.status}` });
    const fromName = String(cur.json?.issue?.status?.name ?? "?");
    // Whitelist (DEFAULT-DENY): из конкретного from ИЛИ из "*". Пустой конфиг → запрет.
    const tr = WCFG.allowedStatusTransitions ?? {};
    const allowed = new Set([...(tr[fromName] ?? []), ...(tr["*"] ?? [])].map(lc));
    if (!allowed.has(lc(target.name))) {
      return ok({
        error: `переход "${fromName}" → "${target.name}" НЕ в whitelist (default-deny).`,
        allowed_from_current: tr[fromName] ?? [],
        hint: "Заполни allowedStatusTransitions в config/redmine-write.json5 по стандарту ЖЦ задач (xwiki).",
      });
    }
    const body: any = { issue: { status_id: target.id } };
    if (note) body.issue.notes = note + attribution();
    logHistory("update_status", { issue_id, from: fromName, to: target.name, with_note: !!note });
    if (DRY_RUN) return ok({ dry_run: true, would_update: { issue_id, from: fromName, to: target.name, status_id: target.id, note: note ? note + attribution() : undefined } });
    const r = await redmineReq("PUT", `/issues/${issue_id}.json`, body);
    if (r.status !== 200 && r.status !== 204) return ok({ error: `Redmine PUT ${r.status}: ${r.text.slice(0, 300)}` });
    return ok({ ok: true, issue_id, url: issueUrl(issue_id), changed: `${fromName} → ${target.name}` });
  },
);

// create_issue — создание задачи (whitelist проектов + per-tracker маппинг + анти-дубль).
server.tool(
  "create_issue",
  `СОЗДАТЬ задачу в Redmine (прод-мутация, за approval-гейтом). Проект ДОЛЖЕН быть в allowedProjects
(config/redmine-write.json5, default-deny). Обязательные/дефолтные поля — per-tracker из конфига.
Перед созданием — анти-дубль (полнотекстовый поиск по ключевым словам); при кандидатах БЕЗ force:true
не создаёт, а возвращает похожие. DRY_RUN → только лог.`,
  {
    project: z.string().describe("slug проекта (должен быть в allowedProjects)"),
    subject: z.string(),
    description: z.string().optional(),
    tracker: z.string().optional(),
    priority: z.string().optional(),
    assignee: z.union([z.string(), z.number()]).optional().describe("id/логин/имя из core_developers"),
    parent: z.number().optional().describe("parent_issue_id"),
    force: z.boolean().optional().describe("создать, даже если найдены похожие задачи"),
  },
  async ({ project, subject, description, tracker, priority, assignee, parent, force }) => {
    // 1) whitelist проектов (default-deny)
    const allowedProjects = (WCFG.allowedProjects ?? []).map(lc);
    if (!allowedProjects.includes(lc(project))) {
      return ok({ error: `проект "${project}" НЕ в allowedProjects (default-deny). Разрешены: ${WCFG.allowedProjects?.join(", ") || "(пусто — заполни config/redmine-write.json5)"}` });
    }
    const projectId = await projectSlugToId(project);
    if (!projectId) return ok({ error: `не нашёл project_id для "${project}" (проверь slug в Redmine)` });

    // 2) маппинг трекера: required + defaults
    const tf = WCFG.trackerFields ?? {};
    const map: TrackerFields = (tracker ? tf[tracker] : undefined) ?? tf["_default"] ?? {};
    const trackerName = tracker || (map.defaults?.tracker as string | undefined);
    const priorityName = priority || (map.defaults?.priority as string | undefined);
    const fields: Record<string, unknown> = { subject, description, tracker: trackerName, priority: priorityName, assignee, parent };
    for (const req of map.required ?? []) {
      if (fields[req] == null || fields[req] === "") return ok({ error: `обязательное поле "${req}" не заполнено (per-tracker маппинг ${tracker || "_default"})` });
    }

    // 3) анти-дубль (NB-4)
    if (!force) {
      const dups = await findDuplicates(projectId, subject);
      if (dups.length) return ok({ needs_confirmation: true, possible_duplicates: dups, hint: "Похоже на существующие задачи. Покажи тимлиду; если всё равно создавать — повтори с force:true." });
    }

    // 4) сборка payload
    const issue: Record<string, unknown> = { project_id: projectId, subject, description: (description ?? "") + attribution() };
    if (trackerName)  { const id = resolveTrackerId(trackerName);  if (id) issue.tracker_id = id;  else return ok({ error: `трекер "${trackerName}" не распознан (team.json)` }); }
    if (priorityName) { const id = resolvePriorityId(priorityName); if (id) issue.priority_id = id; }
    if (assignee != null) { const id = resolveAssignee(assignee); if (id) issue.assigned_to_id = id; else return ok({ error: `исполнитель "${assignee}" не распознан (core_developers)` }); }
    if (parent != null) issue.parent_issue_id = parent;

    logHistory("create_issue", { project, subject, tracker: trackerName, forced: !!force });
    if (DRY_RUN) return ok({ dry_run: true, would_create: { project, ...issue } });
    const r = await redmineReq("POST", "/issues.json", { issue });
    if (r.status !== 201) return ok({ error: `Redmine POST ${r.status}: ${r.text.slice(0, 300)}` });
    const created = r.json?.issue?.id as number;
    return ok({ ok: true, created_id: created, url: issueUrl(created), subject });
  },
);

// write_config_info — что вообще разрешено (для оркестратора/тимлида перед write).
server.tool(
  "write_config_info",
  "Показать конфигурацию write-MCP: режим (DRY_RUN), whitelist проектов, разрешённые переходы статусов, per-tracker маппинг, подпись.",
  {},
  async () => ok({
    dry_run: DRY_RUN,
    auth: useBasicAuth ? "basic" : "api-key",
    allowed_projects: WCFG.allowedProjects ?? [],
    allowed_status_transitions: WCFG.allowedStatusTransitions ?? {},
    tracker_fields: WCFG.trackerFields ?? {},
    anti_duplicate: WCFG.antiDuplicate ?? {},
    attribution_preview: attribution(),
    note: "Все три write-тулзы гейтятся плагином approval-gate (кнопка в Telegram). Whitelist'ы — default-deny.",
  }),
);

await server.connect(new StdioServerTransport());
console.error(`[redmine-write] v0.1.0 (auth=${useBasicAuth ? "basic" : "api-key"}, DRY_RUN=${DRY_RUN}, projects=${(WCFG.allowedProjects ?? []).length}, transitions=${Object.keys(WCFG.allowedStatusTransitions ?? {}).length})`);
