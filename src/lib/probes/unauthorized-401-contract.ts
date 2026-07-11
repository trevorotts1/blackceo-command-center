/**
 * Middleware 401 telemetry — the SHARED CONTRACT between the two runtimes
 * (FLEET-FIX 2.3 / AUD-71).
 *
 * ── Why this file exists, stated honestly ────────────────────────────────────
 * `src/middleware.ts` runs in the **Edge runtime** (Next 14.2 has no Node
 * middleware — `experimental.nodeMiddleware` first appears in Next 15.2). The
 * health surface that must expose the 401 counter (`/api/system/status` ->
 * `runAllProbes()` in `src/lib/system-status.ts`) runs in the **Node runtime**.
 *
 * Those are two different JavaScript realms in the same `next start` process.
 * Module-level state (a `let count = 0` in a module imported by both) does NOT
 * cross that boundary: the Edge bundle gets its own instance and the Node
 * bundle gets a second, disconnected one. A counter incremented by the
 * middleware and read by a Node health route would therefore read 0 FOREVER.
 * (This is exactly the trap the first cut of AUD-71 fell into; `globalThis`
 * does not save it either — the Edge sandbox has its own `globalThis`.)
 *
 * ── The mechanism actually used ──────────────────────────────────────────────
 * The middleware does not try to share memory. For every CREDENTIAL-FAILURE
 * 401 it `NextResponse.rewrite()`s the rejected request to a Node-runtime route
 * (`AUTH_REJECTED_PATH`), passing the event on internal request headers. That
 * route is the one that:
 *
 *   1. increments the authoritative counter (`unauthorized-401-store.ts`,
 *      Node-runtime module state), and
 *   2. emits the single structured `console.error` log line, and
 *   3. returns the SAME `401 {"error":"Unauthorized"}` body the middleware used
 *      to return itself — so auth semantics are unchanged for the caller.
 *
 * A middleware-initiated rewrite is dispatched IN-PROCESS and does not re-enter
 * the middleware, so there is no loop and no network hop. This is synchronous
 * and cannot be silently dropped the way a fire-and-forget loopback `fetch()`
 * (the obvious alternative) can be — no port to resolve, no `waitUntil`, no
 * build-time env-inlining question.
 *
 * Residual, stated rather than hidden: Next dispatches a rewritten request to a
 * route handler only for the HTTP methods that route EXPORTS. `REWRITABLE_METHODS`
 * below is that set. A rejected request with an exotic verb (`PROPFIND`, a custom
 * method) is answered by the middleware directly — identical 401, identical body,
 * structured log line still emitted, but with `count: null`, because that request
 * never reaches the Node counter. It is NOT counted rather than mis-counted.
 *
 * ── What is counted, and what deliberately is NOT ────────────────────────────
 * ONLY credential failures (`missing-header`, `token-mismatch`) increment the
 * counter. `src/middleware.ts` routes several other rejections through the same
 * `unauthorized()` helper — notably the Cloudflare-Access-not-active response,
 * which takes the DEFAULT status (401) — and those are MISCONFIGURATION signals,
 * not "a caller presented bad credentials" signals. Filtering on `status === 401`
 * alone (the first cut of AUD-71) folded that misconfiguration 401 into the
 * counter, which made the number lie. The guard is therefore on the SIGNAL, not
 * on the status code: see `isCredentialFailure()`.
 */

/**
 * A caller presented bad or missing credentials. These — and only these —
 * increment the 401 counter.
 */
export type CredentialFailureReason = 'missing-header' | 'token-mismatch';

/**
 * Every rejection `unauthorized()` in `src/middleware.ts` can emit, named by
 * what it MEANS rather than by the status code it happens to carry.
 *
 *   missing-header          401  no `Authorization: Bearer …` at all
 *   token-mismatch          401  bearer present but != MC_API_TOKEN
 *   cf-access-misconfigured 401  Cloudflare Access is not active on the subdomain
 *   mc-api-token-unset      503  the box never provisioned MC_API_TOKEN
 *   webhook-secret-unset    503  the box never provisioned WEBHOOK_SECRET
 *
 * The last three are OPERATOR-CONFIG faults. They are not credential failures
 * and never touch the counter — `cf-access-misconfigured` in particular is a
 * 401 by status, which is precisely why the discriminator exists.
 */
