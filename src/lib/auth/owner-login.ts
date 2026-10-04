/**
 * Owner login — S7 direct-owner entry for a COMPLETED company.
 *
 * The problem this closes: a client whose interview is finished, on a fresh or
 * cleared browser, with no Cloudflare Access login. Today that browser has no
 * way to become the owner. This module is the narrow answer, and it is narrow
 * on purpose:
 *
 *   • The ticket is minted ONLY by `scripts/mint-owner-login.ts`, run by the
 *     operator on the box itself, from the box's own configured origin and its
 *     own resolved owner record. No HTTP issuance, no caller-supplied subject,
 *     company or origin — those parameters do not exist as inputs anywhere.
 *   • The ticket is `purpose:'owner-login'`, a UUID nonce and a TEN-MINUTE
 *     expiry. The expiry is real because `grantExpired()` in tenant-context.ts
 *     bounds every purpose except the deliberately timeless `enrollment`.
 *   • Redemption is ONE USE, enforced by the `hq_owner_login_uses` primary key
 *     in the database — not a process-local Map, which two processes and a
 *     restart would each defeat. A consumed ticket stays consumed even if the
 *     response never reached the browser; the operator mints a fresh link.
 *   • The destination cookie is the EXISTING 30-day `purpose:'session'` grant
 *     (`mc_tenant_session`, HttpOnly / Secure in production / SameSite=Lax /
 *     Path=/ / no Domain). No new session mechanism, no new identity service,
 *     no interview re-enrollment path.
 *
 * Honest limits, stated rather than implied:
 *   • A stolen unspent link is a bearer capability until it expires. One-use
 *     does not remove that; the 10-minute window bounds it.
 *   • The anti-forgery cookie here is the repo's EXISTING signed `mc_csrf_token`
 *     (src/lib/csrf-protection.ts), minted on page responses by src/middleware.ts
 *     — the same signed double-submit cookie every mutating board route uses.
 *     A second cookie type would be a second mechanism to get wrong.
 *   • NODE-ONLY. This module imports @/lib/db (better-sqlite3). Do not import it
 *     from Edge middleware; the middleware bootstrap exemption for
 *     `/owner-login` and `/api/auth/owner-session` is a separate, smaller edit
 *     (owned by A04) that must not drag a database handle into the edge bundle.
 *
 * SPEC.md rev 4 S7 lines 271-283; frozen storage contract
 * evidence/contracts/storage-auth.md §(b.4), §(d.3).
 */

import { createHash, randomUUID } from 'node:crypto';
import { run, queryOne } from '@/lib/db';
import {
  configuredPublicOrigin,
  requestHost,
  resolveTenantContext,
  signTenantGrant,
  TENANT_SESSION_COOKIE,
  tenantRegistration,
  tenantSessionToken,
  verifyTenantGrant,
} from './tenant-context';
import { CSRF_COOKIE_NAME, verifyCsrfToken } from '@/lib/csrf-protection';

/** The only purpose this module mints. Bounded by `grantExpired()`'s exclusion set. */
export const OWNER_LOGIN_PURPOSE = 'owner-login' as const;

/** S7: a ten-minute owner-login grant. Short, because the link is a bearer token. */
export const OWNER_LOGIN_TTL_SECONDS = 10 * 60;

/**
 * S7: "Keep nonce until capability expiry plus 24 hours". A nonce row may be
 * removed once it is older than its own expiry by this margin; anything sooner
 * could resurrect a still-valid ticket. After cleanup an old ticket still fails
 * on its own expiry, so cleanup can never re-open one.
 */
export const OWNER_LOGIN_USE_KEEP_SECONDS = 24 * 60 * 60;

/** Landing surface (data-free) and the ONE destination a successful redeem may reach. */
export const OWNER_LOGIN_PATH = '/owner-login';
export const OWNER_REDIRECT_PATH = '/hq';

/** Stable subject shape, identical to interview issuance (S7 line 275). */
export const OWNER_SUBJECT_PREFIX = 'invited-owner:';

/** Existing 30-day browser session; the same lifetime the interview session issues. */
export const OWNER_SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;

