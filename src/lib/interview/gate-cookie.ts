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
 */
export const COMPLETE_TTL_SECONDS = 60 * 60 * 24; // 24h
export const INCOMPLETE_TTL_SECONDS = 60; // 1 min

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

function cookieSecret(): string {
  return (
    process.env.MC_INTERVIEW_COOKIE_SECRET ||
    process.env.MC_API_TOKEN ||
    process.env.WEBHOOK_SECRET ||
    // Dev/unprovisioned fallback: still internally consistent (sign + verify use
    // the same value in one process), so the gate works locally. In production
    // one of the above secrets is always set.
    'mc-interview-gate-unsigned-dev-secret'
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
