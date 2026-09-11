/**
 * GitLab WRITE MCP — релиз-менеджер + автоназначение ревьюеров (ADR-0025/0016).
 *
 * Прод-мутации GitLab за approval-гейтом (approval-gate.sensitiveTools: merge_mr/set_reviewers).
 * ОТДЕЛЬНЫЙ сервер от read (gitlab-mr-mcp): раздельные привилегии (ADR-0007). Токен — scope `api`
 * (write), env GITLAB_WRITE_TOKEN (НЕ read GITLAB_TOKEN). Сеть: <YOUR_GITLAB_HOST> — ВНУТРЕННИЙ хост,
 * ходим НАПРЯМУЮ (нативный fetch, без прокси). DEFAULT-DENY + DRY_RUN fail-safe + атрибуция + аудит.
 *
 * Env: GITLAB_BASE_URL, GITLAB_WRITE_TOKEN (scope api),
 *      GITLAB_WRITE_CONFIG (config/gitlab-write.json5 — allowedMergeTargets/pollProjects/reviewer),
 *      REDMINE_TEAM_CONFIG (team.json — gitlab↔разраб↔каста для автоназначения),
 *      DRY_RUN ("false" → реальная запись; иначе лог намерения, FAIL-SAFE),
 *      GITLAB_WRITE_MODEL / GITLAB_WRITE_ON_BEHALF (атрибуция), AGENT_REPO_ROOT (аудит-лог).
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { readFileSync, appendFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import JSON5 from "json5";

// OpenClaw оставляет ${VAR} литералом при пустой подстановке → считаем отсутствующим.
const clean = (v?: string): string => { const s = (v ?? "").trim(); return /^\$\{.*\}$/.test(s) ? "" : s; };

const BASE_URL  = clean(process.env.GITLAB_BASE_URL);
const TOKEN     = clean(process.env.GITLAB_WRITE_TOKEN);
const REPO_ROOT = clean(process.env.AGENT_REPO_ROOT);
const MODEL     = clean(process.env.GITLAB_WRITE_MODEL) || "неизвестная модель";
const ON_BEHALF = clean(process.env.GITLAB_WRITE_ON_BEHALF) || "тимлида";
// DRY_RUN — FAIL-SAFE: реальная запись ТОЛЬКО при явном "false".
const DRY_RUN = clean(process.env.DRY_RUN).toLowerCase() !== "false";

// Redmine READ (read-only) — условие автомёрджа «связанная задача в статусе Исполнено» (NB ADR-0025).
// <YOUR_HOST> — внутренний хост, напрямую. Не задано → plan_release_merges пометит статус-проверку недоступной.
const RM_BASE  = clean(process.env.REDMINE_BASE_URL);
const RM_LOGIN = clean(process.env.REDMINE_LOGIN);
const RM_PASS  = clean(process.env.REDMINE_PASSWORD);
const RM_KEY   = clean(process.env.REDMINE_API_KEY);
const rmAuthAvailable = Boolean(RM_BASE && ((RM_LOGIN && RM_PASS) || RM_KEY));

if (!BASE_URL) { console.error("[gitlab-write] GITLAB_BASE_URL не задан"); process.exit(1); }
if (!TOKEN) { console.error("[gitlab-write] GITLAB_WRITE_TOKEN не задан (нужен scope api — отдельный от read-токена)"); process.exit(1); }

// ─── write-config (whitelist'ы/настройки, NB: конфигом, не кодом) ──────────────
type ReviewerCfg = { backendCount?: number; frontendCount?: number; excludeAuthor?: boolean; excludeTeamlead?: boolean };
type WriteConfig = {
  pollProjects?: Array<string | number>;
  allowedMergeTargets?: string[];   // glob-паттерны веток, КУДА разрешён автомёрдж (default-deny)
  reviewerAssignment?: ReviewerCfg;
  attribution?: string;
  mergeRequiresTaskStatus?: string; // статус задачи Redmine, при котором rc-MR можно мёрджить (NB: "Исполнено")
  reviewScanTargetBranch?: string;  // целевая ветка для скана автоназначения ревьюеров (NB: "dev")
};
let WCFG: WriteConfig = {};
{ const p = clean(process.env.GITLAB_WRITE_CONFIG);
  if (p) { try { WCFG = JSON5.parse(readFileSync(p, "utf-8")) as WriteConfig; }
    catch (e) { console.error(`[gitlab-write] не прочитал GITLAB_WRITE_CONFIG: ${e}`); } } }

// ─── team.json (gitlab↔разраб↔каста, для автоназначения) ──────────────────────
type Dev = { id: number; name: string; login?: string; role?: string; gitlab?: { username?: string; id?: number | null } };
type Team = { core_developers?: Dev[]; roles?: Record<string, { ids: number[]; label?: string }> };
let TEAM: Team = {};
{ const p = clean(process.env.REDMINE_TEAM_CONFIG);
  if (p) { try { TEAM = JSON.parse(readFileSync(p, "utf-8")) as Team; }
    catch (e) { console.error(`[gitlab-write] не прочитал REDMINE_TEAM_CONFIG: ${e}`); } } }
const DEVS = TEAM.core_developers ?? [];
const ROLES = TEAM.roles ?? {};
const devByGitlabId = (gid?: number | null): Dev | undefined =>
  gid == null ? undefined : DEVS.find((d) => d.gitlab?.id === gid);
const isFrontend = (d: Dev): boolean => (ROLES["frontend"]?.ids ?? []).includes(d.id);

// ─── GitLab REST (api/v4, <YOUR_HOST> напрямую) ───────────────────────────────────
const API = `${BASE_URL.replace(/\/$/, "")}/api/v4`;
const encProj = (p: string | number): string => encodeURIComponent(String(p));
type GlResp = { status: number; json: any; text: string };
async function gl(method: string, path: string, body?: unknown): Promise<GlResp> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 15_000);
  try {
    const res = await fetch(`${API}${path}`, {
      method,
      headers: { "PRIVATE-TOKEN": TOKEN, "Content-Type": "application/json", Accept: "application/json" },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    const text = await res.text();
    let json: any = null; try { json = text ? JSON.parse(text) : null; } catch { /* empty */ }
    return { status: res.status, json, text };
  } finally { clearTimeout(t); }
}

