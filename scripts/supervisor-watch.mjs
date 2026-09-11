#!/usr/bin/env node
// scripts/supervisor-watch.mjs
// Supervisor мониторинга worker heartbeats (ADR-0028).
// Запуск: node scripts/supervisor-watch.mjs [--oneshot] [--interval-ms=60000] [--grace-ms=120000]
//
// Проверяет workspace/state/agents/*.json → если heartbeat просрочен:
//   1. Освобождает clone lock'и мёртвого worker'а
//   2. Снимает claim с текущей задачи (освобождает task-queue/*.claimed)
//   3. Пишет supervisor-лог в workspace/state/supervisor-log.json

import { readFileSync, writeFileSync, readdirSync, existsSync, unlinkSync, mkdirSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = (() => {
  try { return resolve(dirname(fileURLToPath(import.meta.url)), ".."); }
  catch { return process.cwd(); }
})();

const AGENTS_DIR = join(ROOT, "workspace", "state", "agents");
const TASK_QUEUE_DIR = join(ROOT, "workspace", "state", "task-queue");
const EVENTS_DIR = join(ROOT, "workspace", "state", "events");
const cleanEnv = (v) => { const s = (v ?? "").trim(); return /^\$\{.*\}$/.test(s) ? "" : s; };
const CLONES_BASE = cleanEnv(process.env.CLONES_BASE_DIR) || join(process.env.HOME ?? "/tmp", "neurodeck-clones");
const CLONE_REGISTRY_PATH = join(CLONES_BASE, ".clone-registry.json");
const SUPERVISOR_LOG_PATH = join(ROOT, "workspace", "state", "supervisor-log.json");

const ONESHOT = process.argv.includes("--oneshot");
const GRACE_MS = parseInt(process.argv.find((a) => a.startsWith("--grace-ms="))?.split("=")[1] || "120000", 10);
const INTERVAL_MS = parseInt(process.argv.find((a) => a.startsWith("--interval-ms="))?.split("=")[1] || "60000", 10);

function log(msg) {
  const ts = new Date().toISOString();
  console.error(`[supervisor ${ts}] ${msg}`);
}

function loadSupervisorLog() {
  if (!existsSync(SUPERVISOR_LOG_PATH)) return { last_check: "", checks: 0, recoveries: 0, history: [] };
  try { return JSON.parse(readFileSync(SUPERVISOR_LOG_PATH, "utf-8")); }
  catch { return { last_check: "", checks: 0, recoveries: 0, history: [] }; }
}

function saveSupervisorLog(sl) {
  mkdirSync(dirname(SUPERVISOR_LOG_PATH), { recursive: true });
  writeFileSync(SUPERVISOR_LOG_PATH, JSON.stringify(sl, null, 2));
}

function readHeartbeats() {
  if (!existsSync(AGENTS_DIR)) return [];
  const files = readdirSync(AGENTS_DIR).filter((f) => f.endsWith(".json"));
  const out = [];
  for (const f of files) {
    try {
      const hb = JSON.parse(readFileSync(join(AGENTS_DIR, f), "utf-8"));
      if (hb.worker_id && hb.last_heartbeat) out.push({ file: f, hb });
    } catch { /* skip invalid */ }
  }
  return out;
}

function isDead(hb) {
  const last = new Date(hb.last_heartbeat).getTime();
  return Date.now() - last > GRACE_MS;
}

function releaseCloneLocks(workerId) {
  if (!existsSync(CLONE_REGISTRY_PATH)) return 0;
  let count = 0;
  try {
    const reg = JSON.parse(readFileSync(CLONE_REGISTRY_PATH, "utf-8"));
    const clones = reg.clones ?? {};
    for (const key of Object.keys(clones)) {
      if (clones[key].worker === workerId) {
        delete clones[key];
        count++;
      }
    }
    reg.clones = clones;
    writeFileSync(CLONE_REGISTRY_PATH, JSON.stringify(reg, null, 2));
  } catch (e) { log(`failed to release clone locks: ${e}`); }
  return count;
}

function releaseTaskClaim(workerId) {
  if (!existsSync(TASK_QUEUE_DIR)) return { taskId: null, redmineId: null };
  const files = readdirSync(TASK_QUEUE_DIR).filter((f) => f.endsWith(".claimed"));
  for (const f of files) {
    try {
      const content = readFileSync(join(TASK_QUEUE_DIR, f), "utf-8").split("\n")[0];
      if (content === workerId) {
        const taskId = f.replace(".claimed", "");
        try { unlinkSync(join(TASK_QUEUE_DIR, f)); } catch { /* already gone */ }
        let redmineId = null;
        try {
          const spec = JSON.parse(readFileSync(join(TASK_QUEUE_DIR, taskId + ".json"), "utf-8"));
          redmineId = parseInt(spec.redmine_id, 10) || null;
        } catch { /* no spec */ }
        return { taskId, redmineId };
      }
    } catch { /* skip */ }
  }
  return { taskId: null, redmineId: null };
}

function emitRecoveryEvent(workerId, taskId, redmineId) {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const file = join(EVENTS_DIR, `${ts}-worker.dead-${workerId}.json`);
  const event = {
    type: "worker.dead",
    worker_id: workerId,
    task_id: taskId,
    redmine_id: redmineId,
    timestamp: new Date().toISOString(),
    payload: { action: "recovery", task_released: taskId, clone_locks_released: true },
  };
  mkdirSync(EVENTS_DIR, { recursive: true });
  try { writeFileSync(file, JSON.stringify(event, null, 2)); } catch { /* skip */ }
}

function check() {
  const sl = loadSupervisorLog();
  sl.checks++;
  sl.last_check = new Date().toISOString();

  const heartbeats = readHeartbeats();
  if (heartbeats.length === 0) {
    log("no heartbeats found");
    saveSupervisorLog(sl);
    return;
  }

  for (const { hb } of heartbeats) {
    if (!isDead(hb)) {
      log(`${hb.worker_id} alive (pid=${hb.pid}, status=${hb.status})`);
      continue;
    }

    log(`DEAD: ${hb.worker_id} (pid=${hb.pid}, last heartbeat ${hb.last_heartbeat}, grace=${GRACE_MS}ms)`);
    const clones = releaseCloneLocks(hb.worker_id);
    const claim = releaseTaskClaim(hb.worker_id);
    if (claim.taskId) emitRecoveryEvent(hb.worker_id, claim.taskId, claim.redmineId);

    sl.recoveries++;
    sl.history.push({
      timestamp: new Date().toISOString(),
      worker: hb.worker_id,
      action: "recovery",
      detail: `Dead after ${Math.round((Date.now() - new Date(hb.last_heartbeat).getTime()) / 1000)}s. Clones released: ${clones}. Task released: ${claim.taskId ?? "none"}.`,
    });
    sl.history = sl.history.slice(-100);
  }

  saveSupervisorLog(sl);
}

console.error(`[supervisor] v0.1.0 | grace=${GRACE_MS}ms | interval=${INTERVAL_MS}ms | oneshot=${ONESHOT}`);
check();

if (!ONESHOT) {
  setInterval(check, INTERVAL_MS);
}
