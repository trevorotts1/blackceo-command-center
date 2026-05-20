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
blue "── 2. Department canonical set (N17) ──"
check "2.1" "config/departments.json has exactly 17 departments" \
  '[ "$(jq -r ". | length" config/departments.json)" = "17" ]' \
  "see Wave 1.2 commit — 17 mandatory + CEO"
check "2.2" "config/departments.json includes CRM" \
  'jq -e ". | map(select(.id == \"dept-crm\")) | length > 0" config/departments.json' \
  ""
check "2.3" "config/departments.json includes OpenClaw Maintenance" \
  'jq -e ". | map(select(.id == \"dept-openclaw\")) | length > 0" config/departments.json' \
  ""
check "2.4" "config/departments.json includes Social Media" \
  'jq -e ". | map(select(.id == \"dept-social\")) | length > 0" config/departments.json' \
  ""
check "2.5" "config/departments.json includes Paid Advertisement" \
  'jq -e ". | map(select(.id == \"dept-paid-ads\")) | length > 0" config/departments.json' \
  ""
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
blue "── 5. No Anthropic models in non-orchestrator code ──"
check "5.1" "no 'claude-' string in src/lib (excluding orchestrator)" \
  "! grep -rE \"'claude-[a-z0-9-]+'\" src/lib/ --include='*.ts' --include='*.tsx' | grep -v -i orchestrator | grep ."
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
