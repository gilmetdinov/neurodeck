#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────
# deploy-config.sh — рендер config/openclaw.json5 → ~/.openclaw/openclaw.json
#
# Что делает:
#   1) грузит .env (для PROJECT_ROOT и развёртывания TELEGRAM_ALLOWED_USER_IDS)
#   2) подставляет PROJECT_ROOT и TELEGRAM_ALLOWED_FROM
#   3) бэкапит текущий ~/.openclaw/openclaw.json
#   4) копирует шаблон на место рабочего конфига
#
# Секреты (${LLM_API_KEY} и т.п.) НЕ инлайнятся — OpenClaw сам
# подставит их из окружения демона. Поэтому демон надо запускать со
# средой из .env (см. docs/guides/llm-setup.md → "Запуск демона").
#
# Usage:  npm run deploy:config   ||   bash scripts/deploy-config.sh
# ─────────────────────────────────────────────────────────────────────────
set -euo pipefail

# AGENT_REPO_ROOT = корень репо САМОГО агента (neurodeck-agent).
# Нужен только чтобы найти собранный Redmine MCP. К управляемым проектам/вариантам
# отношения не имеет — те живут в реестре, см. config/projects.json5 + ADR-0006.
AGENT_REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$AGENT_REPO_ROOT/config/openclaw.json5"
DEST_DIR="$HOME/.openclaw"
DEST="$DEST_DIR/openclaw.json"

[ -f "$SRC" ] || { echo "✗ нет шаблона: $SRC"; exit 1; }

# 1) грузим .env, если есть
if [ -f "$AGENT_REPO_ROOT/.env" ]; then
  set -a; # shellcheck disable=SC1091
  source "$AGENT_REPO_ROOT/.env"; set +a
fi

# 2) TELEGRAM_ALLOWED_USER_IDS="telegram:1,telegram:2" → ["telegram:1","telegram:2"]
#    Префикс telegram: обязателен (не tg:). Список идёт и в allowFrom, и в ownerAllowFrom.
ALLOWED_RAW="${TELEGRAM_ALLOWED_USER_IDS:-}"
if [ -n "$ALLOWED_RAW" ]; then
  TELEGRAM_ALLOWED_FROM="[$(echo "$ALLOWED_RAW" | sed 's/[^,]*[^,]/"&"/g')]"
else
  echo "⚠  TELEGRAM_ALLOWED_USER_IDS пуст — бот не пустит никого. Заполни .env."
  TELEGRAM_ALLOWED_FROM="[]"
fi

mkdir -p "$DEST_DIR"
# Без каталога workspace демон пропускает агента ("Skipping agent main").
# Обычно его создаёт `openclaw onboard`; гарантируем наличие при деплое.
mkdir -p "$DEST_DIR/workspace"

# 3) бэкап
if [ -f "$DEST" ]; then
  cp "$DEST" "$DEST.bak.$(date +%Y%m%d%H%M%S)"
  echo "↩  бэкап: $DEST.bak.*"
fi

# 4) рендер: AGENT_REPO_ROOT, TELEGRAM_ALLOWED_FROM и LLM_MODEL через sed.
#    Остальные секреты (${LLM_API_KEY} и др.) — OpenClaw подставит из env демона.
[ -n "${LLM_MODEL:-}" ] || { echo "✗ LLM_MODEL не задан в .env"; exit 1; }
sed \
  -e "s#\${AGENT_REPO_ROOT}#${AGENT_REPO_ROOT}#g" \
  -e "s#\${OPENCLAW_HOME}#${DEST_DIR}#g" \
  -e "s#\"\${TELEGRAM_ALLOWED_FROM}\"#${TELEGRAM_ALLOWED_FROM}#g" \
  -e "s#\${LLM_MODEL}#${LLM_MODEL}#g" \
  "$SRC" > "$DEST"

# 5) промпт ОДНОГО агента (agent-as-MCP) → ws/orchestrator/AGENTS.md.
#    OpenClaw грузит из workspace СТРОГО именованный набор (BOOTSTRAP_FILENAME="AGENTS.md"),
#    НЕ любой .md. Берём comprehensive prompts/system.md (один агент делает всё; тяжёлую
#    интерпретацию/сырьё отдаёт умным MCP-тулзам — reviewer.review_mr, redmine.team_digest).
WS="$DEST_DIR/ws/orchestrator"
mkdir -p "$WS"
# Роутинг-роестр флота — ГЕНЕРИТСЯ из config/agents.json5 (ADR-0024 §2): правишь реестр → роутинг обновляется.
node "$AGENT_REPO_ROOT/scripts/gen-fleet-prompt.mjs"
# Композиция промпта: общий домен (_base: проект/статусы/команда) + роестр флота (_fleet, авто) + ролевой (system).
# Единый источник правды по статусам/людям — _base.md; по флоту специалистов — config/agents.json5 → _fleet.md.
cat "$AGENT_REPO_ROOT/prompts/_base.md" "$AGENT_REPO_ROOT/prompts/_fleet.md" "$AGENT_REPO_ROOT/prompts/system.md" > "$WS/AGENTS.md"
echo "✓ промпт orchestrator → $WS/AGENTS.md (_base.md + system.md, $(wc -l < "$WS/AGENTS.md") строк)"

echo "✓ задеплоен конфиг → $DEST"
echo "  Модель: ${LLM_MODEL} (temp 0.3); gitlab-MCP без прокси"
echo "  Секреты (\${LLM_API_KEY}, \${TELEGRAM_BOT_TOKEN}, ...) OpenClaw подставит из env демона."
echo "  Проверка: openclaw doctor"
