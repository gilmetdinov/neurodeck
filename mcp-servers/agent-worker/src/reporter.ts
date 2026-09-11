// mcp-servers/agent-worker/src/reporter.ts
// Запись результатов в pool-state.json и эмиссия событий.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { createRequire } from "node:module";
import { POOL_STATE_PATH, POOL_STATE_MIRROR, WORKSPACE_STATE_DIR, ROOT, emitEvent } from "./config.js";

interface PoolTask {
  redmine_id: number;
  task_id: string;
  repo: string;
  repo_path: string;
  branch: string;
  gitlab_project_id?: number;
  worker: string;
  state: "done" | "failed" | "clarifying" | "pending_approval" | "approved";
  done_at?: string;
  commits?: number;
  iteration: number;
  error?: string;
  clarification?: string;
}

interface PoolState {
  tasks: PoolTask[];
}

function loadPoolState(): PoolState {
  if (!existsSync(POOL_STATE_PATH)) return { tasks: [] };
  try { return JSON.parse(readFileSync(POOL_STATE_PATH, "utf-8")) as PoolState; }
  catch { return { tasks: [] }; }
}

function savePoolState(state: PoolState): void {
  mkdirSync(dirname(POOL_STATE_PATH), { recursive: true });
  writeFileSync(POOL_STATE_PATH, JSON.stringify(state, null, 2));
  // Legacy mirror for git-egress, worker-bridge
  try { mkdirSync(dirname(POOL_STATE_MIRROR), { recursive: true }); writeFileSync(POOL_STATE_MIRROR, JSON.stringify(state, null, 2)); } catch {}
}

export function updatePoolState(task: PoolTask): void {
  const state = loadPoolState();
  const idx = state.tasks.findIndex((t) => t.task_id === task.task_id);
  if (idx >= 0) state.tasks[idx] = { ...state.tasks[idx], ...task };
  else state.tasks.push(task);
  savePoolState(state);
}

export function removeFromPoolState(taskId: string): void {
  const state = loadPoolState();
  state.tasks = state.tasks.filter((t) => t.task_id !== taskId);
  savePoolState(state);
}

export function reportDone(spec: Record<string, any>, workerId: string, branch: string, commits: number): void {
  const task: PoolTask = {
    redmine_id: Number(spec.redmine_id),
    task_id: spec.id as string,
    repo: spec.repo as string,
    repo_path: spec.target as string,
    branch,
    gitlab_project_id: getGitlabProjectId(spec.repo as string),
    worker: workerId,
    state: "done",
    done_at: new Date().toISOString(),
    commits,
    iteration: Number(spec.iteration ?? 0),
  };
  updatePoolState(task);
  emitEvent("task.done", spec.id as string, Number(spec.redmine_id), { repo: spec.repo, branch, commits, worker: workerId });
}

export function reportFailed(spec: Record<string, any>, workerId: string, branch: string, error: string): void {
  const task: PoolTask = {
    redmine_id: Number(spec.redmine_id),
    task_id: spec.id as string,
    repo: spec.repo as string,
    repo_path: spec.target as string,
    branch,
    worker: workerId,
    state: "failed",
    done_at: new Date().toISOString(),
    iteration: Number(spec.iteration ?? 0),
    error: error.slice(0, 500),
  };
  updatePoolState(task);
  emitEvent("task.failed", spec.id as string, Number(spec.redmine_id), { error: error.slice(0, 200) });
}

export function reportClarifying(spec: Record<string, any>, workerId: string, text: string): void {
  const task: PoolTask = {
    redmine_id: Number(spec.redmine_id),
    task_id: spec.id as string,
    repo: spec.repo as string,
    repo_path: spec.target as string,
    branch: "",
    worker: workerId,
    state: "clarifying",
    iteration: Number(spec.iteration ?? 0),
    clarification: text.slice(0, 1000),
  };
  updatePoolState(task);
  emitEvent("task.needs_clarify", spec.id as string, Number(spec.redmine_id), { worker: workerId, questions: text.slice(0, 500) });
}

export function reportPendingApproval(spec: Record<string, any>, workerId: string): void {
  const task: PoolTask = {
    redmine_id: Number(spec.redmine_id),
    task_id: spec.id as string,
    repo: spec.repo as string,
    repo_path: spec.target as string,
    branch: "",
    worker: workerId,
    state: "pending_approval",
    iteration: Number(spec.iteration ?? 0),
  };
  updatePoolState(task);
  emitEvent("task.pending_approval", spec.id as string, Number(spec.redmine_id), { worker: workerId });
}

export function reportApproved(spec: Record<string, any>, workerId: string): void {
  const state = loadPoolState();
  const t = state.tasks.find((x) => x.task_id === spec.id);
  if (t) {
    t.state = "approved";
    savePoolState(state);
  }
  emitEvent("task.approved", spec.id as string, Number(spec.redmine_id), { worker: workerId });
}

export function getPoolState(): PoolState {
  return loadPoolState();
}

function getGitlabProjectId(repo: string): number | undefined {
  const reg = loadProjectsRegistry();
  const pid = reg?.projects?.[repo]?.gitlabProjectId;
  return pid ? Number(pid) : undefined;
}

const require = createRequire(import.meta.url);
const JSON5 = require("json5");

function loadProjectsRegistry(): any {
  try {
    return JSON5.parse(readFileSync(join(ROOT, "config", "projects.json5"), "utf-8"));
  } catch { return {}; }
}

// Re-export emitEvent from config for convenience
export { emitEvent };
