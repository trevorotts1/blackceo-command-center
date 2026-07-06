#!/usr/bin/env bash
#
# Command Center Demo Pack — one-command reset (~15-20s).
#
#   bash scripts/demo/reset-demo.sh [--profile interview|dashboard|all] [--fixture harbor-oak]
#
# Rewinds the demo to a pristine, photogenic state for the next prospect:
#   1. pm2-stop the demo apps + simulator BY NAME ALLOWLIST (never the real CC).
#   2. Wipe the demo SQLite DB(s) (+ -wal/-shm) and the demo workspace + company-root.
#   3. Reseed from the JSON fixture (DB content + workspace files + config/*.json).
#   4. ROTATE MC_INTERVIEW_COOKIE_SECRET so any prospect's completed-interview
#      cookie fails CLOSED back to a pristine /interview.
#   5. Restart the demo apps and health-verify (PASS/FAIL, per-check, no false done).
#
# Isolation: only ever acts on the demo app names + the demo data root; the real
# Command Center process and the operator's real workspace are never touched.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
source "$HERE/demo.config.sh"

PROFILE="all"
FIXTURE="harbor-oak"
while [ $# -gt 0 ]; do
  case "$1" in
    --profile) PROFILE="${2:-all}"; shift 2 ;;
    --fixture) FIXTURE="${2:-harbor-oak}"; shift 2 ;;
    *) echo "reset-demo: unknown arg '$1'"; exit 2 ;;
  esac
done
case "$PROFILE" in interview|dashboard|all) : ;; *) echo "reset-demo: --profile must be interview|dashboard|all"; exit 2 ;; esac

PROFILES=()
[ "$PROFILE" = "all" ] && PROFILES=(interview dashboard) || PROFILES=("$PROFILE")

log() { printf '  %s\n' "$*"; }
hr()  { printf '%s\n' "──────────────────────────────────────────────────────────"; }

# Defensive assertion: no demo app name may collide with a forbidden (real) name.
for a in "${DEMO_APPS[@]}"; do
  for f in "${FORBIDDEN_APPS[@]}"; do
    if [ "$a" = "$f" ]; then echo "reset-demo: FATAL — demo app '$a' collides with a protected name. Aborting."; exit 1; fi
  done
done

hr; echo "Command Center Demo — reset (profile=$PROFILE, fixture=$FIXTURE)"; hr
echo "repo:  $DEMO_REPO"
echo "data:  $DEMO_DATA_ROOT"
hr

PM2="pm2"
command -v pm2 >/dev/null 2>&1 || PM2="npx --yes pm2"

# 1. Stop demo apps by allowlist (never the real CC).
echo "[1/5] Stopping demo apps (allowlist only)..."
for a in "${DEMO_APPS[@]}"; do
  $PM2 stop "$a" >/dev/null 2>&1 && log "stopped $a" || log "not running: $a"
done

# 2 + 3 + 4. Per-profile wipe → reseed → rotate cookie secret.
mkdir -p "$DEMO_HOME"
for p in "${PROFILES[@]}"; do
  DIR="$DEMO_DATA_ROOT/$p"
  echo "[2/5] Wiping $p data..."
  rm -f "$DIR/mission-control.db" "$DIR/mission-control.db-wal" "$DIR/mission-control.db-shm"
  rm -rf "$DIR/workspace" "$DIR/company-root"
  mkdir -p "$DIR/workspace" "$DIR/company-root"

  echo "[3/5] Reseeding $p from fixture '$FIXTURE'..."
  ( cd "$DEMO_REPO" && $TSX scripts/demo/seed-demo.ts \
      --profile "$p" --fixture "$FIXTURE" --repo-root "$DEMO_REPO" \
      --db "$DIR/mission-control.db" \
      --workspace "$DIR/workspace" \
      --company-root "$DIR/company-root" \
      --config-dir "$DEMO_REPO/config" \
      --home "$DEMO_HOME" ) 2>&1 | grep -E "computed company health|FAILED|Error" | sed 's/^/    /'
  if [ ! -f "$DIR/mission-control.db" ]; then echo "reset-demo: FATAL — seed did not produce $DIR/mission-control.db"; exit 1; fi

  echo "[4/5] Rotating cookie secret for $p..."
  head -c 24 /dev/urandom | xxd -p | tr -d '\n' > "$DIR/cookie-secret"
  log "rotated MC_INTERVIEW_COOKIE_SECRET (completed cookies now fail closed)"
done

# 5. Restart (fresh env + rotated secret) then health-verify.
echo "[5/5] Restarting demo apps..."
ONLY="$APP_INTERVIEW,$APP_DASHBOARD"
for a in "${DEMO_APPS[@]}"; do $PM2 delete "$a" >/dev/null 2>&1 || true; done
DEMO_REPO="$DEMO_REPO" DEMO_DATA_ROOT="$DEMO_DATA_ROOT" $PM2 start "$ECOSYSTEM" --only "$ONLY" --update-env >/dev/null 2>&1 \
  && log "started $ONLY" || { echo "reset-demo: FATAL — pm2 start failed"; exit 1; }

verify_instance() {
  local name="$1" port="$2" seeded_path="$3" seeded_match="$4"
  local base="http://127.0.0.1:$port"
  local ok_health=0 ok_seed=0
  for _ in $(seq 1 40); do
    local h; h="$(curl -fsS --max-time 3 "$base/api/health" 2>/dev/null)"
    if printf '%s' "$h" | grep -qE '"status":"(ok|degraded)"'; then ok_health=1; break; fi
    sleep 1
  done
  for _ in $(seq 1 20); do
    # Origin matches the host so the middleware treats the probe as a same-origin
    # browser request (the interview instance fail-closes EXTERNAL /api/* callers
    # because it carries no MC_API_TOKEN — by design; the browser is same-origin).
    local s; s="$(curl -fsS --max-time 4 -H "Origin: $base" "$base$seeded_path" 2>/dev/null)"
    if printf '%s' "$s" | grep -q "$seeded_match"; then ok_seed=1; break; fi
    sleep 1
  done
  local health_ok=""; [ "$ok_health" = 1 ] && health_ok="PASS" || health_ok="FAIL"
  local seed_ok="";   [ "$ok_seed" = 1 ]   && seed_ok="PASS"   || seed_ok="FAIL"
  printf '    %-30s health=%s  seeded-read=%s\n' "$name ($base)" "$health_ok" "$seed_ok"
  [ "$ok_health" = 1 ] && [ "$ok_seed" = 1 ]
}

hr; echo "Health verification"; hr
RC=0
if printf '%s\n' "${PROFILES[@]}" | grep -qx interview; then
  verify_instance "$APP_INTERVIEW" "$INTERVIEW_PORT" "/api/interview/canonical-departments" '"floor":28' || RC=1
fi
if printf '%s\n' "${PROFILES[@]}" | grep -qx dashboard; then
  verify_instance "$APP_DASHBOARD" "$DASHBOARD_PORT" "/api/company-health" '"grade"' || RC=1
fi
hr
if [ "$RC" = 0 ]; then
  echo "RESET: PASS — demo is pristine and healthy."
  echo "  interview:  http://127.0.0.1:$INTERVIEW_PORT/interview"
  echo "  dashboard:  http://127.0.0.1:$DASHBOARD_PORT/"
else
  echo "RESET: FAIL — see the per-check lines above."
fi
hr
exit "$RC"
