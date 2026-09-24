/** Edge-safe authenticated tenant context. Host/edge headers select configuration, never authority. */
export interface TenantContext {
  tenantId: string; companyId: string; clientId: string | null;
  kind: 'self' | 'client'; subject: string; host: string; installationId: string;
  /** Verified owner email from the cryptographically verified Access JWT claim.
   *  Null unless the identity was proven via RS256/JWKS above. Never a raw header. */
  email?: string | null;
}
export interface TenantRegistration {
  tenantId: string; companyId: string; clientId?: string;
  kind: 'self' | 'client'; installationId: string; subjects?: string[];
  issuer?: string; audience?: string;
  /** Exact owner emails allowed via the verified Access JWT `email` claim.
   *  Checked ONLY against the signed claim, never a header. When absent, any
   *  email on a valid JWT is accepted and only `subjects` gates identity. */
  allowedEmails?: string[];
  remoteUrl?: string; remoteSecret?: string; remoteApiToken?: string;
}
export class TenantAccessError extends Error { status = 403; }
export const TENANT_SESSION_COOKIE = 'mc_tenant_session';
const enc = new TextEncoder();
function b64(bytes: Uint8Array): string { return btoa(String.fromCharCode(...Array.from(bytes))).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_'); }
function bytes(value: string): Uint8Array<ArrayBuffer> { return Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0)); }
function json(value: string): any { return JSON.parse(new TextDecoder().decode(bytes(value))); }
export function requestHost(request: { headers: Headers }): string {
  const raw = request.headers.get('host') || '';
  try { return new URL(`http://${raw}`).hostname.toLowerCase(); } catch { throw new TenantAccessError('Invalid hostname'); }
}
export function tenantRegistration(host: string): TenantRegistration {
  const registrations = JSON.parse(process.env.MC_TENANT_REGISTRY_JSON || '{}') as Record<string, TenantRegistration>;
  const reg = registrations[host];
  if (reg && reg.tenantId && reg.companyId && reg.installationId && (reg.kind === 'self' || (reg.kind === 'client' && reg.clientId))) return reg;
  const implicitSelf = (): TenantRegistration => ({ tenantId: 'self', companyId: process.env.MC_COMPANY_ID || 'default', kind: 'self', installationId: process.env.MC_INSTALLATION_ID || 'local' });
  const loopback = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(host);
  // Explicit local development mode only. Production requires a registered hostname.
  if (process.env.NODE_ENV !== 'production' && loopback) return implicitSelf();
  // Implicit self registration (2026-09-18): a production box with NO registry
  // configured at all is an unprovisioned single-tenant installation, not a
  // multi-tenant host. Before the registry existed such a box served exactly one
  // tenant (itself) on its own public hostname and on loopback; refusing both
  // turned every unprovisioned box into a 403 wall (measured on VPS + Mac boxes
  // upgraded 2026-09-18) and blinded the loopback health probes. Only two hosts
  // qualify: loopback (reachable from the box alone) and the hostname of the
  // box's own configured public URL. Every other host still has no tenant, and a
  // box WITH a registry keeps the strict behaviour above unchanged.
  if (Object.keys(registrations).length === 0) {
    if (loopback) return implicitSelf();
    const own = ownPublicHost();
    if (own && own === host) return implicitSelf();
  }
  throw new TenantAccessError('Hostname has no configured tenant');
}
function ownPublicHost(): string | null {
  const raw = process.env.CC_PUBLIC_URL || process.env.MC_TENANT_PUBLIC_URL || '';
  if (!raw) return null;
  try { return new URL(raw).hostname.toLowerCase(); } catch { return null; }
}
function secret(): string {
  const value = process.env.MC_TENANT_SESSION_SECRET || process.env.MC_INTERVIEW_COOKIE_SECRET || process.env.MC_API_TOKEN;
  if (!value) throw new TenantAccessError('Tenant authentication is not configured');
  return value;
}
async function signature(payload: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret()), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(payload)));
}
function equal(a: Uint8Array, b: Uint8Array): boolean { let diff = a.length ^ b.length; for (let i = 0; i < a.length; i++) diff |= a[i] ^ (b[i] ?? 0); return diff === 0; }
export interface TenantGrant { purpose: 'session' | 'enrollment'; tenantId: string; companyId?: string; subject: string; host: string; installationId: string; exp: number; nonce: string; }
export async function signTenantGrant(grant: TenantGrant): Promise<string> {
  // All newly signed grants carry company ownership. Serialized legacy grants
  // without this claim must sign in again; registry changes cannot rebind them.
  const bound = { ...grant, companyId: grant.companyId || tenantRegistration(grant.host).companyId };
  const payload = b64(enc.encode(JSON.stringify(bound)));
  return `${payload}.${b64(await signature(payload))}`;
}
/** Enrollment tickets carry NO clock expiry: an interview invitation stays
 * valid until the interview itself is complete, so a client who opens the link
 * days or weeks later is never locked out of an unfinished interview. The
 * completion check lives at the redemption route (interview-session), which is
 * the only place that knows the build state. `exp` is still required to be a
 * finite number, so a truncated or tampered payload fails here, and it is still
 * enforced exactly as before for browser SESSION grants. */
