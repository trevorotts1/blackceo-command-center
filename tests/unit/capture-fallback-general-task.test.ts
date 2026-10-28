/**
 * A General Task placement made because capture could not route is a FALLBACK,
 * not an explicit request, and must re-route once the box can route.
 *
 * The defect: ingest parked an unroutable bare card in the General Task
 * workspace, createTaskCore backfilled `department='general-task'` from that
 * workspace, and the router's Step 1 read that department as the owner's explicit
 * tag. The card was stamped "[catch-all] Explicit General Task request" and the
 * intake sweep only ever re-checked its executor, so it never re-routed after the
 * box was healed.
 *
 * Drives the REAL signed ingest POST and the REAL intake sweep on a fresh DB
 * whose self-client row starts with interview_complete=0 (not provisioned).
 */
import './_isolated-db';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHmac, randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';

const root = process.env.CC_TEST_FIXTURE_ROOT!;
const WEBHOOK_SECRET = 'test-webhook-secret-capture-fallback';
Object.assign(process.env, {
  OPENCLAW_ROOT: path.join(root, 'openclaw'), OPENCLAW_WORKSPACE_ROOT: root, WORKSPACE_BASE_PATH: root,
  DISABLE_CRON: '1', DISABLE_BRIDGE_BOOTSTRAP: '1', OWNER_NOTIFY_TELEGRAM_DISABLED: '1',
  INTAKE_ADVANCE_GRACE_SECONDS: '0', INTAKE_ADVANCE_BATCH: '100',
  SOP_EMBEDDING_PROVIDER: 'openai', OPENAI_API_KEY: '', WEBHOOK_SECRET,
});
delete process.env.GOOGLE_API_KEY;
delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
delete process.env.GEMINI_API_KEY;
const oldFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error('Capture-fallback fixture forbids network'); };

let db: typeof import('../../src/lib/db');
let intake: typeof import('../../src/lib/jobs/intake-advance-sweep');
let policy: typeof import('../../src/lib/routing/catch-all-policy');
let POST: typeof import('../../src/app/api/tasks/ingest/route')['POST'];

test.before(async () => {
  db = await import('../../src/lib/db'); db.getDb();
  intake = await import('../../src/lib/jobs/intake-advance-sweep');
  policy = await import('../../src/lib/routing/catch-all-policy');
  POST = (await import('../../src/app/api/tasks/ingest/route')).POST;
  fs.mkdirSync(path.join(root, 'openclaw', 'agents'), { recursive: true });
  fs.writeFileSync(path.join(root, 'openclaw', 'openclaw.json'), JSON.stringify({ agents: { list: [] } }));
});
test.after(() => { globalThis.fetch = oldFetch; db?.closeDb(); });

function registerRuntime(id: string) {
  fs.mkdirSync(path.join(root, 'openclaw', 'agents', id), { recursive: true });
  const configPath = path.join(root, 'openclaw', 'openclaw.json');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  config.agents.list.push({ id });
  fs.writeFileSync(configPath, JSON.stringify(config));
}

/**
 * One company with a General Task worker and a Sales worker, built once (workspace
 * slugs are unique across companies). The box starts with the interview flag OFF.
 */
