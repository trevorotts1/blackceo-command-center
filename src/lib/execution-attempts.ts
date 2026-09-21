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

/** Default per-worker parallelism when the agent row does not set its own.
 * 1 = one job per worker, exactly how every box behaved before the column existed. */
export const WORKER_MAX_CONCURRENT_FALLBACK = 1;

/** How many executions this worker may run at once.
 *
 * `agents.max_concurrent_executions` (migration 149) when it is set and
 * positive, else WORKER_MAX_CONCURRENT_DEFAULT from the environment, else 1.
 * A pre-migration database has no such column: the read throws, is caught, and
 * the fallback applies — so an un-migrated box keeps the old behaviour instead
 * of failing a dispatch. */
export function workerConcurrencyLimit(agentId: string, db: Database.Database = getDb()): number {
 const envRaw = Number.parseInt(process.env.WORKER_MAX_CONCURRENT_DEFAULT ?? '', 10);
 const fallback = Number.isFinite(envRaw) && envRaw > 0 ? envRaw : WORKER_MAX_CONCURRENT_FALLBACK;
 let configured = 0;
 try {
  const row = db.prepare('SELECT max_concurrent_executions FROM agents WHERE id=?').get(agentId) as { max_concurrent_executions?: number | null } | undefined;
  configured = Number(row?.max_concurrent_executions ?? 0);
 } catch { /* pre-migration DB: the column is absent; the fallback is the answer. */ }
 return Number.isFinite(configured) && configured > 0 ? configured : fallback;
}