function grantExpired(grant: TenantGrant): boolean {
  return grant.purpose === 'session' && grant.exp <= Date.now() / 1000;
}
async function verifyGrant(token: string | null, host: string, purpose: TenantGrant['purpose']): Promise<TenantGrant | null> {
  try {
    if (!token) return null;
    const [payload, sig, extra] = token.split('.');
    if (!payload || !sig || extra || !equal(bytes(sig), await signature(payload))) return null;
    const grant = json(payload) as TenantGrant;
    const reg = tenantRegistration(host);
    if (grant.purpose !== purpose || grant.host !== host || grant.tenantId !== reg.tenantId || grant.companyId !== reg.companyId || grant.installationId !== reg.installationId || !grant.subject || !grant.nonce || !Number.isFinite(grant.exp) || grantExpired(grant)) return null;
    return grant;
  } catch { return null; }
}
export async function verifyTenantGrant(token: string | null, host: string, purpose: TenantGrant['purpose']): Promise<TenantGrant | null> {
  return verifyGrant(token, host, purpose);
}
/** Identity comparison only, after an independently verified LIVE session.
 * This never authorizes enrollment or extends session lifetime. */
export async function verifyEnrollmentIdentity(token: string | null, host: string): Promise<TenantGrant | null> {
  return verifyGrant(token, host, 'enrollment');
}
export function tenantSessionToken(request: { headers: Headers }): string | null {  return request.headers.get('cookie')?.split(';').map(s => s.trim())
    .find(s => s.startsWith(TENANT_SESSION_COOKIE + '='))?.slice(TENANT_SESSION_COOKIE.length + 1) || null;
}
const jwks = new Map<string, { expires: number; keys: JsonWebKey[] }>();
/** Verified Access identity: subject plus the signed email claim. The `email`
 *  header is attacker-controlled and never read — only the JWT claim inside a
 *  signature-verified, issuer/audience/expiry/claim-checked RS256 token. */
