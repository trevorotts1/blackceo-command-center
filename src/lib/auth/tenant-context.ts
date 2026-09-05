/** Edge-safe authenticated tenant context. Host/edge headers select configuration, never authority. */
export interface TenantContext {
  tenantId: string; companyId: string; clientId: string | null;
  kind: 'self' | 'client'; subject: string; host: string; installationId: string;
}
export interface TenantRegistration {
  tenantId: string; companyId: string; clientId?: string;
  kind: 'self' | 'client'; installationId: string; subjects?: string[];
  issuer?: string; audience?: string;
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
  // Explicit local development mode only. Production requires a registered hostname.
  if (process.env.NODE_ENV !== 'production' && ['localhost', '127.0.0.1', '[::1]'].includes(host)) {
    return { tenantId: 'self', companyId: process.env.MC_COMPANY_ID || 'default', kind: 'self', installationId: process.env.MC_INSTALLATION_ID || 'local' };
  }
  throw new TenantAccessError('Hostname has no configured tenant');
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
export interface TenantGrant { purpose: 'session' | 'enrollment'; tenantId: string; subject: string; host: string; installationId: string; exp: number; nonce: string; }
export async function signTenantGrant(grant: TenantGrant): Promise<string> {
  const payload = b64(enc.encode(JSON.stringify(grant)));
  return `${payload}.${b64(await signature(payload))}`;
}
export async function verifyTenantGrant(token: string | null, host: string, purpose: TenantGrant['purpose']): Promise<TenantGrant | null> {
  try {
    if (!token) return null;
    const [payload, sig, extra] = token.split('.');
    if (!payload || !sig || extra || !equal(bytes(sig), await signature(payload))) return null;
    const grant = json(payload) as TenantGrant;
    const reg = tenantRegistration(host);
    if (grant.purpose !== purpose || grant.host !== host || grant.tenantId !== reg.tenantId || grant.installationId !== reg.installationId || !grant.subject || !grant.nonce || !Number.isFinite(grant.exp) || grant.exp <= Date.now() / 1000) return null;
    return grant;
  } catch { return null; }
}
const jwks = new Map<string, { expires: number; keys: JsonWebKey[] }>();
async function verifyAccessJwt(token: string, reg: TenantRegistration): Promise<string | null> {
  if (!reg.issuer || !reg.audience || !reg.subjects?.length) return null;
  try {
    const issuer = new URL(reg.issuer);
    if (issuer.protocol !== 'https:') return null;
    const [headerRaw, payloadRaw, sig, extra] = token.split('.');
    if (extra || !sig) return null;
    const header = json(headerRaw), claims = json(payloadRaw);
    if (header.alg !== 'RS256' || !header.kid || claims.iss !== reg.issuer || !Number.isFinite(claims.exp) || claims.exp <= Date.now()/1000 || (claims.nbf && claims.nbf > Date.now()/1000) || ![claims.aud].flat().includes(reg.audience) || !reg.subjects.includes(claims.sub)) return null;
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
    return await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, bytes(sig), enc.encode(`${headerRaw}.${payloadRaw}`)) ? claims.sub : null;
  } catch { return null; }
}
export async function resolveTenantContext(request: { headers: Headers }): Promise<TenantContext> {
  const host = requestHost(request), reg = tenantRegistration(host);
  let subject: string | null = null;
  const bearer = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
  if (bearer && process.env.MC_API_TOKEN && equal(enc.encode(bearer), enc.encode(process.env.MC_API_TOKEN))) subject = 'operator:api';
  if (!subject) {
    const cookie = request.headers.get('cookie')?.split(';').map(s => s.trim()).find(s => s.startsWith(TENANT_SESSION_COOKIE+'='))?.slice(TENANT_SESSION_COOKIE.length+1) || null;
    subject = (await verifyTenantGrant(cookie, host, 'session'))?.subject || null;
  }
  if (!subject) subject = await verifyAccessJwt(request.headers.get('cf-access-jwt-assertion') || '', reg);
  if (!subject && process.env.NODE_ENV !== 'production' && process.env.INTERVIEW_TENANT_TRUST_LOCAL === 'true' && ['localhost','127.0.0.1'].includes(host)) subject = 'development:local';
  if (!subject) throw new TenantAccessError('A verified tenant identity is required');
  return { tenantId: reg.tenantId, companyId: reg.companyId, clientId: reg.clientId || null, kind: reg.kind, subject, host, installationId: reg.installationId };
}
