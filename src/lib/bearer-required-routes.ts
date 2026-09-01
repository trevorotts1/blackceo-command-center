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
  /^\/api\/sops\/(?!feedback$|proposals$)[^/]+$/,
  /^\/api\/sops\/import-role-library$/,
  /^\/api\/tasks\/[^/]+\/activities$/,
  /^\/api\/tasks\/[^/]+\/deliverables$/,
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