export type AuthRejectionSignal =
  | CredentialFailureReason
  | 'cf-access-misconfigured'
  | 'mc-api-token-unset'
  | 'webhook-secret-unset';

/** The two signals that mean "a caller was turned away for bad credentials". */
export const CREDENTIAL_FAILURE_REASONS: readonly CredentialFailureReason[] = [
  'missing-header',
  'token-mismatch',
];

/** Type guard: does this rejection signal count as a credential failure? */
export function isCredentialFailure(
  signal: AuthRejectionSignal
): signal is CredentialFailureReason {
  return (CREDENTIAL_FAILURE_REASONS as readonly string[]).includes(signal);
}

/** One credential-failure 401, as recorded by the Node-side counter. */
export interface Unauthorized401Event {
  /** The path the caller was rejected on, e.g. `/api/tasks/42/activities`. */
  pathname: string;
  /** HTTP method of the rejected request. */
  method: string;
  /** WHY it was rejected — the whole diagnostic point of AUD-71. */
  reason: CredentialFailureReason;
  /** Caller User-Agent, or null when the caller sent none. */
  ua: string | null;
  /** ISO-8601 timestamp of the rejection. */
  ts: string;
}

/**
 * The Node-runtime route the middleware rewrites credential-failure 401s to.
 * It is INTERNAL: `src/middleware.ts` answers any DIRECT inbound request for
 * this path with a 404 before any auth logic runs, so the only way to reach the
 * handler is the middleware's own rewrite (which does not re-enter middleware).
 * That is what stops an outside caller from poisoning the per-reason breakdown
 * by hand-crafting the internal headers below.
 */
export const AUTH_REJECTED_PATH = '/api/internal/auth-rejected';

/**
 * Methods the sink route exports, and therefore the methods a rewrite can be
 * dispatched for. Anything outside this set is answered by the middleware
 * directly (same 401, logged, uncounted) — see the header comment.
 */
export const REWRITABLE_METHODS: readonly string[] = [
  'GET',
  'HEAD',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'OPTIONS',
];

/** Internal request headers the rewrite carries. Never sent by a real client. */
export const AUTH_REJECT_HEADERS = {
  reason: 'x-cc-auth-reject-reason',
  pathname: 'x-cc-auth-reject-path',
  method: 'x-cc-auth-reject-method',
  ua: 'x-cc-auth-reject-ua',
} as const;

/**
 * Header values must be single-line and bounded. A caller controls its own
 * User-Agent, so it is untrusted input the moment we copy it onto a NEW header:
 * strip CR/LF (header-injection) and cap the length.
 */
export function sanitizeHeaderValue(value: string | null, maxLen = 256): string | null {
  if (value === null || value === undefined) return null;
  const flat = value.replace(/[\r\n]+/g, ' ').trim();
  if (flat.length === 0) return null;
  return flat.length > maxLen ? flat.slice(0, maxLen) : flat;
}

/** Narrow an arbitrary string back to a CredentialFailureReason, or null. */
export function parseCredentialFailureReason(
  value: string | null
): CredentialFailureReason | null {
  if (value === null) return null;
  return (CREDENTIAL_FAILURE_REASONS as readonly string[]).includes(value)
    ? (value as CredentialFailureReason)
    : null;
}

/**
 * The ONE structured log line AUD-71 asks for: single-line JSON on
 * `console.error` (the spec names console.error), greppable straight out of
 * `pm2 logs` with no JSON log pipeline.
 *
 * `count` is the AUTHORITATIVE running total from the Node-side counter when the
 * line is emitted by the sink route (the normal path). It is `null` — never a
 * fabricated number — on the middleware's direct-answer fallback path, where no
 * counter is reachable. `sink` says which of the two happened, so an operator
 * reading raw stdout can tell an uncounted line from a counted one.
 */
export function logUnauthorized401(
  event: Unauthorized401Event,
  count: number | null,
  sink: 'node-sink' | 'middleware-direct'
): void {
  console.error(
    JSON.stringify({
      event: 'middleware_401',
      status: 401,
      pathname: event.pathname,
      method: event.method,
      reason: event.reason,
      ua: event.ua,
      count,
      sink,
      ts: event.ts,
    })
  );
}
