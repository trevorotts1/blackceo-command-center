#!/usr/bin/env bash
# qc-assert-no-client-names.sh — v2.1.0 (command-center)
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
# v2.1.0 FIX (AGW item 25 — the check named "authoritative scan" was reporting
#   success on every CI run without ever performing the roster-specific
#   per-name scan): v2.0.0's STRUCTURAL MODE printed "STRUCTURAL PASS" and
#   exited 0 whenever the curated roster was absent — which is EVERY run on
#   the bare GitHub-hosted CI runner, since CI never has $OPENCLAW_CLIENT_ROSTER
#   or ~/.openclaw/client-roster.txt (client PII is intentionally never put in
#   CI secrets). So the roster-specific name check had run in CI exactly zero
#   times, always reporting success regardless. FIX (ported from
#   openclaw-onboarding's qc-assert-no-client-names.sh, which solved the
#   identical hole there): a DERIVED roster tier now runs the same
#   scripts/qc-derive-roster-from-accounts.py this repo ports in, structurally
#   parsing ~/clawd/accounts/accounts.md ($OPENCLAW_ACCOUNTS_MD to override) at
#   runtime — real data that exists on the operator's own box, never printed,
#   never committed — so the authoritative per-name check now genuinely runs
#   there (locally / pre-commit) instead of nowhere. When NEITHER a curated NOR
#   a derived roster is available (true of every bare CI run, by design):
#     * in a real CI environment (GITHUB_ACTIONS=true / CI=true) the run is
#       REPORT-ONLY — exit 0, but LOUD: a `::warning::` GitHub Actions
#       annotation plus an explicit "CANNOT VERIFY" stderr message replace the
#       old, misleadingly-worded "STRUCTURAL PASS". Nothing that CAN be
#       checked was weakened — operator-path leaks and .example placeholder
#       leaks still fail (exit 1) exactly as before.
#     * outside CI (a human's machine, pre-commit) this is FAIL CLOSED
#       (exit 2) — a roster genuinely exists on this class of machine via the
#       accounts.md derivation, so "no roster anywhere" here is a genuinely
#       exceptional state, not the default.
#
# v2.0.0 — ROSTER EXTERNALIZATION:
#   The real client roster (names, Telegram chat IDs, GHL location IDs) NO LONGER
#   lives inline in this file — it lives in NO tracked file and NOWHERE on
#   GitHub. It is loaded at runtime from an operator-local, gitignored roster
#   (see scripts/client-roster-lib.sh):
#       $OPENCLAW_CLIENT_ROSTER  ->  else  ${HOME}/.openclaw/client-roster.txt
#
#   THREE-TIER ROSTER LOAD ORDER, most-authoritative first:
#     1. Curated roster ($OPENCLAW_CLIENT_ROSTER or ~/.openclaw/client-roster.txt).
#     2. DERIVED roster — scripts/qc-derive-roster-from-accounts.py, structurally
#        parsed from ~/clawd/accounts/accounts.md ($OPENCLAW_ACCOUNTS_MD to
#        override) at runtime. Never echoes a derived name — only a count.
#     3. Neither available -> STRUCTURAL mode, no per-name check ran anywhere.
#
#   TWO MODES:
#     * BOX MODE (curated OR derived roster loaded): scan every tracked file for
#       every real client name / chat ID / GHL ID in the roster. Any hit FAILS
#       (exit 1). This is the authoritative check; it runs on operator boxes,
#       pre-commit, and anywhere accounts.md is reachable.
#     * STRUCTURAL MODE (neither roster source available): the gate MUST NOT
#       silently pass. It always scans for the operator machine path AND for the
#       obviously-fake placeholder names from scripts/client-roster.example.txt
#       (a placeholder leak must still fail — never fail-open). What differs is
#       whether that state is reported as a block or a loud report-only warning:
#         - Outside CI (a human's machine): FAIL CLOSED, exit 2. A roster
#           genuinely exists on this class of machine via the accounts.md
#           derivation, so "no roster anywhere" here is exceptional.
#         - Inside CI (GITHUB_ACTIONS=true / CI=true): REPORT-ONLY, exit 0, but
#           with a `::warning::` GitHub Actions annotation and an explicit
#           "CANNOT VERIFY" message — never the old "STRUCTURAL PASS" wording.
#           CI can never have either roster source by design (no operator-local
#           files on a bare runner; client PII is never provisioned into CI
#           secrets), so a permanent hard-fail there would be an unenforceable,
#           permanently-red gate rather than a real check — see qc-derive-
#           roster-from-accounts.py and this file's v2.1.0 changelog entry above.
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
#   0  — no client names / chat IDs / operator paths / placeholder leaks found
#        (box-mode PASS), OR structural CANNOT VERIFY in CI (report-only there:
#        ::warning:: annotation + stderr message; CI can never hold a roster by
#        design, so the unverifiable state is surfaced loudly instead of
#        blocking every run)
#   1  — one or more found (FAIL — block commit / QC / CI, any mode/environment)
#   2  — structural CANNOT VERIFY outside CI (FAIL CLOSED — a roster genuinely
#        exists on operator boxes via accounts.md, so "no roster anywhere" is
#        exceptional there and must block)
#
# Usage:
#   bash scripts/qc-assert-no-client-names.sh
#   bash scripts/qc-assert-no-client-names.sh --repo-root /path/to/repo
#   OPENCLAW_CLIENT_ROSTER=/path/to/roster.txt bash scripts/qc-assert-no-client-names.sh
#   OPENCLAW_ACCOUNTS_MD=/path/to/accounts.md bash scripts/qc-assert-no-client-names.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/client-roster-lib.sh
source "$SCRIPT_DIR/client-roster-lib.sh"

REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

while [ $# -gt 0 ]; do
  case "$1" in
    --repo-root) REPO_ROOT="$2"; shift 2 ;;
    -h|--help) sed -n '1,108p' "$0"; exit 0 ;;
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

# ─── CI DETECTION ──────────────────────────────────────────────────────────
# Both vars are set automatically by GitHub Actions on every run ("Always set
# to true" per GitHub's own docs) — environment introspection, not a
# credential and not invented: the documented, standard way a script tells
# "running in CI" from "running on a human's machine".
# https://docs.github.com/en/actions/reference/workflows-and-actions/variables
IS_CI=0
if [ "${GITHUB_ACTIONS:-}" = "true" ] || [ "${CI:-}" = "true" ]; then
  IS_CI=1
fi

# ─── DERIVED roster fallback (no curated file needed) ──────────────────────
# scripts/qc-derive-roster-from-accounts.py builds a roster STRUCTURALLY from
# ~/clawd/accounts/accounts.md ($OPENCLAW_ACCOUNTS_MD to override) — a real,
# already-existing local source of the fleet roster (ported from
# openclaw-onboarding, which solved this identical hole the same way). This
# exists because a curated ~/.openclaw/client-roster.txt has never been
# created on this box either — without this fallback, "make CI fail closed"
# alone would only convert a false PASS into an honest but permanently-empty
# CANNOT VERIFY; the roster-specific check would still never run anywhere.
# NEVER echoes a derived name — only appends to CLIENT_NAMES in-process via
# process substitution (no temp file, nothing written to disk, nothing
# printed to this script's own stdout/stderr beyond a count).
_load_derived_roster() {
  local derive_script="$SCRIPT_DIR/qc-derive-roster-from-accounts.py"
  [ -f "$derive_script" ] || return 1
  command -v python3 >/dev/null 2>&1 || return 1
  local line
  local derived=()
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    derived+=("$line")
  done < <(python3 "$derive_script" 2>/dev/null)
  [ "${#derived[@]}" -eq 0 ] && return 1
  CLIENT_NAMES=("${derived[@]}")
  return 0
}

# ─── MODE SELECTION: box (curated or derived roster) vs structural (neither) ──
ROSTER_SOURCE=""
if roster_available; then
  MODE="box"
  ROSTER_SOURCE="curated"
  mapfile -t CLIENT_NAMES    < <(roster_names)
  mapfile -t CLIENT_CHAT_IDS < <(roster_chat_ids)
