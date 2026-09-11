#!/usr/bin/env node
// mcp-servers/agent-worker/src/index.ts (ADR-0028)
// Worker пула: claim → analyze → pending_approval → execute → report.
// Взаимодействует с оркестратором через MCP tools (pool_status, pool_approve).
//
// Env: WORKER_ID, AGENT_REPO_ROOT, REDMINE_*, GITLAB_*, GITLAB_WRITE_TOKEN,
//      LLM_BASE_URL, LLM_API_KEY, OPENCODE_BIN, HARNESS_TIMEOUT_MS,
//      AGENT_WORKER_POLL_INTERVAL_MS, AGENT_WORKER_HEARTBEAT_INTERVAL_MS

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { z } from "zod";

import {
  ROOT, OPENCLAW_HOME, STORE_DIR, STORE_PATH, POOL_STATE_PATH, WORKSPACE_STATE_DIR,
  WORKER_ID, POLL_INTERVAL_MS, HEARTBEAT_INTERVAL_MS, DRY_RUN,
  getWorkerConfig, resolveStatusId, statusNameById, ok,
} from "./config.js";
import { redmineUpdateIssue } from "./api.js";
import { listUnclaimedSpecs, claimTask, releaseTask, readTaskSpec, taskIsClaimed, releaseAllMyClaims } from "./claim.js";
import { acquireClone, releaseClone, createBranch, resetMyLocks } from "./clone-manager.js";
import { analyzeTechnical, analyzeBusiness, matchesSpecialization, computeEstimatedTime } from "./analyze.js";
import { executeHarness, saveHarnessHandle, removeHarnessHandle, loadRunningHandles, collectHarnessResult } from "./executor.js";
import { reportDone, reportFailed, reportClarifying, reportPendingApproval, reportApproved, getPoolState, removeFromPoolState } from "./reporter.js";
import { writeHeartbeat, getWorkerStatus } from "./heartbeat.js";

interface WorkerState {
  status: "idle" | "pending_approval" | "approved" | "working" | "clarifying" | "failed";
  taskId: string | null;
  redmineId: number | null;
  spec: Record<string, any> | null;
  clonePath: string | null;
  branch: string | null;
  claimedAt: string | null;
  analyzeWarnings: string[];
}

const state: WorkerState = {
  status: "idle",
  taskId: null,
  redmineId: null,
  spec: null,
  clonePath: null,
  branch: null,
  claimedAt: null,
  analyzeWarnings: [],
};

interface Store {
  last_tick: string | null;
  tasks_completed: number;
  tasks_failed: number;
  tasks_clarifying: number;
  history: Array<{ task_id: string; redmine_id: number; status: string; timestamp: string; error?: string }>;
}

function loadStore(): Store {
  if (!existsSync(STORE_PATH)) return { last_tick: null, tasks_completed: 0, tasks_failed: 0, tasks_clarifying: 0, history: [] };
  try { return JSON.parse(readFileSync(STORE_PATH, "utf-8")) as Store; }
  catch { return { last_tick: null, tasks_completed: 0, tasks_failed: 0, tasks_clarifying: 0, history: [] }; }
}

function saveStore(s: Store): void {
  mkdirSync(STORE_DIR, { recursive: true });
  writeFileSync(STORE_PATH, JSON.stringify(s, null, 2));
  try { writeFileSync(join(WORKSPACE_STATE_DIR, "agent-worker-state.json"), JSON.stringify(s, null, 2)); } catch {}
}

let store = loadStore();

function recordHistory(status: string, error?: string): void {
  if (!state.taskId || !state.redmineId) return;
  store.history.push({ task_id: state.taskId, redmine_id: state.redmineId, status, timestamp: new Date().toISOString(), error: error?.slice(0, 200) });
  if (status === "completed") store.tasks_completed++;
  if (status === "failed") store.tasks_failed++;
  if (status === "clarifying") store.tasks_clarifying++;
  store.last_tick = new Date().toISOString();
  saveStore(store);
}

