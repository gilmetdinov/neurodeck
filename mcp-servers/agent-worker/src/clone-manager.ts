// mcp-servers/agent-worker/src/clone-manager.ts
// Управление фиксированными клонами: registry, lock, fetch, checkout, release.

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { getClonePolicy, getProjectsRegistry, WORKER_ID, ROOT } from "./config.js";

const clean = (v?: string): string => { const s = (v ?? "").trim(); return /^\$\{.*\}$/.test(s) ? "" : s; };

export interface CloneEntry {
  worker: string;
  repo: string;
  path: string;
  lockedSince: string;
  taskId: string | null;
}

export interface CloneRegistry {
  clones: Record<string, CloneEntry>;
}

export function getClonePolicyConfig(): {
  clonesBaseDir: string;
  registryPath: string;
  maxClonesPerRepo: number;
  lockTimeoutSec: number;
  hotStandby: boolean;
  preWorkRefresh: boolean;
  serviceRepos: string[];
} {
  const policy = getClonePolicy();
  const envBase = clean(process.env.CLONES_BASE_DIR);
  const cfgBase = policy.clones_base_dir || "";
  const clonesBaseDir = envBase || cfgBase || join(process.env.HOME ?? "/tmp", "neurodeck-clones");
  return {
    clonesBaseDir,
    registryPath: policy.clone_registry_path || join(clonesBaseDir, ".clone-registry.json"),
    maxClonesPerRepo: policy.default_policy?.max_clones_per_repo ?? 3,
    lockTimeoutSec: policy.default_policy?.lock_timeout_sec ?? 7200,
    hotStandby: policy.default_policy?.hot_standby ?? true,
    preWorkRefresh: policy.default_policy?.pre_work_refresh ?? true,
    serviceRepos: policy.service_repos ?? [],
  };
}

function loadRegistry(): CloneRegistry {
  const { registryPath } = getClonePolicyConfig();
  if (!existsSync(registryPath)) return { clones: {} };
  try { return JSON.parse(readFileSync(registryPath, "utf-8")) as CloneRegistry; }
  catch { return { clones: {} }; }
}

function saveRegistry(reg: CloneRegistry): void {
  const { registryPath } = getClonePolicyConfig();
  mkdirSync(dirname(registryPath), { recursive: true });
  writeFileSync(registryPath, JSON.stringify(reg, null, 2));
}

function cloneKey(repo: string, worker: string): string { return `${repo}-${worker}`; }

export function isServiceRepo(repo: string): boolean {
  return getClonePolicyConfig().serviceRepos.includes(repo);
}

export function clonePath(repo: string, worker: string): string {
  const { clonesBaseDir } = getClonePolicyConfig();
  if (isServiceRepo(repo)) return join(clonesBaseDir, "services", repo);
  return join(clonesBaseDir, `${repo}-${worker}`);
}

function git(args: string[], cwd: string): { ok: boolean; stdout: string; stderr: string } {
  const r = spawnSync("git", args, { cwd, encoding: "utf-8" });
  return { ok: r.status === 0, stdout: r.stdout?.trim() ?? "", stderr: r.stderr?.trim() ?? "" };
}

function ensureRepoCloned(repo: string, sourcePath: string, targetPath: string): boolean {
  if (existsSync(join(targetPath, ".git"))) return true;
  mkdirSync(dirname(targetPath), { recursive: true });
  if (existsSync(join(sourcePath, ".git"))) {
    const r1 = git(["clone", "--no-hardlinks", "--", sourcePath, targetPath], dirname(targetPath));
    if (!r1.ok) console.error(`[agent-worker] clone failed ${sourcePath} → ${targetPath}: ${r1.stderr}`);
    return r1.ok;
  }
  // Source not a repo — init empty and configure remote
  const r2 = git(["init", targetPath], dirname(targetPath));
  return r2.ok;
}

function refreshClone(path: string, branch = "master"): { ok: boolean; error?: string } {
  const { preWorkRefresh } = getClonePolicyConfig();
  if (!preWorkRefresh) return { ok: true };
  const fetch = git(["fetch", "origin"], path);
  if (!fetch.ok) return { ok: false, error: `fetch: ${fetch.stderr}` };
  const checkout = git(["checkout", branch], path);
  if (!checkout.ok) return { ok: false, error: `checkout: ${checkout.stderr}` };
  const pull = git(["pull", "--ff-only", "origin", branch], path);
  if (!pull.ok) return { ok: false, error: `pull: ${pull.stderr}` };
  return { ok: true };
}

