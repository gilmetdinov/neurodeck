// mcp-servers/task-poller/src/compiler.ts
// compile_task + task_estimate — напрямую через LLM, без оркестратора (ADR-0028).
// Использует промпт из prompts/task-compiler.md и эвристику/LLM из task_estimate.

import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { fetch as diFetch, ProxyAgent } from "undici";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const JSON5 = require("json5");

const clean = (v?: string): string => { const s = (v ?? "").trim(); return /^\$\{.*\}$/.test(s) ? "" : s; };

const ROOT = (() => {
  const env = clean(process.env.AGENT_REPO_ROOT);
  if (env) return env;
  try { return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", ".."); }
  catch { return process.cwd(); }
})();

const REDMINE_BASE_URL = clean(process.env.REDMINE_BASE_URL);
const REDMINE_API_KEY  = clean(process.env.REDMINE_API_KEY);
const REDMINE_LOGIN    = clean(process.env.REDMINE_LOGIN);
const REDMINE_PASSWORD = clean(process.env.REDMINE_PASSWORD);
const useBasicAuth     = Boolean(REDMINE_LOGIN && REDMINE_PASSWORD);

const LLM_BASE          = clean(process.env.LLM_BASE_URL);
const LLM_KEY           = clean(process.env.LLM_API_KEY);
const COMPILER_MODEL   = clean(process.env.COMPILER_MODEL) || clean(process.env.REDMINE_ANALYST_MODEL) || clean(process.env.LLM_MODEL) || "deepseek-ai/DeepSeek-V4-Pro";
const COMPILER_TEMP    = Number(clean(process.env.COMPILER_TEMPERATURE) || "0.3");
const COMPILER_PROMPT_PATH = clean(process.env.COMPILER_PROMPT_PATH) || join(ROOT, "prompts", "task-compiler.md");

const QUEUE_DIR      = clean(process.env.TASK_QUEUE_DIR) || join(ROOT, "workspace", "state", "task-queue");
const REGISTRY_PATH  = clean(process.env.PROJECTS_REGISTRY) || join(ROOT, "config", "projects.json5");
const DAG_PATH       = clean(process.env.HARNESS_DAG_PATH) || join(ROOT, "harness", "docs", "h1-module-dag.md");

const PROXY_URL = clean(process.env.PROXY_URL) || clean(process.env.LLM_PROXY) || clean(process.env.HTTPS_PROXY);
const diDispatcher = PROXY_URL ? new ProxyAgent(PROXY_URL) : undefined;

let COMPILER_PROMPT: string;
try { COMPILER_PROMPT = readFileSync(COMPILER_PROMPT_PATH, "utf-8"); }
catch { COMPILER_PROMPT = "Ты — компилятор Redmine-задачи в черновик TaskSpec для harness. Верни СТРОГО один JSON-объект по схеме из инструкции."; }

const REDMINE_WRITE_LOGIN = clean(process.env.REDMINE_WRITE_LOGIN) || REDMINE_LOGIN;
const REDMINE_WRITE_PASSWORD = clean(process.env.REDMINE_WRITE_PASSWORD) || REDMINE_PASSWORD;
const useWriteBasicAuth = Boolean(REDMINE_WRITE_LOGIN && REDMINE_WRITE_PASSWORD);

function redmineAuthHeaders(): Record<string, string> {
  const h: Record<string, string> = { Accept: "application/json" };
  if (useBasicAuth) h.Authorization = `Basic ${Buffer.from(`${REDMINE_LOGIN}:${REDMINE_PASSWORD}`).toString("base64")}`;
  else if (REDMINE_API_KEY) h["X-Redmine-API-Key"] = REDMINE_API_KEY;
  return h;
}

function redmineWriteAuthHeaders(): Record<string, string> {
  const h: Record<string, string> = { Accept: "application/json" };
  if (useWriteBasicAuth) h.Authorization = `Basic ${Buffer.from(`${REDMINE_WRITE_LOGIN}:${REDMINE_WRITE_PASSWORD}`).toString("base64")}`;
  else if (REDMINE_API_KEY) h["X-Redmine-API-Key"] = REDMINE_API_KEY;
  return h;
}

async function redmineGet(path: string, params: Record<string, string> = {}): Promise<any> {
  const qs = new URLSearchParams(params).toString();
  const url = `${stripTrailingSlash(REDMINE_BASE_URL!)}${path}${qs ? "?" + qs : ""}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15_000);
  try {
    const res = await fetch(url, { headers: redmineAuthHeaders(), signal: ctrl.signal });
    if (!res.ok) throw new Error(`Redmine ${res.status}: ${await res.text()}`.slice(0, 300));
    return await res.json();
  } finally { clearTimeout(timer); }
}

async function redmineIssueDetail(id: number): Promise<any> {
  const data = await redmineGet(`/issues/${id}.json`, { include: "journals" });
  return data.issue;
}

async function diChat(messages: unknown[], maxTokens = 4000, temperature = COMPILER_TEMP): Promise<string> {
  if (!LLM_BASE || !LLM_KEY) throw new Error("LLM_BASE_URL / LLM_API_KEY not set");
  const res = await diFetch(`${LLM_BASE}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${LLM_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: COMPILER_MODEL, messages, temperature, max_tokens: maxTokens }),
    dispatcher: diDispatcher,
  });
  if (!res.ok) throw new Error(`LLM ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = (await res.json()) as any;
  return (data?.choices?.[0]?.message?.content as string) || "";
}

function extractJson(text: string): any | null {
  if (!text) return null;
  const t = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
  const start = t.indexOf("{");
  if (start < 0) { try { return JSON.parse(t); } catch { return null; } }
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < t.length; i++) {
    const c = t[i];
    if (inStr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}") { if (--depth === 0) { try { return JSON.parse(t.slice(start, i + 1)); } catch { return null; } } }
  }
  return null;
}

const kebab = (s: string): string => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "task";

type RepoReg = { repoPath: string; scopeMode: string; target: boolean; models?: Record<string, string> };

export function loadRegistry(): { baseDir: string; repos: Record<string, RepoReg>; workRoots: string[]; workRootScope: string; models: Record<string, string> } {
  const raw = JSON5.parse(readFileSync(REGISTRY_PATH, "utf-8")) as any;
  const dh = raw?.defaults?.harness ?? {};
  const repos: Record<string, RepoReg> = {};
  for (const [name, p] of Object.entries<any>(raw?.projects ?? {})) {
    const h = p?.harness ?? {};
    repos[name] = {
      repoPath: String(p?.repoPath ?? ""),
      scopeMode: String(h.scopeMode ?? dh.scopeMode ?? "files"),
      target: Boolean(h.target ?? dh.target ?? false),
      models: { ...(dh.models ?? {}), ...(h.models ?? {}) },
    };
  }
  return {
    baseDir: clean(process.env.AGENT_WORKBENCH_DIR) || String(raw?.baseDir ?? ""),
    repos,
    workRoots: Array.isArray(dh.workRoots) ? dh.workRoots.map(String) : [],
    workRootScope: String(dh.workRootScope ?? "full"),
    models: dh.models ?? {},
  };
}

export function discoverWorkRootRepos(reg: { baseDir: string; workRoots: string[]; workRootScope: string; models: Record<string, string> }): Record<string, RepoReg> {
  const out: Record<string, RepoReg> = {};
  for (const root of reg.workRoots) {
    const rootPath = join(reg.baseDir, root);
    let names: string[] = [];
    try { names = readdirSync(rootPath, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith(".")).map((d) => d.name); } catch { continue; }
    for (const name of names) {
      if (out[name]) continue;
      out[name] = { repoPath: join(rootPath, name), scopeMode: reg.workRootScope, target: true, models: reg.models };
    }
  }
  return out;
}

function listTopLevel(repoPath: string): string[] {
  try {
    return readdirSync(repoPath, { withFileTypes: true })
      .filter((d) => !d.name.startsWith(".") && d.name !== "vendor" && d.name !== "node_modules")
      .map((d) => (d.isDirectory() ? d.name + "/" : d.name))
      .sort().slice(0, 40);
  } catch { return []; }
}

function loadDagExcerpt(maxChars = 6000): string {
  try { return readFileSync(DAG_PATH, "utf-8").slice(0, maxChars); } catch { return ""; }
}

export function buildTaskSpec(draft: any, redmineId: number, allRepos: Record<string, RepoReg>, input?: { repo?: string; category?: string; model?: string }): Record<string, any> {
  const repoKey = (draft.repo && allRepos[draft.repo]) ? draft.repo : "";
  const entry = allRepos[repoKey];
  const lang = String(draft.lang ?? "").toLowerCase() || repoLangHint(repoKey) || "?";
  const rawId = String(draft.id ?? "").trim();
  const safeId = rawId && /^[a-z0-9][a-z0-9-]*$/i.test(rawId) ? rawId.toLowerCase() : `redmine-${redmineId}-${kebab(String(draft.title ?? ""))}`;
  const sources: string[] = [];
  for (const s of (draft.source_repos ?? []) as string[]) { const r = allRepos[s]; if (r?.repoPath) sources.push(r.repoPath); }

  return {
    id: safeId,
    title: String(draft.title ?? "").slice(0, 120),
    redmine_id: redmineId,
    repo: repoKey || "(не в реестре)",
    target: entry?.repoPath ?? "",
    lang,
    scope_paths: draft.scope_paths ?? [],
    sources: [...new Set(sources)],
    prompt_md: String(draft.prompt_md ?? "").trim(),
    rationale: draft.rationale ?? "",
    harness_target_allowed: Boolean(entry?.target),
    append_system_prompt_path: "harness/tasks/guardrails-product.md",
    suggested_category: input?.category ?? draft.category ?? "medium",
    suggested_model: input?.model || draft.suggested_model || null,
    estimated: false,
    compiled_at: new Date().toISOString(),
  };
}

function repoLangHint(repo: string): string | null {
  const hints: Record<string, string> = {
    <main-project>: "php", <variant-a>: "php", <variant-b>: "php", <variant-c>: "php",
    "<dev-staging>": "php", "<personal-monorepo>": "ts", "<greenfield-project>": "ts", "<sandbox-project>": "php", "<service-a>": "go", "<service-b>": "go",
  };
  return hints[repo] || null;
}

export function estimateHeuristic(taskSpec: Record<string, any>, mode = "manual"): Record<string, any> {
  const promptMd = String(taskSpec.prompt_md ?? "");
  const promptLen = promptMd.length;
  const scopePaths = (taskSpec.scope_paths as string[]) ?? [];
  const lang = String(taskSpec.lang ?? "");
  const promptLow = promptMd.toLowerCase();
  const hasFigma = promptLow.includes("figma") || promptLow.includes("макет") || promptLow.includes("вёрстк");
  const hasMigrations = promptLow.includes("миграци") || promptLow.includes("schema") || promptLow.includes("бд") || promptLow.includes("баз данных");
  const stepCount = (promptMd.match(/^\d+\./gm)?.length ?? 0);

  let score = 0;
  score += Math.min(promptLen / 100, 40);
  score += Math.min(scopePaths.length * 8, 24);
  score += hasFigma ? 12 : 0;
  score += hasMigrations ? 10 : 0;
  score += Math.min(stepCount * 3, 20);
  score += lang === "php" ? 8 : 0;
  score = Math.round(score);

  const suggested = String(taskSpec.suggested_model ?? "");
  let model: string, budget: number, attempts: number, tier: string;
  switch (mode) {
    case "cheap": model = "minimax-m3"; budget = 3; attempts = 1; tier = "weak"; break;
    case "manual":
      if (score < 30) { model = "minimax-m3"; budget = 3; attempts = 1; tier = "weak"; }
      else if (score < 60) { model = "deepseek-v4-pro"; budget = 6; attempts = 1; tier = "weak"; }
      else { model = "deepseek-v4-pro"; budget = 10; attempts = 2; tier = "strong"; }
      break;
    case "autonomous":
      if (score < 30) { model = "kimi-k2.7-code"; budget = 5; attempts = 3; tier = "strong"; }
      else if (score < 60) { model = "deepseek-v4-pro"; budget = 12; attempts = 3; tier = "strong"; }
      else { model = "deepseek-v4-pro"; budget = 18; attempts = 5; tier = "strong"; }
      break;
    case "thorough": model = "glm-5.2"; budget = 20; attempts = 5; tier = "strong"; break;
    default: model = "deepseek-v4-pro"; budget = 10; attempts = 2; tier = "strong";
  }
  if (suggested && !["manual", "cheap"].includes(mode)) model = suggested;
  const prefix = "opencode-go/";
  if (model && !model.includes("/")) model = prefix + model;

  return {
    model,
    maxBudgetUsd: budget,
    maxAttempts: attempts,
    tier,
    estimation_mode: mode,
    estimation_score: score,
    estimation_rationale: [
      `Сложность: ${score}/100`, `prompt=${promptLen}с, scope_paths=${scopePaths.length}, шагов=${stepCount}`,
      hasFigma ? "figma" : "", hasMigrations ? "migrations" : "", lang ? `lang=${lang}` : "", `mode=${mode}`,
    ].filter(Boolean).join("; "),
    estimated_time_min: score < 30 ? 15 : score < 60 ? 45 : 90,
  };
}

async function estimateLLM(taskSpec: Record<string, any>, mode = "manual"): Promise<Record<string, any>> {
  if (!LLM_BASE || !LLM_KEY) return estimateHeuristic(taskSpec, mode);
  try {
    const messages = [
      { role: "system", content: "Ты — оценщик задач для AI-агента. Оцени сложность TaskSpec и предложи модель/бюджет/попытки. Режим: " + mode + ". Ответь СТРОГО JSON: { model, maxBudgetUsd, maxAttempts, tier, score, rationale, estimated_time_min }." },
      { role: "user", content: JSON.stringify({ mode, prompt_md: (taskSpec.prompt_md as string)?.slice(0, 3000), lang: taskSpec.lang, scope_paths: taskSpec.scope_paths, suggested_model: taskSpec.suggested_model }).slice(0, 4000) },
    ];
    const res = await diFetch(`${LLM_BASE}/chat/completions`, {
      method: "POST", headers: { Authorization: `Bearer ${LLM_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: COMPILER_MODEL, messages, temperature: 0.2, max_tokens: 400, response_format: { type: "json_object" } }),
      dispatcher: diDispatcher,
    });
    if (!res.ok) throw new Error(`LLM ${res.status}`);
    const data = await res.json() as any;
    const content = data?.choices?.[0]?.message?.content;
    const j = typeof content === "string" ? (() => { try { return JSON.parse(content); } catch { return null; } })() : content;
    if (j && j.model) {
      if (!String(j.model).includes("/")) j.model = "opencode-go/" + j.model;
      return { ...j, estimation_mode: mode, estimation_llm: COMPILER_MODEL, estimated_time_min: j.estimated_time_min ?? (j.score < 30 ? 15 : j.score < 60 ? 45 : 90) };
    }
  } catch (e: any) { console.error(`[task-poller] estimate LLM: ${e?.message ?? e}`); }
  return estimateHeuristic(taskSpec, mode);
}

