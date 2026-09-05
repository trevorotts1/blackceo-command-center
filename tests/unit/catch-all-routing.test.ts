import './_isolated-db';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Dynamic project imports ensure no module can capture an operator DB/runtime.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-catch-all-'));
Object.assign(process.env, {
  DATABASE_PATH: path.join(root, 'fixture.db'), CC_TEST_FIXTURE_ROOT: root,
  OPENCLAW_ROOT: path.join(root, 'openclaw'), OPENCLAW_COMPANY_ROOT: path.join(root, 'company'),
  WORKSPACE_BASE_PATH: root, OPENCLAW_WORKSPACE_ROOT: root,
  BCC_DEVICE_IDENTITY_DIR: path.join(root, 'identity'),
  OPENCLAW_CLI_BIN: '/usr/bin/false', DISABLE_CRON: '1', DISABLE_BRIDGE_BOOTSTRAP: '1',
  OWNER_NOTIFY_TELEGRAM_DISABLED: '1', SOP_EMBEDDING_PROVIDER: 'openai', OPENAI_API_KEY: '',
  MC_COMPANY_ID: 'catch-a', MC_INSTALLATION_ID: 'catch-fixture',
});
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error('Catch-all routing fixture forbids network'); };
let db: typeof import('../../src/lib/db');
let route: typeof import('../../src/lib/routing/department-router')['routeTaskDecision'];

test.before(async () => {
  db = await import('../../src/lib/db');
  db.getDb();
  route = (await import('../../src/lib/routing/department-router')).routeTaskDecision;
  for (const company of ['catch-a', 'catch-b']) db.run('INSERT INTO companies(id,name,slug) VALUES(?,?,?)', [company,company,company]);
  fs.mkdirSync(path.join(root, 'openclaw', 'agents', 'main'), {recursive:true});
  fs.writeFileSync(path.join(root,'openclaw','openclaw.json'),JSON.stringify({agents:{list:[{id:'main'}]}}));
});
test.after(() => { globalThis.fetch = originalFetch; db?.closeDb(); fs.rmSync(root,{recursive:true,force:true}); });
let serial = 0;
function fixture() {
  const suffix = String(++serial);
  // Each case gets a fresh company so no previous candidate can hide a bad route.
  const company = `case-${suffix}`;
  db.run('INSERT INTO companies(id,name,slug) VALUES(?,?,?)',[company,company,company]);
  function worker(kind: 'general'|'ceo'|'specialist', status = 'standby') {
    const workspace = `custom-workspace-${suffix}-${kind}`;
    const id = `worker-${suffix}-${kind}`;
    const slug = kind === 'general' ? 'general-task' : kind === 'ceo' ? 'master-orchestrator' : 'specialist';
    const name = kind === 'general' ? 'General Task' : kind === 'ceo' ? 'Master Orchestrator' : 'Specialist';
    db.run('INSERT INTO workspaces(id,name,slug,company_id) VALUES(?,?,?,?)',[workspace,name,`${slug}-${suffix}`,company]);
    db.run('INSERT INTO agents(id,name,role,workspace_id,is_master,status) VALUES(?,?,?,?,?,?)',[id,kind === 'ceo' ? 'main' : id,kind === 'ceo' ? 'CEO' : 'General Specialist',workspace,kind === 'ceo' ? 1 : 0,status]);
    if(kind==='ceo') db.run('UPDATE agents SET openclaw_agent_id=? WHERE id=?',['main',id]);
    else fs.mkdirSync(path.join(root,'openclaw','agents',`dept-${slug}-${suffix}`),{recursive:true});
    return {id,workspace};
  }
  const task = {title:'zxqv blorpt' ,priority:'medium' as const,company_id:company,department:'does-not-exist'};
  return {company,worker,task};
}
function assigned(decision: Awaited<ReturnType<typeof route>>, id: string, company: string, workspace: string, method: 'general'|'escalation') {
  assert.equal(decision.status,'assigned',JSON.stringify(decision));
  if (decision.status !== 'assigned') return;
  assert.equal(decision.routing.agentId,id);
  assert.equal(decision.routing.companyId,company);
  assert.equal(decision.routing.workspaceId,workspace);
  assert.equal(decision.routing.method,method);
}

