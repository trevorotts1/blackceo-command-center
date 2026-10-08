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
let history: Array<{ role: string; content: Array<{ type: string; text: string }> }> = [];
let sent: string[] = [];
let gatewayDown = false;

test.before(async () => {
  db = await import('../../src/lib/db'); db.getDb();
  intake = await import('../../src/lib/jobs/intake-advance-sweep');
  dispatcher = await import('../../src/lib/task-dispatcher');
  const client = (await import('../../src/lib/openclaw/client')).getOpenClawClient() as any;
  client.isConnected = () => true;
  client.call = async (method: string, p: { message?: string }) => {
    if (gatewayDown) throw new Error('gateway down');
    if (method === 'chat.send') { sent.push(p.message!); return {}; }
    return { messages: history };
  };
});
test.after(() => { globalThis.fetch = oldFetch; db.closeDb(); });
test.beforeEach(() => { history = []; sent = []; gatewayDown = false; });

const reply = (text: string) => ({ role: 'assistant', content: [{ type: 'text', text }] });

/** A planning task in flight, one user message sent, no assigned agent yet. */
function planningTask() {
  const company = randomUUID(), ws = randomUUID(), id = randomUUID();
  db.run('INSERT INTO companies(id,name,slug) VALUES(?,?,?)', [company, 'Plan Co', company]);
  db.run('INSERT INTO workspaces(id,name,slug,company_id) VALUES(?,?,?,?)', [ws, 'General Task', ws, company]);
  db.run(`INSERT INTO tasks(id,title,description,status,workspace_id,department,planning_session_key,planning_messages,planning_complete,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,0,'2020-01-01','2020-01-01')`,
    [id, 'Plan me ' + id, 'Original description', 'backlog', ws, 'General Task', 'agent:main:planning:x',
      JSON.stringify([{ role: 'user', content: 'plan', timestamp: 1 }])]);
  return { id, ws };
}
const poll = async (id: string) => {
  const { GET } = await import('../../src/app/api/tasks/[id]/planning/poll/route');
  const res = await GET(new NextRequest(`http://localhost/api/tasks/${id}/planning/poll`), { params: Promise.resolve({ id }) });
  return res.json();
};

const complete = JSON.stringify({
  status: 'complete',
  spec: { title: 'T', summary: 'Build the thing', deliverables: ['A doc'], success_criteria: ['Reads well'], constraints: {} },
  agents: [{ name: 'Researcher', role: 'Research', instructions: 'Find the facts' }],
  execution_plan: { approach: 'Research then write', steps: ['Research', 'Write'] },
});

test('(9) completing a plan inserts no agent rows; the task is routable and carries the plan', async () => {
  const t = planningTask();
  const before = db.queryOne<{ n: number }>('SELECT COUNT(*) n FROM agents')!.n;
  history = [reply(complete)];
  const out = await poll(t.id);
  assert.equal(out.complete, true);
  assert.equal(db.queryOne<{ n: number }>('SELECT COUNT(*) n FROM agents')!.n, before, 'no agent rows created');
  const row = db.queryOne<any>('SELECT * FROM tasks WHERE id=?', [t.id])!;
  assert.equal(row.planning_complete, 1);
  assert.equal(row.status, 'backlog');
  assert.equal(row.assigned_agent_id, null);
  assert.match(row.description, /Original description/);
  assert.match(row.description, /Researcher \(Research\): Find the facts/);
  assert.equal(JSON.parse(row.planning_agents)[0].name, 'Researcher');
  db.run("UPDATE tasks SET updated_at='2020-01-01' WHERE id=?", [t.id]);
  const routed: string[] = [];
  await intake.runIntakeAdvanceSweep({
    route: (async (task: { title: string }) => { routed.push(task.title); return { status: 'waiting', reason: 'fixture', owner: 'SYSTEM', retryable: true }; }) as any,
    dispatch: (async () => ({ status: 'held', reason: 'fixture' })) as any,
  });
  assert.ok(routed.includes('Plan me ' + t.id), 'intake-advance routes the completed planning task');
  assert.notEqual((await dispatcher.autoDispatchTask(t.id, 'test')).reason, 'planning_in_progress');
});

test('(11) a gateway error is a distinct error state, not "no reply yet"', async () => {
  const t = planningTask();
  gatewayDown = true;
  const out = await poll(t.id);
  assert.equal(out.gatewayError, true);
  assert.equal(out.hasUpdates, false);
  gatewayDown = false;
  assert.equal((await poll(t.id)).gatewayError, undefined, 'healthy gateway with no reply is not an error');
});

test('(11) malformed reply: one re-prompt in the same session, then the raw text is shown', async () => {
  const t = planningTask();
  history = [reply('Sure! Let me think about that.')];
  const first = await poll(t.id);
  assert.equal(first.hasUpdates, false);
  assert.equal(sent.length, 1);
  assert.match(sent[0], /not valid JSON/);

  history = [reply('Sure! Let me think about that.'), reply('Still not json')];
  const second = await poll(t.id);
  assert.equal(sent.length, 1, 'no second re-prompt');
  assert.equal(second.malformedReply, 'Still not json');

  const { GET } = await import('../../src/app/api/tasks/[id]/planning/route');
  const state = await (await GET(new NextRequest('http://x'), { params: Promise.resolve({ id: t.id }) })).json();
  assert.equal(state.malformedReply, 'Still not json');

  // "Try again" re-prompts once more.
  const { POST } = await import('../../src/app/api/tasks/[id]/planning/poll/route');
  const res = await POST(new NextRequest('http://x', { method: 'POST' }), { params: Promise.resolve({ id: t.id }) });
  assert.equal(res.status, 200);
  assert.equal(sent.length, 2);
});

test('(11) a valid question after a re-prompt is accepted', async () => {
  const t = planningTask();
  history = [reply('oops')];
  await poll(t.id);
  const q = { question: 'Goal?', options: [{ id: 'A', label: 'x' }, { id: 'other', label: 'Other' }] };
  history = [reply('oops'), reply(JSON.stringify(q))];
  const out = await poll(t.id);
  assert.equal(out.currentQuestion.question, 'Goal?');
  assert.equal(out.malformedReply, undefined);
});

test('(12) start prompt carries the inline protocol, no PLANNING.md; (10) gateway failure is a 502 with a reason', async () => {
  const t = planningTask();
  db.run('UPDATE tasks SET planning_session_key=NULL, planning_messages=NULL WHERE id=?', [t.id]);
  const { POST } = await import('../../src/app/api/tasks/[id]/planning/route');
  const start = () => POST(new NextRequest('http://x', { method: 'POST' }), { params: Promise.resolve({ id: t.id }) });

  gatewayDown = true;
  const failed = await start();
  assert.equal(failed.status, 502);
  assert.equal((await failed.json()).reason, 'gateway_unreachable');
  assert.equal(db.queryOne<any>('SELECT planning_session_key k FROM tasks WHERE id=?', [t.id])!.k, null, 'failed start leaves no session');

  gatewayDown = false;
  assert.equal((await start()).status, 200);
  assert.doesNotMatch(sent[0], /PLANNING\.md/);
  for (const needle of ['"question"', '"options"', '"status": "complete"', 'success_criteria', 'deliverables', 'agents']) {
    assert.ok(sent[0].includes(needle), `prompt includes ${needle}`);
  }
});
