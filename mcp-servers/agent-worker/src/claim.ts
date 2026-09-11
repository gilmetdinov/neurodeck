// mcp-servers/agent-worker/src/claim.ts
// Атомарный claim задач из task-queue/ через O_EXCL|O_CREAT.

import { readFileSync, writeFileSync, existsSync, unlinkSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { QUEUE_DIR } from "./config.js";

export interface ClaimResult {
  taskId: string;
  redmineId: number;
  spec: Record<string, any>;
  claimed: boolean;
  worker?: string;
  claimedAt?: string;
}

export function claimTask(taskId: string, workerId: string): boolean {
  const claimFile = join(QUEUE_DIR, `${taskId}.claimed`);
  try {
    writeFileSync(claimFile, `${workerId}\n${new Date().toISOString()}`, { flag: "wx" });
    return true;
  } catch { return false; }
}

export function releaseTask(taskId: string): void {
  try { unlinkSync(join(QUEUE_DIR, `${taskId}.claimed`)); } catch {}
}

export function readClaim(taskId: string): { worker: string; claimedAt: string } | null {
  const claimFile = join(QUEUE_DIR, `${taskId}.claimed`);
  if (!existsSync(claimFile)) return null;
  try {
    const [worker, claimedAt] = readFileSync(claimFile, "utf-8").split("\n");
    return { worker, claimedAt };
  } catch { return null; }
}

export function listUnclaimedSpecs(): { taskId: string; spec: Record<string, any> }[] {
  const files = readdirSync(QUEUE_DIR).filter((f) => f.endsWith(".json"));
  const out: { taskId: string; spec: Record<string, any> }[] = [];
  for (const f of files) {
    const taskId = f.replace(/\.json$/, "");
    if (existsSync(join(QUEUE_DIR, `${taskId}.claimed`))) continue;
    try {
      const spec = JSON.parse(readFileSync(join(QUEUE_DIR, f), "utf-8")) as Record<string, any>;
      out.push({ taskId, spec });
    } catch {}
  }
  return out;
}

export function readTaskSpec(taskId: string): Record<string, any> | null {
  const p = join(QUEUE_DIR, `${taskId}.json`);
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, "utf-8")); } catch { return null; }
}

export function removeTaskSpec(taskId: string): void {
  try { unlinkSync(join(QUEUE_DIR, `${taskId}.json`)); } catch {}
  try { unlinkSync(join(QUEUE_DIR, `${taskId}.prompt.md`)); } catch {}
  releaseTask(taskId);
}

export function taskIsClaimed(taskId: string): boolean {
  return existsSync(join(QUEUE_DIR, `${taskId}.claimed`));
}

export function releaseAllMyClaims(workerId: string): number {
  const files = readdirSync(QUEUE_DIR).filter((f) => f.endsWith(".claimed"));
  let count = 0;
  for (const f of files) {
    try {
      const content = readFileSync(join(QUEUE_DIR, f), "utf-8").split("\n")[0];
      if (content === workerId) {
        unlinkSync(join(QUEUE_DIR, f));
        count++;
      }
    } catch {}
  }
  return count;
}
