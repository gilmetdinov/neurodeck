#!/usr/bin/env node
/**
 * Obsidian Vault MCP (спек 10) — файловый MCP для графовой базы знаний.
 *
 * Тулзы:
 *   obsidian_read(path) — читать .md файл + список [[wikilinks]]
 *   obsidian_search(query, limit) — полнотекстовый поиск
 *   obsidian_links(path, direction) — исходящие/входящие/both
 *   obsidian_write(path, content, mode) — за approval-гейтом
 *
 * Env: OBSIDIAN_VAULT_PATH
 * Безопасность: path не должен выходить за пределы vault (../ запрещены).
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join, resolve, relative, dirname, basename } from "node:path";
import { z } from "zod";

const clean = (v?: string): string => { const s = (v ?? "").trim(); return /^\$\{.*\}$/.test(s) ? "" : s; };

const VAULT = clean(process.env.OBSIDIAN_VAULT_PATH);

const ok = (obj: unknown) => ({ content: [{ type: "text" as const, text: typeof obj === "string" ? obj : JSON.stringify(obj, null, 2) }] });

function safeVaultPath(input: string): string {
  if (!VAULT) throw new Error("OBSIDIAN_VAULT_PATH не задан");
  // Запретить явный выход за пределы vault
  if (input.includes("..") || input.startsWith("/")) throw new Error(`путь запрещён: ${input}`);
  const resolved = resolve(join(VAULT, input));
  const rel = relative(VAULT, resolved);
  if (rel.startsWith("..") || rel.startsWith("/")) throw new Error(`путь вне vault: ${input}`);
  return resolved;
}
function mdPath(input: string): string {
  const p = safeVaultPath(input);
  return p.endsWith(".md") ? p : p + ".md";
}

function extractWikiLinks(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of text.matchAll(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g)) {
    const link = m[1].trim();
    if (!seen.has(link)) { seen.add(link); out.push(link); }
  }
  return out;
}

function allMdFiles(): string[] {
  if (!VAULT) return [];
  const out: string[] = [];
  function walk(dir: string) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory() && !entry.name.startsWith(".")) walk(p);
      else if (entry.isFile() && entry.name.endsWith(".md")) out.push(p);
    }
  }
  walk(VAULT);
  return out;
}

function readMd(input: string): { path: string; title: string; content: string; wikilinks: string[]; updated: string; url: string } {
  const p = mdPath(input);
  if (!existsSync(p)) throw new Error(`файл не найден: ${input}`);
  const text = readFileSync(p, "utf8");
  const title = (text.match(/^#\s+(.+)$/m)?.[1] ?? basename(p, ".md")).trim();
  return {
    path: input,
    title,
    content: text,
    wikilinks: extractWikiLinks(text),
    updated: statSync(p).mtime.toISOString(),
    url: `obsidian://open?vault=${encodeURIComponent(basename(VAULT!))}&file=${encodeURIComponent(input)}`,
  };
}

const server = new McpServer({ name: "obsidian-mcp", version: "0.1.0" });

(server as any).tool("obsidian_read", "Прочитать .md файл из Obsidian vault. Возвращает title, content, [[wikilinks]], дату изменения. Path — относительно корня vault, без .md", {
  path: z.string(),
}, async ({ path }: { path: string }) => {
  try { return ok(readMd(path)); } catch (e: any) { return ok({ error: e?.message ?? String(e) }); }
});

(server as any).tool("obsidian_search", "Полнотекстовый поиск по Obsidian vault.", {
  query: z.string(),
  limit: z.number().optional(),
}, async ({ query, limit }: { query: string; limit?: number }) => {
  if (!VAULT) return ok({ error: "OBSIDIAN_VAULT_PATH не задан" });
  const q = query.toLowerCase();
  const files = allMdFiles();
  const results: { path: string; title: string; snippet: string; updated: string }[] = [];
  for (const f of files) {
    const text = readFileSync(f, "utf8");
    if (!text.toLowerCase().includes(q)) continue;
    const idx = text.toLowerCase().indexOf(q);
    const snippet = text.slice(Math.max(0, idx - 100), idx + 200);
    const title = (text.match(/^#\s+(.+)$/m)?.[1] ?? basename(f, ".md")).trim();
    const rel = relative(VAULT, f).replace(/\.md$/, "");
    results.push({ path: rel, title, snippet, updated: statSync(f).mtime.toISOString() });
    if (results.length >= (limit ?? 10)) break;
  }
  return ok({ query, count: results.length, results });
});

(server as any).tool("obsidian_links", "Навигация по wikilinks: outgoing, incoming или both (граф соседей 1-hop).", {
  path: z.string(),
  direction: z.enum(["outgoing", "incoming", "both"]),
}, async ({ path, direction }: { path: string; direction: "outgoing" | "incoming" | "both" }) => {
  if (!VAULT) return ok({ error: "OBSIDIAN_VAULT_PATH не задан" });
  try {
    const outgoing: string[] = [];
    if (direction === "outgoing" || direction === "both") {
      outgoing.push(...readMd(path).wikilinks);
    }
    const incoming: { path: string; title: string }[] = [];
    if (direction === "incoming" || direction === "both") {
      const targetName = basename(path).replace(/\.md$/, "");
      for (const f of allMdFiles()) {
        const rel = relative(VAULT, f).replace(/\.md$/, "");
        if (rel === path) continue;
        const text = readFileSync(f, "utf8");
        // Точный match: [[targetName]] или [[targetName|alias]]
        const wikilinks = extractWikiLinks(text);
        if (wikilinks.some(l => l === targetName)) {
          const title = (text.match(/^#\s+(.+)$/m)?.[1] ?? basename(f, ".md")).trim();
          incoming.push({ path: rel, title });
        }
      }
    }
    return ok({ path, direction, outgoing, incoming });
  } catch (e: any) { return ok({ error: e?.message ?? String(e) }); }
});

(server as any).tool("obsidian_write", "Записать .md файл в Obsidian vault (за approval-гейтом). mode: create/append/overwrite.", {
  path: z.string(),
  content: z.string(),
  mode: z.enum(["create", "append", "overwrite"]).default("create"),
}, async ({ path, content, mode }: { path: string; content: string; mode: "create" | "append" | "overwrite" }) => {
  if (!VAULT) return ok({ error: "OBSIDIAN_VAULT_PATH не задан" });
  try {
    const p = mdPath(path);
    mkdirSync(dirname(p), { recursive: true });
    if (mode === "create" && existsSync(p)) return ok({ error: "файл уже существует, используй overwrite или append" });
    if (mode === "append") {
      const existing = existsSync(p) ? readFileSync(p, "utf8") : "";
      writeFileSync(p, existing + "\n" + content);
    } else {
      writeFileSync(p, content);
    }
    return ok({ path, mode, written: true, note: "Файл записан в vault. Obsidian Git плагин сам закоммитит при настроенном auto-commit." });
  } catch (e: any) { return ok({ error: e?.message ?? String(e) }); }
});

console.error(`[obsidian-mcp] v0.1.0 (vault=${VAULT || "NOT SET"})`);
await server.connect(new StdioServerTransport());
