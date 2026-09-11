#!/usr/bin/env node
/**
 * Release Manager MCP (ADR-0025) — ОТДЕЛЬНЫЙ агент.
 *
 * Циклы (setInterval, свой внутренний tick):
 *   1. RELEASE SCAN (30 мин): rc-* MR → mergeable + Redmine «Исполнено» → анонс
 *   2. REVIEWER SCAN (30 мин): dev-MR без ревьюера → подбор по касте → анонс
 *   3. VERSION MONITOR (60 мин): открытые версии Redmine → сроки, прогресс → анонс
 *   4. DEADLINE REMINDERS (60 мин): версии с истекающим/прошедшим сроком → анонс
 *   5. GIT ANALYTICS (6 часов / по требованию): коммиты/строки по разрабам
 *
 * Env: GITLAB_BASE_URL, GITLAB_WRITE_TOKEN (scope api),
 *      REDMINE_BASE_URL, REDMINE_LOGIN/PASSWORD (read),
 *      GITLAB_WRITE_CONFIG, REDMINE_TEAM_CONFIG (team.json),
 *      AGENT_REPO_ROOT, TELEGRAM_BOT_TOKEN, TELEGRAM_ALLOWED_USER_IDS, TELEGRAM_PROXY,
 *      HARNESS_NOTIFY_CHAT_ID, RELEASE_POLL_INTERVAL_MS.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
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
const RM_KEY   = clean(process.env.REDMINE_API_KEY);
const RM_LOGIN = clean(process.env.REDMINE_LOGIN);
const RM_PASS  = clean(process.env.REDMINE_PASSWORD);
const useBasic  = Boolean(RM_LOGIN && RM_PASS);
const hasRedmine = Boolean(RM_BASE && (RM_KEY || useBasic));

const TG_TOKEN   = clean(process.env.TELEGRAM_BOT_TOKEN);
const TG_ALLOWED = clean(process.env.TELEGRAM_ALLOWED_USER_IDS) || "";
const TG_PROXY   = clean(process.env.TELEGRAM_PROXY) || clean(process.env.PROXY_URL);
const TG_CHAT    = clean(process.env.HARNESS_NOTIFY_CHAT_ID) || (TG_ALLOWED.match(/-?\d{5,}/) || [])[0] || "";

const POLL_INTERVAL = parseInt(clean(process.env.RELEASE_POLL_INTERVAL_MS) || "1800000", 10);

if (!REPO_ROOT) { console.error("[rel-mgr] AGENT_REPO_ROOT не задан"); process.exit(1); }

// ─── GitLab-write config ────────────────────────────────────────────────────
type GlCfg = { pollProjects?: number[]; allowedMergeTargets?: string[]; mergeRequiresTaskStatus?: string; reviewScanTargetBranch?: string };
let GLCFG: GlCfg = {};
{ const p = clean(process.env.GITLAB_WRITE_CONFIG) || join(REPO_ROOT, "config", "gitlab-write.json5");
  if (p && existsSync(p)) try { GLCFG = JSON5.parse(readFileSync(p, "utf8")) as GlCfg; } catch (e) { console.error(`[rel-mgr] cfg: ${e}`); } }

// ─── Team config ────────────────────────────────────────────────────────────
type Dev = { id: number; name: string; login?: string; role?: string; git_emails?: string[]; gitlab?: { username?: string; id?: number | null; emails?: string[] } };
type TeamCfg = { core_developers?: Dev[]; project?: { id: number; name: string }; roles?: Record<string, { ids: number[]; label?: string }>; statuses?: Record<string, { ids: number[]; names?: string[] }>; trackers?: Record<string, { ids: number[]; names: string[]; meaning?: string; executable?: boolean }> };
let TEAM: TeamCfg = {};
{ const p = clean(process.env.REDMINE_TEAM_CONFIG) || clean(process.env.TEAM_CONFIG) || join(REPO_ROOT, "config", "team.json");
  if (p && existsSync(p)) try { TEAM = JSON5.parse(readFileSync(p, "utf8")) as TeamCfg; } catch (e) { console.error(`[rel-mgr] team: ${e}`); } }

// ─── Projects registry (для локальных путей git-репо) ────────────────────────
type ProjReg = { baseDir?: string; projects?: Record<string, { repoPath?: string; gitlabProjectId?: number | null }> };
let PROJ: ProjReg = {};
{ const p = clean(process.env.PROJECTS_REGISTRY) || join(REPO_ROOT, "config", "projects.json5");
  if (p && existsSync(p)) try { PROJ = JSON5.parse(readFileSync(p, "utf8")) as ProjReg; } catch (e) { console.error(`[rel-mgr] projects: ${e}`); } }

// ─── GitLab REST ────────────────────────────────────────────────────────────
const GL_API = hasGitlab ? `${GL_BASE_URL!.replace(/\/$/, "")}/api/v4` : "";
async function gl(method: string, path: string, body?: unknown): Promise<{ status: number; json: any; text?: string }> {
  if (!hasGitlab) return { status: 0, json: null, text: "GITLAB_WRITE_TOKEN не задан" };
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 20_000);
  try {
    const r = await fetch(`${GL_API}${path}`, {
      method, headers: { "PRIVATE-TOKEN": GL_TOKEN!, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined, signal: ctrl.signal,
    });
    const text = await r.text(); let j: any = null; try { j = text ? JSON.parse(text) : null; } catch { /* */ }
    return { status: r.status, json: j, text };
  } finally { clearTimeout(t); }
}

// ─── Redmine REST ───────────────────────────────────────────────────────────
function rmAuth(): Record<string, string> {
  const h: Record<string, string> = { Accept: "application/json" };
  if (useBasic) h["Authorization"] = `Basic ${Buffer.from(`${RM_LOGIN}:${RM_PASS}`).toString("base64")}`;
  else if (RM_KEY) h["X-Redmine-API-Key"] = RM_KEY!;
  return h;
}
async function rm(method: string, path: string): Promise<{ status: number; json: any }> {
  if (!hasRedmine) return { status: 0, json: null };
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 15_000);
  try {
    const r = await fetch(`${RM_BASE!.replace(/\/$/, "")}${path}`, { method, headers: rmAuth(), signal: ctrl.signal });
    const text = await r.text(); let j: any = null; try { j = text ? JSON.parse(text) : null; } catch { /* */ }
    return { status: r.status, json: j };
  } finally { clearTimeout(t); }
}

