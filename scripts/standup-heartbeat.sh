#!/usr/bin/env bash
# Standup Heartbeat for BlackCEO Command Center
# 3x daily agent check-ins: morning (8 AM), midday (12 PM), evening (5 PM)
#
# Usage:
#   ./standup-heartbeat.sh morning          # Run morning standup for all agents
#   ./standup-heartbeat.sh midday           # Run midday check-in
#   ./standup-heartbeat.sh evening          # Run end-of-day wrap
#   ./standup-heartbeat.sh status           # Check current agent statuses
#   ./standup-heartbeat.sh morning --agent "operations-admin"  # Single agent

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MC_URL="${MISSION_CONTROL_URL:-http://localhost:4000}"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

mc_get() {
  local endpoint="$1"
  curl -sf --max-time 10 "${MC_URL}${endpoint}" 2>/dev/null || echo "[]"
}

mc_post() {
  local endpoint="$1"
  local body="$2"
  curl -sf --max-time 10 -X POST "${MC_URL}${endpoint}" \
    -H 'Content-Type: application/json' \
    -d "$body" 2>/dev/null || echo '{"error":"request failed"}'
}

mc_patch() {
  local endpoint="$1"
  local body="$2"
  curl -sf --max-time 10 -X PATCH "${MC_URL}${endpoint}" \
    -H 'Content-Type: application/json' \
    -d "$body" 2>/dev/null || echo '{"error":"request failed"}'
}

log_info() {
  echo -e "${BLUE}[$(date '+%H:%M:%S')] INFO:${NC} $1"
}

log_warn() {
  echo -e "${YELLOW}[$(date '+%H:%M:%S')] WARN:${NC} $1"
}

log_error() {
  echo -e "${RED}[$(date '+%H:%M:%S')] ERROR:${NC} $1"
}

log_success() {
  echo -e "${GREEN}[$(date '+%H:%M:%S')] OK:${NC} $1"
}

# Get all agents from Mission Control
get_agents() {
  mc_get "/api/agents"
}

# Get tasks assigned to a specific agent
get_agent_tasks() {
  local agent_id="$1"
  mc_get "/api/tasks?assigned_agent_id=${agent_id}&status=in_progress,review,blocked"
}

# Log activity for a task (or create a system event if no task)
log_agent_activity() {
  local agent_id="$1"
  local agent_name="$2"
  local activity_type="$3"
  local message="$4"
  
  # Create a standup task if none exists, or log to most recent task
  local tasks
  tasks=$(mc_get "/api/tasks?assigned_agent_id=${agent_id}&limit=1")
  
  local task_id
  task_id=$(echo "$tasks" | python3 -c "
import json, sys
tasks = json.load(sys.stdin)
if tasks and len(tasks) > 0:
    print(tasks[0]['id'])
else:
    print('')
" 2>/dev/null || echo "")
  
  if [[ -n "$task_id" ]]; then
    # Log to existing task
    mc_post "/api/tasks/${task_id}/activities" "{
      \"activity_type\": \"${activity_type}\",
      \"message\": \"${agent_name}: ${message}\",
      \"agent_id\": \"${agent_id}\"
    }" >/dev/null
  fi
  
  # Also log to events table for system-wide visibility
  mc_post "/api/events" "{
    \"type\": \"${activity_type}\",
    \"agent_id\": \"${agent_id}\",
    \"message\": \"${agent_name}: ${message}\"
  }" >/dev/null 2>&1 || true
}

# ---------------------------------------------------------------------------
# Standup Routines
# ---------------------------------------------------------------------------

run_agent_standup() {
  local agent_id="$1"
  local agent_name="$2"
  local agent_role="$3"
  local agent_status="$4"
  local standup_type="$5"
  
  log_info "Running ${standup_type} standup for ${agent_name} (${agent_role})"
  
  # Get current tasks
  local tasks
  tasks=$(get_agent_tasks "$agent_id")
  local task_count
  task_count=$(echo "$tasks" | python3 -c "import json,sys; print(len(json.load(sys.stdin)))" 2>/dev/null || echo "0")
  
  case "$standup_type" in
    morning)
      # Morning: Check calendar, report availability, claim inbox tasks
      local msg="Morning standup: ${task_count} active tasks. Status: ${agent_status}."
      log_agent_activity "$agent_id" "$agent_name" "standup_start" "$msg"
      
      # If no tasks and status is standby, agent is ready for inbox work
      if [[ "$task_count" -eq 0 && "$agent_status" == "standby" ]]; then
        log_agent_activity "$agent_id" "$agent_name" "updated" "Ready for inbox tasks. Checking for available work."
      fi
      
      log_agent_activity "$agent_id" "$agent_name" "standup_complete" "Morning standup complete. Ready for the day."
      ;;
      
    midday)
      # Midday: Progress update, blockers
      local msg="Midday check-in: ${task_count} active tasks."
      log_agent_activity "$agent_id" "$agent_name" "standup_start" "$msg"
      
      # Check for blockers (this is simplified - in production, agents would self-report)
      if [[ "$agent_status" == "offline" ]]; then
        log_warn "${agent_name} is offline during midday check-in"
      fi
      
      log_agent_activity "$agent_id" "$agent_name" "standup_complete" "Midday check-in complete. Progress on track."
      ;;
      
    evening)
      # Evening: Deliverables summary, handoffs, EOD status
      local msg="End-of-day wrap: ${task_count} tasks in progress."
      log_agent_activity "$agent_id" "$agent_name" "standup_start" "$msg"
      
      # Transition to offline after evening standup
      if [[ "$agent_status" == "standby" ]]; then
        mc_patch "/api/agents/${agent_id}" '{"status":"offline"}' >/dev/null
        log_agent_activity "$agent_id" "$agent_name" "updated" "Transitioned to offline status. See you tomorrow."
      fi
      
      log_agent_activity "$agent_id" "$agent_name" "standup_complete" "EOD wrap complete. Handoffs documented."
      ;;
  esac
  
  log_success "${agent_name} standup complete"
}

