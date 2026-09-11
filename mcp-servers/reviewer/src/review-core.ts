/**
 * review-core.ts — общая логика ревью (используется MCP-сервером и фоновым run-review.ts).
 */
import { fetch, ProxyAgent, type Dispatcher } from "undici";
import { readFileSync } from "node:fs";

// ─── Config ─────────────────────────────────────────────────────────────────────

const clean = (v?: string): string => {
  const s = (v ?? "").trim();
  return /^\$\{.*\}$/.test(s) ? "" : s;
};

export const GL_BASE  = clean(process.env.GITLAB_BASE_URL).replace(/\/$/, "");
export const GL_TOKEN = clean(process.env.GITLAB_TOKEN);
export const RM_BASE  = clean(process.env.REDMINE_BASE_URL).replace(/\/$/, "");
export const RM_LOGIN = clean(process.env.REDMINE_LOGIN);
export const RM_PASS  = clean(process.env.REDMINE_PASSWORD);
const RM_PROJECT = clean(process.env.REDMINE_PROJECT);
const DI_BASE  = (clean(process.env.DEEPINFRA_BASE_URL) || "https://api.deepinfra.com/v1/openai").replace(/\/$/, "");
export const DI_KEY   = clean(process.env.DEEPINFRA_API_KEY);
export const MODEL    = clean(process.env.REVIEW_MODEL) || clean(process.env.DEEPINFRA_MODEL);
export const PROXY    = clean(process.env.DEEPINFRA_PROXY) || clean(process.env.HTTPS_PROXY) || clean(process.env.HTTP_PROXY);
const PROMPT_PATH = clean(process.env.REVIEW_PROMPT_PATH);

const diDispatcher: Dispatcher | undefined = PROXY ? new ProxyAgent(PROXY) : undefined;

export let REVIEW_PROMPT = "Ты — ревьюер кода. Найди явные баги/мусор; дай вердикт: на доработку или ок.";
if (PROMPT_PATH) {
  try { REVIEW_PROMPT = readFileSync(PROMPT_PATH, "utf-8"); }
  catch (e) { console.error(`[reviewer] не прочитал REVIEW_PROMPT_PATH (${PROMPT_PATH}): ${e}`); }
}

export function checkConfig(): string | null {
  if (!GL_BASE || !GL_TOKEN) return "нужен GITLAB_BASE_URL + GITLAB_TOKEN";
  if (!DI_KEY || !MODEL)     return "нужен DEEPINFRA_API_KEY + REVIEW_MODEL/DEEPINFRA_MODEL";
  return null;
}

// ─── Filters ─────────────────────────────────────────────────────────────────────

const REVIEW_EXT = new Set(["php", "go", "ts", "tsx", "js", "jsx", "vue"]);
const SKIP_SUBSTR = ["/migrations/", ".min.", "package-lock.json", "composer.lock", "yarn.lock", ".lock"];
const MAX_DIFF_CHARS = 120_000;

// ─── Repo registry ───────────────────────────────────────────────────────────────

export const REGISTRY: Array<{ name: string; id: string }> = (clean(process.env.REVIEW_PROJECTS) || "")
  .split(",").map((s) => s.trim()).filter(Boolean)
  .map((s) => { const [name, id] = s.split(":"); return { name: (name || "").trim(), id: (id || "").trim() }; })
  .filter((r) => r.name && r.id);

export const ID_TO_NAME = new Map(REGISTRY.map((r) => [r.id, r.name]));

// ─── HTTP helpers ────────────────────────────────────────────────────────────────

async function timed<T>(ms: number, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try { return await fn(ctrl.signal); }
  finally { clearTimeout(t); }
}

export async function glGet(path: string): Promise<any> {
  return timed(30_000, async (signal) => {
    const res = await fetch(`${GL_BASE}/api/v4${path}`, {
      headers: { "PRIVATE-TOKEN": GL_TOKEN, Accept: "application/json" }, signal,
    });
    if (!res.ok) throw new Error(`GitLab ${res.status} ${res.statusText}: ${(await res.text()).slice(0, 200)}`);
    return res.json();
  });
}

export async function rmGet(path: string, params: Record<string, string> = {}): Promise<any | null> {
  if (!RM_BASE || !RM_LOGIN || !RM_PASS) return null;
  const qs = new URLSearchParams(params).toString();
  const auth = Buffer.from(`${RM_LOGIN}:${RM_PASS}`).toString("base64");
  return timed(20_000, async (signal) => {
    const res = await fetch(`${RM_BASE}${path}${qs ? "?" + qs : ""}`, {
      headers: { Authorization: `Basic ${auth}`, Accept: "application/json" }, signal,
    });
    if (!res.ok) return null;
    return res.json();
  });
}

