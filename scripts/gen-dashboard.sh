#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────
# gen-dashboard.sh — авто-генерация dashboard.md в workspace/state/.
# Читает state-файлы из ~/.openclaw и их зеркал в workspace/state/.
# ─────────────────────────────────────────────────────────────────────────
set -euo pipefail

REPO_ROOT="${REPO_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
OPENCLAW_HOME="${OPENCLAW_HOME:-$HOME/.openclaw}"
WS_STATE="$REPO_ROOT/workspace/state"
OUT="$WS_STATE/dashboard.md"

mkdir -p "$WS_STATE"

fmt_iso() {
  local s="${1:-}"
  [ -z "$s" ] && echo "никогда" || echo "$s"
}

iso_age_min() {
  local s="${1:-}"
  [ -z "$s" ] && echo "∞" || echo "$(( ( $(date +%s) - $(date -j -f "%Y-%m-%dT%H:%M:%S" "${s%%.*}" +%s 2>/dev/null || echo 0) ) / 60 ))"
}

exec 5>"$OUT"

# shellcheck disable=SC2095
cat >&5 <<EOF
# Dashboard — $(date '+%d.%m.%Y %H:%M %Z')

EOF

# Executor-engine
{
  echo "## Executor-engine"
  execState="$OPENCLAW_HOME/executor/state.json"
  wsState="$WS_STATE/executor-state.json"
  file="$execState"
  [ -f "$wsState" ] && file="$wsState"
  if [ -f "$file" ]; then
    active=$(python3 -c "import json,sys; d=json.load(open('$file')); print(len([t for t in d.get('tasks',[]) if t.get('state') in ('compiling','running')]))" 2>/dev/null || echo "?")
    pending=$(python3 -c "import json,sys; d=json.load(open('$file')); print(len([t for t in d.get('tasks',[]) if t.get('state')=='pending_approval']))" 2>/dev/null || echo "?")
    failed=$(python3 -c "import json,sys; d=json.load(open('$file')); print(len([t for t in d.get('tasks',[]) if t.get('state')=='failed']))" 2>/dev/null || echo "?")
    last=$(python3 -c "import json,sys; d=json.load(open('$file')); print(d.get('lastPoll',''))" 2>/dev/null || echo "")
    echo "- Последний полл: $(fmt_iso "$last")"
    echo "- Активные: $active | Ожидают апрува: $pending | Зафейлено: $failed"
  else
    echo "- state не найден"
  fi
  echo ""
} >&5

# Harness
{
  echo "## Harness"
  index="$OPENCLAW_HOME/harness/index.json"
  wsIndex="$WS_STATE/harness-index.json"
  file="$index"
  [ -f "$wsIndex" ] && file="$wsIndex"
  jobsDir="$WS_STATE/jobs"
  if [ -f "$file" ]; then
    total=$(python3 -c "import json,sys; d=json.load(open('$file')); print(len(d.get('jobs',[])))" 2>/dev/null || echo "?")
    if [ -d "$jobsDir" ]; then
      running=$(find "$jobsDir" -maxdepth 1 -name '*.json' -exec python3 -c "import json,sys; d=json.load(open(sys.argv[1])); print(1 if d.get('status')=='running' else 0)" {} \; 2>/dev/null | grep -c "1" || true)
      done=$(find "$jobsDir" -maxdepth 1 -name '*.json' -exec python3 -c "import json,sys; d=json.load(open(sys.argv[1])); print(1 if d.get('status')=='done' else 0)" {} \; 2>/dev/null | grep -c "1" || true)
      failed=$(find "$jobsDir" -maxdepth 1 -name '*.json' -exec python3 -c "import json,sys; d=json.load(open(sys.argv[1])); print(1 if d.get('status')=='failed' else 0)" {} \; 2>/dev/null | grep -c "1" || true)
    else
      running="?"; done="?"; failed="?"
    fi
    echo "- Всего джоб: $total | Running: $running | Done: $done | Failed: $failed"
  else
    echo "- индекс не найден"
  fi
  echo ""
} >&5

# Git-egress
{
  echo "## Git-egress"
  file="$OPENCLAW_HOME/git-egress/state.json"
  ws="$WS_STATE/git-egress-state.json"
  [ -f "$ws" ] && file="$ws"
  if [ -f "$file" ]; then
    pending=$(python3 -c "import json,sys; d=json.load(open('$file')); print(len([t for t in d.get('tasks',[]) if t.get('state')=='pending']))" 2>/dev/null || echo "?")
    last=$(python3 -c "import json,sys; d=json.load(open('$file')); print(d.get('lastPoll',''))" 2>/dev/null || echo "")
    echo "- Очередь: $pending | Последний полл: $(fmt_iso "$last")"
  else
    echo "- state не найден"
  fi
  echo ""
} >&5

# Release-manager
{
  echo "## Release-manager"
  file="$OPENCLAW_HOME/release-manager/state.json"
  ws="$WS_STATE/release-manager-state.json"
  [ -f "$ws" ] && file="$ws"
  if [ -f "$file" ]; then
    lastRel=$(python3 -c "import json,sys; d=json.load(open('$file')); print(d.get('lastReleaseScan',''))" 2>/dev/null || echo "")
    lastRev=$(python3 -c "import json,sys; d=json.load(open('$file')); print(d.get('lastReviewerScan',''))" 2>/dev/null || echo "")
    lastVer=$(python3 -c "import json,sys; d=json.load(open('$file')); print(d.get('lastVersionScan',''))" 2>/dev/null || echo "")
    echo "- Последний RC-скан: $(fmt_iso "$lastRel")"
    echo "- Последний ревью-скан: $(fmt_iso "$lastRev")"
    echo "- Последний скан версий: $(fmt_iso "$lastVer")"
  else
    echo "- state не найден"
  fi
  echo ""
} >&5

# Cron
{
  echo "## Cron"
  file="$OPENCLAW_HOME/cron/runs.json"
  if [ -f "$file" ]; then
    count=$(python3 -c "import json,sys; d=json.load(open('$file')); print(len(d.get('runs',[])))" 2>/dev/null || echo "?")
    echo "- Записей в runs: $count"
  else
    echo "- runs.json не найден"
  fi
  echo ""
} >&5

# Telegram
{
  echo "## Telegram delivery-queue"
  file="$OPENCLAW_HOME/telegram/delivery-queue.json"
  if [ -f "$file" ]; then
    failed=$(python3 -c "import json,sys; d=json.load(open('$file')); print(len([x for x in d.get('queue',[]) if x.get('status')=='failed']))" 2>/dev/null || echo "?")
    echo "- Failed в очереди: $failed"
  else
    echo "- delivery-queue.json не найден"
  fi
  echo ""
} >&5

exec 5>&-
echo "Dashboard: $OUT"