// ─── Telegram announce ──────────────────────────────────────────────────────
// Экранирование для Telegram Markdown (legacy): _ * ` [
function escMd(s: string): string { return s.replace(/[_*`[]/g, "\\$&"); }

async function announce(text: string): Promise<void> {
  if (!TG_TOKEN || !TG_CHAT) return;
  try {
    const opts: any = { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chat_id: TG_CHAT, text, parse_mode: "Markdown", disable_web_page_preview: true }), signal: AbortSignal.timeout(12_000) };
    if (TG_PROXY) { const { ProxyAgent } = await import("undici"); opts.dispatcher = new ProxyAgent(TG_PROXY); }
    const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, opts);
    if (!r.ok) console.error(`[rel-mgr] tg: ${r.status}`);
  } catch (e: any) { console.error(`[rel-mgr] tg: ${e?.message ?? e}`); }
}

// Запись события в файловую шину для notifier (групповой чат, ADR-0028)
function emitRmEvent(type: string, payload?: Record<string, any>): void {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const file = join(WORKSPACE_STATE_DIR, "events", `${ts}-${type}-relmgr.json`);
  const event = { type, task_id: `relmgr-${type}`, redmine_id: 0, timestamp: new Date().toISOString(), payload: payload ?? {} };
  mkdirSync(join(WORKSPACE_STATE_DIR, "events"), { recursive: true });
  try { writeFileSync(file, JSON.stringify(event, null, 2)); } catch {}
}

// ─── State ──────────────────────────────────────────────────────────────────
type AnnouncedMr = { mrIid: number; projectId: number; at: string };
type VersionSnapshot = { name: string; status: "ok" | "urgent" | "overdue"; at: string };
type RmState = {
  lastReleaseScan: string; lastReviewerScan: string; lastVersionScan: string; lastGitStats: string;
  lastEventScan: string;
  announcedMrs: AnnouncedMr[]; announcedRevMrs: AnnouncedMr[]; announcedVersions: VersionSnapshot[];
};
const STORE_PATH = join(process.env.HOME ?? "/tmp", ".openclaw", "release-manager", "state.json");
const WORKSPACE_STATE_DIR = join(REPO_ROOT, "workspace", "state");
const GIT_STATS_CACHE_PATH = join(process.env.HOME ?? "/tmp", ".openclaw", "release-manager", "git-stats-cache.json");
function loadState(): RmState {
  try {
    if (existsSync(STORE_PATH)) return JSON.parse(readFileSync(STORE_PATH, "utf8")) as RmState;
  } catch (e) { console.error(`[rel-mgr] loadState: ${e}`); }
  return { lastReleaseScan: "", lastReviewerScan: "", lastVersionScan: "", lastGitStats: "", lastEventScan: "", announcedMrs: [], announcedRevMrs: [], announcedVersions: [] };
}
let state: RmState = loadState();
function saveState(): void {
  try {
    mkdirSync(dirname(STORE_PATH), { recursive: true });
    writeFileSync(STORE_PATH, JSON.stringify(state, null, 2));
    try {
      mkdirSync(WORKSPACE_STATE_DIR, { recursive: true });
      writeFileSync(join(WORKSPACE_STATE_DIR, "release-manager-state.json"), JSON.stringify(state, null, 2));
    } catch { /* workspace mirror — не критично */ }
  } catch (e) { console.error(`[rel-mgr] saveState: ${e}`); }
}

// ─── Helpers ────────────────────────────────────────────────────────────────
const globToRe = (g: string): RegExp => new RegExp("^" + g.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$");
const devByGitlabId = (gid?: number | null): Dev | undefined => TEAM.core_developers?.find((d) => d.gitlab?.id === gid);
const isFrontend = (d: Dev): boolean => (TEAM.roles?.frontend?.ids ?? []).includes(d.id);

// ─── Main tick ──────────────────────────────────────────────────────────────
let cycling = false;
async function tick(): Promise<string[]> {
  if (cycling) return [];
  cycling = true;
  const log: string[] = [];
  const add = (s: string) => { console.log(`[rel-mgr] ${s}`); log.push(s); };

  try {
    const now = Date.now();

    // ── RELEASE SCAN: rc-* MR кандидаты на мёрдж ──────────────────────────
    if (hasGitlab && hasRedmine && now - new Date(state.lastReleaseScan || 0).getTime() > 1_800_000) {
      state.lastReleaseScan = new Date().toISOString();
      add("релиз-скан...");
      // Собираем все eligible MR в батч, шлём ОДНИМ сообщением
      const eligibleMrs: { iid: number; title: string; target: string; rmId: number }[] = [];
      let eligible = 0, skipped = 0;
      const pollIds = GLCFG.pollProjects?.length ? GLCFG.pollProjects : [];
      for (const glId of pollIds) {
        const r = await gl("GET", `/projects/${glId}/merge_requests?state=opened&per_page=50`);
        if (r.status !== 200) continue;
        for (const mr of (r.json as any[]) ?? []) {
          const target = String(mr.target_branch ?? "");
          if (!target.startsWith("rc-")) continue;
          const source = String(mr.source_branch ?? "");
          const rmMatch = source.match(/#(\d{4,})/);
          if (!rmMatch) { skipped++; continue; }
          const rmId = parseInt(rmMatch[1], 10);

          const mrDetail = await gl("GET", `/projects/${glId}/merge_requests/${mr.iid}`);
          if (mrDetail.status !== 200) continue;
          const mergeStatus = String(mrDetail.json?.merge_status ?? "");

          let taskOk = false;
          try {
            const r2 = await rm("GET", `/issues/${rmId}.json`);
            taskOk = String(r2.json?.issue?.status?.name ?? "") === (GLCFG.mergeRequiresTaskStatus || "Исполнено");
          } catch { /* */ }

          const already = state.announcedMrs.some((a) => a.mrIid === mr.iid && a.projectId === glId && now - new Date(a.at).getTime() < 3_600_000);
          if (already) continue;

          if (mergeStatus === "can_be_merged" && taskOk) {
            eligible++;
            state.announcedMrs.push({ mrIid: mr.iid, projectId: glId, at: new Date().toISOString() });
            eligibleMrs.push({ iid: mr.iid, title: mr.title?.slice(0, 80) || "", target, rmId });
          } else skipped++;
        }
      }
      if (eligibleMrs.length) {
        const list = eligibleMrs.slice(0, 8).map((m) => `!${m.iid}`).join(", ");
        const tail = eligibleMrs.length > 8 ? ` и ещё ${eligibleMrs.length - 8}` : "";
        if (eligibleMrs.length && !allAlreadyAnnounced) {
        await announce(`🔀 ${eligibleMrs.length} MR готовы к мёрджу в rc\nНапиши «смёрджи всё» или «смёрджи MR ${list}${tail}»`);
        emitRmEvent("release.rc_ready", { count: eligibleMrs.length, mrs: eligibleMrs.slice(0, 5).map((m) => ({ iid: m.iid, title: m.title, target: m.target })) });
      }
      if (state.announcedMrs.length > 100) state.announcedMrs = state.announcedMrs.slice(-100);
      saveState();
      add(`релиз-скан: eligible=${eligible}, skipped=${skipped}`);
    }

    // ── REVIEWER SCAN: dev-MR без ревьюера ────────────────────────────────
    if (hasGitlab && now - new Date(state.lastReviewerScan || 0).getTime() > 1_800_000) {
      state.lastReviewerScan = new Date().toISOString();
      add("ревью-скан...");
      let found = 0;
      const pollIds = GLCFG.pollProjects?.length ? GLCFG.pollProjects : [];
      const revMrs: { iid: number; title: string; front: boolean; needed: number; suggested: string }[] = [];
      for (const glId of pollIds) {
        const targetBranch = GLCFG.reviewScanTargetBranch || "develop";
        const r = await gl("GET", `/projects/${glId}/merge_requests?state=opened&target_branch=${encodeURIComponent(targetBranch)}&per_page=30`);
        if (r.status !== 200) continue;
        for (const mr of (r.json as any[]) ?? []) {
          const reviewers = (mr.reviewer_ids ?? mr.reviewers ?? []) as any[];
          if (reviewers.length > 0) continue;

          const assigneeId = mr.assignee_id ?? mr.assignee?.id ?? 0;
          const dev = devByGitlabId(assigneeId);
          const front = dev ? isFrontend(dev) : false;
          const needed = front ? 1 : 2;
          const pool = (TEAM.core_developers ?? []).filter((d) => d.gitlab?.id && d.gitlab.id !== assigneeId);
          const suggested = pool.slice(0, needed).map((d) => `@${d.gitlab!.username}`).join(", ");

          found++;
          revMrs.push({ iid: mr.iid, title: mr.title?.slice(0, 60) || "", front, needed, suggested });
        }
      }
      // Анти-спам: если ВСЕ найденные MR уже анонсированы за последние 3 часа — не слать
      const allAlreadyAnnounced = revMrs.length > 0 && revMrs.every((m) => {
        const projectId = GLCFG.pollProjects?.[0] ?? 0; // reviewer scan не знает projectId из списка MR
        return state.announcedRevMrs.some((a) => a.mrIid === m.iid && now - new Date(a.at).getTime() < 10_800_000);
      });
      if (revMrs.length && !allAlreadyAnnounced) {
        const frontCount = revMrs.filter((m) => m.front).length;
        const backCount = revMrs.length - frontCount;
        const tags = [frontCount ? `${frontCount} фронт` : "", backCount ? `${backCount} бек` : ""].filter(Boolean).join(", ");
        await announce(`👀 ${revMrs.length} MR без ревьюеров (${tags})\nНапиши «раскидай ревью MR» или укажи распределение:\n«раскидай MR между @dev1, @dev2, @dev3 (кроме меня)»`);
        emitRmEvent("review.ready", { count: revMrs.length, front_count: frontCount, back_count: backCount, mr_iids: revMrs.map((m) => m.iid) });
        for (const m of revMrs) state.announcedRevMrs.push({ mrIid: m.iid, projectId: GLCFG.pollProjects?.[0] ?? 0, at: new Date().toISOString() });
      }
      if (state.announcedRevMrs.length > 100) state.announcedRevMrs = state.announcedRevMrs.slice(-100);
      saveState();
      add(`ревью-скан: найдено=${found}${allAlreadyAnnounced ? " (уже анонсированы)" : ""}`);
    }

    // ── VERSION MONITOR ────────────────────────────────────────────────────
    if (hasRedmine && now - new Date(state.lastVersionScan || 0).getTime() > 3_600_000) {
      state.lastVersionScan = new Date().toISOString();
      add("версии...");
      try {
        const r = await rm("GET", `/projects/${TEAM.project?.id ?? 171}/versions.json`);
        if (r.status === 200) {
          const open = ((r.json?.versions ?? []) as any[]).filter((v: any) => v.status === "open");
          const versionLines: string[] = [];
          for (const v of open.slice(0, 8)) {
            const due = v.due_date ? new Date(v.due_date) : null;
            const daysLeft = due ? Math.ceil((due.getTime() - Date.now()) / 86_400_000) : null;
            const status: VersionSnapshot["status"] = daysLeft !== null && daysLeft <= 0 ? "overdue" : daysLeft !== null && daysLeft <= 3 ? "urgent" : "ok";
            const icon = status === "overdue" ? "🔴" : status === "urgent" ? "🟠" : daysLeft !== null && daysLeft <= 7 ? "🟡" : "🟢";

            // Анализ исполнителей внутри версии
            let assigneeHint = "";
            try {
              const ir = await rm("GET", `/issues.json?fixed_version_id=${v.id}&status_id=open&limit=100`);
              const issues = (ir.json?.issues ?? []) as any[];
              const counts = new Map<number, number>();
              for (const iss of issues) {
                const aid = iss.assigned_to?.id as number | undefined;
                if (aid) counts.set(aid, (counts.get(aid) || 0) + 1);
              }
              const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
              const top = sorted.slice(0, 2).map(([aid, n]) => {
                const dev = TEAM.core_developers?.find((d) => d.id === aid);
                return dev ? `@${dev.gitlab?.username || dev.login}` : `#${aid}`;
              });
              if (top.length) assigneeHint = `\n   👤 ${top.join(", ")}`;
            } catch { /* */ }

            versionLines.push(`${icon} **${escMd(v.name)}**${due ? ` · до ${due.toLocaleDateString("ru-RU")}` : ""}${daysLeft !== null ? ` (${daysLeft} дн.)` : ""}${assigneeHint}`);
          }

          // Анти-спам: слать только если новая/изменившаяся версия или прошло >6 часов
          const curSnapshots: VersionSnapshot[] = open.slice(0, 8).map((v: any) => {
            const due = v.due_date ? new Date(v.due_date) : null;
            const daysLeft = due ? Math.ceil((due.getTime() - Date.now()) / 86_400_000) : null;
            const status: VersionSnapshot["status"] = daysLeft !== null && daysLeft <= 0 ? "overdue" : daysLeft !== null && daysLeft <= 3 ? "urgent" : "ok";
            return { name: v.name, status, at: "" };
          });
          const prevMap = new Map(state.announcedVersions.map((sv) => [sv.name, sv.status]));
          const changed = curSnapshots.length !== state.announcedVersions.length ||
            curSnapshots.some((snap) => prevMap.get(snap.name) !== snap.status);
          const sixHours = 6 * 3_600_000;
          const lastVersionAnnounce = state.announcedVersions[0]?.at || "";
          const shouldAnnounce = versionLines.length && (changed || now - new Date(lastVersionAnnounce || 0).getTime() > sixHours);

          if (shouldAnnounce) {
            const urgentCount = open.filter((v: any) => {
              const due = v.due_date ? new Date(v.due_date) : null;
              return due && Math.ceil((due.getTime() - Date.now()) / 86_400_000) <= 3;
            }).length;
            const msg = ["📅 Версии neurodeck:", "", ...versionLines];
            if (urgentCount) msg.push("", `⚠️ ${urgentCount} версий требуют внимания.`);
            msg.push("", "Напиши «версии подробно» или «назначь @dev на <версия>».");
            await announce(msg.join("\n"));
            state.announcedVersions = curSnapshots.map((s) => ({ ...s, at: new Date().toISOString() }));
            emitRmEvent("version.monitor", { open_count: open.length, urgent_count: urgentCount, overdue_versions: curSnapshots.filter((s: any) => s.status === "overdue").map((s: any) => s.name), urgent_versions: curSnapshots.filter((s: any) => s.status === "urgent").map((s: any) => s.name) });
            saveState();
          }
          add(`версии: открытых=${open.length}${shouldAnnounce ? " (анонс)" : ""}`);
        }
      } catch (e: any) { add(`версии: ${e?.message ?? e}`); }
    }

    // ── TASK EXECUTED EVENT SCAN (ADR-0028) ─────────────────────────────────
    if (now - new Date(state.lastEventScan || "0").getTime() > 1_800_000) {
      state.lastEventScan = new Date().toISOString();
      let scanned = 0;
      const eventsDir = join(WORKSPACE_STATE_DIR, "events");
      if (existsSync(eventsDir)) {
        for (const f of readdirSync(eventsDir).filter((x) => x.endsWith(".json")).sort()) {
          try {
            const evt = JSON.parse(readFileSync(join(eventsDir, f), "utf8"));
            if (evt.type === "task.executed" || evt.type === "task.done") {
              scanned++;
              const p = evt.payload ?? {};
              add(`executed: #${evt.redmine_id ?? p.redmine_id} (${evt.type})`);
            }
          } catch { continue; }
        }
      }
      if (scanned > 0) add(`event-скан: ${scanned} executed/done`);
      saveState();
    }

    // ── GIT STATS: только по запросу (git_stats), авто-рассылка отключена ──
    // спек 05: git-статистика больше не шлётся автоматически.
  } finally { cycling = false; }
  return log;
}