export async function deepinfraReview(userMsg: string, maxTokens = 2000): Promise<string> {
  return timed(180_000, async (signal) => {
    const res = await fetch(`${DI_BASE}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${DI_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: "system", content: REVIEW_PROMPT }, { role: "user", content: userMsg }],
        max_tokens: maxTokens,
        temperature: 0.2,
      }),
      dispatcher: diDispatcher,
      signal,
    });
    if (!res.ok) throw new Error(`DeepInfra ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const data: any = await res.json();
    return data?.choices?.[0]?.message?.content ?? "(пустой ответ модели)";
  });
}

// ─── Text helpers ────────────────────────────────────────────────────────────────

export function cleanText(s: any): string {
  let t = typeof s === "string" ? s : s == null ? "" : String(s);
  t = t.replace(/data:[^;\s)]*;base64,[A-Za-z0-9+/=\r\n]+/g, "[картинка]");
  t = t.replace(/[A-Za-z0-9+/]{500,}={0,2}/g, "[вложение]");
  return t.replace(/\n{3,}/g, "\n\n").trim();
}

const REWORK_STATUS = 8;
const FAILED_STATUS = 26;

export function countStatusEntries(journals: any[], statusId: number): number {
  let n = 0;
  for (const j of journals ?? []) {
    for (const d of j.details ?? []) {
      if (d.property === "attr" && d.name === "status_id" && Number(d.new_value) === statusId) n++;
    }
  }
  return n;
}

export function annotateDiff(diff: string): string {
  const out: string[] = [];
  let newln = 0;
  for (const line of (diff || "").split("\n")) {
    if (line.startsWith("@@")) {
      const mm = /\+(\d+)/.exec(line);
      newln = mm ? parseInt(mm[1], 10) : 0;
      out.push(line);
    } else if (line.startsWith("\\")) {
      out.push(line);
    } else if (line.startsWith("-")) {
      out.push(`      ${line}`);
    } else {
      out.push(`${String(newln).padStart(5)} ${line}`);
      newln++;
    }
  }
  return out.join("\n");
}

export function keepFile(ch: any): boolean {
  if (ch?.deleted_file) return false;
  const path: string = ch?.new_path || ch?.old_path || "";
  if (SKIP_SUBSTR.some((s) => path.includes(s))) return false;
  const ext = path.includes(".") ? path.split(".").pop()!.toLowerCase() : "";
  if (!REVIEW_EXT.has(ext)) return false;
  return Boolean((ch?.diff || "").trim());
}

// ─── MR resolution ───────────────────────────────────────────────────────────────

function resolveProject(p: string): string {
  if (/^\d+$/.test(p)) return p;
  const byName = REGISTRY.find((r) => r.name === p);
  return byName ? byName.id : p;
}

