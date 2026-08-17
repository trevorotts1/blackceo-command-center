/**
 * Interview tenant resolution (JANET-INTERVIEW-FIX, 2026-08-13).
 *
 * The shared Command Center serves EVERY client dashboard on one process, so
 * a client's hostname (e.g. janet.zerohumanworkforce.com) lands on this box
 * even though the client's own OpenClaw container lives elsewhere. Before this
 * module existed, /api/interview/* answered from the OPERATOR's own canonical
 * interview files — a fresh client was told interviewComplete=true (the
 * operator's completed interview) and the /interview page redirected itself
 * straight to the dashboard (InterviewClient.tsx: interviewComplete → /).
 *
 * Resolution contract:
 *   • Host header matches a KNOWN remote-client hostname → that client's row:
 *     its interview_complete flag (never the operator's files) and its own
 *     gateway (url/token) for the conversation relay.
 *   • Anything else (no Host, unknown Host, the operator's own hostname, or
 *     the self client) → SELF: canonical files win, exactly as before.
 *     Self behavior is a hard regression requirement — it must be unchanged.
 *
 * The hostname → client mapping is kept here, seeded by migration 125, and
 * the client row carries the connection record (gateway_url, gateway_token)
 * the turn route relays to.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { getClient, type Client } from '@/lib/clients';

export interface InterviewTenant {
  kind: 'self' | 'client' | 'unverified';
  /** The remote client row when kind === 'client'. */
  client: Client | null;
  /** Why a client host was refused. Set only when kind === 'unverified'. */
  reason?: string;
}

/**
 * SECURITY (2026-08-17): the Host header is CLIENT-CONTROLLED. Selecting a
 * tenant from it alone let anyone who could reach the origin read and write a
 * client's interview simply by sending `Host: <client>.zerohumanworkforce.com`
 * — proven exploitable with a bare curl against 127.0.0.1:4000, which returned
 * a client's full interview state with no credential.
 *
 * The discriminator: a REAL client request reaches this origin only through the
 * Cloudflare tunnel, so it carries Cloudflare edge headers. A forged-Host
 * request made directly to the origin carries none. We therefore require edge
 * provenance before honoring a client hostname.
 *
 * This is defence-in-depth, not a signature check: anything that can reach the
 * origin directly can also invent a `cf-ray`. It closes the demonstrated local
 * /direct-origin vector and is deliberately chosen over demanding a verified
 * CF Access JWT, because REQUIRE_CF_ACCESS is currently off on this box and a
 * hard JWT requirement would lock live clients out of their own interviews.
 * Upgrade path: verify `cf-access-jwt-assertion` and bind its `aud` to the
 * client's Access application id.
 *
 * Fail CLOSED: a client hostname we cannot corroborate resolves to
 * 'unverified', NEVER to 'self' — falling back to self would hand the
 * operator's own canonical interview to whoever forged the header.
 */
const TRUST_LOCAL_TENANT = process.env.INTERVIEW_TENANT_TRUST_LOCAL === 'true';

function hasEdgeProvenance(headers: Headers): boolean {
  return Boolean(
    headers.get('cf-access-jwt-assertion') ||
      headers.get('cf-ray') ||
      headers.get('cf-connecting-ip'),
  );
}

/** Hostname → clients-row id. One line per remote client served by this CC. */
const REMOTE_CLIENT_HOSTS: Record<string, string> = {
  'janet.zerohumanworkforce.com': 'client-janet-pinkney',
};

/** The operator's own CC hostnames — canonical files, never a client row. */
const SELF_HOSTS = new Set(['trevor.zerohumanworkforce.com', 'localhost', '127.0.0.1']);

function hostFrom(request: NextRequest): string | null {
  const host = request.headers.get('host');
  if (!host) return null;
  return host.split(':')[0].toLowerCase();
}

/**
 * Resolve which tenant this request is for. Never throws: unknown hosts fall
 * back to self (fail-open to the operator's own box — the historical behavior).
 */
export function resolveInterviewTenant(request: NextRequest): InterviewTenant {
  const host = hostFrom(request);
  if (host && !SELF_HOSTS.has(host)) {
    const clientId = REMOTE_CLIENT_HOSTS[host];
    if (clientId) {
      // Host claims a client — corroborate before honoring it.
      if (!hasEdgeProvenance(request.headers) && !TRUST_LOCAL_TENANT) {
        return {
          kind: 'unverified',
          client: null,
          reason:
            `Host '${host}' claims a client tenant but the request carries no ` +
            `Cloudflare edge provenance (cf-ray / cf-connecting-ip / ` +
            `cf-access-jwt-assertion). Refusing: the Host header is ` +
            `client-controlled and cannot by itself authorize access to a ` +
            `client's interview. Set INTERVIEW_TENANT_TRUST_LOCAL=true for ` +
            `local development only.`,
        };
      }
      const client = getClient(clientId);
      if (client && !client.is_self) {
        return { kind: 'client', client };
      }
    }
  }
  return { kind: 'self', client: null };
}

/**
 * Fail-closed guard for every /api/interview/* route. Returns a 403 Response
 * when the tenant could not be corroborated, or null to continue.
 *
 * Every route MUST call this immediately after resolveInterviewTenant(). An
 * 'unverified' tenant must never fall through to the self branch — that is the
 * exact leak this guard exists to prevent.
 */
export function refuseUnverifiedTenant(tenant: InterviewTenant): NextResponse | null {
  if (tenant.kind !== 'unverified') return null;
  console.warn(`[SECURITY] interview tenant refused: ${tenant.reason ?? 'unverified'}`);
  return NextResponse.json(
    { error: 'forbidden', detail: 'unverified interview tenant' },
    { status: 403 },
  );
}

/**
 * Hostname passed by callers that construct a synthetic request (middleware).
 *
 * ROUTING ONLY — never an authorization decision. This variant has no headers
 * to corroborate, so it cannot apply the edge-provenance check above. Callers
 * must not use it to grant access to client data; the API routes re-resolve
 * with resolveInterviewTenant() and fail closed there.
 */
export function tenantForHost(host: string | null): InterviewTenant {
  if (host) {
    const h = host.split(':')[0].toLowerCase();
    if (!SELF_HOSTS.has(h)) {
      const clientId = REMOTE_CLIENT_HOSTS[h];
      if (clientId) {
        const client = getClient(clientId);
        if (client && !client.is_self) {
          return { kind: 'client', client };
        }
      }
    }
  }
  return { kind: 'self', client: null };
}