// ─── MCP tools ──────────────────────────────────────────────────────────────
const server = new McpServer({ name: "release-manager", version: "0.1.0" });

server.tool("rm_status", "Состояние релиз-менеджера: последние сканы, статистика.", {}, async () => ok({
  last_release_scan: state.lastReleaseScan || "никогда",
  last_reviewer_scan: state.lastReviewerScan || "никогда",
  last_version_scan: state.lastVersionScan || "никогда",
  last_git_stats: state.lastGitStats || "никогда",
  gitlab: hasGitlab,
  redmine: hasRedmine,
  poll_projects: GLCFG.pollProjects ?? [],
  team_mapping: (TEAM.core_developers ?? []).map((d) => ({ name: d.name, gitlab: d.gitlab })),
  trackers: TEAM.trackers ?? {},
  epic_tracker_id: EPIC_TRACKER_ID,
}));

server.tool("rm_process", "Ручной тик всех циклов релиз-менеджера.", {}, async () => {
  const steps = await tick();
  return ok({ steps, timestamp: new Date().toISOString() });
});

server.tool("version_status", "Детальный статус открытых версий neurodeck: задачи, прогресс, сроки.", {}, async () => {
  if (!hasRedmine) return ok({ error: "Redmine не настроен" });
  try {
    const r = await rm("GET", `/projects/${TEAM.project?.id ?? 171}/versions.json`);
    if (r.status !== 200) return ok({ error: `Redmine ${r.status}` });
    const versions = (r.json?.versions ?? []) as any[];
    const open = versions.filter((v: any) => v.status === "open");
    const result = await Promise.all(open.slice(0, 10).map(async (v: any) => {
      const due = v.due_date ? new Date(v.due_date) : null;
      const daysLeft = due ? Math.ceil((due.getTime() - Date.now()) / 86_400_000) : null;
      let total = 0, done = 0;
      try {
        const ir = await rm("GET", `/issues.json?fixed_version_id=${v.id}&status_id=*&limit=1`);
        total = ir.json?.total_count ?? 0;
        if (total > 0) {
          for (const grp of ["resolved", "in_pool", "executed_dev"]) {
            const st = TEAM as any; // statuses not in TeamCfg type
            const ids = st?.statuses?.[grp]?.ids ?? [];
            for (const sid of ids) {
              const sr = await rm("GET", `/issues.json?fixed_version_id=${v.id}&status_id=${sid}&limit=1`);
              done += sr.json?.total_count ?? 0;
            }
          }
        }
      } catch { /* */ }
      const pct = total > 0 ? Math.round((done / total) * 100) : 0;
      let urgency = "";
      if (daysLeft !== null && daysLeft <= 0) urgency = "OVERDUE";
      else if (daysLeft !== null && daysLeft <= 3) urgency = "URGENT";
      else if (daysLeft !== null && daysLeft <= 7) urgency = "SOON";
      return { name: v.name, due_date: v.due_date ?? null, days_left: daysLeft, total_tasks: total, done_tasks: done, progress_pct: pct, urgency };
    }));
    return ok({ project: TEAM.project?.name ?? "neurodeck", versions: result });
  } catch (e: any) { return ok({ error: e?.message ?? String(e) }); }
});

