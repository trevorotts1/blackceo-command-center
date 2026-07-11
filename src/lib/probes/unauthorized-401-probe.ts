/**
 * Middleware 401 observability (FLEET-FIX 2.3 / AUD-71).
 *
 * The CC write-back auth train (`23c9ef2` -> v5.1.0/v5.1.1) rebuilt
 * `src/middleware.ts` around a canonical `unauthorized(request, message,
 * status)` helper (DATA-09/10/11, G15-AUTH-HARDEN) but never wired
 * observability for it: a 401 on this deployment produced no structured log
 * line and incremented no counter, so an operator watching a box's stdout or
 * a dashboard had no signal that clients were being rejected — only the
 * client's own error page told them.
 *
 * This module is the counter + structured-log sink `unauthorized()` calls on
 * every ACTUAL 401 (not the 503 misconfiguration responses the same helper
 * also emits — those are a config-error signal, not an auth-rejection
 * signal, and mixing them would make the 401 counter lie about how many
 * callers were actually turned away for bad/missing credentials).
 *
 * Module-level counter, exactly like the sibling `cloudflare-access-probe.ts`
 * (`recordCfAccessSeen` / its module-level `lastSeen` Map) — this file runs in
 * the same Edge runtime as `src/middleware.ts` and follows the same pattern:
 * no filesystem, no node:crypto, plain in-memory module state.
 */

export interface Unauthorized401Event {
  /** The request path that was rejected, e.g. `/api/tasks`. */
  pathname: string;
  /** HTTP method of the rejected request. */
  method: string;
  /** The human-readable reason `unauthorized()` was called with. */
  reason: string;
}

/** Module-level counter. Edge runtime keeps this alive for the isolate's lifetime. */
let unauthorized401Count = 0;

/**
 * Called by `unauthorized()` in `src/middleware.ts` for every response it
 * returns with `status === 401`. Increments the counter and emits ONE
 * single-line structured JSON log record via `console.warn` so it is
 * greppable from raw stdout/log aggregation without a JSON log pipeline.
 */
export function recordUnauthorized401(event: Unauthorized401Event): void {
  unauthorized401Count += 1;
  console.warn(
    JSON.stringify({
      event: 'middleware_401',
      status: 401,
      pathname: event.pathname,
      method: event.method,
      reason: event.reason,
      count: unauthorized401Count,
      ts: new Date().toISOString(),
    })
  );
}

/** Current lifetime count of 401 responses `unauthorized()` has emitted. */
export function getUnauthorized401Count(): number {
  return unauthorized401Count;
}

/** Test-only: resets the in-memory counter between test cases. */
export function __resetUnauthorized401Counter(): void {
  unauthorized401Count = 0;
}
