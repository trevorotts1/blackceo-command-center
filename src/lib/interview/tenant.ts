import { NextResponse, type NextRequest } from 'next/server';
import { getClient, type Client } from '@/lib/clients';
import { resolveTenantContext, tenantRegistration, type TenantContext } from '@/lib/auth/tenant-context';

export interface InterviewTenant {
  kind: 'self' | 'client' | 'unverified'; client: Client | null;
  reason?: string; context?: TenantContext;
}
export async function resolveInterviewTenant(request: NextRequest): Promise<InterviewTenant> {
  try {
    const context = await resolveTenantContext(request);
    if (context.kind === 'self') return { kind: 'self', client: null, context };
    const client = getClient(context.clientId!);
    if (!client || client.is_self) throw new Error('Configured client is unavailable');
    return { kind: 'client', client, context };
  } catch {
    return { kind: 'unverified', client: null, reason: 'Verified tenant identity and registration required' };
  }
}
export function refuseUnverifiedTenant(tenant: InterviewTenant): NextResponse | null {
  return tenant.kind === 'unverified' ? NextResponse.json({error: 'forbidden', detail: 'unverified interview tenant'}, {status:403}) : null;
}
/** Routing only, exclusively after a purpose/host-bound internal gate signature verified. */
export function tenantForHost(host: string | null): InterviewTenant {
  try {
    const normalized = new URL(`http://${host || ''}`).hostname;
    const reg = tenantRegistration(normalized);
    if (reg.kind === 'self') return {kind:'self',client:null};
    const client = getClient(reg.clientId!);
    if (!client || client.is_self) throw new Error('Missing client');
    return {kind:'client',client};
  } catch { return {kind:'unverified',client:null}; }
}
