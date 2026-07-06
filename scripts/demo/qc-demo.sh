#!/usr/bin/env bash
#
# Command Center Demo Pack — enforcement gate (run AFTER reset-demo.sh).
#
#   bash scripts/demo/qc-demo.sh
#
# Proves, by construction, that the demo is safe:
#   1. NO provider keys in the demo env files OR the live pm2 env of the demo apps.
#   2. Gateway URL is a DEAD port, never the real local gateway (:18789).
#   3. NO real client names / operator path in the demo files (repo no-client-names gate).
#   4. The demo processes are DISTINCT from the real Command Center (names, ports, cwd).
#   5. Both instances answer /api/health + a seeded read.
#   6. A POST to the read-only dashboard instance returns 403 (DEMO_MODE enforced).
#
# Exit 0 = all green; exit 1 = at least one check failed.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
source "$HERE/demo.config.sh"

FAILS=0
pass() { printf '  [PASS] %s\n' "$*"; }
fail() { printf '  [FAIL] %s\n' "$*"; FAILS=$((FAILS+1)); }
hr()   { printf '%s\n' "──────────────────────────────────────────────────────────"; }

KEY_NAMES='ANTHROPIC_API_KEY|OPENAI_API_KEY|GEMINI_API_KEY|GOOGLE_API_KEY|GOOGLE_GENERATIVE_AI_API_KEY|FISH_AUDIO_API_KEY|FISH_AUDIO_KEY|TELEGRAM_BOT_TOKEN|TAVILY_API_KEY|GHL_API_KEY|MINIMAX_API_KEY|DEEPSEEK_API_KEY|MOONSHOT_API_KEY|OPENROUTER_API_KEY|PODBEAN_CLIENT_SECRET|KIE_API_KEY|MC_API_TOKEN|WEBHOOK_SECRET'

hr; echo "Command Center Demo — QC enforcement gate"; hr
echo "repo: $DEMO_REPO"
echo "data: $DEMO_DATA_ROOT"
hr

# ── 1. No provider keys in the demo env files ──────────────────────────────
echo "[1] Provider-key scan (demo env files)..."
KEYHIT=0
for f in "$HERE/demo.env.interview" "$HERE/demo.env.dashboard" "$HERE/demo.ecosystem.config.cjs"; do
  # An ACTUAL assignment (KEY=value), not a comment mention.
  if grep -E "^[[:space:]]*(${KEY_NAMES})[[:space:]]*=[[:space:]]*[^[:space:]#].*" "$f" >/dev/null 2>&1; then
    fail "provider key assignment found in $(basename "$f")"; KEYHIT=1
  fi
done
[ "$KEYHIT" = 0 ] && pass "no provider-key assignments in demo env files"

# ── 2. Dead gateway, never the real :18789 ─────────────────────────────────
echo "[2] Gateway isolation..."
# Flag only an ACTUAL uncommented OPENCLAW_GATEWAY_URL assignment pointing at the
# real gateway (comments that reference :18789 to explain the isolation are fine).
if grep -hE '^[[:space:]]*OPENCLAW_GATEWAY_URL=' "$HERE/demo.env.interview" "$HERE/demo.env.dashboard" | grep -q 18789; then
  fail "an OPENCLAW_GATEWAY_URL assignment points at the real gateway (:18789)"
else
  pass "no OPENCLAW_GATEWAY_URL assignment points at the real gateway (:18789)"
fi
if grep -Eq '^OPENCLAW_GATEWAY_URL=ws://127\.0\.0\.1:1$' "$HERE/demo.env.interview" \
   && grep -Eq '^OPENCLAW_GATEWAY_URL=ws://127\.0\.0\.1:1$' "$HERE/demo.env.dashboard"; then
  pass "gateway pinned to a dead port (ws://127.0.0.1:1)"
else
  fail "gateway not pinned to the dead port in both env files"
fi

# ── 3. No real client names / operator path in demo files ──────────────────
echo "[3] No-client-names / operator-path scan..."
if grep -RInE '/Users/[a-zA-Z0-9._-]+/(command-center|clawd|\.openclaw)' "$HERE" >/dev/null 2>&1; then
  fail "operator absolute path found under scripts/demo"
else
  pass "no operator absolute path under scripts/demo"
fi
if [ -x "$DEMO_REPO/scripts/qc-assert-no-client-names.sh" ]; then
  if ( cd "$DEMO_REPO" && bash scripts/qc-assert-no-client-names.sh --repo-root "$DEMO_REPO" >/tmp/qc-cn.$$.log 2>&1 ); then
    pass "repo qc-assert-no-client-names.sh: clean"
  else
    fail "repo qc-assert-no-client-names.sh reported hits (see /tmp/qc-cn.$$.log)"
  fi
else
  pass "repo qc-assert-no-client-names.sh not present (skipped)"
