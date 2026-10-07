/**
 * Correction learning is recorded only for a genuine person (verified tenant session, no updated_by_agent_id),
 * never for the shared MC_API_TOKEN bearer that agents and scripts use, and only AFTER the UPDATE succeeded.
 * Offline; DB and HOME are temp dirs.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHmac, randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-corr-route-'));
process.env.DATABASE_PATH = path.join(dir, 'fixture.db');
Object.assign(process.env, {
  HOME: dir, CC_TEST_FIXTURE_ROOT: dir, WORKSPACE_BASE_PATH: dir, OPENCLAW_WORKSPACE_ROOT: dir,
  OPENCLAW_ROOT: path.join(dir, 'openclaw'), OPENCLAW_COMPANY_ROOT: path.join(dir, 'company'),
  BCC_DEVICE_IDENTITY_DIR: path.join(dir, 'identity'), OPENCLAW_SKILL23_SCRIPTS: path.join(dir, 'absent'),
  OPENCLAW_CLI_BIN: '/usr/bin/false', OPENCLAW_GATEWAY_URL: 'invalid-fixture-url',
  OWNER_NOTIFY_TELEGRAM_DISABLED: '1', DISABLE_CRON: '1', DISABLE_BRIDGE_BOOTSTRAP: '1',
  MC_API_TOKEN: 'corr-fixture-only', MC_COMPANY_ID: 'corr-a', MC_INSTALLATION_ID: 'corr-install',
  MC_TENANT_REGISTRY_JSON: JSON.stringify({ localhost: { tenantId: 'corr-tenant', companyId: 'corr-a', kind: 'self', installationId: 'corr-install' } }),
});
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error('fixture prohibits network'); };
let db: typeof import('../../src/lib/db');
let PATCH: typeof import('../../src/app/api/tasks/[id]/route')['PATCH'];

const sessionCookie = () => {
  const payload = Buffer.from(JSON.stringify({ purpose: 'session', tenantId: 'corr-tenant', companyId: 'corr-a', subject: 'owner:person', host: 'localhost', installationId: 'corr-install', exp: Date.now() / 1000 + 3600, nonce: 'n' })).toString('base64url');
  return `mc_tenant_session=${payload}.${createHmac('sha256', process.env.MC_API_TOKEN!).update(payload).digest('base64url')}`;
};
const patch = (id: string, body: object, as: 'person' | 'bearer') => PATCH(
  new NextRequest(`http://localhost/api/tasks/${id}`, {
    method: 'PATCH', body: JSON.stringify(body),
    headers: { host: 'localhost', 'content-type': 'application/json', ...(as === 'bearer' ? { authorization: 'Bearer corr-fixture-only' } : { cookie: sessionCookie() }) },
  }), { params: Promise.resolve({ id }) });
const corrections = () => db.queryAll<{ text: string; department: string }>('SELECT text, department FROM routing_department_corrections').filter(Boolean);
const tableCount = () => { try { return corrections().length; } catch { return 0; } };
const seedTask = (title: string) => { const id = randomUUID(); db.run('INSERT INTO tasks (id,title,status,priority,workspace_id) VALUES (?,?,?,?,?)', [id, title, 'backlog', 'medium', 'ws-billing']); return id; };

test.before(async () => {
  db = await import('../../src/lib/db');
  db.getDb();
  db.run('INSERT INTO companies (id,name,slug) VALUES (?,?,?)', ['corr-a', 'corr-a', 'corr-a']);
  db.run('INSERT INTO companies (id,name,slug) VALUES (?,?,?)', ['corr-b', 'corr-b', 'corr-b']);
  for (const [id, slug, co] of [['ws-billing', 'billing-finance', 'corr-a'], ['ws-sales', 'sales', 'corr-a'], ['ws-foreign', 'legal', 'corr-b']]) db.run('INSERT INTO workspaces (id,name,slug,company_id) VALUES (?,?,?,?)', [id, slug, slug, co]);
  for (const [id, ws] of [['ag-sales', 'ws-sales'], ['ag-qc', 'ws-billing'], ['ag-foreign', 'ws-foreign']]) db.run('INSERT INTO agents (id,name,role,workspace_id,is_master) VALUES (?,?,?,?,1)', [id, id, 'Tester', ws]);
  PATCH = (await import('../../src/app/api/tasks/[id]/route')).PATCH;
});
test.after(() => { globalThis.fetch = originalFetch; db?.closeDb(); fs.rmSync(dir, { recursive: true, force: true }); });

test('a verified person moving a task to another department agent is recorded', async () => {
  const id = seedTask('person move');
  const r = await patch(id, { assigned_agent_id: 'ag-sales' }, 'person');
  assert.equal(r.status, 200, await r.text());
  assert.deepEqual(corrections(), [{ text: 'person move', department: 'sales' }]);
});

test('the shared bearer token (agents, scripts) is NOT a person: no correction', async () => {
  const id = seedTask('bearer move');
  const r = await patch(id, { assigned_agent_id: 'ag-sales' }, 'bearer');
  assert.equal(r.status, 200, await r.text());
  assert.equal(corrections().some((c) => c.text === 'bearer move'), false);
});

test('a person acting as an agent (updated_by_agent_id) is NOT a correction', async () => {
  const id = seedTask('agent-attributed move');
  const r = await patch(id, { assigned_agent_id: 'ag-sales', updated_by_agent_id: 'ag-qc' }, 'person');
  assert.equal(r.status, 200, await r.text());
  assert.equal(corrections().some((c) => c.text === 'agent-attributed move'), false);
});

test('a reassignment whose UPDATE fails records nothing (recorded only after the UPDATE succeeds)', async () => {
  const id = seedTask('failing move');
  db.run(`CREATE TRIGGER fail_move BEFORE UPDATE ON tasks WHEN NEW.title = 'failing move' BEGIN SELECT RAISE(ABORT, 'forced failure'); END`);
  const before = tableCount();
  const r = await patch(id, { assigned_agent_id: 'ag-sales' }, 'person');
  assert.notEqual(r.status, 200);
  assert.equal(db.queryOne<{ a: string | null }>('SELECT assigned_agent_id AS a FROM tasks WHERE id=?', [id])?.a ?? null, null);
  assert.equal(tableCount(), before);
  assert.equal(corrections().some((c) => c.text === 'failing move'), false);
  db.run('DROP TRIGGER fail_move');
});

test('a reassignment to another company agent is refused before anything is recorded', async () => {
  const id = seedTask('foreign move');
  const r = await patch(id, { assigned_agent_id: 'ag-foreign' }, 'person');
  assert.notEqual(r.status, 200);
  assert.equal(corrections().some((c) => c.text === 'foreign move'), false);
});
