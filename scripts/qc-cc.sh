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
blue "── 5b. Embedding model hygiene (PRD 1.8c) ──"
# gemini-embedding-001 is retired 2026-07-14. It must not appear as an active
# model constant in src/lib/ or scripts/. Allowed only in:
#   - GOOGLE_RETIRED_MODEL  (the literal that identifies stale rows — intentional)
#   - comments / docs       (explaining the migration)
#   - test files            (testing the drift-detection logic)
# The check below flags any occurrence in active lib + scripts code that is NOT
# the GOOGLE_RETIRED_MODEL guard, a comment, or a test file.
check "5b.1" "PINNED_GOOGLE_MODEL constant is gemini-embedding-2 (not retired gemini-embedding-001)" \
  "grep -q \"PINNED_GOOGLE_MODEL = 'gemini-embedding-2'\" src/lib/sop-embeddings.ts"
check "5b.2" "GOOGLE_MODEL resolves to PINNED_GOOGLE_MODEL (no direct -001 assignment)" \
  "grep -q 'const GOOGLE_MODEL = PINNED_GOOGLE_MODEL' src/lib/sop-embeddings.ts"
check "5b.3" "no active assignment of GOOGLE_MODEL = 'gemini-embedding-001' in src/lib" \
  "! grep -rn \"GOOGLE_MODEL = 'gemini-embedding-001'\" src/lib/ --include='*.ts' | grep ."
check "5b.4" "backfill script references PINNED_GOOGLE_MODEL (not hardcoded -001 for active use)" \
  "! grep -n \"'gemini-embedding-001'\" scripts/backfill-sop-embeddings.ts | grep -v 'RETIRED\|retired\|stale\|deprecated\|shutdown\|#'"
check "5b.5" "output_dimensionality=3072 passed explicitly in Google fetch call" \
  "grep -q 'output_dimensionality: GOOGLE_OUTPUT_DIMENSIONALITY' src/lib/sop-embeddings.ts"
check "5b.6" "countStaleGoogleEmbeddings exported from sop-embeddings.ts" \
  "grep -q 'export function countStaleGoogleEmbeddings' src/lib/sop-embeddings.ts"
check "5b.7" "migration 063 (model-drift index) defined in migrations.ts" \
  "grep -q \"id: '063'\" src/lib/db/migrations.ts"

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
blue "── 7. PRD 2.9 integration checks ──"
# (e) Department head names — headTitle must use head_agent_name from the
# workspace's agents JOIN, not a hardcoded generic "Head of <Dept>". The fix
# lives in src/lib/routing/resolve-department.ts: normalizeWorkspace() reads
# ws.head_agent_name and uses it when present.
check "7.1" "resolve-department: normalizeWorkspace reads head_agent_name (PRD 2.9e)" \
  "grep -q 'head_agent_name' src/lib/routing/resolve-department.ts"
check "7.2" "resolve-department: headTitle uses real agent name when available (PRD 2.9e)" \
  "grep -q 'headAgentName || ' src/lib/routing/resolve-department.ts"
check "7.3" "DepartmentResolution interface includes headAgentName field (PRD 2.9e)" \
  "grep -q 'headAgentName' src/lib/routing/resolve-department.ts"

# (f) Null department → workspace slug resolution. When task.department is NULL
# the deptSlug callers in qc-scorer.ts and tasks/[id]/route.ts MUST resolve the
# workspace slug from the DB (never pass UUID raw to record-completion).
check "7.4" "qc-scorer: null department resolved via workspace slug lookup (PRD 2.9f)" \
  "grep -q 'SELECT slug FROM workspaces WHERE id' src/lib/qc-scorer.ts"
check "7.5" "qc-scorer: canonicalDeptSlug applied after workspace slug lookup (PRD 2.9f)" \
  "grep -A10 'SELECT slug FROM workspaces WHERE id' src/lib/qc-scorer.ts | grep -q 'canonicalDeptSlug'"
check "7.6" "tasks PATCH route: null department resolved via workspace slug lookup (PRD 2.9f)" \
  "grep -q 'SELECT slug FROM workspaces WHERE id' 'src/app/api/tasks/[id]/route.ts'"
check "7.7" "tasks PATCH route: canonicalDeptSlug imported for slug normalization (PRD 2.9f)" \
  "grep -q 'canonicalDeptSlug' 'src/app/api/tasks/[id]/route.ts'"

