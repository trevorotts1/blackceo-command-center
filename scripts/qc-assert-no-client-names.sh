#!/usr/bin/env bash
# qc-assert-no-client-names.sh — v1.1.0 (command-center)
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
# v1.1.0 ADDS (PRD P0-3 follow-up): a NUMERIC client Telegram chat-ID denylist.
#   Client chat IDs are just as client-identifying as a name, but a bare number
#   is not itself sensitive to LOG — so unlike the name-scan below, any chat-ID
#   hit is MASKED (only the last 4 digits survive) before it is ever printed to
#   stdout/CI logs. See the "MASKED-OUTPUT CONVENTION" block below.
#
# SCANNING STRATEGY:
#   Uses a filesystem walk (`find`) — NOT `git` — so it runs in environments
#   without git (fresh CI clones, containers) and needs no VCS state. The .git,
#   node_modules, and __pycache__ trees are pruned. A single batched grep pass
#   over the file list keeps it fast even on large repos.
#
# SELF-EXCLUSION:
#   Files that legitimately hold client names as BANNED-PATTERN DATA (this gate
#   and the qc-blocked-gate.sh diff-scope check) are path-anchored-excluded.
#   Nothing else is excluded — real source, docs, tests, configs are all scanned.
#
# Exit codes:
#   0  — no client names / chat IDs / operator paths found in tracked files (PASS)
#   1  — one or more found (FAIL — block commit / QC / CI)
#
# Usage:
#   bash scripts/qc-assert-no-client-names.sh
#   bash scripts/qc-assert-no-client-names.sh --repo-root /path/to/repo

set -uo pipefail

# ─── DENYLIST ─────────────────────────────────────────────────────────────────
# Full-name entries: matched as literal ERE strings (case-insensitive).
# First-name-only entries: wrapped in \b word-boundary anchors so short common
# names don't false-positive on ordinary words.
# Kept in sync with the openclaw-onboarding repo's qc-assert-no-client-names.sh
# (the fleet-wide reference denylist). To add a client: append their full name
# AND, if distinctive, a \bFirstName\b entry.
#
# The AGENCY (Trevor Otts / BlackCEO / Convert and Flow / Zero Human Workforce)
# and operator team members are NOT clients and are NOT listed — they may appear.
CLIENT_NAMES=(
  # Full names (literal, case-insensitive)
  "Maria Anderson"
  "Marico Consulting"
  "Evelyn Bethune"
  "Sheila Reynolds"
  "Dr\.? Tola"
  "Temperance"
  "Sir ?Jordan"
  "Laurane Simon"
  # Client GHL location IDs (opaque but client-identifying)
  "mQeLerCLRJzGKzAQoY2Y"
  "Av6hNUcfFQcctNlekVy4"
  "Corey Sams"
  "Stephanie Wall"
  "Star Bobatoon"
  "Karen Vaughn"
  "Aurelia Gardner"
  "Barret Matthews"
  "Lyric Hawkins"
  "Coach Kaz"
  "Beverly Sanders"
  "Angela Tennison"
  "Cassandra Henriquez"
  "Jill Bulluck"
  "Teresa Pelham"
  "Jocelyn McClure"
  "Christy Staples"
  "Erin Garrett"
  "Sonatta Camara"
  "Talaya Kelley"

  # First-name-only patterns (word-boundary anchored)
  "\bCorey\b"
  "\bAurelia\b"
  "\bBarret\b"
  "\bAngeleen\b"
  "\bMonique\b"
  "\bKofi\b"
  "\bEvelyn\b"
  "\bSheila\b"
  "\bLyric\b"
  "\bSonatta\b"
  "\bTalaya\b"
  "\bCassandra\b"
  "\bJocelyn\b"
  "\bChristy\b"
  "\bBeverly\b"
  # NOTE: bare "\bAnderson\b" (present in the onboarding reference list) is
  # intentionally OMITTED here. It is a very common surname and, under the
  # case-insensitive scan, collides with the legitimate security-expert persona
  # hint 'anderson-security-engineering' (Ross Anderson's "Security Engineering"
  # textbook) in src/lib/sops-seed.ts. The full-name pattern "Maria Anderson"
  # above still covers the client. Re-add a more specific anchor if needed.

  # Operator machine path (must never appear in committed files — use $HOME)
  "/Users/blackceomacmini"
)
# ─────────────────────────────────────────────────────────────────────────────

