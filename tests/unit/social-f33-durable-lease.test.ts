import './_isolated-db';
import test from 'node:test';
import assert from 'node:assert/strict';
import { getDb, run, closeDb } from '../../src/lib/db';
import { createSocialOrchestrator, type SocialPlan } from '../../src/lib/jobs/social-orchestrator';
test.after(() => closeDb());
test('reassigned durable lease rejects stale original settlement', () => {
 getDb();
 const plan: SocialPlan = {company_id:'stale-proof',cycle_id:'c', steps:[{step_id:'s',depends_on:[],role:'worker',provider:'openrouter',estimated_cost:0}]};
 const a=createSocialOrchestrator('ultra',plan);
 const old=a.claim('a','s')!;
 assert.ok(old);
 run("UPDATE social_steps SET lease_expires_at = '2000-01-01T00:00:00.000Z' WHERE company_id='stale-proof'");
 run("UPDATE social_provider_leases SET lease_expires_at = '2000-01-01T00:00:00.000Z' WHERE company_id='stale-proof'");
 const b=createSocialOrchestrator('ultra',plan);
 const newer=b.claim('b','s')!;
 assert.ok(newer);
 assert.equal(a.settle('s','a',old.fencingToken),false,'Old worker must not commit after durable reassignment');
});

test('durable heartbeat renews both records and cannot resurrect an expired owner', () => {
 let now=Date.now()/1000;
 const plan:SocialPlan={company_id:'heartbeat-proof',cycle_id:'c',steps:[{step_id:'s',depends_on:[],provider:'openrouter',estimated_cost:0}]};
 const a=createSocialOrchestrator('ultra',plan,()=>now);
 const old=a.claim('a','s')!;
 now+=60;
 assert.equal(a.heartbeat('s','a',old.fencingToken),true);
 now+=70;
 const b=createSocialOrchestrator('ultra',plan,()=>now);
 assert.equal(b.claim('b','s'),null,'original 120s passed but heartbeat preserved ownership');
 now+=60;
 const newer=b.claim('b','s')!;
 assert.ok(newer);
 assert.ok(newer.fencingToken>old.fencingToken);
 assert.equal(a.heartbeat('s','a',old.fencingToken),false);
 assert.equal(a.fail('s','a',old.fencingToken),false);
 assert.equal(a.settle('s','a',old.fencingToken),false);
 assert.equal(b.settle('s','b',newer.fencingToken),true);
 const restart=createSocialOrchestrator('ultra',plan,()=>now);
 assert.equal(restart.claim('c','s'),null,'settled step survives restart');
});

test('missing durable lease storage rolls back the claim and refuses execution',()=>{
 const plan:SocialPlan={company_id:'storage-proof',cycle_id:'c',steps:[{step_id:'s',depends_on:[],provider:'openrouter',estimated_cost:0}]};
 run('ALTER TABLE social_provider_leases RENAME TO leases_unavailable');
 try {
  const a=createSocialOrchestrator('ultra',plan);
  assert.throws(()=>a.claim('a','s'),/no such table/);
  assert.equal(getDb().prepare("SELECT COUNT(*) AS n FROM social_steps WHERE company_id='storage-proof' AND status='running'").get().n,0,'transaction rolls back partial running state');
 } finally {run('ALTER TABLE leases_unavailable RENAME TO social_provider_leases');}
});

test('operation identity preserves company, long cycle, step and attempt',()=>{
 const plan:SocialPlan={company_id:'A',cycle_id:'12345678-1234-1234-1234-123456789012',steps:[]};
 const a=createSocialOrchestrator('ultra',plan);
 const b=createSocialOrchestrator('ultra',{...plan,company_id:'B'});
 assert.equal(new Set([a.operationKey('s1',1),a.operationKey('s2',1),a.operationKey('s1',2),b.operationKey('s1',1)]).size,4);
});

