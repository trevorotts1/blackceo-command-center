#!/usr/bin/env bash
# ============================================================
#  BlackCEO Command Center — Check for Updates (READ-ONLY)
#  Compares local install against GitHub. NEVER updates anything.
#  Outputs structured JSON the cron agent reasons over.
# ============================================================

set -u
SCRIPT_VERSION="1.0.0"
REPO_NAME="blackceo-command-center"
GH_RAW="https://raw.githubusercontent.com/trevorotts1/${REPO_NAME}/main"

# ----------------------------------------------------------
# Detect install location
# ----------------------------------------------------------
# U53 (HL/U68) fix: this list was NEVER updated with the canonical
# `~/projects/command-center` (Mac) / `/data/projects/command-center` (VPS)
# layout that update.sh:42-50 already lists FIRST and that every other
# install/runtime script in this repo treats as "the canonical layout used
# fleet-wide" (scripts/atomic-deploy.sh, scripts/watchdog-cc.sh,
# scripts/seed-workspaces.py, scripts/install/mac-mini-bootstrap.sh,
# scripts/install/vps-docker-bootstrap.sh). Consequence before this fix: on
# every canonically-installed box, INSTALL_DIR resolved empty -> LOCAL_VERSION
# empty -> HAS_UPDATE computed true whenever the GitHub fetch succeeded ->
# permanent false "update available" on the Sunday cron. This also never
# honored a CC_APP_DIR override, unlike update.sh. Fixed by mirroring
# update.sh's resolution exactly: honor CC_APP_DIR first, then fall back to the
# canonical paths prepended ahead of the legacy last-resort candidates.
#
# TRAP-2: that mirror also inherited update.sh's bug — "directory contains a
# package.json" was the whole test, so a decoy could win. `~/projects/command-
# center` is FIRST in the list and on the operator Mac mini it exists as a
# non-git DATA directory. This file is READ-ONLY (it never updates anything),
# so it cannot abort the way update.sh does: the Sunday cron agent parses this
# JSON. Instead it validates identically and reports the outcome in two new
# fields, `install_dir_status` and `install_dir_detail`, so an unresolvable or
# ambiguous install is VISIBLE to the agent rather than silently reported
# against the wrong directory. Validation must stay identical to update.sh's
# _cc_validate_checkout — it is duplicated rather than sourced from a shared
# lib because the lib would live inside the very checkout being located.
CC_PKG_NAME="mission-control"
CC_REQUIRED_MARKERS=(
  "package.json"
  "next.config.mjs"
  "ecosystem.config.cjs"
  "src"
  "scripts/atomic-deploy.sh"
)
CC_EXPECTED_SLUG="$REPO_NAME"

CC_CANDIDATE_PATH=""
CC_CANDIDATE_REASON=""
_cc_repo_slug() {
  local u="${1%/}"
  u="${u%.git}"
  u="${u##*/}"
  u="${u##*:}"
  printf '%s' "$u"
}
_cc_validate_checkout() {
  local cand="$1"
  local phys top top_phys origin_url slug marker
  CC_CANDIDATE_PATH=""
  CC_CANDIDATE_REASON=""

  if [ ! -d "$cand" ]; then
    CC_CANDIDATE_REASON="no such directory"
    return 1
  fi
  phys=$(cd "$cand" 2>/dev/null && pwd -P) || phys=""
  if [ -z "$phys" ]; then
    CC_CANDIDATE_REASON="directory exists but is not readable"
    return 1
  fi
  if ! command -v git >/dev/null 2>&1; then
    CC_CANDIDATE_REASON="git is not installed on this box"
    return 1
  fi
  top=$(git -C "$phys" rev-parse --show-toplevel 2>/dev/null) || top=""
  if [ -z "$top" ]; then
    CC_CANDIDATE_REASON="not a git repository"
    return 1
  fi
  top_phys=$(cd "$top" 2>/dev/null && pwd -P) || top_phys="$top"
  if [ "$top_phys" != "$phys" ]; then
    CC_CANDIDATE_REASON="not a checkout root (subdirectory of the repo at $top_phys)"
    return 1
  fi
  origin_url=$(git -C "$phys" config --get remote.origin.url 2>/dev/null) || origin_url=""
  if [ -z "$origin_url" ]; then
    CC_CANDIDATE_REASON="no 'origin' remote"
    return 1
  fi
  slug="$(_cc_repo_slug "$origin_url")"
  if [ "$slug" != "$CC_EXPECTED_SLUG" ]; then
    CC_CANDIDATE_REASON="origin is a different repo (got '$slug', expected '$CC_EXPECTED_SLUG')"
    return 1
  fi
  for marker in "${CC_REQUIRED_MARKERS[@]}"; do
    if [ ! -e "$phys/$marker" ]; then
      CC_CANDIDATE_REASON="app structure incomplete — missing $marker"
      return 1
    fi
  done
  if ! grep -Eq "\"name\"[[:space:]]*:[[:space:]]*\"${CC_PKG_NAME}\"" "$phys/package.json" 2>/dev/null; then
    CC_CANDIDATE_REASON="package.json is not the Command Center app"
    return 1
  fi
  CC_CANDIDATE_PATH="$phys"
  return 0
}

