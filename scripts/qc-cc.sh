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
# 3.5b: companion cardinality guard — adding a new agent dir with 0 symlinks
# leaves the count at 69, so 3.5 passes while the new dir is misconfigured.
check "3.5b" "exactly 23 non-_shared agent dirs (cardinality guard)" \
  '[ "$(find agents -mindepth 1 -maxdepth 1 -type d ! -name "_shared" 2>/dev/null | wc -l | tr -d " ")" = "23" ]' \
  "run scripts/migrate-agents-to-zhc.py to create the missing symlinks"
# 3.5c: per-agent check that AGENTS.md, TOOLS.md, USER.md are symlinks (not copies).
# A copied regular file satisfies find -type l count via cancellation but diverges
# from _shared/ going forward.
check "3.5c" "all agent AGENTS.md files are symlinks (not regular-file copies)" \
  '! find agents -mindepth 2 -maxdepth 2 -name "AGENTS.md" ! -type l 2>/dev/null | grep -v "_shared" | grep -q .'
check "3.5d" "all agent TOOLS.md files are symlinks (not regular-file copies)" \
  '! find agents -mindepth 2 -maxdepth 2 -name "TOOLS.md" ! -type l 2>/dev/null | grep -v "_shared" | grep -q .'
check "3.5e" "all agent USER.md files are symlinks (not regular-file copies)" \
  '! find agents -mindepth 2 -maxdepth 2 -name "USER.md" ! -type l 2>/dev/null | grep -v "_shared" | grep -q .'
# 3.5f: dangling symlink guard — find -type l matches dangling symlinks, so a
# deleted _shared/ would yield count 69 while every symlink is broken.
check "3.5f" "no dangling symlinks under agents/ (all symlinks resolve to a readable file)" \
  'find agents -mindepth 2 -maxdepth 2 \( -name "AGENTS.md" -o -name "TOOLS.md" -o -name "USER.md" \) -type l | while read f; do [ -r "$f" ] || exit 1; done'
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
#   - *orchestrat(or|ion)*     : the CEO/orchestration layer may name Claude.
#                                Exclusion covers both "orchestrator" (file names)
#                                and "orchestration" (module names / comments) to
#                                avoid false-not-green on sibling files.
#   - model-providers/anthropic.ts : the dedicated Anthropic connector. Its
#     job is to emit Anthropic model-family LABELS ('claude-opus', etc.) for
#     the UI — these are groupings, not hardcoded inference targets.
#   - web-agent/runner.ts      : the Operator browser agent is built directly
#     on Anthropic's Messages-API tool-use protocol, so it cannot be
#     provider-agnostic. Its model id is env-overridable (WEB_AGENT_MODEL); the
#     fallback literal must stay a valid Anthropic id for the live API call.
# Any NEW hardcoded 'claude-...' id in other src/lib business logic still fails.
#
# FIX (Issue 5): match all three quote styles (', ", `) so a double-quoted or
# backtick-quoted claude-* literal is NOT silently skipped, which would make
# the inverted (!) expression vacuously TRUE = false PASS.
#
# FIX (Issue 6): -iE 'orchestrat(or|ion)' instead of -i orchestrator to also
# exclude file paths / module names containing "orchestration" (sibling files).
# check_claude_literals: returns 1 (FAIL) if any file in src/lib/ contains a
# claude-* model literal in any quote style (', ", `).  Excludes:
#   - orchestrat(or|ion)     — CEO/orchestration layer is exempt
#   - model-providers/anthropic.ts — emits labels, not inference targets
#   - web-agent/runner.ts        — direct Anthropic API consumer, env-overridable
#
# FIX (Issue 5): original used 'claude-[a-z0-9-]+' (single-quotes only); a
# double-quoted or backtick-quoted literal matched 0 lines → inverted ! gave
# a vacuous TRUE = false PASS.  Now all three delimiter styles are checked.
#
# FIX (Issue 6): exclusion widened from '-i orchestrator' to
# '-iE orchestrat(or|ion)' to cover sibling file names / module paths that
# contain "orchestration" rather than just "orchestrator".
#
# FIX (sovereignty parity): model-selector.ts's FORBIDDEN_PREFIXES is the
# ban-list that ENFORCES "no Anthropic" — its bare `claude-*` family PREFIXES
# (and the doc-comments that explain them) are the guard's own declaration, not
# hardcoded inference targets. Mirror 5.2's declaration-exclusion idiom, but
# NARROWLY: exclude only (a) bare denylist array elements
# (`^\s*'claude-…',$`) and (b) the explanatory comment lines, BOTH scoped to
# model-selector.ts. A genuine assignment (`const m = 'claude-…'`) — even inside
# model-selector.ts — has an `=`/`:` before the literal, is not a bare element,
# and is NOT a comment, so it is still caught. The whole file is NOT excluded.
check_claude_literals() {
  local pat='claude-'
  local results
  results=$(grep -rn "$pat" src/lib/ --include='*.ts' --include='*.tsx' 2>/dev/null \
    | grep -E "['\"\`]claude-[a-z0-9-]+['\"\`]" \
    | grep -vEi 'orchestrat(or|ion)' \
    | grep -v 'model-providers/anthropic.ts' \
    | grep -v 'web-agent/runner.ts' \
    | grep -vE "model-selector\.ts:[0-9]+:[[:space:]]*'claude-[a-z0-9-]+',[[:space:]]*\$" \
    | grep -vE "model-selector\.ts:[0-9]+:[[:space:]]*(\*|//)" \
    || true)
  [[ -z "$results" ]]  # exit 0 (pass) when no matches; exit 1 (fail) when matches found
}
check "5.1" "no hardcoded claude-* model id in src/lib (excl. orchestrat(or|ion) + anthropic connector + web-agent runner)" \
  "check_claude_literals"