export async function estimateTask(taskSpec: Record<string, any>, mode = "manual", useLLM = false, overrides?: { model?: string; budget?: number; attempts?: number }): Promise<Record<string, any>> {
  const estimation = useLLM ? await estimateLLM(taskSpec, mode) : estimateHeuristic(taskSpec, mode);
  if (overrides?.model) estimation.model = overrides.model;
  if (overrides?.budget != null) estimation.maxBudgetUsd = overrides.budget;
  if (overrides?.attempts != null) estimation.maxAttempts = overrides.attempts;
  return {
    ...taskSpec,
    ...estimation,
    estimated: true,
    estimated_at: new Date().toISOString(),
  };
}

export interface CompileResult {
  task_id: string;
  redmine_id: number;
  task_spec?: Record<string, any>;
  needs_clarification?: boolean;
  questions?: string[];
  rationale?: string;
  error?: string;
  raw?: string;
  saved?: boolean;
  spec_path?: string;
  prompt_path?: string;
}

export async function compileTask(redmineId: number, input?: { repo?: string; category?: string; model?: string; extra?: string; reworkContext?: string }): Promise<CompileResult> {
  if (!LLM_BASE || !LLM_KEY || !COMPILER_MODEL) {
    return { redmine_id: redmineId, task_id: "", error: "task-poller: LLM_BASE_URL / LLM_API_KEY / COMPILER_MODEL not set" };
  }

  let issue: any;
  try { issue = await redmineIssueDetail(redmineId); }
  catch (e) { return { redmine_id: redmineId, task_id: "", error: `Redmine fetch failed: ${String((e as Error)?.message ?? e).slice(0, 200)}` }; }

  let reg: any;
  try { reg = loadRegistry(); }
  catch (e) { return { redmine_id: redmineId, task_id: "", error: `Registry read failed: ${String((e as Error)?.message ?? e).slice(0, 200)}` }; }

  const allRepos: Record<string, RepoReg> = { ...discoverWorkRootRepos(reg), ...reg.repos };
  delete allRepos["<personal-monorepo>"];

  const hay = (JSON.stringify(issue) + " " + (input?.repo ?? "") + " " + (input?.extra ?? "")).toLowerCase();
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const likely = new Set(Object.keys(allRepos).filter((n) => n.length >= 4 && new RegExp(`\\b${esc(n.toLowerCase())}\\b`).test(hay)).sort((a, b) => b.length - a.length).slice(0, 6));
  const candidates: Record<string, any> = {};
  for (const [name, r] of Object.entries(allRepos)) candidates[name] = { path: r.repoPath, scopeMode: r.scopeMode, ...(likely.has(name) ? { top_level: listTopLevel(r.repoPath) } : {}) };

  const dag = loadDagExcerpt();
  const userPayload = {
    issue,
    hints: { repo: input?.repo ?? null, category: input?.category ?? null, model: input?.model ?? null, extra: input?.extra ?? null, rework_context: input?.reworkContext ?? null },
    registry: candidates,
    module_dag_excerpt: dag || null,
    note_for_model: "registry = допущенные target-репо. top_level дан только для вероятных. <personal-monorepo> исключён. Выбери repo по задаче; нет подходящего → needs_clarification.",
  };
  const messages = [
    { role: "system", content: COMPILER_PROMPT },
    { role: "user", content: "Скомпилируй задачу в черновик TaskSpec. Верни СТРОГО один JSON-объект.\n\n" + JSON.stringify(userPayload).slice(0, 24000) },
  ];

  let content = "";
  try { content = await diChat(messages); }
  catch (e) { return { redmine_id: redmineId, task_id: "", error: `LLM compiler failed: ${String((e as Error)?.message ?? e).slice(0, 200)}` }; }

  const draft = extractJson(content);
  if (!draft) return { redmine_id: redmineId, task_id: "", error: "compiler did not return valid JSON", raw: content.slice(0, 800) };

  if (draft.needs_clarification) {
    return { redmine_id: redmineId, task_id: "", needs_clarification: true, questions: draft.clarification_questions ?? [], rationale: draft.rationale ?? "" };
  }

  const spec = buildTaskSpec(draft, redmineId, allRepos, input);
  return { redmine_id: redmineId, task_id: spec.id as string, task_spec: spec };
}

