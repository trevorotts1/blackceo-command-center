import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'crypto';
import { run } from '@/lib/db';
import { requestHost, verifyTenantGrant, signTenantGrant, TENANT_SESSION_COOKIE } from '@/lib/auth/tenant-context';
export const runtime = 'nodejs';
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const host = requestHost(req);
    const grant = await verifyTenantGrant(typeof body.ticket === 'string' ? body.ticket : null, host, 'enrollment');
    if (!grant) return NextResponse.json({error:'invalid_enrollment'}, {status:403});
    const used = run('INSERT OR IGNORE INTO interview_enrollment_uses (nonce,used_at) VALUES (?,?)', [grant.nonce, new Date().toISOString()]);
    if (!used.changes) return NextResponse.json({error:'enrollment_already_used'}, {status:409});
    const response = NextResponse.json({ok:true});
    response.cookies.set(TENANT_SESSION_COOKIE, await signTenantGrant({...grant,purpose:'session',exp:Math.floor(Date.now()/1000)+3600,nonce:randomUUID()}), {httpOnly:true,secure:process.env.NODE_ENV==='production',sameSite:'strict',path:'/',maxAge:3600});
    return response;
  } catch { return NextResponse.json({error:'enrollment_unavailable'}, {status:503}); }
}
