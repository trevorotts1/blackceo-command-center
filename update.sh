#!/usr/bin/env bash
# ============================================================
#  BlackCEO Command Center — Updater
#  Pulls latest from GitHub, installs deps, runs migrations.
#  DESTRUCTIVE: replaces app code in-place. Backs up first.
# ============================================================

set -euo pipefail
SCRIPT_VERSION="1.0.0"
REPO_URL="https://github.com/trevorotts1/blackceo-command-center.git"
LOG_FILE="/tmp/blackceo-cc-update-$(date +%Y%m%d-%H%M%S).log"
exec 1> >(tee -a "$LOG_FILE") 2>&1

step() { echo ""; echo "━━━ $1 ━━━"; }
success() { echo "  ✓ $1"; }
warn() { echo "  ⚠ $1"; }
fatal() { echo "  ✗ ERROR: $1"; exit 1; }

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

if [ -z "$INSTALL_DIR" ]; then
  fatal "Command Center not found at any expected install path. Cannot update."
fi
success "Found install at: $INSTALL_DIR"

cd "$INSTALL_DIR"

# ----------------------------------------------------------
# Backup
# ----------------------------------------------------------
step "Step 1: Backup"
if [ -d "/data/.openclaw" ]; then
  BACKUP_BASE="$HOME/blackceo-cc-backups"
else
  BACKUP_BASE="$HOME/Downloads/blackceo-cc-backups"
fi
BACKUP_DIR="$BACKUP_BASE/cc-backup-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$BACKUP_DIR"

# Backup the critical files (not node_modules — too big)
for f in version package.json package-lock.json CHANGELOG.md ecosystem.config.cjs; do
  [ -f "$f" ] && cp "$f" "$BACKUP_DIR/" 2>/dev/null || true
done
if [ -d "src" ]; then
  cp -r src "$BACKUP_DIR/" 2>/dev/null || true
fi
if [ -d "config" ]; then
  cp -r config "$BACKUP_DIR/" 2>/dev/null || true
fi
success "Backup: $BACKUP_DIR"

# ----------------------------------------------------------
# Capture current version
# ----------------------------------------------------------
OLD_VERSION=""
[ -f version ] && OLD_VERSION=$(tr -d '[:space:]' < version)
success "Current version: ${OLD_VERSION:-unknown}"

# ----------------------------------------------------------
# Pull latest
# ----------------------------------------------------------
step "Step 2: Pull latest from GitHub"
if [ -d ".git" ]; then
  git fetch origin main 2>&1 || fatal "git fetch failed"
  # Stash any local changes to avoid conflicts
  if ! git diff --quiet 2>/dev/null; then
    warn "Local changes detected — stashing before update"
    git stash push -m "auto-stash before update-$(date +%s)" 2>&1 || true
  fi
  git reset --hard origin/main 2>&1 || fatal "git reset failed"
  success "Pulled latest from origin/main"
else
  fatal "Install dir is not a git repo. Manual recovery required: clone $REPO_URL fresh."
fi

NEW_VERSION=""
[ -f version ] && NEW_VERSION=$(tr -d '[:space:]' < version)
success "New version: ${NEW_VERSION:-unknown}"

# ----------------------------------------------------------
# Install dependencies
# ----------------------------------------------------------
step "Step 3: Install npm dependencies"
if [ -f "package-lock.json" ]; then
  npm ci --no-audit --no-fund 2>&1 || npm install --no-audit --no-fund 2>&1 || fatal "npm install failed"
else
  npm install --no-audit --no-fund 2>&1 || fatal "npm install failed"
fi
success "Dependencies installed"

