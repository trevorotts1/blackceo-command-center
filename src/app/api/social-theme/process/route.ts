import { NextRequest,NextResponse } from 'next/server';
import { resolveTenantContext } from '@/lib/auth/tenant-context';
import { processSocialSubmission } from '@/lib/social-theme/submission-worker';
export const runtime='nodejs';export const dynamic='force-dynamic';
export async function POST(req:NextRequest){
 try{const c=await resolveTenantContext(req);if(c.kind!=='self'||c.subject!=='operator:api'||c.companyId!==process.env.MC_COMPANY_ID||c.installationId!==process.env.MC_INSTALLATION_ID)return NextResponse.json({error:'operator_required'},{status:403});
 return NextResponse.json(await processSocialSubmission(),{headers:{'cache-control':'no-store'}});
 }catch{return NextResponse.json({error:'social_handoff_unavailable'},{status:503});}
}