let shared: { company: string; generalWs: string; salesWs: string; general: string; sales: string } | undefined;
function fixture() {
  if (!shared) {
    const company = randomUUID(), generalWs = randomUUID(), salesWs = randomUUID();
    const general = randomUUID(), sales = randomUUID();
    db.run('INSERT INTO companies(id,name,slug) VALUES(?,?,?)', [company, 'Fixture Company', company]);
    db.run('INSERT INTO workspaces(id,name,slug,company_id) VALUES(?,?,?,?)', [generalWs, 'General Task', 'general-task', company]);
    db.run('INSERT INTO workspaces(id,name,slug,company_id) VALUES(?,?,?,?)', [salesWs, 'Sales', 'sales', company]);
    for (const [id, workspace, name] of [[general, generalWs, 'General'], [sales, salesWs, 'Sales Rep']] as const) {
      db.run('INSERT INTO agents(id,name,role,workspace_id,is_master,status,model) VALUES(?,?,?,?,0,?,?)',
        [id, name, 'Worker', workspace, 'standby', 'deepseek/deepseek-v4-flash']);
      db.run('UPDATE agents SET openclaw_agent_id=? WHERE id=?', [`rt-${id}`, id]);
      registerRuntime(`rt-${id}`);
    }
    shared = { company, generalWs, salesWs, general, sales };
  }
  process.env.MC_COMPANY_ID = shared.company;
  setInterviewComplete(false);
  return shared;
}
function setInterviewComplete(done: boolean) {
  db.run('UPDATE clients SET interview_complete = ? WHERE is_self = 1', [done ? 1 : 0]);
}
async function ingest(payload: Record<string, unknown>) {
  const rawBody = JSON.stringify(payload);
  const res = await POST(new NextRequest('http://localhost/api/tasks/ingest', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-webhook-signature': createHmac('sha256', WEBHOOK_SECRET).update(rawBody).digest('hex') },
    body: rawBody,
  }));
  assert.equal(res.status, 201, await res.clone().text());
  return ((await res.json()) as { task_id: string }).task_id;
}
const row = (id: string) => db.queryOne<any>('SELECT * FROM tasks WHERE id=?', [id])!;
const held = async () => ({ status: 'held' as const, reason: 'fixture dispatch recorder' });
/** Park the card as the queued, never-started state the stuck boxes were in (the status write clears the reason, so put it back). */
function queue(id: string) {
  const reason = row(id).routing_reason;
  db.run("UPDATE tasks SET status='backlog', updated_at='2020-01-01', dispatch_attempts=0, next_dispatch_eligible_at=NULL WHERE id=?", [id]);
  db.run('UPDATE tasks SET routing_reason=? WHERE id=?', [reason, id]);
}

const SALES_TEXT = 'Send the sales proposal to the new lead and follow up on the pipeline deal';

test('a bare card captured while the box is not provisioned is stamped as a fallback, not an explicit request', async () => {
  const f = fixture();
  const id = await ingest({ title: SALES_TEXT, source: 'telegram', idempotency_key: randomUUID() });
  const task = row(id);
  assert.equal(task.workspace_id, f.generalWs);
  assert.match(task.routing_reason, /^\[catch-all\] Fallback at capture/);
  assert.doesNotMatch(task.routing_reason, /Explicit General Task request/);
  assert.equal(policy.isCaptureFallbackTask(task), true);
});

test('once the box is provisioned the sweep re-routes a fallback card to the right department, once', async () => {
  const f = fixture();
  const id = await ingest({ title: SALES_TEXT, source: 'telegram', idempotency_key: randomUUID() });
  queue(id);
  setInterviewComplete(true);
  const sent: string[] = [];
  await intake.runIntakeAdvanceSweep({ dispatch: async (taskId) => { sent.push(taskId); return held(); } });
  const task = row(id);
  assert.equal(task.workspace_id, f.salesWs, task.routing_reason);
  assert.equal(task.assigned_agent_id, f.sales);
  assert.equal(task.department, 'sales');
  assert.doesNotMatch(task.routing_reason ?? '', /Fallback at capture/, 'the marker is consumed so it cannot loop');
  assert.ok(sent.includes(id));
});

test('while the box is still not provisioned the sweep leaves a fallback card parked and does not classify it', async () => {
  const f = fixture();
  const id = await ingest({ title: SALES_TEXT, source: 'telegram', idempotency_key: randomUUID() });
  queue(id);
  await intake.runIntakeAdvanceSweep({ dispatch: held });
  const task = row(id);
  assert.equal(task.workspace_id, f.generalWs);
  assert.match(task.routing_reason, /^\[catch-all\] Fallback at capture/, 'marker survives until the box can route');
});

test('a card the owner explicitly sent to General Task stays in General Task after the box is provisioned', async () => {
  const f = fixture();
  const id = await ingest({ title: SALES_TEXT, source: 'telegram', department_slug: 'general-task', idempotency_key: randomUUID() });
  assert.match(row(id).routing_reason, /^\[catch-all\] Explicit General Task request/);
  assert.equal(policy.isCaptureFallbackTask(row(id)), false);
  queue(id);
  setInterviewComplete(true);
  await intake.runIntakeAdvanceSweep({ dispatch: held });
  const task = row(id);
  assert.equal(task.workspace_id, f.generalWs);
  assert.equal(task.assigned_agent_id, f.general);
  assert.match(task.routing_reason, /^\[catch-all\] Explicit General Task request/);
});

test('a bare card on a provisioned box that routes by content is unaffected', async () => {
  const f = fixture();
  setInterviewComplete(true);
  const id = await ingest({ title: SALES_TEXT, source: 'telegram', idempotency_key: randomUUID() });
  const task = row(id);
  assert.equal(task.workspace_id, f.salesWs);
  assert.equal(task.assigned_agent_id, f.sales);
  assert.equal(policy.isCaptureFallbackTask(task), false);
});