// create_release_mrs — сквозной flow: задачи версии → ветки → MR в RC.
async function _createReleaseMrs(args: { version_name: string; target_branch: string; gitlab_project_id: number; auto_create?: boolean; status_id?: number }): Promise<ReturnType<typeof ok>> {
  const { version_name, target_branch, gitlab_project_id, auto_create, status_id } = args;
  const doCreate = auto_create === true;
  const reqStatusId = status_id ?? 27; // 27 = Исполнено

  if (!hasRedmine) return ok({ error: "Redmine не настроен" });
  if (!hasGitlab) return ok({ error: "Gitlab не настроен" });

  // 1. Найти версию по имени (точное или частичное совпадение среди открытых)
  const vr = await rm("GET", `/projects/${TEAM.project?.id ?? 171}/versions.json`);
  if (vr.status !== 200) return ok({ error: `Redmine versions: ${vr.status}` });
  const versions = ((vr.json?.versions ?? []) as any[]).filter((v: any) => v.status === "open");
  const version = versions.find((v: any) =>
    v.name === version_name || String(v.name ?? "").toLowerCase().includes(version_name.toLowerCase())
  );
  if (!version) return ok({ error: `Версия "${version_name}" не найдена среди открытых. Доступны: ${versions.map((v: any) => v.name).join(", ") || "(нет)"}` });

  // 2. Собрать задачи версии в нужном статусе
  const ir = await rm("GET", `/issues.json?fixed_version_id=${version.id}&status_id=${reqStatusId}&limit=100`);
  if (ir.status !== 200) return ok({ error: `Redmine issues: ${ir.status}` });
  const issues = (ir.json?.issues ?? []) as any[];

  if (!issues.length) return ok({
    version_name: version.name, version_id: version.id, target_branch, status_id: reqStatusId,
    issues_found: 0, message: `Нет задач в статусе ${reqStatusId} в версии ${version.name}`,
  });

  const results: any[] = [];
  let createdCount = 0, skippedCount = 0, errorCount = 0;

  for (const issue of issues) {
    const issueId = issue.id as number;
    const subject = String(issue.subject ?? "").slice(0, 100);
    const branch = `#${issueId}`;
    const rmLink = `${RM_BASE!.replace(/\/$/, "")}/issues/${issueId}`;

    // 3a. Ветка существует в GitLab?
    const branchCheck = await gl("GET", `/projects/${gitlab_project_id}/repository/branches/${encodeURIComponent(branch)}`);
    if (branchCheck.status !== 200) {
      skippedCount++;
      results.push({ issue_id: issueId, subject, branch, mr_status: "skipped", reason: `ветка не найдена в GitLab (status ${branchCheck.status})` });
      continue;
    }

    // 3b. MR уже существует?
    const existing = await gl("GET", `/projects/${gitlab_project_id}/merge_requests?source_branch=${encodeURIComponent(branch)}&target_branch=${encodeURIComponent(target_branch)}&state=opened`);
    if (existing.status === 200 && Array.isArray(existing.json) && existing.json.length > 0) {
      skippedCount++;
      results.push({ issue_id: issueId, subject, branch, mr_status: "skipped", reason: "MR уже существует", existing_mr_iid: existing.json[0].iid, existing_mr_url: existing.json[0].web_url });
      continue;
    }

    const mrTitle = `${branch} ${subject}`.slice(0, 255);
    const mrDesc = [
      `## ${branch} — ${subject}`,
      `Ссылка на задачу: ${rmLink}`,
      "", `### Реализовано`,
      `См. коммиты в ветке \`${branch}\`.`,
      "", `🤖 Автоматический MR создан агентом release-manager в рамках версии **${version.name}**.`,
    ].join("\n");

    if (!doCreate) {
      results.push({ issue_id: issueId, subject, branch, mr_status: "planned", target: target_branch, rm_link: rmLink });
      continue;
    }

    // 3c. Создать MR через GitLab API
    const mrR = await gl("POST", `/projects/${gitlab_project_id}/merge_requests`, {
      source_branch: branch, target_branch, title: mrTitle, description: mrDesc,
    });
    if (mrR.status === 201) {
      createdCount++;
      results.push({ issue_id: issueId, subject, branch, mr_status: "created", mr_iid: mrR.json?.iid, mr_web_url: mrR.json?.web_url });
    } else {
      errorCount++;
      results.push({ issue_id: issueId, subject, branch, mr_status: "error", error: `GitLab ${mrR.status}: ${(mrR.text ?? "").slice(0, 200)}` });
    }
  }

  // Announce
  if (doCreate && createdCount > 0) {
    const compact = results.filter((r: any) => r.mr_status === "created").slice(0, 10).map((r: any) => `• #${r.issue_id} → MR !${r.mr_iid}`).join("\n");
    await announce(`🔀 Release Manager: создано ${createdCount} MR в \`${escMd(target_branch)}\` (версия **${escMd(version.name)}**)\n${compact}`);
  }

  return ok({
    version_name: version.name, version_id: version.id, target_branch, gitlab_project_id, status_id: reqStatusId,
    auto_create: doCreate, issues_found: issues.length,
    created: createdCount, skipped: skippedCount, errors: errorCount,
    results,
  });
}
(server as any).tool("create_release_mrs",
  `Создать MR в RC-ветку по задачам версии в указанном Redmine-статусе.
1. Находит версию Redmine по имени (точное или частичное совпадение).
2. Собирает задачи версии в статусе (по умолчанию 27 = "Исполнено").
3. Для каждой (ветка #NNNNN): проверяет GitLab — ветка есть? MR уже есть?
4. При auto_create=true — создаёт недостающие MR через GitLab API.
Возвращает отчёт: created / skipped / errors + детали по каждой задаче.`,
  {
    version_name: z.string().describe("имя версии Redmine (точное или частичное, напр. 'a.1.5.5.0')"),
    target_branch: z.string().describe("целевая RC-ветка, напр. 'rc-a.1.5.5.0'"),
    gitlab_project_id: z.number().describe("GitLab project ID (напр. 423 для <variant-a>)"),
    auto_create: z.boolean().optional().describe("создавать MR (false — только план)"),
    status_id: z.number().optional().describe("Redmine status ID (по умолчанию 27 = Исполнено)"),
  },
  _createReleaseMrs,
);

