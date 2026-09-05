import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';
import { CreateTaskSchema, UpdateTaskSchema } from '../../src/lib/validation';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-agent-assignment-'));
process.env.DATABASE_PATH = path.join(dir, 'fixture.db');
Object.assign(process.env, {
  CC_TEST_FIXTURE_ROOT: dir, WORKSPACE_BASE_PATH: dir, OPENCLAW_WORKSPACE_ROOT: dir,
  OPENCLAW_ROOT: path.join(dir, 'openclaw'), OPENCLAW_COMPANY_ROOT: path.join(dir, 'company'),
  BCC_DEVICE_IDENTITY_DIR: path.join(dir, 'identity'), OPENCLAW_SKILL23_SCRIPTS: path.join(dir, 'absent'),
  OPENCLAW_CLI_BIN: '/usr/bin/false', OPENCLAW_GATEWAY_URL: 'invalid-fixture-url',
  OWNER_NOTIFY_TELEGRAM_DISABLED: '1', DISABLE_CRON: '1', DISABLE_BRIDGE_BOOTSTRAP: '1',
  MC_API_TOKEN: 'assignment-fixture-only', MC_COMPANY_ID: 'assignment-a', MC_INSTALLATION_ID: 'assignment-install',
  MC_TENANT_REGISTRY_JSON: JSON.stringify({ localhost: { tenantId: 'assignment-tenant', companyId: 'assignment-a', kind: 'self', installationId: 'assignment-install' } }),
});
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error('Assignment fixture prohibits network'); };
let db: typeof import('../../src/lib/db');
let POST: typeof import('../../src/app/api/tasks/route')['POST'];
let PATCH: typeof import('../../src/app/api/tasks/[id]/route')['PATCH'];
const uuidAgent = randomUUID();

test.before(async () => {
  db = await import('../../src/lib/db');
  db.getDb();
  for (const company of ['assignment-a', 'assignment-b']) {
    db.run('INSERT INTO companies (id,name,slug) VALUES (?,?,?)', [company,company,company]);
    db.run('INSERT INTO workspaces (id,name,slug,company_id) VALUES (?,?,?,?)', [company,company,company,company]);
  }
  for (const [id, company] of [['assignment-podcast-editor','assignment-a'], [uuidAgent,'assignment-a'], ['assignment-qc-agent','assignment-a'], ['assignment-foreign-agent','assignment-b']]) {
    db.run('INSERT INTO agents (id,name,role,workspace_id,is_master) VALUES (?,?,?,?,1)', [id,id,'Tester',company]);
  }
  POST = (await import('../../src/app/api/tasks/route')).POST;
  PATCH = (await import('../../src/app/api/tasks/[id]/route')).PATCH;
});
test.after(() => { globalThis.fetch = originalFetch; db?.closeDb(); fs.rmSync(dir, {recursive:true,force:true}); });

function request(body: object, id?: string, authenticated = true) {
  return new NextRequest(`http://localhost/api/tasks${id ? '/'+id : ''}`, {
    method: id ? 'PATCH' : 'POST', headers: {
      host: 'localhost', 'content-type': 'application/json',
      ...(authenticated ? { authorization: 'Bearer assignment-fixture-only' } : {}),
    }, body: JSON.stringify(body),
  });
}
function seedTask(company = 'assignment-a') {
  const id = randomUUID();
  db.run('INSERT INTO tasks (id,title,status,priority,workspace_id) VALUES (?,?,?,?,?)', [id,'Assignment fixture','backlog','medium',company]);
  return id;
}
function snapshot(id: string) {
  return {
    task: db.queryOne('SELECT * FROM tasks WHERE id=?',[id]),
    events: db.queryAll('SELECT * FROM events WHERE task_id=? ORDER BY id',[id]),
  };
}

test('stored slug and UUID references validate; malformed identifiers still fail', () => {
  for (const id of ['podcast-editor','head-agent-sales','qc-agent-sales',uuidAgent]) {
    assert.ok(CreateTaskSchema.safeParse({title:'Task',assigned_agent_id:id,created_by_agent_id:id}).success);
    assert.ok(UpdateTaskSchema.safeParse({assigned_agent_id:id,updated_by_agent_id:id}).success);
  }
  for (const id of ['', ' ', '../agent', 'agent/name', 'a'.repeat(201)]) {
    assert.equal(UpdateTaskSchema.safeParse({assigned_agent_id:id}).success,false);
  }
  assert.ok(UpdateTaskSchema.safeParse({assigned_agent_id:null}).success);
});

