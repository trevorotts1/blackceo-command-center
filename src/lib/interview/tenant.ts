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

import type { NextRequest } from 'next/server';
import { getClient, type Client } from '@/lib/clients';

export interface InterviewTenant {
  kind: 'self' | 'client';
  /** The remote client row when kind === 'client'. */
  client: Client | null;
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
      const client = getClient(clientId);
      if (client && !client.is_self) {
        return { kind: 'client', client };
      }
    }
  }
  return { kind: 'self', client: null };
}

/** Hostname passed by callers that construct a synthetic request (middleware). */
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