INSTALL_DIR=""
INSTALL_DIR_STATUS=""
INSTALL_DIR_DETAIL=""

if [ -n "${CC_APP_DIR:-}" ]; then
  if _cc_validate_checkout "$CC_APP_DIR"; then
    INSTALL_DIR="$CC_CANDIDATE_PATH"
    INSTALL_DIR_STATUS="pinned"
    INSTALL_DIR_DETAIL="pinned via CC_APP_DIR"
  else
    INSTALL_DIR_STATUS="pin_invalid"
    INSTALL_DIR_DETAIL="CC_APP_DIR is set but is not a Command Center checkout: ${CC_CANDIDATE_REASON}"
  fi
fi

if [ -z "$INSTALL_DIR" ] && [ "$INSTALL_DIR_STATUS" != "pin_invalid" ]; then
  CANDIDATES=(
    "$HOME/projects/command-center"
    "/data/projects/command-center"
    "$HOME/clawd/projects/blackceo-command-center"
    "/data/clawd/projects/blackceo-command-center"
    "$HOME/blackceo-command-center"
    "/data/blackceo-command-center"
  )
  CC_VALIDATED=()
  for c in "${CANDIDATES[@]}"; do
    if _cc_validate_checkout "$c"; then
      cc_dup=0
      if [ "${#CC_VALIDATED[@]}" -gt 0 ]; then
        for v in "${CC_VALIDATED[@]}"; do
          if [ "$v" = "$CC_CANDIDATE_PATH" ]; then cc_dup=1; break; fi
        done
      fi
      if [ "$cc_dup" -eq 0 ]; then
        CC_VALIDATED+=("$CC_CANDIDATE_PATH")
      fi
    fi
  done

  if [ "${#CC_VALIDATED[@]}" -eq 1 ]; then
    INSTALL_DIR="${CC_VALIDATED[0]}"
    INSTALL_DIR_STATUS="autodetected"
    INSTALL_DIR_DETAIL="exactly one validated checkout found"
  elif [ "${#CC_VALIDATED[@]}" -gt 1 ]; then
    INSTALL_DIR_STATUS="ambiguous"
    INSTALL_DIR_DETAIL="${#CC_VALIDATED[@]} validated checkouts found ($(printf '%s ' "${CC_VALIDATED[@]}" | sed 's/ $//')) — pin CC_APP_DIR; not reporting against a guess"
  else
    INSTALL_DIR_STATUS="not_found"
    INSTALL_DIR_DETAIL="no candidate path validated as a Command Center checkout — pin CC_APP_DIR"
  fi
fi

# Detect platform
if [ -d "/data/.openclaw" ]; then
  PLATFORM="vps"
else
  PLATFORM="mac"
fi

# ----------------------------------------------------------
# Read local version
# ----------------------------------------------------------
LOCAL_VERSION=""
if [ -n "$INSTALL_DIR" ] && [ -f "$INSTALL_DIR/version" ]; then
  LOCAL_VERSION=$(tr -d '[:space:]' < "$INSTALL_DIR/version")