function resetState(): void {
  if (state.clonePath && state.spec) {
    try { releaseClone(state.spec.repo as string, state.taskId ?? undefined); } catch {}
  }
  state.status = "idle";
  state.taskId = null;
  state.redmineId = null;
  state.spec = null;
  state.clonePath = null;
  state.branch = null;
  state.claimedAt = null;
  state.analyzeWarnings = [];
}

async function handleAnalyze(spec: Record<string, any>, clonePath: string): Promise<{ ok: boolean; reason?: string; questions?: string[] }> {
  const l1 = await analyzeTechnical(spec, clonePath);
  if (!l1.ok) return { ok: false, reason: l1.reason, questions: l1.questions };
  state.analyzeWarnings.push(...(l1.warnings ?? []));

  const l2 = await analyzeBusiness(spec);
  if (!l2.ok) return { ok: false, reason: l2.reason, questions: l2.questions };
  state.analyzeWarnings.push(...(l2.warnings ?? []));

  return { ok: true };
}

async function pickTask(): Promise<{ taskId: string; spec: Record<string, any> } | null> {
  const cfg = getWorkerConfig();
  const all = listUnclaimedSpecs();

  // Prefer matching specialization
  const matching = all.filter((t) => matchesSpecialization(t.spec, cfg.specialization));
  const candidates = matching.length > 0 ? matching : all;

  if (candidates.length === 0) return null;

  // Take first matching
  const chosen = candidates[0];
  if (claimTask(chosen.taskId, WORKER_ID)) {
    return { taskId: chosen.taskId, spec: chosen.spec };
  }
  return null;
}

