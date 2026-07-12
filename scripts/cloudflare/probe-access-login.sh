#!/usr/bin/env bash
#
# probe-access-login.sh
#
# P1-08 (2026-07-11 spec) part (c) step 3: an end-to-end Cloudflare Access
# login POSTURE probe for a single client Command Center hostname.
#
# This is built and QC'd now and SHIPS in P6-01 as a per-box check in the
# final fleet roll's post-validation probe set (spec Section 8) -- it is not
# run against any live client box by this build. It is a distinct check from
# scripts/cc-health-check.sh's "green" definition: cc-health-check.sh answers
# "is the app up and serving", this script answers "is Cloudflare Access
# actually gating this hostname". A box can be fully green on the former and
# still fail this probe if Access isn't in front of it.
#
# Verdict:
#   - Unauthenticated request 3xx-redirects OFF-ORIGIN (Access login page)
#       -> protected        (exit 0)
#   - Unauthenticated request returns 200 (no Access app, no other gate)
#       -> cc_unprotected   (exit 1) -- flagged to the operator lane per spec
#   - Unauthenticated request 3xx-redirects SAME-ORIGIN (e.g. an in-app
#     redirect, not an Access login page) -- Access is not confirmed
#       -> unknown          (exit 3)
#   - Network error, timeout, or any other ambiguous response
#       -> unknown          (exit 3)
#
# If a Cloudflare Access service token is supplied, the probe additionally
# attempts an AUTHENTICATED request against /api/health using the
# CF-Access-Client-Id / CF-Access-Client-Secret headers and reports whether
# it reached the app. This is informational only -- it never downgrades a
# "protected" verdict, because service tokens are optional per box (not
# every client box has one provisioned).
#
# Usage:
#   ./scripts/cloudflare/probe-access-login.sh <cc-hostname> [service-token-id] [service-token-secret]
#
# Example:
#   ./scripts/cloudflare/probe-access-login.sh acme.zerohumanworkforce.com
#   ./scripts/cloudflare/probe-access-login.sh acme.zerohumanworkforce.com "$SVC_ID" "$SVC_SECRET"
#
# Output: one JSON object on stdout (per spec Section 2.7's per-box ledger
# convention -- the caller is expected to write it to
# /tmp/fleet-roll-2026-07/<box>.json alongside the other P6-01 probe rows).
# Diagnostic lines go to stderr. NEVER logs a secret value -- the service
# token, if provided, is used only as an HTTP header and never echoed.
#
# Exit codes: 0=protected  1=cc_unprotected  3=unknown  2=usage error

set -uo pipefail

if [ "$#" -lt 1 ]; then
  echo "Usage: $0 <cc-hostname> [service-token-id] [service-token-secret]" >&2
  exit 2
fi

TARGET_HOSTNAME="$1"
SERVICE_TOKEN_ID="${2:-}"
SERVICE_TOKEN_SECRET="${3:-}"
URL="https://${TARGET_HOSTNAME}/"
PROBED_AT="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"

log() { printf '[probe-access-login] %s\n' "$*" >&2; }

# emit <status> <detail> <http_code> <redirect_target> <auth_probed:true|false> <auth_reachable:true|false>
emit() {
  python3 -c "
import json, sys
status, detail, http_code, redirect, auth_probed, auth_reachable, hostname, ts = sys.argv[1:9]
print(json.dumps({
    'component': 'cloudflare_access_login',
    'hostname': hostname,
    'status': status,
    'detail': detail,
    'unauthenticated_http_code': int(http_code) if (http_code.isdigit() and http_code != '000') else None,
    'redirect_target': redirect or None,
    'service_token_probed': auth_probed == 'true',
    'service_token_reachable': (auth_reachable == 'true') if auth_probed == 'true' else None,
    'probed_at': ts,
}))
" "$1" "$2" "$3" "$4" "$5" "$6" "$TARGET_HOSTNAME" "$PROBED_AT"
}

