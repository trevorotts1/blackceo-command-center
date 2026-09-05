/**
 * Signed internal-call attestation for the interview gate (2026-08-17).
 *
 * WHY THIS EXISTS
 * The middleware's dashboard-admission fallback
 * (`checkInterviewCompleteViaFallback`) makes an in-process loopback fetch to
 * /api/interview/gate-status, forwarding only the browser's Host header so the
 * endpoint resolves the same tenant the browser sees.
 *
 * The Host-spoofing fix requires Cloudflare edge provenance before honoring a
 * client hostname. That loopback call has none — it is server-to-server — so it
 * was refused with 403, the fallback fail-closed, and EVERY client tenant was
 * 302'd to /interview even with a completed interview. In other words: the
 * security fix locked clients out of their own dashboards.
 *
 * The fix is NOT to accept a plain marker header — anything that can reach the
 * origin could send one, which is the very threat the guard exists to stop.
 * Instead the caller proves it holds the box's HMAC secret, which an external
 * attacker does not have.
 *
 * Properties:
 *  - HMAC-SHA256 over `host|expiry` with the box's shared interview secret.
 *  - Short TTL (10s) — ample for a loopback call, useless if captured later.
 *  - Bound to the HOST being claimed, so a token minted for one tenant cannot
 *    be replayed to unlock a different one.
 *  - WebCrypto only, so it is safe in BOTH the Edge middleware and Node routes.
 *
 * Secret chain mirrors gate-cookie.ts deliberately: the two must never disagree
 * about which secret this box signs with.
 */

const TOKEN_TTL_MS = 10_000;
const DEV_FALLBACK_SECRET = 'mc-interview-gate-unsigned-dev-secret';

export const INTERNAL_GATE_HEADER = 'x-mc-internal-gate';

function internalSecret(): string {
  const value = (
    process.env.MC_INTERVIEW_COOKIE_SECRET ||
    process.env.MC_API_TOKEN ||
    process.env.WEBHOOK_SECRET ||
    DEV_FALLBACK_SECRET
  );
  if (value === DEV_FALLBACK_SECRET && process.env.NODE_ENV === 'production') throw new Error('Internal gate secret not configured');
  return value;
}

async function hmac(payload: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(internalSecret()),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(payload));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** Constant-time compare — avoid signature-timing leaks. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Mint a short-lived token attesting an internal call for `host`. */
export async function mintInternalGateToken(host: string): Promise<string> {
  const exp = Date.now() + TOKEN_TTL_MS;
  const h = host.split(':')[0].toLowerCase();
  const sig = await hmac(`${h}|${exp}`);
  return `${exp}.${sig}`;
}

/**
 * Verify a token minted by {@link mintInternalGateToken} for `host`.
 * Returns false on anything malformed, expired, or mis-signed — never throws.
 */
export async function verifyInternalGateToken(
  token: string | null | undefined,
  host: string | null | undefined,
): Promise<boolean> {
  if (!token || !host) return false;
  const dot = token.indexOf('.');
  if (dot < 1) return false;
  const expRaw = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const exp = Number(expRaw);
  if (!Number.isFinite(exp) || exp < Date.now()) return false;
  // Reject absurd future expiries so a forged far-future token still needs the
  // signature to be right (defence in depth; the HMAC already covers exp).
  if (exp > Date.now() + 60_000) return false;
  const h = host.split(':')[0].toLowerCase();
  try {
    const expected = await hmac(`${h}|${exp}`);
    return timingSafeEqual(expected, sig);
  } catch {
    return false;
  }
}
