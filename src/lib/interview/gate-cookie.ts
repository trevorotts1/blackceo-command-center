/**
 * Interview-mode shell-lock cookie (P0-5) — the Edge/Node seam for the
 * "interview shell before dashboard" gate (WG-9).
 *
 * U057 — Interview skip/defer bypass cookie.
 * An operator who needs urgent dashboard access before completing the interview
 * can "Skip for now" on the consent screen, which sets a signed bypass cookie
 * with a 1-hour TTL. The middleware reads it and allows page access through the
 * shell-lock. A persistent reminder banner is shown on all pages until the
 * interview is complete.
 */

export const INTERVIEW_COOKIE_NAME = 'mc_interview_complete';

export const INTERVIEW_BYPASS_COOKIE_NAME = 'mc_interview_bypass';
export const BYPASS_TTL_SECONDS = 60 * 60;

export const COMPLETE_TTL_SECONDS = 30 * 24 * 60 * 60;
export const INCOMPLETE_TTL_SECONDS = 60;

interface GatePayload { complete: boolean; exp: number; }
interface BypassPayload { exp: number; }

export interface GateVerdict { valid: boolean; complete: boolean; expired: boolean; }

const DEV_FALLBACK_SECRET = 'mc-interview-gate-unsigned-dev-secret';

function cookieSecret(): string {
  return process.env.MC_INTERVIEW_COOKIE_SECRET || process.env.MC_API_TOKEN ||
    process.env.WEBHOOK_SECRET || DEV_FALLBACK_SECRET;
}
function devSecretInProduction(): boolean {
  return process.env.NODE_ENV === 'production' && cookieSecret() === DEV_FALLBACK_SECRET;
}

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
async function hmacB64url(payloadB64: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error('WebCrypto subtle unavailable');
  const enc = new TextEncoder();
  const key = await subtle.importKey('raw', enc.encode(cookieSecret()), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await subtle.sign('HMAC', key, enc.encode(payloadB64));
  return bytesToB64url(new Uint8Array(sig));
}
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function signInterviewToken(complete: boolean): Promise<{ value: string; maxAge: number }> {
  if (devSecretInProduction()) { throw new Error('DATA-13: forgeable token in production'); }
  const ttl = complete ? COMPLETE_TTL_SECONDS : INCOMPLETE_TTL_SECONDS;
  const exp = Math.floor(Date.now() / 1000) + ttl;
  const payload: GatePayload = { complete: !!complete, exp };
  const payloadB64 = strToB64url(JSON.stringify(payload));
  const sig = await hmacB64url(payloadB64);
  return { value: payloadB64 + '.' + sig, maxAge: ttl };
}

export async function verifyInterviewToken(value: string | undefined | null): Promise<GateVerdict> {
  const fail: GateVerdict = { valid: false, complete: false, expired: false };
  if (devSecretInProduction()) return fail;
  if (!value || typeof value !== 'string') return fail;
  const dot = value.lastIndexOf('.');
  if (dot <= 0 || dot === value.length - 1) return fail;
  const payloadB64 = value.slice(0, dot);
  const sig = value.slice(dot + 1);
  let expected: string;
  try { expected = await hmacB64url(payloadB64); } catch { return fail; }
  if (!timingSafeEqual(sig, expected)) return fail;
  let payload: GatePayload;
  try { payload = JSON.parse(b64urlToStr(payloadB64)) as GatePayload; } catch { return fail; }
  const complete = payload.complete === true;
  const now = Math.floor(Date.now() / 1000);
  const expired = typeof payload.exp !== 'number' || payload.exp < now;
  return { valid: !expired, complete, expired };
}

/* U057 — Interview bypass ("Skip for now") */

export async function signInterviewBypassToken(): Promise<{ value: string; maxAge: number }> {
  if (devSecretInProduction()) throw new Error('DATA-13: forgeable bypass token');
  const exp = Math.floor(Date.now() / 1000) + BYPASS_TTL_SECONDS;
  const payload: BypassPayload = { exp };
  const payloadB64 = strToB64url(JSON.stringify(payload));
  const sig = await hmacB64url(payloadB64);
  return { value: payloadB64 + '.' + sig, maxAge: BYPASS_TTL_SECONDS };
}

export async function verifyInterviewBypassToken(value: string | undefined | null): Promise<boolean> {
  if (devSecretInProduction()) return false;
  if (!value || typeof value !== 'string') return false;
  const dot = value.lastIndexOf('.');
  if (dot <= 0 || dot === value.length - 1) return false;
  const payloadB64 = value.slice(0, dot);
  const sig = value.slice(dot + 1);
  let expected: string;
  try { expected = await hmacB64url(payloadB64); } catch { return false; }
  if (!timingSafeEqual(sig, expected)) return false;
  let payload: BypassPayload;
  try { payload = JSON.parse(b64urlToStr(payloadB64)) as BypassPayload; } catch { return false; }
  if (typeof payload.exp !== 'number') return false;
  return payload.exp >= Math.floor(Date.now() / 1000);
}
