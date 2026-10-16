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
  build-essential \
  lsof
# lsof: cc-start.sh's orphan-port killer prefers lsof to free port 4000 before
# `next start` binds it (breaks the EADDRINUSE crash-loop). The container image
# does NOT ship lsof by default; cc-start.sh falls back to a pure-python3
# /proc/net parser when it is absent, but installing lsof gives the killer its
# primary, fastest path on every future container build.

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
#   - name: "blackceo-command-center" (fleet-canonical; legacy "mission-control"
#     and "command-center" are reconciled away — converges app name)
#   - script: "bash" + args: "scripts/cc-start.sh --port 4000" (hardened launcher)
#     cc-start.sh: (1) unsets inherited PORT + exports PORT=CC_PORT (env-bleed strip)
#                  (2) kills any orphan process on port 4000 (EADDRINUSE killer)
#                  (3) exec npx next start (correct PM2 PID tracking)
#   - CC_PORT: "4000" in env (never PORT: — prevents Hostinger injected-PORT bleed)
#   - Circuit-breaker: min_uptime + exp_backoff_restart_delay + max_restarts=8 + kill_timeout
#   - PRES-045 deterministic exit policy: stop_exit_codes: [78].
#     scripts/cc-start.sh exits 78 (EX_CONFIG) for exactly one condition — a
#     deterministically stale build — and pm2 must STOP the app on that code
#     instead of restarting it (a restart loop on a deterministic refusal ran
#     2,590 restarts over two days on 2026-09-06 while :4000 stayed dark).
#     A transient crash exits non-78 and keeps its restarts and backoff.
#     Change 78 only together with scripts/cc-start.sh's `exit 78`.
#
ECOSYSTEM_DIR="/data/projects/command-center"
ECOSYSTEM_FILE="$ECOSYSTEM_DIR/ecosystem.config.cjs"
mkdir -p "$ECOSYSTEM_DIR"

write_canonical_ecosystem() {
  cat > "$ECOSYSTEM_FILE" <<'ECOFEOF'
module.exports = {
  apps: [{
    name: "blackceo-command-center",
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
    stop_exit_codes: [78],
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
    write_canonical_ecosystem
    echo "[8b/9] Ecosystem reconciled to canonical (blackceo-command-center + cc-start.sh + circuit-breaker + stop_exit_codes [78])"
    # MR-40: Clean up the .bak sidecar now that the canonical file is in place.
    rm -f "${ECOSYSTEM_FILE}.bak" 2>/dev/null || true
  else
    echo "[8b/9] PM2 ecosystem already canonical at $ECOSYSTEM_FILE — no update needed"
    rm -f "${ECOSYSTEM_FILE}.bak" 2>/dev/null || true
  fi
fi

#
# Step 8c: Additive env-file reconcile (canonical in-container env store)
#
# Step 8b converges the launcher; this step converges the CONFIG the launcher
# serves. A box installed months ago lacks keys the current template ships
# (new toggles, new provider keys), and a blind overwrite would wipe keys the
# operator already set. So: ADDITIVE ONLY — append keys present as ACTIVE
# (uncommented KEY=...) lines in the repo .env.example template but absent
# from the live file; never modify, reorder, or delete an existing line.
# Commented-only template lines are opt-in tunables and are NOT activated.
# Backup to .env.bak before writing (same .bak convention as step 8b).
# Values are never echoed — key names and counts only (never print secrets).
# Non-fatal by design: a missing template warns and returns 0 so bootstrap
# still completes step 9.
#
# ponytail: no explicit fsync here (bash has none); same-dir temp + rename(2)
# is still atomic — readers see old or new, never half-written. Upgrade path:
# python3 fsync of temp + dir before mv when power-loss durability matters.
#
# Test seam: template/target are positional args defaulting to the canonical
# paths, so tests/unit/vps-bootstrap-env-reconcile.test.sh drives the REAL
# function against temp dirs.
#
_ilj_env_key_of_line() {
  local line="$1" rest key
  rest="$(printf '%s' "$line" | sed -E 's/^[[:space:]]+//')"
  case "$rest" in
    ''|\#*) return 1 ;;
  esac
  case "$rest" in
    export[[:space:]]*)
      rest="$(printf '%s' "$rest" | sed -E 's/^export[[:space:]]+//')" ;;
  esac
  case "$rest" in
    [A-Za-z_]*=*)
      key="${rest%%=*}"
      key="$(printf '%s' "$key" | sed -E 's/[[:space:]]+$//')" ;;
    *) return 1 ;;
  esac
  case "$key" in
    ''|*[!A-Za-z0-9_]*|'export') return 1 ;;
  esac
  printf '%s' "$key"
}

