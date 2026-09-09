/**
 * src/lib/social-theme/theme-sessions.ts — F27 invitation token + session
 * cookie helpers (purpose `social-theme`, DISTINCT from workforce-interview).
 *
 * Invitation ticket: raw random token is returned ONCE to the
 * operator/service caller that minted it (queued for delivery to the
 * company's registered destination); ONLY the SHA-256 hash is persisted
 * (social_invitations.token_hash). A leaked DB copy cannot mint tickets.
 * Raw tokens never reach logs or analytics — callers receive them in the
 * response body alone.
 *
 * Exchange: POST /api/social-theme/exchange redeems an UNexpired, UNused,
 * UNrevoked invitation for a scoped HttpOnly session cookie
 * (SOCIAL_THEME_SESSION_COOKIE). The cookie's HMAC grant carries purpose
 * 'social-theme-session' and is verified ONLY by this module's
 * resolveSocialThemeSession — the interview session verifier
 * (verifyTenantGrant purpose 'session') will not accept it, and vice versa,
 * so the two intake flows can never share a browser session.
 *
 * Rate limit: sliding in-process window per company+IP for exchange/renew.
 */

import { createHash, randomBytes } from 'crypto';
import { run, queryOne } from '@/lib/db';
import {
  SOCIAL_THEME_INVITATION_TTL_SECONDS,
  SOCIAL_THEME_SESSION_TTL_SECONDS,
} from './session-policy';

export const SOCIAL_THEME_COOKIE = 'social_theme_session';
export const SOCIAL_THEME_INVITATION_PURPOSE = 'social-theme';

const enc = new TextEncoder();

function hmacSecret(): string {
  const value =
    process.env.MC_TENANT_SESSION_SECRET ||
    process.env.MC_INTERVIEW_COOKIE_SECRET ||
    process.env.MC_API_TOKEN;
  if (!value) throw new Error('Social-theme session secret not configured');
  return value;
}

function b64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...Array.from(bytes)))
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function fromB64url(value: string): Uint8Array {
  return Uint8Array.from(
    atob(value.replace(/-/g, '+').replace(/_/g, '/')),
    (c) => c.charCodeAt(0),
  );
}

async function hmac(payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(hmacSecret()),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return b64url(new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(payload))));
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/* ── Invitation tokens ──────────────────────────────────────────────────── */

/** Hash an invitation token for storage/lookup (never store the raw token). */
export function hashInvitationToken(rawToken: string): string {
  return createHash('sha256').update(`social-theme:${rawToken}`).digest('hex');
}

/** Mint a fresh opaque invitation token. Returns the raw token + its hash. */
export function mintInvitationToken(): { raw: string; tokenHash: string } {
  const raw = randomBytes(32).toString('base64url');
  return { raw, tokenHash: hashInvitationToken(raw) };
}

/* ── Session grants ─────────────────────────────────────────────────────── */

export interface SocialThemeGrant {
  purpose: 'social-theme-session';
  sessionId: string;
  companyId: string;
  cycleId: string;
  exp: number;
  nonce: string;
}

export function signSocialThemeGrant(grant: SocialThemeGrant): string {
  const payload = b64url(enc.encode(JSON.stringify(grant)));
  return payload; // signature appended by caller after async hmac
}

export async function signSessionCookie(grant: {
  sessionId: string;
  companyId: string;
  cycleId: string;
}): Promise<{ value: string; maxAge: number; grant: SocialThemeGrant }> {
  const full: SocialThemeGrant = {
    purpose: 'social-theme-session',
    sessionId: grant.sessionId,
    companyId: grant.companyId,
    cycleId: grant.cycleId,
    exp: Math.floor(Date.now() / 1000) + SOCIAL_THEME_SESSION_TTL_SECONDS,
    nonce: randomBytes(16).toString('hex'),
  };
  const payload = b64url(enc.encode(JSON.stringify(full)));
  const sig = await hmac(payload);
  return { value: `${payload}.${sig}`, maxAge: SOCIAL_THEME_SESSION_TTL_SECONDS, grant: full };
}

export async function verifySessionCookie(
  value: string | undefined | null,
): Promise<SocialThemeGrant | null> {
  try {
    if (!value || typeof value !== 'string') return null;
    const dot = value.lastIndexOf('.');
    if (dot <= 0) return null;
    const payload = value.slice(0, dot);
    const sig = value.slice(dot + 1);
    const expected = await hmac(payload);
    if (!timingSafeEqual(sig, expected)) return null;
    const grant = JSON.parse(new TextDecoder().decode(fromB64url(payload))) as SocialThemeGrant;
    if (grant.purpose !== 'social-theme-session' || !grant.sessionId || !grant.companyId) return null;
    if (!Number.isFinite(grant.exp) || grant.exp <= Date.now() / 1000) return null;
    return grant;
  } catch {
    return null;
  }
}

export function readSocialThemeCookie(request: { headers: Headers }): string | null {
  return (
    request.headers
      .get('cookie')
      ?.split(';')
      .map((s) => s.trim())
      .find((s) => s.startsWith(SOCIAL_THEME_COOKIE + '='))
      ?.slice(SOCIAL_THEME_COOKIE.length + 1) || null
  );
}

/**
 * Server derives the company/cycle from the cookie grant and re-proofs BOTH
 * against the sessions table. Query-string company/cycle ids are NEVER
 * trusted (SPEC: do not trust company IDs from query strings).
 */
export function resolveSessionRow(grant: SocialThemeGrant | null) {
  if (!grant) return null;
  const row = queryOne<{
    id: string;
    company_id: string;
    cycle_id: string;
    status: string;
    revision: number;
    answers_json: string;
    saved_at: string | null;
    submitted_at: string | null;
  }>(
    `SELECT id, company_id, cycle_id, status, revision, answers_json, saved_at, submitted_at
       FROM social_theme_sessions WHERE id = ?`,
    [grant.sessionId],
  );
  if (!row) return null;
  // The cookie is company/cycle-scoped; a session row that no longer matches
  // the grant (foreign id substitution) is rejected outright.
  if (row.company_id !== grant.companyId || row.cycle_id !== grant.cycleId) return null;
  return row;
}

/** Mark an invitation used inside a caller's transaction. */
export function markInvitationUsed(invitationId: string): boolean {
  const used = run(
    `UPDATE social_invitations
        SET used_at = ?
      WHERE id = ? AND used_at IS NULL AND revoked_at IS NULL`,
    [new Date().toISOString(), invitationId],
  );
  return used.changes > 0;
}

export function invitationTtlSeconds(): number {
  return SOCIAL_THEME_INVITATION_TTL_SECONDS;
}

/* ── Rate limiting (exchange/renew) ─────────────────────────────────────── */

interface Bucket {
  windowStart: number;
  count: number;
}
const buckets = new Map<string, Bucket>();

/** Sliding-window limiter; returns true when the call is ALLOWED. */
export function allowExchangeAttempt(key: string, windowSeconds: number, max: number): boolean {
  const now = Date.now();
  const bucket = buckets.get(key);
  if (!bucket || now - bucket.windowStart >= windowSeconds * 1000) {
    buckets.set(key, { windowStart: now, count: 1 });
    return true;
  }
  bucket.count += 1;
  return bucket.count <= max;
}