#!/usr/bin/env bash
#
# setup-access-app.sh
#
# One-shot Cloudflare Access App provisioner for a BlackCEO v4.0 client
# subdomain. Implements PRD Section 7.2 (P1-10).
#
# Given a subdomain and one or more operator emails, this script will:
#   1. Ensure a One-Time PIN identity provider exists for the account, and
#      detect whether a Google identity provider is ALSO configured at the
#      account level (P1-08, 2026-07-11 spec, decision D-3). Google is never
#      created by this script -- only PIN's presence is guaranteed; Google is
#      attached when it already exists.
#   2. Create (or update) a self-hosted Access Application for the subdomain
#      (336h / 14-day session) whose allowed_idps lists One-Time PIN plus
#      Google when available -- attaching Google to an already-existing app
#      the first time it becomes available at the account level.
#   3. Attach an "Allow" policy for the supplied emails. The policy no longer
#      hardcodes a login-method requirement -- which of the app's allowed_idps
#      a user authenticates through is enforced at the app level (step 2), not
#      re-restricted here to One-Time PIN only.
#
# The script is idempotent: re-running it against the same subdomain will
# detect the existing IdP / App / allowed_idps and report rather than create
# duplicates or issue redundant updates.
#
# Required env:
#   CLOUDFLARE_API_TOKEN   Token with Access: Edit + Access: Read scopes
#   CLOUDFLARE_ACCOUNT_ID  Cloudflare account UUID
#
# Usage:
#   ./scripts/cloudflare/setup-access-app.sh <subdomain> <operator-email> [more-emails...]
#
# Example:
#   ./scripts/cloudflare/setup-access-app.sh client.zerohumanworkforce.com trevor@blackceo.com

set -euo pipefail

# ---------------------------------------------------------------------------
# Args + env
# ---------------------------------------------------------------------------

if [ "$#" -lt 2 ]; then
  echo "Usage: $0 <subdomain> <operator-email> [more-emails...]" >&2
  exit 1
fi

SUBDOMAIN="$1"
shift
EMAILS=("$@")

if [ -z "${CLOUDFLARE_API_TOKEN:-}" ] || [ -z "${CLOUDFLARE_ACCOUNT_ID:-}" ]; then
  echo "ERROR: Set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID env vars." >&2
  echo "       Token needs Access: Edit + Access: Read on the target account." >&2
  exit 1
fi

CF_API_ROOT="${CF_API_ROOT:-https://api.cloudflare.com/client/v4}"
API_BASE="${CF_API_ROOT}/accounts/${CLOUDFLARE_ACCOUNT_ID}/access"
AUTH_HEADER="Authorization: Bearer ${CLOUDFLARE_API_TOKEN}"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

# cf_call <method> <path> [json-body]
# Prints the raw response body to stdout, exits non-zero on transport or HTTP
# error and prints the body to stderr.
cf_call() {
  local method="$1"
  local path="$2"
  local body="${3:-}"
  local tmp_body
  local http_code
  tmp_body=$(mktemp)

  if [ -n "$body" ]; then
    http_code=$(curl -sS -o "$tmp_body" -w '%{http_code}' \
      -X "$method" \
      "${API_BASE}${path}" \
      -H "$AUTH_HEADER" \
      -H "Content-Type: application/json" \
      --data "$body")
  else
    http_code=$(curl -sS -o "$tmp_body" -w '%{http_code}' \
      -X "$method" \
      "${API_BASE}${path}" \
      -H "$AUTH_HEADER")
  fi

  if [ "$http_code" -lt 200 ] || [ "$http_code" -ge 300 ]; then
    echo "ERROR: Cloudflare API ${method} ${path} returned HTTP ${http_code}" >&2
    cat "$tmp_body" >&2
    echo >&2
    rm -f "$tmp_body"
    exit 1
  fi

  cat "$tmp_body"
  rm -f "$tmp_body"
}

# Extract a JSON string value by key. Uses Python so we tolerate whitespace
# and nested objects; we always call it against single-object payloads (the
# result wrapper or a single app/idp/policy record).
json_extract() {
  local key="$1"
  python3 -c "
import json, sys
try:
    data = json.load(sys.stdin)
except Exception:
    sys.exit(0)
# Unwrap Cloudflare's {success, result, ...} envelope if present.
if isinstance(data, dict) and 'result' in data:
    data = data['result']
if isinstance(data, dict):
    val = data.get('${key}')
    if val is not None:
        print(val)
"
}

# ---------------------------------------------------------------------------
# Step 1: Ensure One-Time PIN identity provider exists; detect Google (P1-08)
# ---------------------------------------------------------------------------
#
# P1-08 (2026-07-11 spec): the automation provisions One-Time PIN as the
# always-available default. It does NOT create a Google IdP -- that requires
# an OAuth client ID/secret configured once at the Cloudflare account level,
# which is an operator decision (spec Section 9, decision D-3), not something
# a script should provision unattended. This step only DETECTS whether a
# Google IdP is already configured on the account and, if so, captures its id
# so Step 2 can attach it to the app alongside One-Time PIN (D-3's
# recommendation: "let the updated script attach both"). If Google is not
# configured, we say so loudly and fall back to PIN-only -- PIN remains a
# fully working login in the meantime.

