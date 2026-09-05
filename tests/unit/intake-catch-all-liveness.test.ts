import './_isolated-db';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import type { RoutingDecision } from '../../src/lib/routing/department-router';

const root=process.env.CC_TEST_FIXTURE_ROOT!;
Object.assign(process.env, {OPENCLAW_ROOT:path.join(root,'openclaw'),OPENCLAW_WORKSPACE_ROOT:root,
  WORKSPACE_BASE_PATH:root,DISABLE_CRON:'1',DISABLE_BRIDGE_BOOTSTRAP:'1',OWNER_NOTIFY_TELEGRAM_DISABLED:'1',
  INTAKE_ADVANCE_GRACE_SECONDS:'0',INTAKE_ADVANCE_BATCH:'100',OPENAI_API_KEY:'',GOOGLE_API_KEY:''});
const oldFetch=globalThis.fetch;
globalThis.fetch=async()=>{throw new Error('Intake fixture forbids network');};
let db:typeof import('../../src/lib/db');
let intake:typeof import('../../src/lib/jobs/intake-advance-sweep');
let execution:typeof import('../../src/lib/execution-attempts');
test.before(async()=>{
  db=await import('../../src/lib/db');db.getDb();
  intake=await import('../../src/lib/jobs/intake-advance-sweep');
  execution=await import('../../src/lib/execution-attempts');
  registerRuntime('main');
});
test.after(()=>{globalThis.fetch=oldFetch;db.closeDb();});
function registerRuntime(id:string) {
  fs.mkdirSync(path.join(root,'openclaw','agents',id),{recursive:true});
  const configPath=path.join(root,'openclaw','openclaw.json');
  const config=fs.existsSync(configPath)?JSON.parse(fs.readFileSync(configPath,'utf8')):{agents:{list:[]}};
  config.agents.list.push({id});
  fs.writeFileSync(configPath,JSON.stringify(config));
}
function fixture(status='inbox') {
  const company=randomUUID(),workspace=randomUUID(),ceoWs=randomUUID(),general=randomUUID(),ceo=randomUUID(),id=randomUUID();
  db.run('INSERT INTO companies(id,name,slug) VALUES(?,?,?)',[company,'Fixture Company',company]);
  for(const [ws,name] of [[workspace,'General Task'],[ceoWs,'Master Orchestrator']])
    db.run('INSERT INTO workspaces(id,name,slug,company_id) VALUES(?,?,?,?)',[ws,name,ws,company]);
  db.run('INSERT INTO agents(id,name,role,workspace_id,is_master,status) VALUES(?,?,?,?,0,?)',[general,'General','Worker',workspace,'standby']);
  db.run('INSERT INTO agents(id,name,role,workspace_id,is_master,status) VALUES(?,?,?,?,1,?)',[ceo,'main','CEO',ceoWs,'standby']);
  db.run("UPDATE agents SET openclaw_agent_id='main' WHERE id=?",[ceo]);
  db.run(`INSERT INTO tasks(id,title,status,workspace_id,department,created_at,updated_at) VALUES(?,?,?,?,?,'2020-01-01','2020-01-01')`,[id,'Intake fixture',status,workspace,'missing-department']);
  function decision(worker=ceo,reason='[catch-all] unavailable department'):Extract<RoutingDecision,{status:'assigned'}> {
    return {status:'assigned',routing:{agentId:worker,agentName:'Fixture',department:'Master Orchestrator',workspaceId:worker===ceo?ceoWs:workspace,companyId:company,score:0,reason,method:worker===ceo?'escalation':'general'}};
  }
  function row(){return db.queryOne<any>('SELECT t.*,w.company_id,w.slug AS workspace_slug,w.name AS workspace_name FROM tasks t JOIN workspaces w ON w.id=t.workspace_id WHERE t.id=?',[id])!;}
  return {id,company,workspace,ceoWs,general,ceo,decision,row};
}
const held=async()=>({status:'held' as const,reason:'fixture dispatch recorder'});

