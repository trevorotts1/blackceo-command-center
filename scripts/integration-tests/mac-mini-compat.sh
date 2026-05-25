#!/usr/bin/env bash
#
# Mac Mini integration regression test.
#
# Verifies that the Command Center can read all files written by the Mac Mini
# repo's skills, and that the API endpoints that consume them are healthy.
#
# Implements PRD Section 12.3. Exits 0 on success, non-zero on any failure.
#
set -euo pipefail

# Config paths are relative to the repo root (the Mac Mini repo writes here).
REQUIRED_FILES=(
  "config/departments.json"
  "config/company-config.json"
)

REQUIRED_SCHEMAS=(
  'departments[0].slug'
  'departments[0].name'
  'departments[0].icon'
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
  if ! jq -e ".$q" config/departments.json >/dev/null; then
    echo "FAIL: schema missing $q in config/departments.json"
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

echo "Mac Mini integration: PASS"
