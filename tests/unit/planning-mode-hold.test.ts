import './_isolated-db';
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';

const root = process.env.CC_TEST_FIXTURE_ROOT!;
Object.assign(process.env, {
  OPENCLAW_ROOT: path.join(root, 'openclaw'), OPENCLAW_WORKSPACE_ROOT: root, WORKSPACE_BASE_PATH: root,
  DISABLE_CRON: '1', DISABLE_BRIDGE_BOOTSTRAP: '1', OWNER_NOTIFY_TELEGRAM_DISABLED: '1',
  INTAKE_ADVANCE_GRACE_SECONDS: '0', INTAKE_ADVANCE_BATCH: '100', OPENAI_API_KEY: '', GOOGLE_API_KEY: '',
});
const oldFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error('Planning fixture forbids network'); };

let db: typeof import('../../src/lib/db');
let intake: typeof import('../../src/lib/jobs/intake-advance-sweep');
let dispatcher: typeof import('../../src/lib/task-dispatcher');
test.before(async () => {
  db = await import('../../src/lib/db'); db.getDb();
  intake = await import('../../src/lib/jobs/intake-advance-sweep');
  dispatcher = await import('../../src/lib/task-dispatcher');
});
test.after(() => { globalThis.fetch = oldFetch; db.closeDb(); });

/** A backlog task assigned to a worker, with a Planning Mode session in flight. */
function planningTask() {
  const company = randomUUID(), ws = randomUUID(), worker = randomUUID(), id = randomUUID();
  db.run('INSERT INTO companies(id,name,slug) VALUES(?,?,?)', [company, 'Plan Co', company]);
  db.run('INSERT INTO workspaces(id,name,slug,company_id) VALUES(?,?,?,?)', [ws, 'General Task', ws, company]);
  db.run('INSERT INTO agents(id,name,role,workspace_id,is_master,status,model) VALUES(?,?,?,?,0,?,?)',
    [worker, 'Worker', 'Worker', ws, 'standby', 'deepseek/deepseek-v4-flash']);
  db.run(`INSERT INTO tasks(id,title,status,workspace_id,department,assigned_agent_id,planning_session_key,planning_complete,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,0,'2020-01-01','2020-01-01')`, [id, 'Plan me', 'backlog', ws, 'General Task', worker, 'agent:main:planning:x']);
  return { id, ws, worker };
}
const held = async () => ({ status: 'held' as const, reason: 'fixture dispatch recorder' });

test('(a) unfinished planning session: sweep skips the task and autoDispatchTask holds it', async () => {
  const t = planningTask();
  const sent: string[] = [];
  await intake.runIntakeAdvanceSweep({ dispatch: async (id) => { sent.push(id); return held(); } });
  assert.ok(!sent.includes(t.id), 'sweep must not dispatch a task still in planning');
  const outcome = await dispatcher.autoDispatchTask(t.id, 'test');
  assert.deepEqual({ status: outcome.status, reason: outcome.reason }, { status: 'held', reason: 'planning_in_progress' });
  // the pending placeholder (set at create time) holds it too
  db.run('UPDATE tasks SET planning_session_key=? WHERE id=?', [dispatcher.PLANNING_PENDING_KEY, t.id]);
  assert.equal((await dispatcher.autoDispatchTask(t.id, 'test')).reason, 'planning_in_progress');
});

test('(b) after planning_complete=1 (or a locked spec) the task is eligible again', async () => {
  const done = planningTask(), locked = planningTask();
  db.run('UPDATE tasks SET planning_complete=1 WHERE id=?', [done.id]);
  db.run("INSERT INTO planning_specs(id,task_id,spec_markdown,locked_at) VALUES(?,?,'spec',datetime('now'))", [randomUUID(), locked.id]);
  const sent: string[] = [];
  await intake.runIntakeAdvanceSweep({ dispatch: async (id) => { sent.push(id); return held(); } });
  assert.ok(sent.includes(done.id), 'completed planning task must be dispatched by the sweep');
  assert.ok(sent.includes(locked.id), 'legacy approved task (spec locked, flag unset) must not stay stuck');
  const outcome = await dispatcher.autoDispatchTask(done.id, 'test');
  assert.notEqual(outcome.reason, 'planning_in_progress');
});

test('approve route sets planning_complete so the task is released', async () => {
  const t = planningTask();
  db.run("UPDATE tasks SET status='planning', assigned_agent_id=NULL WHERE id=?", [t.id]);
  db.run(`INSERT INTO planning_questions(id,task_id,category,question,question_type,answer,sort_order,created_at)
    VALUES(?,?,'goal','Goal?','text','Ship it',0,datetime('now'))`, [randomUUID(), t.id]);
  const { POST } = await import('../../src/app/api/tasks/[id]/planning/approve/route');
  const res = await POST(new NextRequest(`http://localhost/api/tasks/${t.id}/planning/approve`, { method: 'POST' }),
    { params: Promise.resolve({ id: t.id }) });
  assert.equal(res.status, 200);
  const row = db.queryOne<any>('SELECT status, planning_complete FROM tasks WHERE id=?', [t.id])!;
  assert.equal(row.status, 'backlog');
  assert.equal(row.planning_complete, 1);
});

test('(c) answer route keeps "Other: <text>" for both "other" and "Other"', async () => {
  const { getOpenClawClient } = await import('../../src/lib/openclaw/client');
  const client = getOpenClawClient() as any;
  const sentMessages: string[] = [];
  client.isConnected = () => true;
  client.call = async (_m: string, p: { message: string }) => { sentMessages.push(p.message); return {}; };
  const { POST } = await import('../../src/app/api/tasks/[id]/planning/answer/route');
  for (const answer of ['other', 'Other', 'OTHER']) {
    const t = planningTask();
    const res = await POST(new NextRequest(`http://localhost/api/tasks/${t.id}/planning/answer`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ answer, otherText: 'a custom thing' }),
    }), { params: Promise.resolve({ id: t.id }) });
    assert.equal(res.status, 200, answer);
    assert.match(sentMessages.at(-1)!, /User's answer: Other: a custom thing/, answer);
  }
});

test('(d) retry-dispatch dispatches in-process: no relative-URL fetch', async () => {
  const t = planningTask();
  db.run('UPDATE tasks SET planning_complete=1 WHERE id=?', [t.id]);
  const out = await dispatcher.dispatchPlannedTask(t.id, 'test');
  assert.equal(out.success, false); // no gateway in the fixture
  assert.doesNotMatch(out.error ?? '', /parse URL|forbids network/);
  const { POST } = await import('../../src/app/api/tasks/[id]/planning/retry-dispatch/route');
  const res = await POST(new NextRequest(`http://localhost/api/tasks/${t.id}/planning/retry-dispatch`, { method: 'POST' }),
    { params: Promise.resolve({ id: t.id }) });
  assert.doesNotMatch(JSON.stringify(await res.json()), /parse URL|forbids network/);
  const row = db.queryOne<any>('SELECT planning_dispatch_error FROM tasks WHERE id=?', [t.id])!;
  assert.doesNotMatch(row.planning_dispatch_error ?? '', /parse URL|forbids network/);
});
