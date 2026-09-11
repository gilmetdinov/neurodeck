// mcp-servers/agent-worker/src/config.ts
// Конфигурация и константы worker'а.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const JSON5 = require("json5");

const clean = (v?: string): string => { const s = (v ?? "").trim(); return /^\$\{.*\}$/.test(s) ? "" : s; };

export const ROOT = (() => {
  const env = clean(process.env.AGENT_REPO_ROOT);
  if (env) return env;
  try { return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", ".."); }
  catch { return process.cwd(); }
})();

export const WORKSPACE_STATE_DIR = join(ROOT, "workspace", "state");

export const WORKER_ID = clean(process.env.WORKER_ID) || "worker-1";

export const STORE_DIR = join(WORKSPACE_STATE_DIR, "agents", WORKER_ID);
export const STORE_PATH = join(WORKSPACE_STATE_DIR, "agent-worker-state.json");
export const POOL_STATE_PATH = join(WORKSPACE_STATE_DIR, "pool-state.json");

// Legacy ~/.openclaw mirror — keep synced for existing consumers (worker-bridge, git-egress)
export const OPENCLAW_HOME = clean(process.env.OPENCLAW_HOME) || join(process.env.HOME ?? "~", ".openclaw");
export const POOL_STATE_MIRROR = join(OPENCLAW_HOME, "agent-worker", "pool-state.json");

export const POLL_INTERVAL_MS = Number(clean(process.env.AGENT_WORKER_POLL_INTERVAL_MS) || "30000");
export const HEARTBEAT_INTERVAL_MS = Number(clean(process.env.AGENT_WORKER_HEARTBEAT_INTERVAL_MS) || "30000");
export const HARNESS_TIMEOUT_MS = Number(clean(process.env.HARNESS_TIMEOUT_MS) || "7200000");
export const OPENCODE_BIN = clean(process.env.OPENCODE_BIN) || "opencode-proxy";

export const REDMINE_BASE_URL = clean(process.env.REDMINE_BASE_URL);
export const REDMINE_API_KEY = clean(process.env.REDMINE_API_KEY);
export const REDMINE_LOGIN = clean(process.env.REDMINE_LOGIN);
export const REDMINE_PASSWORD = clean(process.env.REDMINE_PASSWORD);
export const useBasicAuth = Boolean(REDMINE_LOGIN && REDMINE_PASSWORD);

export const GL_BASE_URL = clean(process.env.GITLAB_BASE_URL);
export const GL_TOKEN = clean(process.env.GITLAB_TOKEN);
export const GL_WRITE_TOKEN = clean(process.env.GITLAB_WRITE_TOKEN);

export const TG_TOKEN = clean(process.env.TELEGRAM_BOT_TOKEN);
export const TG_PROXY = clean(process.env.PROXY_URL);

export const DRY_RUN = clean(process.env.DRY_RUN) === "true" || clean(process.env.DRY_RUN) === "1";

export const QUEUE_DIR = join(ROOT, "workspace", "state", "task-queue");
export const EVENTS_DIR = join(ROOT, "workspace", "state", "events");
export const AGENTS_DIR = join(ROOT, "workspace", "state", "agents");
export const ARCHIVE_DIR = join(ROOT, "workspace", "state", "archive");

export const WORKERS_PATH = join(ROOT, "config", "workers.json5");
export const CLONE_POLICY_PATH = join(ROOT, "config", "clone-policy.json5");
export const PROJECTS_PATH = join(ROOT, "config", "projects.json5");
export const TEAM_PATH = join(ROOT, "config", "team.json");

export function loadConfig(path: string): any {
  if (!existsSync(path)) return {};
  try { return JSON5.parse(readFileSync(path, "utf-8")); }
  catch (e) { console.error(`[agent-worker] failed to load config ${path}: ${e}`); return {}; }
}

export function ok(obj: unknown) { return { content: [{ type: "text" as const, text: typeof obj === "string" ? obj : JSON.stringify(obj, null, 2) }] }; }

export function emitEvent(type: string, taskId: string, redmineId: number, payload?: Record<string, any>): string {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const file = join(EVENTS_DIR, `${ts}-${type}-${taskId}.json`);
  const event = { type, task_id: taskId, redmine_id: redmineId, timestamp: new Date().toISOString(), payload: payload ?? {} };
  mkdirSync(EVENTS_DIR, { recursive: true });
  writeFileSync(file, JSON.stringify(event, null, 2));
  return file;
}

export interface WorkerConfig {
  id: string;
  name: string;
  specialization: string[];
  default_model: string;
  tier?: string;
  max_concurrent_tasks?: number;
  idle_grace_ms?: number;
  heartbeat_interval_ms?: number;
}

export function getWorkerConfig(): WorkerConfig {
  const cfg = loadConfig(WORKERS_PATH);
  const w = (cfg.workers ?? []).find((x: any) => x.id === WORKER_ID);
  if (!w) {
    console.error(`[agent-worker] WARNING: worker ${WORKER_ID} not found in workers.json5; using defaults`);
    return {
      id: WORKER_ID,
      name: WORKER_ID,
      specialization: [],
      default_model: "opencode-go/deepseek-v4-pro",
      tier: "strong",
      max_concurrent_tasks: 1,
      idle_grace_ms: 600000,
      heartbeat_interval_ms: 30000,
    };
  }
  return {
    id: w.id,
    name: w.name || w.id,
    specialization: w.specialization ?? [],
    default_model: w.default_model || "opencode-go/deepseek-v4-pro",
    tier: w.tier || "strong",
    max_concurrent_tasks: w.max_concurrent_tasks ?? 1,
    idle_grace_ms: w.idle_grace_ms ?? 600000,
    heartbeat_interval_ms: w.heartbeat_interval_ms ?? 30000,
  };
}

export function getClonePolicy(): any {
  return loadConfig(CLONE_POLICY_PATH);
}

export function getProjectsRegistry(): any {
  const reg = loadConfig(PROJECTS_PATH);
  const envBase = clean(process.env.AGENT_WORKBENCH_DIR);
  if (envBase) reg.baseDir = envBase;
  return reg;
}

export function getTeamConfig(): any {
  return loadConfig(TEAM_PATH);
}

export function resolveStatusId(name: string): number {
  const team = getTeamConfig();
  const map: Record<string, number> = {
    "На исполнение": 20, "В работе": 2, "Code review": 13, "На уточнении": 14,
    "Исполнено": 27, "На доработке": 8,
  };
  for (const [key, group] of Object.entries<any>(team.statuses ?? {})) {
    const idx = (group.names ?? []).indexOf(name);
    if (idx >= 0) return (group.ids ?? [])[idx] ?? map[name];
  }
  return map[name] ?? 14;
}

export function statusNameById(id: number): string {
  const team = getTeamConfig();
  for (const group of Object.values<any>(team.statuses ?? {})) {
    const idx = (group.ids ?? []).indexOf(id);
    if (idx >= 0) return (group.names ?? [])[idx] ?? `#${id}`;
  }
  return `#${id}`;
}
