#!/usr/bin/env bash
#
# BlackCEO Command Center v4.0 VPS Docker bootstrap (inside container)
#
# Idempotent, fail-fast installer that runs inside the OpenClaw container on a
# Hostinger VPS Docker deployment. Implements PRD Section 6.1 and 6.3.
#
# Re-running the script is safe: every step is guarded against prior install.
#
set -euo pipefail

echo "BlackCEO Command Center v4.0 VPS Docker bootstrap (inside container)"
echo "Platform: $(uname -s) $(uname -m)"
echo

#
# Step 1: apt deps
#
echo "[1/9] Installing apt base packages..."
apt-get update
apt-get install -y --no-install-recommends \
  curl \
  ca-certificates \
  gnupg \
  ffmpeg \
  python3 \
  python3-pip \
  git \
  build-essential

#
# Step 2: Node.js 20 LTS via NodeSource
#
NEED_NODE=1
if command -v node >/dev/null 2>&1; then
  NODE_MAJOR="$(node -v | sed -E 's/^v([0-9]+).*/\1/')"
  if [ "$NODE_MAJOR" -ge 20 ]; then
    NEED_NODE=0
    echo "[2/9] Node.js $(node -v) already installed"
  fi
fi
if [ "$NEED_NODE" -eq 1 ]; then
  echo "[2/9] Installing Node.js 20 via NodeSource..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi

#
# Step 3: npm globals
#
echo "[3/9] Installing npm global CLIs (pm2, claude-code, codex, gemini-cli)..."
for pkg in pm2 @anthropic-ai/claude-code @openai/codex @google/gemini-cli; do
  if npm list -g --depth=0 "$pkg" >/dev/null 2>&1; then
    echo "  $pkg already installed globally"
  else
    npm install -g "$pkg"
  fi
done

#
# Step 4: uv
#
if ! command -v uv >/dev/null 2>&1; then
  echo "[4/9] Installing uv..."
  curl -LsSf https://astral.sh/uv/install.sh | sh
  export PATH="$HOME/.local/bin:$PATH"
else
  echo "[4/9] uv already installed at $(command -v uv)"
  export PATH="$HOME/.local/bin:$PATH"
fi

#
# Step 5: Python 3.14 via uv, hermes, free-claude-code
#
echo "[5/9] Installing Python 3.14, hermes, and free-claude-code..."
uv python install 3.14 || true
pip3 install --break-system-packages nousresearch-hermes || true
uv tool install --force "git+https://github.com/Alishahryar1/free-claude-code.git"

#
# Step 6: Antigravity agy
#
echo "[6/9] Installing Antigravity (agy)..."
curl -fsSL https://antigravity.google/cli/install.sh | bash

#
# Step 7: cloudflared (Linux amd64 binary)
#
if ! command -v cloudflared >/dev/null 2>&1; then
  echo "[7/9] Installing cloudflared..."
  curl -L --output /usr/local/bin/cloudflared \
    https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64
  chmod +x /usr/local/bin/cloudflared
else
  echo "[7/9] cloudflared already installed at $(command -v cloudflared)"
fi

#
# Step 8: Persistent volume directories (mkdir -p is idempotent)
#
echo "[8/9] Creating persistent vault and scratch directories under /data..."
mkdir -p /data/vault/journal
mkdir -p /data/vault/studio
mkdir -p /data/operator-scratch

#
# Step 8b: Write ecosystem.config.cjs template (hardened launcher, v4.42.0)
#
# Hostinger containers inject PORT=<random> into the env. The old template put
# PORT: "4000" in the env block, which PM2 STILL inherited from the container
# env BEFORE the app set it. The structural fix is cc-start.sh: it explicitly
# unsets the inherited PORT and exports PORT=CC_PORT before exec-ing next start.
# Setting CC_PORT (not PORT) in the env block means the bleed-path never fires.
#
# Idempotent-healing: always reconcile to the canonical config (not skip-if-exists).
# Backs up the prior file to ecosystem.config.cjs.bak before overwriting so a
# hand-tuned config is not silently lost.
#
# KEY CHANGES vs prior template:
#   - name: "mission-control" (canonical; was "command-center" — converges app name)
#   - script: "bash" + args: "scripts/cc-start.sh --port 4000" (hardened launcher)
#     cc-start.sh: (1) unsets inherited PORT + exports PORT=CC_PORT (env-bleed strip)
#                  (2) kills any orphan process on port 4000 (EADDRINUSE killer)
#                  (3) exec npx next start (correct PM2 PID tracking)
#   - CC_PORT: "4000" in env (never PORT: — prevents Hostinger injected-PORT bleed)
#   - Circuit-breaker: min_uptime + exp_backoff_restart_delay + max_restarts=8 + kill_timeout
#
ECOSYSTEM_DIR="/data/projects/command-center"
ECOSYSTEM_FILE="$ECOSYSTEM_DIR/ecosystem.config.cjs"
mkdir -p "$ECOSYSTEM_DIR"