export function acquireClone(repo: string, taskId: string): { ok: boolean; path?: string; error?: string } {
  const cfg = getClonePolicyConfig();
  const reg = loadRegistry();
  const key = cloneKey(repo, WORKER_ID);
  const path = clonePath(repo, WORKER_ID);

  // Check if already locked by this worker
  const existing = reg.clones[key];
  if (existing && existing.worker !== WORKER_ID) {
    // Check lock timeout
    const locked = new Date(existing.lockedSince).getTime();
    if (Date.now() - locked < cfg.lockTimeoutSec * 1000) {
      return { ok: false, error: `clone ${key} locked by ${existing.worker}` };
    }
  }

  // Get source path from registry
  const regProjects = getProjectsRegistry();
  let sourcePath: string = regProjects?.projects?.[repo]?.repoPath;
  if (!sourcePath) {
    // Try workRoots
    const baseDir = regProjects?.baseDir;
    const roots = regProjects?.defaults?.harness?.workRoots ?? ["services", "libraries"];
    for (const r of roots) {
      const candidate = join(baseDir, r, repo);
      if (existsSync(candidate)) { sourcePath = candidate; break; }
    }
  }
  if (!sourcePath) return { ok: false, error: `repo ${repo} not found in registry` };
  if (!existsSync(sourcePath)) return { ok: false, error: `source repo ${sourcePath} does not exist` };

  if (!ensureRepoCloned(repo, sourcePath, path)) {
    return { ok: false, error: `failed to ensure clone at ${path}` };
  }

  const refreshed = refreshClone(path);
  if (!refreshed.ok) return { ok: false, error: refreshed.error };

  reg.clones[key] = {
    worker: WORKER_ID,
    repo,
    path,
    lockedSince: new Date().toISOString(),
    taskId,
  };
  saveRegistry(reg);
  return { ok: true, path };
}

export function releaseClone(repo: string, taskId?: string): void {
  const reg = loadRegistry();
  const key = cloneKey(repo, WORKER_ID);
  const entry = reg.clones[key];
  if (entry && entry.worker === WORKER_ID) {
    if (taskId == null || entry.taskId === taskId) {
      delete reg.clones[key];
      saveRegistry(reg);
    }
  }
}

export function getCloneStatus(repo: string): CloneEntry | null {
  const reg = loadRegistry();
  return reg.clones[cloneKey(repo, WORKER_ID)] ?? null;
}

export function getAllCloneLocks(): CloneEntry[] {
  return Object.values(loadRegistry().clones);
}

export function resetMyLocks(): void {
  const reg = loadRegistry();
  for (const key of Object.keys(reg.clones)) {
    if (reg.clones[key].worker === WORKER_ID) delete reg.clones[key];
  }
  saveRegistry(reg);
}

export function createBranch(path: string, branch: string): { ok: boolean; error?: string } {
  // Clean up branch if exists, then create
  git(["branch", "-D", branch], path);
  const r = git(["checkout", "-b", branch], path);
  if (!r.ok) return { ok: false, error: r.stderr };
  return { ok: true };
}

export function commitPending(path: string, message: string): { ok: boolean; error?: string } {
  const add = git(["add", "-A"], path);
  if (!add.ok) return { ok: false, error: add.stderr };
  const commit = git(["commit", "-m", message, "--no-verify"], path);
  if (!commit.ok) {
    // Might be empty commit
    if (commit.stderr.includes("nothing to commit") || commit.stdout.includes("nothing to commit")) return { ok: true };
    return { ok: false, error: commit.stderr };
  }
  return { ok: true };
}

export function countCommits(path: string, branch: string): number {
  const r = git(["rev-list", "--count", branch], path);
  if (!r.ok) return 0;
  return Number(r.stdout) || 0;
}

export function getBranchDiffStat(path: string, baseBranch: string): string {
  const r = git(["diff", `${baseBranch}...HEAD`, "--stat"], path);
  return r.stdout || "";
}

export function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}
