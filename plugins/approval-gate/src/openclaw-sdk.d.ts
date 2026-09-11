// Минимальная ЛОКАЛЬНАЯ декларация SDK-входа OpenClaw — чтобы `tsc` собирал плагин БЕЗ
// тяжёлой зависимости от пакета `openclaw` (336 МБ). В рантайме импорт
// `openclaw/plugin-sdk/plugin-entry` резолвится против глобально установленного хоста.
// Здесь объявлено только то, что мы реально используем (хук `before_tool_call` +
// `requireApproval`). Полные типы — в самом openclaw/plugin-sdk; при желании добавь
// `openclaw` в devDependencies и убери этот шим.
declare module "openclaw/plugin-sdk/plugin-entry" {
  export type ApprovalDecision =
    | "allow-once"
    | "allow-always"
    | "deny"
    | "timeout"
    | "cancelled";

  export interface BeforeToolCallEvent {
    toolName: string;
    params?: Record<string, unknown>;
    toolKind?: string;
    toolInputKind?: string;
    runId?: string;
    toolCallId?: string;
    context?: {
      pluginConfig?: unknown;
      agentId?: string;
      sessionKey?: string;
      sessionId?: string;
      runId?: string;
    };
  }

  export interface RequireApproval {
    title: string;
    description: string;
    severity?: "info" | "warning" | "critical";
    timeoutMs?: number;
    timeoutBehavior?: "allow" | "deny";
    allowedDecisions?: Array<"allow-once" | "allow-always" | "deny">;
    pluginId?: string;
    onResolution?: (decision: ApprovalDecision) => void | Promise<void>;
  }

  export interface BeforeToolCallResult {
    params?: Record<string, unknown>;
    block?: boolean;
    blockReason?: string;
    requireApproval?: RequireApproval;
  }

  export interface PluginApi {
    on(
      name: "before_tool_call",
      handler: (
        event: BeforeToolCallEvent,
      ) => Promise<BeforeToolCallResult | void> | BeforeToolCallResult | void,
      opts?: { priority?: number; timeoutMs?: number },
    ): void;
    // прочие хуки/методы SDK существуют, но этому плагину не нужны
    on(
      name: string,
      handler: (event: unknown) => unknown,
      opts?: { priority?: number; timeoutMs?: number },
    ): void;
  }

  export interface PluginEntry {
    id: string;
    name: string;
    register(api: PluginApi): void;
  }

  export function definePluginEntry(entry: PluginEntry): PluginEntry;
}
