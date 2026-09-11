// mcp-servers/notifier/src/event-reader.ts
// Чтение событий из workspace/state/events/, cursor-механика, ротация.

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import { join, dirname, basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getConfig } from "./notifier-config.js";

const clean = (v?: string): string => { const s = (v ?? "").trim(); return /^\$\{.*\}$/.test(s) ? "" : s; };
const ROOT = (() => {
  const env = clean(process.env.AGENT_REPO_ROOT);
  if (env) return env;
  try { return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", ".."); }
  catch { return process.cwd(); }
})();

export interface EventEntry {
  type: string;
  task_id: string;
  redmine_id: number;
  timestamp: string;
  payload?: Record<string, any>;
}

export interface Cursor {
  last_seen_at: string;
  last_seen_file: string | null;
}

function cursorPath(): string {
  const cfg = getConfig();
  return join(ROOT, cfg.cursor_path || "workspace/state/notifier-cursor.json");
}

function eventsDir(): string {
  const cfg = getConfig();
  return join(ROOT, cfg.events_dir || "workspace/state/events");
}

function eventsArchiveDir(): string {
  return join(eventsDir(), "archive");
}

function loadCursor(): Cursor {
  const p = cursorPath();
  if (!existsSync(p)) return { last_seen_at: "1970-01-01T00:00:00Z", last_seen_file: null };
  try { return JSON.parse(readFileSync(p, "utf-8")) as Cursor; }
  catch { return { last_seen_at: "1970-01-01T00:00:00Z", last_seen_file: null }; }
}

function saveCursor(c: Cursor): void {
  mkdirSync(dirname(cursorPath()), { recursive: true });
  writeFileSync(cursorPath(), JSON.stringify(c, null, 2));
}

export function scanNewEvents(): EventEntry[] {
  const cfg = getConfig();
  const cursor = loadCursor();
  const ed = eventsDir();
  if (!existsSync(ed)) return [];

  const allFiles = readdirSync(ed).filter((f) => f.endsWith(".json")).sort();
  const events: EventEntry[] = [];

  for (const file of allFiles) {
    const filePath = join(ed, file);
    // Skip if before cursor
    if (file <= (cursor.last_seen_file ?? "")) continue;

    try {
      const raw = JSON.parse(readFileSync(filePath, "utf-8")) as EventEntry;
      // Filter by enabled event types
      if (!cfg.enabled_event_types || cfg.enabled_event_types.length === 0 || cfg.enabled_event_types.includes(raw.type)) {
        events.push(raw);
      }
    } catch { continue; }
  }

  // Update cursor
  if (allFiles.length > 0) {
    cursor.last_seen_file = allFiles[allFiles.length - 1];
    cursor.last_seen_at = new Date().toISOString();
    saveCursor(cursor);
  }

  return events;
}

export function archiveOldEvents(): number {
  const cfg = getConfig();
  const ed = eventsDir();
  const archive = eventsArchiveDir();
  if (!existsSync(ed)) return 0;

  const maxAgeMs = (cfg.archive_events_days ?? 7) * 24 * 60 * 60 * 1000;
  const now = Date.now();
  let archived = 0;

  const files = readdirSync(ed).filter((f) => f.endsWith(".json"));
  for (const file of files) {
    const filePath = join(ed, file);
    try {
      const stat = statSync(filePath);
      if (now - stat.mtimeMs > maxAgeMs) {
        mkdirSync(archive, { recursive: true });
        renameSync(filePath, join(archive, file));
        archived++;
      }
    } catch { continue; }
  }

  return archived;
}

export function resetCursor(): void {
  saveCursor({ last_seen_at: "1970-01-01T00:00:00Z", last_seen_file: null });
}

export { loadCursor, saveCursor };
