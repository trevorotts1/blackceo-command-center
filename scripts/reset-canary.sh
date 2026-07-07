#!/usr/bin/env bash
# reset-canary.sh — Restore the canary instance to pristine state for a fresh duck test run.
# Usage: bash /Users/blackceomacmini/canary/command-center/scripts/reset-canary.sh
set -e

CANARY_DIR="/Users/blackceomacmini/canary/command-center"
DB_PATH="${CANARY_DIR}/canary.db"
PRISTINE="${CANARY_DIR}/canary.db.pristine"

if [ ! -f "${PRISTINE}" ]; then
  echo "[reset-canary] ERROR: pristine snapshot not found at ${PRISTINE}"
  echo "  To create it: sqlite3 ${DB_PATH} 'PRAGMA wal_checkpoint(TRUNCATE);' && cp ${DB_PATH} ${PRISTINE}"
  exit 1
fi

echo "[reset-canary] Stopping cc-canary..."
pm2 stop cc-canary 2>/dev/null || true

echo "[reset-canary] Restoring pristine DB..."
# Remove any WAL/SHM leftovers
rm -f "${DB_PATH}" "${DB_PATH}-wal" "${DB_PATH}-shm"
cp "${PRISTINE}" "${DB_PATH}"
echo "[reset-canary] DB restored: $(wc -c < "${DB_PATH}") bytes"

echo "[reset-canary] Restarting cc-canary..."
pm2 start cc-canary 2>/dev/null || pm2 restart cc-canary 2>/dev/null

sleep 3

# Verify
HTTP=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:4100/)
if [ "${HTTP}" = "200" ]; then
  echo "[reset-canary] PASS — localhost:4100 -> HTTP 200"
else
  echo "[reset-canary] FAIL — localhost:4100 -> HTTP ${HTTP}"
  exit 1
fi

WS_COUNT=$(sqlite3 "${DB_PATH}" "SELECT COUNT(*) FROM workspaces;" 2>/dev/null)
echo "[reset-canary] Workspaces in DB: ${WS_COUNT}"

echo "[reset-canary] Done. Canary is clean and ready for a duck test run."
