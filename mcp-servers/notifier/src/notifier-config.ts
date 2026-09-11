// mcp-servers/notifier/src/notifier-config.ts
// Конфигурация notifier из config/notifier.json5 + env.

import { readFileSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
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

export interface NotifierConfig {
  chat_id: string;
  bot_token_env: string;
  proxy_env: string;
  poll_interval_ms: number;
  events_dir: string;
  cursor_path: string;
  archive_events_days: number;
  enabled_event_types: string[];
  buttons: {
    open_redmine: boolean;
    open_gitlab: boolean;
    create_rc_mr: boolean;
  };
}

let _cachedConfig: NotifierConfig | null = null;

export function getConfig(): NotifierConfig {
  if (_cachedConfig) return _cachedConfig;

  const configPath = join(ROOT, "config", "notifier.json5");
  const def: NotifierConfig = {
    chat_id: "",
    bot_token_env: "TELEGRAM_BOT_TOKEN",
    proxy_env: "PROXY_URL",
    poll_interval_ms: 30000,
    events_dir: "workspace/state/events",
    cursor_path: "workspace/state/notifier-cursor.json",
    archive_events_days: 7,
    enabled_event_types: [
      "task.pending_approval",
      "task.needs_clarify",
      "task.done",
      "task.rework",
      "task.executed",
      "review.ready",
    ],
    buttons: { open_redmine: true, open_gitlab: true, create_rc_mr: true },
  };

  if (existsSync(configPath)) {
    try {
      const raw = JSON5.parse(readFileSync(configPath, "utf-8")) as any;
      _cachedConfig = {
        chat_id: clean(process.env.NOTIFIER_CHAT_ID) || String(raw.chat_id ?? def.chat_id),
        bot_token_env: raw.bot_token_env ?? def.bot_token_env,
        proxy_env: raw.proxy_env ?? def.proxy_env,
        poll_interval_ms: Number(raw.poll_interval_ms ?? def.poll_interval_ms),
        events_dir: raw.events_dir ?? def.events_dir,
        cursor_path: raw.cursor_path ?? def.cursor_path,
        archive_events_days: Number(raw.archive_events_days ?? def.archive_events_days),
        enabled_event_types: raw.enabled_event_types ?? def.enabled_event_types,
        buttons: { ...def.buttons, ...(raw.buttons ?? {}) },
      };
    } catch { _cachedConfig = def; }
  } else {
    _cachedConfig = def;
  }

  // Env overrides
  const chatFromEnv = clean(process.env.NOTIFIER_CHAT_ID) || clean(process.env.HARNESS_NOTIFY_CHAT_ID);
  if (chatFromEnv) _cachedConfig.chat_id = chatFromEnv;

  // NOTIFIER_MUTE_MODE: "dm" → личка тимлида, "group" → групповой чат
  const muteMode = clean(process.env.NOTIFIER_MUTE_MODE) || "group";
  if (muteMode === "dm") {
    const allowed = clean(process.env.TELEGRAM_ALLOWED_USER_IDS) || "";
    const dmMatch = allowed.match(/telegram:(\d+)/);
    if (dmMatch) _cachedConfig.chat_id = dmMatch[1];
  }

  return _cachedConfig;
}

export function getTelegramToken(): string {
  const cfg = getConfig();
  return clean(process.env[cfg.bot_token_env]) || clean(process.env.TELEGRAM_BOT_TOKEN) || "";
}

export function getProxyUrl(): string {
  const cfg = getConfig();
  return clean(process.env[cfg.proxy_env]) || "";
}

export function isConfigured(): boolean {
  const cfg = getConfig();
  return Boolean(cfg.chat_id && getTelegramToken());
}

export { ROOT };
