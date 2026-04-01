#!/bin/bash
set -e

APP_DIR=~/projects/mission-control
BACKUP_DIR=$APP_DIR/.next-backup
PM2_NAME="mission-control"
SITE_URL="https://trevor.zerohumanworkforce.com"

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

# Step 6: Health check
echo "[6/6] Health check..."
sleep 5
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "$SITE_URL" 2>/dev/null || echo "000")
if [ "$HTTP_CODE" = "200" ]; then
  echo "  HEALTHY - HTTP $HTTP_CODE"
  echo "=== Deploy Complete ==="
else
  echo "  FAILED - HTTP $HTTP_CODE"
  echo "[ROLLBACK] Restoring backup build..."
  pm2 stop "$PM2_NAME"
  rm -rf "$APP_DIR/.next"
  cp -r "$BACKUP_DIR" "$APP_DIR/.next"
  cp "$APP_DIR/mission-control.db.backup" "$APP_DIR/mission-control.db"
  pm2 restart "$PM2_NAME"
  echo "  Rolled back to previous build + database"
  sleep 3
  ROLLBACK_CODE=$(curl -s -o /dev/null -w "%{http_code}" "$SITE_URL" 2>/dev/null || echo "000")
  echo "  Rollback health: HTTP $ROLLBACK_CODE"
  exit 1
fi