test('unknown department selects owned General worker with custom workspace ID',async()=>{
  const f=fixture(),general=f.worker('general'); f.worker('ceo');
  assigned(await route(f.task),general.id,f.company,general.workspace,'general');
});
test('absent department and no classification match still select General',async()=>{
  const f=fixture(),general=f.worker('general');
  assigned(await route({...f.task,department:undefined}),general.id,f.company,general.workspace,'general');
});
test('General absent selects same-company CEO execution fallback',async()=>{
  const f=fixture(),ceo=f.worker('ceo');
  assigned(await route(f.task),ceo.id,f.company,ceo.workspace,'escalation');
});
test('offline General and busy General each prefer idle CEO',async()=>{
  for(const status of ['offline','working']) {
    const f=fixture(),general=f.worker('general',status),ceo=f.worker('ceo');
    if(status==='working') db.run('INSERT INTO tasks(id,title,status,assigned_agent_id,workspace_id) VALUES(?,?,?,?,?)',[`busy-${general.id}`,'Existing execution','in_progress',general.id,general.workspace]);
    assigned(await route(f.task),ceo.id,f.company,ceo.workspace,'escalation');
  }
});
test('both busy retain an owned queued fallback assignment',async()=>{
  const f=fixture(),general=f.worker('general'),ceo=f.worker('ceo');
  for(const worker of [general,ceo]) db.run('INSERT INTO tasks(id,title,status,assigned_agent_id,workspace_id) VALUES(?,?,?,?,?)',[`busy-${worker.id}`,'Existing execution','in_progress',worker.id,worker.workspace]);
  const decision=await route(f.task);
  assert.equal(decision.status,'assigned',JSON.stringify(decision));
  if(decision.status==='assigned') {
    assert.ok([general.id,ceo.id].includes(decision.routing.agentId));
    assert.equal(decision.routing.companyId,f.company);
  }
});
test('foreign-only candidates and conflicting company/workspace never assign',async()=>{
  const empty=fixture(),foreign=fixture(),worker=foreign.worker('general'); foreign.worker('ceo');
  assert.notEqual((await route(empty.task)).status,'assigned');
  assert.equal((await route({...empty.task,workspace_id:worker.workspace})).status,'ambiguous');
});
test('unavailable explicit owner specialist pin remains refused',async()=>{
  const f=fixture(); f.worker('general'); f.worker('ceo');
  assert.notEqual((await route({...f.task,target_agent:'named-but-unavailable-worker'})).status,'assigned');
});

test('matched department without eligible worker uses owned General',async()=>{
  const f=fixture(),general=f.worker('general'); f.worker('specialist','offline');
  assigned(await route({...f.task,department:'Specialist'}),general.id,f.company,general.workspace,'general');
});
test('ambiguous explicit department remains refused instead of guessing',async()=>{
  const f=fixture(); f.worker('general'); f.worker('ceo');
  for(const n of [1,2]) db.run('INSERT INTO workspaces(id,name,slug,company_id) VALUES(?,?,?,?)',[`ambiguous-${serial}-${n}`,'Duplicated Department',`ambiguous-${serial}-${n}`,f.company]);
  assert.equal((await route({...f.task,department:'Duplicated Department'})).status,'ambiguous');
});

test('unknown durable attempt consumes General capacity even before task status changes',async()=>{
  const f=fixture(),general=f.worker('general'),ceo=f.worker('ceo');
  const id=`unknown-${general.id}`;
  db.run('INSERT INTO tasks(id,title,status,assigned_agent_id,workspace_id) VALUES(?,?,?,?,?)',[id,'Uncertain remote acceptance','assigned',general.id,general.workspace]);
  db.run(`INSERT INTO task_executions(id,task_id,assignment_version,agent_id,workspace_id,generation,session_key,session_id,state,lease_owner,lease_expires_at,idempotency_key,created_at,updated_at)
    VALUES(?,?,0,?,?,1,?,?,'unknown','fixture','2099-01-01',?,'2026-09-05','2026-09-05')`,[id,id,general.id,general.workspace,id,id,id]);
  assigned(await route(f.task),ceo.id,f.company,ceo.workspace,'escalation');
  assert.equal(db.queryOne<{state:string}>('SELECT state FROM task_executions WHERE id=?',[id])?.state,'unknown','routing cannot release uncertain remote capacity');
});

test('runtime-unavailable General yields to configured CEO without changing ownership',async()=>{
  const f=fixture(),general=f.worker('general'),ceo=f.worker('ceo');
  db.run('UPDATE agents SET openclaw_agent_id=? WHERE id=?',['runtime-not-installed',general.id]);
  assigned(await route(f.task),ceo.id,f.company,ceo.workspace,'escalation');
});
test('all runtimes unavailable still produce an owned queued assignment',async()=>{
  const f=fixture(),general=f.worker('general'),ceo=f.worker('ceo');
  for(const worker of [general,ceo]) db.run('UPDATE agents SET openclaw_agent_id=? WHERE id=?',['runtime-not-installed',worker.id]);
  assigned(await route(f.task),general.id,f.company,general.workspace,'general');
});

test('idle alphabetically first General QC cannot displace busy doer or idle CEO',async()=>{
  const f=fixture(),general=f.worker('general'),ceo=f.worker('ceo');
  db.run("INSERT INTO agents(id,name,role,role_type,workspace_id,status,is_master) VALUES(?,?,?,'qc',?,'standby',0)",
    [`aaa-qc-${serial}`,'Independent QC','Quality reviewer',general.workspace]);
  db.run('INSERT INTO tasks(id,title,status,assigned_agent_id,workspace_id) VALUES(?,?,?,?,?)',
    [`busy-${general.id}`,'Existing work','in_progress',general.id,general.workspace]);
  assigned(await route(f.task),ceo.id,f.company,ceo.workspace,'escalation');
});
test('QC-only General uses CEO fallback',async()=>{
  const f=fixture(),general=f.worker('general'),ceo=f.worker('ceo');
  db.run("UPDATE agents SET role_type='qc' WHERE id=?",[general.id]);
  assigned(await route(f.task),ceo.id,f.company,ceo.workspace,'escalation');
});
test('QC-only General without CEO remains unassigned',async()=>{
  const f=fixture(),general=f.worker('general');
  db.run("UPDATE agents SET role_type='qc' WHERE id=?",[general.id]);
  assert.notEqual((await route(f.task)).status,'assigned');
});
