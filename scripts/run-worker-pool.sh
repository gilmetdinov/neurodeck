#!/usr/bin/env bash
# scripts/run-worker-pool.sh — запуск / остановка worker pool серверов
# Использование:
#   bash scripts/run-worker-pool.sh              # запустить
#   bash scripts/run-worker-pool.sh --build      # собрать и запустить
#   bash scripts/run-worker-pool.sh --stop       # остановить

set -e
cd "$(dirname "$0")/.."

LOG_DIR="logs/worker-pool"
PID_DIR="$LOG_DIR"
mkdir -p "$LOG_DIR"

STOP=false
BUILD=false
for arg in "$@"; do
  case "$arg" in
    --stop)  STOP=true ;;
    --build) BUILD=true ;;
  esac
done

stop_all() {
  echo "=== Stopping worker pool ==="
  for f in "$PID_DIR"/*.pid; do
    if [ -f "$f" ]; then
      local name=$(basename "$f" .pid)
      local pid=$(cat "$f")
      if kill -0 "$pid" 2>/dev/null; then
        kill "$pid" 2>/dev/null && echo "  stopped $name (pid=$pid)"
      fi
      rm -f "$f"
    fi
  done
  echo "=== All stopped ==="
}

if $STOP; then
  stop_all
  exit 0
fi

# Kill existing before starting
stop_all

# Source env
echo "=== Loading .env ==="
set -a && source .env && set +a
export DRY_RUN="${DRY_RUN:-true}"

# Build if requested
if $BUILD; then
  echo "=== Building servers ==="
  npm run build:task-poller
  npm run build:agent-worker
  npm run build:notifier
  echo "=== Build OK ==="
fi

echo ""
echo "=== Starting Worker Pool ==="

# Task Poller
echo -n "  task-poller: "
node mcp-servers/task-poller/dist/index.js > "$LOG_DIR/task-poller.log" 2>&1 &
echo $! > "$PID_DIR/task-poller.pid"
echo "pid=$! (log: $LOG_DIR/task-poller.log)"

# Agent Worker
echo -n "  agent-worker (worker-1): "
WORKER_ID=worker-1 node mcp-servers/agent-worker/dist/index.js > "$LOG_DIR/agent-worker.log" 2>&1 &
echo $! > "$PID_DIR/agent-worker.pid"
echo "pid=$! (log: $LOG_DIR/agent-worker.log)"

# Notifier
echo -n "  notifier: "
node mcp-servers/notifier/dist/index.js > "$LOG_DIR/notifier.log" 2>&1 &
echo $! > "$PID_DIR/notifier.pid"
echo "pid=$! (log: $LOG_DIR/notifier.log)"

# Supervisor
echo -n "  supervisor: "
node scripts/supervisor-watch.mjs --interval-ms=60000 > "$LOG_DIR/supervisor.log" 2>&1 &
echo $! > "$PID_DIR/supervisor.pid"
echo "pid=$! (log: $LOG_DIR/supervisor.log)"

echo ""
echo "=== Worker Pool запущен ==="
echo ""
echo "Управление:"
echo "  bash scripts/run-worker-pool.sh --stop   # остановить всё"
echo "  tail -f $LOG_DIR/*.log                    # смотреть логи"
echo ""
sleep 2
echo "=== Первые строки логов ==="
for name in task-poller agent-worker notifier supervisor; do
  echo "--- $name ---"
  head -3 "$LOG_DIR/$name.log" 2>/dev/null || echo "(нет лога)"
done
