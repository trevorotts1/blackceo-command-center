#!/usr/bin/env bash
# qc-assert-no-client-names.sh — v3.0.0 (command-center)
#
# ─── THE RULE (operator, 2026-07-11 — AUTHORITATIVE; supersedes v2.x) ─────────
# The command-center repo is FLEET-WIDE — it is cloned to every client box.
# Exactly THREE things are enforceable, and NOTHING else:
#
#   1. No CLIENT / ROSTER MEMBER real HUMAN NAMES — an actual customer or team
#      member. NOT book characters. NOT personas. NOT authors of referenced works.
#   2. No genuine SECRETS — live tokens, API keys, `pit-` GHL tokens, bot tokens,
#      private keys. ABSOLUTE. DO NOT WEAKEN THIS.
#   3. Nothing built for ONE client — content stays generic and fleet-reusable.
#
# ─── ⚠️ EXPLICITLY EXEMPT — NEVER flag, block, or scrub ⚠️ ────────────────────
#   • Cloudflare Access Application UUIDs / AUD tags
#   • Telegram chat IDs
#   • GHL location IDs
#   • ANY opaque identifier (UUID, numeric ID, hash)
#   • Book titles
#   • Persona names derived from books
#   • Authors of referenced works
#   • Product proper nouns
#
# GOVERNING PRINCIPLE: opaque infrastructure identifiers and product content are
# NOT the target.
#
# WHAT v3.0.0 REMOVED (and why): v2.x carried a chat-ID denylist (CHATID_PATTERN),
# a separate chat-ID scan pass, and a masked-token formatter, and its roster
# accessor swept GHL location IDs in as scan terms. All of that enforced an
# OVER-BROAD rule — it hard-blocked PRs over EXEMPT opaque identifiers. It is
# deleted. ⛔ Do NOT re-add an identifier pass here.
#
# ─── ⛔ WHY THIS GATE IS DELIBERATELY NARROW ──────────────────────────────────
# NEVER enforce the NAME rule with a grep / regex / name-roster ALONE. A pattern
# match cannot tell a client's real name from a book-persona name — it either
# misses real leaks or blocks legitimate product PRs forever. The AUTHORITATIVE
# name check is the LLM reviewer (scripts/qc-llm-diff-review.py, run on every PR).
# This script survives only as a cheap always-on scan for the two things that DO
# have a literal shape: the operator machine path, and .example placeholder leaks.
# (Regex IS still correct for SECRETS — a secret has a literal shape; a human
# name does not.)
#
# WHY A WHOLE-TREE SCAN EXISTS (PRD P2-5):
#   qc-blocked-gate.sh Assertion 5 only scans the *git diff*, so names that were
#   ALREADY committed never trip it. This gate walks EVERY tracked file on disk.
#
#   TWO MODES:
#     * BOX MODE (roster present): scan every tracked file for every real client
#       HUMAN NAME in the roster. Any hit FAILS (exit 1).
#     * STRUCTURAL MODE (roster absent/empty, e.g. CI without the secret): the
#       gate MUST NOT silently pass. It runs a STRUCTURAL check instead — it
#       still scans for the operator machine path AND for the obviously-fake
#       placeholder names from scripts/client-roster.example.txt (a placeholder
#       leak must still fail — never fail-open) — and emits a clear WARNING that
#       the full roster-specific name check was skipped.
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
#   0  — no client/roster human names / operator paths / placeholder leaks (PASS)
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
    -h|--help) sed -n '1,75p' "$0"; exit 0 ;;
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
  mapfile -t CLIENT_NAMES < <(roster_names)
else
  MODE="structural"
  # NEVER fail-open: in structural mode we scan for the obviously-fake .example
  # placeholder names (a placeholder leak must still exit non-zero) plus the
  # operator path — but we DO skip the real-roster-specific human-name scan.
  mapfile -t CLIENT_NAMES < <(roster_example_names)
  {
    echo "WARNING: client roster not found (looked at \$OPENCLAW_CLIENT_ROSTER"
    echo "         and $(roster_resolve_path))."
    echo "WARNING: SKIPPING the full roster-specific client-name scan; running the"
    echo "         STRUCTURAL check only (operator-path scan + .example placeholder-"
    echo "         leak scan). Set OPENCLAW_CLIENT_ROSTER or create"
    echo "         ${HOME}/.openclaw/client-roster.txt to enable the authoritative check."
  } >&2
fi

# ─── Build the name/token ERE alternation (client HUMAN NAMES + operator paths) ─
# NOTE: there is NO identifier pass here. The chat-ID denylist (CHATID_PATTERN),
# its scan pass, and the masked-token formatter have been REMOVED: Telegram chat
# IDs and GHL location IDs are EXPLICITLY EXEMPT. Do not re-add them.
SCAN_TERMS=()
SCAN_TERMS+=( ${CLIENT_NAMES[@]+"${CLIENT_NAMES[@]}"} )
SCAN_TERMS+=( "${OPERATOR_PATHS[@]}" )
PATTERN=$(printf '%s\n' "${SCAN_TERMS[@]}" | paste -sd'|' -)

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

# NOTE: the chat-ID scan pass that used to live here is DELETED. Telegram chat IDs
# are EXPLICITLY EXEMPT — they are opaque infrastructure identifiers, not client
# identity, and scanning for them hard-blocked legitimate PRs. Do not re-add it.

if [ "$HITS" -eq 0 ]; then
  if [ "$MODE" = "structural" ]; then
    echo "[qc-assert-no-client-names] STRUCTURAL PASS — no operator paths and no .example"
    echo "  placeholder leaks in tracked files. (Full roster-specific name scan was SKIPPED;"
    echo "  roster absent. Run on an operator box / with OPENCLAW_CLIENT_ROSTER for the"
    echo "  authoritative check.)"
  else
    echo "[qc-assert-no-client-names] PASS — no client/roster human names or operator paths in tracked files."
  fi
  exit 0
else
  echo "[qc-assert-no-client-names] INVARIANT VIOLATED — $HITS client/roster human-name hit(s) in tracked files:"
  for line in "${OFFENDERS[@]}"; do
    echo "$line"
  done
  echo
  if [ "$MODE" = "structural" ]; then
    echo "NOTE: running in STRUCTURAL mode (roster absent) — the hits above are an"
    echo "  operator-path leak and/or a committed .example PLACEHOLDER name. Placeholder"
    echo "  names must never appear in tracked content; remove them (the gate is fail-closed)."
  fi
  echo "REMEDY: replace each real client/roster HUMAN NAME / operator path with a neutral placeholder."
  echo "  Prose:  'a client box', 'a client VPS', '<client-1>'"
  echo "  Config: env/config lookup with a safe default (e.g. \$HOME, <CLIENT_SLUG>)"
  echo "  URLs:   'acme.zerohumanworkforce.com' or 'client.example.com'"
  echo
  echo "NOT A VIOLATION (EXEMPT — if the gate flagged one of these, the gate is wrong):"
  echo "  Cloudflare Access Application UUIDs / AUD tags · Telegram chat IDs ·"
  echo "  GHL location IDs · any opaque identifier (UUID, numeric ID, hash) ·"
  echo "  book titles · persona names derived from books · authors of referenced"
  echo "  works · product proper nouns."
  echo "  Opaque infrastructure identifiers and product content are NOT the target."
  echo
  echo "  See QC.md → 'FLEET-REPO CONTENT RULE' for the full rule."
  exit 1
fi