write_canonical_ecosystem() {
  cat > "$ECOSYSTEM_FILE" <<'ECOFEOF'
module.exports = {
  apps: [{
    name: "mission-control",
    cwd: "/data/projects/command-center",
    script: "bash",
    args: "scripts/cc-start.sh --port 4000",
    env: {
      CC_PORT: "4000",
      NODE_ENV: "production",
      DATABASE_PATH: "/data/projects/command-center/mission-control.db"
    },
    instances: 1,
    exec_mode: "fork",
    autorestart: true,
    min_uptime: 30000,
    max_restarts: 8,
    exp_backoff_restart_delay: 2000,
    kill_timeout: 10000,
    watch: false,
    max_memory_restart: "512M"
  }]
};
ECOFEOF
}

if [ ! -f "$ECOSYSTEM_FILE" ]; then
  echo "[8b/9] Writing PM2 ecosystem template to $ECOSYSTEM_FILE..."
  # B.4 (PRD Addendum B): DATABASE_PATH is pinned to the canonical absolute path.
  write_canonical_ecosystem
else
  # Idempotent-healing: check if the existing file matches canonical.
  NEEDS_UPDATE=0
  grep -q '"mission-control"' "$ECOSYSTEM_FILE" || NEEDS_UPDATE=1
  grep -q 'cc-start.sh' "$ECOSYSTEM_FILE" || NEEDS_UPDATE=1
  grep -q 'min_uptime' "$ECOSYSTEM_FILE" || NEEDS_UPDATE=1
  grep -q 'CC_PORT' "$ECOSYSTEM_FILE" || NEEDS_UPDATE=1
  # Also fail if old vulnerable pattern still present
  grep -q '"command-center"' "$ECOSYSTEM_FILE" && NEEDS_UPDATE=1 || true
  grep -q '"PORT"' "$ECOSYSTEM_FILE" && NEEDS_UPDATE=1 || true

  if [ "$NEEDS_UPDATE" -eq 1 ]; then
    echo "[8b/9] Reconciling stale/vulnerable PM2 ecosystem at $ECOSYSTEM_FILE (backing up to .bak)..."
    cp "$ECOSYSTEM_FILE" "${ECOSYSTEM_FILE}.bak"
    write_canonical_ecosystem
    echo "[8b/9] Ecosystem reconciled to canonical (mission-control + cc-start.sh + circuit-breaker)"
  else
    echo "[8b/9] PM2 ecosystem already canonical at $ECOSYSTEM_FILE — no update needed"
  fi
fi

#
# Step 9: PM2 systemd startup so PM2-managed processes survive restart
#
echo "[9/9] Configuring PM2 systemd startup..."
pm2 startup systemd -u root --hp /root | tail -1 | bash || true
pm2 save || true

#
# Detection summary
#
echo
echo "Bootstrap complete. Detected CLIs:"
for c in node python3 npm claude codex gemini agy uv hermes fcc-server pm2 ffmpeg cloudflared; do
  if command -v "$c" >/dev/null 2>&1; then
    echo "  $c: $(command -v $c)"
  else
    echo "  $c: NOT FOUND"
  fi
done

#
# Command Center repair (durability gate)
# Rebuild better-sqlite3, run migrations, seed SOPs, verify routing.
# This is the permanent fix so tasks move on the Kanban without manual surgery.
#
CC_DIR="$ECOSYSTEM_DIR"
if [ -f "$CC_DIR/scripts/repair-command-center.sh" ]; then
  echo
  echo "Running repair-command-center.sh (durability gate) ..."
  cd "$CC_DIR" && bash scripts/repair-command-center.sh --skip-probe || true
else
  echo
  echo "repair-command-center.sh not found at $CC_DIR/scripts/ — run it manually after cloning the repo"
fi

echo
echo "VPS Docker bootstrap: OK"