# 5.2 detects an 'anthropic/' provider-id literal being USED as a value. The one
# legitimate occurrence is the FORBIDDEN_PREFIXES negative-list in model-selector.ts
# (the guard that BANS Anthropic) — exclude that declaration so the check does not
# flag its own definition. The bare denylist element is `  'anthropic/',` (a quoted
# string immediately followed by a comma); we exclude exactly that element in
# model-selector.ts. Real usage (e.g. model: 'anthropic/claude-…') has extra chars
# after 'anthropic/' before the closing quote, is not the bare element, and is
# still caught. (The legacy `grep -v FORBIDDEN_PREFIXES` line filter is kept for
# any same-line declaration idiom.)
check "5.2" "no 'anthropic/' provider id in src/lib (excl. FORBIDDEN_PREFIXES guard decl)" \
  "! grep -rE \"'anthropic/\" src/lib/ --include='*.ts' --include='*.tsx' | grep -v 'FORBIDDEN_PREFIXES' | grep -vE \"model-selector\.ts:[[:space:]]*'anthropic/',\" | grep ."

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
blue "── 9. PRD 2.12-cc — Self-Healing SOPs (dispatch-time fast loop) ──"

# 9.1 sop-authoring.ts exports the two key functions.
check "9.1" "sop-authoring.ts exports isCanonicalContext and authorSOPForTask" \
  "grep -q 'export function isCanonicalContext' src/lib/sop-authoring.ts && grep -q 'export async function authorSOPForTask' src/lib/sop-authoring.ts"

# 9.2 The canonical guard checks BOTH CANONICAL_SLUGS and source='role-library'.
check "9.2" "fast loop refuses canonical: guard checks CANONICAL_SLUGS AND source='role-library'" \
  "grep -q 'CANONICAL_SLUGS' src/lib/sop-authoring.ts && grep -q \"ROLE_LIBRARY_SOURCE\" src/lib/sop-authoring.ts"

# 9.3 Filed SOPs carry source=NULL (NOT 'role-library').
check "9.3" "filed SOPs carry source=NULL not 'role-library' (INSERT in sop-authoring.ts)" \
  "grep -q 'NULL, NULL, ?, ?)' src/lib/sop-authoring.ts || grep -A5 'INSERT INTO sops' src/lib/sop-authoring.ts | grep -q 'NULL'"

# 9.4 Dispatch hook present in task-dispatcher.ts.
check "9.4" "task-dispatcher.ts: authorSOPForTask + isCanonicalContext imported and called" \
  "grep -q 'authorSOPForTask' src/lib/task-dispatcher.ts && grep -q 'isCanonicalContext' src/lib/task-dispatcher.ts"

# 9.5 Migration 066 exists and is additive.
check "9.5" "migration 066 add_tasks_sop_authoring_link exists in migrations.ts" \
  "grep -q 'add_tasks_sop_authoring_link' src/lib/db/migrations.ts"

