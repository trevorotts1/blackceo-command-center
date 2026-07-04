#!/usr/bin/env bash
# qc-assert-no-client-names.sh — v2.0.0 (command-center)
#
# STATIC QC INVARIANT: enforces the fleet-wide rule that NO real client name,
# client-identifying token, or operator machine path may appear in ANY TRACKED
# file of this repo. The command-center repo is cloned to every client box, so
# any client-identifying string is a privacy / co-mingling violation (PRD P0-3).
#
# WHY THIS EXISTS (PRD P2-5):
#   The pre-existing qc-blocked-gate.sh Assertion 5 only scans the *git diff*,
#   so client names that were ALREADY committed to tracked files never trip it.
#   This gate is the AUTHORITATIVE scan: it walks EVERY tracked file on disk
#   (not just the diff) so historical/committed leaks are caught too.
#
# v2.0.0 — ROSTER EXTERNALIZATION:
#   The real client roster (names, Telegram chat IDs, GHL location IDs) NO LONGER
#   lives inline in this file — it lives in NO tracked file and NOWHERE on
#   GitHub. It is loaded at runtime from an operator-local, gitignored roster
#   (see scripts/client-roster-lib.sh):
#       $OPENCLAW_CLIENT_ROSTER  ->  else  ${HOME}/.openclaw/client-roster.txt
#
#   TWO MODES:
#     * BOX MODE (roster present): scan every tracked file for every real client
#       name / chat ID / GHL ID in the roster. Any hit FAILS (exit 1). This is
#       the authoritative check; it runs on operator boxes and pre-commit.
#     * STRUCTURAL MODE (roster absent/empty, e.g. CI without the secret): the
#       gate MUST NOT silently pass. It runs a STRUCTURAL check instead — it
#       still scans for the operator machine path AND for the obviously-fake
#       placeholder names from scripts/client-roster.example.txt (a placeholder
#       leak must still fail — never fail-open) — and emits a clear WARNING that
#       the full roster-specific name check was skipped. The authoritative
#       roster check runs where the roster exists.
#
#   Numeric client chat-ID hits are still MASKED in output (only the last 4
#   digits survive) — see the "MASKED-OUTPUT CONVENTION" block below.
#
# SCANNING STRATEGY:
#   Uses a filesystem walk (`find`) — NOT `git` — so it runs in environments
#   without git (fresh CI clones, containers) and needs no VCS state. The .git,
#   node_modules, and __pycache__ trees are pruned. A single batched grep pass
#   over the file list keeps it fast even on large repos.
#
# SELF-EXCLUSION:
#   Files that legitimately hold client names as BANNED-PATTERN DATA (this gate,
#   the qc-blocked-gate.sh diff-scope check, the roster loader + its .example
#   template, and the planted CI self-test fixture) are path-anchored-excluded.
#   Nothing else is excluded — real source, docs, tests, configs are all scanned.
#
# Exit codes:
#   0  — no client names / chat IDs / operator paths / placeholder leaks found (PASS)
#   1  — one or more found (FAIL — block commit / QC / CI)
#
# Usage:
#   bash scripts/qc-assert-no-client-names.sh
#   bash scripts/qc-assert-no-client-names.sh --repo-root /path/to/repo
#   OPENCLAW_CLIENT_ROSTER=/path/to/roster.txt bash scripts/qc-assert-no-client-names.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/client-roster-lib.sh
source "$SCRIPT_DIR/client-roster-lib.sh"

REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

while [ $# -gt 0 ]; do
  case "$1" in
    --repo-root) REPO_ROOT="$2"; shift 2 ;;
    -h|--help) sed -n '1,55p' "$0"; exit 0 ;;
    *) echo "Unknown arg: $1" >&2; exit 2 ;;
  esac
done

# ─── OPERATOR MACHINE PATH (roster-INDEPENDENT) ───────────────────────────────
# Not a client identifier, so it is NOT part of the externalized roster — but it
# must never appear in committed files (use $HOME instead). Scanned in BOTH
# modes so a leaked operator path always fails the gate.
OPERATOR_PATHS=(
  "/Users/blackceomacmini"
)

# ─── MODE SELECTION: box (roster present) vs structural (roster absent) ────────
if roster_available; then
  MODE="box"
  mapfile -t CLIENT_NAMES    < <(roster_names)
  mapfile -t CLIENT_CHAT_IDS < <(roster_chat_ids)
