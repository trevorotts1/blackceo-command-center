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
CANDIDATES=(
  "$HOME/clawd/projects/blackceo-command-center"
  "/data/clawd/projects/blackceo-command-center"
  "$HOME/blackceo-command-center"
  "/data/blackceo-command-center"
)
INSTALL_DIR=""
for c in "${CANDIDATES[@]}"; do
  if [ -d "$c" ] && [ -f "$c/package.json" ]; then
    INSTALL_DIR="$c"
    break
  fi
done

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

cat <<JSON
{
  "script_version": "${SCRIPT_VERSION}",
  "repo": "${REPO_NAME}",
  "platform": "${PLATFORM}",
  "checked_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "install_dir": "${INSTALL_DIR}",
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
