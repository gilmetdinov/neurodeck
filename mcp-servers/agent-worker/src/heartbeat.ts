// mcp-servers/agent-worker/src/heartbeat.ts
// Heartbeat-файл worker'а для supervisor-мониторинга.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { hostname } from "node:os";
import { AGENTS_DIR, WORKER_ID } from "./config.js";

const HEARTBEAT_PATH = join(AGENTS_DIR, `${WORKER_ID}.json`);

export interface WorkerHeartbeat {
  worker_id: string;
  status: "idle" | "pending_approval" | "approved" | "working" | "error";
  task_id?: string;
  last_heartbeat: string;
  pid: number;
  hostname: string;
}

export function writeHeartbeat(status: WorkerHeartbeat["status"], taskId?: string): void {
  const hb: WorkerHeartbeat = {
    worker_id: WORKER_ID,
    status,
    task_id: taskId,
    last_heartbeat: new Date().toISOString(),
    pid: process.pid,
    hostname: hostname(),
  };
  mkdirSync(dirname(HEARTBEAT_PATH), { recursive: true });
  writeFileSync(HEARTBEAT_PATH, JSON.stringify(hb, null, 2));
}

export function readHeartbeat(): WorkerHeartbeat | null {
  if (!existsSync(HEARTBEAT_PATH)) return null;
  try { return JSON.parse(readFileSync(HEARTBEAT_PATH, "utf-8")) as WorkerHeartbeat; }
  catch { return null; }
}

export function isHeartbeatAlive(maxAgeSec = 120): boolean {
  const hb = readHeartbeat();
  if (!hb) return false;
  const last = new Date(hb.last_heartbeat).getTime();
  return Date.now() - last < maxAgeSec * 1000;
}

export function getWorkerStatus(): WorkerHeartbeat {
  return readHeartbeat() ?? {
    worker_id: WORKER_ID,
    status: "idle",
    last_heartbeat: new Date(0).toISOString(),
    pid: 0,
    hostname: "?",
  };
}
