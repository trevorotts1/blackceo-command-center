#!/usr/bin/env bash
# watchdog-cc.sh — continuous crash detection via cc-health-check.sh (B.1).
# PRD Addendum B.1 (P0): MUST NOT implement its own green definition.
#
# EXIT CONTRACT:
#   exit 1 (definitive RED) → alert fired
#   exit 3 (UNKNOWN/transient) → logged as warn, NO alert (spec mandates this)
#   exit 0 (GREEN) → silent
#
# Schedule (crontab): */5 * * * *  /path/to/scripts/watchdog-cc.sh
# Env: WATCHDOG_PORT  WATCHDOG_CANONICAL_DIR  WATCHDOG_ALERT_LOG  WATCHDOG_ALERT_HOOK
#      WATCHDOG_SELF_HEAL   (default: 0 — set to 1 to enable self-healing on RED)
#
# PRES-045 / CC-H1 (refusal protection, this revision):
#
#   DEDUPE + RECOVERY: a RED verdict is an INCIDENT tracked in
#   WATCHDOG_STATE_DIR (default <CC root>/.cc-state). An incident key
#   (port + classification) is alerted ONCE into WATCHDOG_ALERT_LOG; repeated
#   RED passes update the state file but do not re-alert, and the recovery
#   pass (first GREEN after a RED) archives the incident and emits exactly one
#   RECOVERY line. Alerts can be deduplicated across restarts because the
#   state file is durable on disk.
#
#   STALE-BUILD REBUILD (the self-heal this script is allowed to do): a RED
#   caused by a cc-start.sh refusal receipt (deterministic stale-build, exit
#   78) is repaired by AT MOST ONE locked authorized atomic rebuild attempt —
#   `flock`-guarded, disk preflight (free space >= WATCHDOG_MIN_FREE_MB),
#   exponential backoff between attempts, and a single at-least-one-incident
#   cap stored in the state file. It NEVER restarts the unchanged build in a
#   loop, NEVER calls `pm2 delete all`, and NEVER touches the OpenClaw gateway
#   or any unrelated pm2 app. Only the canonical CC app name is ever deleted,
#   and only immediately before its own ecosystem-driven recreation.
#
#   The legacy zombie self-heal (duplicate/legacy-name convergence) is
#   RETAINED but hardened: it still clears only the three CC app names and
#   recreates the canonical one; `pm2 delete all` remains forbidden.
#
#   NEVER acts on exit 3 (UNKNOWN) — preserves the exit-3=no-action contract;
#   persistent-unknown escalation is produced by cc-health-check.sh itself
#   (it exits 1 with "persistent_unknown":true once the deadline passes), and
#   THOSE are alertable incidents with their own key.
#
#   NOTE: Never calls `openclaw gateway restart` — manages ONLY the CC process.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HEALTH_CHECK="${SCRIPT_DIR}/cc-health-check.sh"

WATCHDOG_PORT="${WATCHDOG_PORT:-4000}"
WATCHDOG_CANONICAL_DIR="${WATCHDOG_CANONICAL_DIR:-}"
WATCHDOG_ALERT_LOG="${WATCHDOG_ALERT_LOG:-/tmp/cc-watchdog-alerts.log}"
WATCHDOG_ALERT_HOOK="${WATCHDOG_ALERT_HOOK:-}"
WATCHDOG_SELF_HEAL="${WATCHDOG_SELF_HEAL:-0}"
# PRES-045: durable state dir for incident dedupe + recovery + rebuild lock.
CC_ROOT_DEFAULT="$(cd "$SCRIPT_DIR/.." && pwd)"
WATCHDOG_STATE_DIR="${WATCHDOG_STATE_DIR:-${CC_ROOT_DEFAULT}/.cc-state}"
WATCHDOG_MIN_FREE_MB="${WATCHDOG_MIN_FREE_MB:-2048}"
WATCHDOG_REBUILD_BACKOFF_BASE="${WATCHDOG_REBUILD_BACKOFF_BASE:-300}"
WATCHDOG_REBUILD_MAX_ATTEMPTS="${WATCHDOG_REBUILD_MAX_ATTEMPTS:-3}"
# Authorized rebuild command (overridable for tests). Default is the canonical
# atomic deploy; it must be a REBUILD, never a bare `pm2 start` of the same
# stale tree (CC-H1: "never repeatedly start the unchanged build").
WATCHDOG_REBUILD_CMD="${WATCHDOG_REBUILD_CMD:-bash scripts/atomic-deploy.sh}"