const ok = (o: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(o, null, 2) }] });
const globToRe = (g: string): RegExp => new RegExp("^" + g.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$");
const mergeTargetAllowed = (branch: string): boolean =>
  (WCFG.allowedMergeTargets ?? []).some((p) => globToRe(p).test(branch));   // default-deny (пусто → false)

function attribution(): string {
  const tpl = WCFG.attribution ?? "\n\n---\n_Действие выполнено моделью {model} через neurodeck-agent по поручению {onBehalf}._";
  return tpl.replace(/\{model\}/g, MODEL).replace(/\{onBehalf\}/g, ON_BEHALF);
}
function logHistory(action: string, detail: Record<string, unknown>): void {
  if (!REPO_ROOT) return;
  try {
    const dir = join(REPO_ROOT, "docs");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, "approval-history.md"),
      `- **${new Date().toISOString()}** · \`gitlab:${action}\` · ${DRY_RUN ? "DRY_RUN" : "LIVE"} · ${JSON.stringify(detail)}\n`);
  } catch { /* аудит best-effort */ }
}

// Компактный ряд MR.
function mrRow(p: string | number, m: any) {
  return {
    project: String(p), iid: m.iid, title: m.title,
    source: m.source_branch, target: m.target_branch,
    author: m.author?.username,
    assignees: (m.assignees ?? []).map((a: any) => a.username),
    reviewers: (m.reviewers ?? []).map((r: any) => r.username),
    merge_status: m.merge_status, has_conflicts: m.has_conflicts, web_url: m.web_url,
  };
}

