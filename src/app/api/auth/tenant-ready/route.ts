import { NextRequest, NextResponse } from 'next/server';
import { resolveTenantContext } from '@/lib/auth/tenant-context';
import { collectReadinessMissing, gatherReadinessInputs } from '@/lib/readiness';
export const runtime='nodejs';
export const dynamic='force-dynamic';
/** Read-only installation handshake. Token/hostname registration must already be provisioned. */
export async function GET(req:NextRequest) {
 try {
  const context=await resolveTenantContext(req);
  if(context.subject!=='operator:api')return NextResponse.json({error:'operator_required'},{status:403});
  // R-28 shared checklist: the operator handshake derives the SAME missing[]
  // list as the client-facing /api/readiness/checklist — one source of truth.
  const inputs = await gatherReadinessInputs(
    { kind: context.kind, installationId: context.installationId, companyId: context.companyId },
    { requireRemoteReceiver: req.nextUrl.searchParams.get('requireRemoteReceiver') === '1' },
  );
  const missing = collectReadinessMissing(inputs);
  return NextResponse.json({ready:missing.length===0,protocol:'interview.v1',tenantId:context.tenantId,companyId:context.companyId,installationId:context.installationId,host:context.host,kind:context.kind,missing},{status:missing.length?503:200,headers:{'cache-control':'private, no-store'}});
 }catch{return NextResponse.json({ready:false,error:'tenant_registration_or_identity_unverified'},{status:403});}
}
