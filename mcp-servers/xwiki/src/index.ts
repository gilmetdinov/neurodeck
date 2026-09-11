#!/usr/bin/env node
/**
 * XWiki MCP (спек 09) — чтение статей корпоративной Wiki.
 *
 * Тулзы:
 *   xwiki_get_page(space, page, format) — прочитать страницу + ссылки + вложения
 *   xwiki_search(query, space?, limit?) — поиск по Wiki
 *
 * API: REST /xwiki/rest/wikis/{wiki}/spaces/{space}/pages/{page}
 *      GET ?media=json | ?format=html | ?format=markdown
 * Env: XWIKI_BASE_URL, XWIKI_WIKI, XWIKI_LOGIN, XWIKI_PASSWORD, XWIKI_PROXY
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const clean = (v?: string): string => { const s = (v ?? "").trim(); return /^\$\{.*\}$/.test(s) ? "" : s; };

const BASE_URL = clean(process.env.XWIKI_BASE_URL);
if (!BASE_URL) { console.error("[xwiki-mcp] XWIKI_BASE_URL не задан — выхожу"); process.exit(1); }
const WIKI     = clean(process.env.XWIKI_WIKI) || "xwiki";
const LOGIN    = clean(process.env.XWIKI_LOGIN);
const PASSWORD = clean(process.env.XWIKI_PASSWORD);
const PROXY    = clean(process.env.XWIKI_PROXY) || clean(process.env.PROXY_URL);

const ok = (obj: unknown) => ({ content: [{ type: "text" as const, text: typeof obj === "string" ? obj : JSON.stringify(obj, null, 2) }] });

function authHeaders(): Record<string, string> {
  const h: Record<string, string> = { Accept: "application/json" };
  if (LOGIN && PASSWORD) h["Authorization"] = `Basic ${Buffer.from(`${LOGIN}:${PASSWORD}`).toString("base64")}`;
  return h;
}

async function xwiki(path: string, params?: Record<string, string>): Promise<{ status: number; json: any; text: string }> {
  if (!BASE_URL) return { status: 0, json: null, text: "XWIKI_BASE_URL не задан" };
  const qs = params ? "?" + new URLSearchParams(params).toString() : "";
  const url = `${BASE_URL.replace(/\/$/, "")}/rest/wikis/${WIKI}${path}${qs}`;
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 20_000);
  try {
    const opts: any = { method: "GET", headers: authHeaders(), signal: ctrl.signal };
    if (PROXY) { const { ProxyAgent } = await import("undici"); opts.dispatcher = new ProxyAgent(PROXY); }
    const r = await fetch(url, opts);
    const text = await r.text(); let j: any = null; try { j = text ? JSON.parse(text) : null; } catch { /* */ }
    return { status: r.status, json: j, text };
  } finally { clearTimeout(t); }
}

function extractWikiLinks(content: string): { links: { page: string; space: string; url: string }[]; attachments: string[] } {
  const links: { page: string; space: string; url: string }[] = [];
  const attachments: string[] = [];
  const seen = new Set<string>();
  // [[Page Name]] (исключая image: и служебные)
  for (const m of content.matchAll(/\[\[([^\]>]+?)\]\]/g)) {
    const page = m[1].trim();
    if (page.startsWith("image:") || page.startsWith("doc:")) continue;
    if (!seen.has(page)) { seen.add(page); links.push({ page, space: "", url: `${BASE_URL}/bin/view/${page}` }); }
  }
  // [[Title>>Space.Page]]
  for (const m of content.matchAll(/\[\[[^\]>>]+?>>([^\]]+?)\]\]/g)) {
    const ref = m[1].trim();
    const [space, page] = ref.includes(".") ? ref.split(".") : ["", ref];
    if (!seen.has(ref)) { seen.add(ref); links.push({ page: page || ref, space, url: `${BASE_URL}/bin/view/${space ? space + "/" : ""}${page || ref}` }); }
  }
  // doc:Space.Page (поддержка кириллицы и любых символов кроме ]
  for (const m of content.matchAll(/doc:([^\s\]]+)/g)) {
    const ref = m[1];
    const [space, page] = ref.includes(".") ? ref.split(".") : ["", ref];
    if (!seen.has(ref)) { seen.add(ref); links.push({ page: page || ref, space, url: `${BASE_URL}/bin/view/${space ? space + "/" : ""}${page || ref}` }); }
  }
  // [[image:attachment.png]]
  for (const m of content.matchAll(/\[\[image:([^\]]+?)\]\]/g)) {
    attachments.push(m[1].trim());
  }
  return { links, attachments };
}

