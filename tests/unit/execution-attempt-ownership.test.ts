import './_isolated-db';
import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { EXECUTION_SCHEMA_SQL } from '../../src/lib/execution-schema';
import { reserveExecution,beginExecutionSend,recordExecutionUnknown,recordExecutionAcceptance,latestExecution,recoverExpiredExecutions,validateExecutionCompletion,completeExecution,executionSessionId,UNKNOWN_QUARANTINE_MS,type DispatchSnapshot } from '../../src/lib/execution-attempts';
import { runLeasedJob,throwIfJobLeaseLost } from '../../src/lib/jobs/job-lease';
function fixture(){const db=new Database(':memory:');db.exec(`
 CREATE TABLE agents(id TEXT PRIMARY KEY,name TEXT,max_concurrent_executions INTEGER); INSERT INTO agents(id,name,max_concurrent_executions) VALUES('a','Same Name',1),('b','Same Name',1);
 CREATE TABLE tasks(id TEXT PRIMARY KEY,assigned_agent_id TEXT,assignment_version INTEGER DEFAULT 0,status TEXT,workspace_id TEXT,department TEXT,source TEXT,killed_at TEXT,archived_at TEXT,description TEXT,updated_at TEXT);
 CREATE TABLE openclaw_sessions(id TEXT PRIMARY KEY,agent_id TEXT,openclaw_session_id TEXT,channel TEXT,status TEXT,task_id TEXT,created_at TEXT,updated_at TEXT);
 CREATE TABLE events(id TEXT,type TEXT,task_id TEXT,agent_id TEXT,message TEXT,created_at TEXT);
 INSERT INTO tasks(id,assigned_agent_id,status,workspace_id,department) VALUES('t1','a','assigned','ws','engineering'),('t2','a','assigned','ws','engineering'),('t3','b','assigned','ws','engineering');`);db.exec(EXECUTION_SCHEMA_SQL);return db;}
