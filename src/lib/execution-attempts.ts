// U99-RAW-STATUS-WRITER: reservation and expired-unsent recovery atomically own attempt+task+status audit.
/** Durable dispatch ownership. Unknown acceptance deliberately retains capacity:
 * absence of an acknowledgement is never evidence that remote work did not start. */
import { capturePersonaSnapshot, type PersonaSnapshot } from '@/lib/persona-state';
import { randomUUID } from 'crypto';
import { getDb } from '@/lib/db';
import { isOwnerKilled } from '@/lib/owner-killed';
import { ACTIVE_EXECUTION_STATES_SQL } from '@/lib/execution-schema';
import {
  canonicalProvider, isRateLimitError, noteProviderRateLimit, poolLimit,
  providerCoolingUntil, providerOf,
} from '@/lib/capacity/provider-pools';
import type Database from 'better-sqlite3';

export type DispatchOutcome = { status: 'acknowledged' | 'held' | 'failed' | 'unknown'; reason: string; executionId?: string };
export interface Execution {
 id: string; task_id: string; assignment_version: number; agent_id: string;
 workspace_id: string | null; generation: number; session_key: string; session_id: string;
 worker_context: string; remote_run_id: string | null; state: string; lease_owner: string; lease_expires_at: string;
 idempotency_key: string; provider: string | null; created_at: string;
}
export interface DispatchSnapshot {
 persona_snapshot?:PersonaSnapshot; id: string; assigned_agent_id?: string | null; assignment_version?: number;
 workspace_id?: string | null; department?: string | null; status: string;
 source?: string | null; dispatch_hold?: unknown; killed_at?: string | null;
 archived_at?: string | null; description?: string | null;
 /** Provider pool this dispatch will draw on, resolved by the caller from the
  * agent's RUNTIME model (FIX-15: openclaw.json `model.primary`, not the CC's
  * intended model). Absent — a caller that has not resolved one — falls back to
  * the `agents.model` column inside reserveExecution. */
 provider?: string | null;
}
// The capacity-owning states. Shared with capacity/provider-pools.ts via the
// schema module so the two counters can never drift apart.
const ACTIVE = ACTIVE_EXECUTION_STATES_SQL;
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

/** An OPTIONAL per-agent ceiling, or null when this agent has none.
 *
 * v7.6.27 made this a required per-agent number defaulting to 1, which made the
 * AGENT the unit of capacity. It is not: the client's provider PLAN is (see
 * capacity/provider-pools.ts), and an agent ceiling of 1 silently capped every
 * box at one job per worker no matter what the subscription allowed. Migration
 * 150 therefore nulls every row still carrying that v7.6.27 default, and this
 * reads NULL/0 as "no ceiling — the pool is the limit".
 *
 * An explicitly set value still wins, so an operator can pin one agent down
 * without touching the pool. `WORKER_MAX_CONCURRENT_DEFAULT` remains as a
 * box-wide fallback for that pin and is UNSET by default.
 *
 * A pre-migration database has no such column: the read throws, is caught, and
 * the answer is "no ceiling" — so an un-migrated box is bounded by its pool
 * rather than failing a dispatch. */
export function workerConcurrencyLimit(agentId: string, db: Database.Database = getDb()): number | null {
 let configured = 0;
 try {
  const row = db.prepare('SELECT max_concurrent_executions FROM agents WHERE id=?').get(agentId) as { max_concurrent_executions?: number | null } | undefined;
  configured = Number(row?.max_concurrent_executions ?? 0);
 } catch { /* pre-migration DB: the column is absent; there is no agent ceiling. */ }
 if (Number.isFinite(configured) && configured > 0) return configured;
 const envRaw = Number.parseInt(process.env.WORKER_MAX_CONCURRENT_DEFAULT ?? '', 10);
 return Number.isFinite(envRaw) && envRaw > 0 ? envRaw : null;
}

/** True when this database carries the migration-150 `provider` column.
 * Cheap (a PRAGMA off the schema cache) and read inside the reserve
 * transaction, so a box whose migrations have not run yet keeps dispatching on
 * the v7.6.27 rules instead of throwing on every reserve. */
function hasProviderColumn(db: Database.Database): boolean {
 try {
  return (db.prepare('PRAGMA table_info(task_executions)').all() as { name: string }[]).some((c) => c.name === 'provider');
 } catch { return false; }
}

/** Last-resort provider resolution when the caller did not supply one.
 * `agents.model` is the CC's own pinned model, which FIX-15 established is NOT
 * necessarily what the runtime loads — so a dispatcher that knows the runtime
 * model should always pass it. This keeps a caller that does not (a test, a
 * background dispatcher) attributed to SOME pool rather than none. */
function agentProviderFallback(agentId: string, db: Database.Database): string {
 try {
  const row = db.prepare('SELECT model FROM agents WHERE id=?').get(agentId) as { model?: string | null } | undefined;
  return providerOf(row?.model);
 } catch { return providerOf(null); }
}

