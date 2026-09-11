/**
 * Reviewer MCP — код-ревью merge request'ов neurodeck (v0.4.0).
 *
 * v0.4.0: review_mr — асинхронный: spawn фонового run-review.js → возвращает review_id сразу.
 *         review_status — проверка статуса/результата по review_id.
 *         review_batch — синхронный (для cron, release-manager).
 *
 * СЕТЬ: GitLab/Redmine (<YOUR_HOST>) — НАПРЯМУЮ. DeepInfra (api.deepinfra.com) — через прокси.
 * DRY_RUN: ничего не пишет в GitLab/Redmine (только GET + POST к DeepInfra).
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  checkConfig, assembleReview, deepinfraReview,
  ID_TO_NAME, REGISTRY, MODEL, PROXY,
  RM_BASE, RM_LOGIN, RM_PASS, parseVerdict, firstLine, mapPool, indexOpenMrs,
  CODE_REVIEW_STATUS, rmGet,
} from "./review-core.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const RUN_REVIEW_BIN = join(dirname(fileURLToPath(import.meta.url)), "run-review.js");
const REVIEW_STATE_DIR = join(ROOT, "workspace", "state", "reviews");

const configErr = checkConfig();
if (configErr) { console.error(`[reviewer-mcp] ${configErr}`); process.exit(1); }

const ok = (text: string) => ({ content: [{ type: "text" as const, text }] });

// ─── Helpers ─────────────────────────────────────────────────────────────────────

/** Генерит review_id: review-YYYYMMDD-HHMMSS-<mr_hash> */
function genReviewId(mr: string): string {
  const ts = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "");
  const hash = mr.replace(/[^a-zA-Z0-9]/g, "").slice(-8);
  return `review-${ts}-${hash}`;
}

function readReviewState(id: string): Record<string, any> | null {
  const f = join(REVIEW_STATE_DIR, `${id}.json`);
  if (!existsSync(f)) return null;
  try { return JSON.parse(readFileSync(f, "utf-8")); } catch { return null; }
}

// ─── Batch helpers (shared with review-core) ─────────────────────────────────────

const REWORK_STATUS = 8;
const FAILED_STATUS = 26;

// ─── Server ───────────────────────────────────────────────────────────────────────

const server = new McpServer({ name: "reviewer-mcp", version: "0.4.0" });

server.tool(
  "review_mr",
  `Код-ревью merge request'а neurodeck (АСИНХРОННЫЙ). Запускает фоновый воркер, возвращает review_id сразу —
не блокирует gateway. Проверять результат через review_status(review_id).
Принимает: URL мёрж-реквеста, 'репо!номер' (напр. <variant-a>!3508) или голый номер.`,
  {
    mr: z.string().describe("ссылка на MR: URL, 'репо!номер' или просто номер"),
  },
  async ({ mr }) => {
    mkdirSync(REVIEW_STATE_DIR, { recursive: true });
    const reviewId = genReviewId(mr);

    const child = spawn("node", ["--experimental-strip-types", RUN_REVIEW_BIN, "--id", reviewId, "--mr", mr], {
      cwd: ROOT,
      env: { ...process.env, AGENT_REPO_ROOT: ROOT },
      detached: true,
      stdio: "ignore",
    });
    child.unref();

    const state = { review_id: reviewId, mr, status: "submitted", started_at: new Date().toISOString(), pid: child.pid };
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(REVIEW_STATE_DIR, `${reviewId}.json`), JSON.stringify(state, null, 2));

    return ok(`✅ Рецензия запущена (${reviewId})\n` +
              `MR: ${mr}\n` +
              `Проверить статус: review_status("${reviewId}")\n` +
              `Результат будет в workspace/state/reviews/${reviewId}.json`);
  },
);

server.tool(
  "review_status",
  `Проверяет статус асинхронного ревью по review_id. Возвращает состояние (submitted/reviewing/done/error/skipped)
и результат, если готов.`,
  {
    review_id: z.string().describe("review_id из ответа review_mr"),
  },
  async ({ review_id }) => {
    const state = readReviewState(review_id);
    if (!state) return ok(`Рецензия ${review_id} не найдена. Возможно истекла или неверный id.`);
    if (state.status === "submitted") return ok(`⏳ Рецензия ${review_id}: ожидает обработки...`);
    if (state.status === "reviewing") return ok(`🔄 Рецензия ${review_id}: выполняется (${state.kept ?? "?"} файлов, «${state.title ?? "?"}»)...`);
    if (state.status === "error") return ok(`❌ Рецензия ${review_id}: ошибка — ${state.error ?? "неизвестно"}`);
    if (state.status === "skipped") return ok(`⏭ Рецензия ${review_id}: пропущена — ${state.reason ?? "неизвестно"}`);
    if (state.status === "done") {
      return ok(state.result ?? "(пустой результат)");
    }
    return ok(`Рецензия ${review_id}: ${state.status} — ${JSON.stringify(state)}`);
  },
);

