#!/usr/bin/env bash
# reset-canary.sh — Restore a Command Center test instance to a pristine DB
# state for a fresh duck-test run.
#
# FLEET-SAFE: this script hardcodes NO machine-specific path. Every location is
# resolved from an env var with a $HOME-relative default, so it runs unmodified
# on any box. (The repo is fleet-wide and is cloned to every box; a hardcoded
# operator home directory is a tracked-file invariant violation — see
# scripts/qc-assert-no-client-names.sh, which scans for exactly that.)
#
# Config (override any of these via env):
#   CC_TEST_DIR       directory holding the test instance (default: $HOME/canary/command-center)
#   CC_TEST_DB        live SQLite DB to reset             (default: $CC_TEST_DIR/canary.db)
#   CC_TEST_PRISTINE  pristine snapshot to restore from   (default: $CC_TEST_DB.pristine)
#   CC_TEST_PM2       pm2 process name                    (default: cc-canary)
#   CC_TEST_URL       health-check URL                    (default: http://localhost:4100/)
#
# Usage:
#   bash scripts/reset-canary.sh
#   CC_TEST_DIR=/srv/cc-test CC_TEST_PM2=cc-test bash scripts/reset-canary.sh
set -e

CC_TEST_DIR="${CC_TEST_DIR:-${HOME}/canary/command-center}"
CC_TEST_DB="${CC_TEST_DB:-${CC_TEST_DIR}/canary.db}"
CC_TEST_PRISTINE="${CC_TEST_PRISTINE:-${CC_TEST_DB}.pristine}"
CC_TEST_PM2="${CC_TEST_PM2:-cc-canary}"
CC_TEST_URL="${CC_TEST_URL:-http://localhost:4100/}"

if [ ! -f "${CC_TEST_PRISTINE}" ]; then
  echo "[reset-canary] ERROR: pristine snapshot not found at ${CC_TEST_PRISTINE}"
  echo "  To create it:"
  echo "    sqlite3 ${CC_TEST_DB} 'PRAGMA wal_checkpoint(TRUNCATE);' && cp ${CC_TEST_DB} ${CC_TEST_PRISTINE}"
  exit 1
fi

echo "[reset-canary] Stopping ${CC_TEST_PM2}..."
pm2 stop "${CC_TEST_PM2}" 2>/dev/null || true

echo "[reset-canary] Restoring pristine DB..."
# Remove any WAL/SHM leftovers so the restored snapshot is authoritative.
rm -f "${CC_TEST_DB}" "${CC_TEST_DB}-wal" "${CC_TEST_DB}-shm"
cp "${CC_TEST_PRISTINE}" "${CC_TEST_DB}"
echo "[reset-canary] DB restored: $(wc -c < "${CC_TEST_DB}") bytes"

echo "[reset-canary] Restarting ${CC_TEST_PM2}..."
pm2 start "${CC_TEST_PM2}" 2>/dev/null || pm2 restart "${CC_TEST_PM2}" 2>/dev/null

sleep 3

# Verify the instance came back up.
HTTP=$(curl -s -o /dev/null -w "%{http_code}" "${CC_TEST_URL}")
if [ "${HTTP}" = "200" ]; then
  echo "[reset-canary] PASS — ${CC_TEST_URL} -> HTTP 200"
else
  echo "[reset-canary] FAIL — ${CC_TEST_URL} -> HTTP ${HTTP}"
  exit 1
fi

WS_COUNT=$(sqlite3 "${CC_TEST_DB}" "SELECT COUNT(*) FROM workspaces;" 2>/dev/null)
echo "[reset-canary] Workspaces in DB: ${WS_COUNT}"

echo "[reset-canary] Done. Test instance is clean and ready for a duck test run."
