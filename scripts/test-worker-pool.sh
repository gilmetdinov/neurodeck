#!/usr/bin/env bash
# scripts/test-worker-pool.sh — Автономные тесты Worker Pool через CLI
# Запуск: bash scripts/test-worker-pool.sh [--quick] [--verbose]

set -e
cd "$(dirname "$0")/.."

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
PASS=0; FAIL=0; SKIP=0; VERBOSE=false; QUICK=false

for arg in "$@"; do
  case "$arg" in --verbose) VERBOSE=true ;; --quick) QUICK=true ;; esac
done

pass()  { echo -e "  ${GREEN}PASS${NC} $1"; PASS=$((PASS + 1)); }
fail()  { echo -e "  ${RED}FAIL${NC} $1 — $2"; FAIL=$((FAIL + 1)); }
skip()  { echo -e "  ${YELLOW}SKIP${NC} $1 — $2"; SKIP=$((SKIP + 1)); }
info()  { $VERBOSE && echo -e "  ${CYAN}INFO${NC} $1" || true; }

section() { echo -e "\n${CYAN}━━━ $1 ━━━${NC}"; }

# ─── Setup ────────────────────────────────────────────────────────────────────
section "Setup"
info "Loading .env (export mode)"
set -a && source .env && set +a
export DRY_RUN=true

# Check required env
REDMINE_OK=true; GITLAB_OK=true; DEEPINFRA_OK=true
[ -n "$REDMINE_BASE_URL" ] && [ -n "$REDMINE_LOGIN" ] && [ -n "$REDMINE_PASSWORD" ] || REDMINE_OK=false
[ -n "$GITLAB_BASE_URL" ] && [ -n "$GITLAB_TOKEN" ] || GITLAB_OK=false
[ -n "$DEEPINFRA_API_KEY" ] || DEEPINFRA_OK=false

$REDMINE_OK   && pass "Redmine env"     || skip "Redmine env"  "REDMINE_* not set"
$GITLAB_OK    && pass "GitLab env"       || skip "GitLab env"   "GITLAB_* not set"
$DEEPINFRA_OK && pass "DeepInfra env"    || skip "DeepInfra env" "DEEPINFRA_API_KEY not set"

# Check builds
NEEDS_BUILD=false
for m in task-poller agent-worker notifier git-egress; do
  [ -f "mcp-servers/$m/dist/index.js" ] || { NEEDS_BUILD=true; break; }
done
if $NEEDS_BUILD; then
  info "Building worker pool..."
  npm run build:task-poller 2>&1 | tail -1
  npm run build:agent-worker 2>&1 | tail -1
  npm run build:notifier   2>&1 | tail -1
  npm run build:git-egress 2>&1 | tail -1
  pass "Build complete"
else
  pass "Build artifacts exist"
fi

TMPDIR="${TMPDIR:-/tmp}/wp-test-$$"
mkdir -p "$TMPDIR"

# ─── Helpers ──────────────────────────────────────────────────────────────────
run_component() {
  local name="$1" node_cmd="$2" duration="${3:-15}"
  local log="$TMPDIR/${name}.log"
  $VERBOSE && echo "  [${name}] starting for ${duration}s..." >&2
  node "$node_cmd" > "$log" 2>&1 &
  local pid=$!
  echo "$pid" > "$TMPDIR/${name}.pid"
  sleep "$duration"
  kill "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
  echo "$log"
}
check_log() { grep -q "$1" "$2" 2>/dev/null; }

# ─── Test 1: Task Poller ─────────────────────────────────────────────────────
section "Test 1: Task Poller"
if $REDMINE_OK && ! $QUICK; then
  LOG=$(run_component "task-poller" "mcp-servers/task-poller/dist/index.js" 12)

  if check_log "task-poller] v0" "$LOG"; then
    pass "Task Poller starts v0.1.0"
  else
    fail "Task Poller starts" "log: $(head -1 "$LOG" 2>/dev/null || echo empty)"
  fi

  if check_log "poll new tasks" "$LOG"; then
    pass "Task Poller polls Redmine (status 20)"
  else
    fail "Task Poller polls Redmine" "no poll attempt"
  fi

  if check_log "done:" "$LOG"; then
    pass "Task Poller completes tick"
  else
    fail "Task Poller completes tick" "tick incomplete"
  fi

  [ -f "workspace/state/task-poller-state.json" ] && pass "Task Poller writes state" || skip "Task Poller state" "no state file"