// ─── Redmine READ (статус связанной задачи для автомёрджа, NB ADR-0025) ───────
function rmHeaders(): Record<string, string> {
  const h: Record<string, string> = { Accept: "application/json" };
  if (RM_LOGIN && RM_PASS) h["Authorization"] = `Basic ${Buffer.from(`${RM_LOGIN}:${RM_PASS}`).toString("base64")}`;
  else if (RM_KEY) h["X-Redmine-API-Key"] = RM_KEY;
  return h;
}
async function redmineIssueStatus(issueId: number): Promise<string | null> {
  if (!rmAuthAvailable) return null;
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 12_000);
  try {
    const res = await fetch(`${RM_BASE.replace(/\/$/, "")}/issues/${issueId}.json`, { headers: rmHeaders(), signal: ctrl.signal });
    if (!res.ok) return null;
    const j: any = await res.json();
    return j?.issue?.status?.name ?? null;
  } catch { return null; } finally { clearTimeout(t); }
}
// Ветка задачи названа по Redmine-номеру (#NNNNN, projects.json5/recap) → парсим id из source_branch.
const taskIdFromBranch = (branch?: string): number | null => {
  const m = String(branch ?? "").match(/(\d{4,6})/);
  return m ? Number(m[1]) : null;
};

// ─── Детерминированный подбор ревьюеров по MR (общий для suggest_reviewers + plan_review_assignments) ──
async function computeSuggestion(m: any): Promise<any> {
  const cfg = WCFG.reviewerAssignment ?? {};
  const assignee = (m.assignees?.[0]) ?? m.assignee;
  const assigneeDev = devByGitlabId(assignee?.id);
  const taskRole: "frontend" | "backend" = assigneeDev && isFrontend(assigneeDev) ? "frontend" : "backend";
  const needed = taskRole === "frontend" ? (cfg.frontendCount ?? 1) : (cfg.backendCount ?? 2);
  const poolIds = ROLES[taskRole === "frontend" ? "frontend" : "backend_web"]?.ids ?? [];
  const authorId = m.author?.id;
  let pool = DEVS.filter((d) => poolIds.includes(d.id) && d.gitlab?.id != null);
  if (cfg.excludeAuthor !== false) pool = pool.filter((d) => d.gitlab?.id !== authorId);
  if (cfg.excludeTeamlead) pool = pool.filter((d) => d.role !== "teamlead");
  const base = { iid: m.iid, title: m.title, task_role: taskRole, needed, assignee: assignee?.username ?? null };
  if (!pool.length) return { ...base, error: "пул кандидатов пуст — заполни gitlab.id у разрабов нужной касты в team.json", reviewer_gitlab_ids: [] };
  // load-aware: число открытых MR, где кандидат уже ревьюер (по pollProjects).
  const projects = WCFG.pollProjects ?? [];
  const load: Record<number, number> = {};
  for (const d of pool) {
    const gid = d.gitlab!.id as number; let n = 0;
    for (const p of projects) {
      const r = await gl("GET", `/projects/${encProj(p)}/merge_requests?state=opened&reviewer_id=${gid}&per_page=100`);
      if (r.status === 200 && Array.isArray(r.json)) n += r.json.length;
    }
    load[gid] = n;
  }
  const chosen = pool.slice().sort((a, b) => (load[a.gitlab!.id as number] ?? 0) - (load[b.gitlab!.id as number] ?? 0)).slice(0, needed);
  return {
    ...base,
    suggested: chosen.map((d) => ({ name: d.name, gitlab_id: d.gitlab!.id, open_reviews: load[d.gitlab!.id as number] ?? 0, role: isFrontend(d) ? "frontend" : "backend" })),
    reviewer_gitlab_ids: chosen.map((d) => d.gitlab!.id),
  };
}

// ─── MCP сервер ───────────────────────────────────────────────────────────────
const server = new McpServer({ name: "gitlab-write-mcp", version: "0.2.0" });

// list_open_mrs — полл открытых MR (для релиз-менеджера / автоназначения).
server.tool(
  "list_open_mrs",
  `Открытые MR (для полла). Без project — по всем pollProjects из конфига; target_branch — фильтр
(напр. конкретная rc-ветка). Возвращает компактные ряды (merge_status, ветки, автор, ревьюеры).`,
  { project: z.union([z.string(), z.number()]).optional(), target_branch: z.string().optional(), limit: z.number().optional() },
  async ({ project, target_branch, limit }) => {
    const projects = project != null ? [project] : (WCFG.pollProjects ?? []);
    if (!projects.length) return ok({ error: "нет проектов: задай project или pollProjects в config/gitlab-write.json5" });
    const out: any[] = [];
    for (const p of projects) {
      const q = new URLSearchParams({ state: "opened", per_page: String(limit ?? 50) });
      if (target_branch) q.set("target_branch", target_branch);
      const r = await gl("GET", `/projects/${encProj(p)}/merge_requests?${q.toString()}`);
      if (r.status !== 200) { out.push({ project: String(p), error: `GitLab ${r.status}: ${r.text.slice(0, 150)}` }); continue; }
      for (const m of (r.json as any[]) ?? []) out.push(mrRow(p, m));
    }
    return ok({ count: out.length, merge_requests: out });
  },
);

