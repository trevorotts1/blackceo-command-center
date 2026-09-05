# Tenant authentication and interview synchronization rollout

This release closes application-level hostname/header trust. Deploying it before registering the intended host and identity can deny existing browser sessions. Prepare and verify the configuration before promotion. Unknown hosts never select the operator's installation.

## Register each dedicated client installation

Set `MC_INSTALLATION_ID` to the installation's stable ID and provide `MC_API_TOKEN` for authenticated machine calls. Set `MC_TENANT_SESSION_SECRET` (or reuse the existing protected `MC_INTERVIEW_COOKIE_SECRET`/`MC_API_TOKEN` fallback), with consistent secrets across application processes. Register the exact external hostname in `MC_TENANT_REGISTRY_JSON`:

```json
{
  "company.example.com": {
    "kind": "self",
    "tenantId": "tenant-stable-id",
    "companyId": "exact-companies-table-id",
    "installationId": "installation-stable-id",
    "issuer": "https://your-team.cloudflareaccess.com",
    "audience": "access-application-audience",
    "subjects": ["verified-access-subject-id"]
  }
}
```

Company IDs and installation IDs are identifiers verified against the installation, not guessed slugs or names. Cloudflare authentication validates RS256 signatures from the pinned issuer certificate endpoint, issuer, audience, expiry, and the registered subject list. Trusting `cf-ray`, an email, or an unsigned JWT is insufficient. Ensure the origin is reachable only through the intended ingress as an independent protection. Never commit live credentials or tokens in registry examples.

An alternative browser login is an operator-issued one-use invitation. With protected signing configuration loaded on the operator machine, run:

```sh
npx tsx scripts/mint-interview-enrollment.ts company.example.com owner-subject-id
```

The command prints a 15-minute enrollment link and sends no messages. Deliver it through an explicitly authorized channel. Its fragment is removed by the interview page before redemption, and the server exchanges it for a host/tenant/installation-bound, httpOnly session valid for one hour. It cannot be reused after redemption. Provide a fresh invitation when expired. The ordinary page's CSRF cookie still protects browser mutations. Operator bypass requires an operator identity; it is not a general client authorization mechanism.

## Shared interview/board front end

Register the shared client-facing hostname with `kind: "client"`, the same tenant/company/installation IDs as the intended dedicated receiver, and its existing `clientId` from the shared clients table. Add `remoteUrl` (the dedicated installation's HTTPS origin), `remoteApiToken` (that installation's machine API token), and `remoteSecret` (a distinct interview protocol HMAC secret). Configure the same HMAC secret as `MC_INTERVIEW_REMOTE_SECRET` on the dedicated installation. Never substitute the shared operator's token or URL.

The client gateway record must identify that client's gateway for conversational interview turns. Missing gateway configuration returns unavailable; it cannot fall back to the operator. Gateway configuration changes invalidate cached connections.

Remote board calls proxy to the exact dedicated origin with its machine token. They send no browser cookies, reject redirects, and require the authenticated response's `x-installation-id` to match. All interview commands use `interview.v1`, signed tenant/company/installation/interview/operation identity and expiry, plus capability negotiation. A missing/old/unconfigured receiver remains explicitly unavailable. Upgrade the dedicated receiver and prove the handshake before enabling the shared producer.

## Verify before rollout

Call the registered dedicated host's read-only endpoint with its own bearer token:

```text
GET /api/auth/tenant-ready?requireRemoteReceiver=1
Authorization: Bearer <dedicated MC_API_TOKEN>
```

Require status 200 and exact `{ready:true, protocol:"interview.v1", kind:"self", tenantId, companyId, installationId, host, missing:[]}` matching the intended installation. Require `x-installation-id` to match for proxied board use. The optional `requireRemoteReceiver=1` requires the remote HMAC receiver configuration; it is not required for a client using only its own local mini-app. HTTP 403/503, missing target configuration, or identity mismatch is a failed verification. Do not mark onboarding handoff or tenant connectivity verified from configuration text alone.

Test two isolated tenants plus operator: login, answer/save, reload, review/export, remote canonical synchronization, decisions, completion/QC, exact build receipt, redirect to the correct board, and SSE reconnect. Confirm foreign session/task/workspace IDs and copied cookies never reveal another tenant's data. No live client smoke action is implied by publishing this release.

## Durable answers, retries, and recovery

The shared front end saves encrypted answer content and its outbox operation transactionally before reporting saved. Local save and remote synchronization are different statuses. Question IDs are derived from committed answers; mirrors cannot claim a save that failed. The `interview-outbox` sweep retries the oldest pending operation per configured client every two minutes, with capped exponential backoff and five attempts; authenticated state refresh also attempts bounded catch-up. Later writes do not overtake earlier pending writes. Original requester identity remains in the durable operation.

Receiver receipts fence duplicate operation IDs. A known remote rejection is recorded distinctly from an accepted action, and can be corrected with a new request. If the receiver crashes after claiming an operation but before recording its outcome, it returns `unknown` for retries and does not blindly repeat the action. An operator must reconcile the actual canonical answer/decision/build result against the operation before retrying or issuing a new operation. This conservative path prevents duplicate external work; automatic crash reconciliation is not yet implemented. An unanswered pending operation with five failed deliveries requires operator repair and requeue, with its original operation identity retained.

Completion returns the acknowledged installation and build ID when available; a QC pass without a build identity stays in awaiting-build handoff. Interview completion, dashboard access, build QC, and ready-for-task execution are separate states. The existing canonical Skill 23 scripts continue to enforce transcript/consent/department/QC requirements on the client installation.

Additive migration 132 creates enrollment replay records, tenant interview/session reservations, encrypted answer history, remote operations, and receiver receipts. Rollback should preserve these tables and pending work while disabling unsupported producers. Do not delete answer history, reset receipt claims, weaken authentication, or redirect a queued operation to another company as a rollback shortcut.


Readiness also requires an explicit `MC_PERSONA_COMPANY_CONTEXTS_JSON` entry for the installation's canonical company ID, with absolute `companyRoot` and `companyConfig`, `companySlug`, and `personaCatalog` (or the default `coaching-personas/persona-categories.json` under that root). The root and company config must validate and the catalog must be readable JSON. The probe returns503 with `persona_company_context_or_catalog` while these prerequisites are missing; do not override the installer gate to conceal a dispatch configuration failure.