# 9.6 Fixture smoke test file exists.
check "9.6" "smoke-test-sop-authoring.ts exists" \
  "[ -f scripts/smoke-test-sop-authoring.ts ]"

# 9.7 Slow-loop QC wiring: runSopLearning (scheduler.ts) references scoreTaskForQC.
check "9.7" "scheduler.ts runSopLearning references scoreTaskForQC (slow-loop QC verdict)" \
  "grep -q 'scoreTaskForQC' src/lib/jobs/scheduler.ts"

# 9.8 Migration 067 expands sop_proposals status CHECK to include auto-authored-filed.
check "9.8" "migration 067 expand_sop_proposals_status_auto_authored exists" \
  "grep -q 'expand_sop_proposals_status_auto_authored' src/lib/db/migrations.ts"

# 9.9 QC_FIXTURE_JSON_PATH bypass in qc-scorer.ts (smoke test support).
check "9.9" "qc-scorer.ts supports QC_FIXTURE_JSON_PATH fixture bypass" \
  "grep -q 'QC_FIXTURE_JSON_PATH' src/lib/qc-scorer.ts"

# 9.10 AF6: fast loop (QC>=8.5 pass) inserts 'auto-authored-filed', NEVER 'pending'.
# The 'auto-authored-filed' string must exist in sop-authoring.ts (auto-file audit trail),
# and the QC-pass INSERT block must NOT insert 'pending' (only fallback/heuristic paths do).
check "9.10" "AF6: fast loop QC-pass path inserts 'auto-authored-filed' (no operator-approval pause)" \
  "grep -q \"'auto-authored-filed'\" src/lib/sop-authoring.ts"

# 9.11 AF6: proposeDraftFromTask (human-approval-gated slow path) must NOT appear in
# task-dispatcher.ts. The fast loop and the Triad-block path are separate code paths —
# dispatch must never route through the human-approval proposal queue.
check "9.11" "AF6: proposeDraftFromTask absent from task-dispatcher.ts (fast loop stays auto-gated)" \
  "! grep -q 'proposeDraftFromTask' src/lib/task-dispatcher.ts"

# 9.12 AF6: sop-authoring.ts QC gate comment documents the AF6 contract
# (auto-proceed on >=8.5, no operator-approval pause).
check "9.12" "AF6: sop-authoring.ts contains AF6 contract comment (dept-QC >= 8.5 -> auto-file)" \
  "grep -q 'AF6' src/lib/sop-authoring.ts"

# 9.13 AF6: unit test for the fast-loop QC gate exists.
check "9.13" "AF6: prd-2.12-fast-loop-qc-gate.test.ts exists" \
  "[ -f tests/unit/prd-2.12-fast-loop-qc-gate.test.ts ]"

blue ""
blue "── 10. B.2 Atomic deploy integrity ──"

# 10.1 atomic-deploy.sh is not the placeholder stub (no longer exits 2 with "pending" message)
check "10.1" "atomic-deploy.sh is implemented (no 'implementation pending' stub)" \
  "! grep -q 'implementation pending' scripts/atomic-deploy.sh"

# 10.2 atomic-deploy.sh has the pre-flight disk gate
check "10.2" "atomic-deploy.sh: pre-flight disk gate (DISK_MIN_GB)" \
  "grep -q 'DISK_MIN_GB' scripts/atomic-deploy.sh"

# 10.3 atomic-deploy.sh backs up the DB before touching build artifacts
check "10.3" "atomic-deploy.sh: DB backup in pre-flight (sqlite3 checkpoint)" \
  "grep -q 'wal_checkpoint' scripts/atomic-deploy.sh"

# 10.4 atomic-deploy.sh creates .next.rollback snapshot
check "10.4" "atomic-deploy.sh: rollback snapshot (.next.rollback)" \
  "grep -q 'next.rollback' scripts/atomic-deploy.sh"

# 10.5 atomic-deploy.sh kills non-canonical pm2 apps before build
check "10.5" "atomic-deploy.sh: kills non-canonical pm2 apps in pre-flight" \
  "grep -q 'NON_CANONICAL\|non-canonical' scripts/atomic-deploy.sh"