// get_mr — детали + сводка изменённых файлов (классификация + проверка мёрджа).
server.tool(
  "get_mr",
  `Детали MR + сводка изменённых файлов (расширения — для классификации backend/frontend и проверки мёрджа).
merge_status: can_be_merged / cannot_be_merged. Диф берём через /changes (на GitLab 15.1.4 /diffs = 404).`,
  { project: z.union([z.string(), z.number()]), iid: z.number() },
  async ({ project, iid }) => {
    const r = await gl("GET", `/projects/${encProj(project)}/merge_requests/${iid}`);
    if (r.status !== 200) return ok({ error: `GitLab ${r.status}: ${r.text.slice(0, 200)}` });
    const m = r.json;
    const ch = await gl("GET", `/projects/${encProj(project)}/merge_requests/${iid}/changes`);
    const files: string[] = ((ch.json?.changes ?? []) as any[]).map((c) => c.new_path || c.old_path).filter(Boolean);
    const exts = [...new Set(files.map((f) => (f.match(/\.([a-z0-9]+)$/i)?.[1] || "").toLowerCase()).filter(Boolean))];
    return ok({ ...mrRow(project, m), description: String(m.description ?? "").slice(0, 500), changed_files: files.length, extensions: exts });
  },
);

// merge_mr — смёрджить (прод-мутация, за approval-гейтом).
server.tool(
  "merge_mr",
  `СМЁРДЖИТЬ MR (прод-мутация, за approval-гейтом). Гарды: target-ветка ДОЛЖНА совпасть с allowedMergeTargets
(default-deny, напр. rc-*); MR ДОЛЖЕН быть mergeable (merge_status=can_be_merged, без конфликтов). ⚠ Условие
«задача Redmine в статусе Исполнено(27)» проверяет ЛОГИКА релиз-менеджера ДО вызова. DRY_RUN → лог намерения.`,
  { project: z.union([z.string(), z.number()]), iid: z.number() },
  async ({ project, iid }) => {
    const g = await gl("GET", `/projects/${encProj(project)}/merge_requests/${iid}`);
    if (g.status !== 200) return ok({ error: `не прочитал MR: GitLab ${g.status}` });
    const m = g.json;
    if (!mergeTargetAllowed(m.target_branch)) {
      return ok({ error: `target "${m.target_branch}" НЕ в allowedMergeTargets (default-deny). Разрешены: ${(WCFG.allowedMergeTargets ?? []).join(", ") || "(пусто — заполни config/gitlab-write.json5)"}` });
    }
    if (m.merge_status !== "can_be_merged" || m.has_conflicts) {
      return ok({ error: `MR не mergeable: merge_status=${m.merge_status}, has_conflicts=${m.has_conflicts}. Релиз-менеджер мёрджит только бесконфликтные — пропуск.` });
    }
    logHistory("merge_mr", { project: String(project), iid, target: m.target_branch, title: m.title });
    if (DRY_RUN) return ok({ dry_run: true, would_merge: { project: String(project), iid, target: m.target_branch, title: m.title }, note: "DRY_RUN — не смёрджено. DRY_RUN=false для реальной записи." });
    const r = await gl("PUT", `/projects/${encProj(project)}/merge_requests/${iid}/merge`, {});
    if (r.status !== 200) return ok({ error: `GitLab merge ${r.status}: ${r.text.slice(0, 300)}` });
    return ok({ ok: true, merged: { project: String(project), iid, into: m.target_branch }, web_url: m.web_url });
  },
);

