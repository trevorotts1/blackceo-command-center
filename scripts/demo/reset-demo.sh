#!/usr/bin/env bash
# scripts/demo/reset-demo.sh — Command Center Demo Pack one-command reset (SPEC §6)
#
# Wipes + reseeds the demo instance(s), rotates the interview cookie secret, and
# restarts the demo web apps via the demo ecosystem — in ~15–20s (build already
# done; this is seed+restart only). Independent PASS/FAIL verification at the end;
# exit non-zero on any FAIL (no false "done").
#
# Usage:
#   bash scripts/demo/reset-demo.sh [--profile interview|dashboard|all] [--fixture harbor-oak]
#                                   [--data <DEMO_DATA_ROOT override>] [--dry-run] [--self-test]
#   default: --profile all --fixture harbor-oak
#
# HARD SAFETY GUARDS (never touch the real CC):
#   • App allowlist is EXACTLY the 3 demo names. reset only ever stop/deletes
#     those. It NEVER runs `pm2 stop/delete/restart all`, and it explicitly
#     refuses the real CC names (`cc-prod` on :4000 here; `blackceo-command-center`
#     fleet-canonical).
#   • DEMO_DATA_ROOT must resolve UNDER $REPO/scripts/demo/.runtime unless an
#     explicit --data override is given (and even then a critical-path denylist
#     applies). rm only ever happens strictly inside the validated root.

set -euo pipefail

# ── Locate repo + runtime ──────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$SCRIPT_DIR/../.." && pwd)"
SANDBOX_ROOT="$REPO/scripts/demo/.runtime"
ECO="$REPO/scripts/demo/demo.ecosystem.config.cjs"
SEEDER="scripts/demo/seed-demo.ts" # invoked relative to $REPO

# ── App allow / forbid lists ───────────────────────────────────────────────────
DEMO_APP_ALLOWLIST=(
  blackceo-cc-demo-interview
  blackceo-cc-demo-dashboard
  blackceo-cc-demo-simulator
)
# Names this script must NEVER signal, even if asked. Belt-and-suspenders on top
# of the positive allowlist. `cc-prod` is the REAL CC on THIS box (port 4000);
# `blackceo-command-center` is the fleet-canonical real-CC name.
FORBIDDEN_APPS=(
  cc-prod
  blackceo-command-center
  mission-control
)

INTERVIEW_APP=blackceo-cc-demo-interview
DASHBOARD_APP=blackceo-cc-demo-dashboard
SIMULATOR_APP=blackceo-cc-demo-simulator

INTERVIEW_PORT=4600
DASHBOARD_PORT=4601

# ── CLI ────────────────────────────────────────────────────────────────────────
PROFILE=all
FIXTURE=harbor-oak
DATA_OVERRIDE=""
DRY_RUN=0
SELF_TEST=0

while [ $# -gt 0 ]; do
  case "$1" in
    --profile) PROFILE="${2:-}"; shift 2 ;;
    --profile=*) PROFILE="${1#--profile=}"; shift ;;
    --fixture) FIXTURE="${2:-}"; shift 2 ;;
    --fixture=*) FIXTURE="${1#--fixture=}"; shift ;;
    --data) DATA_OVERRIDE="${2:-}"; shift 2 ;;
    --data=*) DATA_OVERRIDE="${1#--data=}"; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    --self-test) SELF_TEST=1; shift ;;
    -h|--help) sed -n '1,32p' "$0"; exit 0 ;;
    *) echo "reset-demo: unknown arg: $1" >&2; exit 2 ;;
  esac
done

case "$PROFILE" in
  interview|dashboard|all) : ;;
  *) echo "reset-demo: --profile must be interview|dashboard|all (got '$PROFILE')" >&2; exit 2 ;;
esac
if [ "$FIXTURE" != "harbor-oak" ]; then
  echo "reset-demo: --fixture must be harbor-oak (got '$FIXTURE')" >&2; exit 2
fi

# ── Path helper: canonicalize without requiring existence (python3 realpath) ───
_abspath() {
  python3 -c 'import os,sys;print(os.path.realpath(sys.argv[1]))' "$1"
}

# ── GUARD PREDICATES (pure — no side effects; unit-testable via --self-test) ───

# _is_allowed_app <name>  → 0 if in the demo allowlist AND not forbidden.
_is_allowed_app() {
  local name="$1" a
  for a in "${FORBIDDEN_APPS[@]}"; do
    [ "$name" = "$a" ] && return 1
  done
  for a in "${DEMO_APP_ALLOWLIST[@]}"; do
    [ "$name" = "$a" ] && return 0
  done
  return 1
}

