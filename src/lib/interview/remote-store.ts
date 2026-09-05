import { createHash, randomUUID } from 'crypto';
import { queryAll, queryOne, run, transaction, timeNow } from '@/lib/db';
import { encryptAtRest, decryptOrPassthrough } from './crypto';
import type { TenantContext } from '@/lib/auth/tenant-context';
export interface TenantInterview { tenant_id: string; interview_id: string; revision: number; gateway_session_id: string | null; session_reservation: string | null; session_reserved_at: string | null; remote_status: string; build_id: string | null; updated_at: string; }
export function ensureTenantInterview(tenantId: string): TenantInterview {
  run(`INSERT OR IGNORE INTO tenant_interviews (tenant_id,interview_id,updated_at) VALUES (?,?,?)`, [tenantId,randomUUID(),timeNow()]);
  return queryOne<TenantInterview>('SELECT * FROM tenant_interviews WHERE tenant_id=?',[tenantId])!;
}
export function tenantAnswers(tenantId: string) {
  const interview = ensureTenantInterview(tenantId);
  return queryAll<{operation_id:string;question_id:string;question_text:string;answer_text:string;created_at:string;revision:number}>(
    'SELECT * FROM tenant_interview_answers WHERE tenant_id=? AND interview_id=? ORDER BY revision',[tenantId,interview.interview_id])
    .map(a=>({...a, question_text: decryptOrPassthrough(a.question_text) ?? '', answer_text: decryptOrPassthrough(a.answer_text) ?? ''}));
}
export interface RemoteOperation { operation_id:string;tenant_id:string;interview_id:string;operation_type:string;origin_subject:string;payload:string;fingerprint:string;state:string;attempts:number;next_eligible_at:string|null;last_error:string|null;receipt:string|null; }
export function queueInterviewOperation(context: TenantContext, type: string, payload: Record<string,unknown>, operationId?: string): RemoteOperation {
  if (operationId && !/^[a-zA-Z0-9_-]{8,128}$/.test(operationId)) throw new Error('Invalid operation identity');
  return transaction(()=>{
    const interview=ensureTenantInterview(context.tenantId);
    const canonical=JSON.stringify({tenantId:context.tenantId,interviewId:interview.interview_id,type,payload});
    const fingerprint=createHash('sha256').update(canonical).digest('hex');
    const id=operationId||randomUUID();
    const existing=queryOne<RemoteOperation>('SELECT * FROM interview_remote_operations WHERE operation_id=?',[id]);
    if(existing){ if(existing.fingerprint!==fingerprint)throw new Error('Operation identity conflicts with another request'); return existing; }
    const now=timeNow();
    run(`INSERT INTO interview_remote_operations(operation_id,tenant_id,interview_id,operation_type,origin_subject,payload,fingerprint,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)`,[id,context.tenantId,interview.interview_id,type,context.subject,encryptAtRest(JSON.stringify(payload)),fingerprint,now,now]);
    if(type==='answer') {
      const revision=interview.revision+1;
      run(`INSERT INTO tenant_interview_answers(operation_id,tenant_id,interview_id,question_id,question_text,answer_text,revision,created_at) VALUES(?,?,?,?,?,?,?,?)`,[id,context.tenantId,interview.interview_id,String(payload.questionId||payload.prompt),encryptAtRest(String(payload.prompt)),encryptAtRest(String(payload.answer)),revision,now]);
      run('UPDATE tenant_interviews SET revision=?,updated_at=? WHERE tenant_id=?',[revision,now,context.tenantId]);
    }
    return queryOne<RemoteOperation>('SELECT * FROM interview_remote_operations WHERE operation_id=?',[id])!;
  });
}