export interface ReserveResult {
 execution?: Execution; reason: string; running?: number; limit?: number;
 /** Pool this reserve drew on — present on every provider-scoped refusal. */
 provider?: string;
 /** When a `provider_cooling_down` pool reopens. */
 until?: string;
}

export function reserveExecution(snapshot: DispatchSnapshot, sessionKey: string, executionId: string,
 db: Database.Database = getDb()): ReserveResult {
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
  // PROVIDER-POOL capacity, checked FIRST because it is the real constraint:
  // concurrency is a property of the client's provider PLAN, not of the agent
  // (capacity/provider-pools.ts). Every agent on this box that runs on Ollama
  // draws on the ONE Ollama subscription the client pays for, so the count is
  // per provider per box, not per agent — four agents at one job each could
  // exceed a 3-concurrent plan without any of them exceeding an agent ceiling.
  // Counted inside this same BEGIN IMMEDIATE, so it serializes against every
  // other reserver exactly as the worker count does.
  const pool = canonicalProvider(snapshot.provider ?? agentProviderFallback(task.assigned_agent_id, db));
  const poolTracked = hasProviderColumn(db);
  if (poolTracked) {
   // A pool the provider itself just 429'd is SHUT: dispatching into it would
   // only earn another refusal. This is not a fault of the card and never
   // counts against its dispatch attempts — the caller holds, it does not fail.
   const coolingUntil = providerCoolingUntil(pool, db);
   if (coolingUntil) return { reason: 'provider_cooling_down', provider: pool, until: coolingUntil };
   const poolMax = poolLimit(pool);
   const poolRunning = (db.prepare(`SELECT COUNT(*) AS n FROM task_executions WHERE provider = ? AND task_id <> ? AND state IN ${ACTIVE}`)
     .get(pool, task.id) as { n: number }).n;
   if (poolRunning >= poolMax) return { reason: 'provider_at_capacity', provider: pool, running: poolRunning, limit: poolMax };
  }
  // PER-AGENT ceiling: OPTIONAL since the pool became the limit. null means the
  // agent has no ceiling of its own and takes as much as its pool allows.
  const limit = workerConcurrencyLimit(task.assigned_agent_id, db);
  if (limit !== null) {
   const running = (db.prepare(`SELECT COUNT(*) AS n FROM task_executions WHERE agent_id = ? AND task_id <> ? AND state IN ${ACTIVE}`)
     .get(task.assigned_agent_id, task.id) as { n: number }).n;
   if (running >= limit) return { reason: 'worker_at_capacity', running, limit };
  }
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
   (id,task_id,assignment_version,agent_id,workspace_id,generation,worker_context,session_key,session_id,state,lease_owner,lease_expires_at,idempotency_key,${poolTracked ? 'provider,' : ''}created_at,updated_at)
   VALUES (?,?,?,?,?,?,?,?,?,'reserved',?,?,?,${poolTracked ? '?,' : ''}?,?)`).run(executionId, task.id, claimed.assignment_version,
    task.assigned_agent_id, task.workspace_id ?? null, generation, context, sessionKey, sessionId, owner,
    new Date(Date.now()+120_000).toISOString(), `execution-${executionId}`, ...(poolTracked ? [pool] : []), now, now);
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
/** The send did not acknowledge. `error` is the failure the gateway raised, when
 * the caller has it: a 429 in that text is the PROVIDER refusing more work, so
 * the whole pool goes into cooldown rather than the next card walking straight
 * into the same refusal. The execution row itself is unchanged by that — it
 * still retains capacity until it is reconciled. */
export function recordExecutionUnknown(execution: Execution, db = getDb(), error?: unknown): void {
 db.prepare("UPDATE task_executions SET state='unknown',error_code='send_acceptance_unknown',updated_at=? WHERE id=? AND lease_owner=? AND state='sending'")
   .run(new Date().toISOString(), execution.id, execution.lease_owner);
 db.prepare(`INSERT INTO events(id,type,task_id,agent_id,message,created_at) VALUES(?,?,?,?,?,?)`)
   .run(randomUUID(),'dispatch_acceptance_unknown',execution.task_id,execution.agent_id,
   'Gateway acknowledgement missing. This execution retains worker capacity; reconcile its session before retrying.',new Date().toISOString());
 if (error !== undefined && execution.provider && isRateLimitError(error)) {
  const until = noteProviderRateLimit(execution.provider, db);
  if (until) db.prepare(`INSERT INTO events(id,type,task_id,agent_id,message,created_at) VALUES(?,?,?,?,?,?)`)
    .run(randomUUID(),'provider_rate_limited',execution.task_id,execution.agent_id,
    `Provider "${execution.provider}" reported a rate limit; its pool is shut until ${until}.`,new Date().toISOString());
 }
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