// set_reviewers — назначить ревьюеров (прод-мутация, за approval-гейтом).
server.tool(
  "set_reviewers",
  `Назначить РЕВЬЮЕРОВ MR (прод-мутация, за approval-гейтом). reviewer_gitlab_ids — числовые GitLab user id
(обычно из suggest_reviewers). DRY_RUN → лог намерения.`,
  { project: z.union([z.string(), z.number()]), iid: z.number(), reviewer_gitlab_ids: z.array(z.number()) },
  async ({ project, iid, reviewer_gitlab_ids }) => {
    logHistory("set_reviewers", { project: String(project), iid, reviewer_gitlab_ids });
    if (DRY_RUN) return ok({ dry_run: true, would_set_reviewers: { project: String(project), iid, reviewer_gitlab_ids } });
    const r = await gl("PUT", `/projects/${encProj(project)}/merge_requests/${iid}`, { reviewer_ids: reviewer_gitlab_ids });
    if (r.status !== 200) return ok({ error: `GitLab ${r.status}: ${r.text.slice(0, 300)}` });
    return ok({ ok: true, project: String(project), iid, reviewers: (r.json?.reviewers ?? []).map((x: any) => x.username) });
  },
);

// suggest_reviewers — предложить ревьюеров для ОДНОГО MR (НЕ назначает; для preview+апрува).
server.tool(
  "suggest_reviewers",
  `Предложить ревьюеров для MR (НЕ назначает — для preview+апрува; дальше set_reviewers). Детерминированно (ADR-0025
NB): каста по assignee (frontend ⇒ 1 ревьюер; иначе бекенд/фулстек ⇒ 2); кандидаты из касты (team.json roles+gitlab.id),
load-aware (по числу открытых MR в ревью), исключая автора, тимлида НЕ исключая.`,
  { project: z.union([z.string(), z.number()]), iid: z.number() },
  async ({ project, iid }) => {
    const g = await gl("GET", `/projects/${encProj(project)}/merge_requests/${iid}`);
    if (g.status !== 200) return ok({ error: `не прочитал MR: GitLab ${g.status}` });
    const s = await computeSuggestion(g.json);
    return ok({ project: String(project), ...s, note: "Предложение. Покажи тимлиду → set_reviewers(reviewer_gitlab_ids) после апрува." });
  },
);

// plan_release_merges — ДЕТЕРМИНИРОВАННЫЙ скан кандидатов на автомёрдж в rc-* (НЕ мёрджит).
server.tool(
  "plan_release_merges",
  `Скан rc-*-MR на готовность к автомёрджу (ДЕТЕРМИНИРОВАННО, НЕ мёрджит — план для апрува). По каждому pollProject
берёт открытые MR с target по allowedMergeTargets (rc-*) и классифицирует: eligible (бесконфликтный + связанная
задача Redmine в статусе mergeRequiresTaskStatus[=Исполнено]) / skipped (+причина: конфликт / статус / нет задачи /
Redmine недоступен). Оркестратор показывает eligible тимлиду → тап-апрув → merge_mr (гейт) по каждому.`,
  {},
  async () => {
    const projects = WCFG.pollProjects ?? [];
    const reqStatus = WCFG.mergeRequiresTaskStatus ?? "Исполнено";
    const eligible: any[] = []; const skipped: any[] = [];
    for (const p of projects) {
      const r = await gl("GET", `/projects/${encProj(p)}/merge_requests?state=opened&per_page=100`);
      if (r.status !== 200) { skipped.push({ project: String(p), error: `GitLab ${r.status}` }); continue; }
      for (const m of (r.json as any[]) ?? []) {
        if (!mergeTargetAllowed(m.target_branch)) continue;   // не rc-* → не наша забота
        const row = { project: String(p), iid: m.iid, title: m.title, source: m.source_branch, target: m.target_branch, web_url: m.web_url };
        if (m.merge_status !== "can_be_merged" || m.has_conflicts) { skipped.push({ ...row, reason: `не mergeable (merge_status=${m.merge_status}, conflicts=${!!m.has_conflicts})` }); continue; }
        const taskId = taskIdFromBranch(m.source_branch);
        if (!taskId) { skipped.push({ ...row, reason: "не извлёк Redmine-задачу из source_branch (#NNNNN)" }); continue; }
        const status = await redmineIssueStatus(taskId);
        if (status == null) { skipped.push({ ...row, redmine_id: taskId, reason: rmAuthAvailable ? "не прочитал статус задачи" : "Redmine read недоступен (нет REDMINE_* у gitlab-write)" }); continue; }
        if (status.trim().toLowerCase() !== reqStatus.trim().toLowerCase()) { skipped.push({ ...row, redmine_id: taskId, reason: `статус задачи "${status}" ≠ "${reqStatus}"` }); continue; }
        eligible.push({ ...row, redmine_id: taskId, task_status: status });
      }
    }
    return ok({ require_task_status: reqStatus, redmine_available: rmAuthAvailable, eligible_count: eligible.length, eligible, skipped_count: skipped.length, skipped,
      note: "eligible — кандидаты на мёрдж. НЕ мёрджит сам: по каждому → апрув тимлида → merge_mr (гейт)." });
  },
);

