#!/usr/bin/env bash
# client-roster-lib.sh — shared loader for the operator-local client roster.
#
# The REAL client roster (names, Telegram chat IDs, GHL location IDs) lives in
# NO tracked file and NOWHERE on GitHub. Leak-detection gates load it at runtime
# from an operator-local, gitignored file:
#
#   1. $OPENCLAW_CLIENT_ROSTER   (env override — used by CI/pre-commit hooks)
#   2. ${HOME}/.openclaw/client-roster.txt   (default operator-local path)
#
# FORMAT: one entry per line. Blank lines and lines beginning with '#' are
# ignored. An entry may be:
#   - a full client name / brand ...... "Jane Doe", "Acme Consulting"
#   - a \b-anchored first-name pattern . "\bJane\b"   (ERE, matched case-insensitively)
#   - a client GHL location ID ......... opaque alphanumeric token
#   - a client Telegram chat ID ........ a pure-numeric line (matched \b-anchored,
#                                        and MASKED in any log output)
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

# Print the NAME/token entries (everything that is not a pure-numeric chat ID).
# Covers full names, \b-anchored first-name ERE patterns, and GHL location IDs.
roster_names() {
  _roster_meaningful_lines "$(roster_resolve_path)" | grep -vE '^[0-9]+$'
}

# Print the pure-numeric chat-ID entries only.
roster_chat_ids() {
  _roster_meaningful_lines "$(roster_resolve_path)" | grep -E '^[0-9]+$'
}

# Print the placeholder NAME entries from the committed .example template.
# Used by the roster-absent STRUCTURAL check: none of these obviously-fake names
# may ever appear in tracked content (a placeholder leak must still fail the gate).
roster_example_names() {
  _roster_meaningful_lines "$(roster_example_path)" | grep -vE '^[0-9]+$'
}