async function mainTick(): Promise<string[]> {
  const log: string[] = [];
  const add = (s: string) => { console.error(`[agent-worker/${WORKER_ID}] ${s}`); log.push(s); };

  // Sync in-memory state with pool-state.json (allows external approval via worker-bridge)
  if (state.taskId && (state.status === "pending_approval" || state.status === "idle")) {
    const pool = getPoolState();
    const poolTask = pool.tasks.find((t) => t.task_id === state.taskId);
    if (poolTask && poolTask.state === "approved" && state.status === "pending_approval") {
      state.status = "approved";
      add("externally approved → starting execution");
    }
  }

  const hbStatus = (state.status === "failed" || state.status === "clarifying") ? "error" : state.status;
  writeHeartbeat(hbStatus as "idle" | "pending_approval" | "approved" | "working" | "error", state.taskId ?? undefined);

  if (state.status === "idle") {
    const picked = await pickTask();
    if (!picked) {
      add("idle — no tasks");
      return log;
    }
    const { taskId, spec } = picked;
    state.taskId = taskId;
    state.redmineId = Number(spec.redmine_id);
    state.spec = spec;
    state.claimedAt = new Date().toISOString();
    add(`claimed ${taskId} (#${state.redmineId})`);

    const repo = spec.repo as string;
    const clone = acquireClone(repo, taskId);
    if (!clone.ok || !clone.path) {
      add(`clone acquisition failed for ${repo}: ${clone.error}`);
      releaseTask(taskId);
      resetState();
      return log;
    }
    state.clonePath = clone.path;
    add(`clone acquired ${clone.path}`);

    const analyze = await handleAnalyze(spec, clone.path);
    if (!analyze.ok) {
      add(`analyze failed: ${analyze.reason}`);
      if (!DRY_RUN) {
        try { await redmineUpdateIssue(state.redmineId, resolveStatusId("На уточнении"), analyze.reason || "Требуется уточнение"); }
        catch (e: any) { add(`failed to update status 14: ${e?.message ?? e}`); }
      }
      reportClarifying(spec, WORKER_ID, analyze.reason || "Требуется уточнение");
      recordHistory("clarifying");
      releaseTask(taskId);
      resetState();
      return log;
    }

    state.status = "pending_approval";
    reportPendingApproval(spec, WORKER_ID);
    add(`pending approval for ${taskId}`);
    return log;
  }

  if (state.status === "pending_approval") {
    add(`waiting approval for ${state.taskId}`);
    return log;
  }

  if (state.status === "approved") {
    const spec = state.spec!;
    const clonePath = state.clonePath!;
    const redmineId = state.redmineId!;
    const branch = `#${redmineId}`;
    state.branch = branch;

    const branchResult = createBranch(clonePath, branch);
    if (!branchResult.ok) {
      add(`branch creation failed: ${branchResult.error}`);
      reportFailed(spec, WORKER_ID, branch, branchResult.error || "branch creation failed");
      recordHistory("failed", branchResult.error);
      resetState();
      return log;
    }

    add(`execute harness ${spec.id} in ${clonePath} branch ${branch}`);
    state.status = "working";

    // Set Redmine status 2 only AFTER approval
    if (!DRY_RUN) {
      try { await redmineUpdateIssue(redmineId, resolveStatusId("В работе"), `Взял в работу: ${WORKER_ID}`); }
      catch (e: any) { add(`failed to update status 2: ${e?.message ?? e}`); }
    }

    const result = await executeHarness(spec, clonePath, branch);

    if (result.clarification) {
      add(`clarification needed: ${result.clarification.slice(0, 100)}`);
      if (!DRY_RUN) {
        try { await redmineUpdateIssue(redmineId, resolveStatusId("На уточнении"), result.clarification); }
        catch (e: any) { add(`failed to update status 14: ${e?.message ?? e}`); }
      }
      reportClarifying(spec, WORKER_ID, result.clarification);
      recordHistory("clarifying");
      resetState();
      return log;
    }

    if (!result.ok) {
      add(`execution failed: ${result.error}`);
      reportFailed(spec, WORKER_ID, branch, result.error || "unknown error");
      recordHistory("failed", result.error);
      resetState();
      return log;
    }

    add(`execution done: ${result.commits} commits`);
    reportDone(spec, WORKER_ID, branch, result.commits);
    recordHistory("completed");
    if (!DRY_RUN) {
      try { await redmineUpdateIssue(redmineId, resolveStatusId("В работе"), `Выполнено. Коммитов: ${result.commits}. Ожидает git-egress для push+MR.`); }
      catch (e: any) { add(`failed to add note: ${e?.message ?? e}`); }
    }
    resetState();
    return log;
  }

  add(`unknown state ${state.status}`);
  return log;
}

// MCP Server
const server = new McpServer({ name: "agent-worker", version: "0.1.0" });

server.tool("worker_status", "Состояние текущего worker'а.", {}, async () => {
  return ok({
    worker_id: WORKER_ID,
    config: getWorkerConfig(),
    state,
    heartbeat: getWorkerStatus(),
    store: { ...store, history: store.history.slice(-20) },
  });
});

server.tool("pool_status", "Состояние worker pool: очередь, pending_approval, approved, клоны.", {}, async () => {
  return ok({
    worker_id: WORKER_ID,
    pool_state: getPoolState(),
    worker_state: state,
    heartbeat: getWorkerStatus(),
    store: { ...store, history: store.history.slice(-20) },
  });
});

server.tool("pool_approve", "Подтвердить выполнение задачи, находящейся в pending_approval.", {
  task_id: z.string().describe("ID задачи из task-queue/"),
}, async ({ task_id }) => {
  if (state.status !== "pending_approval" || state.taskId !== task_id) {
    return ok({ error: `task ${task_id} is not pending approval` });
  }
  state.status = "approved";
  if (state.spec) reportApproved(state.spec, WORKER_ID);
  return ok({ approved: true, task_id, worker: WORKER_ID });
});

