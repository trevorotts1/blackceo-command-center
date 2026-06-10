#!/usr/bin/env bash
# Standup Heartbeat for Mission Control
# Runs 3x daily: 8 AM, 12 PM, 5 PM Eastern
#
# PRD Addendum B.1 (P0): green definition delegated to cc-health-check.sh.
# This script no longer implements its own health signature.
# Checks for tasks in INBOX, TESTING, IN_PROGRESS, and ASSIGNED states,
# but the overall "green" gate is the B.1 deep health check.
#
# Usage:
#   CC_PORT=4000 CC_CANONICAL_DIR=/data/projects/command-center bash scripts/standup-heartbeat.sh

set -euo pipefail

# Configuration — use environment variables or defaults
MISSION_CONTROL_URL="${MISSION_CONTROL_URL:-http://localhost:4000}"
LOG_FILE="${LOG_FILE:-/tmp/standup-heartbeat.log}"
CC_PORT="${CC_PORT:-4000}"
CC_CANONICAL_DIR="${CC_CANONICAL_DIR:-}"
CC_DB_PATH="${CC_DB_PATH:-}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HEALTH_CHECK="${SCRIPT_DIR}/cc-health-check.sh"

# Logging function
log() {
    printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$1" | tee -a "$LOG_FILE"
}

log "=== Standup Heartbeat Started ==="
log "Mission Control URL: $MISSION_CONTROL_URL"

# ── B.1 deep health gate ──────────────────────────────────────────────────────
# "Green" is defined solely by cc-health-check.sh (PRD Addendum B.1).
# This script stops writing its own green signature; callers invoke cc-health-check.sh.
if [[ ! -x "$HEALTH_CHECK" ]]; then
  log "FATAL: cc-health-check.sh not found at ${HEALTH_CHECK} — cannot determine green status"
  exit 1
fi

log "Running B.1 deep health check..."
HEALTH_ARGS=(--port "$CC_PORT" --pm2-check-window 0 --json-only)
[[ -n "$CC_CANONICAL_DIR" ]] && HEALTH_ARGS+=(--canonical-dir "$CC_CANONICAL_DIR")
[[ -n "$CC_DB_PATH" ]] && HEALTH_ARGS+=(--db-path "$CC_DB_PATH")

HEALTH_JSON=""
HEALTH_EXIT=0
HEALTH_JSON=$(bash "$HEALTH_CHECK" "${HEALTH_ARGS[@]}" 2>/dev/null) || HEALTH_EXIT=$?

HEALTH_GREEN=$(printf '%s' "$HEALTH_JSON" \
  | python3 -s -c "import sys,json; d=json.load(sys.stdin); print('true' if d.get('green') else 'false')" \
  2>/dev/null || echo "false")

if [[ "$HEALTH_GREEN" != "true" ]]; then
  log "ALERT: B.1 health check NOT GREEN — standup aborting task check"
  log "Health result: ${HEALTH_JSON}"
  exit 1
fi

log "B.1 health check: GREEN — proceeding with task standup"

# ── Function to make API calls ────────────────────────────────────────────────
api_call() {
    local method="$1"
    local endpoint="$2"
    local data="${3:-}"

    if [ -n "$data" ]; then
        curl -s -X "$method" "$MISSION_CONTROL_URL$endpoint" \
            -H "Content-Type: application/json" \
            -d "$data" 2>/dev/null || echo '{"error": "API call failed"}'
    else
        curl -s -X "$method" "$MISSION_CONTROL_URL$endpoint" 2>/dev/null || echo '{"error": "API call failed"}'
    fi
}

# Helper: safe task count without the grep 0\n0 bug
count_task_ids() {
    local payload="$1"
    local count
    count=$(printf '%s' "$payload" | grep -o '"id"' | wc -l | tr -d ' ')
    echo "${count:-0}"
}

# Step 1: Check for INBOX tasks
log "Checking INBOX tasks..."
INBOX_TASKS=$(api_call "GET" "/api/tasks?status=inbox")
INBOX_COUNT=$(count_task_ids "$INBOX_TASKS")
log "Found $INBOX_COUNT tasks in INBOX"

# Step 2: Check TESTING tasks and trigger auto-tests
log "Checking TESTING tasks..."
TESTING_TASKS=$(api_call "GET" "/api/tasks?status=testing")
TESTING_COUNT=$(count_task_ids "$TESTING_TASKS")
log "Found $TESTING_COUNT tasks in TESTING"

# Auto-test each TESTING task
if [ "$TESTING_COUNT" -gt 0 ]; then
    echo "$TESTING_TASKS" | grep -o '"id":"[^"]*"' | cut -d'"' -f4 | while read -r task_id; do
        log "Running auto-test for task: $task_id"
        TEST_RESULT=$(api_call "POST" "/api/tasks/$task_id/test" "{}")
        log "Test result for $task_id: $(echo "$TEST_RESULT" | grep -o '"success":[a-z]*' || echo 'unknown')"
    done
fi

# Step 3: Check IN_PROGRESS tasks
log "Checking IN_PROGRESS tasks..."
IN_PROGRESS_TASKS=$(api_call "GET" "/api/tasks?status=in_progress")
IN_PROGRESS_COUNT=$(count_task_ids "$IN_PROGRESS_TASKS")
log "Found $IN_PROGRESS_COUNT tasks in IN_PROGRESS"

# Step 4: Check ASSIGNED tasks (rework loop)
log "Checking ASSIGNED tasks..."
ASSIGNED_TASKS=$(api_call "GET" "/api/tasks?status=assigned")
ASSIGNED_COUNT=$(count_task_ids "$ASSIGNED_TASKS")
log "Found $ASSIGNED_COUNT tasks in ASSIGNED (rework loop)"

# Summary
log "=== Standup Heartbeat Summary ==="
log "INBOX: $INBOX_COUNT | TESTING: $TESTING_COUNT | IN_PROGRESS: $IN_PROGRESS_COUNT | ASSIGNED: $ASSIGNED_COUNT"

# Alert if work needs attention
if [ "$INBOX_COUNT" -gt 0 ] || [ "$ASSIGNED_COUNT" -gt 0 ]; then
    log "ALERT: Tasks require attention!"
    exit 1
fi

log "=== Standup Heartbeat Completed Successfully ==="
exit 0