function formatPage(data: any, format: string): { title: string; content: string; links: any[]; attachments: string[]; author: string; updated: string; url: string } {
  const title = data.title || data.name || "?";
  const content = data.content || "";
  const { links, attachments } = extractWikiLinks(content);
  const author = data.author ? (data.author.name || data.author) : "?";
  const updated = data.modified || data.date || "";
  const space = data.space || "";
  const page = data.page || title;
  const url = `${BASE_URL}/bin/view/${space ? space + "/" : ""}${page}`;
  // Формат контента управляется API-параметром ?format= (html/markdown),
  // data.content уже содержит отрендеренный результат.
  return { title, content, links, attachments, author, updated, url };
}

async function _getPage(args: { space: string; page: string; format: "markdown" | "html" | "structured" }): Promise<ReturnType<typeof ok>> {
  if (!BASE_URL) return ok({ error: "XWIKI_BASE_URL не задан" });
  const path = `/spaces/${encodeURIComponent(args.space)}/pages/${encodeURIComponent(args.page)}`;
  const params: Record<string, string> = { media: "json" };
  if (args.format === "html") params.format = "html";
  if (args.format === "markdown") params.format = "markdown";
  const r = await xwiki(path, params);
  if (r.status === 401) return ok({ error: "Ошибка аутентификации XWiki: проверь XWIKI_LOGIN/XWIKI_PASSWORD" });
  if (r.status !== 200) return ok({ error: `XWiki ${r.status}: ${r.text.slice(0, 300)}` });
  if (!r.json) return ok({ error: "XWiki API вернул пустой ответ (не JSON)" });
  return ok(formatPage(r.json, args.format));
}

async function _search(args: { query: string; space?: string; limit?: number }): Promise<ReturnType<typeof ok>> {
  if (!BASE_URL) return ok({ error: "XWIKI_BASE_URL не задан" });
  const params: Record<string, string> = { q: args.query, media: "json", limit: String(args.limit ?? 10) };
  if (args.space) params.space = args.space;
  const r = await xwiki("/search", params);
  if (r.status !== 200) return ok({ error: `XWiki ${r.status}: ${r.text.slice(0, 300)}` });
  const results = ((r.json?.searchResults ?? r.json?.results ?? []) as any[]).slice(0, args.limit ?? 10).map((x: any) => ({
    title: x.title || x.name || "?",
    space: x.space || "",
    url: `${BASE_URL}/bin/view/${x.space ? x.space + "/" : ""}${x.page || x.name || ""}`,
    excerpt: (x.excerpt || x.highlight || "").slice(0, 300),
    score: x.score || 0,
  }));
  return ok({ query: args.query, space: args.space, count: results.length, results });
}

const server = new McpServer({ name: "xwiki-mcp", version: "0.1.0" });

(server as any).tool("xwiki_get_page", "Прочитать страницу XWiki: заголовок, контент, внутренние ссылки, вложения, автор, дата изменения.", {
  space: z.string().describe("например neurodeck"),
  page: z.string().describe("например 'Стандарты разработки'"),
  format: z.enum(["markdown", "html", "structured"]).optional().describe("формат контента"),
}, _getPage);

(server as any).tool("xwiki_search", "Поиск по XWiki.", {
  query: z.string(),
  space: z.string().optional(),
  limit: z.number().optional(),
}, _search);

console.error(`[xwiki-mcp] v0.1.0 (base=${BASE_URL || "NOT SET"}, wiki=${WIKI}, proxy=${PROXY ? "on" : "off"})`);
await server.connect(new StdioServerTransport());
