#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────
# setup.sh — первичная установка neurodeck
#
# Что делает:
#   1. Проверяет Node >= 22.19
#   2. Устанавливает OpenClaw глобально
#   3. Копирует .env.example → .env (если нет)
#   4. Устанавливает npm-зависимости и собирает MCP-серверы
#   5. Деплоит конфиг OpenClaw
#   6. Проверяет конфигурацию (openclaw doctor)
#
# Usage:  bash scripts/setup.sh
# ─────────────────────────────────────────────────────────────────────────
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# ── цвета ────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
info()  { echo -e "${CYAN}→${NC} $*"; }
ok()    { echo -e "${GREEN}✓${NC} $*"; }
warn()  { echo -e "${YELLOW}⚠${NC} $*"; }
err()   { echo -e "${RED}✗${NC} $*"; }

echo ""
echo "═══════════════════════════════════════════════"
echo "  neurodeck — AI-агент операционки разработки"
echo "═══════════════════════════════════════════════"
echo ""

# ── 1. Node.js ───────────────────────────────────────────────────────────
info "Проверяю Node.js..."
if ! command -v node &>/dev/null; then
  err "Node.js не найден. Установи Node >= 22.19 (nvm install 22)."
  exit 1
fi

NODE_VERSION=$(node -v | sed 's/v//')
MAJOR=$(echo "$NODE_VERSION" | cut -d. -f1)
if [ "$MAJOR" -lt 22 ]; then
  err "Node $NODE_VERSION — нужен >= 22.19. Выполни: nvm install 22 && nvm use 22"
  exit 1
fi
ok "Node $NODE_VERSION"

# ── 2. OpenClaw ──────────────────────────────────────────────────────────
info "Проверяю OpenClaw..."
if ! command -v openclaw &>/dev/null; then
  info "Устанавливаю openclaw глобально..."
  npm i -g openclaw@latest
fi
ok "OpenClaw $(openclaw --version 2>/dev/null || echo 'установлен')"

# ── 3. .env ──────────────────────────────────────────────────────────────
if [ ! -f ".env" ]; then
  info "Создаю .env из .env.example..."
  cp .env.example .env
  warn "Отредактируй .env и заполни обязательные переменные:"
  echo "     DEEPINFRA_API_KEY       — ключ DeepInfra (https://deepinfra.com/dash/api_keys)"
  echo "     TELEGRAM_BOT_TOKEN      — токен бота (@BotFather)"
  echo "     TELEGRAM_ALLOWED_USER_IDS — telegram:<твой_id> (узнать у @userinfobot)"
  echo ""
  echo "  После заполнения .env перезапусти: bash scripts/setup.sh"
  exit 0
fi

# Проверяем обязательные переменные
set -a; source .env; set +a

MISSING=""
[ -z "${DEEPINFRA_API_KEY:-}" ]   && MISSING="$MISSING DEEPINFRA_API_KEY"
[ -z "${TELEGRAM_BOT_TOKEN:-}" ]  && MISSING="$MISSING TELEGRAM_BOT_TOKEN"

if [ -n "$MISSING" ]; then
  err "Не заполнены обязательные переменные в .env:$MISSING"
  echo "  Заполни их и перезапусти: bash scripts/setup.sh"
  exit 1
fi

# Проверяем опциональные, но важные переменные
[ -z "${NOTIFIER_CHAT_ID:-}" ]     && warn "NOTIFIER_CHAT_ID не задан — нотификатор worker pool не запустится"
[ -z "${AGENT_WORKBENCH_DIR:-}" ]  && warn "AGENT_WORKBENCH_DIR не задан — автообнаружение проектов не сработает"
[ -z "${CLONES_BASE_DIR:-}" ]      && warn "CLONES_BASE_DIR не задан — worker pool не сможет создавать клоны"
ok ".env заполнен"

# ── 3.5. team.json — проверка и настройка ─────────────────────────────────
info "Проверяю config/team.json..."
if grep -q '<YOUR_REDMINE_PROJECT_SLUG>\|<DEV_NAME_1>\|<AGENT_ACCOUNT_NAME>' config/team.json 2>/dev/null; then
  warn "config/team.json содержит плейсхолдеры — данные команды не заполнены."
  echo ""
  echo "  НЕОБХОДИМО ЗАПОЛНИТЬ:"
  echo "    • config/team.json — имена, ID, email'ы разработчиков"
  echo "    • config/projects.json5 — repoPath для каждого проекта"
  echo "    • config/gitlab-repos.txt — список репозиториев для клонирования"
  echo ""
  echo "  Пример заполнения team.json — в config/team.example.json."
  echo "  После заполнения перезапусти: bash scripts/setup.sh"
  echo ""
  echo "  ПРОДОЛЖАЮ установку (team.json будет заполнен позже)."
else
  ok "team.json заполнен"
fi

# ── 4. npm-зависимости ───────────────────────────────────────────────────
info "Устанавливаю npm-зависимости..."
npm ci --ignore-scripts 2>/dev/null || npm install --ignore-scripts
ok "Зависимости установлены"

# ── 5. Сборка MCP-серверов ───────────────────────────────────────────────
info "Собираю MCP-серверы..."

MCP_DIRS=(
  "mcp-servers/redmine"
  "mcp-servers/redmine-write"
  "mcp-servers/gitlab-write"
  "mcp-servers/release-manager"
  "mcp-servers/reviewer"
  "mcp-servers/git-egress"
  "mcp-servers/xwiki"
  "mcp-servers/obsidian"
  "mcp-servers/task-poller"
  "mcp-servers/agent-worker"
  "mcp-servers/notifier"
  "mcp-servers/worker-bridge"
)

for dir in "${MCP_DIRS[@]}"; do
  if [ -f "$dir/package.json" ]; then
    (cd "$dir" && npm install --ignore-scripts 2>/dev/null && npm run build 2>/dev/null) || warn "Сборка $dir не удалась"
  fi
done
ok "MCP-серверы собраны"

# ── 6. Деплой конфига OpenClaw ──────────────────────────────────────────
info "Деплою конфиг OpenClaw..."
npm run deploy:config
ok "Конфиг задеплоен → ~/.openclaw/openclaw.json"

# ── 7. Проверка ──────────────────────────────────────────────────────────
info "Проверяю конфигурацию..."
openclaw doctor 2>&1 | head -20 || true

# ── 8. Готово ────────────────────────────────────────────────────────────
echo ""
echo "═══════════════════════════════════════════════"
echo "  Установка завершена."
echo ""
echo "  Дальше:"
echo "    1. Запусти gateway:  npm run gateway"
echo "    2. В Telegram напиши боту /start"
echo "    3. Документация:     docs/"
echo "    4. Статус:           openclaw doctor"
echo ""
echo "  При изменении .env или config/ — передеплой:"
echo "    npm run deploy:config"
echo "═══════════════════════════════════════════════"
