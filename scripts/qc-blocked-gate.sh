#!/usr/bin/env bash
# qc-blocked-gate.sh -- Rubric item #11: Blocked-column gate enforcement assertions.
#
# Asserts that the four required components of the blocked-vs-return doctrine
# are all present and wired. Run before any PR merge to the command-center repo.
#
# Exit 0 = all assertions pass (gate green).
# Exit 1 = one or more assertions failed (gate red; list failures to stdout).
#
# Usage: ./scripts/qc-blocked-gate.sh [--repo-root <path>]
#
# Disable individual assertions (for local overrides only -- never in CI):
#   SKIP_MIGRATION=1      SKIP_API_GATE=1
#   SKIP_RETURN_ENDPOINT=1  SKIP_SCHEDULER=1

set -uo pipefail

_QC_BLOCKED_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/client-roster-lib.sh
source "$_QC_BLOCKED_SCRIPT_DIR/client-roster-lib.sh"

REPO_ROOT="${1:-$(cd "$(dirname "$0")/.." && pwd)}"
if [[ "$REPO_ROOT" == "--repo-root" ]]; then
  REPO_ROOT="${2:-$(cd "$(dirname "$0")/.." && pwd)}"
fi

PASS=0
FAIL=0
FAILURES=()

check() {
  local name="$1"
  local result="$2"
  local detail="${3:-}"
  if [[ "$result" == "pass" ]]; then
    printf '[qc-blocked-gate] PASS: %s\n' "$name"
    (( PASS++ )) || true
  else
    printf '[qc-blocked-gate] FAIL: %s%s\n' "$name" "${detail:+ -- $detail}"
    FAILURES+=("$name${detail:+: $detail}")
    (( FAIL++ )) || true
  fi
}

# ── Assertion 1: Migration 071 is present ────────────────────────────────────
if [[ "${SKIP_MIGRATION:-0}" != "1" ]]; then
  MIGRATIONS_FILE="$REPO_ROOT/src/lib/db/migrations.ts"
  if [[ -f "$MIGRATIONS_FILE" ]] && grep -q "id: '071'" "$MIGRATIONS_FILE"; then
    check "migration-071-present" "pass"
  else
    check "migration-071-present" "fail" "id: '071' not found in $MIGRATIONS_FILE"
  fi
fi

# ── Assertion 2: API gate in PATCH handler rejects non-human blocked attempts ─
if [[ "${SKIP_API_GATE:-0}" != "1" ]]; then
  PATCH_ROUTE="$REPO_ROOT/src/app/api/tasks/[id]/route.ts"
  if [[ ! -f "$PATCH_ROUTE" ]]; then
    check "api-gate-blocked" "fail" "PATCH route file not found: $PATCH_ROUTE"
  else
    # Must contain the Blocked-requires-human-only-reason gate text.
    if grep -q "Blocked requires a human-only reason" "$PATCH_ROUTE" && \
       grep -q "blocked_reason" "$PATCH_ROUTE" && \
       grep -q "blocked_on_human" "$PATCH_ROUTE" && \
       grep -q "return-to-orchestrator" "$PATCH_ROUTE"; then
      check "api-gate-blocked" "pass"
    else
      check "api-gate-blocked" "fail" \
        "PATCH handler missing blocked gate assertions (blocked_reason/blocked_on_human/return-to-orchestrator hint)"
    fi
  fi
fi

# ── Assertion 3: return-to-orchestrator endpoint exists ──────────────────────
if [[ "${SKIP_RETURN_ENDPOINT:-0}" != "1" ]]; then
  RETURN_ROUTE="$REPO_ROOT/src/app/api/tasks/[id]/return-to-orchestrator/route.ts"
  if [[ -f "$RETURN_ROUTE" ]] && grep -q "HandbackSchema" "$RETURN_ROUTE"; then
    check "return-to-orchestrator-endpoint" "pass"
  else
    check "return-to-orchestrator-endpoint" "fail" \
      "File not found or HandbackSchema missing: $RETURN_ROUTE"
  fi
fi

