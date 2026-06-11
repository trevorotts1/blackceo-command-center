#!/bin/bash
# deploy.sh — B.2 atomic deploy with /api/health/deep-aware rollback gate.
#
# EXIT CONTRACT (from cc-health-check.sh):
#   0 = green  → deploy succeeds
#   1 = red    → definitive failure → AUTO-ROLLBACK (only on 1, never on 3)
#   3 = UNKNOWN/indeterminate → sleep + retry N times, escalate if never clears
#                               NEVER rollback on 3 (may be a valid deployment
#                               still warming up)
#
# P4 FIX: deploy.sh now passes --canonical-dir "$APP_DIR" to
# cc-health-check.sh so pm2-analyze-cc.py has a real canonical_dir to compare
# against pm2 app cwd.  Without this the cwd check is vacuous (always
# cwd_ok=true regardless of the actual pm2 working directory).
set -e

APP_DIR=~/projects/mission-control
BACKUP_DIR=$APP_DIR/.next-backup
PM2_NAME="mission-control"
HEALTH_SCRIPT="$APP_DIR/scripts/cc-health-check.sh"

# Retry config for exit-3 (indeterminate) health checks
HEALTH_RETRY_SLEEP="${CC_HEALTH_RETRY_SLEEP:-10}"   # seconds between retries
HEALTH_RETRY_MAX="${CC_HEALTH_RETRY_MAX:-6}"         # max retries before escalating

# VPS: Override these variables for your deployment
# Example: APP_DIR=/data/mission-control

echo "=== Mission Control Safe Deploy ==="

run_health_check() {
  local context="$1"
  local attempt=0
  while true; do
    # Capture exit code with `|| code=$?` pattern — prevents set -e (line 10) from
    # aborting the script before we can inspect the code. `bash ... ; local code=$?`
    # would be aborted by set -e on non-zero exit before the assignment runs.
    local code=0
    # P4 FIX: pass --canonical-dir so pm2 cwd check has a real target (not vacuous)
    bash "$HEALTH_SCRIPT" --json-only --canonical-dir "$APP_DIR" || code=$?
    if [[ "$code" -eq 0 ]]; then
      echo "[health] GREEN — ${context}"
      return 0
    elif [[ "$code" -eq 1 ]]; then
      echo "[health] RED (definitive) — ${context}"
      return 1
    elif [[ "$code" -eq 3 ]]; then
      attempt=$(( attempt + 1 ))
      if [[ "$attempt" -ge "$HEALTH_RETRY_MAX" ]]; then
        echo "[health] UNKNOWN after ${attempt} retries — escalating (NOT rolling back) — ${context}"
        return 3
      fi
      echo "[health] UNKNOWN (indeterminate, attempt ${attempt}/${HEALTH_RETRY_MAX}) — sleeping ${HEALTH_RETRY_SLEEP}s..."
      sleep "$HEALTH_RETRY_SLEEP"
    else
      echo "[health] unexpected exit ${code} — treating as indeterminate"
      return 3
    fi
  done
}

do_rollback() {
  echo "[ROLLBACK] Restoring backup build..."
  pm2 stop "$PM2_NAME" || true
  rm -rf "$APP_DIR/.next"
  if [[ -d "$BACKUP_DIR" ]]; then
    cp -r "$BACKUP_DIR" "$APP_DIR/.next"
  fi
  if [[ -f "$APP_DIR/mission-control.db.backup" ]]; then
    cp "$APP_DIR/mission-control.db.backup" "$APP_DIR/mission-control.db"
  fi
  pm2 restart "$PM2_NAME"
  echo "[ROLLBACK] Verifying rollback health..."
  run_health_check "post-rollback" \
    && echo "[ROLLBACK] Rollback succeeded — box is green on prior version" \
    || echo "[ROLLBACK] WARNING: box still not green after rollback — manual intervention required"
}

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
  do_rollback
  exit 1
fi
echo "  Build successful"

# Step 5: Restart PM2 onto fresh build
echo "[5/6] Restarting PM2 onto fresh build..."
pm2 restart "$PM2_NAME"

# Step 6: Health check with exit-contract-aware retry
echo "[6/6] Health check..."
sleep 5   # give pm2 a moment to start serving

HEALTH_CODE=0
run_health_check "post-deploy" || HEALTH_CODE=$?

if [[ "$HEALTH_CODE" -eq 0 ]]; then
  echo "=== Deploy Complete — GREEN ==="
elif [[ "$HEALTH_CODE" -eq 1 ]]; then
  echo "  DEPLOY FAILED — definitive RED"
  do_rollback
  exit 1
else
  # Exit 3: indeterminate after retries — do not rollback, escalate
  echo "  DEPLOY STATUS UNKNOWN after retries — NOT rolling back."
  echo "  Investigate manually: bash scripts/cc-health-check.sh"
  echo "  If box confirmed broken, restore backup: cp .next-backup .next && pm2 restart"
  exit 3
fi
