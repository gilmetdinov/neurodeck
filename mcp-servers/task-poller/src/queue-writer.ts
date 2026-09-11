// mcp-servers/task-poller/src/queue-writer.ts
// Тонкая обёртка вокруг записи в task-queue/ и эмиссии событий.
// Основная логика сохранения живёт в compiler.ts (saveTaskSpecToQueue, emitEvent).

import { existsSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { QUEUE_DIR, saveTaskSpecToQueue, emitEvent, isTaskAlreadyQueued, isTaskArchived } from "./compiler.js";

export interface QueuedTask {
  task_id: string;
  redmine_id: number;
  repo: string;
  lang: string;
  estimated: boolean;
  claimed: boolean;
  claim_worker?: string;
  iteration: number;
}

export function listQueuedTasks(): QueuedTask[] {
  const files = readdirSync(QUEUE_DIR).filter((f) => f.endsWith(".json"));
  return files.map((f) => {
    const task = JSON.parse(readFileSync(join(QUEUE_DIR, f), "utf-8")) as Record<string, any>;
    const claimedPath = join(QUEUE_DIR, f.replace(".json", ".claimed"));
    const claimed = existsSync(claimedPath);
    let claim_worker: string | undefined;
    if (claimed) {
      try { claim_worker = readFileSync(claimedPath, "utf-8").split("\n")[0]; } catch {}
    }
    return {
      task_id: task.id as string,
      redmine_id: Number(task.redmine_id),
      repo: String(task.repo ?? ""),
      lang: String(task.lang ?? ""),
      estimated: Boolean(task.estimated),
      claimed,
      claim_worker,
      iteration: Number(task.iteration ?? 0),
    };
  });
}

export function getTaskSpecPath(taskId: string): string {
  return join(QUEUE_DIR, `${taskId}.json`);
}

export function getTaskPromptPath(taskId: string): string {
  return join(QUEUE_DIR, `${taskId}.prompt.md`);
}

export function readTaskSpec(taskId: string): Record<string, any> | null {
  const p = getTaskSpecPath(taskId);
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, "utf-8")) as Record<string, any>; }
  catch { return null; }
}

export function removeFromQueue(taskId: string): void {
  try { unlinkSync(getTaskSpecPath(taskId)); } catch {}
  try { unlinkSync(getTaskPromptPath(taskId)); } catch {}
  try { unlinkSync(getTaskSpecPath(taskId).replace(".json", ".claimed")); } catch {}
}

export { QUEUE_DIR, saveTaskSpecToQueue, emitEvent, isTaskAlreadyQueued, isTaskArchived };