if [[ ! -x "$HEALTH_CHECK" ]]; then
  printf 'FATAL: cc-health-check.sh not found at %s\n' "$HEALTH_CHECK" >&2; exit 1
fi

mkdir -p "$WATCHDOG_STATE_DIR" 2>/dev/null || true
STATE_FILE="$WATCHDOG_STATE_DIR/incidents.json"
REBUILD_LOCK="$WATCHDOG_STATE_DIR/rebuild.lock"
REBUILD_STATE="$WATCHDOG_STATE_DIR/rebuild-state.json"

TS=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

# ── state helpers (durable, crash-tolerant; single-line JSON) ────────────────
state_get() {  # state_get FILE KEY DEFAULT
  python3 -s - "$1" "$2" "$3" <<'PYEOF'
import json, sys, os
path, key, default = sys.argv[1], sys.argv[2], sys.argv[3]
try:
    with open(path, 'r', encoding='utf-8') as fh:
        d = json.load(fh)
    v = d.get(key)
    print(v if v is not None else default)
except Exception:
    print(default)
PYEOF
}
state_set() {  # state_set FILE KEY VALUE
  python3 -s - "$1" "$2" "$3" <<'PYEOF'
import json, sys, os, tempfile
path, key, value = sys.argv[1], sys.argv[2], sys.argv[3]
d = {}
try:
    with open(path, 'r', encoding='utf-8') as fh:
        d = json.load(fh)
except Exception:
    d = {}
try:
    v = json.loads(value)
except Exception:
    v = value
d[key] = v
try:
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path) or '.', prefix='.inc-')
    with os.fdopen(fd, 'w', encoding='utf-8') as fh:
        json.dump(d, fh)
    os.replace(tmp, path)
except Exception:
    pass
PYEOF
}

# Classify this RED into a stable incident key from the health JSON.
classify_red() {
  python3 -s - "$1" <<'PYEOF'
import json, sys
try:
    d = json.loads(sys.argv[1])
except Exception:
    print("red:unparseable"); sys.exit(0)
detail = str(d.get('detail') or '')
refusal = d.get('refusal') or {}
if d.get('persistent_unknown'):
    print("persistent-unknown")
elif refusal.get('receipt_current') or (refusal.get('receipt_present') and refusal.get('service_status') in ('stopped', 'errored')):
    print("refusal-receipt")
elif d.get('service_status') in ('stopped', 'errored'):
    print("service-" + str(d.get('service_status')))
elif 'unreachable' in detail:
    print("unreachable")
elif d.get('pm2_topology', {}).get('app_count', 0) == 0:
    print("no-pm2-app")
else:
    print("red")
PYEOF
}

ARGS=(--port "$WATCHDOG_PORT" --json-only)
[[ -n "$WATCHDOG_CANONICAL_DIR" ]] && ARGS+=(--canonical-dir "$WATCHDOG_CANONICAL_DIR")

RESULT_JSON=""; RESULT_EXIT=0
RESULT_JSON=$(bash "$HEALTH_CHECK" "${ARGS[@]}") || RESULT_EXIT=$?

# ── GREEN: silence, but archive any open incident exactly once ────────────────
if [[ "$RESULT_EXIT" -eq 0 ]]; then
  OPEN="$(state_get "$STATE_FILE" open_incident '')"
  if [[ -n "$OPEN" ]]; then
    printf '[watchdog-cc] RECOVERY at %s — incident "%s" cleared (verified GREEN after RED)\n' "$TS" "$OPEN" >&2
    printf '{"watchdog_recovery":true,"timestamp":"%s","incident":"%s","port":%s}\n' "$TS" "$OPEN" "$WATCHDOG_PORT" >> "$WATCHDOG_ALERT_LOG"
    state_set "$STATE_FILE" open_incident ''
    # Refusal receipt resolution on verified recovery is the health check's
    # job (it verifies build digest + online state); the watchdog only
    # archives its own incident bookkeeping here.
  fi
  exit 0

# ── UNKNOWN/transient: log as WARN, NEVER alert (spec: must not treat exit 3
#    as definitive). Persistent-unknown escalation arrives as exit 1 instead.
elif [[ "$RESULT_EXIT" -eq 3 ]]; then
  printf '[watchdog-cc] WARN (transient/UNKNOWN) at %s — port %s — not alerting (exit 3)\n' "$TS" "$WATCHDOG_PORT" >&2
  exit 0