export function reserveExecution(snapshot: DispatchSnapshot, sessionKey: string, executionId: string,
 db: Database.Database = getDb()): { execution?: Execution; reason: string; running?: number; limit?: number } {
 return db.transaction(() => {
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(snapshot.id) as DispatchSnapshot | undefined;
  if (!task || !['backlog','assigned','blocked','in_progress'].includes(task.status) || task.status !== snapshot.status || task.assigned_agent_id !== snapshot.assigned_agent_id ||
      (task.assignment_version ?? 0) !== (snapshot.assignment_version ?? 0) ||
      task.workspace_id !== snapshot.workspace_id || task.department !== snapshot.department ||
      task.source !== snapshot.source || task.archived_at || isOwnerKilled(task).killed || task.dispatch_hold ||
      !task.assigned_agent_id || ['build_deck','build_deck_phase'].includes(String(task.source ?? '').trim().toLowerCase())) return { reason: 'assignment_or_state_changed' };
  if(snapshot.persona_snapshot && capturePersonaSnapshot(task.id,db).fingerprint!==snapshot.persona_snapshot.fingerprint)return {reason:'dispatch_prompt_context_changed'};
  // PER-TASK rule, unchanged: one live attempt per card, ever. Still backed by
  // the `task_execution_active_task` unique partial index.
  if (db.prepare(`SELECT id FROM task_executions WHERE task_id = ? AND state IN ${ACTIVE} LIMIT 1`).get(task.id))
    return { reason: 'execution_or_worker_busy' };
  // PER-WORKER capacity: COUNT the worker's other live executions against its
  // configured limit instead of refusing on the first one. The old rule was a
  // hard one-job-per-worker even though the gateway runs many per agent, so a
  // department with one worker processed its queue strictly serially — and a
  // single quarantined row starved it completely. The DB-level UNIQUE index that
  // used to encode the limit is dropped by migration 149 (a limit above 1 cannot
  // be a uniqueness constraint); the count below is the rule now, and it is read
  // inside this BEGIN IMMEDIATE transaction, which serializes it against every
  // other reserver, in this process or another.
  const limit = workerConcurrencyLimit(task.assigned_agent_id, db);
  const running = (db.prepare(`SELECT COUNT(*) AS n FROM task_executions WHERE agent_id = ? AND task_id <> ? AND state IN ${ACTIVE}`)
    .get(task.assigned_agent_id, task.id) as { n: number }).n;
  if (running >= limit) return { reason: 'worker_at_capacity', running, limit };
  // Legacy shared-session workers also consume capacity until their old task
  // finishes. That check exists because those workers SHARED one session; every
  // session is per-execution now, so above limit 1 it would silently cancel the
  // parallelism the operator just asked for. Kept verbatim at limit 1.
  if (limit === 1 && db.prepare("SELECT id FROM tasks WHERE assigned_agent_id = ? AND id <> ? AND status = 'in_progress' AND archived_at IS NULL LIMIT 1")
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
/** How long a quarantined `unknown` row keeps holding worker capacity (ms). */
export const UNKNOWN_QUARANTINE_MS = 24 * 60 * 60 * 1000;

/** POSITIVE EVIDENCE (2026-09): the gateway's own session history contains the
 * dispatched message for this execution, so the send DID land and the missing
 * acknowledgement was a transport artefact. Promote the quarantine to a live
 * state rather than waiting out UNKNOWN_QUARANTINE_MS. Guarded on `unknown` so
 * a late acknowledgement or completion that already moved the row wins. */
export function recordExecutionEvidence(executionId: string, state: 'accepted' | 'running', db = getDb()): boolean {
 return db.prepare("UPDATE task_executions SET state=?,error_code=NULL,updated_at=? WHERE id=? AND state='unknown'")
  .run(state, new Date().toISOString(), executionId).changes === 1;
}

/** NEGATIVE EVIDENCE: the gateway was reachable, its history for this session
 * does NOT contain the dispatched message, and the quarantine is past the
 * resolve window. Release the capacity and hand the card back to the same
 * worker — the same guard the expired-reservation path uses (assignment_version
 * + agent + still in_progress), so a reassigned, killed or archived task is
 * never rewound. No new idempotency key is ever minted. */
export function failUnknownExecutionWithoutEvidence(executionId: string, db = getDb()): { failed: boolean; taskReset: boolean } {
 return db.transaction(() => {
  const row = db.prepare("SELECT * FROM task_executions WHERE id=? AND state='unknown'").get(executionId) as Execution | undefined;
  if (!row) return { failed: false, taskReset: false };
  const now = new Date().toISOString();
  db.prepare("UPDATE task_executions SET state='failed',error_code='execution_unknown_no_evidence',updated_at=? WHERE id=? AND state='unknown'").run(now, executionId);
  // U99-RAW-STATUS-WRITER: the same CAS-guarded in_progress→assigned restore the
  // expired-reservation path above performs, audited by auditExecutionStatus in
  // this same transaction. transition()'s single expectedFrom cannot express the
  // assignment_version + agent + kill/archive guard this CAS carries.
  const changed = db.prepare("UPDATE tasks SET status='assigned',updated_at=? WHERE id=? AND assignment_version=? AND assigned_agent_id=? AND status='in_progress' AND killed_at IS NULL AND archived_at IS NULL")
   .run(now, row.task_id, row.assignment_version, row.agent_id).changes;
  if (changed) auditExecutionStatus(row.task_id, 'in_progress', 'assigned', 'Quarantined execution had no gateway evidence', db);
  return { failed: true, taskReset: changed === 1 };
 }).immediate();
}

/** Process-restart reconciliation never creates a new key. Expired reservations
 * are safe to fail; sending/accepted work is quarantined until positive evidence.
 *
 * QUARANTINE EXPIRY (live stall 2026-09): a row that was `sending` at lease
 * expiry becomes state='unknown', error_code='execution_lease_expired' — and
 * nothing ever reconciled it. reserveExecution counts `unknown` as ACTIVE per
 * agent, so one such row blocked that worker permanently (a client box had one
 * stuck for 4 days). The quarantine is meant to outlive a plausible late
 * acknowledgement, not the agent: after UNKNOWN_QUARANTINE_MS with no
 * acceptance, heartbeat or completion, the row is failed as
 * `execution_unknown_stale` and the capacity is released. Semantics preserved:
 * no new idempotency key is ever minted, and the task row is untouched (the
 * remote run may have happened — only the CC-side reservation is released). */
export function recoverExpiredExecutions(db = getDb(), now = new Date().toISOString()): number {
 return db.transaction(() => {
  const rows = db.prepare(`SELECT * FROM task_executions WHERE lease_expires_at < ? AND state IN ('reserved','sending')`).all(now) as Execution[];
  for (const row of rows) {
   db.prepare('UPDATE task_executions SET state=?,error_code=?,updated_at=? WHERE id=? AND lease_owner=?')
    .run(row.state === 'reserved' ? 'failed' : 'unknown', 'execution_lease_expired', now, row.id,row.lease_owner);
   // U99-RAW-STATUS-WRITER: only unsent expired reservations restore assigned, with audit in the same transaction.
   if (row.state === 'reserved') { const changed=db.prepare("UPDATE tasks SET status='assigned',updated_at=? WHERE id=? AND assignment_version=? AND assigned_agent_id=? AND status='in_progress' AND killed_at IS NULL AND archived_at IS NULL")
    .run(now,row.task_id,row.assignment_version,row.agent_id).changes;
    if(changed)auditExecutionStatus(row.task_id,'in_progress','assigned','Unsent execution reservation expired',db);
   }
  }
  // Release quarantine held past UNKNOWN_QUARANTINE_MS. Rows failed above keep
  // updated_at=now, so this pass can never re-flip what it just wrote.
  const parsedNow = Date.parse(now);
  const staleBefore = new Date((Number.isNaN(parsedNow) ? Date.now() : parsedNow) - UNKNOWN_QUARANTINE_MS).toISOString();
  const stale = db.prepare(`UPDATE task_executions SET state='failed',error_code='execution_unknown_stale',updated_at=?
    WHERE state='unknown' AND error_code='execution_lease_expired' AND updated_at < ?`).run(now,staleBefore).changes;
  return rows.length + stale;
 }).immediate();
}