// ─── Branch finder helpers ───────────────────────────────────────────────────
const EPIC_TRACKER_ID = 26;

async function _getIssueRaw(issueId: number): Promise<any | null> {
  if (!hasRedmine) return null;
  const r = await rm("GET", `/issues/${issueId}.json`);
  if (r.status !== 200) return null;
  return r.json?.issue ?? null;
}

function _repoPathForProjectId(glProjectId: number): string | null {
  for (const v of Object.values(PROJ.projects ?? {})) {
    if ((v as any).gitlabProjectId === glProjectId && (v as any).repoPath) return (v as any).repoPath;
  }
  return null;
}

async function _listRcBranches(projectId: number): Promise<string[]> {
  const r = await gl("GET", `/projects/${projectId}/repository/branches?search=rc-&per_page=100`);
  if (r.status !== 200 || !Array.isArray(r.json)) return [];
  return r.json.map((b: any) => b.name).filter((n: string) => n.startsWith("rc-")).slice(0, 20);
}

async function _checkMergeMr(
  projectId: number, sourceBranch: string, targetBranch: string,
): Promise<{ status: "merged" | "opened" | "none"; mr_iid?: number; mr_web_url?: string }> {
  const merged = await gl("GET", `/projects/${projectId}/merge_requests?source_branch=${encodeURIComponent(sourceBranch)}&target_branch=${encodeURIComponent(targetBranch)}&state=merged&per_page=1`);
  if (merged.status === 200 && Array.isArray(merged.json) && merged.json.length > 0) {
    return { status: "merged", mr_iid: merged.json[0].iid, mr_web_url: merged.json[0].web_url };
  }
  const opened = await gl("GET", `/projects/${projectId}/merge_requests?source_branch=${encodeURIComponent(sourceBranch)}&target_branch=${encodeURIComponent(targetBranch)}&state=opened&per_page=1`);
  if (opened.status === 200 && Array.isArray(opened.json) && opened.json.length > 0) {
    return { status: "opened", mr_iid: opened.json[0].iid, mr_web_url: opened.json[0].web_url };
  }
  return { status: "none" };
}

function _checkMergeGit(repoPath: string, remoteBranch: string, targetBranch: string): boolean {
  try {
    const r = spawnSync("git", ["merge-base", "--is-ancestor", `origin/${remoteBranch}`, `origin/${targetBranch}`],
      { cwd: repoPath, encoding: "utf8", timeout: 15_000 });
    return r.status === 0;
  } catch { return false; }
}

