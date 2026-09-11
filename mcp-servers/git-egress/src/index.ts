#!/usr/bin/env node
/**
 * Git-egress MCP (ADR-0027 этап 2) — ОТДЕЛЬНЫЙ агент для push+MR+review.
 *
 * Ответственность: берёт ГОТОВУЮ ветку #NNNNN (харнес завершил, коммиты есть)
 * и выводит её наружу: push → create MR → review → обновление статуса Redmine.
 * Харнес НЕ пушит (no-push ADR-0008 цел) — egress-поверхность изолирована.
 *
 * Цикл (setInterval, 5 мин): поллинг задач в статусе "done" → push → MR → status.
 * Тулзы: egress_status, egress_process, egress_push (ручной).
 *
 * Env: GITLAB_BASE_URL, GITLAB_WRITE_TOKEN, REDMINE_BASE_URL, REDMINE_LOGIN/PASSWORD,
 *      AGENT_REPO_ROOT, TELEGRAM_BOT_TOKEN, TELEGRAM_ALLOWED_USER_IDS,
 *      TELEGRAM_PROXY, HARNESS_NOTIFY_CHAT_ID, PROJECTS_REGISTRY,
 *      EXECUTOR_STORE_PATH (~/.openclaw/agent-worker/pool-state.json).
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { z } from "zod";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const JSON5 = require("json5");

const ok = (obj: unknown) => ({ content: [{ type: "text" as const, text: typeof obj === "string" ? obj : JSON.stringify(obj, null, 2) }] });
const clean = (v?: string): string => { const s = (v ?? "").trim(); return /^\$\{.*\}$/.test(s) ? "" : s; };

// ─── Config ─────────────────────────────────────────────────────────────────
const REPO_ROOT    = clean(process.env.AGENT_REPO_ROOT);
const GL_BASE_URL  = clean(process.env.GITLAB_BASE_URL);
const GL_TOKEN     = clean(process.env.GITLAB_WRITE_TOKEN);
const hasGitlab    = Boolean(GL_BASE_URL && GL_TOKEN);

const RM_BASE  = clean(process.env.REDMINE_BASE_URL);
const RM_LOGIN = clean(process.env.REDMINE_LOGIN);
const RM_PASS  = clean(process.env.REDMINE_PASSWORD);
const hasRedmine = Boolean(RM_BASE && RM_LOGIN && RM_PASS);

const TG_TOKEN   = clean(process.env.TELEGRAM_BOT_TOKEN);
const TG_ALLOWED = clean(process.env.TELEGRAM_ALLOWED_USER_IDS) || "";
const TG_PROXY   = clean(process.env.TELEGRAM_PROXY) || clean(process.env.PROXY_URL);
const TG_CHAT    = clean(process.env.HARNESS_NOTIFY_CHAT_ID) || (TG_ALLOWED.match(/-?\d{5,}/) || [])[0] || "";

const EXECUTOR_STORE = clean(process.env.EXECUTOR_STORE_PATH) || join(REPO_ROOT, "workspace", "state", "pool-state.json");
const STORE_PATH = clean(process.env.EGRESS_STORE_PATH) || join(REPO_ROOT, "workspace", "state", "git-egress-state.json");
const POLL_INTERVAL = 300_000;
const DRY_RUN = clean(process.env.DRY_RUN) === "true";
const EPIC_TRACKER_ID = 26;

type EgTask = { taskId: string; redmineId: number; subject: string; repoPath: string; branch: string; gitlabProjectId?: number; mrIid?: number; mrWebUrl?: string; targetBranch?: string; state: "pending" | "pushing" | "done" | "failed"; error?: string };
type EgStore = { tasks: EgTask[]; lastPoll: string };

// ─── GitLab-write config (shared) ────────────────────────────────────────────
type GlWriteCfg = { pollProjects?: number[]; allowedMergeTargets?: string[]; reviewScanTargetBranch?: string; mergeRequiresTaskStatus?: string; egressTargetBranch?: string; egressTargetBranchPerProject?: Record<number, string> };
let GLWR: GlWriteCfg = {};
{ const p = clean(process.env.GITLAB_WRITE_CONFIG) || join(REPO_ROOT, "config", "gitlab-write.json5");
  if (p && existsSync(p)) try { GLWR = JSON5.parse(readFileSync(p, "utf8")) as GlWriteCfg; } catch { /* */ } }