server.tool("pool_deny", "Отклонить задачу в pending_approval (вернуть в очередь/на уточнение).", {
  task_id: z.string(),
  reason: z.string().optional(),
}, async ({ task_id, reason }) => {
  if (state.status !== "pending_approval" || state.taskId !== task_id) {
    return ok({ error: `task ${task_id} is not pending approval` });
  }
  if (state.spec && !DRY_RUN) {
    try { await redmineUpdateIssue(Number(state.spec.redmine_id), resolveStatusId("На уточнении"), reason || "Отклонено тимлидом"); }
    catch (e: any) { console.error(`pool_deny redmine error: ${e?.message ?? e}`); }
  }
  resetState();
  return ok({ denied: true, task_id, reason });
});

server.tool("pool_forget", "Удалить задачу из очереди (для застрявших).", {
  redmine_id: z.number().int().positive(),
}, async ({ redmine_id }) => {
  if (state.taskId && state.redmineId === redmine_id) {
    resetState();
  }
  removeFromPoolState(`redmine-${redmine_id}`);
  return ok({ forgot: true, redmine_id });
});

server.tool("pool_reset", "Сбросить состояние worker'а (danger zone).", {}, async () => {
  resetState();
  resetMyLocks();
  return ok({ reset: true, worker: WORKER_ID });
});

// Main loops
let cycling = false;
async function tickWrapper(): Promise<void> {
  if (cycling) return;
  cycling = true;
  try { await mainTick(); }
  catch (e: any) { console.error(`[agent-worker/${WORKER_ID}] tick error: ${e?.message ?? e}`); }
  finally { cycling = false; }
}

console.error(`[agent-worker/${WORKER_ID}] v0.1.0 | poll=${POLL_INTERVAL_MS}ms | heartbeat=${HEARTBEAT_INTERVAL_MS}ms`);

// Reset any stale locks and claims from previous sessions on startup
const released = releaseAllMyClaims(WORKER_ID);
if (released > 0) console.error(`[agent-worker/${WORKER_ID}] released ${released} stale claims from previous session`);
resetMyLocks();

// Crash recovery: check for orphan harness processes from previous session
const orphanHandles = loadRunningHandles();
if (orphanHandles.length > 0) {
  console.error(`[agent-worker/${WORKER_ID}] found ${orphanHandles.length} orphan harness(es) from previous session`);
  for (const h of orphanHandles) {
    const result = collectHarnessResult(h);
    if (result) {
      if (result.ok) {
        console.error(`[agent-worker/${WORKER_ID}] orphan ${h.taskId} completed: ${result.commits} commits`);
        if (!DRY_RUN) {
          try { await redmineUpdateIssue(Number(h.spec.redmine_id), resolveStatusId("В работе"), `Выполнено (recovered). Коммитов: ${result.commits}.`); }
          catch (e: any) { console.error(`recovery redmine error: ${e?.message ?? e}`); }
        }
        reportDone(h.spec, WORKER_ID, h.branch, result.commits);
      } else if (result.clarification) {
        console.error(`[agent-worker/${WORKER_ID}] orphan ${h.taskId} needs clarification`);
        if (!DRY_RUN) {
          try { await redmineUpdateIssue(Number(h.spec.redmine_id), resolveStatusId("На уточнении"), result.clarification); }
          catch (e: any) {}
        }
        reportClarifying(h.spec, WORKER_ID, result.clarification);
      } else {
        console.error(`[agent-worker/${WORKER_ID}] orphan ${h.taskId} failed: ${result.error}`);
        reportFailed(h.spec, WORKER_ID, h.branch, result.error || "recovered orphan failure");
      }
    } else {
      console.error(`[agent-worker/${WORKER_ID}] orphan ${h.taskId} still running (pid ${h.pid})`);
    }
  }
}

// Heartbeat loop
setInterval(() => {
  const hbStatus = (state.status === "failed" || state.status === "clarifying") ? "error" : state.status;
  writeHeartbeat(hbStatus as "idle" | "pending_approval" | "approved" | "working" | "error", state.taskId ?? undefined);
}, HEARTBEAT_INTERVAL_MS);

// Work loop
setInterval(tickWrapper, POLL_INTERVAL_MS);
tickWrapper();

await server.connect(new StdioServerTransport());