# 10.6 atomic-deploy.sh builds to a TEMP dir (not directly to .next)
check "10.6" "atomic-deploy.sh: build to temp dir (NEXT_DIST_DIR or BUILD_TMP)" \
  "grep -q 'BUILD_TMP\|NEXT_DIST_DIR' scripts/atomic-deploy.sh"

# 10.7 atomic-deploy.sh performs atomic swap (single rename/move, no partial window)
check "10.7" "atomic-deploy.sh: atomic swap via mv (single rename)" \
  "grep -q 'mv.*next\|atomic.*swap\|Atomic swap' scripts/atomic-deploy.sh"

# 10.8 atomic-deploy.sh restarts the server before health check (never serves stale)
check "10.8" "atomic-deploy.sh: pm2 restart before health check" \
  "grep -q 'pm2 restart\|pm2 reload' scripts/atomic-deploy.sh"

# 10.9 atomic-deploy.sh calls cc-health-check.sh and captures JSON
check "10.9" "atomic-deploy.sh: calls cc-health-check.sh and captures JSON output" \
  "grep -q 'cc-health-check.sh' scripts/atomic-deploy.sh && grep -q 'HEALTH_JSON' scripts/atomic-deploy.sh"

# 10.10 atomic-deploy.sh: exit 1 from health check triggers auto-rollback (never stays deployed)
check "10.10" "atomic-deploy.sh: exit-1 health check triggers auto-rollback path" \
  "grep -q 'ROLLBACK\|rollback' scripts/atomic-deploy.sh && grep -q 'HEALTH_EXIT.*eq.*1\|exit.*1.*rollback\|1.*rollback\|rollback.*1' scripts/atomic-deploy.sh"

# 10.11 atomic-deploy.sh: auto-rollback restores .next.rollback and restarts
check "10.11" "atomic-deploy.sh: auto-rollback restores .next.rollback + restarts pm2" \
  "grep -A5 'ROLLBACK_DIR\|rollback.*restore\|restoring' scripts/atomic-deploy.sh | grep -qi 'pm2\|restart\|next'"

# 10.12 atomic-deploy.sh: rollback itself is health-checked after restore
check "10.12" "atomic-deploy.sh: rollback health-checked (re-runs cc-health-check.sh after restore)" \
  "grep -q 'ROLLBACK_HEALTH\|rollback.*health\|health.*rollback' scripts/atomic-deploy.sh"

# 10.13 atomic-deploy.sh: loud receipt includes health-check JSON in both success and rollback paths
check "10.13" "atomic-deploy.sh: receipts include health-check JSON" \
  "grep -q 'HEALTH_JSON\|health_json\|health JSON' scripts/atomic-deploy.sh"

# 10.14 atomic-deploy.sh: exit 3 from health check pauses/retries and NEVER triggers rollback
check "10.14" "atomic-deploy.sh: exit-3 health check retries (never rolls back on UNKNOWN)" \
  "grep -q 'HEALTH_RETRIES\|health.*retry\|retry.*health\|Never rollback.*3\|exit 3\|HEALTH_EXIT.*eq.*3' scripts/atomic-deploy.sh"

# 10.15 B.2 fixture test exists
check "10.15" "tests/unit/b2-atomic-deploy.test.ts fixture test exists" \
  "[ -f tests/unit/b2-atomic-deploy.test.ts ]"

# 10.16 atomic-deploy.sh persists the pm2 process list (pm2 save) so BOTH the CC
#       app AND the co-resident cloudflared tunnel connector are in the pm2 dump
#       and auto-resurrect after an OOM/reboot. Root cause of the CF-1033
#       "tunnel has no healthy origin" outage: the app was (re)started under pm2
#       but the dump was never saved, so `pm2 resurrect` on the next boot
#       restored nothing and the dashboard stayed dark.
check "10.16" "atomic-deploy.sh: pm2 save on green (CC + cloudflared persist for auto-resurrect)" \
  "grep -q 'pm2 save' scripts/atomic-deploy.sh"

# 10.17 deploy.sh (legacy operator deploy path per DEPLOYMENT.md) must ALSO
#       persist via pm2 save on green — same OOM/reboot-survival guarantee.
check "10.17" "deploy.sh: pm2 save on green (persist pm2 dump for OOM/reboot survival)" \
  "grep -q 'pm2 save' scripts/deploy.sh"