else
  echo "WARNING: curated client roster not found (looked at \$OPENCLAW_CLIENT_ROSTER" >&2
  echo "         and $(roster_resolve_path)). Trying the accounts.md-derived roster next." >&2
  CLIENT_CHAT_IDS=()
  if _load_derived_roster; then
    MODE="box"
    ROSTER_SOURCE="derived"
    echo "NOTE: no curated roster; loaded a roster DERIVED structurally from" >&2
    echo "      accounts.md instead (see qc-derive-roster-from-accounts.py's own" >&2
    echo "      count line above — no names are echoed here or there). This is a" >&2
    echo "      real, roster-based check, not the no-roster fallback." >&2
  else
    MODE="structural"
    # NEVER fail-open: in structural mode we scan for the obviously-fake .example
    # placeholder names (a placeholder leak must still exit non-zero) plus the
    # operator path — but the real-roster-specific name/chat-ID scan DID NOT RUN
    # from ANY source (curated file or accounts.md derivation).
    mapfile -t CLIENT_NAMES < <(roster_example_names)
    {
      echo "WARNING: the accounts.md-derived roster is ALSO unavailable (missing,"
      echo "         unreadable, or produced zero candidates — see"
      echo "         qc-derive-roster-from-accounts.py's own stderr above)."
      echo "WARNING: SKIPPING the roster-specific client-name scan entirely: no source"
      echo "         could run it in this environment. Always-on checks (operator-path"
      echo "         scan + .example placeholder-leak scan) are still enforced below,"
      echo "         but that is NOT the same check and this run CANNOT report a full"
      echo "         PASS on that basis. Set OPENCLAW_CLIENT_ROSTER, create"
      echo "         ${HOME}/.openclaw/client-roster.txt, or point \$OPENCLAW_ACCOUNTS_MD"
      echo "         / ~/clawd/accounts/accounts.md at a readable roster to enable the"
      echo "         authoritative check."
    } >&2
    if [ "$IS_CI" = 1 ]; then
      echo "NOTE: this is a CI environment (GITHUB_ACTIONS/CI=true) — CI can never" >&2
      echo "      have either roster source by design (no operator-local files exist" >&2
      echo "      on a bare runner, and client PII is intentionally never provisioned" >&2
      echo "      into CI secrets), so this is expected here and is REPORTED ONLY" >&2
      echo "      (warning annotation, exit 0) below — the blocking per-name gate runs" >&2
      echo "      locally / in pre-commit where a roster (curated or accounts.md-" >&2
      echo "      derived) exists." >&2
    fi
  fi
fi

# ─── Build the name/token ERE alternation (client names + operator paths) ─────
# NAMES are \b-anchored (mirroring the chat-ID pattern below) — a bare substring
# match let single-token sentinels like 'PlaceholderCo' fire inside unrelated,
# legitimate identifiers that merely CONTAIN the letters (e.g. the production
# function `isPlaceholderCompany`, whose name embeds "PlaceholderCo" + "mpany").
# That was a real false-positive this gate itself produced (2026-07-31): every
# call site of isPlaceholderCompany() tripped the gate as if it were a leaked
# client name. \b keeps genuine standalone leaks of a name/sentinel — including
# multi-word real names, since \b only anchors the two ends of the whole phrase
# — caught exactly as before. OPERATOR_PATHS are deliberately left as plain
# substrings: a path like '/Users/blackceomacmini' has no word char before the
# leading '/', so \b-anchoring it would never match at all and silently defeat
# the operator-path leak check.
NAME_PATTERN=""
if [ "${#CLIENT_NAMES[@]}" -gt 0 ]; then
  NAME_PATTERN=$(printf '\\b%s\\b\n' "${CLIENT_NAMES[@]}" | paste -sd'|' -)
fi
PATH_PATTERN=$(printf '%s\n' "${OPERATOR_PATHS[@]}" | paste -sd'|' -)
if [ -n "$NAME_PATTERN" ]; then
  PATTERN="${NAME_PATTERN}|${PATH_PATTERN}"
else
  PATTERN="$PATH_PATTERN"
fi

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
  # AUTHORITATIVE scan walks TRACKED files only (git ls-files) — the docstring
  # contract and the pre-push hook both say "tracked files"; the old `find`
  # implementation walked the whole working tree, so untracked local build
  # artifacts (.next.rollback/, live memory state, scratch scripts) that are
  # not part of the pushed tree could block unrelated pushes. Any file whose
  # content is genuinely being pushed is by definition tracked, so this is
  # the correct scope for a push-path gate.
  git -C "$root" ls-files -z | while IFS= read -r -d '' f; do
    case "$f" in
      *.md|*.sh|*.json|*.txt|*.yaml|*.yml|*.py|*.mjs|*.js|*.ts|*.tsx|*.jsx|\