const snap=(db:Database.Database,id:string)=>db.prepare('SELECT * FROM tasks WHERE id=?').get(id) as DispatchSnapshot;
const claim=(db:Database.Database,id:string,eid:string)=>reserveExecution(snap(db,id),`agent:engineering:${executionSessionId(snap(db,id).assigned_agent_id!,eid)}`,eid,db);
// The refusal reason for a BUSY WORKER is `worker_at_capacity` (per-worker
// concurrency, migration 149) — `execution_or_worker_busy` still names the
// per-TASK rule. These tests are about ATTEMPT OWNERSHIP, not about capacity
// policy: they use a busy worker as the instrument for proving that a
// quarantined row keeps holding its slot. Since migration 150 the agent ceiling
// is OPTIONAL and the provider POOL is the default limit, so the fixture pins
// each agent to 1 explicitly — which is now how "one job per worker" is said.
test('one worker capacity and duplicate names have independent stable attempt sessions',()=>{const db=fixture();try{assert.ok(claim(db,'t1','e1').execution);assert.equal(claim(db,'t2','e2').reason,'worker_at_capacity');assert.ok(claim(db,'t3','e3').execution);assert.notEqual(latestExecution('t1',db)!.session_id,latestExecution('t3',db)!.session_id);assert.equal(db.prepare('SELECT COUNT(*) n FROM openclaw_sessions').get() && (db.prepare('SELECT COUNT(*) n FROM openclaw_sessions').get() as {n:number}).n,2);}finally{db.close();}});
test('delayed preflight cannot overwrite assignment, kill, archive or engine ownership',()=>{for(const mutation of ["assigned_agent_id='b',assignment_version=1","killed_at='now'","archived_at='now'","source='build_deck_phase'"]){const db=fixture();try{const old=snap(db,'t1');db.exec(`UPDATE tasks SET ${mutation} WHERE id='t1'`);assert.equal(reserveExecution(old,'key','e',db).execution,undefined);assert.equal((db.prepare('SELECT status FROM tasks WHERE id=?').get('t1') as {status:string}).status,'assigned');}finally{db.close();}}});
test('lost acknowledgement retains attempt and worker capacity; acknowledgement reconciles same key',()=>{const db=fixture();try{const e=claim(db,'t1','e1').execution!;assert.equal(beginExecutionSend(e,db),true);recordExecutionUnknown(e,db);assert.equal(claim(db,'t2','e2').execution,undefined);assert.equal(latestExecution('t1',db)!.state,'unknown');recordExecutionAcceptance(e,{runId:'remote-one'},db);assert.equal(latestExecution('t1',db)!.idempotency_key,e.idempotency_key);assert.equal(latestExecution('t1',db)!.remote_run_id,'remote-one');}finally{db.close();}});
test('restart before send safely recovers reservation; restart after send quarantines instead of duplicating',()=>{const db=fixture();try{const e1=claim(db,'t1','e1').execution!;recoverExpiredExecutions(db,'2999-01-01');assert.equal(latestExecution('t1',db)!.state,'failed');const e2=claim(db,'t1','e2').execution!;assert.equal(beginExecutionSend(e1,db),false);assert.equal(beginExecutionSend(e2,db),true);recoverExpiredExecutions(db,'2999-01-01');assert.equal(latestExecution('t1',db)!.state,'unknown');assert.equal(claim(db,'t2','e3').execution,undefined);}finally{db.close();}});
test('late completion cannot complete newer attempt; matching unique session survives missing session row',()=>{const db=fixture();try{const old=claim(db,'t1','old').execution!;recoverExpiredExecutions(db,'2999-01-01');const current=claim(db,'t1','new').execution!;beginExecutionSend(current,db);assert.ok(validateExecutionCompletion('t1',{executionId:old.id},db));db.exec('DELETE FROM openclaw_sessions');assert.equal(validateExecutionCompletion('t1',{sessionId:current.session_id},db),null);completeExecution('t1',old.id,db);assert.equal(latestExecution('t1',db)!.state,'sending');completeExecution('t1',current.id,db);assert.equal(latestExecution('t1',db)!.state,'succeeded');}finally{db.close();}});
test('timed-out body retains local non-overlap, rejects late writes, and does not block another job',async()=>{const db=fixture();let finish!:()=>void;let staleError:string|undefined;try{const body=new Promise<void>(r=>finish=r);const job=runLeasedJob('slow',async()=>{await body;try{throwIfJobLeaseLost();}catch(e){staleError=(e as Error).message;}},15,db);await assert.rejects(job,/scheduler_job_timeout/);assert.equal((await runLeasedJob('slow',()=>42,15,db)).skipped,true);assert.equal((await runLeasedJob('watchdog',()=>42,50,db)).result,42);finish();await new Promise(r=>setTimeout(r,0));assert.equal(staleError,'scheduler_lease_lost');assert.equal((await runLeasedJob('slow',()=>42,50,db)).result,42);}finally{finish?.();db.close();}});
// Quarantine expiry: an `unknown` row left by a lease expiry used to hold the worker's
// capacity forever (reserveExecution counts `unknown` as active). It now fails as
// `execution_unknown_stale` after UNKNOWN_QUARANTINE_MS — and not one minute earlier.
test('stale unknown quarantine expires and releases the worker; a fresh one still holds it',()=>{const db=fixture();try{const e=claim(db,'t1','e1').execution!;assert.equal(beginExecutionSend(e,db),true);recoverExpiredExecutions(db,'2999-01-01');assert.equal(latestExecution('t1',db)!.state,'unknown');
 // The remote run reported in and t1 moved on; only the ghost attempt row remains.
 db.prepare("UPDATE tasks SET status='done' WHERE id='t1'").run();
 db.prepare('UPDATE task_executions SET updated_at=? WHERE id=?').run(new Date(Date.now()-60_000).toISOString(),e.id);
 recoverExpiredExecutions(db,new Date().toISOString());
 assert.equal(latestExecution('t1',db)!.state,'unknown','a fresh quarantine is never cut short');
 assert.equal(claim(db,'t2','e2').execution,undefined);
 db.prepare('UPDATE task_executions SET updated_at=? WHERE id=?').run(new Date(Date.now()-UNKNOWN_QUARANTINE_MS-60_000).toISOString(),e.id);
 recoverExpiredExecutions(db,new Date().toISOString());
 assert.equal(latestExecution('t1',db)!.state,'failed');
 assert.equal((db.prepare('SELECT error_code FROM task_executions WHERE id=?').get(e.id) as {error_code:string}).error_code,'execution_unknown_stale');
 assert.equal(latestExecution('t1',db)!.idempotency_key,e.idempotency_key,'never mints a new key');
 assert.ok(claim(db,'t2','e3').execution,'worker capacity released');}finally{db.close();}});
