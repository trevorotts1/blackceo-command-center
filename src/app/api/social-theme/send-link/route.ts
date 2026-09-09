import { NextRequest, NextResponse } from 'next/server';
import { resolveTenantContext } from '@/lib/auth/tenant-context';
import { deliverSocialLink, localSocialBinding, localWeek } from '@/lib/social-theme/delivery';
export const runtime='nodejs';
export const dynamic='force-dynamic';
export async function POST(req:NextRequest) {
  const headers={'cache-control':'private, no-store'};
  try {
    const context=await resolveTenantContext(req);
    if(context.kind!=='self'||context.subject!=='operator:api'||context.companyId!==process.env.MC_COMPANY_ID||context.installationId!==process.env.MC_INSTALLATION_ID)return NextResponse.json({error:'operator_required'},{status:403,headers});
    const body=await req.json().catch(()=>({}));
    if(Object.keys(body).some(k=>!['week_start_local','renew'].includes(k)))return NextResponse.json({error:'invalid_request'},{status:400,headers});
    const binding=localSocialBinding();
    const week=body.week_start_local || localWeek(new Date(),binding.timezone);
    if(typeof week!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(week))return NextResponse.json({error:'invalid_week'},{status:400,headers});
    if (body.renew !== undefined && typeof body.renew !== 'boolean') return NextResponse.json({error:'invalid_request'},{status:400,headers});
    const date = new Date(`${week}T00:00:00Z`);
    if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0,10) !== week || date.getUTCDay() !== 1) return NextResponse.json({error:'week_must_be_monday'},{status:400,headers});
    const result=await deliverSocialLink({week,renew:body.renew===true});
    const ok=['delivered','already_delivered','already_submitted'].includes(result.status || '');
    return NextResponse.json({ok,...result},{status:ok?200:409,headers});
  } catch { return NextResponse.json({error:'social_link_delivery_unavailable'},{status:503,headers}); }
}
