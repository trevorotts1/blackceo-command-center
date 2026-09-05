// U99-RAW-STATUS-WRITER: reservation and expired-unsent recovery atomically own attempt+task+status audit.
/** Durable dispatch ownership. Unknown acceptance deliberately retains capacity:
 * absence of an acknowledgement is never evidence that remote work did not start. */
import { capturePersonaSnapshot, type PersonaSnapshot } from '@/lib/persona-state';
import { randomUUID } from 'crypto';
import { getDb } from '@/lib/db';
import { isOwnerKilled } from '@/lib/owner-killed';
import type Database from 'better-sqlite3';

export type DispatchOutcome = { status: 'acknowledged' | 'held' | 'failed' | 'unknown'; reason: string; executionId?: string };
export interface Execution {
 id: string; task_id: string; assignment_version: number; agent_id: string;
 workspace_id: string | null; generation: number; session_key: string; session_id: string;
 worker_context: string; remote_run_id: string | null; state: string; lease_owner: string; lease_expires_at: string;
 idempotency_key: string; created_at: string;
}
export interface DispatchSnapshot {
 persona_snapshot?:PersonaSnapshot; id: string; assigned_agent_id?: string | null; assignment_version?: number;
 workspace_id?: string | null; department?: string | null; status: string;
 source?: string | null; dispatch_hold?: unknown; killed_at?: string | null;
 archived_at?: string | null; description?: string | null;
}
const ACTIVE = "('reserved','sending','accepted','running','unknown')";
export function executionSessionId(agentId: string, executionId: string): string {
 return `mission-control-${agentId}-${executionId}`;
}
export function latestExecution(taskId: string, db = getDb()): Execution | undefined {
 return db.prepare('SELECT * FROM task_executions WHERE task_id = ? ORDER BY generation DESC LIMIT 1').get(taskId) as Execution | undefined;
}