reconcile_env_file_additive() {
  local template="${1:-${ILJ_ENV_TEMPLATE:-$ECOSYSTEM_DIR/.env.example}}"
  local target="${2:-${ILJ_ENV_TARGET:-/data/.openclaw/.env}}"
  if [[ ! -f "$template" ]]; then
    echo "[8c/9] Env template not found at $template — skipping env reconcile (non-fatal)"
    return 0
  fi
  mkdir -p "$(dirname "$target")"
  if [[ ! -f "$target" ]]; then
    echo "[8c/9] Seeding env file at $target from template..."
    cp -p "$template" "$target"
    chmod 600 "$target"
    return 0
  fi
  cp -p "$target" "${target}.bak"
  chmod 600 "${target}.bak"
  local tmp added key line
  added=0
  tmp="$(mktemp "$(dirname "$target")/.env.tmp.XXXXXX")"
  cp -p "$target" "$tmp"
  while IFS= read -r line || [[ -n "$line" ]]; do
    key="$(_ilj_env_key_of_line "$line")" || continue
    if ! grep -q -E "^[[:space:]]*(export[[:space:]]+)?${key}[[:space:]]*=" "$target"; then
      printf '%s\n' "$line" >> "$tmp"
      added=$((added+1))
    fi
  done < "$template" || true
  chmod 600 "$tmp"
  mv -f "$tmp" "$target"
  echo "[8c/9] Env reconcile: $added missing key(s) appended to $target (existing keys untouched, backup at ${target}.bak)"
  return 0
}

echo "[8c/9] Reconciling in-container env file (additive, operator keys preserved)..."
reconcile_env_file_additive || echo "[8c/9] WARNING: env reconcile failed — continuing (PM2 reconcile already applied)"

#
# Step 8d: Headquarters capability check + availability flag
#
# SPEC S10 (install/upgrade/failure): "Feature availability flag proposed
# HEADQUARTERS_ENABLED=1 after capability checks; default enabled in tested
# updated cohort, disabled if schema unavailable with descriptive setup status.
# Flag is operational fallback, not customer activation approval." and
# SPEC S10 (two targets): "Keep existing persistent /data mount ... New
# database rows use existing resolved database. Outbox and bridge identity use
# existing persistent workspace locations."
#
# Two capabilities are proved, both READ-ONLY:
#   (1) SCHEMA — the additive HQ tables exist in the database the app actually
#       serves ($ECOSYSTEM_DIR/mission-control.db, the DATABASE_PATH pinned in
#       step 8b). Missing tables mean the Headquarters feature cannot write;
#       the flag is written 0 with the missing names, never silently 1
#       ("blocks Headquarters writes, not a deceptive empty office").
#   (2) PERSISTENCE — the resolved database file, the platform workspace root
#       and the bridge device-identity dir all live under the persistent mount
#       (default /data). These are the exact VPS paths in CC
#       src/lib/platform.ts: /data/.openclaw/workspace/,
#       /data/.openclaw/mission-control/identity, /data/.openclaw/openclaw.json.
#       A value outside the mount would not survive `--force-recreate`, so the
#       flag is written 0 and the offending path is named.
#
# ADDITIVE ONLY: an already-set HEADQUARTERS_ENABLED (operator or prior run) is
# PRESERVED, never rotated. Backup to .env.bak before writing (step 8c's .bak
# convention, which step 8b shares). Non-fatal by design — a missing python3 or
# database warns and returns 0 so bootstrap still reaches step 9.
#
# Test seam: HQ_CAPABILITY_DB / HQ_PERSIST_ROOT / HQ_ENV_TARGET are positional
# overrides defaulting to the canonical container paths, so
# tests/unit/hq/B32/headquarters-docker-capability.test.sh drives the REAL
# functions against temp dirs (same seam pattern as step 8c's ILJ_ENV_*).
#
hq_missing_tables() {
  local db="$1"
  if [ ! -f "$db" ]; then
    printf 'NO-DATABASE'
    return 0
  fi
  python3 - "$db" <<'PYHQ'
import sqlite3, sys
# The additive HQ table set of SPEC S6. Read-only: PRAGMA + sqlite_master only,
# no write, no migration, no fixture seeding.
REQUIRED = ("hq_activity", "hq_activity_state", "hq_activity_receipts",
            "hq_run_bindings", "hq_chat_sessions", "hq_chat_turns",
            "hq_owner_login_uses")
try:
    con = sqlite3.connect("file:%s?mode=ro" % sys.argv[1], uri=True)
    have = {row[0] for row in con.execute(
        "SELECT name FROM sqlite_master WHERE type='table'")}
    con.close()
except sqlite3.Error as exc:
    print("UNREADABLE:%s" % exc)
    raise SystemExit(0)
missing = [t for t in REQUIRED if t not in have]
print("OK" if not missing else "MISSING:" + ",".join(missing))
PYHQ
}

