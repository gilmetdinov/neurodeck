// mcp-servers/agent-worker/src/analyze.ts
// Двухуровневый анализ задачи перед выполнением (ADR-0028).

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { diFetch } from "./api.js";
import { getProjectsRegistry, getClonePolicy } from "./config.js";

const clean = (v?: string): string => { const s = (v ?? "").trim(); return /^\$\{.*\}$/.test(s) ? "" : s; };
const DI_BASE = clean(process.env.DEEPINFRA_BASE_URL);
const DI_KEY = clean(process.env.DEEPINFRA_API_KEY);
const ANALYZE_MODEL = clean(process.env.ANALYZE_MODEL) || clean(process.env.DEEPINFRA_MODEL) || "deepseek-ai/DeepSeek-V4-Pro";
const PROXY_URL = clean(process.env.PROXY_URL);

function repoLangHint(repo: string): string | null {
  const policy = getClonePolicy();
  return policy?.repo_lang_hints?.[repo] ?? null;
}

export interface AnalyzeResult {
  ok: boolean;
  level: 1 | 2;
  reason?: string;
  questions?: string[];
  warnings?: string[];
}

// Level 1: технический анализ
export async function analyzeTechnical(spec: Record<string, any>, clonePath: string): Promise<AnalyzeResult> {
  const paths = (spec.paths ?? spec.scope_paths ?? []) as string[];
  if (!paths || paths.length === 0) {
    return { ok: true, level: 1, warnings: ["scope_paths пуст — выполнение без ограничения scope"] };
  }

  const missing: string[] = [];
  const existing: string[] = [];
  for (const p of paths) {
    const full = join(clonePath, p);
    if (existsSync(full)) existing.push(p);
    else missing.push(p);
  }

  if (existing.length === 0 && missing.length > 0) {
    return {
      ok: false,
      level: 1,
      reason: `Не найдены указанные scope_paths: ${missing.join(", ")}. Возможно, компилятор ошибся в выборе repo/scope.`,
      questions: [`Уточните правильные пути для scope: ${missing.join(", ")}`],
    };
  }

  const warnings: string[] = [];
  if (missing.length > 0) warnings.push(`Некоторые scope_paths отсутствуют: ${missing.join(", ")}`);

  // Basic check for well-known files (e.g., AGENTS.md)
  if (existsSync(join(clonePath, "AGENTS.md"))) warnings.push("AGENTS.md найден — агент получит проектный контекст");

  return { ok: true, level: 1, warnings };
}

// Level 2: бизнес/RAG-анализ (stub с web-fallback)
export async function analyzeBusiness(spec: Record<string, any>): Promise<AnalyzeResult> {
  const warnings: string[] = [];

  // 1. Keyword heuristics
  const prompt = String(spec.prompt_md ?? "").toLowerCase();
  const riskyKeywords = ["iata", "icao", "авиа", "стандарт", "regulation", "compliance", "fims", "aixm"];
  const hits = riskyKeywords.filter((k) => prompt.includes(k));
  if (hits.length > 0) {
    warnings.push(`Задача содержит регуляторные/авиа-термины: ${hits.join(", ")}. Рекомендуется web-fallback проверка.`);
  }

  // 2. Web-fallback via opencode search (stub)
  if (hits.length > 0 && DI_BASE && DI_KEY) {
    try {
      const query = `IATA aviation standard ${hits.slice(0, 2).join(" ")} ${spec.repo ?? ""}`;
      const result = await runWebSearch(query);
      if (result) warnings.push(`Web-fallback: ${result.slice(0, 200)}`);
    } catch (e: any) {
      warnings.push(`Web-fallback недоступен: ${e?.message ?? e}`);
    }
  }

  // 3. LLM sanity check (optional, cheap)
  if (DI_BASE && DI_KEY) {
    try {
      const sanity = await llmSanityCheck(spec);
      if (!sanity.ok) {
        return { ok: false, level: 2, reason: sanity.reason, questions: sanity.questions };
      }
      if (sanity.warnings) warnings.push(...sanity.warnings);
    } catch { /* ignore LLM failures */ }
  }

  return { ok: true, level: 2, warnings };
}

async function runWebSearch(query: string): Promise<string | null> {
  // Placeholder: in real implementation this might call an opencode search tool or external search API.
  // For now, we just return a marker that web-fallback was considered.
  return `Web search considered for: ${query.slice(0, 100)} (implementation stub)`;
}

async function llmSanityCheck(spec: Record<string, any>): Promise<{ ok: boolean; reason?: string; questions?: string[]; warnings?: string[] }> {
  const messages = [
    { role: "system", content: "Ты — технический аналитик. Оцени выполнимость и целесообразность задачи. Ответь СТРОГО JSON: { ok: boolean, reason?: string, questions?: string[], warnings?: string[] }." },
    { role: "user", content: JSON.stringify({ title: spec.title, prompt_md: String(spec.prompt_md).slice(0, 2000), repo: spec.repo, scope_paths: spec.paths ?? spec.scope_paths }).slice(0, 3000) },
  ];
  const dispatcher = PROXY_URL ? new (await import("undici")).ProxyAgent(PROXY_URL) : undefined;
  const res = await diFetch(`${DI_BASE}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${DI_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: ANALYZE_MODEL, messages, temperature: 0.2, max_tokens: 400, response_format: { type: "json_object" } }),
    dispatcher,
  });
  if (!res.ok) return { ok: true };
  const data = await res.json() as any;
  const content = data?.choices?.[0]?.message?.content;
  try {
    const j = typeof content === "string" ? JSON.parse(content) : content;
    return { ok: j?.ok !== false, reason: j?.reason, questions: j?.questions, warnings: j?.warnings };
  } catch { return { ok: true }; }
}

export function matchesSpecialization(spec: Record<string, any>, specialization: string[]): boolean {
  if (!specialization || specialization.length === 0) return true;
  const repo = String(spec.repo ?? "");
  const lang = String(spec.lang ?? "").toLowerCase() || (repoLangHint(repo) ?? "");
  const specLangs = specialization.map((s) => s.toLowerCase());
  if (specLangs.includes(lang)) return true;
  return false;
}

export function computeEstimatedTime(spec: Record<string, any>): number {
  return Number(spec.estimated_time_min ?? 30);
}