// plan_review_assignments — ДЕТЕРМИНИРОВАННЫЙ скан dev-MR без ревьюеров + подбор (НЕ назначает).
server.tool(
  "plan_review_assignments",
  `Скан MR в целевой ветке (reviewScanTargetBranch[=dev]) БЕЗ назначенных ревьюеров + детерминированный подбор по
каждому (suggest-логика). НЕ назначает — план для апрува. Оркестратор показывает → апрув → set_reviewers (гейт).`,
  {},
  async () => {
    const projects = WCFG.pollProjects ?? [];
    const target = WCFG.reviewScanTargetBranch ?? "dev";
    const plan: any[] = [];
    for (const p of projects) {
      const r = await gl("GET", `/projects/${encProj(p)}/merge_requests?state=opened&target_branch=${encodeURIComponent(target)}&per_page=100`);
      if (r.status !== 200) { plan.push({ project: String(p), error: `GitLab ${r.status}` }); continue; }
      for (const m of (r.json as any[]) ?? []) {
        if ((m.reviewers ?? []).length > 0) continue;        // ревьюер уже есть → пропуск
        const s = await computeSuggestion(m);
        plan.push({ project: String(p), web_url: m.web_url, ...s });
      }
    }
    return ok({ target_branch: target, count: plan.length, assignments: plan,
      note: "Без ревьюера → предложен подбор. НЕ назначает: по каждому → апрув → set_reviewers(project,iid,reviewer_gitlab_ids)." });
  },
);

// create_mr — создать MR напрямую через GitLab API (без локального git).
server.tool(
  "create_mr",
  `Создать MR через GitLab API (МУТАЦИЯ, за approval-гейтом). НЕ требует локального git/push —
  ветка source_branch ДОЛЖНА уже существовать в GitLab. target_branch проверяется на
  allowedMergeTargets (default-deny). DRY_RUN → лог намерения.`,
  {
    project:        z.union([z.number(), z.string()]),
    source_branch:  z.string().describe("ветка-источник (должна существовать в GitLab)"),
    target_branch:  z.string().describe("ветка-цель (напр. rc-a.1.5.5.0 или develop)"),
    title:          z.string().describe("заголовок MR"),
    description:    z.string().optional().describe("описание MR (markdown)"),
    assignee_id:    z.number().optional().describe("GitLab ID ответственного"),
    remove_source_branch: z.boolean().optional().describe("удалить source-ветку после мёрджа"),
  },
  async ({ project, source_branch, target_branch, title, description, assignee_id, remove_source_branch }) => {
    if (!mergeTargetAllowed(target_branch)) {
      return ok({ error: `target "${target_branch}" НЕ в allowedMergeTargets (default-deny). Разрешены: ${(WCFG.allowedMergeTargets ?? []).join(", ") || "(пусто — заполни config/gitlab-write.json5)"}` });
    }
    // Проверяем, что source-ветка существует
    const branchCheck = await gl("GET", `/projects/${encProj(project)}/repository/branches/${encodeURIComponent(source_branch)}`);
    if (branchCheck.status !== 200) {
      return ok({ error: `ветка "${source_branch}" не найдена в проекте ${project} (GitLab ${branchCheck.status})` });
    }
    // Проверяем, нет ли уже открытого MR source→target
    const existing = await gl("GET", `/projects/${encProj(project)}/merge_requests?source_branch=${encodeURIComponent(source_branch)}&target_branch=${encodeURIComponent(target_branch)}&state=opened`);
    if (existing.status === 200 && Array.isArray(existing.json) && existing.json.length > 0) {
      const mr = existing.json[0];
      return ok({ already_exists: true, iid: mr.iid, web_url: mr.web_url, title: mr.title, note: "MR уже существует — создание пропущено." });
    }
    const body: any = { source_branch, target_branch, title };
    if (description != null) body.description = description + attribution();
    else body.description = `MR создан агентом gitlab-write.${attribution()}`;
    if (assignee_id != null) body.assignee_id = assignee_id;
    if (remove_source_branch != null) body.remove_source_branch = remove_source_branch;

    logHistory("create_mr", { project: String(project), source_branch, target_branch, title });
    if (DRY_RUN) return ok({ dry_run: true, would_create: { project: String(project), source_branch, target_branch, title } });

    const r = await gl("POST", `/projects/${encProj(project)}/merge_requests`, body);
    if (r.status === 201) {
      logHistory("create_mr_ok", { project: String(project), iid: r.json?.iid, web_url: r.json?.web_url });
      return ok({ ok: true, iid: r.json?.iid, title: r.json?.title, web_url: r.json?.web_url, merge_status: r.json?.merge_status });
    }
    return ok({ error: `GitLab ${r.status}: ${(r.text ?? "").slice(0, 300)}` });
  },
);

