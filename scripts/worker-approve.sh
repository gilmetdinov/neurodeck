#!/usr/bin/env bash
# scripts/worker-approve.sh — ручной approve задачи для worker pool
# Использование: bash scripts/worker-approve.sh [task_id]
# Без аргументов показывает текущий статус

cd "$(dirname "$0")/.."

POOL_STATE="$HOME/.openclaw/agent-worker/pool-state.json"

if [ ! -f "$POOL_STATE" ]; then
  echo "Нет pool-state.json — worker pool не запущен или нет задач"
  exit 1
fi

if [ "${1:-}" = "--status" ] || [ -z "${1:-}" ]; then
  echo "=== Worker pool status ==="
  python3 -c "
import json, sys
with open('$POOL_STATE') as f:
    data = json.load(f)
for t in data.get('tasks', []):
    icon = '🟡' if t['state'] == 'pending_approval' else '✅' if t['state'] == 'done' else '❌'
    print(f\"{icon} #{t['redmine_id']} — {t['state']} | worker: {t.get('worker','?')} | repo: {t.get('repo','?')}\")
if not data.get('tasks'):
    print('(пусто)')
"
  exit 0
fi

TASK_ID="$1"

python3 -c "
import json
with open('$POOL_STATE') as f:
    data = json.load(f)
found = False
for t in data.get('tasks', []):
    if t['task_id'] == '$TASK_ID' or str(t['redmine_id']) == '$TASK_ID':
        if t['state'] == 'pending_approval':
            t['state'] = 'approved'
            found = True
            print(f'✅ #{t[\"redmine_id\"]} approved → worker запустит в следующем тике')
        else:
            print(f'⚠️ #{t[\"redmine_id\"]} уже в статусе {t[\"state\"]} (не pending_approval)')
            found = True
if not found:
    print(f'❌ Задача \"$TASK_ID\" не найдена в pool-state')
else:
    with open('$POOL_STATE', 'w') as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
"
