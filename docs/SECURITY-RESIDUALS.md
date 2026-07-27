# SECURITY-RESIDUALS — U052

**Date:** 2026-07-27
**Author:** U052 (passthrough write scope)

## What was closed

**38 routes**, reachable with no credential via a forged same-origin header, are now gated by `BEARER_REQUIRED_WRITE_ROUTES` in `src/middleware.ts`. A caller without a valid `Authorization: Bearer` token receives a 401 on those routes. The exact 38 routes are listed in the `BEARER_REQUIRED_WRITE_ROUTES` array (35 regex patterns; three use the `(\/[^/]+)?` collection-or-item form and each covers two routes).

## What remains open — 61 routes

**61 mutating `/api/*` routes** remain reachable with no credential via the same-origin passthrough because **the browser interface itself calls them with no credential**. Route-level scoping cannot close them — any list that does would 401 the interface's own writes.

### Three worst (by severity)

| Route | Reason |
|---|---|
| `/api/system/converge` | Full system convergence — triggers the deployment pipeline |
| `/api/system/bootstrap` | System initialisation — seeds the entire application state |
| `/api/clients/{id}/keys` | API key management — creates/rotates client authentication keys |

### How they stay open

1. The same-origin passthrough in `middleware.ts` relies on `Origin`/`Referer` headers, which are client-settable.
2. `requiresBearerForWrite()` deliberately excludes the 61 interface-called routes — gating them would 401 the interface's own writes.
3. The code comment at the passthrough explicitly documents this residual.

### Closing them

Two paths exist; neither is a code change in `middleware.ts`:

- **Part B** — Set `REQUIRE_CF_ACCESS=true`. The middleware's own comment states this closes the residual at the edge for every route. Requires the box to be genuinely fronted by Cloudflare Access with every operator granted access.
- **Part C** — Introduce a signed, server-issued, session-bound token the browser holds and an attacker cannot reproduce. Requires introducing a session concept.

### Rejected approaches (per U052 Part C)

- **`Sec-Fetch-Site: same-origin`**: Browsers set it honestly, but a non-browser caller can send any header it likes. Defends against cross-site, not against the direct-to-origin caller.
- **Unsigned double-submit cookie/header pair**: An attacker who can set headers can set both halves to the same arbitrary value.

### Interface call census

The 61 interface-kept routes were determined by intersecting (a) all 104 `POST`/`PATCH`/`PUT`/`DELETE`-exporting routes under `src/app/api/` with (b) every mutating `fetch()` call in `src/` outside `src/app/api/`. The anti-rot test at `src/lib/__tests__/passthrough-write-scope.test.ts` asserts this intersection — a new route added without classification, or a new interface call site to a listed route, fails the test.
