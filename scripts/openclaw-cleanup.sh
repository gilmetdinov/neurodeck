#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────
# openclaw-cleanup.sh — ротация по требованию накопленного «мусора» в ~/.openclaw.
#
# OpenClaw не чистит за собой: транскрипты сессий (agents/main/sessions) и авто-
# бэкапы конфига (openclaw.json.bak.*) копятся бесконечно. Этот скрипт режет ТОЛЬКО
# историю/debug, не трогая ничего функционального.
#
# Удаляет:
#   • agents/main/sessions/*.jsonl.reset.*    (архивы после /new·/reset)
#   • agents/main/sessions/*.trajectory.jsonl (детальные траектории, debug)
#   • openclaw.json.bak.*                      (кроме N свежих)
#   • harness/jobs/*.json старше 30 дней (done/failed/canceled)
#   • telegram/delivery-queue.json failed старше 7 дней
#   • cron/runs.json записи старше 30 дней
# всё — старше порога по mtime (см. --days). Файлы свежее 24ч НЕ трогаются никогда
# (защита активной сессии: её файлы всегда свежие).
#
# НЕ ТРОГАЕТ (сакральное): executor/state.json, git-egress/state.json, harness/index.json,
#   cron/tasks/ commitments/ identity/ flows/ plugins*/ openclaw.json openclaw.json.last-good,
#   а также живые переписки сессий <id>.jsonl (вдруг резюмишь) — режутся только .reset/.trajectory.
#
# Usage:
#   bash scripts/openclaw-cleanup.sh                 # DRY-RUN: только показать
#   bash scripts/openclaw-cleanup.sh --apply         # реально удалить
#   bash scripts/openclaw-cleanup.sh --days 14       # порог 14 суток (дефолт 7)
#   bash scripts/openclaw-cleanup.sh --keep-bak 5    # оставить 5 свежих бэкапов (дефолт 3)
#   bash scripts/openclaw-cleanup.sh --workspace     # заодно чистит workspace/state/
#   bash scripts/openclaw-cleanup.sh --full           # ПОЛНАЯ очистка: игнорирует порог дней, всё под нож
#   npm run cleanup:openclaw -- --apply
# ─────────────────────────────────────────────────────────────────────────
set -euo pipefail

OPENCLAW_DIR="${OPENCLAW_DIR:-$HOME/.openclaw}"
SESS_DIR="$OPENCLAW_DIR/agents/main/sessions"
DAYS=7
KEEP_BAK=3
APPLY=0
CLEAN_WORKSPACE=0
FULL=0

usage() {
  sed -n '2,34p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

while [ $# -gt 0 ]; do
  case "$1" in
    --apply)        APPLY=1 ;;
    --workspace)    CLEAN_WORKSPACE=1 ;;
    --full)         FULL=1 ;;
    --days)         DAYS="${2:?--days требует число}"; shift ;;
    --days=*)       DAYS="${1#*=}" ;;
    --keep-bak)     KEEP_BAK="${2:?--keep-bak требует число}"; shift ;;
    --keep-bak=*)   KEEP_BAK="${1#*=}" ;;
    -h|--help)      usage; exit 0 ;;
    *) echo "✗ неизвестный аргумент: $1"; echo "  --help для справки"; exit 1 ;;
  esac
  shift
done

case "$DAYS" in (*[!0-9]*|'') echo "✗ --days должен быть числом: '$DAYS'"; exit 1 ;; esac
case "$KEEP_BAK" in (*[!0-9]*|'') echo "✗ --keep-bak должен быть числом: '$KEEP_BAK'"; exit 1 ;; esac
[ -d "$OPENCLAW_DIR" ] || { echo "✗ нет каталога: $OPENCLAW_DIR"; exit 1; }

# размер файла в байтах (BSD/macOS → GNU фолбэк); байты → человекочитаемо
fsize() { stat -f%z "$1" 2>/dev/null || stat -c%s "$1" 2>/dev/null || echo 0; }
human() { awk -v b="${1:-0}" 'BEGIN{ split("B K M G T",u," "); i=1; while(b>=1024 && i<5){b/=1024;i++}; printf (i==1?"%d%s\n":"%.1f%s\n"), b, u[i] }'; }