# ----------------------------------------------------------
# Run any database migrations (if seed files changed)
# ----------------------------------------------------------
step "Step 4: Database migrations (if applicable)"
# Schema/data migrations are applied automatically and idempotently by the
# TypeScript migration runner (src/lib/db/migrate.ts -> runMigrations) on start;
# there is nothing to apply here. The legacy seed-departments*.sql files are
# demo-only artifacts and now live (non-executed) under docs/archive/legacy-demo-sql/.
if [ -f "seed-departments-fixed.sql" ] || [ -f "seed-departments.sql" ]; then
  warn "Legacy demo seed SQL found at repo root — this is DEMO-ONLY data."
  warn "  Files: $(ls seed-departments*.sql 2>/dev/null | tr '\n' ' ')"
  warn "  Do NOT run these on a client/production box: they inject fake demo tasks."
  warn "  Real migrations run automatically via the app's migration runner."
  warn "  These files belong in docs/archive/legacy-demo-sql/ — move them there."
fi

# ----------------------------------------------------------
# Build + restart (atomic deploy)
# ----------------------------------------------------------
# BUILD-05: the old updater pulled new code + `npm ci`, then did a bare
# `pm2 reload` — it NEVER recompiled. pm2 reload restarts the process onto the
# SAME stale `.next` build, so freshly-merged pages/components never took effect
# (the dead client Kanban class). The recompile MUST happen between install and
# restart. We route through scripts/atomic-deploy.sh, which builds into a temp
# dir, gates on a FRESH .next/BUILD_ID (mtime > build start), atomically swaps
# .next (no missing-build window), restarts pm2 onto the fresh build, and
# health-checks with auto-rollback. We deliberately do NOT use a bare
# `npm run build` here (that path — used by the deprecated scripts/deploy.sh —
# does a non-atomic `rm -rf .next` before building, opening a window where the
# server has no build to serve).
step "Step 5: Build + restart (atomic deploy)"
CC_PM2_NAME="blackceo-command-center"
ATOMIC_DEPLOY="$INSTALL_DIR/scripts/atomic-deploy.sh"

# atomic-deploy.sh requires bash 4+ (macOS system bash is 3.2). Resolve one.
BASH4=""
for _cand in /opt/homebrew/bin/bash /usr/local/bin/bash bash; do
  if command -v "$_cand" >/dev/null 2>&1 && \
     [ "$("$_cand" -c 'echo "${BASH_VERSINFO[0]:-0}"' 2>/dev/null || echo 0)" -ge 4 ]; then
    BASH4="$_cand"; break
  fi
done

DEPLOY_OK=0
if [ -f "$ATOMIC_DEPLOY" ] && [ -n "$BASH4" ]; then
  ADEPLOY_ARGS=(--app-dir "$INSTALL_DIR" --pm2-app "$CC_PM2_NAME")
  [ -n "${CC_PORT:-}" ] && ADEPLOY_ARGS+=(--port "$CC_PORT")
  # set -e is active for the updater; suspend it around the deploy so we can
  # inspect its exit-contract code (0 green / 1 rolled-back / 2 pre-flight / 3 unknown).
  set +e
  "$BASH4" "$ATOMIC_DEPLOY" "${ADEPLOY_ARGS[@]}"
  ADEPLOY_RC=$?
  set -e
  case "$ADEPLOY_RC" in
    0) success "Atomic deploy GREEN — fresh build compiled, atomically swapped, and serving"; DEPLOY_OK=1 ;;
    3) warn "Atomic deploy UNKNOWN (health indeterminate) — fresh build swapped but health not confirmed. NOT rolled back; investigate. See receipt above."; DEPLOY_OK=1 ;;
    1) fatal "Atomic deploy FAILED and auto-rolled-back to the prior build — the update did NOT take effect on the running server. See the atomic-deploy receipt above." ;;
    2) fatal "Atomic deploy pre-flight failed (disk / build / deps) — old build untouched, code NOT recompiled. Fix the reported issue and re-run this updater." ;;
    *) fatal "Atomic deploy exited with unexpected code $ADEPLOY_RC — refusing to declare the update successful." ;;
  esac
fi

