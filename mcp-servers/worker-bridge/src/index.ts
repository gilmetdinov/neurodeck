#!/usr/bin/env node
// mcp-servers/worker-bridge/src/index.ts
// Тонкий MCP-мост между оркестратором и worker pool (ADR-0028).
// Оркестратор вызывает pool_approve → пишет событие в events/ → agent-worker подхватывает.
// ВАЖНО: не запускает harness сам — только файловая шина. Agent-worker живёт отдельно.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { writeFileSync, readFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { z } from "zod";

const clean = (v?: string): string => { const s = (v ?? "").trim(); return /^\$\{.*\}$/.test(s) ? "" : s; };
const ok = (obj: unknown) => ({ content: [{ type: "text" as const, text: typeof obj === "string" ? obj : JSON.stringify(obj, null, 2) }] });

const ROOT = clean(process.env.AGENT_REPO_ROOT) || process.cwd();
const EVENTS_DIR = join(ROOT, "workspace", "state", "events");
const POOL_STATE = clean(process.env.POOL_STATE_PATH) || join(process.env.HOME ?? "/tmp", ".openclaw", "agent-worker", "pool-state.json");
const TASK_QUEUE = join(ROOT, "workspace", "state", "task-queue");

function emitEvent(type: string, taskId: string, redmineId: number, payload?: Record<string, any>): string {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const file = join(EVENTS_DIR, `${ts}-${type}-${taskId}.json`);
  const event = { type, task_id: taskId, redmine_id: redmineId, timestamp: new Date().toISOString(), payload: payload ?? {} };
  mkdirSync(EVENTS_DIR, { recursive: true });
  writeFileSync(file, JSON.stringify(event, null, 2));
  return file;
}

function readPoolState(): any {
  if (!existsSync(POOL_STATE)) return { tasks: [] };
  try { return JSON.parse(readFileSync(POOL_STATE, "utf-8")); } catch { return { tasks: [] }; }
}

function writePoolState(state: any): void {
  mkdirSync(dirname(POOL_STATE), { recursive: true });
  writeFileSync(POOL_STATE, JSON.stringify(state, null, 2));
}

function findTask(taskIdOrRedmine: string): { task: any; pool: any } | null {
  const pool = readPoolState();
  const task = pool.tasks?.find((t: any) =>
    t.task_id === taskIdOrRedmine || String(t.redmine_id) === taskIdOrRedmine
  );
  return task ? { task, pool } : null;
}

const server = new McpServer({ name: "worker-bridge", version: "0.1.0" });

server.tool("pool_status", "Состояние worker pool (читает pool-state.json).", {}, async () => {
  const pool = readPoolState();
  const queueFiles = existsSync(TASK_QUEUE) ? readdirSync(TASK_QUEUE).filter((f: string) => !f.startsWith(".") && !f.endsWith(".claimed")) : [];
  return ok({
    pool_tasks: (pool.tasks || []).map((t: any) => ({ redmine_id: t.redmine_id, task_id: t.task_id, state: t.state, worker: t.worker, repo: t.repo })),
    queued: queueFiles.length,
    queue: queueFiles.map((f: string) => f.replace(".json", "")).slice(0, 10),
  });
});

server.tool("pool_approve", "Подтвердить выполнение задачи (пишет событие в events/, worker pool подхватит).", {
  task_id: z.string().describe("ID задачи (redmine-60030-... или просто номер #60030)"),
}, async ({ task_id }) => {
  let tid = task_id;
  // Allow #NNNNN format
  if (/^\d+$/.test(tid)) {
    // Try to find in queue
    const queueFiles = existsSync(TASK_QUEUE) ? readdirSync(TASK_QUEUE).filter((f: string) => f.endsWith(".json")) : [];
    const match = queueFiles.find((f: string) => f.includes(tid));
    if (match) tid = match.replace(".json", "");
  }
  const found = findTask(tid);
  if (!found) {
    return ok({ error: `Задача ${task_id} не найдена в pool-state`, hint: "Убедись что worker pool запущен и задача заклеймлена" });
  }
  if (found.task.state !== "pending_approval") {
    return ok({ error: `Задача уже в статусе ${found.task.state}`, task_id: found.task.task_id });
  }
  found.task.state = "approved";
  writePoolState(found.pool);
  emitEvent("cmd.approve", found.task.task_id, found.task.redmine_id, { approved_by: "orchestrator" });
  return ok({ approved: true, task_id: found.task.task_id, redmine_id: found.task.redmine_id, hint: "Worker подхватит в течение 30 сек" });
});

server.tool("pool_deny", "Отклонить задачу (вернуть в очередь).", {
  task_id: z.string(),
  reason: z.string().optional(),
}, async ({ task_id, reason }) => {
  const found = findTask(task_id);
  if (!found) return ok({ error: `Задача ${task_id} не найдена` });
  emitEvent("cmd.deny", found.task.task_id, found.task.redmine_id, { reason });
  return ok({ denied: true, task_id: found.task.task_id });
});

console.error(`[worker-bridge] v0.1.0`);
await server.connect(new StdioServerTransport());
