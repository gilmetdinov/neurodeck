// mcp-servers/agent-worker/src/api.ts
// HTTP-клиенты для Redmine и GitLab + Telegram best-effort notify.

import { REDMINE_BASE_URL, REDMINE_API_KEY, REDMINE_LOGIN, REDMINE_PASSWORD, useBasicAuth, GL_BASE_URL, GL_TOKEN, TG_TOKEN, TG_PROXY } from "./config.js";
import { fetch as diFetch, ProxyAgent } from "undici";

const clean = (v?: string): string => { const s = (v ?? "").trim(); return /^\$\{.*\}$/.test(s) ? "" : s; };
const RM_WRITE_LOGIN = clean(process.env.REDMINE_WRITE_LOGIN) || REDMINE_LOGIN;
const RM_WRITE_PASSWORD = clean(process.env.REDMINE_WRITE_PASSWORD) || REDMINE_PASSWORD;
const useWriteBasicAuth = Boolean(RM_WRITE_LOGIN && RM_WRITE_PASSWORD);

function stripTrailingSlash(s: string): string { return s.replace(/\/$/, ""); }

function redmineAuthHeaders(): Record<string, string> {
  const h: Record<string, string> = { Accept: "application/json", "Content-Type": "application/json" };
  if (useBasicAuth) h.Authorization = `Basic ${Buffer.from(`${REDMINE_LOGIN}:${REDMINE_PASSWORD}`).toString("base64")}`;
  else if (REDMINE_API_KEY) h["X-Redmine-API-Key"] = REDMINE_API_KEY;
  return h;
}

function redmineWriteAuthHeaders(): Record<string, string> {
  const h: Record<string, string> = { Accept: "application/json", "Content-Type": "application/json" };
  if (useWriteBasicAuth) h.Authorization = `Basic ${Buffer.from(`${RM_WRITE_LOGIN}:${RM_WRITE_PASSWORD}`).toString("base64")}`;
  else if (REDMINE_API_KEY) h["X-Redmine-API-Key"] = REDMINE_API_KEY;
  return h;
}

export async function redmineGet(path: string, params: Record<string, string> = {}): Promise<any> {
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

export async function redmineUpdateIssue(redmineId: number, statusId?: number, note?: string): Promise<void> {
  const body: any = { issue: {} };
  if (statusId != null) body.issue.status_id = statusId;
  if (note) body.issue.notes = note;
  const url = `${stripTrailingSlash(REDMINE_BASE_URL!)}/issues/${redmineId}.json`;
  const res = await fetch(url, { method: "PUT", headers: redmineWriteAuthHeaders(), body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`Redmine update #${redmineId} → ${statusId}: ${res.status}`);
}

export async function redmineGetIssue(redmineId: number): Promise<any> {
  const data = await redmineGet(`/issues/${redmineId}.json`, { include: "journals" });
  return data.issue;
}

export async function gitlabGet(path: string): Promise<any> {
  if (!GL_BASE_URL || !GL_TOKEN) throw new Error("GITLAB_BASE_URL or GITLAB_TOKEN not set");
  const url = `${stripTrailingSlash(GL_BASE_URL)}/api/v4${path}`;
  const res = await fetch(url, { headers: { "PRIVATE-TOKEN": GL_TOKEN } });
  if (!res.ok) throw new Error(`GitLab ${res.status}: ${await res.text()}`.slice(0, 300));
  return await res.json();
}

export async function gitlabFindMr(projectId: number, branch: string): Promise<any | null> {
  if (!GL_BASE_URL || !GL_TOKEN) return null;
  const path = `/projects/${encodeURIComponent(String(projectId))}/merge_requests?source_branch=${encodeURIComponent(branch)}&state=opened`;
  const mrs = await gitlabGet(path);
  return mrs[0] ?? null;
}

export async function gitlabMrComments(projectId: number, mrIid: number): Promise<string[]> {
  if (!GL_BASE_URL || !GL_TOKEN) return [];
  const path = `/projects/${encodeURIComponent(String(projectId))}/merge_requests/${mrIid}/notes`;
  const notes = await gitlabGet(path);
  return (notes as any[]).filter((n) => !n.system).map((n) => `${n.author?.name ?? "?"}: ${n.body}`).slice(0, 20);
}

export async function notifyTelegram(chatId: string, text: string): Promise<void> {
  if (!TG_TOKEN || !chatId) return;
  try {
    const body = JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" });
    const dispatcher = TG_PROXY ? new ProxyAgent(TG_PROXY) : undefined;
    await diFetch("https://api.telegram.org/bot" + TG_TOKEN + "/sendMessage", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      dispatcher,
    });
  } catch (e: any) {
    console.error(`[agent-worker] telegram notify failed: ${e?.message ?? e}`);
  }
}

export { diFetch };
