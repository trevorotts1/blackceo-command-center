#!/usr/bin/env bash
# qc-cc.sh — Static QC for the BlackCEO Command Center repo.
#
# Mechanical checks that complement the rubric in QC.md. Exits 0 only when all
# checks pass. Run from the repo root.
#
# Companion to onboarding repo's qc-system-integrity.sh — that script checks
# the live OpenClaw install on a host; this script checks the dashboard repo
# itself.

set -u  # NOT -e — collect all failures, report at the end

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PASS=0
FAIL=0
WARN=0
FAILURES=()

red()    { printf "\033[31m%s\033[0m\n" "$1"; }
green()  { printf "\033[32m%s\033[0m\n" "$1"; }
yellow() { printf "\033[33m%s\033[0m\n" "$1"; }
blue()   { printf "\033[34m%s\033[0m\n" "$1"; }

check() {
  local id="$1"; local desc="$2"; local cmd="$3"; local remedy="${4:-}"
  if eval "$cmd" >/dev/null 2>&1; then
    green "  ✓ $id  $desc"
    PASS=$((PASS+1))
  else
    red "  ✗ $id  $desc"
    FAIL=$((FAIL+1))
    FAILURES+=("$id $desc${remedy:+ — fix: $remedy}")
  fi
}

warn_check() {
  local id="$1"; local desc="$2"; local cmd="$3"
  if eval "$cmd" >/dev/null 2>&1; then
    green "  ✓ $id  $desc"
    PASS=$((PASS+1))
  else
    yellow "  ! $id  $desc (warn)"
    WARN=$((WARN+1))
  fi
}

blue "── 1. Version consistency ──"
check "1.1" "version file exists" \
  '[ -f version ]' \
  "create /version with content like v3.1.0"
check "1.2" "package.json version matches /version" \
  'V_PKG=$(node -p "require(\"./package.json\").version" 2>/dev/null); V_FILE=$(head -1 version | tr -d "v[:space:]"); [ "$V_PKG" = "$V_FILE" ]' \
  "edit package.json or /version so they agree"

blue ""
blue "── 2. Department canonical set (N18) ──"
# As of v4.0.3 (commit bc99e90) config/departments.json ships EMPTY ([]) on
# purpose: the stale 17-row hardcoded template was winning the seed race, and
# autoSeedFromDepartmentsJson() (src/lib/db/migrations.ts) returns early on an
# empty array. The file is regenerated PER CLIENT by
# scripts/sync-departments-from-build-state.py from the client's real Zero
# Human Company build state. So the canonical-set contract now lives in the
# TypeScript source of truth (src/lib/routing/departments.config.ts), and
# departments.json is validated only for SHAPE: it must be a valid JSON array
# (empty = unseeded template, populated = a client's regenerated set), and any
# entries it does contain must carry the required schema fields.
# Count updated to 24: the routing fix (fix/command-center-routing-sop-persona)
# aligned DEFAULT_DEPARTMENTS to the full ZHC canonical set — added the 6 ZHC
# departments the router was previously blind to (presentations, client-coaches,
# course-creator, podcast, community-management, personal-assistant), giving
# the ZHC canonical 23 + Security (E27) = 24. The QC gate must match.
# Count updated to 25: feat/general-task-routing added general-task as a
# mandatory catch-all department on every client (design section B). It is
# priority-1 / empty-keywords so it never wins routing on merit; it is reached
# only via the MIN_ROUTING_CONFIDENCE floor in comDispatch().
check "2.1" "config/departments.json is a valid JSON array (empty template or client-regenerated)" \
  '[ "$(jq -r "type" config/departments.json)" = "array" ]' \
  "must be [] (shipped template) or a populated array; run scripts/sync-departments-from-build-state.py"
check "2.2" "config/departments.json entries (if any) all have id+name (schema valid)" \
  '[ "$(jq -r "all(.[]; has(\"id\") and has(\"name\"))" config/departments.json)" = "true" ]' \
  "every department object needs id and name fields"
check "2.3" "departments.config.ts includes Social Media (canonical source of truth)" \
  "grep -q \"id: 'social-media'\" src/lib/routing/departments.config.ts"
check "2.4" "departments.config.ts includes Paid Advertisement" \
  "grep -q \"id: 'paid-advertisement'\" src/lib/routing/departments.config.ts"
check "2.5" "departments.config.ts defines exactly 25 canonical departments" \
  "[ \"\$(grep -cE \"id: '[a-z-]+'\" src/lib/routing/departments.config.ts)\" = \"25\" ]"
check "2.6" "departments.config.ts has CRM and OpenClaw Maintenance" \
  "grep -q \"id: 'crm'\" src/lib/routing/departments.config.ts && grep -q \"id: 'openclaw-maintenance'\" src/lib/routing/departments.config.ts"
check "2.7" "departments.config.ts does NOT include Operations / Creative / HR / IT" \
  "! grep -E \"id: '(operations|creative|hr-people|it-tech)'\" src/lib/routing/departments.config.ts"

blue ""
blue "── 3. Agents ZHC layout (N19) ──"
check "3.1" "agents/_shared/ exists" \
  '[ -d agents/_shared ]'
check "3.2" "agents/_shared/AGENTS.md is a real file (not a symlink)" \
  '[ -f agents/_shared/AGENTS.md ] && [ ! -L agents/_shared/AGENTS.md ]'
check "3.3" "agents/_shared/TOOLS.md is a real file" \
  '[ -f agents/_shared/TOOLS.md ] && [ ! -L agents/_shared/TOOLS.md ]'