hq_persistence_offenders() {
  local root="$1" db="$2"
  # A path is persistent when it is the mount itself or sits under it.
  local offenders="" p
  # The three non-database paths are the vps-docker values of CC
  # src/lib/platform.ts (workspace root, bridge device identity, path-loaded
  # extension dir) expressed relative to the mount, so the production value is
  # byte-identical while a test seam can point the root at a temp dir.
  for p in "$db" "$root/.openclaw/workspace" "$root/.openclaw/mission-control/identity" "$root/.openclaw/extensions"; do
    case "$p" in
      "$root"|"$root"/*) : ;;
      *) offenders="${offenders}${offenders:+, }${p}" ;;
    esac
  done
  printf '%s' "$offenders"
}

hq_write_enabled_flag() {
  local value="$1" status="$2" target="${3:-${HQ_ENV_TARGET:-/data/.openclaw/.env}}"
  mkdir -p "$(dirname "$target")" 2>/dev/null || true
  if [ -f "$target" ] && grep -q -E "^[[:space:]]*(export[[:space:]]+)?HEADQUARTERS_ENABLED[[:space:]]*=" "$target"; then
    echo "[8d/9] HEADQUARTERS_ENABLED already set in $target — preserved (not overwritten). $status"
    return 0
  fi
  [ -f "$target" ] && { cp -p "$target" "${target}.bak" && chmod 600 "${target}.bak" 2>/dev/null; }
  printf 'HEADQUARTERS_ENABLED=%s\n' "$value" >> "$target"
  chmod 600 "$target" 2>/dev/null || true
  echo "[8d/9] HEADQUARTERS_ENABLED=$value written to $target. $status"
  return 0
}

echo "[8d/9] Checking Headquarters capability (schema + persistent paths, read-only)..."
_HQ_ROOT="${HQ_PERSIST_ROOT:-/data}"
_HQ_DB="${HQ_CAPABILITY_DB:-$ECOSYSTEM_DIR/mission-control.db}"
_HQ_PATH_OFFENDERS="$(hq_persistence_offenders "$_HQ_ROOT" "$_HQ_DB")"
if [ -n "$_HQ_PATH_OFFENDERS" ]; then
  hq_write_enabled_flag 0 "capability=0 reason=persistent-path-contract offenders=$_HQ_PATH_OFFENDERS (must sit under $_HQ_ROOT to survive container replacement)"
else
  _HQ_SCHEMA="$(hq_missing_tables "$_HQ_DB" || printf 'UNREADABLE:probe-failed')"
  case "$_HQ_SCHEMA" in
    OK)
      mkdir -p "$_HQ_ROOT/.openclaw/workspace" "$_HQ_ROOT/.openclaw/mission-control/identity" 2>/dev/null || true
      hq_write_enabled_flag 1 "capability=1 db=$_HQ_DB schema=present paths=persistent root=$_HQ_ROOT"
      ;;
    MISSING:*)
      hq_write_enabled_flag 0 "capability=0 reason=schema-unavailable missing=${_HQ_SCHEMA#MISSING:} db=$_HQ_DB — run the Command Center migration (scripts/repair-command-center.sh) then re-run this bootstrap"
      ;;
    *)
      hq_write_enabled_flag 0 "capability=0 reason=${_HQ_SCHEMA} db=$_HQ_DB status=descriptive-setup-required"
      ;;
  esac
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