test('provider slots and budget are reserved across coordinator instances',()=>{
 const plan:SocialPlan={company_id:'quota-proof',cycle_id:'c',providers:{openrouter:{concurrency:1}},steps:[{step_id:'s1',depends_on:[],provider:'openrouter',estimated_cost:0},{step_id:'s2',depends_on:[],provider:'openrouter',estimated_cost:0}]};
 const a=createSocialOrchestrator('ultra',plan),b=createSocialOrchestrator('ultra',plan);
 const first=a.claim('a','s1')!;
 assert.ok(first);
 assert.equal(b.claim('b','s2'),null);
 assert.ok(a.settle('s1','a',first.fencingToken));
 assert.ok(b.claim('b','s2'));
 const costly:SocialPlan={...plan,company_id:'budget-proof',cycle_budget_cap:10,providers:{openrouter:{concurrency:10}},steps:plan.steps.map(s=>({...s,estimated_cost:6}))};
 const c=createSocialOrchestrator('ultra',costly),d=createSocialOrchestrator('ultra',costly);
 assert.ok(c.claim('c','s1'));
 assert.equal(d.claim('d','s2'),null,'durable reserved spend prevents cross-process overcommit');
});

test('bounded retry attempts and dependency completion survive coordinator restart',()=>{
 let now=Date.now()/1000;
 const plan:SocialPlan={company_id:'retry-proof',cycle_id:'c',steps:[{step_id:'s1',depends_on:[],provider:'openrouter',estimated_cost:0},{step_id:'s2',depends_on:['s1'],provider:'openrouter',estimated_cost:0}]};
 for(let n=1;n<=3;n++) {
  const a=createSocialOrchestrator('ultra',plan,()=>now);
  const lease=a.claim('worker','s1')!;
  assert.ok(lease); assert.equal(lease.attempt,n);
  assert.equal(a.claim('blocked','s2'),null);
  assert.ok(a.fail('s1','worker',lease.fencingToken));
  assert.equal(createSocialOrchestrator('ultra',plan,()=>now).claim('early','s1'),null);
  now+=30*n+1;
 }
 assert.equal(createSocialOrchestrator('ultra',plan,()=>now).claim('fourth','s1'),null);
 const good={...plan,company_id:'dependency-proof'};
 const a=createSocialOrchestrator('ultra',good,()=>now);
 const lease=a.claim('w','s1')!;assert.ok(lease);
 assert.ok(a.settle('s1','w',lease.fencingToken));
 assert.ok(createSocialOrchestrator('ultra',good,()=>now).claim('w2','s2'));
});

test('two real child processes racing one operation obtain exactly one lease', async()=>{
 const {execFile}=await import('node:child_process');
 const {promisify}=await import('node:util');
 const exec=promisify(execFile);
 const source=String.raw`
 const {createSocialOrchestrator}=require('./src/lib/jobs/social-orchestrator.ts');
 const {closeDb}=require('./src/lib/db');
 const plan={company_id:'race-proof',cycle_id:'c',steps:[{step_id:'s',depends_on:[],provider:'openrouter',estimated_cost:0}]};
 const result=createSocialOrchestrator('ultra',plan).claim(process.argv[1],'s');
 console.log('RACE_RESULT='+JSON.stringify(result));closeDb();`;
 const results=await Promise.all(['child-a','child-b'].map(worker=>exec(process.execPath,['--import','tsx','--import','./tests/setup/no-owner-telegram.ts','-e',source,worker],{cwd:process.cwd(),env:{...process.env,DATABASE_PATH:process.env.DATABASE_PATH},timeout:20000})));
 const parsed=results.map(r=>JSON.parse(r.stdout.split('\n').find(line=>line.startsWith('RACE_RESULT='))!.slice('RACE_RESULT='.length)));
 assert.equal(parsed.filter(Boolean).length,1,'BEGIN IMMEDIATE serializes real process claim races');
});

test('malformed cost and mutation of an existing step cannot bypass reservations',()=>{
 const base:SocialPlan={company_id:'immutable-proof',cycle_id:'c',steps:[{step_id:'s',depends_on:[],provider:'openrouter',estimated_cost:6}]};
 assert.throws(()=>createSocialOrchestrator('ultra',{...base,steps:[{...base.steps[0],estimated_cost:-1}]}),/nonnegative/);
 assert.throws(()=>createSocialOrchestrator('ultra',{...base,cycle_budget_cap:NaN}),/nonnegative/);
 const a=createSocialOrchestrator('ultra',base);
 assert.ok(a.claim('a','s'));
 const altered=createSocialOrchestrator('ultra',{...base,steps:[{...base.steps[0],provider:'deepseek'}]});
 assert.throws(()=>altered.claim('b','s'),/differs from approved plan/);
});

