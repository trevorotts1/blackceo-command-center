/** Real signed ingest coverage for the operator presentation contract. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHmac } from 'node:crypto';
import { NextRequest } from 'next/server';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-operator-ingest-'));
process.env.DATABASE_PATH = path.join(ROOT, 'mission-control.db');
process.env.WEBHOOK_SECRET = 'operator-ingest-test-secret';
process.env.OPENCLAW_ROOT = '/nonexistent-openclaw-root';
process.env.OWNER_NOTIFY_TELEGRAM_DISABLED = '1';

const RUN = Math.random().toString(36).slice(2, 9);
type Db = typeof import('../../src/lib/db');
let run: Db['run']; let queryOne: Db['queryOne']; let closeDb: Db['closeDb'];
type Route = typeof import('../../src/app/api/tasks/ingest/route'); let POST: Route['POST'];

function intake(title: string, changes: Record<string, unknown> = {}) {
  return {
    version: 1, source: 'operator-delegated', title, presentation_type: 'from_scratch',
    run_mode: 'ultra', workhorse_model: 'deepseek-flash@deepseek-direct', slide_count: 8,
    pitch_included: false, deliverable_set: 'deck, teleprompter, speech, audio',
    want_teleprompter: 'yes', want_speech_script: 'yes', want_audio_deliverable: 'yes',
    want_audio_demo: true, want_ghl_upload: 'yes', delivery_destinations: ['local presentation folder', 'GoHighLevel'],
    want_sales_checkout: 'yes', want_vsl_page: 'yes', answers: { goal: 'Explain the department.' }, ...changes,
  };
}
function signed(payload: Record<string, unknown>) {
  const raw = JSON.stringify(payload);
  return new NextRequest('http://localhost/api/tasks/ingest', { method: 'POST', headers: {
    'content-type': 'application/json',
    'x-webhook-signature': createHmac('sha256', process.env.WEBHOOK_SECRET!).update(raw).digest('hex'),
  }, body: raw });
}
async function ingest(payload: Record<string, unknown>) { return POST(signed(payload)) as unknown as Promise<Response>; }

 test.before(async () => {
  const db = await import('../../src/lib/db') as Db;
  run = db.run; queryOne = db.queryOne; closeDb = db.closeDb; db.getDb();
  const now = new Date().toISOString();
  run(`INSERT OR IGNORE INTO companies (id,name,slug,config,created_at,updated_at) VALUES ('default','Default','default','{}',?,?)`, [now, now]);
  run(`INSERT OR IGNORE INTO workspaces (id,slug,name,icon,company_id,sort_order,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`, [`presentations-${RUN}`, 'presentations', 'Presentations', '📊', 'default', 1, now, now]);
  run(`INSERT OR IGNORE INTO workspaces (id,slug,name,icon,company_id,sort_order,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`, [`general-${RUN}`, 'general-task', 'General Task', '📋', 'default', 2, now, now]);
  // This suite verifies ingest and identity only; no agent means no detached launch.
  run(`DELETE FROM agents WHERE workspace_id = (SELECT id FROM workspaces WHERE slug = 'presentations' LIMIT 1)`);
  POST = (await import('../../src/app/api/tasks/ingest/route') as Route).POST;
});
test.after(() => { try { closeDb(); } catch {} fs.rmSync(ROOT, { recursive: true, force: true }); });

test('wrong department is rejected before an operator presentation task is created', async () => {
  const title = `wrong department ${RUN}`;
  const response = await ingest({ title, source: 'operator-delegated', department_slug: 'general-task', idempotency_key: `wrong-${RUN}`, presentation_intake: intake(title) });
  assert.equal(response.status, 400);
  assert.equal(queryOne<{ n: number }>('SELECT count(*) n FROM tasks WHERE title=?', [title])?.n, 0);
});

test('equivalent parsed intake dedupes and safely recovers one missing contract', async () => {
  const title = `dedupe ${RUN}`; const key = `same-${RUN}`;
  const payload = { title, source: 'operator-delegated', department_slug: 'presentations', idempotency_key: key, presentation_intake: intake(title) };
  const first = await ingest(payload); assert.equal(first.status, 201); const firstBody = await first.json() as { task_id: string };
  run('DELETE FROM presentation_operator_contracts WHERE task_id=?', [firstBody.task_id]);
  // The driver normalizes destination whitespace. A retry carrying that
  // equivalent representation must retain the original operation identity.
  const equivalent = { ...payload, presentation_intake: intake(title, { delivery_destinations: [' local presentation folder ', ' GoHighLevel '] }) };
  const retry = await ingest(equivalent); assert.equal(retry.status, 200); const retryBody = await retry.json() as { task_id: string; deduped: boolean };
  assert.equal(retryBody.task_id, firstBody.task_id); assert.equal(retryBody.deduped, true);
  assert.equal(queryOne<{ n: number }>('SELECT count(*) n FROM presentation_operator_contracts WHERE task_id=?', [firstBody.task_id])?.n, 1);
});

test('same operation with changed parsed intake is a 409 and does not mint a second task', async () => {
  const title = `conflict ${RUN}`; const key = `conflict-${RUN}`;
  const first = await ingest({ title, source: 'operator-delegated', department_slug: 'presentations', idempotency_key: key, presentation_intake: intake(title) });
  assert.equal(first.status, 201);
  const changed = await ingest({ title, source: 'operator-delegated', department_slug: 'presentations', idempotency_key: key, presentation_intake: intake(title, { want_vsl_page: 'no' }) });
  assert.equal(changed.status, 409);
  assert.equal(queryOne<{ n: number }>('SELECT count(*) n FROM tasks WHERE title=?', [title])?.n, 1);
});