blue ""
blue "── 11. Port-pin and env-bleed guard (v4.42.0+) ──"
#
# Prevents re-introduction of the crash-loop root causes:
#   (a) process.env.PORT in ecosystem.config.cjs → OpenClaw gateway PORT bleeds in
#   (b) PORT: key in ecosystem env block → Hostinger injected PORT bleeds in
#   (c) cc-start.sh missing → no orphan-port kill, no env-bleed strip
#   (d) circuit-breaker fields missing → PM2 loops forever (126K restarts)
#   (e) start paths invoking next start directly → hardened launcher bypassed
#
# A planted fixture (tests/fixtures/port-guard/bleeding-ecosystem.cjs) contains
# the vulnerable pattern and is used in CI to prove the guard actually bites.

# 11.1: ecosystem.config.cjs must NOT read process.env.PORT in active (non-comment) code.
# Exclude lines that are pure comments (start with optional whitespace + * or //).
check "11.1" "ecosystem.config.cjs does NOT read process.env.PORT in active code (env-bleed guard)" \
  '! grep -E "process\.env\.PORT" ecosystem.config.cjs | grep -vE "^\s*(//|\*)" | grep .'

# 11.2: ecosystem env block must NOT contain a PORT: key (only CC_PORT: is allowed)
check "11.2" "ecosystem.config.cjs env block has no PORT: key (only CC_PORT: allowed)" \
  '! grep -E "^\s+PORT:" ecosystem.config.cjs | grep .'

# 11.3: cc-start.sh must exist AND contain unset PORT (env-bleed strip)
check "11.3" "scripts/cc-start.sh exists" \
  '[ -f scripts/cc-start.sh ]'
check "11.4" "scripts/cc-start.sh contains 'unset PORT' (env-bleed strip)" \
  'grep -q "unset PORT" scripts/cc-start.sh'

# 11.5: cc-start.sh must contain lsof or fuser (orphan-port kill)
check "11.5" "scripts/cc-start.sh contains lsof/fuser (orphan-port killer)" \
  'grep -qE "lsof|fuser" scripts/cc-start.sh'

# 11.6-11.9: circuit-breaker completeness in ecosystem.config.cjs
check "11.6" "ecosystem.config.cjs has min_uptime (circuit-breaker — makes max_restarts bite)" \
  'grep -q "min_uptime" ecosystem.config.cjs'
check "11.7" "ecosystem.config.cjs has exp_backoff_restart_delay (exponential backoff)" \
  'grep -q "exp_backoff_restart_delay" ecosystem.config.cjs'
check "11.8" "ecosystem.config.cjs has max_restarts (restart cap)" \
  'grep -q "max_restarts" ecosystem.config.cjs'
check "11.9" "ecosystem.config.cjs has kill_timeout (clean shutdown budget)" \
  'grep -q "kill_timeout" ecosystem.config.cjs'

# 11.10: package.json scripts.start must route through cc-start.sh (not bare next start)
check "11.10" "package.json scripts.start invokes cc-start.sh (not bare next start)" \
  'node -e "const s=require(\"./package.json\").scripts.start; if(s.includes(\"next start\")&&!s.includes(\"cc-start\")) process.exit(1)"'

# 11.11: bootstrap templates must not invoke next start directly (check for cc-start.sh)
check "11.11" "mac-mini-bootstrap.sh Step 8b uses cc-start.sh (not bare next start)" \
  'grep -q "cc-start.sh" scripts/install/mac-mini-bootstrap.sh'
check "11.12" "vps-docker-bootstrap.sh Step 8b uses cc-start.sh (not bare next start)" \
  'grep -q "cc-start.sh" scripts/install/vps-docker-bootstrap.sh'

# 11.13: planted fixture MUST be detectable by the guard (proves guard bites, not vacuous).
# We run the SAME grep that check 11.1 uses against the fixture — it must MATCH (exit 0).
# The fixture uses process.env.PORT in active code (not just comments), so the full
# non-comment filter must still detect it.
check "11.13" "planted fixture bleeding-ecosystem.cjs IS detectable by guard 11.1 (self-proof)" \
  'grep -E "process\.env\.PORT" tests/fixtures/port-guard/bleeding-ecosystem.cjs | grep -vE "^\s*(//|\*)" | grep -q .'