// ─── Projects registry ───────────────────────────────────────────────────────
type ProjReg = { baseDir?: string; projects?: Record<string, { repoPath?: string; gitlabProjectId?: number | null }> };
let PROJ: ProjReg = {};
{ const p = clean(process.env.PROJECTS_REGISTRY) || join(REPO_ROOT, "config", "projects.json5");
  if (p && existsSync(p)) try { PROJ = JSON5.parse(readFileSync(p, "utf8")) as ProjReg; } catch { /* */ } }

function targetBranchForProject(glProjectId: number): string {
  if (GLWR.egressTargetBranchPerProject?.[glProjectId]) return GLWR.egressTargetBranchPerProject[glProjectId];
  return GLWR.egressTargetBranch || "develop";
}

// ─── GitLab REST ────────────────────────────────────────────────────────────
const GL_API = hasGitlab ? `${GL_BASE_URL!.replace(/\/$/, "")}/api/v4` : "";
async function gl(method: string, path: string, body?: unknown): Promise<{ status: number; json: any; text?: string }> {
  if (!hasGitlab) return { status: 0, json: null, text: "GITLAB_WRITE_TOKEN не задан" };
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 20_000);
  try {
    const r = await fetch(`${GL_API}${path}`, {
      method, headers: { "PRIVATE-TOKEN": GL_TOKEN!, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined, signal: ctrl.signal,
    });
    const text = await r.text(); let j: any = null; try { j = text ? JSON.parse(text) : null; } catch { /* */ }
    return { status: r.status, json: j, text };
  } finally { clearTimeout(t); }
}

// ─── Redmine REST ───────────────────────────────────────────────────────────
function rmAuth(): Record<string, string> {
  return { Accept: "application/json", Authorization: `Basic ${Buffer.from(`${RM_LOGIN}:${RM_PASS}`).toString("base64")}` };
}
async function rmPut(path: string, body: any): Promise<boolean> {
  if (!hasRedmine) return false;
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 15_000);
  try {
    const r = await fetch(`${RM_BASE!.replace(/\/$/, "")}${path}`, {
      method: "PUT", headers: { ...rmAuth(), "Content-Type": "application/json" },
      body: JSON.stringify(body), signal: ctrl.signal,
    });
    return r.ok;
  } catch { return false; }
  finally { clearTimeout(t); }
}

// ─── Telegram ───────────────────────────────────────────────────────────────
async function announce(text: string): Promise<void> {
  if (!TG_TOKEN || !TG_CHAT) return;
  try {
    const opts: any = { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chat_id: TG_CHAT, text, disable_web_page_preview: true }), signal: AbortSignal.timeout(12_000) };
    if (TG_PROXY) { const { ProxyAgent } = await import("undici"); opts.dispatcher = new ProxyAgent(TG_PROXY); }
    await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, opts);
  } catch { /* */ }
}

// ─── State ──────────────────────────────────────────────────────────────────
function loadStore(): EgStore {
  try { if (existsSync(STORE_PATH)) return JSON.parse(readFileSync(STORE_PATH, "utf8")) as EgStore; } catch { /* */ }
  return { tasks: [], lastPoll: "" };
}
function saveStore(s: EgStore): void {
  try {
    mkdirSync(dirname(STORE_PATH), { recursive: true });
    writeFileSync(STORE_PATH, JSON.stringify(s, null, 2));
    try {
      if (REPO_ROOT) {
        mkdirSync(join(REPO_ROOT, "workspace", "state"), { recursive: true });
        writeFileSync(join(REPO_ROOT, "workspace", "state", "git-egress-state.json"), JSON.stringify(s, null, 2));
      }
    } catch { /* workspace mirror — не критично */ }
  } catch { /* */ }
}

// Обратная запись в pool-state: после успешного egress обновить задачу.
function updateExecutorStore(taskId: string, mrIid: number, mrWebUrl: string): void {
  if (!existsSync(EXECUTOR_STORE)) return;
  try {
    const raw = readFileSync(EXECUTOR_STORE, "utf8");
    const executorData = JSON5.parse(raw);
    const tasks = executorData?.tasks ?? [];
    const t = tasks.find((t: any) => String(t.task_id ?? t.redmine_id) === taskId);
    if (t && t.state === "done") {
      t.state = "review";
      t.mrIid = mrIid;
      t.mrWebUrl = mrWebUrl;
      writeFileSync(EXECUTOR_STORE, JSON.stringify(executorData, null, 2));
      console.error(`[git-egress] обновлён pool-state: #${t.redmine_id} done→review, MR !${mrIid}`);
    }
  } catch (e: any) { console.error(`[git-egress] не смог обновить pool-state: ${e?.message ?? e}`); }
}