# Предупреждение, если gateway жив (активную сессию защитит порог 24ч, но полная чистка лучше на стопе)
if lsof -nP -iTCP:18789 -sTCP:LISTEN -t >/dev/null 2>&1; then
  echo "⚠  gateway похоже запущен (порт 18789). Активную сессию НЕ трону (всё свежее 24ч защищено),"
  echo "   но для полной чистки лучше остановить gateway."
fi

# ── Сбор кандидатов ──────────────────────────────────────────────────────
candidates=()
if [ -d "$SESS_DIR" ]; then
  if [ "$FULL" -eq 1 ]; then
    # --full: все сессионные файлы (кроме активных — mtime +0 = старше 24ч)
    while IFS= read -r -d '' f; do candidates+=("$f"); done < <(
      find "$SESS_DIR" -type f \( -name '*.jsonl*' \) -mtime +0 -print0
    )
  else
    # reset-архивы + траектории старше $DAYS суток
    while IFS= read -r -d '' f; do candidates+=("$f"); done < <(
      find "$SESS_DIR" -type f \( -name '*.jsonl.reset.*' -o -name '*.trajectory.jsonl' \) -mtime +"$DAYS" -print0
    )
  fi
fi

# Старые бэкапы конфига
if [ "$FULL" -eq 1 ]; then
  # --full: ВСЕ бэкапы
  while IFS= read -r f; do [ -n "$f" ] && candidates+=("$f"); done < <(
    ls -t "$OPENCLAW_DIR"/openclaw.json.bak.* 2>/dev/null
  )
else
  # оставляем $KEEP_BAK свежих, остальные — в кандидаты
  while IFS= read -r f; do [ -n "$f" ] && candidates+=("$f"); done < <(
    ls -t "$OPENCLAW_DIR"/openclaw.json.bak.* 2>/dev/null | tail -n +"$((KEEP_BAK+1))"
  )
fi

# ── cleanup state-файлов (спек 06) ───────────────────────────────────────
# harness/jobs
if [ -d "$OPENCLAW_DIR/harness/jobs" ]; then
  if [ "$FULL" -eq 1 ]; then
    while IFS= read -r -d '' f; do candidates+=("$f"); done < <(
      find "$OPENCLAW_DIR/harness/jobs" -type f -name '*.json' -print0
    )
  else
    while IFS= read -r -d '' f; do candidates+=("$f"); done < <(
      find "$OPENCLAW_DIR/harness/jobs" -type f -name '*.json' -mtime +30 -print0
    )
  fi
fi
# telegram/delivery-queue: failed старше 7 дней — JSON patch, не удаление файла
if [ -f "$OPENCLAW_DIR/telegram/delivery-queue.json" ]; then
  tmp_queue="$(mktemp)"
  python3 -c "
import json,sys,datetime
f=sys.argv[1]
try:
  with open(f) as fh: d=json.load(fh)
except: d={}
now=datetime.datetime.now()
cutoff=now-datetime.timedelta(days=7)
keep=[]
for x in d.get('queue',[]):
  if x.get('status')=='failed':
    ts=x.get('updated_at') or x.get('created_at')
    if ts:
      try: t=datetime.datetime.fromisoformat(ts.replace('Z','+00:00').replace('+00:00',''))
      except: t=now
      if t<cutoff: continue
  keep.append(x)
d['queue']=keep
with open(f,'w') as fh: json.dump(d,fh,indent=2,ensure_ascii=False)
" "$OPENCLAW_DIR/telegram/delivery-queue.json" 2>/dev/null || true
fi
# cron/runs: записи старше 30 дней — JSON patch
if [ -f "$OPENCLAW_DIR/cron/runs.json" ]; then
  python3 -c "
import json,sys,datetime
f=sys.argv[1]
try:
  with open(f) as fh: d=json.load(fh)
except: d={}
now=datetime.datetime.now()
cutoff=now-datetime.timedelta(days=30)
keep=[]
for x in d.get('runs',[]):
  ts=x.get('started_at') or x.get('created_at')
  if ts:
    try: t=datetime.datetime.fromisoformat(ts.replace('Z','+00:00').replace('+00:00',''))
    except: t=now
    if t<cutoff: continue
  keep.append(x)