test('CEO catch-all assignment normalizes all intake lanes and can reserve actual execution',()=>{
  for(const status of ['inbox','planning','pending_dispatch']){
    const f=fixture(status);
    assert.equal(intake.commitIntakeAssignment(f.row(),f.decision()),true);
    const task=f.row();assert.equal(task.status,'assigned');assert.match(task.routing_reason,/^\[catch-all\]/);
    const reserved=execution.reserveExecution(task,`agent:main:${f.id}`,randomUUID());
    assert.ok(reserved.execution,reserved.reason);
    assert.equal(f.row().status,'in_progress');
    assert.equal(db.queryOne<any>('SELECT COUNT(*) AS n FROM task_events WHERE task_id=?',[f.id]).n,2);
  }
});

test('non-catchall master, foreign company, killed, engine and assignment-race commits are rejected',()=>{
  const normal=fixture();assert.equal(intake.commitIntakeAssignment(normal.row(),normal.decision(normal.ceo,'ordinary route')),false);
  const foreign=fixture(),other=fixture();assert.equal(intake.commitIntakeAssignment(foreign.row(),other.decision()),false);
  for(const [column,value] of [['killed_at','2026-01-01'],['source','build_deck'],['dispatch_hold',1]] as const){
    const f=fixture();db.run(`UPDATE tasks SET ${column}=? WHERE id=?`,[value,f.id]);
    assert.equal(intake.commitIntakeAssignment(f.row(),f.decision()),false);
  }
  const terminal=fixture('done');assert.equal(intake.commitIntakeAssignment(terminal.row(),terminal.decision()),false);
  const race=fixture(),snapshot=race.row();db.run("UPDATE tasks SET title='Operator edited',updated_at='2021-01-01' WHERE id=?",[race.id]);
  assert.equal(intake.commitIntakeAssignment(snapshot,race.decision()),false);
});

test('historical department-only hold recovers atomically; another hold remains untouched',async()=>{
  const old=fixture(),other=fixture();
  const historical='Requested department missing-department is unavailable in this company.';
  for(const [f,reason] of [[old,historical],[other,'Awaiting audience approval']] as const)
    db.run("UPDATE tasks SET dispatch_hold=1,routing_wait_owner='SYSTEM',routing_reason=? WHERE id=?",[reason,f.id]);
  const sends:string[]=[];
  await intake.runIntakeAdvanceSweep({route:async(input)=>input.company_id===old.company?old.decision():{status:'waiting',reason:'fixture no route',owner:'SYSTEM',retryable:true},dispatch:async(id)=>{sends.push(id);return held();}});
  assert.equal(old.row().dispatch_hold,0);assert.equal(old.row().status,'assigned');assert.equal(old.row().assigned_agent_id,old.ceo);
  assert.ok(sends.includes(old.id));assert.ok(!sends.includes(other.id));
  assert.equal(other.row().dispatch_hold,1);assert.equal(other.row().routing_reason,'Awaiting audience approval');
});

test('queued catch-all reroutes to another idle worker, but unknown attempt never moves',async()=>{
  const queued=fixture('assigned'),active=fixture('assigned');
  for(const f of [queued,active]) {
    db.run('UPDATE tasks SET assigned_agent_id=?,department=?,updated_at=? WHERE id=?',[f.general,'General Task','2020-01-01',f.id]);
    db.run("UPDATE tasks SET routing_reason='[catch-all] queued worker' WHERE id=?",[f.id]);
  }
  const reserved=execution.reserveExecution(active.row(),`agent:fixture:${active.id}`,randomUUID());assert.ok(reserved.execution);
  db.run("UPDATE task_executions SET state='unknown' WHERE task_id=?",[active.id]);
  // Even a restored queued status cannot free uncertain remote acceptance.
  db.run("UPDATE tasks SET status='assigned',updated_at='2020-01-01' WHERE id=?",[active.id]);
  db.run("UPDATE tasks SET routing_reason='[catch-all] queued worker' WHERE id=?",[active.id]);
  db.run("UPDATE agents SET status='offline' WHERE id=?",[queued.general]);
  const routed:string[]=[];
  await intake.runIntakeAdvanceSweep({route:async(input)=>{routed.push(String(input.company_id));return input.company_id===queued.company?queued.decision():{status:'waiting',reason:'fixture no route',owner:'SYSTEM',retryable:true};},dispatch:held});
  assert.equal(queued.row().assigned_agent_id,queued.ceo);
  assert.equal(active.row().assigned_agent_id,active.general);assert.ok(!routed.includes(active.company));
  assert.equal(db.queryOne<any>('SELECT state FROM task_executions WHERE task_id=?',[active.id]).state,'unknown');
});