// ─── Git operations ─────────────────────────────────────────────────────────
function gitPush(repoPath: string, branch: string): { ok: boolean; error?: string } {
  const remotes = (spawnSync("git", ["remote"], { cwd: repoPath, encoding: "utf8" }).stdout || "").trim().split("\n")[0];
  if (remotes) {
    spawnSync("git", ["config", "--unset", `remote.${remotes}.pushurl`], { cwd: repoPath });
    const r = spawnSync("git", ["push", "-u", remotes, branch], { cwd: repoPath, encoding: "utf8", timeout: 30_000 });
    if (r.status === 0) return { ok: true };
    return { ok: false, error: (r.stderr || r.stdout || "").slice(0, 300) };
  }
  return { ok: false, error: "нет git remote" };
}

// ─── Epic helper ─────────────────────────────────────────────────────────────
async function getEpicBranch(redmineId: number): Promise<string | null> {
  if (!hasRedmine) return null;
  try {
    const r1 = await rmGet(`/issues/${redmineId}.json`);
    const parentId = r1?.issue?.parent?.id as number | undefined;
    if (!parentId) return null;
    const r2 = await rmGet(`/issues/${parentId}.json`);
    const trackerId = r2?.issue?.tracker?.id as number | undefined;
    if (trackerId === EPIC_TRACKER_ID) return `#${parentId}`;
  } catch { /* */ }
  return null;
}

async function rmGet(path: string): Promise<any | null> {
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 10_000);
  try {
    const r = await fetch(`${RM_BASE!.replace(/\/$/, "")}${path}`, {
      headers: rmAuth(), signal: ctrl.signal,
    });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
  finally { clearTimeout(t); }
}

