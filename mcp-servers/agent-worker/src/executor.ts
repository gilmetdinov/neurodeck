// mcp-servers/agent-worker/src/executor.ts
// Запуск harness/src/run.ts в клоне, обработка результатов.
// Детачед-спавн — harness переживает рестарт gateway.

import { spawn, spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { existsSync, readFileSync, writeFileSync, mkdirSync, openSync, unlinkSync } from "node:fs";
import { HARNESS_TIMEOUT_MS, OPENCODE_BIN, ROOT } from "./config.js";

export interface ExecuteResult {
  ok: boolean;
  exitCode: number;
  signal?: string;
  commits: number;
  branch: string;
  cost?: number;
  reportPath?: string;
  error?: string;
  clarification?: string;
}

interface HarnessHandle {
  pid: number;
  taskId: string;
  clonePath: string;
  branch: string;
  spec: Record<string, any>;
  startedAt: string;
  logFile: string;
}

const PID_DIR = join(ROOT, "workspace", "state", "harness-pids");

function pidFile(specId: string): string {
  return join(PID_DIR, `${specId}.json`);
}

export function saveHarnessHandle(h: HarnessHandle): void {
  mkdirSync(PID_DIR, { recursive: true });
  writeFileSync(pidFile(h.taskId), JSON.stringify(h, null, 2));
}

export function removeHarnessHandle(taskId: string): void {
  try { unlinkSync(pidFile(taskId)); } catch {}
}

export function loadRunningHandles(): HarnessHandle[] {
  if (!existsSync(PID_DIR)) return [];
  const handles: HarnessHandle[] = [];
  try {
    const { readdirSync, readFileSync } = require("node:fs");
    for (const f of readdirSync(PID_DIR)) {
      if (!f.endsWith(".json")) continue;
      try {
        const h = JSON.parse(readFileSync(join(PID_DIR, f), "utf-8")) as HarnessHandle;
        if (isProcessAlive(h.pid)) handles.push(h);
        else removeHarnessHandle(h.taskId);
      } catch {}
    }
  } catch {}
  return handles;
}

function isProcessAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch { return false; }
}

export function collectHarnessResult(handle: HarnessHandle): ExecuteResult | null {
  if (isProcessAlive(handle.pid)) return null;

  // Process completed — check results
  const result = processResult(0, null, handle.clonePath, handle.branch, "", "");
  if (result.ok || result.clarification) return result;

  // Try to read exit info from log
  const logFile = handle.logFile;
  if (existsSync(logFile)) {
    try {
      const log = readFileSync(logFile, "utf-8");
      if (log.includes("HARNESS_DONE")) {
        const commits = countAgentCommits(handle.clonePath, handle.branch, handle.spec.redmine_id);
        return { ok: true, exitCode: 0, commits, branch: handle.branch };
      }
    } catch {}
  }

  // Default: assume failed if we can't determine outcome
  const commits = countAgentCommits(handle.clonePath, handle.branch, handle.spec.redmine_id);
  return { ok: commits > 0, exitCode: 0, commits, branch: handle.branch,
    error: commits === 0 ? "harness completed but no agent commits found" : undefined };
}