test('normalization preserves marker and blocks held or active attempts without changing ownership',()=>{
  const f=fixture('planning');
  db.run('UPDATE tasks SET assigned_agent_id=?,workspace_id=?,department=? WHERE id=?',[f.ceo,f.ceoWs,'Master Orchestrator',f.id]);
  db.run("UPDATE tasks SET routing_reason='[catch-all] CEO fallback' WHERE id=?",[f.id]);
  assert.equal(intake.normalizeIntakeForDispatch(f.id),true);assert.equal(f.row().status,'assigned');assert.match(f.row().routing_reason,/^\[catch-all\]/);
  const h=fixture('pending_dispatch');db.run('UPDATE tasks SET assigned_agent_id=?,dispatch_hold=1 WHERE id=?',[h.general,h.id]);
  assert.equal(intake.normalizeIntakeForDispatch(h.id),false);assert.equal(h.row().status,'pending_dispatch');
  assert.ok(execution.reserveExecution(f.row(),`agent:main:${f.id}`,randomUUID()).execution);
  assert.equal(intake.normalizeIntakeForDispatch(f.id),false);
});


test('real router reassigns queued General to executable CEO when General is offline or has no runtime',async()=>{
  for(const unavailable of ['offline','missing-runtime']) {
    const f=fixture('assigned');
    db.run('UPDATE tasks SET assigned_agent_id=?,department=? WHERE id=?',[f.general,'General Task',f.id]);
    db.run("UPDATE tasks SET routing_reason='[catch-all] queued General',updated_at='2020-01-01' WHERE id=?",[f.id]);
    db.run('UPDATE agents SET status=? WHERE id=?',[unavailable==='offline'?'offline':'standby',f.general]);
    const sent:string[]=[];
    await intake.runIntakeAdvanceSweep({dispatch:async(id)=>{sent.push(id);return held();}});
    assert.equal(f.row().assigned_agent_id,f.ceo,unavailable);
    assert.ok(sent.includes(f.id));
  }
});

test('policy revision wakes a routing-only wait even with an unchanged roster hash',async()=>{
  const f=fixture();
  const rows=db.queryAll<Record<string,unknown>>(`SELECT w.id,w.company_id,w.name,w.description,w.archived_at,a.id AS agent_id,a.role,a.status,a.is_master,a.updated_at
    FROM workspaces w LEFT JOIN agents a ON a.workspace_id=w.id ORDER BY w.id,a.id`);
  const legacy=createHash('sha256').update(JSON.stringify(rows.filter(r=>String(r.company_id)===f.company))).digest('hex');
  db.run("UPDATE tasks SET routing_wait_owner='SYSTEM',routing_config_revision=?,routing_reason='No old policy candidate',next_routing_eligible_at='2999-01-01' WHERE id=?",[legacy,f.id]);
  await intake.runIntakeAdvanceSweep({route:async(input)=>input.company_id===f.company?f.decision():{status:'waiting',reason:'fixture no route',owner:'SYSTEM',retryable:true},dispatch:held});
  assert.equal(f.row().assigned_agent_id,f.ceo);
  assert.equal(f.row().routing_wait_owner,null);
});

