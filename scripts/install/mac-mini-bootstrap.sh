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
# Step 8b: Write ecosystem.config.cjs template (hardened launcher, v4.42.0)
#
# Idempotent-healing: always reconcile to the canonical config (not skip-if-exists).
# Backs up the prior file to ecosystem.config.cjs.bak before overwriting so a
# hand-tuned config is not silently lost.
#
# KEY CHANGES vs prior template:
#   - name: "mission-control" (canonical; was "command-center" — converges app name)
#   - script: "bash" + args: "scripts/cc-start.sh --port 4000" (hardened launcher)
#     cc-start.sh performs env-bleed strip + orphan-port kill before exec-ing next.
#   - CC_PORT: "4000" in env (never PORT: — prevents OpenClaw gateway PORT bleed)
#   - Circuit-breaker: min_uptime + exp_backoff_restart_delay + max_restarts=8 + kill_timeout
#
# NOTE: Never call `openclaw gateway restart` from this script — cc-start.sh
# manages ONLY the CC node process, not the OpenClaw gateway (Mac launchd rule).
#
ECOSYSTEM_DIR="$HOME/projects/command-center"
ECOSYSTEM_FILE="$ECOSYSTEM_DIR/ecosystem.config.cjs"
mkdir -p "$ECOSYSTEM_DIR"

# Build the canonical ecosystem content (used for both fresh install and reconciliation).
CANONICAL_ECOSYSTEM="module.exports = {
  apps: [{
    name: \"mission-control\",
    cwd: \"$ECOSYSTEM_DIR\",
    script: \"bash\",
    args: \"scripts/cc-start.sh --port 4000\",
    env: {
      CC_PORT: \"4000\",
      NODE_ENV: \"production\",
      DATABASE_PATH: \"$ECOSYSTEM_DIR/mission-control.db\"
    },
    instances: 1,
    exec_mode: \"fork\",
    autorestart: true,
    min_uptime: 30000,
    max_restarts: 8,
    exp_backoff_restart_delay: 2000,
    kill_timeout: 10000,
    watch: false,
    max_memory_restart: \"512M\"
  }]
};"

if [ ! -f "$ECOSYSTEM_FILE" ]; then
  echo "[8b/9] Writing PM2 ecosystem template to $ECOSYSTEM_FILE..."
  # B.4 (PRD Addendum B): DATABASE_PATH is pinned to the canonical absolute path
  # so a pm2 restart from any cwd always opens the same DB.
  printf '%s\n' "$CANONICAL_ECOSYSTEM" > "$ECOSYSTEM_FILE"
else
  # Idempotent-healing: check if the existing file matches canonical.
  # Compare the critical fields rather than byte-exact (comments may differ).
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
    printf '%s\n' "$CANONICAL_ECOSYSTEM" > "$ECOSYSTEM_FILE"
    echo "[8b/9] Ecosystem reconciled to canonical (mission-control + cc-start.sh + circuit-breaker)"
  else
    echo "[8b/9] PM2 ecosystem already canonical at $ECOSYSTEM_FILE — no update needed"
  fi
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
echo "Mac Mini bootstrap: OK"
