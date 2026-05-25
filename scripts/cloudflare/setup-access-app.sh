#!/usr/bin/env bash
#
# setup-access-app.sh
#
# One-shot Cloudflare Access App provisioner for a BlackCEO v4.0 client
# subdomain. Implements PRD Section 7.2 (P1-10).
#
# Given a subdomain and one or more operator emails, this script will:
#   1. Ensure a One-Time PIN identity provider exists for the account
#   2. Create a self-hosted Access Application for the subdomain
#      (336h / 14-day session)
#   3. Attach an "Allow" policy for the supplied emails, gated on OTP login
#
# The script is idempotent: re-running it against the same subdomain will
# detect the existing IdP / App and report rather than create duplicates.
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
# Step 1: Ensure One-Time PIN identity provider exists
# ---------------------------------------------------------------------------

echo "==> Checking for existing One-Time PIN identity provider..." >&2
IDP_LIST=$(cf_call GET "/identity_providers")

IDP_PRESENT=$(echo "$IDP_LIST" | python3 -c "
import json, sys
data = json.load(sys.stdin)
for idp in data.get('result', []) or []:
    if idp.get('type') == 'onetimepin':
        print('yes')
        break
" || true)

if [ "$IDP_PRESENT" = "yes" ]; then
  echo "    One-Time PIN IdP already exists for this account. Skipping create." >&2
else
  echo "    No One-Time PIN IdP found. Creating one..." >&2
  cf_call POST "/identity_providers" \
    '{"name":"One-time PIN login","type":"onetimepin","config":{}}' >/dev/null
  echo "    One-Time PIN IdP created." >&2
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
  "session_duration": "336h"
}
EOF
)")

  APP_ID=$(echo "$APP_RESPONSE" | json_extract id)
  if [ -z "$APP_ID" ]; then
    echo "ERROR: Failed to parse Access App id from response:" >&2
    echo "$APP_RESPONSE" >&2
    exit 1
  fi
  echo "    Access App created (id=${APP_ID})." >&2
fi

# Re-fetch the app to grab the AUD tag (stable, used by middleware verification)
APP_DETAIL=$(cf_call GET "/apps/${APP_ID}")
APP_AUD=$(echo "$APP_DETAIL" | json_extract aud)

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

  cf_call POST "/apps/${APP_ID}/policies" "$(cat <<EOF
{
  "name": "Allowed users",
  "decision": "allow",
  "include": ${EMAIL_JSON},
  "require": [{"login_method":{"id":"onetimepin"}}]
}
EOF
)" >/dev/null
  echo "    Allow policy created." >&2
fi

# ---------------------------------------------------------------------------
# Done. Print the operator-facing summary on stdout.
# ---------------------------------------------------------------------------

cat <<EOF

Cloudflare Access provisioned for ${SUBDOMAIN}

  Application UUID : ${APP_ID}
  Application AUD  : ${APP_AUD}
  Session length   : 336h (14 days)
  Allowed emails   : ${EMAILS[*]}

Copy these into the deployment .env so the Next.js middleware can verify
the Cloudflare Access JWT:

  CF_ACCESS_TEAM_DOMAIN=<your-team>.cloudflareaccess.com
  CF_ACCESS_AUD=${APP_AUD}

EOF