else
  MODE="structural"
  # NEVER fail-open: in structural mode we scan for the obviously-fake .example
  # placeholder names (a placeholder leak must still exit non-zero) plus the
  # operator path — but we DO skip the real-roster-specific name/chat-ID scan.
  mapfile -t CLIENT_NAMES < <(roster_example_names)
  CLIENT_CHAT_IDS=()
  {
    echo "WARNING: client roster not found (looked at \$OPENCLAW_CLIENT_ROSTER"
    echo "         and $(roster_resolve_path))."
    echo "WARNING: SKIPPING the full roster-specific client-name scan; running the"
    echo "         STRUCTURAL check only (operator-path scan + .example placeholder-"
    echo "         leak scan). Set OPENCLAW_CLIENT_ROSTER or create"
    echo "         ${HOME}/.openclaw/client-roster.txt to enable the authoritative check."
  } >&2
fi

# ─── Build the name/token ERE alternation (client names + operator paths) ─────
SCAN_TERMS=()
SCAN_TERMS+=( ${CLIENT_NAMES[@]+"${CLIENT_NAMES[@]}"} )
SCAN_TERMS+=( "${OPERATOR_PATHS[@]}" )
PATTERN=$(printf '%s\n' "${SCAN_TERMS[@]}" | paste -sd'|' -)

# Whole-number, \b-anchored alternation for the chat-ID denylist (box mode only).
CHATID_PATTERN=""
if [ "${#CLIENT_CHAT_IDS[@]}" -gt 0 ]; then
  CHATID_PATTERN=$(printf '\\b%s\\b\n' "${CLIENT_CHAT_IDS[@]}" | paste -sd'|' -)
fi

# ─── File enumeration (filesystem walk — no git) ─────────────────────────────
# Prune the .git, node_modules, and __pycache__ trees, then take every regular
# text-ish file. We enumerate by extension (plus dotfiles like .env) so binary
# assets are skipped.
_list_files() {
  local root="$1"
  find "$root" \
    \( -path "$root/.git" -o -path "$root/node_modules" -o -name "__pycache__" \) -prune \
    -o -type f \( \
        -name "*.md"   -o -name "*.sh"   -o -name "*.json" -o -name "*.txt" \
        -o -name "*.yaml" -o -name "*.yml" -o -name "*.py"  -o -name "*.mjs" \
        -o -name "*.js"   -o -name "*.ts"  -o -name "*.tsx" -o -name "*.jsx" \
        -o -name "*.cjs"  -o -name "*.html" -o -name "*.css" -o -name "*.toml" \
        -o -name "*.sql"  -o -name "*.conf" -o -name "*.cfg" -o -name "*.ini" \
        -o -name "*.xml"  -o -name "*.csv" -o -name "*.plist" -o -name "*.tf" \
        -o -name "*.template" -o -name "*.tmpl" -o -name "*.example" \
        -o -name "*.sample" -o -name ".env" -o -name "*.env" \
      \) -print
}

# ─── Self-exclusion predicate ─────────────────────────────────────────────────
# Path-anchored: only files that hold client names as BANNED-PATTERN DATA or as
# the roster machinery are skipped (this gate + the diff-scope qc-blocked-gate.sh
# + the roster loader + its .example template + the planted self-test fixture).
# Everything else is scanned — no source/doc/test/config file may hide a leak.
_is_excluded() {
  case "$1" in
    */scripts/qc-assert-no-client-names.sh) return 0 ;;
    */scripts/qc-blocked-gate.sh)           return 0 ;;
    */scripts/client-roster-lib.sh)         return 0 ;;
    */scripts/client-roster.example.txt)    return 0 ;;
    # Planted CI self-test fixture — holds a placeholder name + operator path as
    # detection TEST DATA (the gate's self-test copies it out and expects a FAIL).
    */tests/fixtures/no-client-names/planted-client-name.txt) return 0 ;;
  esac
  return 1
}

# ─── MASKED-OUTPUT CONVENTION ─────────────────────────────────────────────────
# Chat-ID hits are reported as "  <path>:<line>: ******<last4>" — the file and
# line number are shown (so the leak is locatable and fixable) but the token
# itself is NEVER printed in full, only its last 4 digits behind a mask.
_masked_token_for_line() {
  local content="$1"
  local id
  for id in ${CLIENT_CHAT_IDS[@]+"${CLIENT_CHAT_IDS[@]}"}; do
    case "$content" in
      *"$id"*) printf '******%s' "${id: -4}"; return 0 ;;
    esac
  done
  printf '******????'
}