function workerContext(agentId:string,db:Database.Database):string|null {
 const agent=db.prepare('SELECT * FROM agents WHERE id=?').get(agentId) as Record<string,unknown>|undefined;
 if(!agent)return null;
 const workspace=agent.workspace_id && db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='workspaces'").get()?db.prepare('SELECT * FROM workspaces WHERE id=?').get(agent.workspace_id) as Record<string,unknown>|undefined:undefined;
 return JSON.stringify([agent.workspace_id??null,agent.role_type??null,agent.openclaw_agent_id??null,workspace?.company_id??null]);
}
function auditExecutionStatus(taskId:string,from:string,to:string,reason:string,db:Database.Database):void {
 if(from===to)return;
 const now=new Date().toISOString();
 if(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='task_events'").get()) db.prepare('INSERT INTO task_events(id,task_id,from_status,to_status,actor,reason,created_at) VALUES(?,?,?,?,?,?,?)').run(randomUUID(),taskId,from,to,'execution-attempt',reason,now);
 else db.prepare('INSERT INTO events(id,type,task_id,message,created_at) VALUES(?,?,?,?,?)').run(randomUUID(),'task_status_changed',taskId,`${from} → ${to}: ${reason}`,now);
}

export function reserveExecution(snapshot: DispatchSnapshot, sessionKey: string, executionId: string,
 db: Database.Database = getDb()): { execution?: Execution; reason: string } {
 return db.transaction(() => {
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(snapshot.id) as DispatchSnapshot | undefined;
  if (!task || !['backlog','assigned','blocked','in_progress'].includes(task.status) || task.status !== snapshot.status || task.assigned_agent_id !== snapshot.assigned_agent_id ||
      (task.assignment_version ?? 0) !== (snapshot.assignment_version ?? 0) ||
      task.workspace_id !== snapshot.workspace_id || task.department !== snapshot.department ||
      task.source !== snapshot.source || task.archived_at || isOwnerKilled(task).killed || task.dispatch_hold ||
      !task.assigned_agent_id || ['build_deck','build_deck_phase'].includes(String(task.source ?? '').trim().toLowerCase())) return { reason: 'assignment_or_state_changed' };
  if(snapshot.persona_snapshot && capturePersonaSnapshot(task.id,db).fingerprint!==snapshot.persona_snapshot.fingerprint)return {reason:'dispatch_prompt_context_changed'};
  const active = db.prepare(`SELECT id FROM task_executions WHERE (task_id = ? OR agent_id = ?) AND state IN ${ACTIVE} LIMIT 1`)
    .get(task.id, task.assigned_agent_id);
  if (active) return { reason: 'execution_or_worker_busy' };
  // Legacy shared-session workers also consume capacity until their old task finishes.
  if (db.prepare("SELECT id FROM tasks WHERE assigned_agent_id = ? AND id <> ? AND status = 'in_progress' AND archived_at IS NULL LIMIT 1")
    .get(task.assigned_agent_id, task.id)) return { reason: 'worker_busy_legacy_task' };
  const context=workerContext(task.assigned_agent_id,db);
  if(!context)return {reason:'worker_missing'};
  const now = new Date().toISOString();
  auditExecutionStatus(task.id,task.status,'in_progress','Durable execution reserved',db);
  // U99-RAW-STATUS-WRITER: durable reservation includes strict transactional task_events audit above.
  db.prepare("UPDATE tasks SET status = 'in_progress', updated_at = ? WHERE id = ?").run(now, task.id);
  const claimed = db.prepare('SELECT assignment_version FROM tasks WHERE id = ?').get(task.id) as { assignment_version: number };
  if (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='task_dispatch_intents'").get()) db.prepare("UPDATE task_dispatch_intents SET updated_at=? WHERE task_id=? AND state='pending'").run(now,task.id);
  const generation = (latestExecution(task.id, db)?.generation ?? 0) + 1;
  const sessionId = executionSessionId(task.assigned_agent_id, executionId);
  const owner = randomUUID();
  db.prepare(`INSERT INTO task_executions
   (id,task_id,assignment_version,agent_id,workspace_id,generation,worker_context,session_key,session_id,state,lease_owner,lease_expires_at,idempotency_key,created_at,updated_at)
   VALUES (?,?,?,?,?,?,?,?,?,'reserved',?,?,?,?,?)`).run(executionId, task.id, claimed.assignment_version,
    task.assigned_agent_id, task.workspace_id ?? null, generation, context, sessionKey, sessionId, owner,
    new Date(Date.now()+120_000).toISOString(), `execution-${executionId}`, now, now);
  // Never rebind an existing session. Each attempt has immutable attribution.
  db.prepare(`INSERT INTO openclaw_sessions
   (id,agent_id,openclaw_session_id,channel,status,task_id,created_at,updated_at)
   VALUES (?,?,?,'mission-control','active',?,?,?)`).run(randomUUID(), task.assigned_agent_id, sessionId, task.id, now, now);
  return { execution: latestExecution(task.id, db), reason: 'reserved' };
 }).immediate();
}

/** Must run immediately before the network send; no await between this and call(). */
export function beginExecutionSend(execution: Execution, db = getDb()): boolean {
 return db.transaction(() => {
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(execution.task_id) as DispatchSnapshot | undefined;
  if (!task || task.status !== 'in_progress' || task.assigned_agent_id !== execution.agent_id ||
      task.assignment_version !== execution.assignment_version || workerContext(execution.agent_id,db)!==execution.worker_context || task.archived_at || task.dispatch_hold || isOwnerKilled(task).killed) {
   db.prepare("UPDATE task_executions SET state='failed', error_code='claim_superseded', updated_at=? WHERE id=? AND lease_owner=? AND state='reserved'")
     .run(new Date().toISOString(), execution.id, execution.lease_owner);
   return false;
  }
  return db.prepare("UPDATE task_executions SET state='sending',updated_at=? WHERE id=? AND lease_owner=? AND state='reserved'")
   .run(new Date().toISOString(), execution.id, execution.lease_owner).changes === 1;
 }).immediate();
}
export function recordExecutionAcceptance(execution: Execution, response: unknown, db = getDb()): void {
 db.transaction(()=>{
 const result=response as {runId?:string;run_id?:string}|undefined;
 const changed=db.prepare("UPDATE task_executions SET state='accepted',remote_run_id=?,heartbeat_at=?,updated_at=? WHERE id=? AND lease_owner=? AND state IN ('sending','unknown')")
 .run(result?.runId??result?.run_id??null,new Date().toISOString(),new Date().toISOString(),execution.id,execution.lease_owner).changes;
 if(changed && db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='task_dispatch_intents'").get())db.prepare("UPDATE task_dispatch_intents SET state='acknowledged',updated_at=? WHERE task_id=? AND state='pending'").run(new Date().toISOString(),execution.task_id);
 }).immediate();
}
export function recordExecutionUnknown(execution: Execution, db = getDb()): void {
 db.prepare("UPDATE task_executions SET state='unknown',error_code='send_acceptance_unknown',updated_at=? WHERE id=? AND lease_owner=? AND state='sending'")
   .run(new Date().toISOString(), execution.id, execution.lease_owner);
 db.prepare(`INSERT INTO events(id,type,task_id,agent_id,message,created_at) VALUES(?,?,?,?,?,?)`)
   .run(randomUUID(),'dispatch_acceptance_unknown',execution.task_id,execution.agent_id,
   'Gateway acknowledgement missing. This execution retains worker capacity; reconcile its session before retrying.',new Date().toISOString());
}

/** New attempts require execution identity, or their unique session ID. Legacy
 * tasks keep their old callback contract. A stale callback cannot finish a new run. */
export function validateExecutionCompletion(taskId: string, identity: { executionId?: string; sessionId?: string }, db = getDb()): string | null {
 const execution = latestExecution(taskId, db);
 if (!execution) return null;
 if (identity.executionId !== execution.id && identity.sessionId !== execution.session_id) return 'execution_identity_required_or_stale';
 const task = db.prepare('SELECT * FROM tasks WHERE id=?').get(taskId) as DispatchSnapshot | undefined;
 if (!task || task.assigned_agent_id !== execution.agent_id || task.archived_at || isOwnerKilled(task).killed ||
     (task.assignment_version !== execution.assignment_version || workerContext(execution.agent_id,db)!==execution.worker_context) ||
     execution.state === 'failed') return 'execution_superseded';
 return null;
}
export function completeExecution(taskId: string, executionId?: string, db = getDb()): void {
 if (!executionId) return;
 db.prepare(`UPDATE task_executions SET state='succeeded',progress_at=?,updated_at=? WHERE task_id=? AND id=? AND state IN ${ACTIVE}`)
  .run(new Date().toISOString(),new Date().toISOString(),taskId,executionId);
}
/** Process-restart reconciliation never creates a new key. Expired reservations
 * are safe to fail; sending/accepted work is quarantined until positive evidence. */
export function recoverExpiredExecutions(db = getDb(), now = new Date().toISOString()): number {
 return db.transaction(() => {
  const rows = db.prepare(`SELECT * FROM task_executions WHERE lease_expires_at < ? AND state IN ('reserved','sending','accepted','running')`).all(now) as Execution[];
  for (const row of rows) {
   db.prepare('UPDATE task_executions SET state=?,error_code=?,updated_at=? WHERE id=? AND lease_owner=?')
    .run(row.state === 'reserved' ? 'failed' : 'unknown', 'execution_lease_expired', now, row.id,row.lease_owner);
   // U99-RAW-STATUS-WRITER: only unsent expired reservations restore assigned, with audit in the same transaction.
   if (row.state === 'reserved') { const changed=db.prepare("UPDATE tasks SET status='assigned',updated_at=? WHERE id=? AND assignment_version=? AND assigned_agent_id=? AND status='in_progress' AND killed_at IS NULL AND archived_at IS NULL")
    .run(now,row.task_id,row.assignment_version,row.agent_id).changes;
    if(changed)auditExecutionStatus(row.task_id,'in_progress','assigned','Unsent execution reservation expired',db);
   }
  }
  return rows.length;
 }).immediate();
}