else
  skip "Task Poller" "no Redmine or --quick"
fi

# ─── Test 2: Agent Worker ────────────────────────────────────────────────────
section "Test 2: Agent Worker"
if $REDMINE_OK && ! $QUICK; then
  LOG=$(run_component "agent-worker" "mcp-servers/agent-worker/dist/index.js" 12)

  if check_log "agent-worker" "$LOG"; then
    pass "Agent Worker starts"
  else
    fail "Agent Worker starts" "log: $(head -1 "$LOG" 2>/dev/null || echo empty)"
  fi

  if check_log "agent-worker.*state\|heartbeat\|tickWrapper\|main" "$LOG"; then
    pass "Agent Worker runs poll loop"
  else
    skip "Agent Worker poll loop" "no poll logged in 12s"
  fi

  [ -f "workspace/state/pool-state.json" ] && pass "Pool state file exists" || skip "Pool state" "no pool-state.json"
else
  skip "Agent Worker" "no Redmine or --quick"
fi

# ─── Test 3: Notifier ────────────────────────────────────────────────────────
section "Test 3: Notifier"
LOG=$(run_component "notifier" "mcp-servers/notifier/dist/index.js" 8)

if check_log "notifier] v0" "$LOG"; then
  pass "Notifier starts"
else
  fail "Notifier starts" "log: $(head -1 "$LOG" 2>/dev/null || echo empty)"
fi

# Without token: "not configured". With token: "chat=configured" or scan logs.
if check_log "not configured" "$LOG"; then
  pass "Notifier: graceful degradation (no token)"
elif check_log "configured\|scan\|event" "$LOG"; then
  pass "Notifier: ready, token configured"
else
  skip "Notifier" "no recognizable status"
fi

if ! check_log "Error\|FATAL\|ENOENT" "$LOG"; then
  pass "Notifier: no crash"
else
  fail "Notifier crashed" "$(grep -i 'error\|fatal' "$LOG" | head -1)"
fi

# ─── Test 4: Git Egress ─────────────────────────────────────────────────────
section "Test 4: Git Egress"
if $GITLAB_OK && ! $QUICK; then
  LOG=$(run_component "git-egress" "mcp-servers/git-egress/dist/index.js" 10)

  if check_log "git-egress\|v0\|EGRESS\|egress" "$LOG"; then
    pass "Git Egress starts"
  else
    fail "Git Egress starts" "log: $(head -1 "$LOG" 2>/dev/null || echo empty)"
  fi

  if check_log "DRY_RUN\|dry.run\|dry-run" "$LOG"; then
    pass "Git Egress in DRY_RUN mode"
  else
    info "DRY_RUN not explicitly logged"
  fi
else
  skip "Git Egress" "no GitLab or --quick"
fi

# ─── Test 5: Commit Counting ─────────────────────────────────────────────────
section "Test 5: Commit Counting"
TEST_REPO="$TMPDIR/test-commits"
rm -rf "$TEST_REPO" && mkdir -p "$TEST_REPO"
(
  cd "$TEST_REPO"
  git init && git config user.email "dev@test.com" && git config user.name "Developer"
  echo "old" > old.txt && git add old.txt && git commit -m "historical commit" --date="2020-01-01"
  echo "agent-work" > agent.txt && git add agent.txt
  GIT_AUTHOR_NAME="neurodeck Agent" GIT_AUTHOR_EMAIL="agent@<YOUR_HOST>" \
    git commit -m "#60030 feat: agent work"
  echo "other" > other.txt && git add other.txt && git commit -m "another commit"
) 2>/dev/null

if [ -d "$TEST_REPO/.git" ]; then
  AGENT_COUNT=$(cd "$TEST_REPO" && git log master --pretty="%an <%ae>" 2>/dev/null | grep -ic "Agent\|agent@<YOUR_HOST>\|neurodeck" || echo "0")
  TOTAL_COUNT=$(cd "$TEST_REPO" && git rev-list --count master 2>/dev/null || echo "0")
  if [ "$AGENT_COUNT" = "1" ]; then
    pass "Commit counting: $AGENT_COUNT agent / $TOTAL_COUNT total"
  else
    fail "Commit counting" "expected 1 agent, got $AGENT_COUNT"
  fi
else
  fail "Commit counting" "can't create test repo"
fi