function parseMrRef(s: string): { project?: string; iid?: number; bareIid?: number } {
  const t = (s || "").trim();
  const url = /https?:\/\/[^\s]+?\/([^\s?#]+?)\/-\/merge_requests\/(\d+)/.exec(t);
  if (url) return { project: url[1], iid: parseInt(url[2], 10) };
  const pi = /^(.+?)[!#](\d+)$/.exec(t);
  if (pi) return { project: pi[1].trim(), iid: parseInt(pi[2], 10) };
  const bare = /^#?(\d+)$/.exec(t);
  if (bare) return { bareIid: parseInt(bare[1], 10) };
  return {};
}

export async function resolveMr(mr: string): Promise<{ project: string; iid: number; info: any | null } | { error: string }> {
  const ref = parseMrRef(mr);
  if (ref.project && ref.iid != null) {
    return { project: resolveProject(ref.project), iid: ref.iid, info: null };
  }
  if (ref.bareIid != null) {
    const hits: Array<{ name: string; id: string; data: any }> = [];
    for (const p of REGISTRY) {
      try { const d = await glGet(`/projects/${p.id}/merge_requests/${ref.bareIid}`); if (d?.iid) hits.push({ ...p, data: d }); }
      catch { /* нет такого MR в этом репо */ }
    }
    if (hits.length === 0) return { error: `MR !${ref.bareIid} не найден ни в одном репо (${REGISTRY.map((r) => r.name).join(", ")}). Дай ссылку на MR или укажи репозиторий.` };
    if (hits.length > 1) return { error: `MR !${ref.bareIid} есть в нескольких репо: ${hits.map((h) => h.name).join(", ")}. Уточни какой (или дай ссылку на MR).` };
    return { project: hits[0].id, iid: ref.bareIid, info: hits[0].data };
  }
  return { error: `Не разобрал ссылку на MR: "${mr}". Дай URL мёрж-реквеста, "репо!номер" или номер.` };
}

// ─── Review assembly ─────────────────────────────────────────────────────────────

export type Assembled = { userMsg: string; kept: number; title: string; taskId?: string; truncated: boolean };

export async function assembleReview(project: string, iid: number, info: any | null): Promise<Assembled | { skip: string }> {
  const pid = encodeURIComponent(project);
  if (!info) {
    try { info = await glGet(`/projects/${pid}/merge_requests/${iid}`); }
    catch (e) { return { skip: `MR ${project}!${iid}: не получить (${(e as Error).message})` }; }
  }
  let changes: any[] = [];
  try {
    const ch = await glGet(`/projects/${pid}/merge_requests/${iid}/changes`);
    changes = ch?.changes ?? [];
  } catch (e) { return { skip: `MR ${project}!${iid}: диф не получить (${(e as Error).message})` }; }

  const kept = changes.filter(keepFile);
  const title = info?.title ?? "";
  const taskId = (/(\d{4,})/.exec(info?.source_branch ?? "") ?? [])[1];
  if (kept.length === 0) {
    return { skip: `MR ${project}!${iid} «${title}»: нет файлов под ревью (из ${changes.length} все отсеяны — не код/шум/удалённые).` };
  }

  const projWeb = (info?.web_url ?? "").split("/-/merge_requests")[0];
  const branch = info?.source_branch ?? "";
  const links: string[] = [];
  let diffText = "";
  let truncated = false;
  for (const c of kept) {
    if (projWeb && branch) links.push(`- ${c.new_path} → ${projWeb}/-/blob/${branch}/${c.new_path}`);
    const block = `\n--- ${c.new_path} ---\n${annotateDiff(c.diff)}`;
    if (diffText.length + block.length > MAX_DIFF_CHARS) { truncated = true; break; }
    diffText += block;
  }

  let taskCtx = "(Redmine-задачу определить не удалось)";
  if (taskId) {
    const issue = await rmGet(`/issues/${taskId}.json`, { include: "journals" });
    const it = issue?.issue;
    if (it) {
      const journals: any[] = it.journals ?? [];
      const notes: string[] = journals.map((j) => j.notes).filter(Boolean);
      const lastNotes = notes.slice(-3).map((n: string) => `  • ${cleanText(n).slice(0, 300)}`).join("\n");
      const rework = countStatusEntries(journals, REWORK_STATUS);
      const failed = countStatusEntries(journals, FAILED_STATUS);
      const histParts = [rework ? `↩ ${rework}× на доработке` : "", failed ? `❌ ${failed}× не прошла тестирование` : ""].filter(Boolean);
      const history = histParts.length ? `\nИстория: ${histParts.join(", ")}` : "";
      taskCtx = `#${taskId} ${it.subject ?? ""}\nСтатус: ${it.status?.name}${history}\n` +
                `Описание: ${cleanText(it.description).slice(0, 1500)}\nПоследние примечания:\n${lastNotes || "  (нет)"}`;
    } else {
      taskCtx = `#${taskId} (Redmine-задача не подтянулась)`;
    }
  }

  const linksBlock = links.length ? `# ССЫЛКИ (для замечаний: <ссылка>#L<строка>)\n${links.join("\n")}\n\n` : "";
  const userMsg =
    `# КОНТЕКСТ ЗАДАЧИ (Redmine)\n${taskCtx}\n\n` +
    `# MERGE REQUEST\n${project}!${iid}: ${title}  ` +
    `[${info?.source_branch} → ${info?.target_branch}]\n\n` +
    linksBlock +
    `# ДИФФ (число слева = номер строки в новом файле)${truncated ? "  ⚠ ОБРЕЗАН по лимиту\n" : "\n"}` +
    "```diff\n" + diffText + "\n```";

  return { userMsg, kept: kept.length, title, taskId, truncated };
}

// ─── Batch helpers ───────────────────────────────────────────────────────────────

export const CODE_REVIEW_STATUS = "13";

export function parseVerdict(text: string): string {
  const m = /🔴|🟡|🟢/.exec(text || "");
  return m ? m[0] : "⚪";
}

export function firstLine(text: string): string {
  const ln = (text || "").split("\n").map((s) => s.trim()).filter(Boolean);
  return ln[0] ? ln[0].replace(/^[🔴🟡🟢⚪⚠]\s*/u, "").slice(0, 180) : "(пустой ответ модели)";
}

export async function mapPool<T, R>(items: T[], n: number, fn: (x: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  const worker = async () => { while (i < items.length) { const c = i++; out[c] = await fn(items[c], c); } };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(n, items.length)) }, worker));
  return out;
}

export async function indexOpenMrs(): Promise<Map<string, { project: string; iid: number; info: any }>> {
  const idx = new Map<string, { project: string; iid: number; info: any }>();
  for (const p of REGISTRY) {
    try {
      const mrs = await glGet(`/projects/${p.id}/merge_requests?state=opened&per_page=100&order_by=updated_at&sort=desc`);
      for (const mr of mrs ?? []) {
        const m = /(\d{4,})/.exec(mr?.source_branch ?? "");
        if (!m) continue;
        if (!idx.has(m[1])) idx.set(m[1], { project: p.id, iid: mr.iid, info: mr });
      }
    } catch { /* репо недоступно */ }
  }
  return idx;
}
