#!/usr/bin/env bash
#
# setup-access-app.sh
#
# One-shot Cloudflare Access App provisioner for a BlackCEO client
# subdomain. Implements PRD Section 7.2 (P1-10).
#
# Given a subdomain and one or more operator emails, this script will:
#   1. Ensure a One-Time PIN identity provider exists for the account, and
#      detect whether a Google identity provider is ALSO configured at the
#      account level (P1-08, 2026-07-11 spec, decision D-3). Google is never
#      created by this script -- only PIN's presence is guaranteed; Google is
#      attached when it already exists.
#   2. Create (or update) a self-hosted Access Application for the subdomain
#      (720h / 30-day session) whose allowed_idps lists One-Time PIN plus
#      Google when available -- and adding whichever of One-Time PIN / Google
#      an already-existing app is missing (GET-merge PUT, Step 2b), so every
#      client can sign in with an emailed code even if Google refuses them.
#   3. Attach an "Allow" policy for the supplied emails. The policy no longer
#      hardcodes a login-method requirement -- which of the app's allowed_idps
#      a user authenticates through is enforced at the app level (step 2), not
#      re-restricted here to One-Time PIN only.
#   4. (Optional, interview hardening 2026-10-13) When ACCESS_SERVICE_TOKEN_ID is
#      set to an EXISTING client-specific Access service-token id, reconcile a
#      narrowly scoped non_identity policy named "<subdomain> Command Center
#      automation" on that app, so the box's own bearer-only automation
#      (/api/auth/interview-ready, /api/auth/interview-invitation) reaches the
#      Command Center instead of being redirected to the Access login page.
#      This step never creates, rotates or prints a credential: it only attaches
#      the caller-supplied token id. Unset means "skip", exactly as before.
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
  "session_duration": "720h",
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
# Step 2b: reconcile login methods and the 30-day session on EXISTING apps.
#
# An app created by hand (or by an older script) can list only Google in
# allowed_idps. Google sign-in fails for personal @gmail.com users while the
# Google OAuth client is internal-only (Error 403: org_internal), so a client
# with no email-code option is locked out. This step adds whatever of
# One-Time PIN / Google the app is missing. It never removes an IdP the app
# already lists. An empty allowed_idps stays empty (Cloudflare already offers
# every account IdP, including email code); its session can still need repair.
#
# Cloudflare's PUT /apps/{id} REPLACES the whole record, so the body is the
# app's own GET result with only login/session settings changed (GET-merge): hand-set
# dashboard options (launcher visibility, deny pages, CORS, ...) survive.
# Cloudflare also rejects auto_redirect_to_identity=true when more than one
# IdP is allowed (API error 12130), so that flag is turned off in the same
# PUT when the merged list has more than one entry.
# ---------------------------------------------------------------------------

