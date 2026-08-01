# SECURITY-RESIDUALS — U052

**Date:** 2026-07-27
**Author:** U052 (passthrough write scope)

## What was closed

**38 routes**, reachable with no credential via a forged same-origin header, are now gated by `BEARER_REQUIRED_WRITE_ROUTES` in `src/middleware.ts`. A caller without a valid `Authorization: Bearer` token receives a 401 on those routes. The exact 38 routes are listed in the `BEARER_REQUIRED_WRITE_ROUTES` array (35 regex patterns; three use the `(\/[^/]+)?` collection-or-item form and each covers two routes).

## What remains open — 63 routes

> **Updated 2026-07-29.** Two mutating routes were added after this document was
> written and are also interface-called, taking the open set from 61 to 63:
> `POST /api/tasks/{id}/resume` (called by `src/components/TaskOverviewPanels.tsx:482`)
> and `POST /api/tasks/{id}/persona-choice` (called by
> `src/components/PersonaPickerPanel.tsx:101`). Both were briefly considered for
> `BEARER_REQUIRED_WRITE_ROUTES`; adding them would 401 the interface's own
> resume button and persona picker, which is precisely the failure mode the
> "How they stay open" note below describes. They are therefore **accepted
> residuals on the existing rationale**, not new exemptions — and the anti-rot
> lock's interface-call assertion is what forced this to be a recorded decision
> instead of a silent one.

**63 mutating `/api/*` routes** remain reachable with no credential via the same-origin passthrough because **the browser interface itself calls them with no credential**. Route-level scoping cannot close them — any list that does would 401 the interface's own writes.

### Three worst (by severity)

| Route | Reason |
|---|---|
| `/api/system/converge` | Full system convergence — triggers the deployment pipeline |
| `/api/system/bootstrap` | System initialisation — seeds the entire application state |
| `/api/clients/{id}/keys` | API key management — creates/rotates client authentication keys |

### How they stay open

1. The same-origin passthrough in `middleware.ts` relies on `Origin`/`Referer` headers, which are client-settable.
2. `requiresBearerForWrite()` deliberately excludes the 63 interface-called routes — gating them would 401 the interface's own writes.
3. The code comment at the passthrough explicitly documents this residual.

### Closing them

Two paths exist; neither is a code change in `middleware.ts`:

- **Part B** — Set `REQUIRE_CF_ACCESS=true`. The middleware's own comment states this closes the residual at the edge for every route. Requires the box to be genuinely fronted by Cloudflare Access with every operator granted access.
- **Part C** — Introduce a signed, server-issued, session-bound token the browser holds and an attacker cannot reproduce. Requires introducing a session concept.

### Rejected approaches (per U052 Part C)

- **`Sec-Fetch-Site: same-origin`**: Browsers set it honestly, but a non-browser caller can send any header it likes. Defends against cross-site, not against the direct-to-origin caller.
- **Unsigned double-submit cookie/header pair**: An attacker who can set headers can set both halves to the same arbitrary value.

### MR-23 status (signed CSRF cookie, `src/lib/csrf-protection.ts`)

MR-23 added a signed `mc_csrf_token` double-submit cookie (httpOnly + SameSite=Strict + HMAC-SHA256) that the middleware mints on non-API page responses and verifies on every mutating same-origin `/api/*` passthrough. Its actual coverage, verified by test:

- **Closes cross-site CSRF** — SameSite=Strict means a foreign site's request never carries the cookie.
- **Closes unsigned double-submit forgery** — the value is HMAC-signed, so a third party cannot mint one (the rejected approach above).
- **Does NOT close the direct-to-origin forgery this section names.** The token is minted on UNAUTHENTICATED public page loads (e.g. `/interview`), so a non-browser caller reaching the origin directly harvests a valid signed token and replays it with a forged `Origin`/`Referer`. The signature proves the server minted the token, not that the presenter is the operator, so it cannot defeat harvest-and-replay. (Reproduced: GET a gate-exempt page → read `Set-Cookie: mc_csrf_token=…` → DELETE `/api/tasks/:id` with that cookie + a forged same-origin `Referer` and no bearer → passthrough 200.)

Therefore the direct-to-origin residual is closed **only by Part B** (`REQUIRE_CF_ACCESS=true`): Layer 1 rejects any request lacking the Cloudflare-Access edge assertion before the passthrough runs. The CSRF cookie is defense-in-depth for the cross-site and unsigned-forgery vectors; it is not a substitute for CF Access on the direct-forgery vector.

**Secret hygiene (fix2).** The CSRF cookie is HMAC-signed with a key that resolves from a DEDICATED var first — `MC_CSRF_COOKIE_SECRET` — then falls back to `MC_INTERVIEW_COOKIE_SECRET` → `MC_API_TOKEN` → `WEBHOOK_SECRET` → a public dev fallback (which hard-locks sign/verify in production). The dedicated var decouples CSRF signing from the API token lifecycle: `MC_API_TOKEN` is the credential an external caller presents, so sharing it as an HMAC key would widen the blast radius of a token leak into cookie forgery. Operators should set `MC_CSRF_COOKIE_SECRET` explicitly (see `.env.example`). This does not close the harvest-and-replay residual above — only `REQUIRE_CF_ACCESS=true` does — but it keeps the CSRF signature from being keyed on a credential that crosses the trust boundary.

### Interface call census

The interface-kept routes (61 at authoring, 63 as of 2026-07-29) were determined by intersecting (a) all 106 `POST`/`PATCH`/`PUT`/`DELETE`-exporting routes (104 at authoring; 106 as of 2026-07-29) under `src/app/api/` with (b) every mutating `fetch()` call in `src/` outside `src/app/api/`. The anti-rot test at `src/lib/__tests__/passthrough-write-scope.test.ts` asserts this intersection — a new route added without classification, or a new interface call site to a listed route, fails the test.
