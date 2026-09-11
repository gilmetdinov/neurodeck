#!/usr/bin/env node
// mcp-servers/notifier/src/index.ts (ADR-0028)
// Асинхронный Telegram-нотификатор для worker pool.
// Слушает workspace/state/events/ → шлёт в групповой чат разрабов + inline-кнопки.
//
// Env: NOTIFIER_CHAT_ID, TELEGRAM_BOT_TOKEN, PROXY_URL, AGENT_REPO_ROOT

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { z } from "zod";

import { getConfig, isConfigured, ROOT } from "./notifier-config.js";
import { scanNewEvents, archiveOldEvents, resetCursor, EventEntry } from "./event-reader.js";
import { sendEvent } from "./telegram.js";

const ok = (obj: unknown) => ({ content: [{ type: "text" as const, text: typeof obj === "string" ? obj : JSON.stringify(obj, null, 2) }] });

const STORE_PATH = join(ROOT, "workspace", "state", "notifier-state.json");
const WORKSPACE_STATE_DIR = join(ROOT, "workspace", "state");

interface Store {
  last_scan: string | null;
  last_archive: string | null;
  events_processed: number;
  messages_sent: number;
  messages_failed: number;
  recent: Array<{ type: string; task_id: string; timestamp: string }>;
}

function loadStore(): Store {
  if (!existsSync(STORE_PATH)) return { last_scan: null, last_archive: null, events_processed: 0, messages_sent: 0, messages_failed: 0, recent: [] };
  try { return JSON.parse(readFileSync(STORE_PATH, "utf-8")) as Store; }
  catch { return { last_scan: null, last_archive: null, events_processed: 0, messages_sent: 0, messages_failed: 0, recent: [] }; }
}

function saveStore(s: Store): void {
  mkdirSync(dirname(STORE_PATH), { recursive: true });
  writeFileSync(STORE_PATH, JSON.stringify(s, null, 2));
  try { writeFileSync(join(WORKSPACE_STATE_DIR, "notifier-state.json"), JSON.stringify(s, null, 2)); } catch {}
}

let store = loadStore();
let archived = false;

async function tick(): Promise<string[]> {
  const log: string[] = [];
  const add = (s: string) => { console.error(`[notifier] ${s}`); log.push(s); };

  const cfg = getConfig();

  if (!isConfigured()) {
    add("not configured — set NOTIFIER_CHAT_ID and TELEGRAM_BOT_TOKEN");
    return log;
  }

  // Scan new events
  const events = scanNewEvents();
  store.events_processed += events.length;

  for (const event of events) {
    const sent = await sendEvent(event);
    store.recent.unshift({ type: event.type, task_id: event.task_id, timestamp: new Date().toISOString() });
    store.recent = store.recent.slice(0, 30);

    if (sent) {
      store.messages_sent++;
      add(`${event.type} → #${event.redmine_id ?? event.task_id}`);
    } else {
      store.messages_failed++;
    }
  }

  // Archive old events (once per day)
  if (!archived) {
    try {
      const count = archiveOldEvents();
      if (count > 0) add(`archived ${count} events`);
      store.last_archive = new Date().toISOString();
      archived = true;
      // Reset archived flag once a day
      setTimeout(() => { archived = false; }, 24 * 60 * 60 * 1000);
    } catch (e: any) { add(`archive error: ${e?.message ?? e}`); }
  }

  store.last_scan = new Date().toISOString();
  saveStore(store);

  return log;
}

// MCP Server
const server = new McpServer({ name: "notifier", version: "0.1.0" });

server.tool("ntf_status", "Состояние notifier: конфигурация, статистика, последние отправки.", {}, async () => {
  return ok({
    configured: isConfigured(),
    config: { ...getConfig(), bot_token_env: "(obfuscated)", proxy_env: "(obfuscated)" },
    store: { ...store, recent: store.recent.slice(0, 10) },
  });
});

server.tool("ntf_send_test", "Отправить тестовое сообщение в чат.", {
  text: z.string().optional().describe("Текст сообщения"),
}, async ({ text }) => {
  if (!isConfigured()) return ok({ error: "notifier not configured" });
  try {
    const testEvent: EventEntry = {
      type: "task.compiled",
      task_id: "test-message",
      redmine_id: 0,
      timestamp: new Date().toISOString(),
      payload: { repo: "test", lang: "test" },
    };
    await sendEvent(testEvent);
    return ok({ sent: true, text: text || "test message" });
  } catch (e: any) {
    return ok({ error: `send failed: ${e?.message ?? e}` });
  }
});

server.tool("ntf_reset_cursor", "Сбросить cursor, чтобы переслать все события заново.", {}, async () => {
  resetCursor();
  return ok({ cursor_reset: true });
});

// Main loop
let cycling = false;
const cfg = getConfig();

async function tickWrapper(): Promise<void> {
  if (cycling) return;
  cycling = true;
  try { await tick(); }
  catch (e: any) { console.error(`[notifier] tick error: ${e?.message ?? e}`); }
  finally { cycling = false; }
}

const muteMode = (process.env.NOTIFIER_MUTE_MODE || "").trim();
console.error(`[notifier] v0.1.0 | chat=${cfg.chat_id ? (muteMode === "dm" ? "dm" : "group") : "MISSING"} | poll=${cfg.poll_interval_ms}ms`);
tickWrapper();
setInterval(tickWrapper, cfg.poll_interval_ms);

await server.connect(new StdioServerTransport());
