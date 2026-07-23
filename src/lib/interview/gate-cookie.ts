/**
 * Interview-mode shell-lock cookie (P0-5) — the Edge/Node seam for the
 * "interview shell before dashboard" gate (WG-9).
 *
 * WHY A COOKIE:
 *   src/middleware.ts runs in the EDGE runtime and CANNOT import better-sqlite3
 *   or fs, so it can't read .workforce-build-state.json / getInterviewState()
 *   directly. Instead a Node-runtime setter (the `refreshInterviewGate` server
 *   action mounted from the root layout) derives completion from the canonical
 *   FILES and drops a short-TTL SIGNED cookie (`mc_interview_complete`). The
 *   Edge middleware only READS + verifies that cookie and 302s while incomplete.
 *
 * EDGE-SAFETY (critical):
 *   This module imports NOTHING Node-only — no `fs`, no `child_process`, no
 *   `crypto` from 'node:crypto', no seam.ts, no interview-state.ts. It uses only
 *   Web-standard globals (globalThis.crypto.subtle, TextEncoder, btoa/atob) that
 *   exist in BOTH the Edge middleware runtime and the Node server runtime, so it
 *   is safe for `src/middleware.ts` to import. Keep it that way — a single Node
 *   import here would break the Edge build.
 *
 * The value is HMAC-SHA256 signed so a client cannot forge a "complete" cookie
 * to unlock the dashboard. Signing + verification share a process-local secret
 * (MC_INTERVIEW_COOKIE_SECRET → MC_API_TOKEN → WEBHOOK_SECRET → dev fallback);
 * both the setter and the middleware run in the same box process, so they agree.
 */

/** Edge-readable cookie name. Kept in one place so setter + reader can't drift. */
export const INTERVIEW_COOKIE_NAME = 'mc_interview_complete';

/**
 * Completion is TERMINAL (the interview never un-completes; buildCompletedAt is
 * final), so a "complete" token gets a long TTL and rarely needs re-minting.
 * An "incomplete" token gets a short TTL so the shell unlocks quickly (within a
 * page load or a minute) the moment update-interview-state.sh --complete lands.
 *
 * U010: COMPLETE_TTL extended to 30 days so the signed cookie survives restarts
 * and tunnel reconnects. A persistent latch cookie (LATCH_COOKIE_NAME) with a
 * 60-day TTL provides a fallback when the main cookie is absent/expired. Both
 * are signed with the same stable HMAC key derived from MC_INTERVIEW_COOKIE_SECRET
 * (env-backed, not regenerated per restart).
 */
export const COMPLETE_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days (U010)
export const INCOMPLETE_TTL_SECONDS = 60; // 1 min

/**
 * Persistent gate-latch cookie (U010). When the main mc_interview_complete
 * cookie is absent or expired, the middleware checks this latch as a fallback
 * before redirecting to /interview. The latch is signed with the same HMAC key
 * and has a longer TTL (60 days) so it survives restarts, tunnel reconnects, and
 * cookie-store expiry. Set once when the interview is confirmed complete and
 * refreshed on every page load by InterviewGateSync.
 */
export const LATCH_COOKIE_NAME = 'mc_interview_gate_latch';
export const LATCH_TTL_SECONDS = 60 * 60 * 24 * 60; // 60 days

interface GatePayload {
  /** true only when the interview is genuinely complete / build finished. */
  complete: boolean;
  /** unix seconds this token expires. */
  exp: number;
}

export interface GateVerdict {
  /** signature valid AND not expired. */
  valid: boolean;
  /** the signed completion bit (trustworthy whenever the signature verifies,
   *  even if the token is expired — completion never reverts). */
  complete: boolean;
  /** signature verified but past `exp`. */
  expired: boolean;
}

/**
 * The well-known dev/unprovisioned fallback secret. It is PUBLIC (it ships in
 * this source file), so any cookie signed with it is forgeable by anyone who
 * has read the repo. It exists only so the gate stays internally consistent on
 * a local/dev box where none of the real secrets are set.
 */
const DEV_FALLBACK_SECRET = 'mc-interview-gate-unsigned-dev-secret';

function cookieSecret(): string {
  return (
    process.env.MC_INTERVIEW_COOKIE_SECRET ||
    process.env.MC_API_TOKEN ||
    process.env.WEBHOOK_SECRET ||
    // Dev/unprovisioned fallback: still internally consistent (sign + verify use
    // the same value in one process), so the gate works locally. In production
    // one of the above secrets is always set — and if it somehow isn't,
    // devSecretInProduction() below HARD-LOCKS the gate rather than signing with
    // this public, forgeable key (DATA-13).
    DEV_FALLBACK_SECRET
  );
}

/**
 * DATA-13 — production hard-lock condition. When the effective signing secret
 * resolves to the public {@link DEV_FALLBACK_SECRET} on a production box, the
 * HMAC key is public: anyone could forge a `{complete:true}` cookie and unlock
 * the dashboard. In that state we refuse to serve — signing throws and every
 * verification fails CLOSED (302 → /interview) — so no forged token can pass
 * and the operator is forced to provision a real secret. Uses only
 * `process.env` (Edge-safe; Next inlines NODE_ENV in both runtimes), so this
 * keeps `gate-cookie.ts` importable from the Edge middleware.
 */
function devSecretInProduction(): boolean {
  return (
    process.env.NODE_ENV === 'production' &&
    cookieSecret() === DEV_FALLBACK_SECRET
  );
}

/* ── base64url (no Buffer — Edge-safe) ─────────────────────────────────────── */