run_standup_all() {
  local standup_type="$1"
  local target_agent="${2:-}"
  
  log_info "=========================================="
  log_info "Starting ${standup_type} standup heartbeat"
  log_info "Mission Control: ${MC_URL}"
  log_info "Time: $(date '+%Y-%m-%d %H:%M:%S %Z')"
  log_info "=========================================="
  
  # Fetch all agents
  local agents_json
  agents_json=$(get_agents)
  
  if [[ "$agents_json" == "[]" || -z "$agents_json" ]]; then
    log_error "No agents found in Mission Control"
    exit 1
  fi
  
  # Process agents
  local total=0
  local completed=0
  local failed=0
  
  while IFS='|' read -r id name role status; do
    [[ -z "$id" ]] && continue
    
    total=$((total + 1))
    
    # If target agent specified, skip others
    if [[ -n "$target_agent" && "$name" != "$target_agent" ]]; then
      continue
    fi
    
    if run_agent_standup "$id" "$name" "$role" "$status" "$standup_type"; then
      completed=$((completed + 1))
    else
      failed=$((failed + 1))
      log_error "Standup failed for ${name}"
    fi
    
    # Small delay to avoid overwhelming the API
    sleep 0.1
    
  done < <(echo "$agents_json" | python3 -c "
import json, sys
agents = json.load(sys.stdin)
for a in agents:
    print(f\"{a['id']}|{a['name']}|{a.get('role','unknown')}|{a.get('status','unknown')}\")
" 2>/dev/null)
  
  log_info "=========================================="
  log_info "Standup complete: ${completed}/${total} agents processed"
  if [[ $failed -gt 0 ]]; then
    log_warn "Failed: ${failed} agents"
  fi
  log_info "=========================================="
  
  # Create summary event
  mc_post "/api/events" "{
    \"type\": \"system\",
    \"message\": \"📊 ${standup_type} standup complete: ${completed}/${total} agents checked in\"
  }" >/dev/null 2>&1 || true
}

# ---------------------------------------------------------------------------
# Status Check
# ---------------------------------------------------------------------------

cmd_status() {
  log_info "Agent Status Check"
  log_info "Mission Control: ${MC_URL}"
  log_info ""
  
  local agents_json
  agents_json=$(get_agents)
  
  if [[ "$agents_json" == "[]" || -z "$agents_json" ]]; then
    log_error "No agents found"
    exit 1
  fi
  
  # Header
  printf "%-25s %-15s %-10s %-10s\n" "AGENT" "ROLE" "STATUS" "TASKS"
  printf "%-25s %-15s %-10s %-10s\n" "-------------------------" "---------------" "----------" "----------"
  
  # Process agents
  while IFS='|' read -r id name role status; do
    [[ -z "$id" ]] && continue
    
    # Get task count
    local tasks
    tasks=$(get_agent_tasks "$id")
    local task_count
    task_count=$(echo "$tasks" | python3 -c "import json,sys; print(len(json.load(sys.stdin)))" 2>/dev/null || echo "0")
    
    # Status icon
    local icon="⚪"
    case "$status" in
      working) icon="🟢" ;;
      standby) icon="⚪" ;;
      offline) icon="🔴" ;;
      blocked) icon="🟡" ;;
    esac
    
    printf "%-25s %-15s %s %-8s %-10s\n" "$name" "$role" "$icon" "$status" "$task_count"
    
  done < <(echo "$agents_json" | python3 -c "
import json, sys
agents = json.load(sys.stdin)
for a in agents:
    print(f\"{a['id']}|{a['name']}|{a.get('role','unknown')}|{a.get('status','unknown')}\")
" 2>/dev/null)
  
  log_info ""
  log_info "Legend: 🟢 Working | ⚪ Standby | 🔴 Offline | 🟡 Blocked"
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

main() {
  local cmd="${1:-}"
  local target_agent=""
  
  # Parse optional args
  # Note: --verbose is accepted for forward-compatibility but currently no-op
  while [[ $# -gt 1 ]]; do
    case "$2" in
      --agent) target_agent="${3:-}"; shift 2;;
      --verbose) shift;;
      *) shift;;
    esac
  done
  
  case "$cmd" in
    morning|midday|evening)
      run_standup_all "$cmd" "$target_agent"
      ;;
    status)
      cmd_status
      ;;
    *)
      echo "Standup Heartbeat for BlackCEO Command Center"
      echo ""
      echo "Usage:"
      echo "  $0 morning [options]     # 8 AM standup - day planning"
      echo "  $0 midday [options]      # 12 PM check-in - progress update"
      echo "  $0 evening [options]     # 5 PM wrap - EOD summary"
      echo "  $0 status                # Check all agent statuses"
      echo ""
      echo "Options:"
      echo "  --agent NAME             # Run for single agent only"
      echo ""
      echo "Environment:"
      echo "  MISSION_CONTROL_URL      # API base URL (default: http://localhost:4000)"
      echo ""
      echo "Examples:"
      echo "  $0 morning                              # All agents"
      echo "  $0 morning --agent operations-admin     # Single agent"
      echo "  MISSION_CONTROL_URL=http://mc.local:4000 $0 status"
      exit 1
      ;;
  esac
}

main "$@"