/** Ticket transport bound (S7 body `{ticket}` only, max 4 KiB overall). */
export const OWNER_LOGIN_TICKET_MAX = 2048;
export const OWNER_SESSION_BODY_MAX = 4096;

/** `invited-owner:<sha256(ownerChat)>` — the derivation interview issuance already uses. */
export function ownerSubjectForChatId(ownerChatId: string): string {
  return OWNER_SUBJECT_PREFIX + createHash('sha256').update(ownerChatId).digest('hex');
}

/**
 * The fixed link, in the fixed format (S7 line 277):
 * `<configured origin>/owner-login#ticket=<capability>`.
 *
 * The fragment is deliberate: it never reaches a server, a log, or a Referer.
 * The landing page strips it again with history.replaceState on arrival.
 */
export function ownerLoginLink(origin: URL, ticket: string): string {
  return `${origin.origin}${OWNER_LOGIN_PATH}#ticket=${encodeURIComponent(ticket)}`;
}

export type OriginVerdict = 'ok' | 'wrong' | 'unconfigured';

/**
 * Exact configured Origin, scheme and port included (S7 line 279).
 *
 * 'unconfigured' is its own verdict so the route can answer a setup error
 * differently from a hostile call: in production a missing or plain-HTTP public
 * origin is a misconfiguration, never a reason to skip the check.
 */
export function verifyExactOrigin(request: { headers: Headers }): OriginVerdict {
  const configured = configuredPublicOrigin();
  if (!configured) return 'unconfigured';
  if (process.env.NODE_ENV === 'production' && configured.protocol !== 'https:') return 'unconfigured';
  const raw = request.headers.get('origin');
  if (!raw) return 'wrong';
  try {
    return new URL(raw).origin === configured.origin ? 'ok' : 'wrong';
  } catch {
    return 'wrong';
  }
}

/**
 * Same-origin Fetch Metadata, checked WHEN PRESENT (S7 line 279). A caller
 * without the header is not trusted for it, but is not refused on its absence
 * either — the exact-origin check and the signed anti-forgery cookie still
 * stand, and the spec asks only for the present-header case.
 */
export function verifyFetchMetadata(request: { headers: Headers }): boolean {
  const site = request.headers.get('sec-fetch-site');
  if (!site) return true;
  return site === 'same-origin';
}

/** The existing signed anti-forgery cookie. No second cookie type is introduced. */
export async function verifyAntiForgery(request: {
  cookies: { get(name: string): { value: string } | undefined };
}): Promise<boolean> {
  return verifyCsrfToken(request.cookies.get(CSRF_COOKIE_NAME)?.value);
}

export type NonceConsumeResult = 'consumed' | 'used' | 'unavailable';

/**
 * One use, across concurrent processes and across restarts (S7 line 281).
 *
 * The primary key does the arbitration: SQLite applies exactly one winning
 * `INSERT` and every other attempt sees `changes === 0`. Nothing is cached in
 * process memory, so a second process — or the same process after a restart —
 * cannot be talked into a second redemption.
 *
 * FAILS CLOSED: any database error is 'unavailable', never a silent pass.
 */
export function consumeOwnerLoginNonce(nonce: string, expiresAt: number): NonceConsumeResult {
  try {
    const result = run(
      'INSERT OR IGNORE INTO hq_owner_login_uses (nonce, expires_at, used_at) VALUES (?,?,?)',
      [nonce, expiresAt, Math.floor(Date.now() / 1000)],
    );
    return result.changes === 1 ? 'consumed' : 'used';
  } catch {
    return 'unavailable';
  }
}

/**
 * Retention for the nonce table: drop rows that are past `expires_at + 24h`.
 *
 * Deliberately best-effort and deliberately NOT a login gate — maintenance
 * must never turn a working sign-in into a failure. Until a sweeper exists,
 * this is called on the redemption path; every row is a few dozen bytes and a
 * fresh row can never satisfy the predicate, so the call cannot delete the
 * nonce it is about to write.
 */
export function pruneOwnerLoginUses(nowSeconds: number = Math.floor(Date.now() / 1000)): void {
  try {
    run('DELETE FROM hq_owner_login_uses WHERE expires_at < ?', [
      nowSeconds - OWNER_LOGIN_USE_KEEP_SECONDS,
    ]);
  } catch {
    /* best effort: never let cleanup break an otherwise valid sign-in */
  }
}

