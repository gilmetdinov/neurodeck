// mcp-servers/notifier/src/telegram.ts
// Telegram-отправка с inline-кнопками для группового чата разрабов.

import { fetch as diFetch, ProxyAgent } from "undici";
import { getConfig, getTelegramToken, getProxyUrl, isConfigured } from "./notifier-config.js";
import { EventEntry } from "./event-reader.js";

// Dedup: don't send same (type, task_id) within DEDUP_WINDOW_MS
const DEDUP_WINDOW_MS = 5 * 60 * 1000;
const _sentCache = new Map<string, number>();

export interface InlineButton {
  text: string;
  url?: string;
  callback_data?: string;
}

interface TelegramMessage {
  text: string;
  keyboard?: InlineButton[][];
  event: EventEntry;
}

function buildMessage(event: EventEntry): TelegramMessage | null {
  const cfg = getConfig();
  const p = event.payload ?? {};
  const id = event.redmine_id || p.redmine_id;
  const taskId = event.task_id;

  switch (event.type) {
    case "task.pending_approval": {
      const details = [
        p.repo ? `репо: ${p.repo}` : "",
        p.lang ? `/${p.lang}` : "",
        p.estimated_time_min ? `~${p.estimated_time_min}мин` : "",
      ].filter(Boolean).join(", ");
      const btns: InlineButton[][] = [];
      if (cfg.buttons.open_redmine && id) btns.push([{ text: "Открыть в RM", url: getRedmineUrl(id) }]);
      return { text: `🟡 <b>#${id}</b> ждёт запуска${details ? `\n${details}` : ""}\nОркестратор запустит автоматически`, keyboard: btns, event };
    }
    case "task.compiled": {
      const details = [
        p.repo ? `репо: ${p.repo}` : "",
        p.lang ? `/${p.lang}` : "",
        p.estimated_time_min ? `${p.estimated_time_min}мин` : "",
        p.rework ? "(rework)" : "",
      ].filter(Boolean).join(", ");

      const btns: InlineButton[][] = [];
      if (cfg.buttons.open_redmine && id) btns.push([{ text: "Открыть в RM", url: getRedmineUrl(id) }]);

      return { text: `🆕 <b>#${id}</b> скомпилирована${details ? `: ${details}` : ""}`, keyboard: btns, event };
    }
    case "task.claimed": {
      const worker = p.worker || "worker";
      return { text: `🔧 <b>#${id}</b> взял <i>${worker}</i>`, event };
    }
    case "task.started": {
      return { text: `🔄 <b>#${id}</b> выполняется`, event };
    }
    case "task.needs_clarify": {
      const questions = Array.isArray(p.questions) ? p.questions.join("\n") : (p.questions ?? p.text ?? "требуется уточнение");
      const btns: InlineButton[][] = [];
      if (cfg.buttons.open_redmine && id) btns.push([{ text: "Ответить в RM", url: getRedmineUrl(id) }]);

      return { text: `⚠️ <b>#${id}</b> требует уточнения:\n${questions.slice(0, 300)}`, keyboard: btns, event };
    }
    case "task.done": {
      const details = [
        p.branch ? `ветка: ${p.branch}` : "",
        p.commits ? `коммитов: ${p.commits}` : "",
        p.worker ? `worker: ${p.worker}` : "",
      ].filter(Boolean).join(", ");

      const btns: InlineButton[][] = [];
      if (cfg.buttons.open_redmine && id) btns.push([{ text: "Открыть RM", url: getRedmineUrl(id) }]);

      return { text: `✅ <b>#${id}</b> готов${details ? ` (${details})` : ""}\nЖдёт git-egress для push+MR.`, keyboard: btns, event };
    }
    case "task.rework": {
      return { text: `🔁 <b>#${id}</b> отправлена на доработку`, event };
    }
    case "task.executed": {
      const btns: InlineButton[][] = [];
      if (cfg.buttons.open_redmine && id) btns.push([{ text: "Открыть RM", url: getRedmineUrl(id) }]);
      if (cfg.buttons.create_rc_mr && p.version_id) {
        btns.push([{ text: "Создать RC MR", callback_data: `create_rc_mr:${p.version_id}` }]);
      }

      return { text: `🏁 <b>#${id}</b> исполнена${p.rc_branch ? ` → ${p.rc_branch}` : ""}. Пора в релизную ветку.`, keyboard: btns, event };
    }
    case "review.ready": {
      const count = p.count ?? 0;
      const taskIds = Array.isArray(p.task_ids) ? p.task_ids.slice(0, 10).join(", #") : (Array.isArray(p.mr_iids) ? p.mr_iids.slice(0, 10).map((n: number) => `!${n}`).join(", ") : "");
      const front = p.front_count ? ` (${p.front_count} фронт)` : "";
      const back = p.back_count ? ` (${p.back_count} бек)` : "";
      return { text: `👀 <b>${count} MR</b> без ревьюеров${front}${back}${taskIds ? `\n${taskIds}` : ""}`, event };
    }
    case "release.rc_ready": {
      const count = p.count ?? 0;
      const mrs = Array.isArray(p.mrs) ? p.mrs.slice(0, 5).map((m: any) => `!${m.iid} → ${m.target}`).join("\n") : "";
      return { text: `🔀 <b>${count} MR</b> готовы к мёрджу в rc${mrs ? `\n${mrs}` : ""}`, event };
    }
    case "version.monitor": {
      const open = p.open_count ?? 0;
      const urgent = p.urgent_count ?? 0;
      const overdue = (p.overdue_versions ?? []).length;
      const lines: string[] = [];
      lines.push(`📅 <b>${open} открытых версий</b>`);
      if (urgent) lines.push(`⚠️ ${urgent} срочных`);
      if (overdue) lines.push(`🔴 ${overdue} просрочено`);
      return { text: lines.join(" · "), event };
    }
    default:
      return null;
  }
}