// ─── Main tick: poll executor store for "done" tasks → egress ───────────────
let cycling = false;
async function tick(): Promise<string[]> {
  if (cycling || !hasGitlab) return [];
  cycling = true;
  const log: string[] = [];
  const add = (s: string) => { console.log(`[git-egress] ${s}`); log.push(s); };
  if (DRY_RUN) add("⚠ DRY_RUN=true — запись в GitLab/Redmine заблокирована");
  try {
    if (!existsSync(EXECUTOR_STORE)) { cycling = false; return log; }
    let executorData: any;
    try { executorData = JSON5.parse(readFileSync(EXECUTOR_STORE, "utf8")); } catch { cycling = false; return log; }

    const store = loadStore();
    const doneTasks = (executorData?.tasks ?? []).filter((t: any) => t.state === "done" && t.branch && t.repo_path);

    // Retry failed tasks from previous cycles
    const retryTasks = store.tasks.filter((t) => t.state === "failed" && t.error?.includes("push"));
    if (retryTasks.length) add(`повтор: ${retryTasks.length} неудавшихся push(ей)`);

    const knownIds = new Set(store.tasks.map((t) => t.taskId));
    const allTasks: Array<{ taskId: string; redmineId: number; subject: string; repoPath: string; branch: string; gitlabProjectId: number | undefined; state: "pending" }> = [];
    for (const t of retryTasks) allTasks.push({ taskId: t.taskId, redmineId: t.redmineId, subject: t.subject, repoPath: t.repoPath, branch: t.branch, gitlabProjectId: t.gitlabProjectId, state: "pending" });
    for (const dt of doneTasks) {
      const tid = String(dt.task_id ?? dt.redmine_id ?? "?");
      if (!knownIds.has(tid)) {
        allTasks.push({ taskId: tid, redmineId: dt.redmine_id as number, subject: String(dt.task_id ?? "").slice(0, 100), repoPath: dt.repo_path as string, branch: dt.branch as string, gitlabProjectId: dt.gitlab_project_id as number | undefined, state: "pending" });
      }
    }

    for (const dt of allTasks) {
      const tid = dt.taskId;

      let task = store.tasks.find((t) => t.taskId === tid);
      if (!task) {
        task = { taskId: tid, redmineId: dt.redmineId, subject: dt.subject, repoPath: dt.repoPath, branch: dt.branch, gitlabProjectId: dt.gitlabProjectId, state: "pending" };
        store.tasks.push(task);
      }
      const isRetry = retryTasks.some((t) => t.taskId === tid);
      add(`#${task.redmineId}${isRetry ? " (retry)" : " новая"} ветка=${task.branch}`);

      // Push
      task.state = "pushing";
      if (DRY_RUN) { add(`  [DRY_RUN] push ${task.branch}`); }
      else {
        const pushResult = gitPush(task.repoPath, task.branch);
        if (!pushResult.ok) { task.state = "failed"; task.error = `push: ${pushResult.error}`; add(`  ✖ ${task.error}`); saveStore(store); continue; }
        add(`  ✅ push ${task.branch}`);
      }

      // Determine target branch (epic-aware, skip for retries — already set)
      let targetBranch = task.targetBranch || (task.gitlabProjectId ? targetBranchForProject(task.gitlabProjectId) : "develop");
      let epicBranch: string | null = null;
      if (hasRedmine && !isRetry && !task.targetBranch) {
        epicBranch = await getEpicBranch(task.redmineId);
        if (epicBranch && targetBranch === "develop") { targetBranch = epicBranch; add(`  🔗 эпик-ветка: ${epicBranch}`); }
      }

      // Create MR
      let mrLink = "";
      if (task.gitlabProjectId && !DRY_RUN) {
        // Check if MR already exists
        const existing = await gl("GET", `/projects/${task.gitlabProjectId}/merge_requests?source_branch=${encodeURIComponent(task.branch)}&target_branch=${encodeURIComponent(targetBranch)}&state=opened&per_page=1`);
        if (existing.status === 200 && Array.isArray(existing.json) && existing.json.length > 0) {
          task.mrIid = existing.json[0].iid;
          task.mrWebUrl = existing.json[0].web_url;
          mrLink = task.mrWebUrl ?? `MR !${task.mrIid}`;
          add(`  ⚡ MR уже существует → ${mrLink}`);
        } else {
          const mrR = await gl("POST", `/projects/${task.gitlabProjectId}/merge_requests`, {
            source_branch: task.branch, target_branch: targetBranch,
            title: `${task.branch} ${task.subject.slice(0, 80)}`,
            description: [
              `## ${task.branch} — ${task.subject}`,
              `Ссылка на задачу: ${RM_BASE!.replace(/\/$/, "")}/issues/${task.redmineId}`,
              "", "### Реализовано", `См. коммиты в ветке \`${task.branch}\`.`,
              epicBranch ? `### Эпик\nЗадача — подзадача эпика. MR направлен в эпик-ветку \`${epicBranch}\`.` : "",
              "", `🤖 Автоматический MR создан агентом git-egress.`,
            ].join("\n"),
          });
          if (mrR.status === 201) {
            task.mrIid = mrR.json?.iid;
            task.mrWebUrl = mrR.json?.web_url;
            mrLink = task.mrWebUrl ?? `MR !${task.mrIid}`;
            add(`  ✅ MR !${task.mrIid} → ${targetBranch}`);
          } else {
            const err = (mrR.text ?? "").slice(0, 120);
            task.state = "failed"; task.error = `MR: ${mrR.status} ${err}`; mrLink = "(MR не создан)";
            add(`  ✖ MR: ${err}`); saveStore(store); continue;
          }
        }
      } else if (DRY_RUN) {
        mrLink = `[DRY_RUN] MR → ${targetBranch}`;
        add(`  [DRY_RUN] создал бы MR → ${targetBranch}`);
      } else {
        mrLink = "(нет gitlabProjectId — ручной MR)";
      }

      // Update Redmine
      if (hasRedmine && !DRY_RUN) {
        const note = [
          "🤖 Агент завершил работу (git-egress).",
          `Ветка: \`${task.branch}\``,
          epicBranch ? `Эпик-ветка: \`${epicBranch}\`. MR → \`${targetBranch}\`.` : "",
          mrLink ? `MR: ${mrLink}` : "",
        ].filter(Boolean).join("\n");
        await rmPut(`/issues/${task.redmineId}.json`, { issue: { status_id: 13, notes: note } });
      } else if (DRY_RUN) {
        add(`  [DRY_RUN] Redmine → статус 13`);
      }
      task.state = "done";
      task.targetBranch = targetBranch;
      if (!DRY_RUN && task.mrIid && task.mrWebUrl) updateExecutorStore(task.taskId, task.mrIid, task.mrWebUrl);
      if (!DRY_RUN) await announce(`✅ #${task.redmineId} — код готов, MR создан${epicBranch ? ` в эпик-ветку ${epicBranch}` : ""}.${mrLink ? ` MR: ${mrLink}` : ""}`);
      add(`#${task.redmineId}: ✅ egress complete${DRY_RUN ? " [DRY_RUN]" : ""}`);
    }
    store.lastPoll = new Date().toISOString();
    saveStore(store);
  } catch (e: any) { log.push(`ошибка: ${e?.message ?? e}`); }
  finally { cycling = false; }
  return log;
}

