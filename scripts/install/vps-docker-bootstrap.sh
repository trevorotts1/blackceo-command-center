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
# Step 8b: Write ecosystem.config.cjs template (Bug 7, v4.0.2)
#
# Hostinger containers inject PORT=<random> into the env. PM2 inherits that
# and overrides whatever the project's .env says, so `next start` tries to
# bind the random port, collides with the OpenClaw wrapper, dies in a
# restart loop. Hardcode the port in BOTH the args and the env block.
#
ECOSYSTEM_DIR="/data/projects/command-center"
ECOSYSTEM_FILE="$ECOSYSTEM_DIR/ecosystem.config.cjs"
mkdir -p "$ECOSYSTEM_DIR"
if [ ! -f "$ECOSYSTEM_FILE" ]; then
  echo "[8b/9] Writing PM2 ecosystem template to $ECOSYSTEM_FILE..."
  cat > "$ECOSYSTEM_FILE" <<'EOF'
module.exports = {
  apps: [{
    name: "command-center",
    cwd: "/data/projects/command-center",
    script: "npm",
    args: "run start -- -p 4000 -H 0.0.0.0",
    env: {
      PORT: "4000",
      NODE_ENV: "production"
    },
    instances: 1,
    autorestart: true,
    max_restarts: 5,
    exec_mode: "fork",
    user: "node"
  }]
};
EOF
else
  echo "[8b/9] PM2 ecosystem already present at $ECOSYSTEM_FILE — leaving as-is"
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
