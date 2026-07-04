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
# Restart service (if PM2 is managing it)
# ----------------------------------------------------------
step "Step 5: Restart service"
if command -v pm2 >/dev/null 2>&1; then
  if pm2 list 2>/dev/null | grep -q "command-center\|blackceo"; then
    pm2 reload ecosystem.config.cjs 2>&1 || pm2 restart all 2>&1 || warn "PM2 reload failed — restart manually with pm2 restart all"
    success "PM2 reloaded"
  else
    warn "PM2 installed but no command-center process found — start manually with: pm2 start ecosystem.config.cjs"
  fi
else
  warn "PM2 not installed — restart the Next.js dev/prod server manually."
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