MERGE_RESULT=$(echo "$APP_DETAIL" | WANTED_IDPS="$ALLOWED_IDPS_JSON" OTP_IDP_ID="$OTP_IDP_ID" python3 -c "
import json, os, sys
wanted = json.loads(os.environ['WANTED_IDPS'])
otp = os.environ['OTP_IDP_ID']
data = json.load(sys.stdin)
app = data.get('result', data) if isinstance(data, dict) else {}
current = app.get('allowed_idps') or []
missing = [i for i in wanted if i not in current] if current else []
session_changed = app.get('session_duration') != '720h'
if not missing and not session_changed:
    print(json.dumps({'missing': [], 'update': False}))
    sys.exit(0)
body = {k: v for k, v in app.items() if k not in ('id', 'aud', 'uid', 'created_at', 'updated_at', 'policies')}
if missing:
    body['allowed_idps'] = current + missing
    if len(body['allowed_idps']) > 1 and body.get('auto_redirect_to_identity'):
        body['auto_redirect_to_identity'] = False
body['session_duration'] = '720h'
names = ['One-Time PIN' if i == otp else 'Google' for i in missing]
print(json.dumps({'missing': names, 'update': True, 'body': body}))
")

MISSING_IDP_NAMES=$(echo "$MERGE_RESULT" | python3 -c "import json,sys; print(', '.join(json.load(sys.stdin)['missing']))")
APP_UPDATE_NEEDED=$(echo "$MERGE_RESULT" | python3 -c "import json,sys; print('yes' if json.load(sys.stdin)['update'] else 'no')")

if [ "$APP_UPDATE_NEEDED" = "yes" ]; then
  if [ -n "$MISSING_IDP_NAMES" ]; then
    echo "==> Adding ${MISSING_IDP_NAMES} to existing Access App ${APP_ID} and ensuring a 30-day session..." >&2
  else
    echo "==> Updating Access App ${APP_ID} to a 30-day session (login methods unchanged)..." >&2
  fi
  MERGED_APP_BODY=$(echo "$MERGE_RESULT" | python3 -c "import json,sys; print(json.dumps(json.load(sys.stdin)['body']))")
  cf_call PUT "/apps/${APP_ID}" "$MERGED_APP_BODY" >/dev/null
  echo "    Access App ${APP_ID} reconciled with a 720h session." >&2
else
  echo "    Access App ${APP_ID} already offers every available login method and a 720h session. Skipping update." >&2
fi

# ---------------------------------------------------------------------------
# Step 3: Create (or reconcile) the Allow policy
# ---------------------------------------------------------------------------

echo "==> Checking existing policies on App ${APP_ID}..." >&2
POLICIES=$(cf_call GET "/apps/${APP_ID}/policies")

EXISTING_POLICY_JSON=$(echo "$POLICIES" | python3 -c "
import json, sys
data = json.load(sys.stdin)
for p in data.get('result', []) or []:
    if p.get('name') == 'Allowed users':
        print(json.dumps(p))
        break
" || true)

if [ -n "$EXISTING_POLICY_JSON" ]; then
  echo "    Policy 'Allowed users' already exists on this app." >&2

  # P1-08 FIX (re-derived after a failed QC pass): an app the OLD
  # (pre-P1-08) script provisioned carries a policy with
  # "require":[{"login_method":{"id":"onetimepin"}}] -- an AND clause that
  # rejects any login NOT performed via One-Time PIN, even after Step 2/2b
  # above just attached Google to the app's allowed_idps. Skipping this
  # policy outright (the old behavior) left that clause in place forever, so
  # Google logins on an old-script-provisioned app kept failing at policy
  # eval despite Google being an allowed IdP -- exactly the incompatibility
  # this unit's code comments describe elsewhere in this file. Detect the
  # stale clause and, only when Google is available to attach, reconcile the
  # policy: GET-check-then-update-only-if-needed, the same idempotence
  # pattern the rest of this script already uses -- a policy that is already
  # clean (no login_method require, or Google not yet available) is left
  # untouched.
  POLICY_ID=$(echo "$EXISTING_POLICY_JSON" | json_extract id)
  HAS_LOGIN_METHOD=$(echo "$EXISTING_POLICY_JSON" | python3 -c "
import json, sys
p = json.load(sys.stdin)
require = p.get('require') or []
found = any(isinstance(r, dict) and r.get('login_method') == {'id': 'onetimepin'} for r in require)
print('yes' if found else 'no')
")

  if [ -n "$GOOGLE_IDP_ID" ] && [ "$HAS_LOGIN_METHOD" = "yes" ]; then
    echo "==> Policy 'Allowed users' on App ${APP_ID} carries a stale login_method:onetimepin require clause from the pre-P1-08 script -- Google is available but would be rejected at policy eval. Removing the clause..." >&2

    # Preserve every writable policy field and unrelated condition; drop only
    # the historical onetimepin require selector. Built from the policy already
    # fetched above (no extra GET needed) rather than hand-assembled from
    # shell variables, so unexpected characters in email addresses/names
    # can never corrupt the JSON we send back.
    RECONCILED_POLICY_BODY=$(echo "$EXISTING_POLICY_JSON" | python3 -c "
import json, sys
p = json.load(sys.stdin)
body = {k: v for k, v in p.items() if k not in ('id', 'uid', 'created_at', 'updated_at')}
remaining = []
for clause in p.get('require') or []:
    if isinstance(clause, dict) and clause.get('login_method') == {'id': 'onetimepin'}:
        clause = {k: v for k, v in clause.items() if k != 'login_method'}
        if not clause:
            continue
    remaining.append(clause)
body['require'] = remaining
print(json.dumps(body))
")

    cf_call PUT "/apps/${APP_ID}/policies/${POLICY_ID}" "$RECONCILED_POLICY_BODY" >/dev/null
    echo "    Policy 'Allowed users' updated -- historical onetimepin restriction removed; unrelated policy conditions preserved." >&2
  else
    echo "    Policy 'Allowed users' has no login_method restriction to remove (or Google is not yet available). Skipping update." >&2
    echo "    To change the allow-list, edit the policy via dashboard or PUT it directly." >&2
  fi
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
# Step 3b (optional): machine / service-token policy for same-client automation
# ---------------------------------------------------------------------------
#
# WHY THIS EXISTS. Full-host Cloudflare Access turns every unauthenticated
# request into an edge redirect BEFORE the Command Center runs. A bearer-only
# caller (MC_API_TOKEN) never gets past that redirect, so readiness checks and
# invitation issuance fail at the EDGE rather than in the app -- the box can no
# longer prove its own interview path or mint its own invitation. The repair is
# one non_identity policy bound to the client's OWN existing service token: it
# admits that single token and nothing else, and it composes with the human
# "Allowed users" policy above (Access evaluates any matching policy as allow).
#
# INVARIANTS. Existing policies are never removed. The service token itself is
# never created, rotated or echoed -- only its id travels in this script's
# environment. No operator-account administrator credential is required here.
if [ -n "${ACCESS_SERVICE_TOKEN_ID:-}" ]; then
  MACHINE_POLICY_NAME="${SUBDOMAIN} Command Center automation"

  echo "==> Reconciling machine (service-token) policy '${MACHINE_POLICY_NAME}'..." >&2

  MACHINE_POLICY_JSON=$(echo "$POLICIES" | MACHINE_POLICY_NAME="$MACHINE_POLICY_NAME" python3 -c "
import json, os, sys
name = os.environ['MACHINE_POLICY_NAME']
data = json.load(sys.stdin)
for p in data.get('result', []) or []:
    if p.get('name') == name:
        print(json.dumps(p))
        break
" || true)

  MACHINE_POLICY_BODY=$(ACCESS_SERVICE_TOKEN_ID="$ACCESS_SERVICE_TOKEN_ID" python3 -c "
import json, os
print(json.dumps({
    'name': os.environ['MACHINE_POLICY_NAME'],
    'decision': 'non_identity',
    'include': [{'service_token': {'token_id': os.environ['ACCESS_SERVICE_TOKEN_ID']}}],
}))
")

  if [ -n "$MACHINE_POLICY_JSON" ]; then
    MACHINE_POLICY_ID=$(echo "$MACHINE_POLICY_JSON" | json_extract id)
    MACHINE_POLICY_TOKEN=$(echo "$MACHINE_POLICY_JSON" | python3 -c "
import json, sys
p = json.load(sys.stdin)
for entry in p.get('include') or []:
    token = (entry or {}).get('service_token') or {}
    if token.get('token_id'):
        print(token['token_id'])
        break
")
    if [ "$MACHINE_POLICY_TOKEN" = "$ACCESS_SERVICE_TOKEN_ID" ]; then
      echo "    Machine policy already correct on App ${APP_ID} (id=${MACHINE_POLICY_ID}). Skipping." >&2
    else
      echo "    Machine policy exists with a different service token — updating in place (id=${MACHINE_POLICY_ID})." >&2
      cf_call PUT "/apps/${APP_ID}/policies/${MACHINE_POLICY_ID}" "$MACHINE_POLICY_BODY" >/dev/null
    fi
  else
    echo "    Creating machine policy (non_identity, one existing service token; every other policy preserved)." >&2
    cf_call POST "/apps/${APP_ID}/policies" "$MACHINE_POLICY_BODY" >/dev/null
  fi
  echo "    Machine policy reconciled on App ${APP_ID}." >&2
else
  echo "==> ACCESS_SERVICE_TOKEN_ID unset — no machine (service-token) policy reconciled." >&2
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
  Session length   : 720h (30 days)
  Login methods    : ${LOGIN_METHODS_SUMMARY}
  Allowed emails   : ${EMAILS[*]}

Copy these into the deployment .env so the Next.js middleware can verify
the Cloudflare Access JWT:

  CF_ACCESS_TEAM_DOMAIN=<your-team>.cloudflareaccess.com
  CF_ACCESS_AUD=${APP_AUD}

EOF
