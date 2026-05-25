#!/usr/bin/env bash
#
# VPS Docker integration regression test.
#
# Mirrors the Mac Mini compat test against the VPS Docker paths defined in
# PRD Section 13.1. Verifies the Command Center can read the config files
# written by the VPS repo's skills under /data/.openclaw/workspace/ and that
# the API endpoints that consume them are healthy.
#
# Implements PRD Section 13.3. Exits 0 on success, non-zero on any failure.
#
set -euo pipefail

VPS_WORKSPACE="${VPS_WORKSPACE:-/data/.openclaw/workspace}"

REQUIRED_FILES=(
  "$VPS_WORKSPACE/config/departments.json"
  "$VPS_WORKSPACE/config/company-config.json"
)

REQUIRED_SCHEMAS=(
  '.[0].id'
  '.[0].name'
  '.[0].emoji'
)

API_BASE="${API_BASE:-http://localhost:4000}"

#
# Step 1: required files
#
for f in "${REQUIRED_FILES[@]}"; do
  if [ ! -f "$f" ]; then
    echo "FAIL: missing $f"
    exit 1
  fi
done

#
# Step 2: jq schema probes
#
if ! command -v jq >/dev/null 2>&1; then
  echo "FAIL: jq is required for schema verification but is not installed"
  exit 1
fi

for q in "${REQUIRED_SCHEMAS[@]}"; do
  if ! jq -e "$q" "$VPS_WORKSPACE/config/departments.json" >/dev/null; then
    echo "FAIL: schema missing $q in $VPS_WORKSPACE/config/departments.json"
    exit 1
  fi
done

#
# Step 3: live API endpoints
#
if ! curl -fsS "$API_BASE/api/company" >/dev/null; then
  echo "FAIL: $API_BASE/api/company did not return 200"
  exit 1
fi

if ! curl -fsS "$API_BASE/api/workspaces" >/dev/null; then
  echo "FAIL: $API_BASE/api/workspaces did not return 200"
  exit 1
fi

echo "VPS Docker integration: PASS"