server.tool(
  "review_batch",
  `Батч-ревью всех задач в статусе Code review (id 13) ОДНИМ вызовом (СИНХРОННЫЙ — для cron/release-manager).
Сам находит открытые MR'ы по задачам, ревьюит каждую и возвращает сводку.`,
  {
    limit: z.number().int().optional().describe("сколько MR ревьюить (топ по приоритету/сроку), дефолт 10, макс 25"),
    project: z.string().optional().describe("Redmine-проект (имя/id), дефолт из env REDMINE_PROJECT"),
    status_id: z.string().optional().describe("Redmine status_id, дефолт 13 (Code review)"),
    assignee_id: z.string().optional().describe("фильтр по исполнителю (Redmine user id)"),
    version_id: z.string().optional().describe("фильтр по версии/релизу (Redmine fixed_version_id)"),
    due_from: z.string().optional().describe("срок (due_date) не раньше, YYYY-MM-DD"),
    due_to: z.string().optional().describe("срок (due_date) не позже, YYYY-MM-DD"),
  },
  async (args) => {
    if (!RM_BASE || !RM_LOGIN || !RM_PASS) return ok("Redmine не настроен в reviewer-MCP — батч недоступен.");
    if (REGISTRY.length === 0) return ok("Реестр вариантов (REVIEW_PROJECTS) пуст — не по чему искать MR'ы.");

    const clean = (v?: string): string => { const s = (v ?? "").trim(); return /^\$\{.*\}$/.test(s) ? "" : s; };
    const RM_PROJECT = clean(process.env.REDMINE_PROJECT);

    const statusId = (args.status_id && String(args.status_id).trim()) || CODE_REVIEW_STATUS;
    const project = (args.project && String(args.project).trim()) || RM_PROJECT;
    const params: Record<string, string> = { status_id: statusId, limit: "100", sort: "priority:desc,due_date:asc" };
    if (project) params.project_id = project;
    if (args.assignee_id) params.assigned_to_id = String(args.assignee_id).trim();
    if (args.version_id) params.fixed_version_id = String(args.version_id).trim();
    const df = args.due_from && String(args.due_from).trim();
    const dt = args.due_to && String(args.due_to).trim();
    if (df && dt) params.due_date = `><${df}|${dt}`;
    else if (df) params.due_date = `>=${df}`;
    else if (dt) params.due_date = `<=${dt}`;

    const data = await rmGet("/issues.json", params);
    if (!data) return ok("Redmine недоступен — не собрал список задач Code review.");
    const issues: any[] = data?.issues ?? [];
    const statusName = issues[0]?.status?.name || `status ${statusId}`;
    if (issues.length === 0) return ok(`Нет задач в статусе «${statusName}»${project ? ` (проект ${project})` : ""} под текущие фильтры.`);

    const idx = await indexOpenMrs();
    const matched: Array<{ issue: any; mr: { project: string; iid: number; info: any } }> = [];
    const noMr: any[] = [];
    for (const it of issues) {
      const hit = idx.get(String(it.id));
      if (hit) matched.push({ issue: it, mr: hit }); else noMr.push(it);
    }
    if (matched.length === 0) {
      const list = issues.slice(0, 10).map((it: any) => `#${it.id}`).join(", ");
      return ok(`Задач в «${statusName}»: ${issues.length}, но ни у одной не нашёл ОТКРЫТОГО MR.\nЗадачи: ${list}...`);
    }

    const limit = Math.max(1, Math.min(Number(args.limit) || 10, 25));
    const selected = matched.slice(0, limit);
    const overflow = matched.length - selected.length;

    const rows = await mapPool(selected, 4, async ({ issue, mr }) => {
      const repo = ID_TO_NAME.get(mr.project) || mr.project;
      const base = { issue, repo, iid: mr.iid };
      const a = await assembleReview(mr.project, mr.iid, mr.info);
      if ("skip" in a) return { ...base, verdict: "⚪", summary: a.skip };
      const terse = a.userMsg +
        `\n\n# РЕЖИМ: БАТЧ-СВОДКА\nОтветь РОВНО одной строкой на русском в формате: ` +
        `"<🔴|🟡|🟢> <суть ≤15 слов> (замечаний: N)". 🔴 = на доработку, 🟡 = мелочи/в беклог, 🟢 = ок.`;
      try {
        const r = await deepinfraReview(terse, 260);
        return { ...base, verdict: parseVerdict(r), summary: firstLine(r) };
      } catch (e) {
        return { ...base, verdict: "⚠", summary: `модель недоступна: ${(e as Error).message}` };
      }
    });

    const fmtDue = (d?: string) => (d ? `${d.slice(8, 10)}.${d.slice(5, 7)}` : "—");
    const lines = rows.map((r) => {
      const it = r.issue;
      const who = (it.assigned_to?.name || "—").split(" ").slice(-1)[0];
      const prio = it.priority?.name || "—";
      return `${r.verdict} #${it.id} ${r.repo}!${r.iid} · ${who} · ${prio} · ${fmtDue(it.due_date)} — ${r.summary}`;
    });
    const counts = rows.reduce<Record<string, number>>((m, r) => ((m[r.verdict] = (m[r.verdict] || 0) + 1), m), {});
    const tally = ["🔴", "🟡", "🟢"].filter((e) => counts[e]).map((e) => `${e}${counts[e]}`).join("  ") || "—";
    const head = `🔎 Батч-ревью «${statusName}» — ${selected.length}/${matched.length}` +
      (overflow > 0 ? ` (лимит ${limit}, +${overflow} не вошли)` : "") +
      `   ${tally}\n\n`;
    const footer = noMr.length
      ? `\n\n⚠ Без открытого MR: ${noMr.slice(0, 8).map((it: any) => `#${it.id}`).join(", ")}` +
        `${noMr.length > 8 ? ` …(+${noMr.length - 8})` : ""}.`
      : "";
    return ok(head + lines.join("\n") + footer + `\n\nDRY_RUN — ничего не постится.`);
  },
);

await server.connect(new StdioServerTransport());
console.error(`[reviewer-mcp] v0.4.0 async (model=${MODEL}, proxy=${PROXY ? "on" : "off"}, forks=${REGISTRY.length})`);