# ── Unauthenticated probe ────────────────────────────────────────────────────
# --max-redirs 0 keeps a Cloudflare Access login redirect visible as a 3xx
# instead of being silently followed (same convention as cc-health-check.sh's
# existing CF public-URL probe).
RAW=$(curl -s --max-time 15 --max-redirs 0 -o /dev/null -w '%{http_code} %{redirect_url}' "$URL" 2>/dev/null || echo "000 ")
HTTP_CODE="${RAW%% *}"
REDIRECT_TARGET="${RAW#* }"

if [ "$HTTP_CODE" = "000" ]; then
  log "UNKNOWN: ${URL} unreachable (network error or timeout)"
  emit "unknown" "unreachable (network error or timeout)" "$HTTP_CODE" "" "false" "false"
  exit 3
fi

case "$HTTP_CODE" in
  3??)
    # A redirect happened. Confirm it lands OFF-ORIGIN (a Cloudflare Access
    # login page lives on a different host -- the team domain or
    # cloudflareaccess.com), not an in-app same-origin redirect (which would
    # mean Access isn't actually gating this hostname at all).
    REDIRECT_HOST=$(printf '%s' "$REDIRECT_TARGET" | sed -E 's#^[a-zA-Z]+://##; s#[/?].*$##' | tr '[:upper:]' '[:lower:]')
    REQUEST_HOST=$(printf '%s' "$TARGET_HOSTNAME" | tr '[:upper:]' '[:lower:]')
    if [ -n "$REDIRECT_HOST" ] && [ "$REDIRECT_HOST" != "$REQUEST_HOST" ]; then
      log "PROTECTED: ${URL} -> HTTP ${HTTP_CODE} to ${REDIRECT_TARGET} (Access login redirect confirmed)"
      AUTH_PROBED="false"; AUTH_REACHABLE="false"
      if [ -n "$SERVICE_TOKEN_ID" ] && [ -n "$SERVICE_TOKEN_SECRET" ]; then
        AUTH_PROBED="true"
        AUTH_CODE=$(curl -s --max-time 15 --max-redirs 0 -o /dev/null -w '%{http_code}' \
          -H "CF-Access-Client-Id: ${SERVICE_TOKEN_ID}" \
          -H "CF-Access-Client-Secret: ${SERVICE_TOKEN_SECRET}" \
          "${URL}api/health" 2>/dev/null || echo "000")
        [ "$AUTH_CODE" = "200" ] && AUTH_REACHABLE="true"
        log "service-token probe: ${URL}api/health -> HTTP ${AUTH_CODE}"
      fi
      emit "protected" "Access login redirect confirmed" "$HTTP_CODE" "$REDIRECT_TARGET" "$AUTH_PROBED" "$AUTH_REACHABLE"
      exit 0
    else
      # Same-origin redirect (e.g. an in-app shell lock) -- Access is not
      # confirmed to be gating this hostname. Ambiguous rather than a hard
      # fail: the app is at least up and redirecting somewhere in-app, but
      # this probe cannot tell that apart from "no edge gate at all" without
      # a human/second signal, so it reports UNKNOWN rather than silently
      # trusting either verdict.
      log "UNKNOWN: ${URL} redirected same-origin to ${REDIRECT_TARGET} -- Access not confirmed"
      emit "unknown" "same-origin redirect, not a confirmed off-origin Access login page" "$HTTP_CODE" "$REDIRECT_TARGET" "false" "false"
      exit 3
    fi
    ;;
  200)
    log "cc_unprotected: ${URL} returned HTTP 200 unauthenticated -- no Access app / no other gate in front of this hostname"
    emit "cc_unprotected" "HTTP 200 unauthenticated -- no Access app / no other auth in front of this hostname" "200" "" "false" "false"
    exit 1
    ;;
  *)
    log "UNKNOWN: ${URL} returned HTTP ${HTTP_CODE} (ambiguous)"
    emit "unknown" "ambiguous HTTP ${HTTP_CODE}" "$HTTP_CODE" "" "false" "false"
    exit 3
    ;;
esac