async function _findBranchesForTask(
  taskId: number,
  opts: { gitlabProjectId?: number; checkTargets: string[]; includeEpics: boolean; useGitCheck: boolean },
): Promise<Record<string, unknown>> {
  const issue = await _getIssueRaw(taskId);
  if (!issue) return { task_id: taskId, error: "Задача не найдена в Redmine" };

  const tracker = String(issue.tracker?.name ?? "?");
  const subject = String(issue.subject ?? "").slice(0, 120);
  const version = issue.fixed_version?.name as string | undefined;
  const parentId = issue.parent?.id as number | undefined;
  const parent: Record<string, unknown> = {};

  if (parentId && opts.includeEpics) {
    const pi = await _getIssueRaw(parentId);
    if (pi) {
      parent.id = parentId;
      parent.tracker = String(pi.tracker?.name ?? "?");
      parent.is_epic = pi.tracker?.id === EPIC_TRACKER_ID;
      parent.subject = String(pi.subject ?? "").slice(0, 120);
    }
  }

  const projectIds = opts.gitlabProjectId
    ? [opts.gitlabProjectId]
    : (GLCFG.pollProjects?.length ? GLCFG.pollProjects : []);
  const branchName = `#${taskId}`;
  const branches: Record<string, unknown>[] = [];
  const epics: Record<string, unknown>[] = [];

  for (const glId of projectIds) {
    const check = await gl("GET", `/projects/${glId}/repository/branches/${encodeURIComponent(branchName)}`);
    if (check.status === 200) {
      const sha = check.json?.commit?.id ?? null;
      const repoPath = _repoPathForProjectId(glId);
      branches.push({ project_id: glId, branch: branchName, exists: true, tip_sha: sha, local_repo: repoPath });
    }
  }

  let parentBranchName = "";
  if (parent.id && parent.is_epic && opts.includeEpics) {
    parentBranchName = `#${parent.id}`;
    for (const glId of projectIds) {
      const check = await gl("GET", `/projects/${glId}/repository/branches/${encodeURIComponent(parentBranchName)}`);
      if (check.status === 200) {
        const sha = check.json?.commit?.id ?? null;
        const repoPath = _repoPathForProjectId(glId);
        epics.push({ project_id: glId, branch: parentBranchName, exists: true, tip_sha: sha, local_repo: repoPath });
      }
    }
  }

  // Level 1: MR check against targets + rc-* branches
  const rcBranchesPerProject = new Map<number, string[]>();
  for (const glId of projectIds) {
    if (!rcBranchesPerProject.has(glId)) rcBranchesPerProject.set(glId, await _listRcBranches(glId));
  }

  const mergeInto: Record<string, unknown> = {};
  const targets = opts.checkTargets.length > 0 ? opts.checkTargets : ["develop"];

  for (const br of branches) {
    const glId = br.project_id as number;
    const bname = br.branch as string;

    for (const target of targets) {
      const key = `into_${target}`;
      if (!mergeInto[key]) mergeInto[key] = await _checkMergeMr(glId, bname, target);
    }
  }

  // Check into epic branch
  let intoEpic: Record<string, unknown> | undefined;
  if (parentBranchName && branches.length > 0) {
    const glId = branches[0].project_id as number;
    intoEpic = await _checkMergeMr(glId, branchName, parentBranchName);
  }

  // rc-* MR check (best-effort: check first project where branch exists)
  const rcMerge: Record<string, unknown>[] = [];
  if (branches.length > 0) {
    const glId = branches[0].project_id as number;
    const rcBranches = rcBranchesPerProject.get(glId) ?? [];
    for (const rc of rcBranches.slice(0, 15)) {
      const mr = await _checkMergeMr(glId, branchName, rc);
      if (mr.status !== "none") rcMerge.push({ target: rc, ...mr });
    }
  }

  // Level 2: git merge-base
  let gitCheck: Record<string, unknown> | null = null;
  if (opts.useGitCheck && branches.length > 0) {
    const br = branches[0];
    const repoPath = br.local_repo as string | null;
    const bname = br.branch as string;
    if (repoPath) {
      try { spawnSync("git", ["fetch", "origin", bname, "-q"], { cwd: repoPath, encoding: "utf8", timeout: 30_000 }); } catch { /* */ }
      const gitInto: Record<string, boolean> = {};
      for (const target of targets) gitInto[target] = _checkMergeGit(repoPath, bname, target);
      if (parentBranchName) gitInto[`parent:${parentBranchName}`] = _checkMergeGit(repoPath, bname, parentBranchName);
      gitCheck = { repo: repoPath, merged_into: gitInto, _note: "git merge-base --is-ancestor (точнее MR API, работает при squash)" };
    }
  }

  // Bypass detection: MR into develop exists, but parent is epic and no MR into parent
  const devMr = mergeInto["into_develop"] as Record<string, unknown> | undefined;
  const bypassEpic = parent.is_epic && (intoEpic as any)?.status === "none" && devMr?.status === "merged";

  // Delivered status
  const toDevelop = devMr?.status === "merged";
  const toEpic = (intoEpic as any)?.status === "merged";
  const toRc = rcMerge.filter((r) => r.status === "merged").map((r) => r.target);
  const delivered = {
    to_develop: toDevelop,
    to_rc: toRc,
    via_epic: !!(parent.is_epic && toEpic),
    bypass_epic: bypassEpic,
  };

  return {
    task_id: taskId,
    subject,
    tracker,
    version,
    parent: Object.keys(parent).length > 0 ? parent : undefined,
    branches,
    epic_branch: epics.length > 0 ? epics[0] : undefined,
    merge_status: { ...mergeInto, into_epic: intoEpic, into_rc: rcMerge },
    git_check: gitCheck,
    bypass_epic: bypassEpic,
    delivered,
  };
}

// ─── rm_find_branches tool ───────────────────────────────────────────────────
async function _rmFindBranches(args: {
  task_ids: number[];
  gitlab_project_id?: number;
  check_targets?: string[];
  include_epics?: boolean;
  use_git_check?: boolean;
}): Promise<ReturnType<typeof ok>> {
  const { task_ids, gitlab_project_id, check_targets, include_epics, use_git_check } = args;
  if (!hasRedmine) return ok({ error: "Redmine не настроен" });
  if (!hasGitlab) return ok({ error: "GitLab не настроен" });

  const opts = {
    gitlabProjectId: gitlab_project_id,
    checkTargets: check_targets?.length ? check_targets : ["develop"],
    includeEpics: include_epics !== false,
    useGitCheck: use_git_check === true,
  };

  const results: Record<string, unknown>[] = [];
  let foundBranches = 0, totalWithBranches = 0, totalEpicSubtasks = 0, totalBypassed = 0;

  for (const tid of task_ids) {
    const r = await _findBranchesForTask(tid, opts);
    results.push(r);
    if (!r.error) {
      const branches = (r.branches as any[]) ?? [];
      if (branches.length > 0) totalWithBranches++;
      foundBranches += branches.length;
      if (r.parent && (r.parent as any).is_epic) totalEpicSubtasks++;
      if (r.bypass_epic) totalBypassed++;
    }
  }

  return ok({
    tasks_requested: task_ids.length,
    tasks_found: results.filter((r) => !r.error).length,
    tasks_with_branches: totalWithBranches,
    total_branches_found: foundBranches,
    epic_subtasks: totalEpicSubtasks,
    bypassed_epics: totalBypassed,
    _check: opts.useGitCheck ? "MR API + git merge-base" : "MR API only (используйте use_git_check=true для точной проверки влития через git)",
    results,
  });
}

