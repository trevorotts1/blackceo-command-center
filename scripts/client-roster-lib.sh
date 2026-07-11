#!/usr/bin/env bash
# client-roster-lib.sh — shared loader for the operator-local client roster.
#
# ─── THIS IS A HUMAN-NAME ROSTER. NOTHING ELSE. ──────────────────────────────
# The REAL client roster lives in NO tracked file and NOWHERE on GitHub.
# Leak-detection gates load it at runtime from an operator-local, gitignored file:
#
#   1. $OPENCLAW_CLIENT_ROSTER   (env override — used by CI/pre-commit hooks)
#   2. ${HOME}/.openclaw/client-roster.txt   (default operator-local path)
#
# FORMAT: one entry per line. Blank lines and lines beginning with '#' are
# ignored. An entry may be:
#   - a full client name / brand ...... "Jane Doe", "Acme Consulting"
#   - a \b-anchored first-name pattern . "\bJane\b"   (ERE, matched case-insensitively)
#
# ─── THE RULE (operator, 2026-07-11 — AUTHORITATIVE) ─────────────────────────
# This repo is FLEET-WIDE (cloned to every client box). Only THREE things are
# enforceable:
#   1. No CLIENT / ROSTER MEMBER real HUMAN NAMES — an actual customer or team
#      member. NOT book characters. NOT personas. NOT authors of referenced works.
#   2. No genuine SECRETS — live tokens, API keys, `pit-` GHL tokens, bot tokens,
#      private keys. ABSOLUTE. DO NOT WEAKEN THIS.
#   3. Nothing built for ONE client — content stays generic and fleet-reusable.
#
# ⚠️ EXPLICITLY EXEMPT — NEVER flag, block, or scrub:
#   Cloudflare Access Application UUIDs / AUD tags · Telegram chat IDs · GHL
#   location IDs · any opaque identifier (UUID, numeric ID, hash) · book titles ·
#   persona names derived from books · authors of referenced works · product
#   proper nouns.
#   GOVERNING PRINCIPLE: opaque infrastructure identifiers and product content are
#   NOT the target.
#
# ⚠️ OPAQUE IDs ARE NOT ROSTER ENTRIES. roster_chat_ids() has been REMOVED and
#    roster_names() now FILTERS OUT opaque identifiers, so a chat ID or GHL
#    location ID left in an old operator roster file can never become a scan term
#    again. Do NOT re-add an identifier accessor here.
#
# ⛔ NEVER enforce the NAME rule with a grep / regex / name-roster ALONE. A pattern
#    match cannot tell a client's real name from a book-persona name — it either
#    misses real leaks or blocks legitimate product PRs forever. The AUTHORITATIVE
#    name check is the LLM reviewer (scripts/qc-llm-diff-review.py, every PR).
#    (Regex IS still correct for SECRETS — a secret has a literal shape; a human
#    name does not.)
#
# A committed template with obviously-fake placeholders ships alongside the
# gates: scripts/client-roster.example.txt. Copy it to
# ${HOME}/.openclaw/client-roster.txt and fill in the real roster; never commit
# the filled file.
#
# This library is sourced by the shell gates (qc-assert-no-client-names.sh,
# qc-blocked-gate.sh). It defines helper functions only — it takes no action
# and prints nothing when sourced.

# Absolute path to this library's directory (…/scripts).
# shellcheck disable=SC2296
_CLIENT_ROSTER_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# The committed placeholder template (safe to track; obviously-fake names only).
roster_example_path() {
  printf '%s\n' "$_CLIENT_ROSTER_LIB_DIR/client-roster.example.txt"
}

# The path the roster WOULD load from (whether or not it exists on disk).
roster_resolve_path() {
  if [ -n "${OPENCLAW_CLIENT_ROSTER:-}" ]; then
    printf '%s\n' "$OPENCLAW_CLIENT_ROSTER"
  else
    printf '%s\n' "${HOME}/.openclaw/client-roster.txt"
  fi
}

# Emit the meaningful (non-comment, non-blank) lines of a roster file, trimmed.
_roster_meaningful_lines() {
  local file="$1"
  [ -f "$file" ] || return 0
  # Strip inline nothing; drop comments/blanks; trim surrounding whitespace.
  sed -e 's/[[:space:]]*$//' -e 's/^[[:space:]]*//' "$file" \
    | grep -vE '^[[:space:]]*#' \
    | grep -vE '^[[:space:]]*$'
}

# 0 (true) if the resolved roster exists AND has at least one meaningful line.
roster_available() {
  local file
  file="$(roster_resolve_path)"
  [ -f "$file" ] || return 1
  [ -n "$(_roster_meaningful_lines "$file")" ]
}

# ─── OPAQUE-ID FILTER (the EXEMPT list, enforced at load time) ────────────────
# Drops any line that is an OPAQUE IDENTIFIER rather than a human name. Opaque
# IDs are EXEMPT and must never become scan terms: a Telegram chat ID / GHL
# location ID / UUID / AUD tag / hash is infrastructure, not a client's identity.
# Older operator roster files may still list them — this filter makes the gates
# correct regardless of what is on the operator's disk.
#
# A line is an opaque ID when it is:
#   • pure numeric ................. 8123456789            (Telegram chat ID)
#   • whitespace-free with a digit .. aB3xKp9QrTn2LmVw7ZcY (GHL location ID, UUID,
#                                     AUD tag, hash — base62/hex blobs)
#   • whitespace-free and >=16 chars (a long opaque blob with no digits)
# A human name always has whitespace ("Jane Doe") or is a short \b-anchored
# first-name pattern ("\bJane\b") — neither matches the above.
_roster_drop_opaque_ids() {
  grep -vE '^[0-9]+$' \
    | grep -vE '^[^[:space:]]*[0-9][^[:space:]]*$' \
    | grep -vE '^[^[:space:]]{16,}$'
}

# Print the HUMAN-NAME entries only (full names + \b-anchored first-name ERE
# patterns). Opaque identifiers are filtered OUT — they are EXEMPT.
# This previously returned EVERY non-numeric line, which swept GHL location IDs
# in as scan terms. That was the over-reach; it is fixed here.
roster_names() {
  _roster_meaningful_lines "$(roster_resolve_path)" | _roster_drop_opaque_ids
}

# NOTE: roster_chat_ids() DELETED — Telegram chat IDs are EXPLICITLY EXEMPT and
# are never scanned for. Do not re-add it.

# Print the placeholder NAME entries from the committed .example template.
# Used by the roster-absent STRUCTURAL check: none of these obviously-fake names
# may ever appear in tracked content (a placeholder leak must still fail the gate).
roster_example_names() {
  _roster_meaningful_lines "$(roster_example_path)" | _roster_drop_opaque_ids
}