d['runs']=keep
with open(f,'w') as fh: json.dump(d,fh,indent=2,ensure_ascii=False)
" "$OPENCLAW_DIR/cron/runs.json" 2>/dev/null || true
fi

n=${#candidates[@]}

# ── WORKSPACE STATE сбор (если флаг --workspace) ──────────────────────────
ws_candidates=()
ws_patched=0
WS_STATE=""
if [ "$CLEAN_WORKSPACE" -eq 1 ]; then
  REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  WS_STATE="$REPO_ROOT/workspace/state"
  if [ -d "$WS_STATE" ]; then
    if [ "$FULL" -eq 1 ]; then
      # --full: ВСЕ workspace state-файлы (кроме .gitkeep и dashboard.md)
      while IFS= read -r -d '' f; do ws_candidates+=("$f"); done < <(
        find "$WS_STATE" -type f \( -name '*.json' -o -name '*.md' \) ! -name '.gitkeep' ! -name 'dashboard.md' -print0 2>/dev/null
      )
      ws_patched=-1  # маркер: полный сброс harness-index
    else
      # harness jobs старше 30 дней
      if [ -d "$WS_STATE/jobs" ]; then
        while IFS= read -r -d '' f; do ws_candidates+=("$f"); done < <(
          find "$WS_STATE/jobs" -type f -name '*.json' -mtime +30 -print0 2>/dev/null
        )
      fi
      # зеркала старше 7 дней → пересоздадутся на следующем тике MCP
      for mirror in executor-state.json git-egress-state.json release-manager-state.json; do
        mp="$WS_STATE/$mirror"
        if [ -f "$mp" ] && find "$mp" -mtime +7 -print0 2>/dev/null | grep -qz .; then
          ws_candidates+=("$mp")
        fi
      done
      # harness-index.json: посчитать старые read_reports (сухим прогоном)
      if [ -f "$WS_STATE/harness-index.json" ]; then
        removed_reports=$(python3 -c "
import json,re,datetime,sys
f=sys.argv[1]; d=int(sys.argv[2])
try:
  with open(f) as fh: data=json.load(fh)
except: data={}
now=datetime.datetime.now()
cutoff=now-datetime.timedelta(days=d)
removed=0
for r in data.get('read_reports',[]):
  m=re.search(r'(\d{4}-\d{2}-\d{2}|\d{8})', r)
  if m:
    ds=m.group(1)
    try:
      if len(ds)==8: dt=datetime.datetime.strptime(ds,'%Y%m%d')
      else: dt=datetime.datetime.strptime(ds,'%Y-%m-%d')
      if dt<cutoff: removed+=1
    except: pass
print(removed)
" "$WS_STATE/harness-index.json" "$DAYS" 2>/dev/null || echo 0)
        [ "$removed_reports" -gt 0 ] && ws_patched=$removed_reports
      fi
    fi
  fi
fi

if [ "$n" -eq 0 ] && [ "${#ws_candidates[@]}" -eq 0 ] && [ "$ws_patched" -eq 0 ]; then
  echo "✓ чистить нечего (порог: старше ${DAYS} сут; бэкапов оставляем ${KEEP_BAK})."
  exit 0
fi

# ── Отчёт (общий) ─────────────────────────────────────────────────────────
if [ "$n" -gt 0 ]; then
  total=0
  for f in "${candidates[@]}"; do total=$((total + $(fsize "$f"))); done
  echo "Кандидаты ~/.openclaw: ${n} файлов, ~$(human "$total")  (порог: старше ${DAYS} сут, keep-bak=${KEEP_BAK})"
  for f in "${candidates[@]}"; do
    printf '  %8s  %s\n' "$(human "$(fsize "$f")")" "${f#"$OPENCLAW_DIR"/}"
  done
fi

ws_n=${#ws_candidates[@]}
if [ "$ws_n" -gt 0 ] || [ "$ws_patched" -ne 0 ]; then
  echo
  echo "=== workspace/state ==="
  if [ "$ws_n" -gt 0 ]; then
    ws_total=0
    for f in "${ws_candidates[@]}"; do ws_total=$((ws_total + $(fsize "$f"))); done
    echo "Файлы к удалению: ${ws_n}, ~$(human "$ws_total")"
    for f in "${ws_candidates[@]}"; do
      printf '  %8s  %s\n' "$(human "$(fsize "$f")")" "${f#"$REPO_ROOT"/}"
    done
  fi
  if [ "$ws_patched" -eq -1 ]; then
    echo "harness-index.json: ПОЛНЫЙ СБРОС (read_reports + jobs)"
  elif [ "$ws_patched" -gt 0 ]; then
    echo "harness-index.json: -${ws_patched} старых read_reports"
  fi
fi

if [ "$APPLY" -ne 1 ]; then
  echo
  if [ "$FULL" -eq 1 ]; then
    echo "⚠  --full: ПОЛНАЯ очистка (игнорируются все пороги возраста)."
  fi
  echo "DRY-RUN — ничего не удалено. Повтори с --apply, чтобы удалить."
  exit 0
fi

if [ "$FULL" -eq 1 ]; then
  echo "⚠  --full + --apply: удаляю ВСЁ, без ограничений по возрасту."
fi

# ── Удаление ~/.openclaw ──────────────────────────────────────────────────
if [ "$n" -gt 0 ]; then
  freed=0
  for f in "${candidates[@]}"; do
    sz=$(fsize "$f")
    rm -f "$f" && freed=$((freed + sz))
  done
  echo "✓ ~/.openclaw: удалено ${n} файлов, освобождено ~$(human "$freed")."
fi

# ── Удаление workspace ────────────────────────────────────────────────────
if [ "$ws_n" -gt 0 ]; then
  ws_freed=0
  for f in "${ws_candidates[@]}"; do
    sz=$(fsize "$f")
    rm -f "$f" && ws_freed=$((ws_freed + sz))
  done
  echo "✓ workspace: удалено ${ws_n} файлов, освобождено ~$(human "$ws_freed")."
fi

# harness-index.json: вырезать старые read_reports (всегда, если --workspace, не зависит от APPLY)
if [ "$CLEAN_WORKSPACE" -eq 1 ] && [ -f "$WS_STATE/harness-index.json" ] && [ "$ws_patched" -ne 0 ]; then
  python3 -c "
import json,re,datetime,sys
f=sys.argv[1]; d=int(sys.argv[2]); dry=int(sys.argv[3]); full=int(sys.argv[4])
try:
  with open(f) as fh: data=json.load(fh)
except: data={'jobs':[],'read_reports':[]}
if full:
  if dry:
    rp=len(data.get('read_reports',[])); jb=len(data.get('jobs',[]))
    print(f'DRY-RUN: ПОЛНЫЙ СБРОС harness-index ({rp} read_reports, {jb} jobs)')
  else:
    data={'jobs':[],'read_reports':[],'agent_cursor':0}
    with open(f,'w') as fh: json.dump(data,fh,indent=2,ensure_ascii=False)
    print('✓ harness-index: ПОЛНЫЙ СБРОС')
else:
  now=datetime.datetime.now(); cutoff=now-datetime.timedelta(days=d)
  kept=[]; removed=0
  for r in data.get('read_reports',[]):
    m=re.search(r'(\d{4}-\d{2}-\d{2}|\d{8})', r)
    if m:
      ds=m.group(1)
      try:
        if len(ds)==8: dt=datetime.datetime.strptime(ds,'%Y%m%d')
        else: dt=datetime.datetime.strptime(ds,'%Y-%m-%d')
        if dt<cutoff: removed+=1; continue
      except: pass
    kept.append(r)
  if dry:
    print(f'DRY-RUN: убрал бы {removed} старых read_reports из harness-index.json (оставлено {len(kept)})')
  else:
    data['read_reports']=kept
    data['jobs']=[j for j in data.get('jobs',[]) if len(j)>3]
    with open(f,'w') as fh: json.dump(data,fh,indent=2,ensure_ascii=False)
    print(f'✓ harness-index: -{removed} read_reports (оставлено {len(kept)})')
" "$WS_STATE/harness-index.json" "$DAYS" "$([ "$APPLY" -eq 1 ] && echo 0 || echo 1)" "$FULL" 2>/dev/null || true
fi
