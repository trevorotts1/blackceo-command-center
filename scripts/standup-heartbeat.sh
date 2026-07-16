#!/bin/bash
# Standup Heartbeat for Mission Control
# Runs 3x daily: 8 AM, 12 PM, 5 PM Eastern
# Checks for tasks in INBOX, TESTING, IN_PROGRESS, and ASSIGNED states
#
# B.1 integration: delegates green/red verdict to scripts/cc-health-check.sh.
# This script does NOT implement its own health signature — it calls the single
# definition of green.  Exit 3 (UNKNOWN/indeterminate) is logged as transient,
# NOT treated as not-green.

set -e

# Configuration - use environment variable or default
MISSION_CONTROL_URL="${MISSION_CONTROL_URL:-http://localhost:4000}"
LOG_FILE="${LOG_FILE:-/tmp/standup-heartbeat.log}"

# Logging function
log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" | tee -a "$LOG_FILE"
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HEALTH_SCRIPT="$SCRIPT_DIR/cc-health-check.sh"

log "=== Standup Heartbeat Started ==="
log "Mission Control URL: $MISSION_CONTROL_URL"

# B.1: check box health before doing task work.
# Exit 3 (UNKNOWN/indeterminate) = transient — log it but do NOT alert or fail.
#
# FIX (dead-code bug): under `set -e` (line 11), a bare simple command that
# exits non-zero kills the script IMMEDIATELY — before the next line runs.
# The previous form here was:
#   bash "$HEALTH_SCRIPT" --json-only >> "$LOG_FILE" 2>&1
#   HEALTH_EXIT=$?
# which meant a RED (exit 1) or UNKNOWN (exit 3) health check killed this
# script on the `bash "$HEALTH_SCRIPT"` line itself, before `HEALTH_EXIT=$?`
# ever assigned — so BOTH the "ALERT: RED" branch and the "WARN: UNKNOWN"
# branch below were unreachable dead code, and the entire INBOX/TESTING/
# IN_PROGRESS/ASSIGNED task-checking body (below) never ran on any box whose
# health check returned non-zero. Wiring the failing command into an `||`
# list is the standard set-e-safe capture: bash's errexit rule exempts any
# command that is not the final one in a `&&`/`||` list, so a non-zero exit
# here runs `HEALTH_EXIT=$?` instead of killing the script.
if [[ -x "$HEALTH_SCRIPT" ]]; then
  log "Running cc-health-check.sh..."
  HEALTH_EXIT=0
  bash "$HEALTH_SCRIPT" --json-only >> "$LOG_FILE" 2>&1 || HEALTH_EXIT=$?
  if [[ "$HEALTH_EXIT" -eq 1 ]]; then
    log "ALERT: cc-health-check reports RED — box is not healthy, skipping task work"
    exit 1
  elif [[ "$HEALTH_EXIT" -eq 3 ]]; then
    log "WARN: cc-health-check reports UNKNOWN (transient) — continuing with task work"
  else
    log "cc-health-check: GREEN"
  fi
fi

# Function to make API calls
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
