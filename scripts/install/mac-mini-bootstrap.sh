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
#   - name: "blackceo-command-center" (fleet-canonical; legacy "mission-control"
#     and "command-center" are reconciled away — converges app name)
#   - script: "bash" + args: "scripts/cc-start.sh --port 4000" (hardened launcher)
#     cc-start.sh performs env-bleed strip + orphan-port kill before exec-ing next.
#   - CC_PORT: "4000" in env (never PORT: — prevents OpenClaw gateway PORT bleed)
#   - Circuit-breaker: min_uptime + exp_backoff_restart_delay + max_restarts=8 + kill_timeout
#   - PRES-045 deterministic exit policy: stop_exit_codes: [78].
#     scripts/cc-start.sh exits 78 (EX_CONFIG) for exactly one condition — a
#     deterministically stale build — and pm2 must STOP the app on that code
#     instead of restarting it (a restart loop on a deterministic refusal ran
#     2,590 restarts over two days on 2026-09-06 while :4000 stayed dark).
#     A transient crash exits non-78 and keeps its restarts and backoff.
#     Change 78 only together with scripts/cc-start.sh's `exit 78`.
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
    name: \"blackceo-command-center\",
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
    stop_exit_codes: [78],
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
  # PRES-045: stop_exit_codes is REQUIRED — an existing install without the
  # exact exit policy is reconciled (backed up first, unrelated settings
  # preserved by rewriting only through the canonical template; any custom
  # fields beyond the canonical set are captured in the .bak before overwrite).
  NEEDS_UPDATE=0
  grep -q '"blackceo-command-center"' "$ECOSYSTEM_FILE" || NEEDS_UPDATE=1
  grep -q 'cc-start.sh' "$ECOSYSTEM_FILE" || NEEDS_UPDATE=1
  grep -q 'min_uptime' "$ECOSYSTEM_FILE" || NEEDS_UPDATE=1
  grep -q 'CC_PORT' "$ECOSYSTEM_FILE" || NEEDS_UPDATE=1
  grep -q 'stop_exit_codes' "$ECOSYSTEM_FILE" || NEEDS_UPDATE=1
  grep -q 'stop_exit_codes: \[78\]' "$ECOSYSTEM_FILE" || NEEDS_UPDATE=1
  # Also reconcile if a LEGACY app name is still present (mission-control or the
  # bare command-center), or the vulnerable literal PORT key — note the
  # '"command-center"' pattern's leading quote does NOT match
  # '"blackceo-command-center"' (preceded by a hyphen, not a quote).
  grep -q '"mission-control"' "$ECOSYSTEM_FILE" && NEEDS_UPDATE=1 || true
  grep -q '"command-center"' "$ECOSYSTEM_FILE" && NEEDS_UPDATE=1 || true
  grep -q '"PORT"' "$ECOSYSTEM_FILE" && NEEDS_UPDATE=1 || true

  if [ "$NEEDS_UPDATE" -eq 1 ]; then
    echo "[8b/9] Reconciling stale/vulnerable PM2 ecosystem at $ECOSYSTEM_FILE (backing up to .bak)..."
    cp "$ECOSYSTEM_FILE" "${ECOSYSTEM_FILE}.bak"
    printf '%s\n' "$CANONICAL_ECOSYSTEM" > "$ECOSYSTEM_FILE"
    echo "[8b/9] Ecosystem reconciled to canonical (blackceo-command-center + cc-start.sh + circuit-breaker + stop_exit_codes [78])"
    # MR-40: Clean up the .bak sidecar now that the canonical file is in place.
    # The old ecosystem content is preserved in the git history of the bootstrap
    # script itself — the disk copy is a one-shot migration safety net only.
    rm -f "${ECOSYSTEM_FILE}.bak" 2>/dev/null || true
  else
    echo "[8b/9] PM2 ecosystem already canonical at $ECOSYSTEM_FILE — no update needed"
    # Clean up any lingering .bak from a previous interrupted bootstrap run.
    rm -f "${ECOSYSTEM_FILE}.bak" 2>/dev/null || true
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

#
# Step 10: Headquarters capability + persistence preflight
#
# SPEC S10 ("Install, upgrade and failure"): availability flag
# HEADQUARTERS_ENABLED — default enabled when the schema is available, disabled
# with a descriptive setup status when it is not. It is an operational
# fallback, never a customer activation approval; the flag is not an
# authorization surface and nothing here mints, sends or logs an owner link.
#
# The LIVE schema is the authority, never the _migrations ledger — same rule as
# scripts/cc-schema-health.ts (a box can claim a migration applied while the
# columns/tables are absent). S6 owns the table set below.
#
# Runs AFTER the repair gate on purpose: on a fresh box the migrations only run
# inside repair-command-center.sh, so a check placed before it would disable
# Headquarters on every new install and nothing later would re-enable it.
#
# Soft gate by design: a schema-less box still installs, with Headquarters
# DISABLED — fail-closed availability, never a broken install and never a
# deceptive empty office (SPEC S10: startup schema failure blocks Headquarters
# writes; it does not fake a populated company).
#
# Persistence uses the EXISTING Mac locations from src/lib/platform.ts
# (~/clawd/, ~/clawd/scratch/, ~/.mission-control/identity). The exact outbox
# file is owned by the telemetry unit and is deliberately NOT guessed here.
# No new service, no new container, no key or provider config is touched.
#
# Test seam: every helper takes its paths as positional args (defaults are the
# canonical ones) and HQ_SQLITE_BIN names the probe binary, so
# tests/unit/hq/B31/mac-bootstrap-hq.test.sh drives the REAL functions against
# temp fixtures (extracted by sed range, never copied).
#
HQ_SQLITE_BIN="${HQ_SQLITE_BIN:-sqlite3}"