export function saveTaskSpecToQueue(spec: Record<string, any>): { spec_path: string; prompt_path: string } {
  const safeId = spec.id as string;
  const promptMd = (spec.prompt_md as string) || "";
  const specPath = join(QUEUE_DIR, `${safeId}.json`);
  const promptPath = join(QUEUE_DIR, `${safeId}.prompt.md`);

  const out: Record<string, any> = {
    id: safeId,
    redmine_id: spec.redmine_id,
    target: spec.target,
    scopeMode: spec.harness_target_allowed ? "files" : "full",
    paths: spec.scope_paths ?? [],
    sources: spec.sources ?? [],
    model: spec.model,
    maxBudgetUsd: spec.maxBudgetUsd,
    maxAttempts: spec.maxAttempts,
    promptPath: `workspace/state/task-queue/${safeId}.prompt.md`,
    appendSystemPromptPath: spec.append_system_prompt_path,
    tier: spec.tier || undefined,
    estimated: spec.estimated ?? false,
    estimated_at: spec.estimated_at,
    estimation_score: spec.estimation_score,
    estimation_rationale: spec.estimation_rationale,
    estimated_time_min: spec.estimated_time_min,
    repo: spec.repo,
    lang: spec.lang,
    compiled_at: spec.compiled_at,
    iteration: spec.iteration ?? 0,
    rework_context: spec.rework_context ?? undefined,
  };

  mkdirSync(QUEUE_DIR, { recursive: true });
  writeFileSync(specPath, JSON.stringify(out, null, 2));
  writeFileSync(promptPath, promptMd + "\n");
  return { spec_path: specPath, prompt_path: promptPath };
}

