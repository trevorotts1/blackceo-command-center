#!/usr/bin/env bash
# b5-cf-access-check.sh — CF-Access subdomain health probe (PRD Addendum B.5)
#
# PURPOSE
# -------
# Verifies that a client subdomain (e.g. acme.zerohumanworkforce.com) is
# properly protected by Cloudflare Access — i.e. an unauthenticated request
# returns 302 → CF-login, NOT 200 (which would mean CF-Access is misconfigured
# or inactive).
#
# This is a SEPARATE, WARNING-LEVEL check from B.1. It does not affect the
# cc-health-check.sh green/not-green verdict. Wire it into the Sunday cron
# alongside cc-health-check.sh for automated visibility.
#
# PRD B.5: "corey, evelyn, and lyric-vps return 401 'Cloudflare Access is not
# active on this subdomain' from the app's own guard — a CF-Access config issue."
# Fix: separate diagnostic pass per box.
#
# USAGE
#   bash scripts/b5-cf-access-check.sh --public-url https://acme.zerohumanworkforce.com
#   bash scripts/b5-cf-access-check.sh --public-url URL [--json-only] [--pretty]
#
# OUTPUT (JSON)
#   {
#     "pass": true | false,
#     "url": "https://...",
#     "http_code": 302,
#     "redirect_url": "https://...cloudflareaccess.com/...",
#     "detail": "...",
#     "timestamp": "ISO-8601"
#   }
#
# Exit: 0 = CF-Access active (302 to CF-login), 1 = misconfigured/unexpected,
#       2 = usage error, 3 = unreachable (tunnel may be down)
#
# WIRED INTO:
#   scripts/sunday-cron-sweep.sh — weekly fleet sweep (alongside cc-health-check.sh)

set -euo pipefail

###############################################################################
# Argument parsing
###############################################################################

PUBLIC_URL=""
JSON_ONLY="0"
PRETTY="0"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --public-url)  PUBLIC_URL="${2:?--public-url requires a value}"; shift 2 ;;
    --json-only)   JSON_ONLY="1"; shift ;;
    --pretty)      PRETTY="1"; shift ;;
    *) printf 'ERROR: Unknown argument: %s\n' "$1" >&2; exit 2 ;;
  esac
done

if [[ -z "$PUBLIC_URL" ]]; then
  printf 'ERROR: --public-url is required\n' >&2
  exit 2
fi

_log() { [[ "${JSON_ONLY:-0}" == "1" ]] || printf '%s\n' "$*" >&2; }
_iso8601() { date -u +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null; }
_jstr() {
  local s="$1"
  s="${s//\\/\\\\}"; s="${s//\"/\\\"}"; s="${s//$'\n'/\\n}"
  printf '%s' "$s"
}

###############################################################################
# Probe
###############################################################################

_log "[B.5] CF-Access probe: ${PUBLIC_URL}"

CF_RESP=$(curl -s -o /dev/null \
  -w "%{http_code}|||%{redirect_url}" \
  --max-time 10 \
  --max-redirs 0 \
  "$PUBLIC_URL" 2>/dev/null || echo "000|||")

CF_CODE="${CF_RESP%%|||*}"
CF_REDIR="${CF_RESP##*|||}"

TS=$(_iso8601)
PASS="false"
DETAIL=""
EXIT_CODE=1

if [[ "$CF_CODE" == "000" ]]; then
  DETAIL="Unreachable (HTTP 000 — connection refused or tunnel may be down)"
  EXIT_CODE=3
elif [[ "$CF_CODE" == "302" || "$CF_CODE" == "301" ]]; then
  if printf '%s' "$CF_REDIR" | grep -qiE 'cloudflareaccess\.com|\.cloudflare\.com'; then
    PASS="true"
    DETAIL="CF-Access active — ${CF_CODE} → CF-login (${CF_REDIR})"
    EXIT_CODE=0
    _log "  OK  ${CF_CODE} → ${CF_REDIR}"
  else
    DETAIL="Redirect to unexpected host — CF-Access may not be active (${CF_CODE} → ${CF_REDIR})"
    _log "  WARN ${CF_CODE} → ${CF_REDIR} (not CF-Access)"
  fi
elif [[ "$CF_CODE" == "200" ]]; then
  DETAIL="HTTP 200 without CF-Access redirect — CF-Access is not active on this subdomain (B.5 misconfiguration)"
  _log "  FAIL ${CF_CODE} (expected 302 to CF-login)"
elif [[ "$CF_CODE" == "401" || "$CF_CODE" == "403" ]]; then
  DETAIL="HTTP ${CF_CODE} — CF-Access app guard returned auth error (check CF tunnel route and Access application settings)"
  _log "  FAIL ${CF_CODE}"
else
  DETAIL="Unexpected HTTP ${CF_CODE} (expected 302 to CF-login)"
  _log "  WARN ${CF_CODE}"
fi

OUT='{'
OUT+='"pass":'${PASS}','
OUT+='"url":"'"$(_jstr "$PUBLIC_URL")"'",'
OUT+='"http_code":'"${CF_CODE}"','
OUT+='"redirect_url":"'"$(_jstr "$CF_REDIR")"'",'
OUT+='"detail":"'"$(_jstr "$DETAIL")"'",'
OUT+='"timestamp":"'"${TS}"'"'
OUT+='}'

if [[ "$PRETTY" == "1" ]] && command -v python3 &>/dev/null; then
  printf '%s' "$OUT" | python3 -m json.tool
else
  printf '%s\n' "$OUT"
fi

exit "$EXIT_CODE"
