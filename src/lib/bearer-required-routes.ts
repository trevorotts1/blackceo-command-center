/**
 * Mutating /api/* routes the BROWSER INTERFACE never calls, and which therefore have no
 * legitimate tokenless caller. The same-origin passthrough in src/middleware.ts
 * trusts client-settable Origin/Referer headers; without this list, a forged header
 * reaches 99 mutating routes with no credential of any kind.
 *
 * Derived 2026-07-26 by intersecting (a) every route under src/app/api exporting
 * POST/PATCH/PUT/DELETE with (b) every mutating fetch() in src/ outside src/app/api.
 * 104 mutating routes; 5 already excluded by isWebhookSecretRoute; 99 reachable;
 * 61 needed by the interface; 38 listed here as 35 patterns -- three use the
 * (\/[^/]+)? collection-or-item form and each covers two routes, so this array's
 * .length is 35, not 38. Checksum 32 + (3 x 2) = 38 routes, and 61 + 38 = 99.
 *
 * 2026-09-08 (F38, W2 batch): +1 pattern for POST /api/social/media/{id}
 * (company-bound asset-register ingest; the browser player only ever GETs, so
 * no legitimate tokenless POST caller exists). Now 39 patterns covering 42
 * routes; see the U052 lock test for the live census.
 *
 * 2026-09-09 (F27, W3 batch): +2 patterns — POST /api/social-theme/invitations
 * and POST /api/social-theme/renew are OPERATOR/SERVICE surfaces (the browser
 * mini-app client never calls them; delivery automation does), so they are
 * bearer-gated. The five client-facing routes under /api/social-theme/* are
 * deliberately NOT on this list: their browsers hold NO mc_tenant_session, the
 * middleware exempts the namespace (routes verify their own narrow
 * social-theme session capability), and each mutating route enforces MR-23
 * CSRF + same-origin in its own handler.
 *
 * 2026-09-09 (F40, W4 batch, integration commit): +1 pattern for POST
 * /api/social/performance — provider-metrics ingest seam (service-to-service,
 * same class as F38's asset-register ingest). The browser interface never
 * calls it (the review job reads the DB directly), so no legitimate tokenless
 * POST caller exists. Now 42 patterns covering 45 routes.
 *
 * This list is NOT the whole fix. 61 routes -- including /api/system/converge,
 * /api/system/bootstrap and /api/clients/{id}/keys -- must stay open because the
 * interface calls them with no credential, and no route list can close them.
 * See docs/SECURITY-RESIDUALS.md and U052 Parts B and C.
 *
 * MAINTENANCE: a new interface call site to a listed route will 401. Re-derive with the
 * test in src/lib/__tests__/passthrough-write-scope.test.ts, which fails when this
 * list and the codebase disagree -- so the list cannot rot silently.
 *
 * U052: This is the single source of truth, imported by both src/middleware.ts
 * and the anti-rot lock test. One array, one source.
 */
export const BEARER_REQUIRED_WRITE_ROUTES: RegExp[] = [
  /^\/api\/auth\/interview-invitation$/,
  /^\/api\/ad-campaigns(\/[^/]+)?$/,
  /^\/api\/agents$/,
  /^\/api\/agents\/[^/]+\/memory-logs$/,
  /^\/api\/agents\/[^/]+\/openclaw$/,
  /^\/api\/anthology\/gate$/,
  /^\/api\/bugs(\/[^/]+)?$/,
  /^\/api\/campaigns\/[^/]+$/,
  /^\/api\/clients$/,
  /^\/api\/companies$/,
  /^\/api\/cron\/sop-learning$/,
  /^\/api\/da-challenges$/,
  /^\/api\/departments\/[^/]+\/config$/,
  /^\/api\/execution-queue(\/[^/]+)?$/,
  /^\/api\/files\/upload$/,
  /^\/api\/harvest-cards\/[^/]+\/approve$/,
  /^\/api\/interview\/send-link$/,
  /^\/api\/logo$/,
  /^\/api\/openclaw\/sessions$/,
  /^\/api\/operator\/journal\/[^/]+$/,
  /^\/api\/operator\/memory\/search$/,
  /^\/api\/operator\/notebook\/[^/]+$/,
  /^\/api\/operator\/tts$/,
  /^\/api\/recommendations$/,
  /^\/api\/recommendations\/[^/]+\/outcome$/,
  /^\/api\/social\/media\/[^/]+$/,
  /^\/api\/social\/performance$/,
  /^\/api\/social-theme\/invitations$/,
  /^\/api\/social-theme\/renew$/,
  /^\/api\/sops\/(?!feedback$|proposals$)[^/]+$/,
  /^\/api\/sops\/import-role-library$/,
  /^\/api\/tasks\/[^/]+\/activities$/,
  /^\/api\/tasks\/[^/]+\/deliverables$/,
  // PRES-010 — presentation run registration is a PRODUCER-ONLY surface (the
  // presentation engine stamps its run root; the board UI never calls it). An
  // unlisted write route would fall through the same-origin passthrough on a
  // forged Origin/Referer (U052 residual); gating it here keeps registration
  // reachable ONLY with the MC_API_TOKEN bearer, like ingest.
  /^\/api\/presentations\/runs$/,
  /^\/api\/tasks\/[^/]+\/messages$/,
  /^\/api\/tasks\/[^/]+\/planning\/approve$/,
  /^\/api\/tasks\/[^/]+\/rating$/,
  /^\/api\/tasks\/[^/]+\/return-to-orchestrator$/,
  /^\/api\/tasks\/[^/]+\/subagent$/,
  /^\/api\/tasks\/[^/]+\/test$/,
  // FIX 35 (spec REV 3): audit-backfill is a hygiene-job-only surface (the
  // browser interface never calls it). Bearer-gated so the destructive-
  // confirmation backfill is reachable ONLY with MC_API_TOKEN + HMAC.
  /^\/api\/tasks\/[^/]+\/audit-backfill$/,
  /^\/api\/weight-profiles$/,
  /^\/api\/workspaces\/[^/]+$/,
];

export const READ_ONLY_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function requiresBearerForWrite(pathname: string, method: string): boolean {
  if (READ_ONLY_METHODS.has(method.toUpperCase())) return false;
  return BEARER_REQUIRED_WRITE_ROUTES.some((r) => r.test(pathname));
}