export async function executeHarness(spec: Record<string, any>, clonePath: string, branch: string): Promise<ExecuteResult> {
  const taskFile = join(ROOT, "workspace", "state", "task-queue", `${spec.id}.json`);
  if (!existsSync(taskFile)) {
    return { ok: false, exitCode: -1, commits: 0, branch, error: `TaskSpec file not found: ${taskFile}` };
  }

  // Patch target to point to the clone — harness reads task.target for its working directory.
  let originalTarget = "";
  try {
    const raw = JSON.parse(readFileSync(taskFile, "utf-8"));
    originalTarget = raw.target || "";
    raw.target = clonePath;
    writeFileSync(taskFile, JSON.stringify(raw, null, 2));
  } catch {}

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HARNESS_NOTIFY: "0",
    HARNESS_BRANCH: branch,
    OPENCODE_BIN,
    HARNESS_GIT_NAME: "neurodeck Agent",
    HARNESS_GIT_EMAIL: "agent@local",
    OPENCODE_TIMEOUT_MS: String(OPENCODE_TIMEOUT_MS || 600000),
  };

  const cmd = "node";
  const args = ["--experimental-strip-types", join(ROOT, "harness", "src", "run.ts"), taskFile];

  const logDir = join(ROOT, "harness", "logs");
  mkdirSync(logDir, { recursive: true });
  const logFile = join(logDir, `${spec.id}.log`);
  const errFile = join(logDir, `${spec.id}.err`);

  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: clonePath,
      env,
      detached: true,
      stdio: ["ignore", openSync(logFile, "w"), openSync(errFile, "w")],
    });

    // Write PID handle for crash recovery
    saveHarnessHandle({
      pid: child.pid!,
      taskId: spec.id,
      clonePath,
      branch,
      spec,
      startedAt: new Date().toISOString(),
      logFile,
    });

    // Unref child so it survives parent process exit
    child.unref();

    const timer = setTimeout(() => {
      try { child.kill("SIGTERM"); } catch {}
      setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 30_000);
    }, HARNESS_TIMEOUT_MS);

    child.on("close", (code, signal) => {
      clearTimeout(timer);
      removeHarnessHandle(spec.id);
      // Restore original target path in TaskSpec
      if (originalTarget) {
        try {
          const restored = JSON.parse(readFileSync(taskFile, "utf-8"));
          restored.target = originalTarget;
          writeFileSync(taskFile, JSON.stringify(restored, null, 2));
        } catch {}
      }
      const result = processResult(code, signal, clonePath, branch, "", "");
      // Fix commit count: only count agent-authored commits
      if (result.commits === 0 || !result.ok) {
        const agentCommits = countAgentCommits(clonePath, branch, spec.redmine_id);
        if (agentCommits > 0) {
          result.commits = agentCommits;
          result.ok = true;
          result.error = undefined;
        }
      }
      resolve(result);
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      removeHarnessHandle(spec.id);
      resolve({ ok: false, exitCode: -1, commits: 0, branch, error: `spawn failed: ${err.message}` });
    });
  });
}

function processResult(code: number | null, signal: NodeJS.Signals | null, clonePath: string, branch: string, _stdout: string, _stderr: string): ExecuteResult {
  if (signal) {
    return { ok: false, exitCode: code ?? -1, signal, commits: 0, branch, error: `harness killed by ${signal}` };
  }
  if (code === null || code === undefined) {
    return { ok: false, exitCode: -1, commits: 0, branch, error: "harness exited without code" };
  }
  const commits = countAgentCommits(clonePath, branch, 0);
  if (code === 0) return { ok: true, exitCode: 0, commits, branch };
  const error = `harness exited with code ${code}`;
  return { ok: false, exitCode: code, commits, branch, error };
}

export let OPENCODE_TIMEOUT_MS: number = Number(process.env.OPENCODE_TIMEOUT_MS) || 600000;

function countAgentCommits(clonePath: string, branch: string, _redmineId: number): number {
  const r = spawnSync("git", ["log", "--oneline", branch, "--not", "master", "develop", "--perl-regexp", "--author", "(Agent|neurodeck|agent@example\\.com)"], {
    cwd: clonePath, encoding: "utf-8",
  });
  if (r.status === 0 && r.stdout.trim()) {
    return r.stdout.trim().split("\n").length;
  }
  const r2 = spawnSync("git", ["log", "--oneline", branch, "--not", "master", "--", "."], {
    cwd: clonePath, encoding: "utf-8",
  });
  if (r2.status !== 0) return 0;
  const lines = r2.stdout.trim().split("\n").filter(Boolean);
  if (lines.length > 100) return lines.length;
  return 0;
}

export function findReportPath(branch: string): string | undefined {
  const reportDir = join(ROOT, "harness", "reports");
  if (!existsSync(reportDir)) return undefined;
  return undefined;
}

export function needsClarification(result: ExecuteResult): boolean {
  return Boolean(result.clarification);
}
