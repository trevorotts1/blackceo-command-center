import { createHmac, timingSafeEqual, randomUUID } from 'crypto';
import { tenantRegistration, type TenantContext } from '@/lib/auth/tenant-context';
import { run, queryAll, timeNow } from '@/lib/db';
import { decryptOrPassthrough } from './crypto';
import type { RemoteOperation } from './remote-store';
export const INTERVIEW_PROTOCOL = 'interview.v1';
/**
 * Failures that mean the far side is PARKED, not refusing us: an unresolved
 * transport, a receiver that is not configured yet, HTTP 429 and any 5xx.
 * They never consume the five-attempt dead-letter budget — the operation keeps
 * retrying and keeps its place in line instead of being parked forever.
 */
const PARKED_FAILURE = /^remote_(?:transport_unresolved|not_configured|http_(?:429|5\d\d))$/;
function parkedFailure(reason: string | null): boolean { return !!reason && PARKED_FAILURE.test(reason); }
export function signRemoteBody(body: string, secret: string): string { return createHmac('sha256',secret).update(body).digest('hex'); }
export function verifyRemoteBody(body: string, signature: string, secret: string): boolean {
  if(!secret || !/^[a-f0-9]{64}$/.test(signature))return false;
  return timingSafeEqual(Buffer.from(signRemoteBody(body,secret),'hex'),Buffer.from(signature,'hex'));
}
async function requestRemote(context:TenantContext, type:string, operationId:string, interviewId:string, payload:unknown) {
  const reg=tenantRegistration(context.host);
  if(!reg.remoteUrl || !reg.remoteSecret)throw new Error('remote_not_configured');
  const url=new URL(reg.remoteUrl);
  if(url.protocol!=='https:' && !(process.env.NODE_ENV!=='production' && ['localhost','127.0.0.1'].includes(url.hostname)))throw new Error('remote_requires_https');
  const body=JSON.stringify({protocol:INTERVIEW_PROTOCOL,tenantId:context.tenantId,companyId:context.companyId,installationId:context.installationId,interviewId,operationId,subject:context.subject,type,payload,issuedAt:Date.now(),expiresAt:Date.now()+30_000});
  const response=await fetch(new URL('/api/interview/remote',url), {method:'POST',headers:{'content-type':'application/json','x-interview-signature':signRemoteBody(body,reg.remoteSecret)},body,signal:AbortSignal.timeout(8_000),redirect:'error'});
  if(!response.ok)throw new Error(`remote_http_${response.status}`);
  return response.json();
}
export async function deliverInterviewOperation(context:TenantContext, operation:RemoteOperation):Promise<{state:string;receipt?:any;reason?:string}> {
  if(operation.state==='acknowledged' || operation.state==='rejected')return {state:operation.state,receipt:operation.receipt?JSON.parse(operation.receipt):undefined};
  // Dead-letter is terminal for automatic delivery: five failed attempts move
  // the operation out of the retry loop into an operator-visible queue. The
  // original operation identity is retained so repair + requeue never forks it.
  // A PARKED failure (unresolved transport, receiver not configured, HTTP 429 or
  // 5xx) never counts toward that budget, so it is retried, never parked.
  if(operation.state==='dead_letter' && !parkedFailure(operation.last_error))return {state:operation.state,reason:operation.last_error||'remote_retry_exhausted'};
  if(operation.attempts>=5 && !parkedFailure(operation.last_error)){run(`UPDATE interview_remote_operations SET state='dead_letter',last_error='remote_retry_exhausted',updated_at=? WHERE operation_id=? AND state='pending'`,[timeNow(),operation.operation_id]);return {state:'dead_letter',reason:'remote_retry_exhausted'};}
  if(operation.next_eligible_at && Date.parse(operation.next_eligible_at)>Date.now())return {state:'pending',reason:operation.last_error||'retry_backoff'};
  // Preserve source order so completion cannot overtake an earlier answer/decision.
  // A parked (dead-letter) operation blocks everything behind it instead of being
  // silently overtaken; a rejected answer/decision blocks too, while a rejected
  // `complete` never holds anything back.
  const prior=queryAll<{operation_id:string}>(`SELECT operation_id FROM interview_remote_operations WHERE tenant_id=? AND rowid < (SELECT rowid FROM interview_remote_operations WHERE operation_id=?) AND (state IN ('pending','dead_letter') OR (state='rejected' AND operation_type<>'complete')) LIMIT 1`,[context.tenantId,operation.operation_id]);
  if(prior.length)return {state:'pending',reason:'prior_operation_undelivered'};
  try {
    const capability=await requestRemote(context,'capabilities',randomUUID(),operation.interview_id,{});
    if(capability.protocol!==INTERVIEW_PROTOCOL || capability.installationId!==context.installationId || !capability.operations?.includes(operation.operation_type))throw new Error('remote_capability_unavailable');
    const receipt=await requestRemote({...context,subject:operation.origin_subject||context.subject},operation.operation_type,operation.operation_id,operation.interview_id,JSON.parse(decryptOrPassthrough(operation.payload)||'{}'));
    if(receipt.operationId!==operation.operation_id || receipt.tenantId!==context.tenantId || receipt.installationId!==context.installationId || receipt.state!=='acknowledged')throw new Error('remote_acknowledgement_unresolved');
    // A 429 or 5xx receipt is a PARKED failure, not a rejection: throwing here
    // (before any `rejected` write) sends it down the retry path where it never
    // burns the attempt budget. Only 400-428 and 430-499 mean `rejected`.
    const httpStatus=Number(receipt.httpStatus);
    if(httpStatus===429 || httpStatus>=500)throw new Error('remote_http_'+httpStatus);
    const state=receipt.httpStatus>=400?'rejected':'acknowledged';
    run(`UPDATE interview_remote_operations SET state=?,receipt=?,last_error=NULL,updated_at=? WHERE operation_id=?`,[state,JSON.stringify(receipt),timeNow(),operation.operation_id]);
    if(operation.operation_type==='complete')run('UPDATE tenant_interviews SET remote_status=?,build_id=?,updated_at=? WHERE tenant_id=?',[receipt.result?.status || state,receipt.buildId || null,timeNow(),context.tenantId]);
    return {state,receipt};
  } catch(err) {
    const raw=(err as Error).message;
    const reason=/^remote_[a-z0-9_]+$/.test(raw)?raw:'remote_transport_unresolved';
    // Parked failures back off exponentially (capped at one hour) and always
    // stay pending; the `state IN (...)` predicate lets a parked row that had
    // been dead-lettered come back into the retry loop.
    const attempts=operation.attempts+1;
    const waitSeconds=parkedFailure(reason)?Math.min(3600,30*2**Math.min(attempts,7)):Math.min(3600,30*2**operation.attempts);
    run(`UPDATE interview_remote_operations SET state='pending',attempts=attempts+1,next_eligible_at=?,last_error=?,updated_at=? WHERE operation_id=? AND state IN ('pending','dead_letter')`,[new Date(Date.now()+waitSeconds*1000).toISOString(),reason,timeNow(),operation.operation_id]);
    return {state:'pending',reason};
  }
}
/** Bounded ordered retry, called by authenticated state polling or an explicit retry. */
export async function drainInterviewOperations(context:TenantContext, limit=3) {
  const pending=queryAll<RemoteOperation>(`SELECT * FROM interview_remote_operations WHERE tenant_id=? AND state='pending' ORDER BY rowid LIMIT ?`,[context.tenantId,limit]);
  for(const op of pending){const result=await deliverInterviewOperation(context,op);if(result.state!=='acknowledged')break;}
}
export async function readRemoteInterviewState(context:TenantContext, interviewId:string) {
  const receipt=await requestRemote(context,'state',randomUUID(),interviewId,{});
  if(receipt.tenantId!==context.tenantId || receipt.installationId!==context.installationId || receipt.httpStatus!==200 || receipt.state!=='acknowledged')throw new Error('remote_state_unavailable');
  return receipt.result;
}