function getRedmineUrl(redmineId: number): string {
  const base = process.env.REDMINE_BASE_URL?.replace(/\/$/, "") || "https://redmine.example.com";
  return `${base}/issues/${redmineId}`;
}

function getGitlabMrUrl(projectId: number, mrIid: number): string {
  const base = process.env.GITLAB_BASE_URL?.replace(/\/$/, "") || "https://gitlab.com";
  return `${base}/-/merge_requests/${mrIid}`;
}

export async function sendEvent(event: EventEntry): Promise<boolean> {
  if (!isConfigured()) return false;

  // Dedup: skip if same (type, task_id) sent recently
  const dedupKey = `${event.type}:${event.task_id}`;
  const lastSent = _sentCache.get(dedupKey);
  if (lastSent && Date.now() - lastSent < DEDUP_WINDOW_MS) return false;

  const msg = buildMessage(event);
  if (!msg) return false;

  try {
    await sendTelegramMsg(msg.text, msg.keyboard);
    _sentCache.set(dedupKey, Date.now());
    // Cleanup old cache entries
    if (_sentCache.size > 200) {
      for (const [k, ts] of _sentCache) { if (Date.now() - ts > DEDUP_WINDOW_MS) _sentCache.delete(k); }
    }
    return true;
  } catch (e: any) {
    console.error(`[notifier] send failed for ${event.type}/${event.task_id}: ${e?.message ?? e}`);
    return false;
  }
}

async function sendTelegramMsg(text: string, keyboard?: InlineButton[][]): Promise<void> {
  const token = getTelegramToken();
  const chatId = getConfig().chat_id;
  const proxyUrl = getProxyUrl();
  const dispatcher = proxyUrl ? new ProxyAgent(proxyUrl) : undefined;

  const body: any = {
    chat_id: chatId,
    text: text.slice(0, 4096),
    parse_mode: "HTML",
    disable_web_page_preview: true,
  };

  if (keyboard && keyboard.length > 0) {
    body.reply_markup = { inline_keyboard: keyboard.map((row) => row.map((btn) => {
      const b: any = { text: btn.text };
      if (btn.url) b.url = btn.url;
      if (btn.callback_data) b.callback_data = btn.callback_data;
      return b;
    })) };
  }

  const res = await diFetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    dispatcher,
  });

  if (!res.ok) throw new Error(`Telegram ${res.status}: ${(await res.text()).slice(0, 300)}`);
}

export { getRedmineUrl, getGitlabMrUrl };