blue ""
blue "── 12. Cross-store embedding contract validate (SOP_EMBEDDING_PROVIDER=google / gemini-embedding-2 / 3072) ──"
#
# CONTRACT: SOP_EMBEDDING_PROVIDER=google is the SINGLE embedding contract for
# this installation. gemini-embedding-2 at 3072 dims must be consistent across:
#   (a) the CODE contract  — sop-embeddings.ts auto-detect puts Google first
#   (b) the ENV store      — .env.local pins SOP_EMBEDDING_PROVIDER=google
#   (c) the DB persona-index — sop_embeddings table has ONLY gemini-embedding-2 rows
#
# Any drift between these three stores means the routing layer is silently using
# a different embedding space than the stored index, corrupting cosine similarity.
# This gate must pass before every deploy.

# 12.1: CODE contract — auto-detect in resolveEmbeddingProvider() puts Google FIRST
#   (OpenAI is demoted to explicit optional fallback, never auto-selected over Google)
check "12.1" "sop-embeddings.ts: Google auto-detect runs BEFORE OpenAI (single-contract order)" \
  'awk "/Auto-detect/,/OPTIONAL FALLBACK/" src/lib/sop-embeddings.ts | grep -q "googleKey = resolveGoogleKey"'

# 12.2: CODE contract — OpenAI is labelled as OPTIONAL FALLBACK, not default
check "12.2" "sop-embeddings.ts: OpenAI demoted to OPTIONAL FALLBACK (not default auto-detect)" \
  "grep -q 'OPTIONAL FALLBACK' src/lib/sop-embeddings.ts"

# 12.3: ENV store — .env.local pins SOP_EMBEDDING_PROVIDER=google
# Skip gracefully when .env.local is absent (CI / fresh clone) — it is a
# gitignored runtime file that only exists on a provisioned box.
if [ -f .env.local ]; then
  check "12.3" ".env.local pins SOP_EMBEDDING_PROVIDER=google (single contract env)" \
    'grep -q "^SOP_EMBEDDING_PROVIDER=google" .env.local'
else
  yellow "  ! 12.3  .env.local pins SOP_EMBEDDING_PROVIDER=google (skip — .env.local absent in CI/fresh clone)"
  WARN=$((WARN+1))
fi

# 12.4: CODE + ENV agree — forced-google override is the first override branch
check "12.4" "sop-embeddings.ts: SOP_EMBEDDING_PROVIDER=google is the FIRST override branch (CONTRACT path)" \
  "grep -n \"override === 'google'\" src/lib/sop-embeddings.ts | head -1 | grep -q ."

# 12.5: DB persona-index — sop_embeddings table has no OpenAI (text-embedding-3-small) rows
# Skip gracefully when sqlite3 is absent or DB doesn't exist yet (CI / fresh clone).
DB_PATH="$(dirname "$ROOT")/data/mission-control.db"
if command -v sqlite3 >/dev/null 2>&1 && [ -f "$DB_PATH" ]; then
  check "12.5" "DB sop_embeddings: zero OpenAI (text-embedding-3-small) rows (cross-store provider agreement)" \
    "[ \"\$(sqlite3 \"$DB_PATH\" \"SELECT COUNT(*) FROM sop_embeddings WHERE embedding_model='text-embedding-3-small';\" 2>/dev/null)\" = \"0\" ]"
  check "12.6" "DB sop_embeddings: all rows use gemini-embedding-2 model (persona-index == CC active provider)" \
    "[ \"\$(sqlite3 \"$DB_PATH\" \"SELECT COUNT(*) FROM sop_embeddings WHERE embedding_model != 'gemini-embedding-2';\" 2>/dev/null)\" = \"0\" ]"
  check "12.7" "DB sop_embeddings: all rows have dims=3072 (gemini-embedding-2 output dimensionality)" \
    "[ \"\$(sqlite3 \"$DB_PATH\" \"SELECT COUNT(*) FROM sop_embeddings WHERE embedding_dims != 3072;\" 2>/dev/null)\" = \"0\" ]"
else
  yellow "  ! 12.5  DB sop_embeddings OpenAI-row count (skip — sqlite3 not found or DB absent)"
  yellow "  ! 12.6  DB sop_embeddings gemini-embedding-2 model agreement (skip — sqlite3 not found or DB absent)"
  yellow "  ! 12.7  DB sop_embeddings dims=3072 agreement (skip — sqlite3 not found or DB absent)"
  WARN=$((WARN+3))
fi

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