fi
LOCAL_PKG_VERSION=""
if [ -n "$INSTALL_DIR" ] && [ -f "$INSTALL_DIR/package.json" ]; then
  LOCAL_PKG_VERSION=$(grep '"version"' "$INSTALL_DIR/package.json" | head -1 | sed -E 's/.*"version"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/')
fi

# ----------------------------------------------------------
# Fetch remote state
# ----------------------------------------------------------
fetch_remote() {
  curl -fsSL --max-time 15 "${GH_RAW}/$1" 2>/dev/null || echo ""
}

LATEST_VERSION=$(fetch_remote version | tr -d '[:space:]')
LATEST_CHANGELOG=$(fetch_remote CHANGELOG.md)

# Most recent changelog entry (top section until next "## v")
LATEST_ENTRY=""
if [ -n "$LATEST_CHANGELOG" ]; then
  LATEST_ENTRY=$(echo "$LATEST_CHANGELOG" | awk '
    /^## v/ {
      if (count == 0) { count=1; print; next }
      else { exit }
    }
    count == 1 { print }
  ')
fi

# Risk hint
RISK_HINT=""
if [ -n "$LATEST_ENTRY" ]; then
  RISK_HINT=$(echo "$LATEST_ENTRY" | grep -iE "^### Risk:" | head -1 | sed -E 's/^### Risk:[[:space:]]*//I' | tr -d '[:space:]' | tr '[:upper:]' '[:lower:]')
fi

# ----------------------------------------------------------
# Has update?
# ----------------------------------------------------------
HAS_UPDATE="false"
if [ -n "$LATEST_VERSION" ] && [ "$LOCAL_VERSION" != "$LATEST_VERSION" ]; then
  HAS_UPDATE="true"
fi

# Risk-tier classification fallback if no explicit tag
# (the agent will do better reasoning but this gives a baseline)
INFERRED_RISK="low"
if [ -n "$LATEST_ENTRY" ]; then
  if echo "$LATEST_ENTRY" | grep -qiE "breaking|migration|schema change|drop.*column|delete.*table|api version|deprecat"; then
    INFERRED_RISK="high"
  elif echo "$LATEST_ENTRY" | grep -qiE "added|new feature|new component|new dependency"; then
    INFERRED_RISK="medium"
  fi
fi

# ----------------------------------------------------------
# Compose JSON
# ----------------------------------------------------------
LATEST_ENTRY_JSON=$(printf '%s' "$LATEST_ENTRY" | python3 -c "import sys,json; print(json.dumps(sys.stdin.read()))" 2>/dev/null)
[ -z "$LATEST_ENTRY_JSON" ] && LATEST_ENTRY_JSON='""'

# install_dir_detail is built from filesystem paths, so strip the two
# characters that could break out of a JSON string literal.
INSTALL_DIR_DETAIL_JSON=$(printf '%s' "$INSTALL_DIR_DETAIL" | tr -d '"\\')

cat <<JSON
{
  "script_version": "${SCRIPT_VERSION}",
  "repo": "${REPO_NAME}",
  "platform": "${PLATFORM}",
  "checked_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "install_dir": "${INSTALL_DIR}",
  "install_dir_status": "${INSTALL_DIR_STATUS}",
  "install_dir_detail": "${INSTALL_DIR_DETAIL_JSON}",
  "local_version": "${LOCAL_VERSION}",
  "local_package_version": "${LOCAL_PKG_VERSION}",
  "latest_version": "${LATEST_VERSION}",
  "has_update": ${HAS_UPDATE},
  "risk_hint": "${RISK_HINT}",
  "inferred_risk": "${INFERRED_RISK}",
  "changelog_excerpt": ${LATEST_ENTRY_JSON}
}
JSON

# Record last check timestamp
if [ -n "$INSTALL_DIR" ]; then
  date -u +%Y-%m-%dT%H:%M:%SZ > "$INSTALL_DIR/.last-update-check" 2>/dev/null || true
fi