// ─── MCP tools ──────────────────────────────────────────────────────────────
const server = new McpServer({ name: "git-egress", version: "0.2.0" });

server.tool("egress_status", "Состояние очереди git-egress: задачи на выпуск.", {}, async () => {
  const s = loadStore();
  return ok({ tasks: s.tasks.map((t) => ({ id: `#${t.redmineId}`, subject: t.subject.slice(0, 100), state: t.state, branch: t.branch, target: t.targetBranch ?? "develop", mr: t.mrWebUrl ?? null, error: t.error?.slice(0, 120) })), last_poll: s.lastPoll, gitlab: hasGitlab, redmine: hasRedmine, dry_run: DRY_RUN });
});

server.tool("egress_process", "Ручной тик egress-цикла.", {}, async () => {
  const steps = await tick();
  return ok({ steps, timestamp: new Date().toISOString() });
});

async function _egressPush(args: { redmine_id: number; repo_path: string; gitlab_project_id?: number; target_branch?: string }): Promise<ReturnType<typeof ok>> {
  const { redmine_id, repo_path, gitlab_project_id, target_branch } = args;
  const target = target_branch || (gitlab_project_id ? targetBranchForProject(gitlab_project_id) : "develop");
  if (!hasGitlab) return ok({ error: "GITLAB_WRITE_TOKEN не задан" });
  const branch = `#${redmine_id}`;
  if (!existsSync(join(repo_path, ".git"))) return ok({ error: `не git-репо: ${repo_path}` });

  if (DRY_RUN) return ok({ dry_run: true, redmine_id, branch, target, repo: repo_path });

  const pushR = gitPush(repo_path, branch);
  if (!pushR.ok) return ok({ error: `push: ${pushR.error}` });

  let mrLink = "";
  if (gitlab_project_id) {
    // Check for existing MR
    const existing = await gl("GET", `/projects/${gitlab_project_id}/merge_requests?source_branch=${encodeURIComponent(branch)}&target_branch=${encodeURIComponent(target)}&state=opened&per_page=1`);
    if (existing.status === 200 && Array.isArray(existing.json) && existing.json.length > 0) {
      mrLink = existing.json[0].web_url ?? `MR !${existing.json[0].iid}`;
    } else {
      const mrR = await gl("POST", `/projects/${gitlab_project_id}/merge_requests`, {
        source_branch: branch, target_branch: target, title: `${branch} Ручной egress → ${target}`, description: `Задача: #${redmine_id}\n🤖 Ручной egress.`,
      });
      if (mrR.status === 201) mrLink = mrR.json?.web_url ?? `MR !${mrR.json?.iid}`;
      else return ok({ error: `MR: ${(mrR.text ?? "").slice(0, 200)}`, push: "ok" });
    }
  }
  if (hasRedmine) await rmPut(`/issues/${redmine_id}.json`, { issue: { status_id: 13, notes: `🤖 Ручной egress: ветка \`${branch}\`${mrLink ? `, MR: ${mrLink}` : ""}` } });
  await announce(`✅ #${redmine_id} — ручной egress.${mrLink ? ` MR: ${mrLink}` : ""}`);
  return ok({ ok: true, redmine_id, branch, target, mr: mrLink || "без GitLab проекта" });
}
(server as any).tool("egress_push", "Ручной push+MR для конкретной задачи (ветка #NNNNN должна существовать).", {
  redmine_id: z.number(), repo_path: z.string(), gitlab_project_id: z.number().optional(), target_branch: z.string().optional(),
}, _egressPush);

// ─── Internal loop ──────────────────────────────────────────────────────────
let loopTimer: ReturnType<typeof setInterval> | null = null;
function startLoop() {
  if (loopTimer) return;
  console.error(`[git-egress] v0.3.0 (gitlab=${hasGitlab ? "on" : "OFF"}, redmine=${hasRedmine ? "on" : "OFF"}, poll=5min, dry_run=${DRY_RUN ? "ON" : "off"})`);
  const tickWrapper = async () => { try { await tick(); } catch (e: any) { console.error(`[git-egress] tick: ${e?.message ?? e}`); } };
  tickWrapper();
  loopTimer = setInterval(tickWrapper, POLL_INTERVAL);
}

startLoop();
await server.connect(new StdioServerTransport());