/** True when a nonce row is still present (diagnostics only; never an auth gate). */
export function ownerLoginNonceSeen(nonce: string): boolean {
  try {
    return !!queryOne<{ nonce: string }>(
      'SELECT nonce FROM hq_owner_login_uses WHERE nonce = ?',
      [nonce],
    );
  } catch {
    return false;
  }
}

/**
 * The self-kind + company + installation fence (S7 line 275).
 *
 * `verifyTenantGrant` already binds the ticket to whatever registration the
 * request's host resolves to. That is not enough here: a client-kind host must
 * never redeem an owner ticket, and a permissive registry entry must not let a
 * box whose configured installation disagrees mint or accept one. Env values
 * are only compared when they are actually set, so an unprovisioned box is not
 * refused for a variable nobody configured.
 */
export function registrationAllowsOwnerLogin(host: string): boolean {
  let registration;
  try {
    registration = tenantRegistration(host);
  } catch {
    return false;
  }
  if (registration.kind !== 'self') return false;
  const installation = (process.env.MC_INSTALLATION_ID || '').trim();
  if (installation && registration.installationId !== installation) return false;
  const company = (process.env.MC_COMPANY_ID || '').trim();
  if (company && registration.companyId !== company) return false;
  return true;
}

export interface OwnerBrowserIdentity {
  /** 'session' = the existing mc_tenant_session cookie; 'access' = a verified Access JWT. */
  via: 'session' | 'access';
  subject: string;
  tenantId: string;
  companyId: string;
  installationId: string;
  host: string;
  /** Unix seconds for a verified session cookie; null for an Access identity (no local clock). */
  expiresAt: number | null;
}

/**
 * Verified EXISTING browser identity, or null.
 *
 * Two accepted principals, and they stay separate: the signed session cookie,
 * or a cryptographically verified Cloudflare Access JWT resolved by the shared
 * `resolveTenantContext`. A service bearer is not a browser owner — this
 * module never returns `operator:api` (S7 line 269), and callers must refuse a
 * presented Authorization header outright rather than fall back to it.
 */
export async function resolveOwnerBrowserIdentity(request: {
  headers: Headers;
  cookies: { get(name: string): { value: string } | undefined };
}): Promise<OwnerBrowserIdentity | null> {
  let host: string;
  try {
    host = requestHost(request);
  } catch {
    return null;
  }
  try {
    const grant = await verifyTenantGrant(tenantSessionToken(request), host, 'session');
    if (grant) {
      return {
        via: 'session',
        subject: grant.subject,
        tenantId: grant.tenantId,
        companyId: grant.companyId || '',
        installationId: grant.installationId,
        host,
        expiresAt: grant.exp,
      };
    }
  } catch {
    /* fall through to Access */
  }
  try {
    const context = await resolveTenantContext(request);
    if (context.subject === 'operator:api') return null;
    return {
      via: 'access',
      subject: context.subject,
      tenantId: context.tenantId,
      companyId: context.companyId,
      installationId: context.installationId,
      host: context.host,
      expiresAt: null,
    };
  } catch {
    return null;
  }
}

/** Cookie attributes for the owner session: the existing contract, unchanged (S7 line 283). */
export function ownerSessionCookieAttributes() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax' as const,
    path: '/',
  };
}

/**
 * Mint the destination session grant. Pure signing — NOTHING is mutated here,
 * which is what lets the route sign before it consumes the nonce and keeps a
 * signing failure from burning a valid ticket.
 */
export async function signOwnerSession(input: {
  tenantId: string;
  companyId: string;
  installationId: string;
  host: string;
  subject: string;
}): Promise<{ token: string; expiresAt: number }> {
  const expiresAt = Math.floor(Date.now() / 1000) + OWNER_SESSION_TTL_SECONDS;
  const token = await signTenantGrant({
    purpose: 'session',
    tenantId: input.tenantId,
    companyId: input.companyId,
    installationId: input.installationId,
    host: input.host,
    subject: input.subject,
    exp: expiresAt,
    nonce: randomUUID(),
  });
  return { token, expiresAt };
}

export { TENANT_SESSION_COOKIE };