// ── post_mr_comment ─────────────────────────────────────────────────────────
server.tool(
  "post_mr_comment",
  `Пост комментария в MR (МУТАЦИЯ, за approval-гейтом). При DRY_RUN=true — лог, без записи.`,
  {
    project: z.union([z.number(), z.string()]),
    mr_iid:   z.number(),
    body:     z.string().describe("текст комментария (поддерживается markdown)"),
  },
  async ({ project, mr_iid, body }) => {
    if (DRY_RUN) {
      logHistory("would_post_comment", { project: String(project), mr_iid, length: body.length });
      return ok({ dry_run: true, would_post: true, project, mr_iid, body_preview: body.slice(0, 200) });
    }
    const r = await gl("POST", `/projects/${encProj(project)}/merge_requests/${mr_iid}/notes`, { body });
    if (r.status === 201) {
      logHistory("post_comment", { project: String(project), mr_iid });
      return ok({ ok: true, posted: true, note_id: r.json?.id });
    }
    return ok({ error: `GitLab ${r.status}: ${(r.text ?? "").slice(0, 200)}` });
  },
);

// gitlab_write_config_info — что разрешено + полнота маппинга.
server.tool(
  "gitlab_write_config_info",
  "Конфиг gitlab-write: DRY_RUN, allowedMergeTargets, pollProjects, reviewer-настройки, полнота gitlab-маппинга team.json.",
  {},
  async () => ok({
    dry_run: DRY_RUN, base_url: BASE_URL,
    allowed_merge_targets: WCFG.allowedMergeTargets ?? [],
    poll_projects: WCFG.pollProjects ?? [],
    reviewer_assignment: WCFG.reviewerAssignment ?? {},
    gitlab_mapping: DEVS.map((d) => ({ name: d.name, role: isFrontend(d) ? "frontend" : "backend", gitlab_id: d.gitlab?.id ?? null })),
    mapping_complete: DEVS.length > 0 && DEVS.every((d) => d.gitlab?.id != null),
    note: "merge_mr/set_reviewers гейтятся approval-gate (кнопка в Telegram). allowedMergeTargets — default-deny.",
  }),
);

await server.connect(new StdioServerTransport());
console.error(`[gitlab-write] v0.2.0 (DRY_RUN=${DRY_RUN}, mergeTargets=${(WCFG.allowedMergeTargets ?? []).length}, pollProjects=${(WCFG.pollProjects ?? []).length}, mappedDevs=${DEVS.filter((d) => d.gitlab?.id != null).length}/${DEVS.length}, redmineRead=${rmAuthAvailable})`);
