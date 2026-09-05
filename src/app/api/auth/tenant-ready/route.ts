import { NextRequest, NextResponse } from 'next/server';
import { resolveTenantContext } from '@/lib/auth/tenant-context';
import { queryOne } from '@/lib/db';
import { personaCompanyContext } from '@/lib/persona-company';
import fs from 'node:fs';
export const runtime='nodejs';
export const dynamic='force-dynamic';
/** Read-only installation handshake. Token/hostname registration must already be provisioned. */
export async function GET(req:NextRequest) {
 try {
  const context=await resolveTenantContext(req);
  if(context.subject!=='operator:api')return NextResponse.json({error:'operator_required'},{status:403});
  const missing:string[]=[];
  if(context.kind!=='self')missing.push('dedicated_self_registration');
  if(process.env.MC_INSTALLATION_ID!==context.installationId)missing.push('installation_id');
  if(!queryOne('SELECT id FROM companies WHERE id=?',[context.companyId]))missing.push('company_record');
  try {
    const persona=personaCompanyContext(context.companyId);
    const catalog=JSON.parse(fs.readFileSync(persona.personaCatalog,'utf8'));
    if(!catalog || typeof catalog!=='object')missing.push('persona_catalog');
  } catch { missing.push('persona_company_context_or_catalog'); }
  if(!process.env.MC_TENANT_SESSION_SECRET&&!process.env.MC_INTERVIEW_COOKIE_SECRET&&!process.env.MC_API_TOKEN)missing.push('session_secret');
  if(req.nextUrl.searchParams.get('requireRemoteReceiver')==='1') {
    if(!process.env.MC_INTERVIEW_REMOTE_SECRET)missing.push('remote_receiver_secret');
    const paths=await import('@/lib/interview/paths');
    if(!paths.scriptExists(paths.updateInterviewStateScript())||!paths.scriptExists(paths.recordDeptDecisionScript())||!paths.scriptExists(paths.listCanonicalDepartmentsScript()))missing.push('interview_receiver_scripts');
  }
  return NextResponse.json({ready:missing.length===0,protocol:'interview.v1',tenantId:context.tenantId,companyId:context.companyId,installationId:context.installationId,host:context.host,kind:context.kind,missing},{status:missing.length?503:200,headers:{'cache-control':'private, no-store'}});
 }catch{return NextResponse.json({ready:false,error:'tenant_registration_or_identity_unverified'},{status:403});}
}
