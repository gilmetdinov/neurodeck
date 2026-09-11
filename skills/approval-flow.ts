/**
 * approval-flow — approval-gate перед write-операциями (этап 3+).
 *
 * Заглушка. Реализуется на этапе 3. Контракт (из AGENTS.md):
 *  - агент формирует preview изменения
 *  - шлёт в Telegram сообщение с кнопками [✅ Подтвердить][✏️ Редактировать][❌ Отмена]
 *  - ждёт апрув, timeout 30 минут → автоотмена
 *  - DRY_RUN=true: пишет в docs/dry-run-log.md, в prod не пишет
 *  - DRY_RUN=false + апрув: исполняет write, лог в docs/approval-history.md
 */

export type ApprovalAction = {
  /** тип действия: redmine_add_note | redmine_update_status | gitlab_comment | ... */
  kind: string;
  /** объект: "Redmine #842" | "GitLab MR-1234" | "vault/reviews/...md" */
  target: string;
  /** что именно будет записано (показывается пользователю в preview) */
  change: string;
};

export type ApprovalResult =
  | { status: "approved" }
  | { status: "edited"; newChange: string }
  | { status: "cancelled" }
  | { status: "timeout" };

/** Формат preview-сообщения approval-gate (AGENTS.md). */
export function renderApprovalPreview(a: ApprovalAction): string {
  return [
    "🔍 Планирую выполнить:",
    "",
    `Действие: ${a.kind}`,
    `Объект: ${a.target}`,
    `Изменение: ${a.change}`,
  ].join("\n");
}

// TODO(этап 3): requestApproval(action): Promise<ApprovalResult>
//   - отрисовать inline-кнопки в Telegram
//   - дождаться callback / timeout 30m
//   - учесть DRY_RUN
export {};
