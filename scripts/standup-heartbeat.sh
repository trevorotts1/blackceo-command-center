#!/bin/bash
# Standup Heartbeat for Mission Control
# Runs 3x daily: 8 AM, 12 PM, 5 PM Eastern
# Checks for tasks in INBOX, TESTING, IN_PROGRESS, and ASSIGNED states

set -e

# Configuration - use environment variable or default
MISSION_CONTROL_URL="${MISSION_CONTROL_URL:-http://localhost:3000}"
LOG_FILE="${LOG_FILE:-/tmp/standup-heartbeat.log}"

# Logging function
log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" | tee -a "$LOG_FILE"
}

log "=== Standup Heartbeat Started ==="
log "Mission Control URL: $MISSION_CONTROL_URL"

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

# Step 1: Check for INBOX tasks
log "Checking INBOX tasks..."
INBOX_TASKS=$(api_call "GET" "/api/tasks?status=inbox")
INBOX_COUNT=$(echo "$INBOX_TASKS" | grep -c '"id"' || echo "0")
log "Found $INBOX_COUNT tasks in INBOX"

# Step 2: Check TESTING tasks and trigger auto-tests
log "Checking TESTING tasks..."
TESTING_TASKS=$(api_call "GET" "/api/tasks?status=testing")
TESTING_COUNT=$(echo "$TESTING_TASKS" | grep -c '"id"' || echo "0")
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
IN_PROGRESS_COUNT=$(echo "$IN_PROGRESS_TASKS" | grep -c '"id"' || echo "0")
log "Found $IN_PROGRESS_COUNT tasks in IN_PROGRESS"

# Step 4: Check ASSIGNED tasks (rework loop)
log "Checking ASSIGNED tasks..."
ASSIGNED_TASKS=$(api_call "GET" "/api/tasks?status=assigned")
ASSIGNED_COUNT=$(echo "$ASSIGNED_TASKS" | grep -c '"id"' || echo "0")
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
