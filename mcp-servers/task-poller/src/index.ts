#!/usr/bin/env node
// mcp-servers/task-poller/src/index.ts (ADR-0028)
// Автономный поллинг Redmine → compile_task → task_estimate → task-queue/.
// НЕ взаимодействует с Telegram — только пишет события.
//
// Env: REDMINE_BASE_URL, REDMINE_API_KEY (or REDMINE_LOGIN + REDMINE_PASSWORD),
//      LLM_BASE_URL, LLM_API_KEY, COMPILER_MODEL,
//      TASK_POLLER_INTERVAL_MS, TASK_POLLER_REWORK_INTERVAL_MS, TASK_POLLER_AGENT_ID
//      AGENT_REPO_ROOT, GITLAB_BASE_URL, GITLAB_WRITE_TOKEN

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

import {
  compileAndEstimate,
  listRedmineIssuesByStatus,
  updateRedmineStatus,
  addRedmineNote,
  emitEvent,
  isTaskAlreadyQueued,
  isTaskArchived,
  wasRecentlyCompiled,
  CompileResult,
  QUEUE_DIR,
  resolveStatusId,
} from "./compiler.js";
import { listQueuedTasks, removeFromQueue } from "./queue-writer.js";
import { pollReworkTasks } from "./rework.js";

const clean = (v?: string): string => { const s = (v ?? "").trim(); return /^\$\{.*\}$/.test(s) ? "" : s; };
const ok = (obj: unknown) => ({ content: [{ type: "text" as const, text: typeof obj === "string" ? obj : JSON.stringify(obj, null, 2) }] });

