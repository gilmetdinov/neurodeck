// mcp-servers/task-poller/src/rework.ts
// Перекомпиляция задач в статусе "На доработке" (8) с контекстом MR-комментариев.

import { readFileSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import {
  listRedmineIssuesByStatus,
  compileAndEstimate,
  findMrForTask,
  fetchGitLabMrComments,
  emitEvent,
  isTaskAlreadyQueued,
  isTaskArchived,
  CompileResult,
  REDMINE_BASE_URL,
  REDMINE_API_KEY,
  REDMINE_LOGIN,
  REDMINE_PASSWORD,
} from "./compiler.js";
import { readTaskSpec, removeFromQueue } from "./queue-writer.js";

const clean = (v?: string): string => { const s = (v ?? "").trim(); return /^\$\{.*\}$/.test(s) ? "" : s; };

const GL_BASE_URL = clean(process.env.GITLAB_BASE_URL);
const GL_WRITE_TOKEN = clean(process.env.GITLAB_WRITE_TOKEN);
const AGENT_ID = Number(clean(process.env.TASK_POLLER_AGENT_ID) || "386");
const { fileURLToPath } = await import("node:url");
const ROOT = (() => {
  const env = clean(process.env.AGENT_REPO_ROOT);
  if (env) return env;
  try { return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", ".."); }
  catch { return process.cwd(); }
})();

export interface ReworkResult {
  redmine_id: number;
  task_id?: string;
  error?: string;
  recompiled?: boolean;
  comments_count?: number;
}

async function getRegistry(): Promise<Record<string, any>> {
  const { createRequire } = await import("node:module");
  const JSON5 = createRequire(import.meta.url)("json5");
  const regPath = join(ROOT, "config", "projects.json5");
  return JSON5.parse(readFileSync(regPath, "utf-8"));
}

export async function pollReworkTasks(): Promise<ReworkResult[]> {
  const results: ReworkResult[] = [];
  if (!REDMINE_BASE_URL) return results;
  try {
    const issues = await listRedmineIssuesByStatus(8, AGENT_ID);
    const reg = await getRegistry();
    const projects = (reg?.projects ?? {}) as Record<string, any>;

    for (const issue of issues) {
      const redmineId = Number(issue.id);
      // Determine repo from previous TaskSpec or issue description
      const repo = await detectRepo(redmineId, issue, projects);
      const projectId = repo ? projects[repo]?.gitlabProjectId ?? null : null;
      let comments: string[] = [];
      if (projectId && GL_WRITE_TOKEN) {
        const mr = await findMrForTask(redmineId, projectId, GL_WRITE_TOKEN, GL_BASE_URL);
        if (mr) comments = await fetchGitLabMrComments(projectId, mr.iid, GL_WRITE_TOKEN, GL_BASE_URL);
      }

      const taskId = `redmine-${redmineId}-${slug(String(issue.subject ?? ""))}`;
      if (isTaskAlreadyQueued(taskId) || isTaskArchived(taskId)) {
        results.push({ redmine_id: redmineId, task_id: taskId, recompiled: false });
        continue;
      }

      const reworkContext = [
        `Статус: На доработке (Redmine #${redmineId}).`,
        comments.length ? `Комментарии из MR:\n${comments.join("\n")}` : "Комментарии из MR отсутствуют.",
      ].join("\n\n");

      const compiled = await compileAndEstimate(redmineId, {
        repo,
        extra: reworkContext,
        mode: "autonomous",
        reworkContext,
      });

      if (compiled.task_spec) {
        const spec = compiled.task_spec;
        spec.iteration = (Number(spec.iteration ?? 0)) + 1;
        spec.rework_context = reworkContext;
        results.push({ redmine_id: redmineId, task_id: spec.id as string, recompiled: true, comments_count: comments.length });
        emitEvent("task.compiled", spec.id as string, redmineId, { repo: spec.repo, lang: spec.lang, iteration: spec.iteration, rework: true });
      } else {
        results.push({ redmine_id: redmineId, error: compiled.error || "needs clarification", task_id: compiled.task_id });
      }
    }
  } catch (e: any) {
    console.error(`[task-poller] rework poll failed: ${e?.message ?? e}`);
  }
  return results;
}

async function detectRepo(redmineId: number, issue: any, projects: Record<string, any>): Promise<string | undefined> {
  // 1. Try previous TaskSpec
  const prev = readTaskSpec(`redmine-${redmineId}-${slug(String(issue.subject ?? ""))}`);
  if (prev?.repo && projects[String(prev.repo)]) return String(prev.repo);

  // 2. Try to match repo name in issue text
  const hay = JSON.stringify(issue).toLowerCase();
  const candidates = Object.keys(projects).filter((n) => n.length >= 4 && hay.includes(n.toLowerCase()));
  candidates.sort((a, b) => b.length - a.length);
  return candidates[0];
}

function slug(s: string): string {
  return s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "task";
}

export { slug };
