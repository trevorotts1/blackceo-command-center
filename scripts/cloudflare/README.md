# Cloudflare Access setup

One-shot provisioner for the Cloudflare Access app that gates every BlackCEO
v4.0 client subdomain. Implements PRD Section 7.2 (P1-10).

## Prerequisites

1. **Cloudflare account with Zero Trust enabled.** Free tier signup is
   instant at `https://one.dash.cloudflare.com`. Free up to 50 users across
   the entire account.
2. **The client subdomain is already on Cloudflare DNS** (a proxied CNAME or
   A record pointing at the deployment).
3. **A Cloudflare API token** scoped to the account with:
   - `Access: Apps and Policies` -> Edit
   - `Access: Identity Providers` -> Edit
   - `Account: Read`

   Create at `https://dash.cloudflare.com/profile/api-tokens` using the
   "Create Custom Token" flow.
4. **Your Cloudflare account ID.** Visible in the right sidebar of any zone
   page on `dash.cloudflare.com`, or via `wrangler whoami`.

Export both values before running:

```bash
export CLOUDFLARE_API_TOKEN="cf_token_xxxxxxxxxxxxxxxx"
export CLOUDFLARE_ACCOUNT_ID="00000000000000000000000000000000"
```

## Usage

```bash
./scripts/cloudflare/setup-access-app.sh <subdomain> <operator-email> [more-emails...]
```

Example:

```bash
./scripts/cloudflare/setup-access-app.sh client.zerohumanworkforce.com trevor@blackceo.com
```

Multiple operator emails are supported by listing them after the subdomain.

## What it does

1. **Ensures a One-Time PIN identity provider exists** on the account. If
   one is already configured (any prior client setup), it is reused.
2. **Detects an account-level Google identity provider.** The script never
   creates one -- that is a one-time, account-level OAuth setup only the
   operator can authorize (dashboard: Zero Trust -> Settings ->
   Authentication -> Login methods -> Google). If Google is found, its id is
   attached to the app's `allowed_idps` alongside One-Time PIN. If not, the
   script prints a loud `WARNING` and falls back to PIN-only -- PIN keeps
   working either way.
3. **Creates (or updates) a self-hosted Access Application** bound to the
   subdomain with a 336-hour (14-day) session duration and `allowed_idps`
   set to whichever of One-Time PIN / Google are available. If an app for
   that exact domain already exists and Google has newly become available
   since it was created, the script attaches Google to it. **Ownership
   note:** that attach call is a Cloudflare `PUT /apps/{id}`, which REPLACES
   the app record with exactly the fields the script sends (name, domain,
   type, session_duration, allowed_idps) -- any option set by hand in the
   dashboard on that app (app launcher visibility, a custom deny page, CORS,
   etc.) is reset to Cloudflare's default by this call. This script owns and
   re-asserts only those 5 fields on every app it touches; re-apply any
   hand-set option after running the script if one is needed.
4. **Attaches an Allow policy** named "Allowed users" that includes the
   supplied operator email(s). The policy does not restrict login method --
   that is enforced once, at the app level, via `allowed_idps` above. If a
   policy with that name already exists on the app, the script GETs it and,
   **only if it still carries the old `require: login_method=onetimepin`
   clause** (the restriction the pre-P1-08 version of this script always
   attached), PUTs it back with that clause removed -- name, decision, and
   the existing email `include` list are preserved. A policy that is
   already clean is left untouched; no other field is ever modified.

## Idempotency

Safe to re-run. The script checks for the existing IdP, Application,
Application `allowed_idps`, and Policy before any create/update call. On a
second run for the same subdomain you will see "already exists" /
"already has Google attached" / "no login_method restriction to remove"
lines on stderr and the same Application UUID + AUD on stdout. The only
mutations on an already-existing app are: attaching Google to
`allowed_idps` the first time it becomes available at the account level,
and removing a stale `login_method` require clause from the "Allowed
users" policy if one is found and Google is available to attach.

**Residue on apps provisioned before this fix:** pulling this fix into the
repo does not change anything on a box until the script is actually run
again against it -- the stale policy clause lives in Cloudflare's API, not
in this repo. Blast radius is every app created by a pre-P1-08 checkout
(unmeasured until the P6-01 per-box probe runs); remediation is re-running
this script against the affected subdomain, which is safe (idempotent) and
touches only the `require` field of an already-existing policy.

To change the allow-list (the email `include` set) after the fact, edit
the policy via the Cloudflare dashboard (Zero Trust -> Access ->
Applications -> [your app] -> Policies) or PUT it via the API directly --
this script does not add or remove emails from an existing policy, only
reconciles the login-method restriction described above.

## Output env vars

The script prints the values you need to drop into the deployment `.env`
so the Next.js middleware can verify the Cloudflare Access JWT:

```env
CF_ACCESS_TEAM_DOMAIN=<your-team>.cloudflareaccess.com
CF_ACCESS_AUD=<Application AUD tag printed by the script>
```

`CF_ACCESS_TEAM_DOMAIN` is the team subdomain you chose when enabling Zero
Trust. `CF_ACCESS_AUD` is the per-application audience tag printed at the
end of the script run.

## Verifying the login posture (`probe-access-login.sh`)

`probe-access-login.sh` is a separate, read-only probe that answers "is
Cloudflare Access actually gating this hostname" from the outside, by
issuing one unauthenticated request:

```bash
./scripts/cloudflare/probe-access-login.sh <cc-hostname> [service-token-id] [service-token-secret]
```

It exits `0` (protected: the hostname redirected off-origin to an Access
login page), `1` (`cc_unprotected`: the hostname answered 200 with no gate
at all -- this is the condition that should be flagged to the operator
lane), or `3` (unknown/ambiguous -- network error, or a same-origin redirect
that isn't confirmed to be an Access login page). This script is built and
QC'd as part of P1-08 but is wired into the fleet's per-box validation only
in the final P6-01 roll -- it is not invoked against any live client box by
this repo's build/deploy scripts on its own.

## Troubleshooting

- **HTTP 401** from the Cloudflare API: the API token is invalid, expired,
  or wasn't exported into the current shell. Re-issue and re-export.
- **HTTP 403** from the Cloudflare API: the token authenticated but lacks
  scope. Edit the token and add `Access: Apps and Policies -> Edit` and
  `Access: Identity Providers -> Edit`.
- **HTTP 404** from the Cloudflare API: `CLOUDFLARE_ACCOUNT_ID` is wrong
  for this token, or the token is scoped to a different account. Confirm
  the ID at `dash.cloudflare.com` (right sidebar on any zone page).
- **No Application UUID printed**: the API returned a 2xx but the JSON
  shape was unexpected. The raw response is logged to stderr by the
  script's `cf_call` helper; capture it and check against the Cloudflare
  Access API reference.
