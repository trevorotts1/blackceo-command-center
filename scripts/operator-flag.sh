#!/usr/bin/env bash
# ============================================================================
# operator-flag.sh — set / unset / list DURABLE operator kill-flags.  [F6]
#
# WHY THIS EXISTS
# ---------------
# The emergency stop for a runaway sweep used to be a hand-written line in the
# checkout's `.env.production.local`. That file is gitignored (.gitignore:27),
# so it is untracked, lives INSIDE the app checkout, and is therefore erased by
# `git clean -fdx`, by a re-clone (re-install / disaster recovery / container
# re-create), and by anything in the deploy chain that regenerates the app's env
# file wholesale (DEPLOYMENT.md "What runs, in order", step 3 — the onboarding
# half of the weekly update writes `.env.local` on every run). An operator's
# emergency stop must not be undoable by a routine deploy that nobody is
# watching.
#
# This script writes the flag to a DURABLE overrides file OUTSIDE the checkout.
# The app reads it via src/lib/ops/operator-kill-flags.ts on every sweep tick.
#
# TWO PROPERTIES THIS SCRIPT GUARANTEES
# -------------------------------------
#   1. MERGE, NEVER REGENERATE. `set` and `unset` rewrite the file key-by-key
#      and preserve every other line (including comments) verbatim. Nothing this
#      script does can drop an override it did not touch. (Written via a temp
#      file + atomic mv, so a crash mid-write cannot truncate the file.)
#   2. NOTHING IS SILENT. Every mutation prints the file, the key, and the
#      before -> after value. `list` shows the live resolved state.
#
# USAGE
#   bash scripts/operator-flag.sh list
#   bash scripts/operator-flag.sh set   DISABLE_STALE_TASK_SWEEP 1
#   bash scripts/operator-flag.sh unset DISABLE_STALE_TASK_SWEEP
#
# The flag takes effect on the NEXT sweep tick — no rebuild, no pm2 restart, no
# deploy (the app re-reads the file each tick).
#
# Override the target file with CC_OPERATOR_OVERRIDES_FILE=/path/to/file (the
# app honours the same variable, so the two always agree).
# ============================================================================
set -euo pipefail

# Keep this list in sync with HONORED_FLAGS in src/lib/ops/operator-kill-flags.ts.
HONORED_FLAGS=("DISABLE_STALE_TASK_SWEEP")

_resolve_file() {
  if [ -n "${CC_OPERATOR_OVERRIDES_FILE:-}" ]; then
    printf '%s' "$CC_OPERATOR_OVERRIDES_FILE"
    return
  fi
  # Same candidate order as overridesFileCandidates(): prefer an EXISTING file,
  # otherwise create under $HOME (or /data on a VPS/Docker box, where /data is
  # the only persistent volume).
  local home_file="${HOME:-/root}/.blackceo/command-center/operator-overrides.env"
  local data_file="/data/.blackceo/command-center/operator-overrides.env"
  if [ -f "$home_file" ]; then printf '%s' "$home_file"; return; fi
  if [ -f "$data_file" ]; then printf '%s' "$data_file"; return; fi
  if [ -d "/data" ] && [ ! -d "${HOME:-/nonexistent}" ]; then printf '%s' "$data_file"; return; fi
  printf '%s' "$home_file"
}

_is_honored() {
  local key="$1" f
  for f in "${HONORED_FLAGS[@]}"; do
    [ "$f" = "$key" ] && return 0
  done
  return 1
}

_get() {
  local file="$1" key="$2"
  [ -f "$file" ] || return 0
  # Last assignment wins, matching the parser's behavior.
  awk -F= -v k="$key" '
    { line=$0; sub(/^[ \t]*/, "", line); sub(/^export[ \t]+/, "", line) }
    line ~ /^#/ { next }
    { eq = index(line, "="); if (eq <= 1) next
      key = substr(line, 1, eq-1); gsub(/[ \t]+$/, "", key)
      if (key == k) { val = substr(line, eq+1); gsub(/^[ \t]+|[ \t]+$/, "", val); out = val } }
    END { if (out != "") print out }
  ' "$file"
}

