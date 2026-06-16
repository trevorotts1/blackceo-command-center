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
# SELF-HEAL MODE (WATCHDOG_SELF_HEAL=1):
#   On a definitive RED where the PM2 topology shows a zombie (app_count>1),
#   a crash_looper, or EADDRINUSE in recent pm2 logs, the watchdog:
#     1. Kills all legacy-named CC apps (blackceo-command-center, command-center)
#     2. Invokes the canonical cc-start.sh orphan-port killer (via ecosystem restart)
#     3. Restarts via pm2 start ecosystem.config.cjs
#   NEVER acts on exit 3 (UNKNOWN) — preserves the exit-3=no-action contract.
#   NOTE: Never calls `openclaw gateway restart` — manages ONLY the CC process.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HEALTH_CHECK="${SCRIPT_DIR}/cc-health-check.sh"

WATCHDOG_PORT="${WATCHDOG_PORT:-4000}"
WATCHDOG_CANONICAL_DIR="${WATCHDOG_CANONICAL_DIR:-}"
WATCHDOG_ALERT_LOG="${WATCHDOG_ALERT_LOG:-/tmp/cc-watchdog-alerts.log}"
WATCHDOG_ALERT_HOOK="${WATCHDOG_ALERT_HOOK:-}"
WATCHDOG_SELF_HEAL="${WATCHDOG_SELF_HEAL:-0}"

if [[ ! -x "$HEALTH_CHECK" ]]; then
  printf 'FATAL: cc-health-check.sh not found at %s\n' "$HEALTH_CHECK" >&2; exit 1
fi

ARGS=(--port "$WATCHDOG_PORT" --json-only)
[[ -n "$WATCHDOG_CANONICAL_DIR" ]] && ARGS+=(--canonical-dir "$WATCHDOG_CANONICAL_DIR")

RESULT_JSON=""; RESULT_EXIT=0
RESULT_JSON=$(bash "$HEALTH_CHECK" "${ARGS[@]}") || RESULT_EXIT=$?
TS=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

if [[ "$RESULT_EXIT" -eq 0 ]]; then
  exit 0  # GREEN — silent

elif [[ "$RESULT_EXIT" -eq 3 ]]; then
  # UNKNOWN/transient — log as WARN, NEVER alert (spec: must not treat exit 3 as definitive)
  # NEVER self-heal on exit 3 — preserves the no-action contract for transient states.
  printf '[watchdog-cc] WARN (transient/UNKNOWN) at %s — port %s — not alerting (exit 3)\n' "$TS" "$WATCHDOG_PORT" >&2
  exit 0  # do not propagate as failure

else
  # Exit 1 = definitive RED — alert
  ALERT="{\"watchdog_alert\":true,\"timestamp\":\"${TS}\",\"port\":${WATCHDOG_PORT},\"result\":${RESULT_JSON}}"
  printf '%s\n' "$ALERT" >> "$WATCHDOG_ALERT_LOG"
  printf '[watchdog-cc] ALERT at %s — box on port %s is RED (definitive)\n' "$TS" "$WATCHDOG_PORT" >&2
  printf '%s\n' "$RESULT_JSON" >&2

  # ── SELF-HEAL (opt-in) ───────────────────────────────────────────────────────
  # Only runs when WATCHDOG_SELF_HEAL=1 AND the failure pattern indicates a
  # zombie/orphan/crash-loop that cc-start.sh can resolve.
  # NEVER triggers on exit 3 (guarded above) — preserves the no-action contract.
  if [[ "$WATCHDOG_SELF_HEAL" == "1" ]]; then
    # Detect zombie/orphan/crash-loop indicators in the health JSON.
    HEAL_TRIGGER=0
    # app_count > 1 = zombie duplicate (two CC apps fighting for the port)
    if printf '%s' "$RESULT_JSON" | grep -q '"app_count":[2-9]'; then
      HEAL_TRIGGER=1
      printf '[watchdog-cc] SELF-HEAL trigger: zombie detected (app_count>1)\n' >&2
    fi
    # crash_looper flag in health JSON
    if printf '%s' "$RESULT_JSON" | grep -q '"crash_looper":true'; then
      HEAL_TRIGGER=1
      printf '[watchdog-cc] SELF-HEAL trigger: crash_looper=true in health report\n' >&2
    fi
    # EADDRINUSE in pm2 log snippet (if health check embeds log lines)
    if printf '%s' "$RESULT_JSON" | grep -qi 'EADDRINUSE'; then
      HEAL_TRIGGER=1
      printf '[watchdog-cc] SELF-HEAL trigger: EADDRINUSE detected in health report\n' >&2
    fi

    if [[ "$HEAL_TRIGGER" -eq 1 ]]; then
      printf '[watchdog-cc] SELF-HEAL: converging PM2 app names + restarting via canonical ecosystem\n' >&2
      # Determine the CC install dir: prefer WATCHDOG_CANONICAL_DIR, else try common paths.
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
        # Kill all legacy-named CC apps so duplicate/orphan names are cleared.
        for name in blackceo-command-center command-center mission-control; do
          pm2 delete "$name" >/dev/null 2>&1 && \
            printf '[watchdog-cc] SELF-HEAL: deleted pm2 app "%s"\n' "$name" >&2 || true
        done

        # Start via the canonical hardened ecosystem (which delegates to cc-start.sh
        # for the orphan-port kill + env-bleed strip).
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