test('durable snapshot preserves costs and trusted dependency completion across restart',()=>{
 const plan:SocialPlan={company_id:'snapshot-proof',cycle_id:'c',cycle_budget_cap:20,steps:[{step_id:'s1',depends_on:[],provider:'openrouter',model:'fixture/model',estimated_cost:6},{step_id:'s2',depends_on:['s1'],provider:'openrouter',estimated_cost:2}]};
 const a=createSocialOrchestrator('ultra',plan);
 const lease=a.claim('a','s1')!;
 const b=createSocialOrchestrator('ultra',plan);
 assert.equal(b.completeDependency('s1'),false,'external adapter cannot override another live worker');
 assert.equal(b.status().budgetReserved,6);
 assert.equal(b.status().providers.openrouter,1);
 assert.ok(a.settle('s1','a',lease.fencingToken));
 assert.equal(b.status().budgetSpent,6);
 assert.equal(b.status().budgetReserved,0);
 assert.ok(b.claim('b','s2'));
 const external=createSocialOrchestrator('ultra',{...plan,company_id:'external-proof'});
 assert.ok(external.completeDependency('s1'));
 assert.ok(createSocialOrchestrator('ultra',{...plan,company_id:'external-proof'}).claim('next','s2'));
});

test('automatic claim passes a saturated durable provider without changing explicit requests',()=>{
 const plan:SocialPlan={company_id:'fair-proof',cycle_id:'c',providers:{openrouter:{concurrency:1},deepseek:{concurrency:1}},steps:[{step_id:'a-running',depends_on:[],provider:'openrouter',estimated_cost:0},{step_id:'b-blocked-provider',depends_on:[],provider:'openrouter',estimated_cost:0},{step_id:'z-independent',depends_on:[],provider:'deepseek',estimated_cost:0}]};
 const a=createSocialOrchestrator('ultra',plan),b=createSocialOrchestrator('ultra',plan);
 const held=a.claim('a','a-running')!;
 assert.ok(held);
 assert.equal(b.claim('b','b-blocked-provider'),null,'explicit claim remains pinned');
 const alternative=b.claim('b')!;
 assert.equal(alternative.stepId,'z-independent');
 assert.equal(b.claim('c'),null,'bounded pass ends when all remaining capacity is full');
 const pending=getDb().prepare("SELECT status,attempt_count FROM social_steps WHERE company_id='fair-proof' AND step_id='b-blocked-provider'").get() as {status:string;attempt_count:number};
 assert.equal(pending.status,'pending');assert.equal(pending.attempt_count,0);
 assert.ok(a.settle('a-running','a',held.fencingToken));
 assert.equal(b.claim('next')!.stepId,'b-blocked-provider');
});

test('automatic claim passes a durable budget refusal and preserves the expensive queued step',()=>{
 const plan:SocialPlan={company_id:'fair-budget-proof',cycle_id:'c',cycle_budget_cap:10,providers:{openrouter:{concurrency:10}},steps:[{step_id:'a-held',depends_on:[],provider:'openrouter',estimated_cost:6},{step_id:'b-expensive',depends_on:[],provider:'openrouter',estimated_cost:7},{step_id:'z-cheap',depends_on:[],provider:'openrouter',estimated_cost:2}]};
 const a=createSocialOrchestrator('ultra',plan),b=createSocialOrchestrator('ultra',plan);
 const held=a.claim('a','a-held')!;assert.ok(held);
 assert.equal(b.claim('b','b-expensive'),null);
 assert.equal(b.claim('b')!.stepId,'z-cheap');
 assert.equal(b.claim('c'),null);
 const pending=getDb().prepare("SELECT status,attempt_count FROM social_steps WHERE company_id='fair-budget-proof' AND step_id='b-expensive'").get() as {status:string;attempt_count:number};
 assert.equal(pending.status,'pending');assert.equal(pending.attempt_count,0);
 assert.ok(a.fail('a-held','a',held.fencingToken,{permanent:true}));
 assert.equal(b.claim('next')!.stepId,'b-expensive');
});
