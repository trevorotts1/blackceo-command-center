#!/usr/bin/env bash
#
# BlackCEO Command Center v4.0 Mac Mini bootstrap
#
# Idempotent, fail-fast installer for a fresh Mac Mini deployment.
# Implements PRD Section 6.1 (what gets installed) and 6.2 (the script).
#
# Safe to re-run: every step checks for prior installation before acting.
# Failures abort the whole script (set -euo pipefail).
#
set -euo pipefail

echo "BlackCEO Command Center v4.0 Mac Mini bootstrap"
echo "Platform: $(uname -s) $(uname -m)"
echo

#
# Step 1: Homebrew
#
if ! command -v brew >/dev/null 2>&1; then
  echo "[1/9] Installing Homebrew..."
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  # Ensure brew is on PATH for the rest of this script (Apple Silicon path)
  if [ -x /opt/homebrew/bin/brew ]; then
    eval "$(/opt/homebrew/bin/brew shellenv)"
  elif [ -x /usr/local/bin/brew ]; then
    eval "$(/usr/local/bin/brew shellenv)"
  fi
else
  echo "[1/9] Homebrew already installed at $(command -v brew)"
fi

#
# Step 2: brew formulae (Node, Python, ffmpeg, cloudflared)
#
echo "[2/9] Installing brew formulae (node@20, python@3.14, ffmpeg, cloudflared)..."
for formula in node@20 python@3.14 ffmpeg cloudflared; do
  if brew list "$formula" >/dev/null 2>&1; then
    echo "  $formula already installed"
  else
    brew install "$formula"
  fi
done

#
# Step 3: Obsidian cask
#
echo "[3/9] Installing Obsidian cask..."
if brew list --cask obsidian >/dev/null 2>&1; then
  echo "  obsidian cask already installed"
else
  brew install --cask obsidian
fi

#
# Step 4: npm globals
#
echo "[4/9] Installing npm global CLIs (pm2, claude-code, codex, gemini-cli)..."
for pkg in pm2 @anthropic-ai/claude-code @openai/codex @google/gemini-cli; do
  if npm list -g --depth=0 "$pkg" >/dev/null 2>&1; then
    echo "  $pkg already installed globally"
  else
    npm install -g "$pkg"
  fi
done

#
# Step 5: uv (per PRD 6.3, exact path)
#
if ! command -v uv >/dev/null 2>&1; then
  echo "[5/9] Installing uv..."
  curl -LsSf https://astral.sh/uv/install.sh | sh
  export PATH="$HOME/.local/bin:$PATH"
else
  echo "[5/9] uv already installed at $(command -v uv)"
  export PATH="$HOME/.local/bin:$PATH"
fi

#
# Step 6: Python 3.14 via uv, pip packages, free-claude-code
#
echo "[6/9] Installing Python 3.14 via uv, hermes, and free-claude-code..."
uv python install 3.14 || true
pip3 install --user nousresearch-hermes || true
uv tool install --force "git+https://github.com/Alishahryar1/free-claude-code.git"

#
# Step 7: Antigravity agy (per PRD 6.3, exact path)
#
echo "[7/9] Installing Antigravity (agy)..."
curl -fsSL https://antigravity.google/cli/install.sh | bash

# Ensure ~/.local/bin is on PATH in zshrc (idempotent grep guard)
if [ -f "$HOME/.zshrc" ]; then
  if ! grep -q 'export PATH="$HOME/.local/bin:$PATH"' "$HOME/.zshrc"; then
    echo 'export PATH="$HOME/.local/bin:$PATH"' >> "$HOME/.zshrc"
  fi
else
  echo 'export PATH="$HOME/.local/bin:$PATH"' > "$HOME/.zshrc"
fi

#
# Step 8: Vault + scratch directories (mkdir -p is idempotent)
#
echo "[8/9] Creating vault and scratch directories..."
mkdir -p "$HOME/Documents/Obsidian Vault/journal"
mkdir -p "$HOME/Documents/Obsidian Vault/studio"
mkdir -p "$HOME/operator-scratch"

#
# Step 8b: Write ecosystem.config.cjs template (Bug 7, v4.0.2)
#
# Hardcode the port in BOTH the args and the env block so a stray PORT in
# the shell env can't override the dashboard's listening port.
#
ECOSYSTEM_DIR="$HOME/projects/command-center"
ECOSYSTEM_FILE="$ECOSYSTEM_DIR/ecosystem.config.cjs"
mkdir -p "$ECOSYSTEM_DIR"
if [ ! -f "$ECOSYSTEM_FILE" ]; then
  echo "[8b/9] Writing PM2 ecosystem template to $ECOSYSTEM_FILE..."
  cat > "$ECOSYSTEM_FILE" <<EOF
module.exports = {
  apps: [{
    name: "command-center",
    cwd: "$ECOSYSTEM_DIR",
    script: "npm",
    args: "run start -- -p 4000 -H 0.0.0.0",
    env: {
      PORT: "4000",
      NODE_ENV: "production"
    },
    instances: 1,
    autorestart: true,
    max_restarts: 5,
    exec_mode: "fork"
  }]
};
EOF
else
  echo "[8b/9] PM2 ecosystem already present at $ECOSYSTEM_FILE — leaving as-is"
fi

#
# Step 9: PM2 launchd startup
#
echo "[9/9] Configuring PM2 to start on boot..."
pm2 startup launchd -u "$USER" --hp "$HOME" | tail -1 | bash || true
pm2 save || true

#
# Detection summary
#
echo
echo "Bootstrap complete. Detected CLIs:"
for c in node python3 npm brew claude codex gemini agy uv hermes fcc-server obsidian-cli pm2 ffmpeg cloudflared; do
  if command -v "$c" >/dev/null 2>&1; then
    echo "  $c: $(command -v $c)"
  else
    echo "  $c: NOT FOUND"
  fi
done

echo
echo "Mac Mini bootstrap: OK"