// Also export a reusable wrapper for compiling and estimating in one go.
export async function compileAndEstimate(redmineId: number, options?: { repo?: string; category?: string; model?: string; extra?: string; mode?: string; useLLM?: boolean; reworkContext?: string }): Promise<CompileResult> {
  const compiled = await compileTask(redmineId, options);
  if (compiled.error || compiled.needs_clarification || !compiled.task_spec) return compiled;
  const estimated = await estimateTask(compiled.task_spec, options?.mode ?? "manual", options?.useLLM ?? false, options?.model ? { model: options.model } : undefined);
  const saved = saveTaskSpecToQueue(estimated);
  return { ...compiled, task_spec: estimated, saved: true, ...saved };
}

export async function listRedmineIssuesByStatus(statusId: number, assignedToId?: number): Promise<any[]> {
  const params: Record<string, string> = { status_id: String(statusId), sort: "updated_on:desc", limit: "100" };
  if (assignedToId) params.assigned_to_id = String(assignedToId);
  const data = await redmineGet("/issues.json", params);
  return (data.issues ?? []) as any[];
}

export async function fetchGitLabMrComments(projectId: number, mrIid: number, token: string, baseUrl: string): Promise<string[]> {
  const url = `${stripTrailingSlash(baseUrl)}/api/v4/projects/${projectId}/merge_requests/${mrIid}/notes`;
  const res = await fetch(url, { headers: { "PRIVATE-TOKEN": token } });
  if (!res.ok) return [];
  const notes = await res.json() as any[];
  return notes.filter((n) => !n.system).map((n) => `${n.author?.name ?? "?"}: ${n.body}`).slice(0, 20);
}