test('real task editor saves slug/UUID assignment and priority together, and clearing works', async () => {
  const id = seedTask();
  for (const assigned_agent_id of ['assignment-podcast-editor',uuidAgent,null]) {
    const response = await PATCH(request({assigned_agent_id,priority:'high'},id), {params:Promise.resolve({id})});
    assert.equal(response.status,200,await response.text());
    const task = db.queryOne<{assigned_agent_id:string|null;priority:string}>('SELECT assigned_agent_id,priority FROM tasks WHERE id=?',[id]);
    assert.equal(task?.assigned_agent_id,assigned_agent_id);
    assert.equal(task?.priority,'high');
  }
  assert.equal(db.queryAll('SELECT id FROM events WHERE task_id=? AND type=?',[id,'task_assigned']).length,2);
});

test('unknown/foreign agents and actor IDs cannot mutate any sibling field or event', async () => {
  for (const change of [
    {assigned_agent_id:'assignment-missing'}, {assigned_agent_id:'assignment-foreign-agent'},
    {updated_by_agent_id:'assignment-foreign-agent'}, {updated_by_agent_id:'assignment-missing'},
  ]) {
    const id=seedTask(), before=snapshot(id);
    const response=await PATCH(request({...change,priority:'high',title:'must not persist'},id),{params:Promise.resolve({id})});
    assert.equal(response.status,400);
    assert.deepEqual(snapshot(id),before);
  }
});

test('another company task and unauthenticated assignment are refused without mutation',async()=>{
  for (const [company,authenticated] of [['assignment-b',true],['assignment-a',false]] as const) {
    const id=seedTask(company),before=snapshot(id);
    const response=await PATCH(request({assigned_agent_id:'assignment-podcast-editor',priority:'high'},id,authenticated),{params:Promise.resolve({id})});
    assert.equal(response.status,authenticated?404:403);
    assert.deepEqual(snapshot(id),before);
  }
});

test('assignment audit failure rolls back the assignment and priority transaction',async()=>{
  const id=seedTask(),before=snapshot(id);
  db.getDb().exec("CREATE TRIGGER assignment_fixture_fail BEFORE INSERT ON events WHEN NEW.type='task_assigned' BEGIN SELECT RAISE(ABORT,'fixture audit failure'); END");
  try {
    const response=await PATCH(request({assigned_agent_id:'assignment-podcast-editor',priority:'high'},id),{params:Promise.resolve({id})});
    assert.equal(response.status,500);
    assert.deepEqual(snapshot(id),before);
  } finally { db.getDb().exec('DROP TRIGGER assignment_fixture_fail'); }
});

test('create rejects unknown/foreign references before persisting task or creation event',async()=>{
  for(const assigned_agent_id of ['assignment-missing','assignment-foreign-agent']) {
    const before=db.queryAll('SELECT * FROM tasks ORDER BY id');
    const events=db.queryAll('SELECT * FROM events ORDER BY id');
    const response=await POST(request({title:'Rejected create',workspace_id:'assignment-a',assigned_agent_id,priority:'high'}));
    assert.equal(response.status,400);
    assert.deepEqual(db.queryAll('SELECT * FROM tasks ORDER BY id'),before);
    assert.deepEqual(db.queryAll('SELECT * FROM events ORDER BY id'),events);
  }
});

test('real create endpoint retains seeded and UUID references',async()=>{
  for(const assigned_agent_id of ['assignment-podcast-editor',uuidAgent]) {
    const response=await POST(request({title:'Assignment create fixture',status:'planning',workspace_id:'assignment-a',assigned_agent_id,priority:'high',created_by_agent_id:'assignment-qc-agent'}));
    assert.equal(response.status,201,await response.clone().text());
    const task=await response.json();
    assert.equal(task.assigned_agent_id,assigned_agent_id);
    assert.equal(task.priority,'high');
    assert.equal(db.queryOne<{assigned_agent_id:string}>('SELECT assigned_agent_id FROM tasks WHERE id=?',[task.id])?.assigned_agent_id,assigned_agent_id);
  }
});

test('New Task without a workspace remains company-owned through its durable request identity',async()=>{
  const response=await POST(request({title:'Unrouted assignment fixture',status:'planning',assigned_agent_id:'assignment-podcast-editor'}));
  assert.equal(response.status,201,await response.clone().text());
  const task=await response.json();
  assert.equal(task.workspace_id,null);
  const saved=await PATCH(request({assigned_agent_id:uuidAgent,priority:'high'},task.id),{params:Promise.resolve({id:task.id})});
  assert.equal(saved.status,200,await saved.clone().text());
  db.run('INSERT INTO task_request_keys (company_id,source,operation_id,payload_sha256,task_id,created_at) VALUES (?,?,?,?,?,?)',
    ['assignment-b','fixture','conflicting-company','fixture',task.id,new Date().toISOString()]);
  const before=snapshot(task.id);
  const refused=await PATCH(request({assigned_agent_id:null,priority:'low'},task.id),{params:Promise.resolve({id:task.id})});
  assert.equal(refused.status,404);
  assert.deepEqual(snapshot(task.id),before);
});