# ─── CLIENT CHAT-ID DENYLIST (PRD P0-3 follow-up) ─────────────────────────────
# Numeric Telegram chat IDs are client-identifying tokens (fleet roster), on par
# with a client's real name. They are matched \b-anchored (whole-number tokens
# only, so they never false-positive as a substring of an unrelated longer
# number) and, unlike the name-scan above, MATCHES ARE NEVER PRINTED IN FULL —
# see "MASKED-OUTPUT CONVENTION" below.
#
# ALLOWLIST: 5252140759 is Trevor's operator rescue sentinel — configuration,
# not a leak. It is deliberately excluded from this array and must stay that
# way; do not add it here even if it shows up in a future scan finding.
CLIENT_CHAT_IDS=(
  "871463120"
  "6949338820"
  "8959124298"
  "8566720334"
)
# shellcheck disable=SC2034  # documents the allowlisted value; intentionally unused in matching
OPERATOR_SENTINEL_CHAT_ID="5252140759"  # operator rescue sentinel — configuration, not a leak
# ─────────────────────────────────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

while [ $# -gt 0 ]; do
  case "$1" in
    --repo-root) REPO_ROOT="$2"; shift 2 ;;
    -h|--help) sed -n '1,40p' "$0"; exit 0 ;;
    *) echo "Unknown arg: $1" >&2; exit 2 ;;
  esac
done

# Build a single ERE alternation from the denylist.
PATTERN=$(printf '%s\n' "${CLIENT_NAMES[@]}" | paste -sd'|' -)

# Whole-number, \b-anchored alternation for the chat-ID denylist.
CHATID_PATTERN=$(printf '\\b%s\\b\n' "${CLIENT_CHAT_IDS[@]}" | paste -sd'|' -)

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
# Path-anchored: only files that hold client names as BANNED-PATTERN DATA are
# skipped (this gate + the diff-scope qc-blocked-gate.sh). Everything else is
# scanned — no source/doc/test/config file may hide a leak behind an exclusion.
_is_excluded() {
  case "$1" in
    */scripts/qc-assert-no-client-names.sh) return 0 ;;
    */scripts/qc-blocked-gate.sh)           return 0 ;;
    # Planted CI self-test fixture — holds a denylisted name + operator path as
    # detection TEST DATA (the gate's self-test copies it out and expects a FAIL).
    */tests/fixtures/no-client-names/planted-client-name.txt) return 0 ;;
  esac
  return 1
}

# ─── MASKED-OUTPUT CONVENTION ─────────────────────────────────────────────────
# Chat-ID hits are reported as "  <path>:<line>: ******<last4>" — the file and
# line number are shown (so the leak is locatable and fixable) but the token
# itself is NEVER printed in full, only its last 4 digits behind a mask. This
# is the gate's one masked-output convention; if a future denylist class needs
# masking too, reuse this "path:line: ******last4" shape.
_masked_token_for_line() {
  local content="$1"
  local id
  for id in "${CLIENT_CHAT_IDS[@]}"; do
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

# ─── Chat-ID scan pass (masked output — see convention above) ────────────────
CHATID_HITS=0
CHATID_OFFENDERS=()
declare -A _PER_FILE_CHATID_HITS=()
if [ "${#FILES[@]}" -gt 0 ]; then
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
  echo "[qc-assert-no-client-names] PASS — no client names / chat IDs / operator paths in tracked files."
  exit 0
else
  echo "[qc-assert-no-client-names] INVARIANT VIOLATED — $TOTAL_HITS client-identifying hit(s) in tracked files:"
  for line in "${OFFENDERS[@]}"; do
    echo "$line"
  done
  for line in "${CHATID_OFFENDERS[@]}"; do
    echo "$line"
  done
  echo
  echo "REMEDY: replace each real client name / chat ID / operator path with a neutral placeholder."
  echo "  Prose:  'a client box', 'a client VPS', '<client-1>'"
  echo "  Config: env/config lookup with a safe default (e.g. \$HOME, <CLIENT_SLUG>)"
  echo "  URLs:   'acme.zerohumanworkforce.com' or 'client.example.com'"
  echo "  Chat IDs: use an obviously-synthetic literal in tests (e.g. 1000000001)."
  echo "  See repo memory [repo-is-fleet-wide-no-client-names]."
  exit 1
fi