export async function findGitLabMrForBranch(projectId: number, branch: string, token: string, baseUrl: string): Promise<{ iid: number; source_branch: string } | null> {
  const url = `${stripTrailingSlash(baseUrl)}/api/v4/projects/${projectId}/merge_requests?source_branch=${encodeURIComponent(branch)}&state=opened`;
  const res = await fetch(url, { headers: { "PRIVATE-TOKEN": token } });
  if (!res.ok) return null;
  const mrs = await res.json() as any[];
  return mrs[0] ? { iid: mrs[0].iid, source_branch: mrs[0].source_branch } : null;
}

export async function findGitLabMrBySourceBranch(projectId: number, branch: string, token: string, baseUrl: string): Promise<{ iid: number; source_branch: string } | null> {
  return findGitLabMrForBranch(projectId, branch, token, baseUrl);
}

export async function findMrForTask(redmineId: number, projectId: number | null, token: string, baseUrl: string): Promise<{ iid: number; source_branch: string } | null> {
  if (!projectId || !token) return null;
  const branch = `#${redmineId}`;
  return findGitLabMrBySourceBranch(projectId, branch, token, baseUrl);
}

function stripTrailingSlash(s: string): string { return s.replace(/\/$/, ""); }

export async function updateRedmineStatus(redmineId: number, statusId: number, note?: string): Promise<void> {
  const body: any = { issue: { status_id: statusId } };
  if (note) body.issue.notes = note;
  const url = `${stripTrailingSlash(REDMINE_BASE_URL!)}/issues/${redmineId}.json`;
  const res = await fetch(url, {
    method: "PUT",
    headers: { ...redmineWriteAuthHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Redmine update ${redmineId} → ${statusId}: ${res.status}`);
}

export async function addRedmineNote(redmineId: number, note: string): Promise<void> {
  const url = `${stripTrailingSlash(REDMINE_BASE_URL!)}/issues/${redmineId}.json`;
  const res = await fetch(url, {
    method: "PUT",
    headers: { ...redmineWriteAuthHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ issue: { notes: note } }),
  });
  if (!res.ok) throw new Error(`Redmine note ${redmineId}: ${res.status}`);
}

export function emitEvent(type: string, taskId: string, redmineId: number, payload?: Record<string, any>): string {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const file = join(ROOT, "workspace", "state", "events", `${ts}-${type}-${taskId}.json`);
  const event = { type, task_id: taskId, redmine_id: redmineId, timestamp: new Date().toISOString(), payload: payload ?? {} };
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(event, null, 2));
  return file;
}

export function isTaskAlreadyQueued(taskId: string): boolean {
  return existsSync(join(QUEUE_DIR, `${taskId}.json`)) || existsSync(join(QUEUE_DIR, `${taskId}.claimed`));
}

export function isTaskArchived(taskId: string): boolean {
  return existsSync(join(ROOT, "workspace", "state", "archive", `${taskId}.json`));
}

export function resolveStatusId(name: string): number {
  // Dynamic resolve: query Redmine statuses. For simplicity, fallback to known IDs.
  const map: Record<string, number> = {
    "На исполнение": 20, "В работе": 2, "Code review": 13, "На уточнении": 14,
    "Исполнено": 27, "На доработке": 8,
  };
  return map[name] ?? 14;
}

// Check if redmine_id was recently compiled (anti-duplicate, prevents recompilation storm)
export function wasRecentlyCompiled(redmineId: number, maxAgeMs = 30 * 60 * 1000): boolean {
  const files = readdirSync(QUEUE_DIR).filter((f) => f.endsWith(".json"));
  for (const f of files) {
    try {
      const spec = JSON.parse(readFileSync(join(QUEUE_DIR, f), "utf-8"));
      if (Number(spec.redmine_id) === redmineId) {
        const compiledAt = spec.compiled_at ? new Date(spec.compiled_at).getTime() : 0;
        return Date.now() - compiledAt < maxAgeMs;
      }
    } catch {}
  }
  return false;
}

export { QUEUE_DIR, REGISTRY_PATH, REDMINE_BASE_URL, REDMINE_API_KEY, REDMINE_LOGIN, REDMINE_PASSWORD, useBasicAuth };