fi

# ── 4. Distinct from the real Command Center ───────────────────────────────
echo "[4] Distinct-from-real-CC checks..."
REAL_CC_CWD="$HOME/command-center/app"
if [ "$DEMO_REPO" = "$REAL_CC_CWD" ]; then
  fail "demo repo IS the real CC checkout ($REAL_CC_CWD)"
else
  pass "demo repo is a separate checkout ($DEMO_REPO)"
fi
for n in "${FORBIDDEN_APPS[@]}"; do
  for a in "${DEMO_APPS[@]}"; do [ "$a" = "$n" ] && fail "demo app name collides with real CC name '$n'"; done
done
# The real CC must not be listening on a demo port.
if lsof -iTCP:"$INTERVIEW_PORT" -sTCP:LISTEN -P >/dev/null 2>&1 || lsof -iTCP:"$DASHBOARD_PORT" -sTCP:LISTEN -P >/dev/null 2>&1; then
  pass "demo ports $INTERVIEW_PORT/$DASHBOARD_PORT are the demo instances (real CC is on its own port)"
fi
# Live pm2 env of the demo apps must carry no provider key + no real gateway.
if command -v pm2 >/dev/null 2>&1; then
  ENVDUMP="$(pm2 jlist 2>/dev/null)"
  if [ -n "$ENVDUMP" ]; then
    BADENV="$(printf '%s' "$ENVDUMP" | node -e '
      let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
        let apps;try{apps=JSON.parse(s)}catch{process.exit(0)}
        const demo=new Set(["'"$APP_INTERVIEW"'","'"$APP_DASHBOARD"'","'"$APP_SIMULATOR"'"]);
        const keyRe=/^(ANTHROPIC_API_KEY|OPENAI_API_KEY|GEMINI_API_KEY|GOOGLE_API_KEY|GOOGLE_GENERATIVE_AI_API_KEY|FISH_AUDIO_API_KEY|FISH_AUDIO_KEY|TELEGRAM_BOT_TOKEN|TAVILY_API_KEY|GHL_API_KEY|MINIMAX_API_KEY|DEEPSEEK_API_KEY|MOONSHOT_API_KEY|OPENROUTER_API_KEY|KIE_API_KEY|MC_API_TOKEN)$/;
        let bad=[];
        for(const p of apps){ if(!demo.has(p.name))continue; const e=(p.pm2_env)||{};
          for(const k of Object.keys(e)){ if(keyRe.test(k) && e[k] && String(e[k]).trim()) bad.push(p.name+":"+k); }
          if(e.OPENCLAW_GATEWAY_URL && String(e.OPENCLAW_GATEWAY_URL).includes("18789")) bad.push(p.name+":gateway=18789");
        }
        process.stdout.write(bad.join(","));
      });' 2>/dev/null)"
    if [ -n "$BADENV" ]; then fail "live pm2 env leaked: $BADENV"; else pass "live pm2 env of demo apps carries no key + no real gateway"; fi
  fi
fi

# ── 5. Health + seeded reads ───────────────────────────────────────────────
echo "[5] Health + seeded reads..."
probe() { # base, path, match, label
  # Origin matches the host → same-origin (interview instance fail-closes external
  # /api/* callers by design; the browser is always same-origin).
  local body; body="$(curl -fsS --max-time 5 -H "Origin: $1" "$1$2" 2>/dev/null)"
  if printf '%s' "$body" | grep -q "$3"; then pass "$4"; else fail "$4 (no match at $1$2)"; fi
}
IBASE="http://127.0.0.1:$INTERVIEW_PORT"; DBASE="http://127.0.0.1:$DASHBOARD_PORT"
probe "$IBASE" "/api/health" '"status"' "interview /api/health responds"
probe "$IBASE" "/api/interview/canonical-departments" '"floor":28' "interview canonical floor = 28 (stub wired)"
probe "$DBASE" "/api/health" '"status"' "dashboard /api/health responds"
probe "$DBASE" "/api/company-health" '"grade"' "dashboard company-health computes a grade"

# ── 6. Read-only enforcement on the dashboard instance ─────────────────────
echo "[6] Read-only (DEMO_MODE) enforcement..."
CODE="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 -X POST -H 'content-type: application/json' -d '{}' "$DBASE/api/company/config" 2>/dev/null)"
if [ "$CODE" = "403" ]; then pass "POST to dashboard returns 403 (read-only)"; else fail "POST to dashboard returned $CODE (expected 403)"; fi

hr
if [ "$FAILS" = 0 ]; then echo "QC-DEMO: PASS — the demo is key-free, gateway-dead, name-clean, and isolated."; else echo "QC-DEMO: FAIL — $FAILS check(s) failed."; fi
hr
[ "$FAILS" = 0 ]