test('legacy rows: only an ingest bare-capture General card is re-routable', async () => {
  const legacy = '[catch-all] Explicit General Task request. Assigned to General worker for execution.';
  const bare = '— Captured via task-ingest —\nSource: telegram';
  const tagged = '— Captured via task-ingest —\nSource: telegram\nRequested department: general-task';
  const cases: Array<[string, Parameters<typeof policy.isCaptureFallbackTask>[0], boolean]> = [
    ['ingest bare capture', { routing_reason: legacy, department: 'general-task', description: `Do it.\n\n${bare}` }, true],
    ['department alias general', { routing_reason: legacy, department: 'general', description: `Do it.\n\n${bare}` }, true],
    ['owner named the department', { routing_reason: legacy, department: 'general-task', description: `Do it.\n\n${tagged}` }, false],
    ['no ingest provenance (UI or CEO chat)', { routing_reason: legacy, department: 'general-task', description: 'Do it.' }, false],
    ['no description', { routing_reason: legacy, department: 'general-task', description: null }, false],
    ['a real department', { routing_reason: legacy, department: 'sales', description: `Do it.\n\n${bare}` }, false],
    ['a content-judged catch-all', { routing_reason: '[catch-all] No eligible department match. Assigned to General worker.', department: 'general-task', description: `Do it.\n\n${bare}` }, false],
    ['no reason', { routing_reason: null, department: 'general-task', description: `Do it.\n\n${bare}` }, false],
    ['new marker', { routing_reason: `[catch-all] ${policy.CAPTURE_FALLBACK_REASON}. Assigned to General worker.`, department: 'general-task', description: null }, true],
  ];
  for (const [name, input, expected] of cases) assert.equal(policy.isCaptureFallbackTask(input), expected, name);
});

test('legacy stuck rows re-route once the box is provisioned; the owner-named one stays', async () => {
  const f = fixture();
  const legacyReason = '[catch-all] Explicit General Task request. Assigned to General worker for execution.';
  function legacyRow(description: string) {
    const id = randomUUID();
    db.run(`INSERT INTO tasks(id,title,description,status,workspace_id,department,assigned_agent_id,created_at,updated_at)
      VALUES(?,?,?,'backlog',?,'general-task',?,'2020-01-01','2020-01-01')`, [id, SALES_TEXT, description, f.generalWs, f.general]);
    db.run('UPDATE tasks SET routing_reason=? WHERE id=?', [legacyReason, id]);
    return id;
  }
  const stuck = legacyRow('Source: telegram\n\n— Captured via task-ingest —\nSource: telegram');
  const named = legacyRow('Source: telegram\n\n— Captured via task-ingest —\nSource: telegram\nRequested department: general-task');
  setInterviewComplete(true);
  await intake.runIntakeAdvanceSweep({ dispatch: held });
  assert.equal(row(stuck).workspace_id, f.salesWs, row(stuck).routing_reason);
  assert.equal(row(stuck).assigned_agent_id, f.sales);
  assert.equal(row(named).workspace_id, f.generalWs);
  assert.equal(row(named).assigned_agent_id, f.general);
  assert.equal(row(named).routing_reason, legacyReason);
});

test('a re-route that finds nothing better ends the fallback instead of looping every tick', async () => {
  const f = fixture();
  const id = await ingest({ title: 'zxqv blorpt', source: 'telegram', idempotency_key: randomUUID() });
  queue(id);
  setInterviewComplete(true);
  let routed = 0;
  const { routeTaskDecision } = await import('../../src/lib/routing/department-router');
  const counting = async (input: Parameters<typeof routeTaskDecision>[0]) => { if (input.title === 'zxqv blorpt') routed++; return routeTaskDecision(input); };
  await intake.runIntakeAdvanceSweep({ route: counting, dispatch: held });
  assert.equal(row(id).workspace_id, f.generalWs, 'nothing matched, so General Task is now a real decision');
  assert.doesNotMatch(row(id).routing_reason ?? '', /Fallback at capture/);
  assert.equal(policy.isCaptureFallbackTask(row(id)), false);
  const after = routed;
  queue(id);
  await intake.runIntakeAdvanceSweep({ route: counting, dispatch: held });
  assert.equal(policy.isCaptureFallbackTask(row(id)), false);
  assert.ok(routed - after <= 1, 'at most the ordinary catch-all executor check on the next tick');
});