(server as any).tool("rm_find_branches",
  `Найти Git-ветки для задач Redmine по номерам.
1. Для каждого task_id: получает задачу из Redmine (трекер, родитель-эпик, версия).
2. Проверяет существование ветки #NNNNN в GitLab-проектах (pollProjects или указанный).
3. Если задача — подзадача эпика (tracker родителя = 26 «Эпик»): проверяет ветку эпика #<parent_id> и MR в неё.
4. Level 1 (по умолчанию): проверяет смердженные/открытые MR из ветки задачи в develop, rc-* и родительскую ветку.
5. Level 2 (use_git_check=true): git merge-base --is-ancestor на локальных репо (точнее, ловит squash-мёрджи).
6. Определяет bypass_epic: MR в develop есть, а в эпик-ветку — нет.
Возвращает: по каждой задаче — ветки, merge-статус, bypass, delivered.`,
  {
    task_ids: z.array(z.number()).describe("список ID задач Redmine (напр. [21547, 21548])"),
    gitlab_project_id: z.number().optional().describe("конкретный GitLab project ID (по умолчанию — все pollProjects)"),
    check_targets: z.array(z.string()).optional().describe("целевые ветки для проверки влития (по умолчанию ['develop'])"),
    include_epics: z.boolean().optional().describe("проверять родительскую эпик-ветку (по умолчанию true)"),
    use_git_check: z.boolean().optional().describe("Level 2: git merge-base на локальных репо (по умолчанию false)"),
  },
  _rmFindBranches,
);

// ─── rm_version_branches tool ────────────────────────────────────────────────
async function _rmVersionBranches(args: {
  version_name: string;
  gitlab_project_id?: number;
  status_id?: number;
  check_targets?: string[];
  include_epics?: boolean;
  use_git_check?: boolean;
  limit?: number;
}): Promise<ReturnType<typeof ok>> {
  const { version_name, gitlab_project_id, status_id, check_targets, include_epics, use_git_check, limit } = args;
  if (!hasRedmine) return ok({ error: "Redmine не настроен" });
  if (!hasGitlab) return ok({ error: "GitLab не настроен" });

  const vr = await rm("GET", `/projects/${TEAM.project?.id ?? 171}/versions.json`);
  if (vr.status !== 200) return ok({ error: `Redmine versions: ${vr.status}` });
  const versions = ((vr.json?.versions ?? []) as any[]).filter((v: any) => v.status === "open");
  const version = versions.find((v: any) =>
    v.name === version_name || String(v.name ?? "").toLowerCase().includes(version_name.toLowerCase()),
  );
  if (!version) return ok({ error: `Версия "${version_name}" не найдена среди открытых. Доступны: ${versions.map((v: any) => v.name).join(", ") || "(нет)"}` });

  const sid = status_id != null ? `&status_id=${status_id}` : "&status_id=*";
  const maxIssues = limit ?? 100;
  const ir = await rm("GET", `/issues.json?fixed_version_id=${version.id}${sid}&limit=${maxIssues}`);
  if (ir.status !== 200) return ok({ error: `Redmine issues: ${ir.status}` });
  const issues = (ir.json?.issues ?? []) as any[];

  if (!issues.length) return ok({
    version_name: version.name, version_id: version.id,
    status_filter: status_id ?? "без фильтра",
    issues_found: 0, message: `Нет задач в версии ${version.name}`,
  });

  const opts = {
    gitlabProjectId: gitlab_project_id,
    checkTargets: check_targets?.length ? check_targets : ["develop"],
    includeEpics: include_epics !== false,
    useGitCheck: use_git_check === true,
  };

  const taskResults: Record<string, unknown>[] = [];
  let tasksWithBranches = 0, totalBranches = 0, mergedToDevelop = 0, mergedToRc = 0, bypassed = 0, epicSubtasks = 0;

  for (const iss of issues) {
    const r = await _findBranchesForTask(iss.id as number, opts);
    taskResults.push(r);
    if (!r.error) {
      if ((r.branches as any[])?.length > 0) tasksWithBranches++;
      totalBranches += (r.branches as any[])?.length ?? 0;
      if ((r.delivered as any)?.to_develop) mergedToDevelop++;
      if ((r.delivered as any)?.to_rc?.length > 0) mergedToRc++;
      if (r.bypass_epic) bypassed++;
      if (r.parent && (r.parent as any).is_epic) epicSubtasks++;
    }
  }

  return ok({
    version_name: version.name,
    version_id: version.id,
    total_tasks: issues.length,
    tasks_with_branches: tasksWithBranches,
    tasks_without_branches: issues.length - tasksWithBranches,
    total_branches: totalBranches,
    merged_to_develop: mergedToDevelop,
    merged_to_rc: mergedToRc,
    epic_subtasks: epicSubtasks,
    bypass_epic_count: bypassed,
    _note: status_id != null ? `Фильтр по status_id=${status_id}` : "Без фильтра по статусу",
    tasks: taskResults,
  });
}

(server as any).tool("rm_version_branches",
  `Маппинг всех задач версии Redmine → Git-ветки + статус влития.
1. Находит версию Redmine по имени (только открытые).
2. Собирает ВСЕ задачи версии (limit=100, без фильтра по статусу).
3. Для каждой задачи вызывает логику rm_find_branches: поиск ветки #NNNNN, проверка MR в develop/rc-*, детект эпиков и bypass.
4. Агрегирует: сколько задач имеют ветки, сколько влито в develop, сколько в rc, сколько bypass-эпика.
Используйте для аудита релиза: все ли задачи имеют ветки и доставлены ли они в нужные target-ветки.`,
  {
    version_name: z.string().describe("имя версии Redmine (точное или частичное совпадение)"),
    gitlab_project_id: z.number().optional().describe("конкретный GitLab project ID (по умолчанию — все pollProjects)"),
    status_id: z.number().optional().describe("фильтр по статусу Redmine (по умолчанию без фильтра, status_id=*)"),
    check_targets: z.array(z.string()).optional().describe("целевые ветки для проверки влития (по умолчанию ['develop'])"),
    include_epics: z.boolean().optional().describe("проверять родительскую эпик-ветку (по умолчанию true)"),
    use_git_check: z.boolean().optional().describe("Level 2: git merge-base (медленно для многих задач, по умолчанию false)"),
    limit: z.number().optional().describe("макс. число задач из версии (по умолчанию 100)"),
  },
  _rmVersionBranches,
);

// ─── Git stats cache ────────────────────────────────────────────────────────
type GitStatsCache = { period: string; since: string; updatedAt: string; data: any };
function loadGitStatsCache(): GitStatsCache | null {
  try { if (existsSync(GIT_STATS_CACHE_PATH)) return JSON.parse(readFileSync(GIT_STATS_CACHE_PATH, "utf8")) as GitStatsCache; } catch { /* */ }
  return null;
}
function saveGitStatsCache(cache: GitStatsCache): void {
  try { mkdirSync(dirname(GIT_STATS_CACHE_PATH), { recursive: true }); writeFileSync(GIT_STATS_CACHE_PATH, JSON.stringify(cache, null, 2)); } catch { /* */ }
}

function devEmails(dev: Dev): string[] {
  const list = new Set<string>();
  for (const e of dev.git_emails ?? []) if (e) list.add(e.toLowerCase());
  for (const e of dev.gitlab?.emails ?? []) if (e) list.add(e.toLowerCase());
  return Array.from(list);
}