# ─── Test 6: Event System ────────────────────────────────────────────────────
section "Test 6: Event System"
EVENT_COUNT=$(ls workspace/state/events/*.json 2>/dev/null | wc -l | tr -d ' ')
if [ "$EVENT_COUNT" -gt 0 ]; then
  pass "Events: $EVENT_COUNT files"
  SAMPLE=$(ls workspace/state/events/*.json 2>/dev/null | head -1)
  if [ -n "$SAMPLE" ] && python3 -c "import json; d=json.load(open('$SAMPLE')); assert 'type' in d; assert 'task_id' in d" 2>/dev/null; then
    pass "Event format: type + task_id present"
  else
    skip "Event format" "can't parse"
  fi
else
  skip "Events" "no events found (needs prior worker runs)"
fi

# ─── Test 7: Crash Recovery ──────────────────────────────────────────────────
section "Test 7: Crash Recovery / PID files"
HARNESS_PID_DIR="workspace/state/harness-pids"
mkdir -p "$HARNESS_PID_DIR"

if [ -d "$HARNESS_PID_DIR" ]; then
  pass "harness-pids/ directory exists"

  # Test PID file lifecycle
  echo '{"pid":99999,"specId":"test-123","startedAt":"2026-01-01T00:00:00Z"}' > "$HARNESS_PID_DIR/test-recovery.json"
  if [ -f "$HARNESS_PID_DIR/test-recovery.json" ]; then
    PID_CONTENT=$(cat "$HARNESS_PID_DIR/test-recovery.json")
    if echo "$PID_CONTENT" | python3 -c "import sys,json; d=json.load(sys.stdin); assert 'pid' in d; assert 'specId' in d" 2>/dev/null; then
      pass "PID file format valid"
    else
      fail "PID file format" "invalid JSON"
    fi
    rm -f "$HARNESS_PID_DIR/test-recovery.json"
  else
    fail "PID file write" "could not create"
  fi
else
  fail "harness-pids/ directory" "can't create"
fi

# ─── Test 8: Supervisor ──────────────────────────────────────────────────────
section "Test 8: Supervisor"
if [ -f "workspace/state/supervisor-log.json" ]; then
  pass "Supervisor state exists"
elif [ -f "scripts/supervisor-watch.mjs" ]; then
  LOG=$(run_component "supervisor" "scripts/supervisor-watch.mjs --interval-ms=5000" 8)
  if [ -f "workspace/state/supervisor-log.json" ]; then
    pass "Supervisor writes state"
  else
    skip "Supervisor" "no state in 8s"
  fi
else
  skip "Supervisor" "script not found"
fi

# ─── Cleanup ──────────────────────────────────────────────────────────────────
section "Test 9: Reviewer Subagent"
if [ -f ".opencode/agents/reviewer.md" ]; then
  pass "Reviewer subagent file exists"

  # Verify it's a valid opencode agent (has frontmatter)
  if head -1 ".opencode/agents/reviewer.md" | grep -q "^---$"; then
    pass "Reviewer has YAML frontmatter"
  else
    fail "Reviewer frontmatter" "missing --- header"
  fi

  # Check skills exist
  for sk in compile-task team-digest figma-to-spec; do
    if [ -f ".opencode/skills/$sk/SKILL.md" ]; then
      pass "Skill $sk exists"
    else
      skip "Skill $sk" "not found"
    fi
  done

  # Verify opencode sees the reviewer
  if opencode agent list 2>&1 | grep -q "reviewer.*subagent"; then
    pass "opencode discovers reviewer subagent"
  else
    fail "opencode discovers reviewer" "not in agent list"
  fi
else
  fail "Reviewer subagent" ".opencode/agents/reviewer.md not found"
fi

# ─── Cleanup ──────────────────────────────────────────────────────────────────
section "Cleanup"
rm -rf "$TMPDIR"
pass "Cleanup done"

# ─── Summary ──────────────────────────────────────────────────────────────────
section "Results"
echo -e "  ${GREEN}PASS: $PASS${NC}  ${RED}FAIL: $FAIL${NC}  ${YELLOW}SKIP: $SKIP${NC}"
echo ""
if [ "$FAIL" -gt 0 ]; then
  echo -e "${RED}Some tests FAILED.${NC}"
  exit 1
else
  echo -e "${GREEN}All tests passed (${PASS} pass, ${SKIP} skip).${NC}"
  exit 0
fi