# ── Assertion 4: stale-task-sweep registered in scheduler.ts ─────────────────
if [[ "${SKIP_SCHEDULER:-0}" != "1" ]]; then
  SCHEDULER="$REPO_ROOT/src/lib/jobs/scheduler.ts"
  SWEEP_JOB="$REPO_ROOT/src/lib/jobs/stale-task-sweep.ts"
  if [[ -f "$SWEEP_JOB" ]] && grep -q "stale-task-sweep" "$SCHEDULER"; then
    check "stale-sweep-in-scheduler" "pass"
  else
    check "stale-sweep-in-scheduler" "fail" \
      "stale-task-sweep.ts missing or not registered in scheduler.ts JOBS[]"
  fi
fi

# ── Assertion 5: No client names in changed files (fleet-wide guard) ──────────
# SCOPE: DIFF-ONLY fast-path. This assertion greps only the uncommitted git diff
# (added `+` lines), so it catches a client name being introduced in the CURRENT
# change set but CANNOT catch names that were ALREADY committed to tracked files.
#
# AUTHORITATIVE SCAN: scripts/qc-assert-no-client-names.sh walks EVERY tracked
# file on disk (not just the diff) and is the source of truth for the fleet-wide
# "no client names" invariant (wired into CI as the `no-client-names` job). This
# diff check is kept only as a fast local pre-commit signal; a green result here
# does NOT imply the tree is clean — run qc-assert-no-client-names.sh for that.
# The client-name denylist is EXTERNALIZED (no real names live in this file) —
# it is loaded at runtime from the operator-local roster via client-roster-lib.sh
# ($OPENCLAW_CLIENT_ROSTER, else ~/.openclaw/client-roster.txt).
#   * BOX mode (roster present): scan the diff for real roster names.
#   * STRUCTURAL mode (roster absent, e.g. CI): scan the diff for the obviously-
#     fake .example placeholder names instead (never fail-open) and WARN that the
#     full roster-specific diff name-check was skipped.
# Roster machinery holds the denylist DATA / placeholder template legitimately —
# exclude those paths from the diff scan (mirrors qc-assert's _is_excluded set)
# so the template's own placeholder lines never trip the structural check.
_ROSTER_EXCLUDES=(
  ':(exclude)scripts/client-roster.example.txt'
  ':(exclude)scripts/client-roster-lib.sh'
  ':(exclude)scripts/qc-assert-no-client-names.sh'
  ':(exclude)scripts/qc-blocked-gate.sh'
  ':(exclude)tests/fixtures/no-client-names/planted-client-name.txt'
)
if command -v git &>/dev/null && git -C "$REPO_ROOT" rev-parse --git-dir &>/dev/null; then
  # Only scan the diff if we're in a git repo.
  DIFF_FILES=$(git -C "$REPO_ROOT" diff --name-only HEAD -- . "${_ROSTER_EXCLUDES[@]}" 2>/dev/null || true)
  if [[ -n "$DIFF_FILES" ]]; then
    if roster_available; then
      NAME_MODE="box"
      mapfile -t _DENY_NAMES < <(roster_names)
    else
      NAME_MODE="structural"
      mapfile -t _DENY_NAMES < <(roster_example_names)
      echo "[qc-blocked-gate] WARNING: client roster not found ($(roster_resolve_path)); skipping the full roster-specific diff name-check — scanning only for .example placeholder leaks. Set OPENCLAW_CLIENT_ROSTER or create ~/.openclaw/client-roster.txt to enable the authoritative diff check." >&2
    fi
    if [[ "${#_DENY_NAMES[@]}" -gt 0 ]]; then
      CLIENT_NAMES_PATTERN="($(printf '%s\n' "${_DENY_NAMES[@]}" | paste -sd'|' -))"
      DIFF_ADDED=$(git -C "$REPO_ROOT" diff HEAD -- . "${_ROSTER_EXCLUDES[@]}" 2>/dev/null | grep '^+[^+]' || true)
      if echo "$DIFF_ADDED" | grep -qE "$CLIENT_NAMES_PATTERN"; then
        HITS=$(echo "$DIFF_ADDED" | grep -E "$CLIENT_NAMES_PATTERN" | head -3)
        check "no-client-names-in-diff" "fail" "Client name in new diff lines: $HITS"
      else
        check "no-client-names-in-diff ($NAME_MODE-scope; authoritative scan = qc-assert-no-client-names.sh)" "pass"
      fi
    else
      check "no-client-names-in-diff (no denylist entries loaded; authoritative scan = qc-assert-no-client-names.sh)" "pass"
    fi
  else
    check "no-client-names-in-diff (diff-scope; authoritative scan = qc-assert-no-client-names.sh)" "pass" "(no diff to scan)"
  fi