export interface VerifiedAccessIdentity { sub: string; email: string | null; }
async function verifyAccessJwt(token: string, reg: TenantRegistration): Promise<VerifiedAccessIdentity | null> {
  if (!reg.issuer || !reg.audience || !reg.subjects?.length) return null;
  try {
    const issuer = new URL(reg.issuer);
    if (issuer.protocol !== 'https:') return null;
    const [headerRaw, payloadRaw, sig, extra] = token.split('.');
    if (extra || !sig) return null;
    const header = json(headerRaw), claims = json(payloadRaw);
    if (header.alg !== 'RS256' || !header.kid || claims.iss !== reg.issuer || !Number.isFinite(claims.exp) || claims.exp <= Date.now()/1000 || (claims.nbf && claims.nbf > Date.now()/1000) || ![claims.aud].flat().includes(reg.audience) || typeof claims.sub !== 'string' || !claims.sub.trim()) return null;
    // Exact allowed-email allowlist, enforced ONLY on the signed `email` claim.
    // Unsigned headers never participate. When configured, a valid JWT whose
    // signed email is not listed is rejected — identity without authorization.
    const signedEmail = typeof claims.email === 'string' && claims.email.trim() ? claims.email.trim() : null;
    if (reg.allowedEmails?.length && (!signedEmail || !reg.allowedEmails.map(e => e.toLowerCase()).includes(signedEmail.toLowerCase()))) return null;
    let cached = jwks.get(reg.issuer);
    if (!cached || cached.expires <= Date.now()) {
      const response = await fetch(new URL('/cdn-cgi/access/certs', issuer), { signal: AbortSignal.timeout(5000), redirect: 'error' });
      if (!response.ok) return null;
      const body = await response.json();
      if (!Array.isArray(body.keys)) return null;
      cached = { expires: Date.now() + 300_000, keys: body.keys };
      jwks.set(reg.issuer, cached);
    }
    const keyData = cached.keys.find(k => (k as JsonWebKey & {kid?: string}).kid === header.kid);
    if (!keyData || keyData.kty !== 'RSA') return null;
    const key = await crypto.subtle.importKey('jwk', keyData, {name: 'RSASSA-PKCS1-v1_5', hash:'SHA-256'}, false, ['verify']);
    if (!await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, bytes(sig), enc.encode(`${headerRaw}.${payloadRaw}`))) return null;
    // Legacy provisioning stored emails in subjects. Match those only against
    // the signature-verified email claim; opaque subjects still match sub exactly.
    const authorized = reg.subjects.some(subject => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(subject)
      ? signedEmail !== null && subject.toLowerCase() === signedEmail.toLowerCase()
      : subject === claims.sub);
    if (!authorized) return null;
    return { sub: claims.sub as string, email: signedEmail };
  } catch { return null; }
}
export async function resolveTenantContext(request: { headers: Headers }): Promise<TenantContext> {
  const host = requestHost(request), reg = tenantRegistration(host);
  let subject: string | null = null;
  let email: string | null = null;
  const bearer = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
  if (bearer && process.env.MC_API_TOKEN && equal(enc.encode(bearer), enc.encode(process.env.MC_API_TOKEN))) subject = 'operator:api';
  if (!subject) {
    const cookie = tenantSessionToken(request);
    subject = (await verifyTenantGrant(cookie, host, 'session'))?.subject || null;
  }
  // Cloudflare Access owner login, cryptographically verified in-process:
  // RS256/JWKS signature, issuer, audience, expiry/nbf, exact subject and —
  // when configured — exact signed-email allowlist. The unsigned email/header
  // values are never trusted; only the claims inside a verified token identify
  // the owner. No public slug fallback, no fake bearer: boxes without
  // issuer/audience/subjects configured cannot verify (verifyAccessJwt nulls)
  // and fall through to the refusal below. Opaque subjects match sub exactly;
  // legacy email entries match only the cryptographically verified email claim.
  if (!subject) {
    const verified = await verifyAccessJwt(request.headers.get('cf-access-jwt-assertion') || '', reg);
    if (verified) { subject = verified.sub; email = verified.email; }
  }
  if (!subject && process.env.NODE_ENV !== 'production' && process.env.INTERVIEW_TENANT_TRUST_LOCAL === 'true' && ['localhost','127.0.0.1'].includes(host)) subject = 'development:local';
  if (!subject) throw new TenantAccessError('A verified tenant identity is required');
  return { tenantId: reg.tenantId, companyId: reg.companyId, clientId: reg.clientId || null, kind: reg.kind, subject, host, installationId: reg.installationId, email };
}
