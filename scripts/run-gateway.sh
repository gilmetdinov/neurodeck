#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────
# run-gateway.sh — запуск OpenClaw gateway из ТВОЕГО терминала с file-логом.
#
# Прокси: на этой машине OpenClaw требует прокси и для Telegram (гео), и для
# LLM (прямой большой POST виснет → ETIMEDOUT; через прокси отдаёт 200).
# Поэтому ДЕФОЛТ — гнать ВЕСЬ трафик через прокси из PROXY_URL (или TELEGRAM_PROXY)
# в .env. NO_PROXY оставляет localhost. Минус — латентность VPN (это свойство нода).
#
# Заполни PROXY_URL (или TELEGRAM_PROXY) в .env, напр. http://127.0.0.1:7897.
#
# DIRECT=1 — попробовать LLM напрямую (сейчас НЕ работает, оставлено на будущее):
#   DIRECT=1 bash scripts/run-gateway.sh
#
# Лог пишется и на экран, и в logs/gateway-<timestamp>.log (смотреть: tail -f).
# ─────────────────────────────────────────────────────────────────────────
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Node 22 через nvm (OpenClaw требует >=22.19)
export NVM_DIR="$HOME/.nvm"; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"; nvm use default >/dev/null 2>&1 || true

# Грузим .env проекта (ключи/флаги + TELEGRAM_PROXY).
set -a; [ -f "$ROOT/.env" ] && . "$ROOT/.env"; set +a

# По умолчанию: весь трафик через прокси. Источник — PROXY_URL или TELEGRAM_PROXY.
PROXY_URL="${PROXY_URL:-${TELEGRAM_PROXY:-}}"
if [ "${DIRECT:-0}" = "1" ]; then
  unset HTTP_PROXY HTTPS_PROXY http_proxy https_proxy   # эксперимент: напрямую
elif [ -n "$PROXY_URL" ]; then
  export HTTP_PROXY="$PROXY_URL" HTTPS_PROXY="$PROXY_URL"
  # Внутренние хосты (redmine/<YOUR_GITLAB_HOST>) — НАПРЯМУЮ, мимо прокси: прокси внешний (VPN),
  # а <YOUR_HOST> за фаерволлом. Иначе proxy-aware клиенты (gitbeaker в gitlab-mr-mcp) не достучатся.
  export NO_PROXY="${NO_PROXY:-localhost,127.0.0.1,<YOUR_HOST>,<YOUR_HOST>}"
else
  echo "⚠  PROXY_URL/TELEGRAM_PROXY не заданы в .env — Telegram/LLM могут не подключиться."
fi

mkdir -p "$ROOT/logs"
LOG="$ROOT/logs/gateway-$(date +%Y%m%d-%H%M%S).log"

# освобождаем порт, если висит прошлый инстанс
PIDS="$(lsof -nP -iTCP:18789 -sTCP:LISTEN -t 2>/dev/null || true)"
[ -n "$PIDS" ] && { echo "↩ убиваю прошлый gateway: $PIDS"; kill $PIDS 2>/dev/null; sleep 2; }

# убиваем зомби MCP-процессы от прошлых запусков (осиротевшие дети gateway)
cleanup_mcp_zombies() {
  for pattern in "git-egress" "release-manager" "gitlab-write" "redmine-write" "redmine" "gitlab-mr" "reviewer" "harness" "figma" "worker-bridge"; do
    local dead
    dead="$(ps aux 2>/dev/null | grep -i "mcp-servers/${pattern}/dist/index.js" | grep -v grep | awk '{print $2}')"
    [ -n "$dead" ] && { echo "🧹 зомби ${pattern}: $dead"; kill $dead 2>/dev/null; }
  done
}
cleanup_mcp_zombies

# trap: при выключении gateway убиваем ВСЕ дочерние MCP-процессы
cleanup_on_exit() {
  echo "↩ gateway выключается, чищу дочерние MCP-процессы..."
  # убиваем всю группу процессов (дети gateway)
  jobs -p 2>/dev/null | xargs kill 2>/dev/null || true
  cleanup_mcp_zombies
}
trap cleanup_on_exit EXIT INT TERM

echo "node:        $(node -v)"
echo "режим:       ${DIRECT:+DIRECT (напрямую)}${DIRECT:-всё через прокси}"
echo "HTTP_PROXY:  ${HTTP_PROXY:-<unset>}"
echo "HTTPS_PROXY: ${HTTPS_PROXY:-<unset>}"
echo "NO_PROXY:    ${NO_PROXY:-<unset>}"
echo "лог:         $LOG"
echo "─────────────────────────────────────────────"
openclaw gateway --verbose 2>&1 | tee "$LOG"
