#!/usr/bin/env bash
# scripts/worker-pool-cleanup.sh — полная очистка всех состояний worker pool
# Использование: bash scripts/worker-pool-cleanup.sh

set -e
cd "$(dirname "$0")/.."

echo "=== Worker Pool Cleanup ==="

# 1. Очередь задач
echo -n "task-queue: "
rm -f workspace/state/task-queue/*.json workspace/state/task-queue/*.claimed workspace/state/task-queue/*.md 2>/dev/null
echo "cleared"

# 2. События
echo -n "events: "
rm -f workspace/state/events/*.json workspace/state/events/archive/*.json 2>/dev/null
echo "cleared"

# 3. Heartbeats worker'ов
echo -n "agents: "
rm -f workspace/state/agents/*.json 2>/dev/null
echo "cleared"

# 4. Архив задач
echo -n "archive: "
rm -f workspace/state/archive/*.json workspace/state/archive/*.md 2>/dev/null
echo "cleared"

# 5. Pool state (~/.openclaw/agent-worker/)
echo -n "pool-state: "
rm -f ~/.openclaw/agent-worker/pool-state.json 2>/dev/null
rm -f ~/.openclaw/agent-worker/state.json 2>/dev/null
rm -f ~/.openclaw/agent-worker/*.heartbeat.json 2>/dev/null
echo "cleared"

# 6. Task-poller state
echo -n "task-poller-state: "
rm -f ~/.openclaw/task-poller/state.json 2>/dev/null
rm -f workspace/state/task-poller-state.json 2>/dev/null
echo "cleared"

# 7. Notifier state
echo -n "notifier-state: "
rm -f ~/.openclaw/notifier/state.json 2>/dev/null
rm -f workspace/state/notifier-state.json 2>/dev/null
rm -f workspace/state/notifier-cursor.json 2>/dev/null
echo "cleared"

# 8. Supervisor log
echo -n "supervisor-log: "
rm -f workspace/state/supervisor-log.json 2>/dev/null
echo "cleared"

# 9. Clone registry (путь — из env CLONES_BASE_DIR или ~/neurodeck-clones)
echo -n "clone-registry: "
CLONE_REG="${CLONES_BASE_DIR:-$HOME/neurodeck-clones}/.clone-registry.json"
rm -f "$CLONE_REG" 2>/dev/null
echo "cleared ($CLONE_REG)"

# 10. Workspace mirrors
echo -n "workspace mirrors: "
rm -f workspace/state/pool-state.json workspace/state/executor-state.json workspace/state/agent-worker-state.json workspace/state/task-poller-state.json workspace/state/notifier-state.json workspace/state/release-manager-state.json workspace/state/git-egress-state.json workspace/state/supervisor-log.json 2>/dev/null
echo "cleared"

echo ""
echo "=== All worker pool state cleared ==="