# _is_path_in_sandbox <path> <sandbox>  → 0 if <path> == sandbox or a descendant.
_is_path_in_sandbox() {
  local p sp
  p="$(_abspath "$1")"
  sp="$(_abspath "$2")"
  [ "$p" = "$sp" ] || case "$p" in "$sp"/*) return 0 ;; *) return 1 ;; esac
}

# _is_critical_path <path>  → 0 (TRUE, refuse) if the path is a catastrophic rm
# target. Used to sanity-check an explicit --data override.
_is_critical_path() {
  local p
  p="$(_abspath "$1")"
  case "$p" in
    / | /Users | /Users/* ) # allow deep user paths only if >=4 segments below /
      # count segments
      local segs; segs="$(printf '%s' "$p" | awk -F/ '{print NF-1}')"
      [ "$p" = "/" ] && return 0
      [ "$p" = "/Users" ] && return 0
      # /Users/<home> (2 segs) is critical; require deeper
      [ "$segs" -lt 4 ] && return 0
      ;;
  esac
  case "$p" in
    /etc|/etc/*|/var|/usr|/bin|/sbin|/System|/System/*|/Library|/Applications|/opt|/opt/homebrew|"$HOME"|"$REPO") return 0 ;;
  esac
  return 1
}

# assert_guards — validates the effective app targets + DEMO_DATA_ROOT. Refuses
# (exit non-zero via caller) on any violation. Honors a test seam:
#   RESET_DEMO_TEST_INJECT_APP — appends a bogus app to the checked set so the
#   app-guard refusal path is provable without touching pm2.
assert_guards() {
  local ddr="$1" ok=1

  # (a) App guard — every app we would touch must be allowlisted + non-forbidden.
  local apps_to_check=("${DEMO_APP_ALLOWLIST[@]}")
  if [ -n "${RESET_DEMO_TEST_INJECT_APP:-}" ]; then
    apps_to_check+=("$RESET_DEMO_TEST_INJECT_APP")
  fi
  local app
  for app in "${apps_to_check[@]}"; do
    if ! _is_allowed_app "$app"; then
      echo "GUARD REFUSED: app '$app' is not in the demo allowlist (or is a forbidden real-CC name)." >&2
      ok=0
    fi
  done

  # (b) Path guard.
  if [ -n "$DATA_OVERRIDE" ]; then
    # Explicit override: must be absolute + not a catastrophic path.
    case "$ddr" in
      /*) : ;;
      *) echo "GUARD REFUSED: --data override must be an absolute path (got '$ddr')." >&2; ok=0 ;;
    esac
    if _is_critical_path "$ddr"; then
      echo "GUARD REFUSED: --data override '$ddr' resolves to a critical/system path — refusing to rm there." >&2
      ok=0
    fi
  else
    # No override: DEMO_DATA_ROOT MUST be under the sandbox.
    if ! _is_path_in_sandbox "$ddr" "$SANDBOX_ROOT"; then
      echo "GUARD REFUSED: DEMO_DATA_ROOT '$ddr' is not under the sandbox '$SANDBOX_ROOT' and no --data override was given." >&2
      ok=0
    fi
  fi

  [ "$ok" -eq 1 ] || return 1
  return 0
}

# ── SELF-TEST: prove the guard predicates without touching pm2/rm/reseed ───────
run_self_test() {
  local fails=0
  _expect() { # <desc> <expected 0|1> <actual rc>
    if [ "$2" -eq "$3" ]; then
      echo "  PASS  $1"
    else
      echo "  FAIL  $1 (expected rc=$2 got rc=$3)"
      fails=$((fails+1))
    fi
  }
  echo "[self-test] app allowlist predicate"
  _is_allowed_app blackceo-cc-demo-interview; _expect "allow demo-interview" 0 $?
  _is_allowed_app blackceo-cc-demo-dashboard; _expect "allow demo-dashboard" 0 $?
  _is_allowed_app blackceo-cc-demo-simulator; _expect "allow demo-simulator" 0 $?
  _is_allowed_app cc-prod; _expect "REFUSE cc-prod (real CC :4000)" 1 $?
  _is_allowed_app blackceo-command-center; _expect "REFUSE blackceo-command-center" 1 $?
  _is_allowed_app some-random-app; _expect "REFUSE random app" 1 $?

  echo "[self-test] sandbox path predicate (sandbox=$SANDBOX_ROOT)"
  _is_path_in_sandbox "$SANDBOX_ROOT" "$SANDBOX_ROOT"; _expect "sandbox root itself" 0 $?
  _is_path_in_sandbox "$SANDBOX_ROOT/interview" "$SANDBOX_ROOT"; _expect "descendant" 0 $?
  _is_path_in_sandbox "/tmp/evil-demo" "$SANDBOX_ROOT"; _expect "REFUSE /tmp/evil-demo" 1 $?
  _is_path_in_sandbox "$SANDBOX_ROOT/../../../etc" "$SANDBOX_ROOT"; _expect "REFUSE ../ escape" 1 $?

  echo "[self-test] critical-path predicate"
  _is_critical_path "/"; _expect "/ is critical" 0 $?
  _is_critical_path "$HOME"; _expect "\$HOME is critical" 0 $?
  _is_critical_path "$REPO"; _expect "\$REPO is critical" 0 $?
  _is_critical_path "/etc"; _expect "/etc is critical" 0 $?
  _is_critical_path "$SANDBOX_ROOT/dashboard"; _expect "sandbox child NOT critical" 1 $?

  echo "[self-test] assert_guards refusal on injected forbidden app"
  ( RESET_DEMO_TEST_INJECT_APP=cc-prod assert_guards "$SANDBOX_ROOT" >/dev/null 2>&1 ); _expect "REFUSE injected cc-prod" 1 $?
  echo "[self-test] assert_guards refusal on out-of-sandbox DEMO_DATA_ROOT"
  ( DATA_OVERRIDE="" assert_guards "/tmp/evil-demo" >/dev/null 2>&1 ); _expect "REFUSE /tmp/evil-demo root" 1 $?
  echo "[self-test] assert_guards PASS on default sandbox"
  ( assert_guards "$SANDBOX_ROOT" >/dev/null 2>&1 ); _expect "ALLOW default sandbox" 0 $?

  echo
  if [ "$fails" -eq 0 ]; then
    echo "[self-test] ALL GUARD CHECKS PASSED"
    return 0
  fi
  echo "[self-test] $fails GUARD CHECK(S) FAILED"
  return 1
}

if [ "$SELF_TEST" -eq 1 ]; then
  run_self_test
  exit $?
fi

# ── Resolve DEMO_DATA_ROOT ──────────────────────────────────────────────────────
if [ -n "$DATA_OVERRIDE" ]; then
  DEMO_DATA_ROOT="$DATA_OVERRIDE"
else
  DEMO_DATA_ROOT="${DEMO_DATA_ROOT:-$SANDBOX_ROOT}"
fi

# ── Enforce guards BEFORE any mutation ─────────────────────────────────────────
if ! assert_guards "$DEMO_DATA_ROOT"; then
  echo "reset-demo: guards refused — aborting before any change." >&2
  exit 3
fi

# Validated absolute root (all rm targets must live strictly under this).
DDR="$(_abspath "$DEMO_DATA_ROOT")"

# Profiles to (re)build → the web apps to start.
PROFILES=()
WEB_APPS=()
case "$PROFILE" in
  interview) PROFILES=(interview); WEB_APPS=("$INTERVIEW_APP") ;;
  dashboard) PROFILES=(dashboard); WEB_APPS=("$DASHBOARD_APP") ;;
  all) PROFILES=(interview dashboard); WEB_APPS=("$INTERVIEW_APP" "$DASHBOARD_APP") ;;
esac

echo "==> Command Center Demo reset"
echo "    REPO           = $REPO"
echo "    DEMO_DATA_ROOT = $DDR"
echo "    profile(s)     = ${PROFILES[*]}"
echo "    fixture        = $FIXTURE"
echo "    web app(s)     = ${WEB_APPS[*]}"

# ── DRY-RUN: guards + plan only, no mutation ───────────────────────────────────
if [ "$DRY_RUN" -eq 1 ]; then
  echo
  echo "[dry-run] guards PASSED. Would perform, in order:"
  echo "  1. pm2 stop+delete (allowlist only): ${DEMO_APP_ALLOWLIST[*]}"
  for p in "${PROFILES[@]}"; do
    echo "  2. rm -rf $DDR/$p/mission-control.db{,-wal,-shm} and $DDR/$p/workspace"
  done
  echo "  3. openssl rand -hex 32 > $DDR/cookie-secret.txt"
  for p in "${PROFILES[@]}"; do
    echo "  4. npx tsx $SEEDER --profile $p --fixture $FIXTURE --db $DDR/$p/mission-control.db --workspace $DDR/$p/workspace"
  done
  echo "  5. pm2 start $ECO --only $(IFS=,; echo "${WEB_APPS[*]}") --update-env"
  echo "  6. poll /api/health per port + one seeded read; PASS/FAIL summary"
  echo "[dry-run] no pm2/rm/seed actions were taken."
  exit 0
fi

# ── Preconditions for the real run ─────────────────────────────────────────────
command -v pm2 >/dev/null 2>&1 || { echo "reset-demo: pm2 not found on PATH" >&2; exit 1; }
command -v openssl >/dev/null 2>&1 || { echo "reset-demo: openssl not found on PATH" >&2; exit 1; }
command -v npx >/dev/null 2>&1 || { echo "reset-demo: npx not found on PATH" >&2; exit 1; }
[ -f "$ECO" ] || { echo "reset-demo: ecosystem config missing: $ECO" >&2; exit 1; }
[ -f "$REPO/$SEEDER" ] || { echo "reset-demo: seeder missing: $REPO/$SEEDER (built by the fixture/seeder agent)" >&2; exit 1; }

cd "$REPO"

# ── STEP 1: stop + delete ONLY the allowlisted demo apps (never the real CC) ───
echo
echo "[1/6] stopping + deleting demo apps (allowlist only)…"
for app in "${DEMO_APP_ALLOWLIST[@]}"; do
  _is_allowed_app "$app" || { echo "  refusing non-allowlisted app '$app'" >&2; exit 3; }
  pm2 stop "$app"   >/dev/null 2>&1 || true
  pm2 delete "$app" >/dev/null 2>&1 || true
  echo "  cleared $app"
done

# ── STEP 2 + 3: wipe per-profile DB + workspace (strictly under DDR) ───────────
_safe_rm() {
  # Refuse to rm anything that is not strictly under the validated DDR.
  local target abs
  target="$1"
  abs="$(_abspath "$target")"
  case "$abs" in
    "$DDR"/*) rm -rf "$abs" ;;
    *) echo "  FATAL: refusing to rm '$abs' — outside DEMO_DATA_ROOT ($DDR)" >&2; exit 3 ;;
  esac
}

echo
echo "[2/6] wiping demo DB + workspace for: ${PROFILES[*]}…"
for p in "${PROFILES[@]}"; do
  _safe_rm "$DDR/$p/mission-control.db"
  _safe_rm "$DDR/$p/mission-control.db-wal"
  _safe_rm "$DDR/$p/mission-control.db-shm"
  _safe_rm "$DDR/$p/workspace"
  mkdir -p "$DDR/$p/workspace"
  echo "  wiped + prepared $DDR/$p"
done

# ── STEP 4: rotate the interview cookie secret ─────────────────────────────────
echo
echo "[3/6] rotating cookie secret (invalidates outstanding mc_interview cookies)…"
mkdir -p "$DDR"
umask 077
openssl rand -hex 32 > "$DDR/cookie-secret.txt"
echo "  wrote $DDR/cookie-secret.txt (value not shown)"

# ── STEP 5: reseed each profile ────────────────────────────────────────────────
echo
echo "[4/6] reseeding…"
for p in "${PROFILES[@]}"; do
  echo "  seeding profile=$p…"
  npx tsx "$SEEDER" \
    --profile "$p" \
    --fixture "$FIXTURE" \
    --db "$DDR/$p/mission-control.db" \
    --workspace "$DDR/$p/workspace"
done

# ── STEP 6: start the demo web apps (never the simulator) ──────────────────────
echo
echo "[5/6] starting demo web app(s) via the ecosystem…"
ONLY_CSV="$(IFS=,; echo "${WEB_APPS[*]}")"
DEMO_DATA_ROOT="$DDR" pm2 start "$ECO" --only "$ONLY_CSV" --update-env

# ── VERIFY: health + one seeded read per started profile ───────────────────────
echo
echo "[6/6] verifying…"
FAILS=0
_check() { # <desc> <0|1 rc>
  if [ "$2" -eq 0 ]; then echo "  PASS  $1"; else echo "  FAIL  $1"; FAILS=$((FAILS+1)); fi
}

_poll_health() { # <port> — 0 if /api/health returns 200 within ~30s
  local port="$1" i code
  for i in $(seq 1 30); do
    code="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$port/api/health" 2>/dev/null || echo 000)"
    [ "$code" = "200" ] && return 0
    sleep 1
  done
  return 1
}

for p in "${PROFILES[@]}"; do
  if [ "$p" = "interview" ]; then
    port="$INTERVIEW_PORT"
  else
    port="$DASHBOARD_PORT"
  fi

  if _poll_health "$port"; then _check "$p /api/health 200 (:$port)" 0; else _check "$p /api/health 200 (:$port)" 1; fi

  if [ "$p" = "dashboard" ]; then
    # seeded read: company-health returns a grade
    body="$(curl -s "http://127.0.0.1:$port/api/company-health" 2>/dev/null || true)"
    if printf '%s' "$body" | grep -qi '"grade"'; then _check "dashboard /api/company-health has a grade" 0; else _check "dashboard /api/company-health has a grade" 1; fi
  else
    # seeded read: interview page renders
    code="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$port/interview" 2>/dev/null || echo 000)"
    if [ "$code" = "200" ]; then _check "interview GET /interview 200" 0; else _check "interview GET /interview 200 (got $code)" 1; fi
  fi
done

echo
if [ "$FAILS" -eq 0 ]; then
  echo "==> RESET COMPLETE — all checks PASSED."
  exit 0
fi
echo "==> RESET FINISHED WITH $FAILS FAILING CHECK(S)." >&2
exit 1