// Отдельная функция чтобы обойти TS2589 в z.string() + async handler
async function _gitStats(args: { period: string }): Promise<ReturnType<typeof ok>> {
  const { period } = args;
  const days: Record<string, number> = { week: 7, month: 30, quarter: 90, half_year: 180 };
  const since = new Date(Date.now() - (days[period] ?? 7) * 86_400_000).toISOString().slice(0, 10);
  const sinceIso = new Date(Date.now() - (days[period] ?? 7) * 86_400_000).toISOString();

  // Кэш: если запрос за тот же период и свежее 1 часа — отдаём кэш
  const cached = loadGitStatsCache();
  if (cached && cached.period === period && cached.since === since && Date.now() - new Date(cached.updatedAt).getTime() < 3_600_000) {
    return ok({ ...cached.data, cached: true, cachedAt: cached.updatedAt });
  }

  // Локальные репо из projects.json5
  const repoPaths: string[] = Object.values(PROJ.projects ?? {})
    .map((v: any) => v.repoPath as string).filter((p: string) => p && existsSync(join(p, ".git")));

  // git fetch --all перед подсчётом
  for (const repoPath of repoPaths) {
    try { spawnSync("git", ["fetch", "--all", "-q"], { cwd: repoPath, encoding: "utf8", timeout: 30_000 }); } catch { /* */ }
  }

  type DevStat = { developer: string; gitlab_user: string; git_emails: string[]; commits: number; additions: number; deletions: number; repos: number; merged_develop: number; merged_rc: number; comments: number; approvals: number; avg_review_cycle_days: number | null };
  const stats: DevStat[] = [];

  for (const dev of TEAM.core_developers ?? []) {
    const emails = devEmails(dev);
    if (!emails.length && !dev.gitlab?.username) continue;
    let totalCommits = 0, totalAdds = 0, totalDels = 0, repoCount = 0;

    for (const repoPath of repoPaths) {
      try {
        const r = spawnSync("git", ["log", "--all", `--since=${since}`, "--shortstat", "--format=%H%n%ae%n%ce", "--no-merges"],
          { cwd: repoPath, encoding: "utf8", timeout: 30_000, maxBuffer: 512 * 1024 });
        const out = (r.stdout || "").trim();
        if (!out) continue;
        const blocks = out.split(/\n(?=[a-f0-9]{40}\n)/);
        let repoCommits = 0, repoAdds = 0, repoDels = 0;
        for (const block of blocks) {
          const lines = block.split("\n");
          const ae = (lines[1] ?? "").trim().toLowerCase();
          const ce = (lines[2] ?? "").trim().toLowerCase();
          if (!emails.includes(ae) && !emails.includes(ce)) continue;
          repoCommits++;
          for (const line of lines) {
            const ins = line.match(/(\d+)\s+insertion/);
            const del = line.match(/(\d+)\s+deletion/);
            if (ins) repoAdds += parseInt(ins[1], 10);
            if (del) repoDels += parseInt(del[1], 10);
          }
        }
        if (repoCommits === 0) continue;
        repoCount++;
        totalCommits += repoCommits;
        totalAdds += repoAdds;
        totalDels += repoDels;
      } catch { /* */ }
    }

    // GitLab метрики (best-effort)
    let mergedDevelop = 0, mergedRc = 0, comments = 0, approvals = 0;
    const reviewCycles: number[] = [];
    const gitlabId = dev.gitlab?.id;
    if (gitlabId && hasGitlab) {
      for (const glId of GLCFG.pollProjects ?? []) {
        try {
          // merged MR авторства разраба
          const mrR = await gl("GET", `/projects/${glId}/merge_requests?state=merged&author_id=${gitlabId}&created_after=${encodeURIComponent(sinceIso)}&per_page=100`);
          const mrs = (mrR.json ?? []) as any[];
          for (const mr of mrs) {
            const target = String(mr.target_branch ?? "");
            if (target === "develop") mergedDevelop++;
            else if (target.startsWith("rc-")) mergedRc++;
            if (mr.merged_at && mr.created_at) {
              const days = (new Date(mr.merged_at).getTime() - new Date(mr.created_at).getTime()) / 86_400_000;
              if (days >= 0) reviewCycles.push(days);
            }
          }
          // комментарии разраба в MR (notes)
          for (const mr of mrs.slice(0, 20)) {
            try {
              const notesR = await gl("GET", `/projects/${glId}/merge_requests/${mr.iid}/notes?author_id=${gitlabId}&per_page=100`);
              comments += ((notesR.json ?? []) as any[]).length;
            } catch { /* */ }
          }
          // апрувы разраба: MR где он в approved_by
          const apprR = await gl("GET", `/projects/${glId}/merge_requests?state=merged&approved_by_ids[]=${gitlabId}&updated_after=${encodeURIComponent(sinceIso)}&per_page=100`);
          approvals += ((apprR.json ?? []) as any[]).length;
        } catch { /* */ }
      }
    }

    const avgReview = reviewCycles.length ? Number((reviewCycles.reduce((a, b) => a + b, 0) / reviewCycles.length).toFixed(1)) : null;

    if (totalCommits > 0 || mergedDevelop > 0 || mergedRc > 0 || comments > 0 || approvals > 0) {
      stats.push({
        developer: dev.name,
        gitlab_user: dev.gitlab?.username || dev.login || "?",
        git_emails: emails,
        commits: totalCommits,
        additions: totalAdds,
        deletions: totalDels,
        repos: repoCount,
        merged_develop: mergedDevelop,
        merged_rc: mergedRc,
        comments,
        approvals,
        avg_review_cycle_days: avgReview,
      });
    }
  }
  stats.sort((a, b) => b.commits - a.commits);
  const data = {
    period, since,
    developers: stats,
    _source: `git log --all + git fetch --all по ${repoPaths.length} локальным репо; GitLab API по ${(GLCFG.pollProjects ?? []).length} проектам`,
    _updatedAt: new Date().toISOString(),
  };
  saveGitStatsCache({ period, since, updatedAt: new Date().toISOString(), data });
  return ok(data);
}
(server as any).tool("git_stats", "Статистика по git и GitLab MR за период. Периоды: week, month, quarter, half_year. Для каждого разраба: коммиты, +/- строк, репо, смердженные MR (develop/rc), комментарии в MR, апрувы, средний цикл ревью. Кэшируется на 1 час.", {
  period: z.string(),
}, _gitStats);

// ─── Internal loop ──────────────────────────────────────────────────────────
let loopTimer: ReturnType<typeof setInterval> | null = null;
function startLoop() {
  if (loopTimer) return;
  console.error(`[rel-mgr] v0.1.0 (gitlab=${hasGitlab ? "on" : "OFF"}, redmine=${hasRedmine ? "on" : "OFF"}, poll=${Math.round(POLL_INTERVAL / 60000)}min)`);
  const tickWrapper = async () => { try { await tick(); } catch (e: any) { console.error(`[rel-mgr] tick: ${e?.message ?? e}`); } };
  tickWrapper();
  loopTimer = setInterval(tickWrapper, POLL_INTERVAL);
}

startLoop();
await server.connect(new StdioServerTransport());
