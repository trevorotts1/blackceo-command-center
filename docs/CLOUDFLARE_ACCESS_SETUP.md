# Cloudflare Access Setup

This guide explains how to put a per-client BlackCEO Command Center subdomain behind Cloudflare Access so that only the client's email address can reach the dashboard. Reference: PRD Section 7 (Authentication) and the post-build-fixes doc P1-10.

The recommended path is the automated script. The manual dashboard path is documented below as a fallback.

## What Cloudflare Access provides

  - Edge-enforced login on every request. Cloudflare validates the user's email through a one-time PIN flow before forwarding the request to the origin.
  - A signed `Cf-Access-Jwt-Assertion` header injected on every authorized request, which the app verifies in middleware.
  - No password to manage. The client receives a 6-digit code by email at sign-in.
  - Session length is configurable per Access app. Our default is 336 hours (14 days).

The Cloudflare Access JWT is independent of any in-app session. `REQUIRE_CF_ACCESS` is OPT-IN and defaults OFF on every box (v4.72.0). Set `REQUIRE_CF_ACCESS=true` ONLY on a box that is genuinely fronted by Cloudflare Access — it adds a page-level edge gate (defense-in-depth) on top of the always-on MC_API_TOKEN bearer / WEBHOOK_SECRET HMAC gates. Do NOT set it true on a plain Cloudflare Tunnel box with no Access app: with no edge injecting `Cf-Access-Jwt-Assertion`, enforcement 401s every route and blanks the board. The board's own data always renders via the same-origin passthrough regardless of this flag.

## Prerequisites

Before you run the setup script you need:

  1. A Cloudflare account that owns the zone (for example `zerohumanworkforce.com`).
  2. A Cloudflare API token with these scopes:
     - Account: Access Apps Read, Access Apps Edit
     - Account: Access Policies Read, Access Policies Edit
     - Account: Access Identity Providers Read, Access Identity Providers Edit
     - Zone: Zone Read
     - Zone: DNS Read
     Create the token at https://dash.cloudflare.com/profile/api-tokens. Use the "Custom Token" template and add the scopes above.
  3. The Cloudflare Account ID. Find it in the right sidebar of any zone overview page.
  4. The Zone ID for the parent zone the client subdomain belongs to.
  5. The fully-qualified client subdomain (for example `acme.zerohumanworkforce.com`). DNS must already resolve to the Cloudflare Tunnel that fronts the client's BlackCEO origin.
  6. The client's primary email address. This becomes the one allowed identity on the policy.

Export these into the shell before running the script:

```bash
export CLOUDFLARE_API_TOKEN=...
export CLOUDFLARE_ACCOUNT_ID=...
export CLOUDFLARE_ZONE_ID=...
```

## Automated setup (5 steps)

The setup script is at [`../scripts/cloudflare/setup-access-app.sh`](../scripts/cloudflare/setup-access-app.sh). It is created by P1-10 in the v4.0.1 fix pass. See [`../scripts/cloudflare/README.md`](../scripts/cloudflare/README.md) for the canonical usage block.

  1. Confirm DNS for the client subdomain resolves to the Cloudflare Tunnel. `dig acme.zerohumanworkforce.com +short` should return the orange-cloud proxied address.
  2. Confirm the API token has the scopes listed above by running `curl -s -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" https://api.cloudflare.com/client/v4/user/tokens/verify | jq .success`. Expect `true`.
  3. Run the script with the subdomain and the client email as positional arguments:
     ```bash
     ./scripts/cloudflare/setup-access-app.sh acme.zerohumanworkforce.com owner@acme.com
     ```
  4. The script creates (in order):
     - A One-Time PIN identity provider on the account if one does not exist.
     - An Access Application that protects `acme.zerohumanworkforce.com/*`.
     - A policy named `allow-owner` that includes only `owner@acme.com` via the One-Time PIN IdP.
     - Session duration is set to `336h` (14 days). This means the client logs in once every two weeks at most.
  5. The script prints the new App UUID and Policy UUID. Save both into the client's row in the operator's client registry. You will need them to add more emails or revoke access later.

If any step returns non-200 from the Cloudflare API, the script aborts before creating downstream resources. Re-run after fixing the failing call. The script is idempotent on the IdP and App but creates a new Policy on every run, so always check for and delete duplicate policies if you re-run.

## Manual setup fallback