if [ "$DEPLOY_OK" -ne 1 ]; then
  # DEGRADED FALLBACK: atomic-deploy.sh or bash 4+ is not available on this box
  # (older checkout / no Homebrew bash). We MUST still recompile — a plain
  # `pm2 reload` would serve the OLD build (the BUILD-05 bug). Do an IN-PLACE
  # `next build` (which writes into .next WITHOUT the destructive `rm -rf .next`
  # window scripts/deploy.sh used), verify a BUILD_ID landed, then reload pm2.
  warn "atomic-deploy.sh or bash 4+ not available — falling back to in-place build + reload (DEGRADED path)."
  set +e
  npm run build 2>&1 | tail -8
  BUILD_RC=${PIPESTATUS[0]}
  set -e
  [ "${BUILD_RC:-1}" -eq 0 ] || fatal "Build failed (exit ${BUILD_RC}) — refusing to reload onto a stale/broken build."
  [ -f "$INSTALL_DIR/.next/BUILD_ID" ] || fatal "Build produced no .next/BUILD_ID — refusing to reload onto an incomplete build."
  success "Rebuild complete (.next/BUILD_ID present)"

  if command -v pm2 >/dev/null 2>&1; then
    if pm2 list 2>/dev/null | grep -q "command-center\|blackceo"; then
      pm2 reload ecosystem.config.cjs 2>&1 || pm2 restart all 2>&1 || warn "PM2 reload failed — restart manually with pm2 restart all"
      success "PM2 reloaded onto fresh build"
    else
      warn "PM2 installed but no command-center process found — start manually with: pm2 start ecosystem.config.cjs"
    fi
  else
    warn "PM2 not installed — restart the Next.js prod server manually."
  fi
fi

# ----------------------------------------------------------
# Write UPDATE PENDING flag for agent
# ----------------------------------------------------------
step "Step 6: Notify agent via AGENTS.md flag"
if [ -d "/data/clawd" ]; then
  WORKSPACE="/data/clawd"
else
  WORKSPACE="$HOME/clawd"
fi
AGENTS_FILE="$WORKSPACE/AGENTS.md"
mkdir -p "$WORKSPACE"
touch "$AGENTS_FILE"

# Remove old command-center flag if present
grep -v "COMMAND CENTER UPDATE PENDING" "$AGENTS_FILE" > "$AGENTS_FILE.tmp" 2>/dev/null || true
mv "$AGENTS_FILE.tmp" "$AGENTS_FILE" 2>/dev/null || true

cat >> "$AGENTS_FILE" <<EOF

## 🔴 COMMAND CENTER UPDATE PENDING

BlackCEO Command Center was updated from ${OLD_VERSION:-unknown} to ${NEW_VERSION:-unknown} on $(date -u +%Y-%m-%dT%H:%M:%SZ).

Read \`$INSTALL_DIR/CHANGELOG.md\` (top entry) and:
1. Verify the app is running (curl http://localhost:4000/api/health or check pm2 status)
2. Run any SQL migrations if the changelog mentions schema changes
3. Tell the owner: "Command Center updated to ${NEW_VERSION}. [list any items that need owner action]"
4. Remove this section from AGENTS.md when complete

Backup of pre-update state: $BACKUP_DIR
EOF
success "AGENTS.md flag written"

# ----------------------------------------------------------
# Record version + check timestamp
# ----------------------------------------------------------
date -u +%Y-%m-%dT%H:%M:%SZ > "$INSTALL_DIR/.last-update-check" 2>/dev/null || true

step "Update complete"
echo ""
echo "  ✓ Command Center updated from ${OLD_VERSION:-unknown} to ${NEW_VERSION:-unknown}"
echo "  ✓ Backup: $BACKUP_DIR"
echo "  ✓ Log: $LOG_FILE"
echo "  ✓ Agent flag written to: $AGENTS_FILE"
echo ""
echo "  Next steps:"
echo "    1. Verify the app is responsive (curl /api/health if endpoint exists)"
echo "    2. Tell your agent: 'Process the COMMAND CENTER UPDATE PENDING section in my AGENTS.md'"
echo ""