# _write_key <file> <key> <value|""> — value "" means DELETE the key.
# Preserves every other line verbatim (merge, never regenerate).
_write_key() {
  local file="$1" key="$2" value="${3:-}"
  local dir tmp
  dir="$(dirname "$file")"
  mkdir -p "$dir"
  chmod 700 "$dir" 2>/dev/null || true
  [ -f "$file" ] || {
    {
      echo "# BlackCEO Command Center — DURABLE operator overrides."
      echo "# Lives OUTSIDE the app checkout on purpose: a deploy, a re-clone, or"
      echo "# 'git clean -fdx' must never be able to undo an operator's emergency stop."
      echo "# Managed by: bash scripts/operator-flag.sh  (hand-editing is fine too)"
      echo "# Only the flags this app honours are read from here; see"
      echo "# src/lib/ops/operator-kill-flags.ts (HONORED_FLAGS)."
    } > "$file"
    chmod 600 "$file" 2>/dev/null || true
  }

  tmp="$(mktemp "${file}.tmp.XXXXXX")"
  local replaced=0
  # Rewrite line-by-line: only lines assigning THIS key are touched.
  while IFS= read -r line || [ -n "$line" ]; do
    local probe="${line#"${line%%[![:space:]]*}"}"   # left-trim
    probe="${probe#export }"
    case "$probe" in
      "#"*)      printf '%s\n' "$line" >> "$tmp"; continue ;;
      "$key="*)
        if [ -n "$value" ] && [ "$replaced" -eq 0 ]; then
          printf '%s=%s\n' "$key" "$value" >> "$tmp"
          replaced=1
        fi
        # value empty => drop the line (unset); duplicate keys collapse to one.
        continue ;;
      *) printf '%s\n' "$line" >> "$tmp"; continue ;;
    esac
  done < "$file"

  if [ -n "$value" ] && [ "$replaced" -eq 0 ]; then
    printf '%s=%s\n' "$key" "$value" >> "$tmp"
  fi

  chmod 600 "$tmp" 2>/dev/null || true
  mv "$tmp" "$file"   # atomic within the same directory
}

FILE="$(_resolve_file)"
CMD="${1:-list}"

case "$CMD" in
  list)
    echo "Durable operator-overrides file: $FILE"
    if [ ! -f "$FILE" ]; then
      echo "  (does not exist — no durable operator kill-flag is set on this box)"
    else
      echo "  contents (honored flags only):"
      for f in "${HONORED_FLAGS[@]}"; do
        v="$(_get "$FILE" "$f" || true)"
        printf '    %s=%s\n' "$f" "${v:-<unset>}"
      done
    fi
    echo ""
    echo "Environment (process env of THIS shell — the app reads its own):"
    for f in "${HONORED_FLAGS[@]}"; do
      printf '    %s=%s\n' "$f" "${!f:-<unset>}"
    done
    echo ""
    echo "A flag disables its sweep when EITHER source is truthy (1/true/yes/on)."
    ;;

  set)
    KEY="${2:-}"; VAL="${3:-1}"
    [ -n "$KEY" ] || { echo "usage: $0 set <FLAG> [value]" >&2; exit 2; }
    if ! _is_honored "$KEY"; then
      echo "ERROR: '$KEY' is not a flag this app honours from the durable file." >&2
      echo "       Honored flags: ${HONORED_FLAGS[*]}" >&2
      echo "       Writing it here would do NOTHING — refusing so you do not think you stopped something you did not." >&2
      exit 2
    fi
    OLD="$(_get "$FILE" "$KEY" || true)"
    _write_key "$FILE" "$KEY" "$VAL"
    echo "SET  $KEY: ${OLD:-<unset>} -> $VAL"
    echo "     file: $FILE  (every other key in it was preserved)"
    if [ "$KEY" = "DISABLE_STALE_TASK_SWEEP" ]; then
      echo ""
      echo "  ⚠ The stale-task sweep is now OFF. Stale/blocked tasks will NOT be escalated"
      echo "    to a human while this is set. This is an emergency stop, not a resting state."
      echo "    Takes effect on the next sweep tick (no restart needed). Undo:"
      echo "      bash scripts/operator-flag.sh unset DISABLE_STALE_TASK_SWEEP"
    fi
    ;;

  unset)
    KEY="${2:-}"
    [ -n "$KEY" ] || { echo "usage: $0 unset <FLAG>" >&2; exit 2; }
    OLD="$(_get "$FILE" "$KEY" || true)"
    if [ ! -f "$FILE" ]; then
      echo "UNSET $KEY: already <unset> (no durable overrides file at $FILE)"
    else
      _write_key "$FILE" "$KEY" ""
      echo "UNSET $KEY: ${OLD:-<unset>} -> <unset>"
      echo "      file: $FILE  (every other key in it was preserved)"
    fi
    if [ -n "${!KEY:-}" ]; then
      echo ""
      echo "  ⚠ NOTE: $KEY is ALSO set in the environment ($KEY=${!KEY})."
      echo "    Either source keeps the flag ON. Clear it there too (e.g. remove it from"
      echo "    the checkout's .env*.local and restart pm2) or the sweep stays disabled."
    fi
    ;;

  *)
    echo "usage: $0 {list|set <FLAG> [value]|unset <FLAG>}" >&2
    exit 2
    ;;
esac
