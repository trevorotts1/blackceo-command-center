/** Dedicated-installation receiver. No operator fallback and no external side effects before identity verification. */
import { NextRequest, NextResponse } from 'next/server';
import { createHash } from 'crypto';
import { queryOne, run, transaction, timeNow } from '@/lib/db';
import { requestHost, tenantRegistration } from '@/lib/auth/tenant-context';
import { verifyRemoteBody, INTERVIEW_PROTOCOL } from '@/lib/interview/remote-protocol';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function POST(req:NextRequest) {
  let body: any;
  try {
    const raw=await req.text();
    if(raw.length>3_000_000)return NextResponse.json({error:'payload_too_large'},{status:413});
    const secret=process.env.MC_INTERVIEW_REMOTE_SECRET || '';
    if(!verifyRemoteBody(raw,req.headers.get('x-interview-signature')||'',secret))return NextResponse.json({error:'invalid_signature'},{status:403});
    body=JSON.parse(raw);
    const reg=tenantRegistration(requestHost(req));
    if(reg.kind!=='self' || body.protocol!==INTERVIEW_PROTOCOL || body.tenantId!==reg.tenantId || body.companyId!==reg.companyId || body.installationId!==reg.installationId || !Number.isFinite(body.expiresAt) || body.expiresAt<Date.now() || body.expiresAt>Date.now()+60_000 || !Number.isFinite(body.issuedAt) || body.issuedAt>Date.now()+5000 || Date.now()-body.issuedAt>60_000) return NextResponse.json({error:'wrong_scope_or_expired'},{status:403});
    if(body.type==='capabilities') {
      const paths=await import('@/lib/interview/paths');
      const update=paths.scriptExists(paths.updateInterviewStateScript());
      const decision=paths.scriptExists(paths.recordDeptDecisionScript());
      const departments=paths.scriptExists(paths.listCanonicalDepartmentsScript());
      return NextResponse.json({protocol:INTERVIEW_PROTOCOL,installationId:reg.installationId,operations:['state',...(update?['answer']:[]),...(decision?['decision']:[]),...(departments?['departments']:[]),...(update&&departments?['complete']:[])]});
    }
    if(!['answer','decision','complete','state','departments'].includes(body.type)||typeof body.operationId!=='string'||!body.operationId||typeof body.interviewId!=='string'||!body.interviewId||!body.subject)return NextResponse.json({error:'invalid_operation'},{status:400});
    if(!process.env.MC_API_TOKEN)return NextResponse.json({error:'receiver_not_configured'},{status:503});
    const fingerprint=createHash('sha256').update(JSON.stringify({tenantId:body.tenantId,interviewId:body.interviewId,type:body.type,payload:body.payload})).digest('hex');
    const prior=queryOne<{fingerprint:string;receipt:string|null;state:string}>('SELECT * FROM interview_receiver_receipts WHERE operation_id=?',[body.operationId]);
    if(prior){
      if(prior.fingerprint!==fingerprint)return NextResponse.json({error:'operation_conflict'},{status:409});
      return prior.receipt?NextResponse.json(JSON.parse(prior.receipt)):NextResponse.json({operationId:body.operationId,tenantId:body.tenantId,installationId:reg.installationId,state:'unknown',reason:'prior_attempt_requires_reconciliation'},{status:202});
    }
    const claimed=transaction(()=>{
      run('INSERT OR IGNORE INTO tenant_interviews(tenant_id,interview_id,updated_at) VALUES(?,?,?)',[body.tenantId,body.interviewId,timeNow()]);
      const interview=queryOne<{interview_id:string}>('SELECT interview_id FROM tenant_interviews WHERE tenant_id=?',[body.tenantId]);
      if(interview?.interview_id!==body.interviewId)return false;
      return !!run('INSERT OR IGNORE INTO interview_receiver_receipts(operation_id,tenant_id,fingerprint,state,created_at) VALUES(?,?,?,?,?)',[body.operationId,body.tenantId,fingerprint,'applying',timeNow()]).changes;
    });
    if(!claimed)return NextResponse.json({error:'interview_revision_conflict'},{status:409});
    const headers=new Headers({'host':requestHost(req),'authorization':`Bearer ${process.env.MC_API_TOKEN}`,'content-type':'application/json'});
    let response:Response;
    const url=`https://${requestHost(req)}/api/interview/${body.type}`;
    if(body.type==='state') response=await (await import('../state/route')).GET(new NextRequest(url,{headers}));
    else if(body.type==='departments') response=await (await import('../canonical-departments/route')).GET(new NextRequest(url,{headers}));
    else {
      const payload={...body.payload};
      if(body.type==='decision'){payload.sessionId=body.interviewId;}
      if(body.type==='answer'){payload.sessionId=body.interviewId;payload.askedBy=body.subject;}
      const delegated=new NextRequest(url,{method:'POST',headers,body:JSON.stringify(payload)});
      if(body.type==='answer')response=await (await import('../answer/route')).POST(delegated);
      else if(body.type==='decision') {
        if(typeof payload.dept!=='string' || !['yes','no','later'].includes(payload.decision))response=NextResponse.json({error:'invalid_decision'},{status:400});
        else {
          await (await import('@/lib/interview/seam')).recordDeptDecision({dept:payload.dept,decision:payload.decision,by:body.subject,session:body.interviewId,source:'owner-interview'});
          response=NextResponse.json({ok:true,dept:payload.dept,decision:payload.decision,sessionId:body.interviewId});
        }
      }
      else response=await (await import('../complete/route')).POST(delegated);
    }
    const result=await response.json();
    const canonical=(await import('@/lib/interview/seam')).readBuildState();
    const buildId=typeof canonical?.buildId==='string'?canonical.buildId:null;
    const receipt={operationId:body.operationId,tenantId:body.tenantId,installationId:reg.installationId,interviewId:body.interviewId,buildId,state:'acknowledged',result,httpStatus:response.status};
    run('UPDATE interview_receiver_receipts SET state=?,receipt=? WHERE operation_id=?',['acknowledged',JSON.stringify(receipt),body.operationId]);
    return NextResponse.json(receipt);
  } catch { return NextResponse.json({error:'receiver_unavailable'},{status:503}); }
}