If you cannot run the script (for example you are on a workstation without bash, or the API is being rate-limited), do this in the Cloudflare dashboard:

  1. Go to Zero Trust > Settings > Authentication. Under Login methods click Add. Choose One-time PIN. Save.
  2. Go to Zero Trust > Access > Applications. Click Add an application. Choose Self-hosted.
  3. Fill in:
     - Application name: `BlackCEO - <client-slug>` (for example `BlackCEO - Acme`)
     - Session duration: 14 hours by default in the UI. Click the field and switch to a custom value of `336h`. The free Zero Trust plan caps at 720h.
     - Application domain: subdomain `acme`, domain `zerohumanworkforce.com`, path empty so it covers `/*`.
  4. Click Next. On the Identity providers step, leave only One-time PIN checked.
  5. Click Next. On the Policies step, click Add a policy.
     - Policy name: `allow-owner`
     - Action: Allow
     - Session duration: same as the app
     - Include: Emails, then add `owner@acme.com`
  6. Click Next, then Add Application. Cloudflare will return the App UUID. Copy it into the client registry.
  7. Visit `https://acme.zerohumanworkforce.com` in an incognito window. You should see the Cloudflare Access PIN screen, not the BlackCEO dashboard.

## Adding more emails to a policy

Use the script's `add-email` mode if you have it, otherwise patch the policy directly:

```bash
# Append a new email to the existing allow-owner policy
APP_UUID=...        # from the original setup
POLICY_UUID=...     # from the original setup

curl -s -X PUT \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  -H "Content-Type: application/json" \
  "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/access/apps/$APP_UUID/policies/$POLICY_UUID" \
  -d '{
    "name": "allow-owner",
    "decision": "allow",
    "include": [
      { "email": { "email": "owner@acme.com" } },
      { "email": { "email": "assistant@acme.com" } }
    ]
  }'
```

Alternatively, in the dashboard, open the App, open the policy, and add the new email under Include > Emails. Save.

The new email gets access on their next request. No restart, no cache flush. They will receive a One-Time PIN by email.

## Revoking access

To remove a single user:

  1. In Zero Trust > Access > Applications, click the client's app.
  2. Open the policy. Under Include > Emails, delete the email and save.
  3. Force-revoke any active sessions for that email via Zero Trust > My Team > Users > select user > Revoke sessions.

To kill access for the entire app (for example during a security incident):

  1. Zero Trust > Access > Applications. Click the three-dot menu next to the app. Delete.
  2. Alternatively, edit the policy to `decision: "deny"` so all requests fail closed without removing the app config.

The Cloudflare Tunnel does NOT need to be touched to revoke. The Tunnel is the data path. Access is the auth layer in front of it.

## Troubleshooting

### 401 / 403 with "user is not authorized"

  - The user's email is not on the policy. Add it (see above) or check the spelling.
  - The policy was created on a different identity provider than the one the user signed in with. Edit the policy to include the One-Time PIN IdP and re-save.

### Missing `Cf-Access-Jwt-Assertion` header at the origin

  - The Tunnel is bypassing Access. Confirm the Access app's domain field matches the subdomain the Tunnel is publishing.
  - The Tunnel hostname is on the `tunnel` table but the app is on a different domain (typo). Re-create the Access app with the correct domain.
  - Check `/api/system/status` in the dashboard. The `cloudflare_access` probe (see P1-12) reports degraded when the header has not been seen in the last 30 seconds.

### Session expires immediately after sign-in

  - The Access app's session duration is set to `0h` (sometimes happens after a manual edit). Set it to `336h`.
  - The user is using a browser that blocks third-party cookies and the Cloudflare login redirect cannot complete. Tell them to allow `*.cloudflareaccess.com` cookies or to use a different browser.

### PIN email never arrives

  - Check spam folder. Cloudflare sends from `noreply@notify.cloudflare.com`.
  - Confirm the user's email on the policy matches exactly what they typed at the PIN prompt. Cloudflare is case-insensitive on the local part but it will still reject if the domain part has a typo.
  - Try the magic link option if it is enabled on the One-Time PIN IdP settings.

### Operator override for local development

  - `REQUIRE_CF_ACCESS` defaults OFF (opt-in, v4.72.0), so local dev needs no override to skip the JWT verification middleware. Set `REQUIRE_CF_ACCESS=true` only on a box actually fronted by Cloudflare Access. The middleware logs an informational notice at boot when it is off (the default).

## References

  - PRD Section 7 (Authentication) for the in-app middleware that verifies the JWT.
  - Post-build-fixes Section 7.2 for the onboarding flow that invokes this script.
  - Cloudflare Zero Trust docs: https://developers.cloudflare.com/cloudflare-one/applications/configure-apps/self-hosted-apps/
  - One-Time PIN IdP: https://developers.cloudflare.com/cloudflare-one/identity/one-time-pin/
  - API reference for Access Apps: https://developers.cloudflare.com/api/operations/access-applications-list-access-applications