function bytesToB64url(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function strToB64url(s: string): string {
  // `s` is pure-ASCII JSON ({"complete":true,"exp":123}) so btoa is safe.
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlToStr(b64: string): string {
  const norm = b64.replace(/-/g, '+').replace(/_/g, '/');
  const pad = norm.length % 4 === 0 ? '' : '='.repeat(4 - (norm.length % 4));
  return atob(norm + pad);
}

async function hmacB64url(payloadB64: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error('WebCrypto subtle unavailable');
  const enc = new TextEncoder();
  const key = await subtle.importKey(
    'raw',
    enc.encode(cookieSecret()),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await subtle.sign('HMAC', key, enc.encode(payloadB64));
  return bytesToB64url(new Uint8Array(sig));
}

/** Constant-time string compare (avoid signature-timing leaks). */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Mint a signed `mc_interview_complete` cookie value + the matching cookie
 * maxAge. Called by the Node setter only (never the Edge middleware).
 */
export async function signInterviewToken(
  complete: boolean,
): Promise<{ value: string; maxAge: number }> {
  // DATA-13: never mint a token signed with the public dev fallback in prod —
  // it would be trivially forgeable. Fail loud so the setter surfaces the
  // misconfiguration instead of silently issuing a worthless (forgeable) cookie.
  if (devSecretInProduction()) {
    throw new Error(
      'DATA-13: interview cookie secret resolves to the public dev fallback in ' +
        'production. Set MC_INTERVIEW_COOKIE_SECRET (or MC_API_TOKEN / ' +
        'WEBHOOK_SECRET). Refusing to sign a forgeable token.',
    );
  }
  const ttl = complete ? COMPLETE_TTL_SECONDS : INCOMPLETE_TTL_SECONDS;
  const exp = Math.floor(Date.now() / 1000) + ttl;
  const payload: GatePayload = { complete: !!complete, exp };
  const payloadB64 = strToB64url(JSON.stringify(payload));
  const sig = await hmacB64url(payloadB64);
  return { value: `${payloadB64}.${sig}`, maxAge: ttl };
}

/**
 * Verify a cookie value. A forged / tampered / absent token returns
 * `{ valid:false, complete:false }` so the middleware fails CLOSED to /interview.
 * A signature-valid token surfaces its `complete` bit even when expired, because
 * completion is monotonic — an expired "complete" token still safely unlocks and
 * is simply refreshed by the setter on the next load (prevents over-locking a
 * finished client whose cookie merely aged out).
 */
export async function verifyInterviewToken(
  value: string | undefined | null,
): Promise<GateVerdict> {
  const fail: GateVerdict = { valid: false, complete: false, expired: false };
  // DATA-13: on a production box whose secret is the public dev fallback, the
  // signing key is forgeable — trust NOTHING and hard-lock to /interview,
  // regardless of what the presented token claims. Over-locking a
  // mis-provisioned box is the correct fail-safe (spec: "refuse to serve").
  if (devSecretInProduction()) return fail;
  if (!value || typeof value !== 'string') return fail;
  const dot = value.lastIndexOf('.');
  if (dot <= 0 || dot === value.length - 1) return fail;
  const payloadB64 = value.slice(0, dot);
  const sig = value.slice(dot + 1);

  let expected: string;
  try {
    expected = await hmacB64url(payloadB64);
  } catch {
    return fail;
  }
  if (!timingSafeEqual(sig, expected)) return fail;

  let payload: GatePayload;
  try {
    payload = JSON.parse(b64urlToStr(payloadB64)) as GatePayload;
  } catch {
    return fail;
  }
  const complete = payload.complete === true;
  const now = Math.floor(Date.now() / 1000);
  const expired = typeof payload.exp !== 'number' || payload.exp < now;
  return { valid: !expired, complete, expired };
}

/**
 * Shared cookie options for both the main interview-complete cookie and the
 * persistent latch cookie (U010). HttpOnly prevents JS access, Secure is set
 * in production (TLS), SameSite=Lax allows the cookie on top-level navigations
 * from the same site, and path=/ covers every route. Callers pass `maxAge`
 * from the signed token's TTL.
 *
 * Note: these options are for the setter (server action) only. The middleware
 * reads cookies via `request.cookies.get()` and does not set them.
 */
export function getInterviewCookieOptions(maxAge: number): {
  httpOnly: boolean;
  sameSite: 'lax';
  path: string;
  maxAge: number;
  secure: boolean;
} {
  return {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge,
    secure: process.env.NODE_ENV === 'production',
  };
}

/**
 * Mint a persistent latch cookie value (U010). The latch is a long-lived
 * (60-day) signed cookie set ONCE when the interview is confirmed complete
 * and refreshed on every page load alongside the main cookie. The middleware
 * checks it as a fallback when the main `mc_interview_complete` cookie is
 * absent or expired — preventing a completed operator from being bounced to
 * /interview after a restart or tunnel reconnect.
 *
 * Only mints when `complete === true`; an incomplete latch is never set
 * (completion is terminal and never reverts). Uses the same HMAC key as
 * signInterviewToken so the middleware can verify both with the same secret.
 */
export async function signLatchToken(): Promise<{ value: string; maxAge: number }> {
  if (devSecretInProduction()) {
    throw new Error(
      'DATA-13: interview cookie secret resolves to the public dev fallback in ' +
        'production. Set MC_INTERVIEW_COOKIE_SECRET (or MC_API_TOKEN / ' +
        'WEBHOOK_SECRET). Refusing to sign a forgeable latch token.',
    );
  }
  const exp = Math.floor(Date.now() / 1000) + LATCH_TTL_SECONDS;
  const payload: GatePayload = { complete: true, exp };
  const payloadB64 = strToB64url(JSON.stringify(payload));
  const sig = await hmacB64url(payloadB64);
  return { value: `${payloadB64}.${sig}`, maxAge: LATCH_TTL_SECONDS };
}