fi

# ── Assertion 6: No Anthropic model pins in new files ─────────────────────────
NEW_FILES=(
  "$REPO_ROOT/src/lib/jobs/stale-task-sweep.ts"
  "$REPO_ROOT/src/app/api/tasks/[id]/return-to-orchestrator/route.ts"
)
ANTHROPIC_HIT=0
for f in "${NEW_FILES[@]}"; do
  if [[ -f "$f" ]] && grep -qE '(claude-|anthropic/)' "$f"; then
    ANTHROPIC_HIT=1
    check "no-anthropic-pins-in-new-files" "fail" "Anthropic model pin found in $f"
    break
  fi
done
if [[ "$ANTHROPIC_HIT" -eq 0 ]]; then
  check "no-anthropic-pins-in-new-files" "pass"
fi

# ── Assertion 7: Artifact-mandatory invariant A — zero-deliverable path ───────
# Confirms that qc-scorer.ts contains:
#   (a) the isArtifactTask guard that calls return-to-orchestrator when a task
#       reaches review with zero registered deliverables, AND
#   (b) that the return-to-orchestrator fetch call exists inside invariant A.
# This is the root-cause fix for the false-done / false-blocked bug (design item #10).
if [[ "${SKIP_ARTIFACT_INVARIANT:-0}" != "1" ]]; then
  QC_SCORER="$REPO_ROOT/src/lib/qc-scorer.ts"
  if [[ ! -f "$QC_SCORER" ]]; then
    check "artifact-mandatory-invariant-a" "fail" "qc-scorer.ts not found: $QC_SCORER"
  else
    # Check for the isArtifactTask guard
    if grep -q "isArtifactTask" "$QC_SCORER" && \
       grep -q "no artifact registered" "$QC_SCORER" && \
       grep -q "return-to-orchestrator" "$QC_SCORER" && \
       grep -q "fileRows.length === 0" "$QC_SCORER"; then
      check "artifact-mandatory-invariant-a" "pass"
    else
      check "artifact-mandatory-invariant-a" "fail" \
        "qc-scorer.ts missing isArtifactTask guard / zero-deliverable return-to-orchestrator path. Root-cause fix #10 not applied."
    fi
  fi
fi

# ── Assertion 8: Mode-B is guarded to non-artifact tasks only ─────────────────
# Confirms the Mode-B comment block explicitly documents that artifact tasks with
# zero deliverables can no longer fall through to description re-scoring.
if [[ "${SKIP_MODEB_GUARD:-0}" != "1" ]]; then
  QC_SCORER="$REPO_ROOT/src/lib/qc-scorer.ts"
  if [[ ! -f "$QC_SCORER" ]]; then
    check "mode-b-non-artifact-only" "fail" "qc-scorer.ts not found: $QC_SCORER"
  else
    if grep -q "Mode B: document/work task (confirmed non-artifact)" "$QC_SCORER" && \
       grep -q "isArtifactTask=false" "$QC_SCORER"; then
      check "mode-b-non-artifact-only" "pass"
    else
      check "mode-b-non-artifact-only" "fail" \
        "Mode-B guard comment missing from qc-scorer.ts — artifact tasks may still fall through to description re-scoring"
    fi
  fi
fi

# ── Summary ───────────────────────────────────────────────────────────────────
printf '\n[qc-blocked-gate] %d passed, %d failed\n' "$PASS" "$FAIL"
if [[ "$FAIL" -gt 0 ]]; then
  printf '[qc-blocked-gate] FAILURES:\n'
  for f in "${FAILURES[@]}"; do
    printf '  - %s\n' "$f"
  done
  exit 1
fi
printf '[qc-blocked-gate] All assertions GREEN -- rubric item #11 passes.\n'
exit 0