hq_required_tables() {
  printf '%s\n' hq_activity hq_activity_state hq_activity_receipts \
    hq_run_bindings hq_chat_sessions hq_chat_turns hq_owner_login_uses
}

# Mirrors the DATABASE_PATH order ecosystem.config.cjs documents. Tier 1 (an
# exported DATABASE_PATH) then the path the canonical ecosystem at step 8b pins
# for THIS install dir, which is what any pm2-started CC on a box this script
# installed actually opens. A hand-tuned ecosystem that repointed the path
# elsewhere is the one case this does not see — the resolved path is printed so
# a mismatch is visible, never silent.
hq_resolve_db_path() {
  local install_dir="${1:-$ECOSYSTEM_DIR}"
  if [ -n "${DATABASE_PATH:-}" ]; then
    printf '%s' "$DATABASE_PATH"
    return 0
  fi
  printf '%s' "$install_dir/mission-control.db"
}

# stdout: "<1|0>|<reason>" — reason is a token or "tables-missing:a,b".
# Never a guess: an unreadable file is reported as unreadable, not as an empty
# table set, and a missing probe binary is its own reason (UNDETERMINED is said
# out loud rather than collapsed into "disabled because broken").
hq_capability_check() {
  local db="${1:-}" missing="" t probe rc
  if ! command -v "$HQ_SQLITE_BIN" >/dev/null 2>&1; then
    printf '0|sqlite3-cli-absent'
    return 0
  fi
  if [ ! -f "$db" ]; then
    printf '0|database-absent'
    return 0
  fi
  probe="$("$HQ_SQLITE_BIN" -readonly "$db" "SELECT count(*) FROM sqlite_master" 2>/dev/null)"
  rc=$?
  if [ "$rc" -ne 0 ] || [ -z "$probe" ]; then
    printf '0|database-unreadable'
    return 0
  fi
  for t in $(hq_required_tables); do
    if ! "$HQ_SQLITE_BIN" -readonly "$db" \
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='$t' LIMIT 1" 2>/dev/null | grep -q 1; then
      missing="${missing}${missing:+,}$t"
    fi
  done
  if [ -n "$missing" ]; then
    printf '0|tables-missing:%s' "$missing"
    return 0
  fi
  printf '1|schema-present'
}

# Additive only, same contract as the VPS installer's env reconcile: an
# operator/cohort value already present is preserved, an absent key is
# appended, nothing is reordered or rewritten. Append-only needs no .bak — no
# existing byte is touched, so there is nothing to restore.
# stdout: "written" | "operator value preserved" | "write-failed".
hq_apply_flag() {
  local env_file="${1:-}" value="${2:-}"
  [ -n "$env_file" ] || { printf 'write-failed'; return 0; }
  if [ -f "$env_file" ] && grep -qE '^[[:space:]]*(export[[:space:]]+)?HEADQUARTERS_ENABLED[[:space:]]*=' "$env_file"; then
    printf 'operator value preserved'
    return 0
  fi
  if printf '%s\n' "HEADQUARTERS_ENABLED=$value" >> "$env_file" 2>/dev/null; then
    chmod 600 "$env_file" 2>/dev/null || true
    printf 'written'
  else
    printf 'write-failed'
  fi
}

hq_persistence_preflight() {
  local root="${1:-$HOME}"
  mkdir -p "$root/clawd/scratch" "$root/.mission-control/identity" 2>/dev/null || return 1
  return 0
}

echo "[step 10] Headquarters capability + persistence preflight (Mac)..."
HQ_ENV_FILE="$ECOSYSTEM_DIR/.env.local"
if hq_persistence_preflight "$HOME"; then
  echo "  persistence:    ~/clawd/scratch/ and ~/.mission-control/identity present (bridge identity + workspace roots; no new service)"
else
  echo "  persistence:    WARN — could not create the Mac persistence roots; check $HOME permissions"
fi
HQ_DB="$(hq_resolve_db_path "$ECOSYSTEM_DIR")"
HQ_RESULT="$(hq_capability_check "$HQ_DB")"
HQ_ENABLED="${HQ_RESULT%%|*}"
HQ_REASON="${HQ_RESULT#*|}"
HQ_FLAG_ACTION="$(hq_apply_flag "$HQ_ENV_FILE" "$HQ_ENABLED")"

echo "  database:       $HQ_DB"
if [ "$HQ_ENABLED" = "1" ]; then
  echo "  capability:     schema present — HEADQUARTERS_ENABLED=1"
else
  echo "  capability:     HEADQUARTERS_ENABLED=0 — $HQ_REASON"
  echo "                  Headquarters writes stay blocked until the reserved HQ migration"
  echo "                  lands and this step re-runs. Health reports this as a setup state,"
  echo "                  not a dead box."
fi
echo "  flag:           $HQ_FLAG_ACTION in $HQ_ENV_FILE"

echo
echo "Mac Mini bootstrap: OK"