test('commit and normalization cannot free an uncertain active attempt despite restored queued state',()=>{
  const f=fixture('assigned');
  db.run('UPDATE tasks SET assigned_agent_id=?,department=? WHERE id=?',[f.general,'General Task',f.id]);
  db.run("UPDATE tasks SET routing_reason='[catch-all] queued General' WHERE id=?",[f.id]);
  assert.ok(execution.reserveExecution(f.row(),`agent:fixture:${f.id}`,randomUUID()).execution);
  db.run("UPDATE task_executions SET state='unknown' WHERE task_id=?",[f.id]);
  db.run("UPDATE tasks SET status='assigned' WHERE id=?",[f.id]);
  db.run("UPDATE tasks SET routing_reason='[catch-all] queued General' WHERE id=?",[f.id]);
  assert.equal(intake.commitIntakeAssignment(f.row(),f.decision()),false);
  assert.equal(intake.normalizeIntakeForDispatch(f.id),false);
  assert.equal(f.row().assigned_agent_id,f.general);
});


test('workspace-less durable company wakes and assigns; ambiguous or missing company is refused',async()=>{
  const owned=fixture(),ambiguous=fixture(),unowned=fixture(),foreign=fixture();
  for(const f of [owned,ambiguous,unowned]) {
    db.run("UPDATE tasks SET workspace_id=NULL,routing_wait_owner='SYSTEM',routing_config_revision='old-policy',updated_at='2020-01-01' WHERE id=?",[f.id]);
  }
  for(const [task,company] of [[owned,owned.company],[ambiguous,ambiguous.company],[ambiguous,foreign.company]] as const)
    db.run('INSERT INTO task_request_keys(company_id,source,operation_id,payload_sha256,task_id,created_at) VALUES(?,?,?,?,?,?)',[company,'fixture',randomUUID(),'fixture',task.id,'2020-01-01']);
  const attempted:string[]=[];
  await intake.runIntakeAdvanceSweep({route:async(input)=>{attempted.push(String(input.company_id));return input.company_id===owned.company?owned.decision():{status:'waiting',reason:'fixture no route',owner:'SYSTEM',retryable:true};},dispatch:held});
  assert.equal(db.queryOne<any>('SELECT assigned_agent_id FROM tasks WHERE id=?',[owned.id]).assigned_agent_id,owned.ceo);
  for(const f of [ambiguous,unowned]) {
    const row=db.queryOne<any>('SELECT * FROM tasks WHERE id=?',[f.id]);
    assert.equal(row.assigned_agent_id,null);
    assert.equal(intake.commitIntakeAssignment({...row,company_id:f.company},f.decision()),false);
  }
  assert.ok(attempted.includes(owned.company));
});


test('explicit General request still prefers an idle ready CEO when General is busy, without weakening target pins',async()=>{
  const f=fixture();
  const runtime=`general-${randomUUID()}`;
  registerRuntime(runtime);
  db.run('UPDATE agents SET openclaw_agent_id=? WHERE id=?',[runtime,f.general]);
  db.run("INSERT INTO tasks(id,title,status,assigned_agent_id,workspace_id) VALUES(?,?,'in_progress',?,?)",[randomUUID(),'Busy General',f.general,f.workspace]);
  const {routeTaskDecision}=await import('../../src/lib/routing/department-router');
  const request={title:'General work',priority:'medium' as const,company_id:f.company,department:'General Task'};
  const chosen=await routeTaskDecision(request);assert.equal(chosen.status,'assigned');
  if(chosen.status==='assigned')assert.equal(chosen.routing.agentId,f.ceo);
  const pinned=await routeTaskDecision({...request,catch_all:true,target_agent:f.general});
  assert.equal(pinned.status,'assigned');if(pinned.status==='assigned')assert.equal(pinned.routing.agentId,f.general);
});