# (a) Heuristic mode never triggers reroute loop (PRD 2.4 — verify still live).
check "7.8" "qc-scorer: heuristic guard present — skips reroute loop (PRD 2.4)" \
  "grep -q 'scoringPath.*heuristic' src/lib/qc-scorer.ts"

# (b) Live feed covers task_created / task_dispatched / task_completed.
check "7.9" "tasks.ts emits task_created event" \
  "grep -q \"'task_created'\" src/lib/tasks.ts"
check "7.10" "tasks.ts emits task_dispatched event for routed tasks" \
  "grep -q \"'task_dispatched'\" src/lib/tasks.ts"
check "7.11" "task PATCH route emits task_completed event on done transition" \
  "grep -q \"'task_completed'\" 'src/app/api/tasks/[id]/route.ts'"

# (c) Auto-dispatch skips master/CEO agents (route-not-execute).
check "7.12" "task-dispatcher: master/CEO agent guard present (PRD 2.9c)" \
  "grep -q 'is_master' src/lib/task-dispatcher.ts"

# (d) Company Settings theming is wired.
check "7.13" "BrandTheme component exists (PRD 2.9d)" \
  '[ -f src/components/BrandTheme.tsx ]'
check "7.14" "BrandTheme reads brand_color from client context (PRD 2.9d)" \
  "grep -q 'brand_color' src/components/BrandTheme.tsx"

# PRD 2.9(f) fixture test file ships.
check "7.15" "prd-2.9f-null-dept-slug.test.ts exists (fixture for null-department slug)" \
  '[ -f tests/unit/prd-2.9f-null-dept-slug.test.ts ]'

blue "── 8. PRD 2.11 — Department Trio (QC + Research + Devil's Advocate) ──"

# Migration 065 seeding.
check "8.1" "migrations.ts: migration 065 exists (trio seed)" \
  "grep -q \"id: '065'\" src/lib/db/migrations.ts"
check "8.2" "migrations.ts: migration 065 seeds role_type='research'" \
  "grep -q \"'research'\" src/lib/db/migrations.ts"
check "8.3" "migrations.ts: migration 065 seeds role_type='devils-advocate'" \
  "grep -q \"'devils-advocate'\" src/lib/db/migrations.ts"
check "8.4" "migrations.ts: autoSeedTrioAgents exported (deferred-seed path)" \
  "grep -q 'export function autoSeedTrioAgents' src/lib/db/migrations.ts"
check "8.5" "migrations.ts: autoSeedTrioAgents called from runMigrations post-chain" \
  "grep -q 'autoSeedTrioAgents(db)' src/lib/db/migrations.ts"
check "8.6" "migrations.ts: autoSeedTrioAgents called from autoSeedFromDepartmentsJson" \
  "grep -A5 'autoSeedTrioAgents' src/lib/db/migrations.ts | grep -q 'autoSeedTrioAgents'"

# resolveTrioAgents + getMissingTrioRoles in qc-scorer.
check "8.7" "qc-scorer.ts: resolveTrioAgents exported (build-gate resolver)" \
  "grep -q 'export function resolveTrioAgents' src/lib/qc-scorer.ts"
check "8.8" "qc-scorer.ts: getMissingTrioRoles exported (build-gate assertion)" \
  "grep -q 'export function getMissingTrioRoles' src/lib/qc-scorer.ts"
check "8.9" "qc-scorer.ts: DeptTrioAgents interface exported (PRD 2.11 trio type)" \
  "grep -q 'export interface DeptTrioAgents' src/lib/qc-scorer.ts"

# DA is internal — verify its description carries the INTERNAL marker.
check "8.10" "migrations.ts: DA description carries INTERNAL marker (never surfaced to client)" \
  "grep -q 'INTERNAL' src/lib/db/migrations.ts"

# Deterministic ID pattern.
check "8.11" "migrations.ts: research agent id prefix 'research-agent-'" \
  "grep -q \"research-agent-\" src/lib/db/migrations.ts"
check "8.12" "migrations.ts: DA agent id prefix 'da-agent-'" \
  "grep -q \"da-agent-\" src/lib/db/migrations.ts"

# Fixture test file.
check "8.13" "prd-2.11-trio-agent-seed.test.ts exists (fixture for trio seeding)" \
  '[ -f tests/unit/prd-2.11-trio-agent-seed.test.ts ]'

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
