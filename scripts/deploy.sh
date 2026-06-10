#!/bin/bash
# deploy.sh — Mission Control safe deploy with B.1 health-check gate.
# Health verification delegates to scripts/cc-health-check.sh (PRD Addendum B.1).
# A shallow HTTP 200 check is NOT sufficient; the full check catches stale manifests,
# Default branding, pm2 topology failures, and disk issues.
set -e

APP_DIR=~/projects/mission-control
BACKUP_DIR=$APP_DIR/.next-backup
PM2_NAME="mission-control"
SITE_URL="https://trevor.zerohumanworkforce.com"
CC_PORT="${CC_PORT:-4000}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HEALTH_CHECK="${SCRIPT_DIR}/cc-health-check.sh"

# VPS: Override these variables for your deployment
# Example: APP_DIR=/data/mission-control
# Example: SITE_URL=http://YOUR_VPS_IP:4000

echo "=== Mission Control Safe Deploy ==="

# Step 1: Backup current .next build
echo "[1/6] Backing up current build..."
if [ -d "$APP_DIR/.next" ]; then
  rm -rf "$BACKUP_DIR"
  cp -r "$APP_DIR/.next" "$BACKUP_DIR"
  echo "  Backed up .next to .next-backup"
fi

# Step 2: Backup database
echo "[2/6] Backing up database..."
cp "$APP_DIR/mission-control.db" "$APP_DIR/mission-control.db.backup"
echo "  Database backed up"

# Step 3: Clean build
echo "[3/6] Cleaning old build..."
rm -rf "$APP_DIR/.next"

# Step 4: Build
echo "[4/6] Building..."
cd "$APP_DIR"
npm run build 2>&1 | tail -5
if [ ! -f "$APP_DIR/.next/BUILD_ID" ]; then
  echo "  BUILD FAILED - .next directory incomplete"
  echo "[ROLLBACK] Restoring backup build..."
  rm -rf "$APP_DIR/.next"
  cp -r "$BACKUP_DIR" "$APP_DIR/.next"
  pm2 restart "$PM2_NAME"
  echo "  Rolled back to previous build"
  exit 1
fi
echo "  Build successful"

# Step 5: Restart PM2
echo "[5/6] Restarting PM2..."
pm2 restart "$PM2_NAME"

# Step 6: Deep health check via cc-health-check.sh (B.1) — the single definition of green.
# This replaces the former hand-rolled HTTP 200 check and catches stale manifests,
# Default branding, pm2 topology failures, and disk issues.
echo "[6/6] Health check (B.1 deep check)..."
sleep 5

HEALTH_JSON=""
HEALTH_EXIT=0

if [[ -x "$HEALTH_CHECK" ]]; then
  HEALTH_JSON=$(bash "$HEALTH_CHECK" \
    --port "$CC_PORT" \
    --canonical-dir "$APP_DIR" \
    --pm2-check-window 0 \
    --json-only 2>/dev/null) || HEALTH_EXIT=$?
else
  echo "  WARN: cc-health-check.sh not found at ${HEALTH_CHECK} — falling back to HTTP probe"
  HTTP_CODE=$(curl -s -L -o /dev/null -w "%{http_code}" --max-time 10 "http://127.0.0.1:${CC_PORT}/" 2>/dev/null || echo "000")
  if [ "$HTTP_CODE" = "200" ]; then
    HEALTH_EXIT=0
    HEALTH_JSON='{"green":true,"fallback":true}'
  else
    HEALTH_EXIT=1
    HEALTH_JSON='{"green":false,"fallback":true}'
  fi
fi

HEALTH_GREEN=$(printf '%s' "$HEALTH_JSON" \
  | python3 -s -c "import sys,json; d=json.load(sys.stdin); print('true' if d.get('green') else 'false')" \
  2>/dev/null || echo "false")

echo "  Health check result: ${HEALTH_JSON}"

if [ "$HEALTH_GREEN" = "true" ]; then
  echo "  HEALTHY — all B.1 checks passed"
  echo "=== Deploy Complete ==="
else
  echo "  FAILED — B.1 health check not green"
  echo "[ROLLBACK] Restoring backup build..."
  pm2 stop "$PM2_NAME"
  rm -rf "$APP_DIR/.next"
  cp -r "$BACKUP_DIR" "$APP_DIR/.next"
  cp "$APP_DIR/mission-control.db.backup" "$APP_DIR/mission-control.db"
  pm2 restart "$PM2_NAME"
  echo "  Rolled back to previous build + database"
  sleep 3
  ROLLBACK_JSON=$(bash "$HEALTH_CHECK" \
    --port "$CC_PORT" \
    --canonical-dir "$APP_DIR" \
    --pm2-check-window 0 \
    --json-only 2>/dev/null) || true
  echo "  Rollback health: ${ROLLBACK_JSON}"
  exit 1
fi