const ROOT = (() => {
  const env = clean(process.env.AGENT_REPO_ROOT);
  if (env) return env;
  try { return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", ".."); }
  catch { return process.cwd(); }
})();

const STORE_PATH = join(ROOT, "workspace", "state", "task-poller-state.json");
const WORKSPACE_STATE_DIR = join(ROOT, "workspace", "state");

const AGENT_ID = Number(clean(process.env.TASK_POLLER_AGENT_ID) || "386");
const POLL_INTERVAL_MS = Number(clean(process.env.TASK_POLLER_INTERVAL_MS) || "300000");      // 5 min
const REWORK_INTERVAL_MS = Number(clean(process.env.TASK_POLLER_REWORK_INTERVAL_MS) || "900000"); // 15 min
const ESTIMATE_MODE = clean(process.env.TASK_POLLER_ESTIMATE_MODE) || "manual";
const ESTIMATE_USE_LLM = clean(process.env.TASK_POLLER_ESTIMATE_USE_LLM) === "1";

// State
interface Store {
  last_poll: string | null;
  last_rework_poll: string | null;
  compiled: number;
  needs_clarify: number;
  errors: number;
  tasks: Array<{ redmine_id: number; task_id: string; status: string; timestamp: string }>;
}

function loadStore(): Store {
  if (!existsSync(STORE_PATH)) return { last_poll: null, last_rework_poll: null, compiled: 0, needs_clarify: 0, errors: 0, tasks: [] };
  try {
    return JSON.parse(readFileSync(STORE_PATH, "utf-8")) as Store;
  } catch { return { last_poll: null, last_rework_poll: null, compiled: 0, needs_clarify: 0, errors: 0, tasks: [] }; }
}

function saveStore(store: Store): void {
  mkdirSync(dirname(STORE_PATH), { recursive: true });
  writeFileSync(STORE_PATH, JSON.stringify(store, null, 2));
  try { writeFileSync(join(WORKSPACE_STATE_DIR, "task-poller-state.json"), JSON.stringify(store, null, 2)); } catch {}
}

let store = loadStore();

async function pollNewTasks(): Promise<string[]> {
  const log: string[] = [];
  const add = (s: string) => { console.error(`[task-poller] ${s}`); log.push(s); };

  add("poll new tasks (status 20)");
  let issues: any[] = [];
  try {
    issues = await listRedmineIssuesByStatus(20, AGENT_ID);
  } catch (e: any) {
    add(`Redmine poll failed: ${e?.message ?? e}`);
    store.errors++;
    saveStore(store);
    return log;
  }

  add(`found ${issues.length} issues in status 20`);
  let compiled = 0;
  let clarified = 0;
  let errors = 0;

  for (const issue of issues) {
    const redmineId = Number(issue.id);
    const slug = issue.subject?.toString().toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "task";
    const taskId = `redmine-${redmineId}-${slug}`;

    if (isTaskAlreadyQueued(taskId) || isTaskArchived(taskId)) {
      add(`skip #${redmineId} — already queued or archived`);
      continue;
    }

    if (wasRecentlyCompiled(redmineId)) {
      add(`skip #${redmineId} — compiled recently (<30 min)`);
      continue;
    }

    add(`compile #${redmineId} → ${taskId}`);
    const result = await compileAndEstimate(redmineId, {
      mode: ESTIMATE_MODE,
      useLLM: ESTIMATE_USE_LLM,
      extra: issue.subject,
    });

    if (result.error) {
      add(`#${redmineId} error: ${result.error}`);
      errors++;
      store.tasks.push({ redmine_id: redmineId, task_id: taskId, status: "error", timestamp: new Date().toISOString() });
      continue;
    }

    if (result.needs_clarification) {
      add(`#${redmineId} needs clarification: ${result.questions?.join("; ") ?? ""}`);
      clarified++;
      try {
        await updateRedmineStatus(redmineId, resolveStatusId("На уточнении"), [
          "Агент-поллер требует уточнения перед выполнением:",
          ...(result.questions ?? []),
          "",
          "Ответь в примечаниях Redmine и верни задачу в статус «На исполнение».",
        ].join("\n"));
      } catch (e: any) {
        add(`#${redmineId} failed to set clarify status: ${e?.message ?? e}`);
      }
      emitEvent("task.needs_clarify", taskId, redmineId, { questions: result.questions ?? [], rationale: result.rationale ?? "" });
      store.tasks.push({ redmine_id: redmineId, task_id: taskId, status: "needs_clarify", timestamp: new Date().toISOString() });
      continue;
    }

    if (result.task_spec) {
      add(`#${redmineId} compiled + estimated → ${result.task_spec.id} (${result.task_spec.model}, ${result.task_spec.estimated_time_min}min)`);
      compiled++;
      emitEvent("task.compiled", result.task_spec.id as string, redmineId, {
        repo: result.task_spec.repo,
        lang: result.task_spec.lang,
        estimated_time_min: result.task_spec.estimated_time_min,
      });
      store.tasks.push({ redmine_id: redmineId, task_id: result.task_spec.id as string, status: "compiled", timestamp: new Date().toISOString() });
    }
  }

  store.last_poll = new Date().toISOString();
  store.compiled += compiled;
  store.needs_clarify += clarified;
  store.errors += errors;
  saveStore(store);

  add(`done: compiled=${compiled}, clarify=${clarified}, errors=${errors}`);
  return log;
}

async function pollRework(): Promise<string[]> {
  const log: string[] = [];
  const add = (s: string) => { console.error(`[task-poller] ${s}`); log.push(s); };
  add("poll rework tasks (status 8)");
  try {
    const results = await pollReworkTasks();
    store.last_rework_poll = new Date().toISOString();
    saveStore(store);
    for (const r of results) {
      if (r.recompiled) add(`rework recompiled #${r.redmine_id} → ${r.task_id} (${r.comments_count} comments)`);
      else if (r.error) add(`rework #${r.redmine_id} error: ${r.error}`);
      else add(`rework skip #${r.redmine_id}`);
    }
  } catch (e: any) {
    add(`rework poll failed: ${e?.message ?? e}`);
  }
  return log;
}

async function tick(): Promise<string[]> {
  const log = await pollNewTasks();
  const reworkLog = await pollRework();
  return [...log, ...reworkLog];
}

// MCP Server
const server = new McpServer({ name: "task-poller", version: "0.1.0" });

server.tool("tp_status", "Состояние task-poller: очередь, статистика, последние поллы.", {}, async () => {
  const queue = listQueuedTasks();
  return ok({
    store: { ...store, tasks: store.tasks.slice(-20) },
    queued: queue.length,
    queue_snapshot: queue.slice(0, 20),
    agent_id: AGENT_ID,
    poll_interval_ms: POLL_INTERVAL_MS,
    rework_interval_ms: REWORK_INTERVAL_MS,
  });
});

server.tool("tp_process", "Ручной тик поллера: опросить статус 20 и статус 8.", {}, async () => {
  const log = await tick();
  return ok({ processed: true, log });
});

server.tool("tp_compile_one", "Скомпилировать и оценить одну задачу вручную.", {
  redmine_id: z.number().int().positive().describe("номер задачи Redmine"),
  repo: z.string().optional().describe("подсказка репо"),
  category: z.enum(["simple", "medium", "complex"]).optional().describe("категория сложности"),
  mode: z.enum(["manual", "autonomous", "cheap", "thorough"]).optional().describe("режим оценки"),
  use_llm: z.boolean().optional().describe("использовать LLM для оценки"),
}, async ({ redmine_id, repo, category, mode, use_llm }) => {
  const result = await compileAndEstimate(redmine_id, {
    repo,
    category,
    mode: mode ?? ESTIMATE_MODE,
    useLLM: use_llm ?? ESTIMATE_USE_LLM,
  });
  if (result.task_spec) {
    emitEvent("task.compiled", result.task_spec.id as string, redmine_id, { repo: result.task_spec.repo, lang: result.task_spec.lang, manual: true });
  }
  return ok(result);
});

// Main loop
let cycling = false;
let lastReworkPoll = 0;

async function tickWrapper(): Promise<void> {
  if (cycling) return;
  cycling = true;
  try {
    await pollNewTasks();
    const now = Date.now();
    if (now - lastReworkPoll >= REWORK_INTERVAL_MS) {
      await pollRework();
      lastReworkPoll = now;
    }
  } catch (e: any) {
    console.error(`[task-poller] tick error: ${e?.message ?? e}`);
  } finally {
    cycling = false;
  }
}

console.error(`[task-poller] v0.1.0 | agent_id=${AGENT_ID} | poll=${POLL_INTERVAL_MS}ms | rework=${REWORK_INTERVAL_MS}ms`);
tickWrapper();
setInterval(tickWrapper, POLL_INTERVAL_MS);

await server.connect(new StdioServerTransport());
