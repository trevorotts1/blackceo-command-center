/**
 * CSRF double-submit cookie protection for mutating /api/* routes (MR-23).
 *
 * BACKGROUND:
 *   src/middleware.ts has a same-origin passthrough (lines ~496-504) that lets
 *   same-origin /api/* requests bypass the MC_API_TOKEN bearer check. The
 *   passthrough trusts `Origin`/`Referer` headers, both of which are client-
 *   settable. 38 routes already require a bearer via `BEARER_REQUIRED_WRITE_ROUTES`;
 *   the remaining 63 mutating routes the browser interface calls itself remain
 *   reachable with no credential via a forged same-origin header.
 *
 * THIS FIX (Part B + C per docs/SECURITY-RESIDUALS.md):
 *   Every mutating (POST/PATCH/PUT/DELETE) /api/* request passing through the
 *   same-origin passthrough must carry a signed `mc_csrf_token` cookie. The
 *   cookie is set on non-API page responses by the middleware itself and is
 *   verified in the same-origin passthrough block.
 *
 *   The cookie is httpOnly + SameSite=Strict:
 *     - httpOnly: XSS cannot read it.
 *     - SameSite=Strict: the browser will NOT send it on cross-site requests,
 *       closing the traditional CSRF vector.
 *     - HMAC-SHA256 signed: a direct-to-origin attacker cannot forge its value
 *       because they do not know the server-side signing secret.
 *
 * EDGE-SAFETY: This module imports only Web-standard globals (globalThis.crypto.subtle,
 * TextEncoder, btoa/atob). It is safe for import from src/middleware.ts.
 */

/* ── Constants ────────────────────────────────────────────────────────────── */

/** Cookie name the middleware sets and reads. */
export const CSRF_COOKIE_NAME = 'mc_csrf_token';

/** Cookie TTL (1 hour). Refreshed on every non-API page response. */
export const CSRF_COOKIE_TTL_SECONDS = 60 * 60;

/** Cookie attributes for Set-Cookie. */
export const CSRF_COOKIE_ATTRIBUTES = {
  httpOnly: true,
  sameSite: 'strict' as const,
  path: '/',
  secure: process.env.NODE_ENV === 'production',
};

/** Methods that never require CSRF (read-only). */
const READ_ONLY_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/* ── Payload ──────────────────────────────────────────────────────────────── */

interface CsrfPayload {
  /** Hard-coded discriminator so a token minted for CSRF cannot be replayed as
   *  another cookie type. */
  role: 'csrf';
  /** Unix seconds this token expires. */
  exp: number;
}

/* ── Secret resolution ────────────────────────────────────────────────────── */

const DEV_FALLBACK_SECRET = 'mc-csrf-unsigned-dev-secret';

function csrfSecret(): string {
  return (
    process.env.MC_INTERVIEW_COOKIE_SECRET ||
    process.env.MC_API_TOKEN ||
    process.env.WEBHOOK_SECRET ||
    DEV_FALLBACK_SECRET
  );
}

function devSecretInProduction(): boolean {
  return (
    process.env.NODE_ENV === 'production' &&
    csrfSecret() === DEV_FALLBACK_SECRET
  );
}

/* ── base64url utilities (no Buffer -- Edge-safe) ────────────────────────── */

function bytesToB64url(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function strToB64url(s: string): string {
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlToStr(b64: string): string {
  const norm = b64.replace(/-/g, '+').replace(/_/g, '/');
  const pad = norm.length % 4 === 0 ? '' : '='.repeat(4 - (norm.length % 4));
  return atob(norm + pad);
}

async function hmacB64url(data: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error('WebCrypto subtle unavailable');
  const enc = new TextEncoder();
  const key = await subtle.importKey(
    'raw',
    enc.encode(csrfSecret()),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await subtle.sign('HMAC', key, enc.encode(data));
  return bytesToB64url(new Uint8Array(sig));
}

/** Constant-time comparison (avoids signature-timing side channels). */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/* ── Public API ───────────────────────────────────────────────────────────── */

/**
 * Mint a signed CSRF cookie value + matching cookie maxAge.
 *
 * Called from the middleware for every non-API page response. The cookie is
 * httpOnly so it travels with every same-origin request the browser makes but
 * is never readable by JavaScript. An attacker hitting the origin directly
 * cannot forge a valid cookie because they do not know the HMAC key.
 */
export async function signCsrfToken(): Promise<{ value: string; maxAge: number }> {
  if (devSecretInProduction()) {
    throw new Error(
      '[CSRF] Cookie secret resolves to the public dev fallback in production. ' +
        'Set MC_INTERVIEW_COOKIE_SECRET (or MC_API_TOKEN / WEBHOOK_SECRET). ' +
        'Refusing to sign a forgeable CSRF token.',
    );
  }
  const exp = Math.floor(Date.now() / 1000) + CSRF_COOKIE_TTL_SECONDS;
  const payload: CsrfPayload = { role: 'csrf', exp };
  const payloadB64 = strToB64url(JSON.stringify(payload));
  const sig = await hmacB64url(payloadB64);
  return {
    value: `${payloadB64}.${sig}`,
    maxAge: CSRF_COOKIE_TTL_SECONDS,
  };
}

/**
 * Verify a CSRF cookie value.
 *
 * Returns true only when ALL of:
 *   - The value is a non-empty string.
 *   - The HMAC-SHA256 signature is valid.
 *   - The payload's `role` is 'csrf' (not a replay of another cookie type).
 *   - The token has not expired.
 *
 * On a production box whose secret resolves to the public dev fallback,
 * EVERY verification returns false (hard-lock, DATA-13 pattern).
 */
export async function verifyCsrfToken(
  value: string | undefined | null,
): Promise<boolean> {
  if (devSecretInProduction()) return false;
  if (!value || typeof value !== 'string') return false;

  const dot = value.lastIndexOf('.');
  if (dot <= 0 || dot === value.length - 1) return false;
  const payloadB64 = value.slice(0, dot);
  const sig = value.slice(dot + 1);

  let expected: string;
  try {
    expected = await hmacB64url(payloadB64);
  } catch {
    return false;
  }
  if (!timingSafeEqual(sig, expected)) return false;

  let payload: CsrfPayload;
  try {
    payload = JSON.parse(b64urlToStr(payloadB64)) as CsrfPayload;
  } catch {
    return false;
  }

  if (payload.role !== 'csrf') return false;
  if (typeof payload.exp !== 'number') return false;
  if (payload.exp < Math.floor(Date.now() / 1000)) return false;

  return true;
}

/**
 * Returns true for HTTP methods that never require CSRF validation.
 */
export function isReadOnlyMethod(method: string): boolean {
  return READ_ONLY_METHODS.has(method.toUpperCase());
}