# ── Definitive RED — deduped alert + guarded actions ──────────────────────────
else
  KEY="$(classify_red "$RESULT_JSON")"
  PRIOR="$(state_get "$STATE_FILE" open_incident '')"

  if [[ "$PRIOR" == "$KEY" ]]; then
    printf '[watchdog-cc] RED at %s — port %s — incident "%s" already alerted (deduped, no new alert)\n' "$TS" "$WATCHDOG_PORT" "$KEY" >&2
  else
    ALERT="{\"watchdog_alert\":true,\"timestamp\":\"${TS}\",\"port\":${WATCHDOG_PORT},\"incident\":\"${KEY}\",\"result\":${RESULT_JSON}}"
    printf '%s\n' "$ALERT" >> "$WATCHDOG_ALERT_LOG"
    printf '[watchdog-cc] ALERT at %s — box on port %s is RED (definitive; incident: %s)\n' "$TS" "$WATCHDOG_PORT" "$KEY" >&2
    printf '%s\n' "$RESULT_JSON" >&2
    state_set "$STATE_FILE" open_incident "$KEY"
    state_set "$STATE_FILE" incident_opened_at "$TS"
  fi

  # ── STALE-BUILD REBUILD (opt-in, PRES-045) ─────────────────────────────────
  # Only for the refusal-receipt incident class, only when WATCHDOG_SELF_HEAL=1,
  # at most ONE in-flight locked attempt, disk preflight, backoff between
  # attempts, bounded total attempts. Never a bare restart of the stale tree.
  if [[ "$WATCHDOG_SELF_HEAL" == "1" && "$KEY" == "refusal-receipt" ]]; then
    ATTEMPTS=$(python3 -s -c "import json,sys;
try: print(int(json.load(open(sys.argv[1])).get('rebuild_attempts', 0)))
except Exception: print(0)" "$REBUILD_STATE" 2>/dev/null || echo 0)
    ATTEMPTS_OK=$(python3 -s -c "
import json, sys
try: print('yes' if int(json.load(open(sys.argv[1])).get('rebuild_attempts', 0)) < int(sys.argv[2]) else 'no')
except Exception: print('yes')" "$REBUILD_STATE" "$WATCHDOG_REBUILD_MAX_ATTEMPTS" 2>/dev/null || echo yes)
    # Backoff: attempts are spaced WATCHDOG_REBUILD_BACKOFF_BASE * 2^(n-1)
    # seconds apart (capped 24h), measured from the last recorded attempt.
    DUE=$(python3 -s -c "
import sys, datetime, json
def _parse_ts(ts):
    s = (ts or '').strip()
    if not s:
        raise ValueError('empty timestamp')
    if s.endswith('Z'):
        s = s[:-1] + '+00:00'
    dt = datetime.datetime.fromisoformat(s)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=datetime.timezone.utc)
    return dt
try:
    with open(sys.argv[1]) as fh: d = json.load(fh)
    n = int(d.get('rebuild_attempts', 0))
    if n == 0: print('yes'); sys.exit(0)
    dt = _parse_ts(d.get('last_rebuild_at', ''))
    age = int((datetime.datetime.now(datetime.timezone.utc) - dt).total_seconds())
    base = int(sys.argv[2])
    backoff = min(base * (2 ** (n - 1)), 86400)
    print('yes' if age >= backoff else 'no')
except Exception:
    print('yes')" "$REBUILD_STATE" "$WATCHDOG_REBUILD_BACKOFF_BASE" 2>/dev/null || echo yes)

    if [[ "$ATTEMPTS_OK" != "yes" ]]; then
      printf '[watchdog-cc] REBUILD: attempt cap %s reached — no further automatic rebuilds for this incident; human review required\n' "$WATCHDOG_REBUILD_MAX_ATTEMPTS" >&2
    elif [[ "$DUE" != "yes" ]]; then
      printf '[watchdog-cc] REBUILD: backoff window not yet elapsed — no rebuild this pass\n' >&2
    fi

    if [[ "$DUE" == "yes" && "$ATTEMPTS_OK" == "yes" ]]; then
      CC_DIR="${WATCHDOG_CANONICAL_DIR:-$CC_ROOT_DEFAULT}"
      if [[ -f "$CC_DIR/ecosystem.config.cjs" || -f "$CC_DIR/scripts/atomic-deploy.sh" ]]; then
        # DISK PREFLIGHT: never start a rebuild onto a full disk — a failed
        # build directory would destroy the only good artifact.
        FREE_MB=$(df -Pm "$CC_DIR" 2>/dev/null | awk 'NR==2{print $4}')
        if [[ -n "$FREE_MB" && "$FREE_MB" =~ ^[0-9]+$ ]] && [[ "$FREE_MB" -lt "$WATCHDOG_MIN_FREE_MB" ]]; then
          printf '[watchdog-cc] REBUILD REFUSED: only %sMB free on %s (min %sMB) — disk preflight failed, manual intervention required\n' "$FREE_MB" "$CC_DIR" "$WATCHDOG_MIN_FREE_MB" >&2
        else
          # LOCK: at most ONE rebuild in flight fleet-wide. mkdir-lock — atomic
          # on every POSIX filesystem (macOS bash 3.2 has no flock(1)); a stale
          # lock older than 30 minutes is broken (a crashed rebuild must not
          # wedge the watchdog forever).
          if ! mkdir "$REBUILD_LOCK" 2>/dev/null; then
            LOCK_AGE=$(python3 -s -c "
import os, sys, time
try:
    p = sys.argv[1]
    age = time.time() - os.stat(p).st_mtime
    print(int(age))
except Exception:
    print(0)" "$REBUILD_LOCK" 2>/dev/null || echo 0)
            if [[ "$LOCK_AGE" -gt 1800 ]]; then
              rmdir "$REBUILD_LOCK" 2>/dev/null || true
              mkdir "$REBUILD_LOCK" 2>/dev/null || { printf '[watchdog-cc] REBUILD: another attempt holds the lock (stale lock could not be broken)\n' >&2; LOCKED=1; }
            else
              printf '[watchdog-cc] REBUILD: another attempt holds the lock — skipping (one rebuild at a time)\n' >&2
              LOCKED=1
            fi
          fi
          if [[ "${LOCKED:-0}" != "1" ]]; then
            # Re-check attempts INSIDE the lock (another cron pass may have won).
            IN_ATTEMPTS=$(python3 -s -c "import json,sys
try: print(int(json.load(open(sys.argv[1])).get('rebuild_attempts', 0)))
except Exception: print(0)" "$REBUILD_STATE" 2>/dev/null || echo 0)
            IN_OK=$(python3 -s -c "
import json, sys
try: print('yes' if int(json.load(open(sys.argv[1])).get('rebuild_attempts', 0)) < int(sys.argv[2]) else 'no')
except Exception: print('yes')" "$REBUILD_STATE" "$WATCHDOG_REBUILD_MAX_ATTEMPTS" 2>/dev/null || echo yes)
            if [[ "$IN_OK" != "yes" ]]; then
              printf '[watchdog-cc] REBUILD: attempt cap %s reached inside lock — not rebuilding (one authorized attempt window per incident, then human)\n' "$WATCHDOG_REBUILD_MAX_ATTEMPTS" >&2
              rmdir "$REBUILD_LOCK" 2>/dev/null || true
            else
              NOW=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
              state_set "$REBUILD_STATE" rebuild_attempts "$((IN_ATTEMPTS + 1))"
              state_set "$REBUILD_STATE" last_rebuild_at "$NOW"
              state_set "$REBUILD_STATE" rebuild_incident "$KEY"
              printf '[watchdog-cc] REBUILD: authorized atomic rebuild attempt %s/%s starting (locked, disk preflight passed: %sMB free)\n' "$((IN_ATTEMPTS + 1))" "$WATCHDOG_REBUILD_MAX_ATTEMPTS" "${FREE_MB:-?}" >&2
              (
                cd "$CC_DIR" || exit 1
                bash -c "$WATCHDOG_REBUILD_CMD"
              ) >> "$WATCHDOG_STATE_DIR/rebuild.log" 2>&1 || \
                printf '[watchdog-cc] REBUILD: attempt %s FAILED (see %s/rebuild.log) — no further automatic attempts until backoff window; human review after cap\n' "$((IN_ATTEMPTS + 1))" "$WATCHDOG_STATE_DIR" >&2
              rmdir "$REBUILD_LOCK" 2>/dev/null || true
            fi
          fi
        fi
      else
        printf '[watchdog-cc] REBUILD skipped: cannot locate CC install (ecosystem/atomic-deploy) at %s\n' "$CC_DIR" >&2
      fi
    fi
  fi

  # ── Legacy zombie self-heal (RETAINED, hardened) ────────────────────────────
  # Only runs when WATCHDOG_SELF_HEAL=1 AND the failure pattern indicates a
  # zombie/orphan/crash-loop that cc-start.sh can resolve.
  # NEVER triggers on exit 3 (guarded above) — preserves the no-action contract.
  # HARDENING (PRES-045): never `pm2 delete all`; only the three CC app names
  # are ever deleted, only before their own recreation; refusal-receipt REDs
  # are handled by the REBUILD path above, not by a bare `pm2 start` of the
  # same stale tree.
  if [[ "$WATCHDOG_SELF_HEAL" == "1" && "$KEY" != "refusal-receipt" ]]; then
    HEAL_TRIGGER=0
    if printf '%s' "$RESULT_JSON" | grep -q '"app_count":[2-9]'; then
      HEAL_TRIGGER=1
      printf '[watchdog-cc] SELF-HEAL trigger: zombie detected (app_count>1)\n' >&2
    fi
    if printf '%s' "$RESULT_JSON" | grep -q '"crash_looper":true'; then
      HEAL_TRIGGER=1
      printf '[watchdog-cc] SELF-HEAL trigger: crash_looper=true in health report\n' >&2
    fi
    if printf '%s' "$RESULT_JSON" | grep -qi 'EADDRINUSE'; then
      HEAL_TRIGGER=1
      printf '[watchdog-cc] SELF-HEAL trigger: EADDRINUSE detected in health report\n' >&2
    fi

    if [[ "$HEAL_TRIGGER" -eq 1 ]]; then
      printf '[watchdog-cc] SELF-HEAL: converging PM2 app names + restarting via canonical ecosystem\n' >&2
      CC_DIR="${WATCHDOG_CANONICAL_DIR:-}"
      if [[ -z "$CC_DIR" ]]; then
        for d in "$HOME/projects/command-center" "/data/projects/command-center"; do
          if [[ -f "$d/ecosystem.config.cjs" ]]; then
            CC_DIR="$d"
            break
          fi
        done
      fi

      if [[ -z "$CC_DIR" || ! -f "$CC_DIR/ecosystem.config.cjs" ]]; then
        printf '[watchdog-cc] SELF-HEAL skipped: cannot locate ecosystem.config.cjs\n' >&2
      else
        # Clear ONLY the known CC pm2 app names (canonical + legacy aliases) so
        # a zombie duplicate or a stray legacy "mission-control" cannot survive;
        # the ecosystem start below then recreates the single canonical
        # "blackceo-command-center". DELIBERATELY scoped: `pm2 delete all` is
        # FORBIDDEN — other apps on this box (gateways, workers) are never
        # touched. Each name is deleted only because it is about to be
        # recreated by the ecosystem start below.
        for name in blackceo-command-center command-center mission-control; do
          pm2 delete "$name" >/dev/null 2>&1 && \
            printf '[watchdog-cc] SELF-HEAL: deleted pm2 app "%s" (canonical recreation follows)\n' "$name" >&2 || true
        done

        CC_PORT="$WATCHDOG_PORT" pm2 start "$CC_DIR/ecosystem.config.cjs" && \
          printf '[watchdog-cc] SELF-HEAL: pm2 start ecosystem.config.cjs OK\n' >&2 || \
          printf '[watchdog-cc] SELF-HEAL: pm2 start failed — manual intervention required\n' >&2

        pm2 save >/dev/null 2>&1 || true
        printf '[watchdog-cc] SELF-HEAL: complete at %s\n' "$TS" >&2
      fi
    else
      printf '[watchdog-cc] SELF-HEAL enabled but no zombie/orphan/EADDRINUSE pattern — not self-healing\n' >&2
    fi
  fi
  # ── END SELF-HEAL ────────────────────────────────────────────────────────────

  if [[ -n "$WATCHDOG_ALERT_HOOK" && -x "$WATCHDOG_ALERT_HOOK" ]]; then
    printf '%s\n' "$RESULT_JSON" | bash "$WATCHDOG_ALERT_HOOK" || true
  fi
  exit 1
fi
