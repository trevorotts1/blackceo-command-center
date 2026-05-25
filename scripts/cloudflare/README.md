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
2. **Creates a self-hosted Access Application** bound to the subdomain with
   a 336-hour (14-day) session duration. If an app for that exact domain
   already exists, the script reuses it.
3. **Attaches an Allow policy** named "Allowed users" that includes the
   supplied operator email(s) and requires One-Time PIN login. If a policy
   with that name already exists on the app, it is left in place.

## Idempotency

Safe to re-run. The script checks for the existing IdP, Application, and
policy before any create call. On a second run for the same subdomain you
will see "already exists" lines on stderr and the same Application UUID +
AUD on stdout.

To change the allow-list after the fact, edit the policy via the Cloudflare
dashboard (Zero Trust -> Access -> Applications -> [your app] -> Policies)
or PUT it via the API directly. This script intentionally does not mutate
an existing policy.

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