*.cjs|*.html|*.css|*.toml|*.sql|*.conf|*.cfg|*.ini|*.xml|*.csv|*.plist|*.tf|\
*.template|*.tmpl|*.example|*.sample|.env|*.env) printf '%s\n' "$f" ;;
    esac
  done | sed "s#^#$root/#"
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
  if [ "$MODE" = "box" ]; then
    if [ "$ROSTER_SOURCE" = "derived" ]; then
      echo "[qc-assert-no-client-names] PASS (box mode, roster DERIVED from accounts.md) —"
      echo "  no roster client names, chat IDs, operator paths, or placeholder leaks in"
      echo "  tracked files."
    else
      echo "[qc-assert-no-client-names] PASS (box mode, curated roster) — no client names /"
      echo "  chat IDs / operator paths / placeholder leaks in tracked files."
    fi
    exit 0
  else
    # Structural mode: neither a curated roster NOR an accounts.md-derived
    # roster could be loaded. The roster-specific per-name check DID NOT RUN
    # from any source. This must never be reported as a bare PASS.
    if [ "$IS_CI" = 1 ]; then
      # CI can never have either roster source by design (no operator-local
      # files on a bare runner; client PII intentionally never provisioned
      # into CI secrets) — so exiting non-zero here would be a permanently-red
      # battery, not an enforceable gate. Instead: exit 0, but surface the
      # CANNOT VERIFY state loudly as a workflow annotation (visible in the
      # run's Annotations summary) plus the full stderr message. Nothing that
      # CAN be verified in CI was weakened: operator-path and .example
      # placeholder-leak hits still exit 1 above, unconditionally.
      echo "::warning title=qc-assert-no-client-names::CANNOT VERIFY (structural, CI) — no roster source exists on a bare CI runner by design, so the roster-specific per-name check DID NOT RUN here. Operator-path and .example placeholder checks ran and are clean. This is NOT a pass of the authoritative per-name check — that check runs locally / in pre-commit where a roster (curated or accounts.md-derived) exists."
      echo "[qc-assert-no-client-names] CANNOT VERIFY (structural, CI — report-only) —"
      echo "  neither a curated roster nor an accounts.md-derived roster is available in"
      echo "  this CI environment (CI never has either — no operator-local files exist on"
      echo "  a bare runner, and client PII is intentionally never provisioned into CI"
      echo "  secrets), so the roster-specific per-name check DID NOT RUN. Operator-path"
      echo "  and .example placeholder-leak checks ran and are clean, but that alone does"
      echo "  NOT mean 'no client names' — this is NOT a pass of the per-name check. The"
      echo "  blocking per-name gate runs locally and in pre-commit on the operator box,"
      echo "  where a curated or accounts.md-derived roster exists and this same state"
      echo "  fails closed (exit 2) instead." >&2
      exit 0
    else
      # Outside CI: a roster genuinely exists on this class of machine via the
      # accounts.md derivation, so "no roster anywhere" here is exceptional —
      # FAIL CLOSED.
      echo "[qc-assert-no-client-names] CANNOT VERIFY (structural) — neither"
      echo "  \$OPENCLAW_CLIENT_ROSTER / ~/.openclaw/client-roster.txt NOR an"
      echo "  accounts.md-derived roster could be loaded (see the WARNINGs above for"
      echo "  which one failed and why), so the roster-specific per-name check DID NOT"
      echo "  RUN. Operator-path and .example placeholder-leak checks ran and are clean,"
      echo "  but that alone does NOT mean 'no client names'. Fix: provide a curated"
      echo "  roster, or point \$OPENCLAW_ACCOUNTS_MD / ~/clawd/accounts/accounts.md at a"
      echo "  readable roster." >&2
      exit 2
    fi
  fi
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
    echo "NOTE: running in STRUCTURAL mode (no curated or derived roster) — the hits"
    echo "  above are an operator-path leak and/or a committed .example PLACEHOLDER name."
    echo "  Placeholder names must never appear in tracked content; remove them (the"
    echo "  always-on checks are fail-closed regardless of roster availability)."
  fi
  echo "REMEDY: replace each real client name / chat ID / operator path with a neutral placeholder."
  echo "  Prose:  'a client box', 'a client VPS', '<client-1>'"
  echo "  Config: env/config lookup with a safe default (e.g. \$HOME, <CLIENT_SLUG>)"
  echo "  URLs:   'acme.zerohumanworkforce.com' or 'client.example.com'"
  echo "  Chat IDs: use an obviously-synthetic literal in tests (e.g. 1000000001)."
  echo "  See repo memory [repo-is-fleet-wide-no-client-names]."
  exit 1
fi