echo "==> Checking existing identity providers..." >&2
IDP_LIST=$(cf_call GET "/identity_providers")

OTP_IDP_ID=$(echo "$IDP_LIST" | python3 -c "
import json, sys
data = json.load(sys.stdin)
for idp in data.get('result', []) or []:
    if idp.get('type') == 'onetimepin':
        print(idp.get('id', ''))
        break
" || true)

if [ -n "$OTP_IDP_ID" ]; then
  echo "    One-Time PIN IdP already exists (id=${OTP_IDP_ID}). Skipping create." >&2
else
  echo "    No One-Time PIN IdP found. Creating one..." >&2
  OTP_CREATE_RESPONSE=$(cf_call POST "/identity_providers" \
    '{"name":"One-time PIN login","type":"onetimepin","config":{}}')
  OTP_IDP_ID=$(echo "$OTP_CREATE_RESPONSE" | json_extract id)
  if [ -z "$OTP_IDP_ID" ]; then
    echo "ERROR: Failed to parse One-Time PIN IdP id from creation response:" >&2
    echo "$OTP_CREATE_RESPONSE" >&2
    exit 1
  fi
  echo "    One-Time PIN IdP created (id=${OTP_IDP_ID})." >&2
fi

echo "==> Checking for an account-level Google identity provider..." >&2
GOOGLE_IDP_ID=$(echo "$IDP_LIST" | python3 -c "
import json, sys
data = json.load(sys.stdin)
for idp in data.get('result', []) or []:
    if idp.get('type') == 'google':
        print(idp.get('id', ''))
        break
" || true)

if [ -n "$GOOGLE_IDP_ID" ]; then
  echo "    Google IdP found (id=${GOOGLE_IDP_ID}). Will attach it alongside One-Time PIN." >&2
else
  echo "WARNING: No Google identity provider is configured on this Cloudflare account." >&2
  echo "         Falling back to One-Time PIN only for ${SUBDOMAIN}." >&2
  echo "         Configuring Google is a one-time, ACCOUNT-LEVEL OAuth setup" >&2
  echo "         (Zero Trust > Settings > Authentication > Login methods > Google)" >&2
  echo "         that only the operator can authorize -- see spec Section 9, decision D-3." >&2
  echo "         PIN remains a fully working login in the meantime." >&2
fi

if [ -n "$GOOGLE_IDP_ID" ]; then
  ALLOWED_IDPS_JSON="[\"${OTP_IDP_ID}\",\"${GOOGLE_IDP_ID}\"]"
else
  ALLOWED_IDPS_JSON="[\"${OTP_IDP_ID}\"]"
fi

# ---------------------------------------------------------------------------
# Step 2: Create (or detect) the Access Application
# ---------------------------------------------------------------------------

echo "==> Looking for existing Access App for domain ${SUBDOMAIN}..." >&2
APP_LIST=$(cf_call GET "/apps?per_page=1000")

# Naive but adequate: look for "domain":"<subdomain>" in the list payload and,
# if present, pull the nearest "id" before it. We re-fetch the single app
# afterwards to get a clean object.
APP_ID=""
APP_AUD=""

# Use python (always present on macOS + Linux fleet) for reliable JSON parsing.
APP_ID=$(echo "$APP_LIST" | SUBDOMAIN="$SUBDOMAIN" python3 -c "
import json, os, sys
target = os.environ['SUBDOMAIN']
data = json.load(sys.stdin)
for app in data.get('result', []) or []:
    if app.get('domain') == target:
        print(app.get('id',''))
        break
" || true)

if [ -n "$APP_ID" ]; then
  echo "    Access App already exists for ${SUBDOMAIN} (id=${APP_ID}). Skipping create." >&2
fi

if [ -z "$APP_ID" ]; then
  echo "==> Creating Access App for ${SUBDOMAIN}..." >&2
  APP_RESPONSE=$(cf_call POST "/apps" "$(cat <<EOF
{
  "name": "${SUBDOMAIN} Command Center",
  "domain": "${SUBDOMAIN}",
  "type": "self_hosted",
  "session_duration": "336h",
  "allowed_idps": ${ALLOWED_IDPS_JSON}
}
EOF
)")

  APP_ID=$(echo "$APP_RESPONSE" | json_extract id)
  if [ -z "$APP_ID" ]; then
    echo "ERROR: Failed to parse Access App id from response:" >&2
    echo "$APP_RESPONSE" >&2
    exit 1
  fi
  echo "    Access App created (id=${APP_ID}) with allowed_idps=${ALLOWED_IDPS_JSON}." >&2
fi

# Re-fetch the app to grab the AUD tag (stable, used by middleware verification)
APP_DETAIL=$(cf_call GET "/apps/${APP_ID}")
APP_AUD=$(echo "$APP_DETAIL" | json_extract aud)

# ---------------------------------------------------------------------------
# Step 2b (P1-08): attach Google to an EXISTING app if it just became
# available and isn't wired yet. GET-check-then-create-only-missing, applied
# to the app's allowed_idps rather than to the app record itself: never
# touches an app that already lists every currently-known IdP.
# ---------------------------------------------------------------------------

if [ -n "$GOOGLE_IDP_ID" ]; then
  APP_HAS_GOOGLE=$(echo "$APP_DETAIL" | GOOGLE_IDP_ID="$GOOGLE_IDP_ID" python3 -c "
import json, os, sys
target = os.environ.get('GOOGLE_IDP_ID', '')
data = json.load(sys.stdin)
result = data.get('result', data) if isinstance(data, dict) else data
ids = (result.get('allowed_idps') or []) if isinstance(result, dict) else []
print('yes' if target in ids else 'no')
" || echo "no")

  if [ "$APP_HAS_GOOGLE" = "no" ]; then
    echo "==> Attaching Google IdP to Access App ${APP_ID} (already existed, Google newly available)..." >&2
    cf_call PUT "/apps/${APP_ID}" "$(cat <<EOF
{
  "name": "${SUBDOMAIN} Command Center",
  "domain": "${SUBDOMAIN}",
  "type": "self_hosted",
  "session_duration": "336h",
  "allowed_idps": ${ALLOWED_IDPS_JSON}
}
EOF
)" >/dev/null
    echo "    Google IdP attached to ${APP_ID} alongside One-Time PIN." >&2
  else
    echo "    Access App ${APP_ID} already has Google attached. Skipping update." >&2
  fi
fi

# ---------------------------------------------------------------------------
# Step 3: Create (or detect) the Allow policy
# ---------------------------------------------------------------------------

echo "==> Checking existing policies on App ${APP_ID}..." >&2
POLICIES=$(cf_call GET "/apps/${APP_ID}/policies")

POLICY_PRESENT=$(echo "$POLICIES" | python3 -c "
import json, sys
data = json.load(sys.stdin)
for p in data.get('result', []) or []:
    if p.get('name') == 'Allowed users':
        print('yes')
        break
" || true)

if [ "$POLICY_PRESENT" = "yes" ]; then
  echo "    Policy 'Allowed users' already exists on this app. Skipping create." >&2
  echo "    To change the allow-list, edit the policy via dashboard or PUT it directly." >&2
else
  echo "==> Creating Allow policy with ${#EMAILS[@]} email(s)..." >&2

  EMAIL_JSON=""
  for e in "${EMAILS[@]}"; do
    EMAIL_JSON+=",{\"email\":{\"email\":\"${e}\"}}"
  done
  EMAIL_JSON="[${EMAIL_JSON:1}]"

  # P1-08 FIX: no "require": [{"login_method":{"id":"onetimepin"}}] clause.
  # That clause forced EVERY allowed user through One-Time PIN specifically,
  # even on an app whose allowed_idps also lists Google -- a user who tried
  # to authenticate via Google would pass the app-level IdP gate and then be
  # rejected here anyway (require is an AND: a login actually performed via
  # Google can never simultaneously satisfy "login_method == onetimepin").
  # This is the discrepancy the P1-08 spec named: hand-configured Google
  # logins worked because they were set up OUTSIDE this script, which never
  # had this restrictive clause. Login-METHOD selection is enforced once, at
  # the app level, via allowed_idps (Step 2/2b); this policy only restricts
  # WHO (by email) is allowed in, regardless of which of the app's allowed
  # IdPs they used to prove who they are.
  cf_call POST "/apps/${APP_ID}/policies" "$(cat <<EOF
{
  "name": "Allowed users",
  "decision": "allow",
  "include": ${EMAIL_JSON}
}
EOF
)" >/dev/null
  echo "    Allow policy created (no login-method restriction; governed by the app's allowed_idps)." >&2
fi

# ---------------------------------------------------------------------------
# Done. Print the operator-facing summary on stdout.
# ---------------------------------------------------------------------------

if [ -n "$GOOGLE_IDP_ID" ]; then
  LOGIN_METHODS_SUMMARY="Google + One-Time PIN"
else
  LOGIN_METHODS_SUMMARY="One-Time PIN only (no Google IdP configured on this account -- see Section 9 D-3)"
fi

cat <<EOF

Cloudflare Access provisioned for ${SUBDOMAIN}

  Application UUID : ${APP_ID}
  Application AUD  : ${APP_AUD}
  Session length   : 336h (14 days)
  Login methods    : ${LOGIN_METHODS_SUMMARY}
  Allowed emails   : ${EMAILS[*]}

Copy these into the deployment .env so the Next.js middleware can verify
the Cloudflare Access JWT:

  CF_ACCESS_TEAM_DOMAIN=<your-team>.cloudflareaccess.com
  CF_ACCESS_AUD=${APP_AUD}

EOF
