// ─────────────────────────────────────────────────────────────────────────────
// approval-gate — OpenClaw-плагин: НАТИВНЫЙ approval-гейт на чувствительные тулзы.
//
// Зачем: harness `run_task`/`run_batch` (и позже redmine-write/gitlab-write) запускают
// ПЛАТНЫЕ/МУТИРУЮЩИЕ действия. До этого плагина гейт был только «промпт-договорённостью»
// (LLM сама себя «апрувила») + грубым env-предохранителем HARNESS_RUN_ENABLED — это
// self-approval-хол (ADR-0007 §открытый вопрос B).
//
// Как: хук `before_tool_call` срабатывает ПОСЛЕ выбора тула моделью и ДО исполнения.
// Возвращаем `requireApproval` → OpenClaw ставит прогон на паузу, шлёт тимлиду апрув в
// Telegram (нативные кнопки + `/approve`), и на `deny`/`timeout`/нет-маршрута — БЛОКИРУЕТ
// вызов. Гейт нативный, между выбором и исполнением → LLM физически не может само-апрувнуть.
// Это и есть гибрид ADR-0007 (несбиваемый нативный гейт + богатый предпросмотр) в ОДНОМ
// механизме. Маршрутизация — `approvals.plugin` в openclaw.json5 (см. README).
//
// Сборку/установку/проверку делает тимлид (среда gateway+Telegram): см. README.
// ─────────────────────────────────────────────────────────────────────────────
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

// Тулзы, требующие апрува ПЕРЕД исполнением. Дефолт — платные harness-запуски.
// Расширяется через plugins.entries.<id>.config.sensitiveTools (напр. добавить
// write-тулзы Redmine/GitLab на этапах 4–5) без правки кода.
const DEFAULT_SENSITIVE = ["run_task", "run_batch", "pool_approve", "pool_forget"];

// «Критичные» (трата $ / автономный прогон Claude) → severity:critical.
const CRITICAL = new Set(["run_task", "run_batch"]);

// Лимиты из OpenClaw (PluginApprovalRequestPayload): title ≤ 80, description ≤ 256.
const TITLE_MAX = 80;
const DESC_MAX = 256;

// Матч имени тула робастно к неймспейсингу bundle-mcp: точное ИЛИ суффикс
// (`harness__run_task` / `harness.run_task` / `mcp__harness__run_task` → все матчат `run_task`).
function matchesSensitive(toolName: string, sensitive: string[]): string | null {
  for (const s of sensitive) {
    if (toolName === s || toolName.endsWith("__" + s) || toolName.endsWith("." + s) || toolName.endsWith("_" + s)) {
      return s;
    }
  }
  return null;
}

function clip(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}

// Краткий человекочитаемый предпросмотр из параметров тула. БЕЗ секретов/тел — только
// безопасные идентификаторы (что/куда/модель/бюджет): они и так уйдут в чат апрува.
function buildPreview(params: Record<string, unknown>): string {
  const p = params ?? {};
  const bits: string[] = [];
  const pick = (k: string, label: string) => {
    const v = p[k];
    if (v != null && v !== "") bits.push(`${label}=${String(v)}`);
  };
  pick("task_id", "задача");
  pick("repo", "репо");
  pick("category", "категория");
  pick("model", "модель");
  pick("max_budget_usd", "бюджет$");
  pick("redmine_id", "redmine");
  if (Array.isArray(p["task_ids"])) bits.push(`задачи=${(p["task_ids"] as unknown[]).join(",")}`);
  return bits.length ? bits.join("  ") : "(параметры не распознаны — проверь вызов вручную)";
}

interface GateConfig {
  sensitiveTools?: string[];
  timeoutMs?: number;
}

export default definePluginEntry({
  id: "approval-gate",
  name: "neurodeck Approval Gate",
  register(api) {
    api.on(
      "before_tool_call",
      async (event) => {
        const cfg = (event?.context?.pluginConfig ?? {}) as GateConfig;
        const sensitive = Array.isArray(cfg.sensitiveTools) && cfg.sensitiveTools.length
          ? cfg.sensitiveTools
          : DEFAULT_SENSITIVE;

        const toolName = String(event.toolName ?? "");
        const hit = matchesSensitive(toolName, sensitive);
        if (!hit) return; // не чувствительный тул — пропускаем без гейта

        const isCritical = CRITICAL.has(hit);
        const preview = buildPreview((event.params ?? {}) as Record<string, unknown>);

        return {
          requireApproval: {
            title: clip(`🔍 Подтвердить: ${toolName}`, TITLE_MAX),
            description: clip(preview, DESC_MAX),
            severity: isCritical ? "critical" : "warning",
            // Платный/мутирующий вызов апрувим КАЖДЫЙ раз — без durable allow-always.
            allowedDecisions: ["allow-once", "deny"],
            timeoutMs: typeof cfg.timeoutMs === "number" ? cfg.timeoutMs : 600_000,
            timeoutBehavior: "deny",
            onResolution: (decision) => {
              // Аудит-след в лог gateway. Верить ЭТОМУ, не нарративу LLM (recap: честность).
              console.error(
                `[approval-gate] ${toolName} → ${decision} ` +
                `(agent=${event?.context?.agentId ?? "?"}, ${preview})`,
              );
            },
          },
        };
      },
      { priority: 80 },
    );
  },
});