check "3.4" "agents/_shared/USER.md is a real file" \
  '[ -f agents/_shared/USER.md ] && [ ! -L agents/_shared/USER.md ]'
check "3.5" "agents has exactly 69 symlinks (23 agents × 3 shared files)" \
  '[ "$(find agents -type l 2>/dev/null | wc -l | tr -d " ")" = "69" ]' \
  "run scripts/migrate-agents-to-zhc.py"
check "3.6" "every non-_shared agent dir has IDENTITY.md" \
  'find agents -mindepth 1 -maxdepth 1 -type d ! -name "_shared" | while read d; do [ -f "$d/IDENTITY.md" ] || exit 1; done'
check "3.7" "every agent dir has HEARTBEAT.md" \
  'find agents -mindepth 1 -maxdepth 1 -type d ! -name "_shared" | while read d; do [ -f "$d/HEARTBEAT.md" ] || exit 1; done'
check "3.8" "master-orchestrator IDENTITY.md uses CEO Mode deferral clause" \
  'grep -q "Persona Governance — CEO Mode" agents/master-orchestrator/IDENTITY.md'
check "3.9" "non-CEO agent uses Standard deferral clause" \
  'grep -q "Persona Governance Override" agents/billing-agent/IDENTITY.md'

blue ""
blue "── 4. DB migrations integrity ──"
check "4.1" "migrations.ts present" '[ -f src/lib/db/migrations.ts ]'
check "4.2" "migration 019 (persona_assignment) defined" \
  "grep -q \"id: '019'\" src/lib/db/migrations.ts"
warn_check "4.3" "migration 008 not skipped (no numbered gap)" \
  "grep -q \"id: '008'\" src/lib/db/migrations.ts"

blue ""
blue "── 5. No Anthropic models in non-orchestrator code (QC.md #8 cost policy) ──"
# Cost policy: business logic must NOT hardcode an Anthropic model as an
# inference target — it should route through the model resolver / cheaper
# providers. Three classes of match are legitimately exempt:
#   - *orchestrator*           : the CEO/orchestration layer may name Claude.
#   - model-providers/anthropic.ts : the dedicated Anthropic connector. Its
#     job is to emit Anthropic model-family LABELS ('claude-opus', etc.) for
#     the UI — these are groupings, not hardcoded inference targets.
#   - web-agent/runner.ts      : the Operator browser agent is built directly
#     on Anthropic's Messages-API tool-use protocol, so it cannot be
#     provider-agnostic. Its model id is env-overridable (WEB_AGENT_MODEL); the
#     fallback literal must stay a valid Anthropic id for the live API call.
# Any NEW hardcoded 'claude-...' id in other src/lib business logic still fails.
check "5.1" "no hardcoded 'claude-' model id in src/lib (excl. orchestrator + anthropic connector + web-agent runner)" \
  "! grep -rE \"'claude-[a-z0-9-]+'\" src/lib/ --include='*.ts' --include='*.tsx' | grep -v -i orchestrator | grep -v 'model-providers/anthropic.ts' | grep -v 'web-agent/runner.ts' | grep ."
check "5.2" "no 'anthropic/' provider id in src/lib" \
  "! grep -rE \"'anthropic/\" src/lib/ --include='*.ts' --include='*.tsx' | grep ."

blue ""
blue "── 6. Persona infrastructure ──"
check "6.1" "/api/persona-matrix route exists" \
  '[ -f src/app/api/persona-matrix/route.ts ]'
check "6.2" "/api/persona-assignment route exists (Wave 4.3)" \
  '[ -f src/app/api/persona-assignment/route.ts ]'
check "6.3" "PersonaGovernanceBoard component exists" \
  '[ -f src/components/ceo-board/PersonaGovernanceBoard.tsx ]'
check "6.4" "CEO board mounts PersonaGovernanceBoard" \
  'grep -q "PersonaGovernanceBoard" src/app/ceo-board/page.tsx'
# PRD 1.3-CC: persona-selector.ts MUST pass DASHBOARD_DB_PATH to the Python subprocess
# so find_dashboard_db() uses the authoritative path rather than its candidate list.
check "6.5" "persona-selector.ts passes DASHBOARD_DB_PATH env to subprocess (PRD 1.3-CC)" \
  "grep -q 'DASHBOARD_DB_PATH' src/lib/persona-selector.ts" \
  "add env: { ...process.env, DASHBOARD_DB_PATH: DB_PATH } to execFileSync call in src/lib/persona-selector.ts"
check "6.6" "persona-selector.ts imports DB_PATH from @/lib/db (PRD 1.3-CC)" \
  "grep -q 'import.*DB_PATH.*from.*lib/db' src/lib/persona-selector.ts" \
  "add: import { DB_PATH } from '@/lib/db';"
check "6.7" "DB_PATH is exported from src/lib/db/index.ts (PRD 1.3-CC)" \
  "grep -q '^export const DB_PATH' src/lib/db/index.ts" \
  "add export keyword: export const DB_PATH = ..."

blue ""
blue "════════════════════════════════════════════════════════════"
if [ $FAIL -eq 0 ]; then
  green "PASS — $PASS checks green, $WARN warnings"
  exit 0
else
  red "FAIL — $FAIL checks failed ($PASS passed, $WARN warnings)"
  echo ""
  red "Failures:"
  for f in "${FAILURES[@]}"; do
    red "  • $f"
  done
  exit 1
fi