HITS=0
OFFENDERS=()

FILES=()
while IFS= read -r f; do
  _is_excluded "$f" && continue
  FILES+=("$f")
done < <(_list_files "$REPO_ROOT")

declare -A _PER_FILE_HITS=()
if [ "${#FILES[@]}" -gt 0 ]; then
  while IFS= read -r hit_line; do
    [ -z "$hit_line" ] && continue
    # grep -H output is `path:lineno:line`; the path is the first field.
    path="${hit_line%%:*}"
    n=$(( ${_PER_FILE_HITS["$path"]:-0} + 1 ))
    _PER_FILE_HITS["$path"]=$n
    [ "$n" -gt 20 ] && continue   # per-file cap so one noisy file can't flood
    OFFENDERS+=("  $hit_line")
    HITS=$((HITS + 1))
  done < <(printf '%s\0' "${FILES[@]}" \
             | xargs -0 grep -E -Hin "$PATTERN" 2>/dev/null)
fi

# ─── Chat-ID scan pass (masked output — box mode only) ───────────────────────
CHATID_HITS=0
CHATID_OFFENDERS=()
declare -A _PER_FILE_CHATID_HITS=()
if [ -n "$CHATID_PATTERN" ] && [ "${#FILES[@]}" -gt 0 ]; then
  while IFS= read -r hit_line; do
    [ -z "$hit_line" ] && continue
    path="${hit_line%%:*}"
    rest="${hit_line#*:}"
    lineno="${rest%%:*}"
    content="${rest#*:}"
    n=$(( ${_PER_FILE_CHATID_HITS["$path"]:-0} + 1 ))
    _PER_FILE_CHATID_HITS["$path"]=$n
    [ "$n" -gt 20 ] && continue   # per-file cap so one noisy file can't flood
    masked="$(_masked_token_for_line "$content")"
    CHATID_OFFENDERS+=("  $path:$lineno: $masked")
    CHATID_HITS=$((CHATID_HITS + 1))
  done < <(printf '%s\0' "${FILES[@]}" \
             | xargs -0 grep -E -Hin "$CHATID_PATTERN" 2>/dev/null)
fi

TOTAL_HITS=$((HITS + CHATID_HITS))

if [ "$TOTAL_HITS" -eq 0 ]; then
  if [ "$MODE" = "structural" ]; then
    echo "[qc-assert-no-client-names] STRUCTURAL PASS — no operator paths and no .example"
    echo "  placeholder leaks in tracked files. (Full roster-specific name scan was SKIPPED;"
    echo "  roster absent. Run on an operator box / with OPENCLAW_CLIENT_ROSTER for the"
    echo "  authoritative check.)"
  else
    echo "[qc-assert-no-client-names] PASS — no client names / chat IDs / operator paths in tracked files."
  fi
  exit 0
else
  echo "[qc-assert-no-client-names] INVARIANT VIOLATED — $TOTAL_HITS client-identifying hit(s) in tracked files:"
  for line in "${OFFENDERS[@]}"; do
    echo "$line"
  done
  for line in ${CHATID_OFFENDERS[@]+"${CHATID_OFFENDERS[@]}"}; do
    echo "$line"
  done
  echo
  if [ "$MODE" = "structural" ]; then
    echo "NOTE: running in STRUCTURAL mode (roster absent) — the hits above are an"
    echo "  operator-path leak and/or a committed .example PLACEHOLDER name. Placeholder"
    echo "  names must never appear in tracked content; remove them (the gate is fail-closed)."
  fi
  echo "REMEDY: replace each real client name / chat ID / operator path with a neutral placeholder."
  echo "  Prose:  'a client box', 'a client VPS', '<client-1>'"
  echo "  Config: env/config lookup with a safe default (e.g. \$HOME, <CLIENT_SLUG>)"
  echo "  URLs:   'acme.zerohumanworkforce.com' or 'client.example.com'"
  echo "  Chat IDs: use an obviously-synthetic literal in tests (e.g. 1000000001)."
  echo "  See repo memory [repo-is-fleet-wide-no-client-names]."
  exit 1
fi
