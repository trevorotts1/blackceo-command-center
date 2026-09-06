import './_isolated-db';
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { NextRequest } from 'next/server';
import { signTenantGrant } from '../../src/lib/auth/tenant-context';

const root = process.env.CC_TEST_FIXTURE_ROOT!;
Object.assign(process.env, {
  HOME: root, OPENCLAW_ROOT: path.join(root, 'runtime'),
  OPENCLAW_WORKSPACE_ROOT: path.join(root, 'workspace'),
  MC_COMPANY_ID: 'memory-owner', MC_API_TOKEN: 'memory-fixture-token',
  DISABLE_CRON: '1', DISABLE_BRIDGE_BOOTSTRAP: '1',
  MC_TENANT_REGISTRY_JSON: JSON.stringify({
    'memory.example': { kind: 'self', tenantId: 'memory-tenant', companyId: 'memory-owner', installationId: 'memory-install' },
    'foreign.example': { kind: 'self', tenantId: 'foreign-tenant', companyId: 'memory-foreign', installationId: 'foreign-install' },
  }),
});
let db: typeof import('../../src/lib/db');
let collection: typeof import('../../src/app/api/dept-memory/route');
let item: typeof import('../../src/app/api/dept-memory/[id]/route');
let seedDeptMemory: typeof import('../../src/lib/db/seed-dept-memory')['seedDeptMemory'];
const req = (method: string, query = '', body?: unknown, headers: Record<string, string> = {}) => new NextRequest(`https://memory.example/api/dept-memory${query}`, {
  method, headers: { host: 'memory.example', authorization: 'Bearer memory-fixture-token', ...headers },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const memories = () => db.queryAll<{id: string; workspace_id: string; content: string; created_by: string}>('SELECT * FROM dept_memory ORDER BY id');
const add = (id: string, workspace: string, content = 'Actual owner preference') => db.run('INSERT INTO dept_memory(id,workspace_id,memory_type,content) VALUES(?,?,?,?)', [id, workspace, 'context', content]);

test.before(async () => {
  db = await import('../../src/lib/db'); db.getDb();
  db.run("INSERT INTO companies(id,name,slug) VALUES('memory-owner','Owner','memory-owner'),('memory-foreign','Foreign','memory-foreign')");
  for (const [id, slug, company, archived] of [
    ['memory-ceo-uuid', 'ceo', 'memory-owner', null],
    ['memory-real', 'sales', 'memory-owner', null],
    ['memory-archived', 'marketing', 'memory-owner', '2026-09-06'],
    ['memory-duplicate-a', 'billing', 'memory-owner', null],
    ['memory-duplicate-b', 'billing-finance', 'memory-owner', null],
    ['memory-foreign-ceo', 'master-orchestrator', 'memory-foreign', null],
  ]) db.run('INSERT INTO workspaces(id,name,slug,company_id,archived_at) VALUES(?,?,?,?,?)', [id, id, slug, company, archived]);
  collection = await import('../../src/app/api/dept-memory/route');
  item = await import('../../src/app/api/dept-memory/[id]/route');
  ({ seedDeptMemory } = await import('../../src/lib/db/seed-dept-memory'));
});
test.beforeEach(() => { delete process.env.DEMO_SEED; db.run('DELETE FROM dept_memory'); });
test.after(() => db.closeDb());

test('GET is read-only even when demo mode is enabled, with an explicit owned workspace', async () => {
  process.env.DEMO_SEED = 'true';
  const response = await collection.GET(req('GET', '?workspace_id=memory-ceo-uuid'));
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), { data: [] });
  assert.deepEqual(memories(), []);
  assert.equal((await collection.GET(req('GET'))).status, 400);
});

test('ordinary seed never creates fictional goals and requires explicit valid company for demos', () => {
  assert.equal(seedDeptMemory(), 0); assert.deepEqual(memories(), []);
  process.env.DEMO_SEED = 'true';
  assert.throws(() => seedDeptMemory('memory-foreign'), /matching company/);
  const previous = process.env.MC_COMPANY_ID; delete process.env.MC_COMPANY_ID;
  try { assert.throws(() => seedDeptMemory(), /explicit matching company/); assert.throws(() => seedDeptMemory('missing'), /does not exist/); }
  finally { process.env.MC_COMPANY_ID = previous; }
  assert.deepEqual(memories(), []);
});

test('explicit demo uses unique active same-company actual IDs and preserves real and foreign memory', () => {
  add('real-memory', 'memory-real'); add('foreign-memory', 'memory-foreign-ceo');
  const originals = memories(); process.env.DEMO_SEED = 'true';
  assert.ok(seedDeptMemory() > 0);
  const rows = memories(); const seeded = rows.filter(row => row.created_by === 'demo-seed');
  assert.ok(seeded.length > 0); assert.ok(seeded.every(row => row.workspace_id === 'memory-ceo-uuid' && row.content.startsWith('[DEMO] ')));
  assert.deepEqual(rows.filter(row => row.created_by !== 'demo-seed'), originals);
  assert.equal(seedDeptMemory(), 0); assert.deepEqual(memories(), rows);
});

test('all API verbs reject missing authentication and never accept body or query company authority', async () => {
  add('foreign-memory', 'memory-foreign-ceo');
  assert.equal((await collection.GET(req('GET', '?workspace_id=memory-ceo-uuid', undefined, { authorization: '' }))).status, 403);
  assert.equal((await collection.POST(req('POST', '', { workspace_id: 'memory-ceo-uuid', memory_type: 'context', content: 'x' }, { authorization: '' }))).status, 403);
  assert.equal((await item.PATCH(req('PATCH', '', { content: 'x' }, { authorization: '' }), params('foreign-memory'))).status, 403);
  assert.equal((await item.DELETE(req('DELETE', '', undefined, { authorization: '' }), params('foreign-memory'))).status, 403);
  assert.equal((await collection.GET(req('GET', '?workspace_id=memory-foreign-ceo&company_id=memory-foreign'))).status, 404);
  assert.equal((await collection.POST(req('POST', '', { workspace_id: 'memory-foreign-ceo', company_id: 'memory-foreign', memory_type: 'context', content: 'x' }))).status, 404);
  assert.equal(memories().length, 1);
});

test('foreign and legacy orphan memory IDs cannot be read, edited or deleted', async () => {
  add('foreign-memory', 'memory-foreign-ceo'); add('orphan-memory', 'nonexistent-legacy-ceo'); const original = memories();
  for (const [id, workspace] of [['foreign-memory', 'memory-foreign-ceo'], ['orphan-memory', 'nonexistent-legacy-ceo']]) {
    assert.equal((await collection.GET(req('GET', `?workspace_id=${workspace}`))).status, 404);
    assert.equal((await item.PATCH(req('PATCH', '', { content: 'overwritten' }), params(id))).status, 404);
    assert.equal((await item.DELETE(req('DELETE'), params(id))).status, 404);
  }
  assert.deepEqual(memories(), original);
});

test('authenticated owner can create, read, edit and delete real memories', async () => {
  const created = await collection.POST(req('POST', '', { workspace_id: 'memory-ceo-uuid', memory_type: 'goal', content: 'Owner actual goal' }));
  assert.equal(created.status, 201); const { data } = await created.json();
  const read = await collection.GET(req('GET', '?workspace_id=memory-ceo-uuid'));
  assert.equal((await read.json()).data[0].content, 'Owner actual goal');
  const changed = await item.PATCH(req('PATCH', '', { content: 'Owner updated goal' }), params(data.id));
  assert.equal(changed.status, 200); assert.equal((await changed.json()).data.content, 'Owner updated goal');
  assert.equal((await item.DELETE(req('DELETE'), params(data.id))).status, 200); assert.deepEqual(memories(), []);
});

test('signed browser session is scoped to its registered company and host', async () => {
  add('owned-memory', 'memory-ceo-uuid'); add('foreign-memory', 'memory-foreign-ceo');
  const token = await signTenantGrant({ purpose: 'session', tenantId: 'memory-tenant', subject: 'owner', host: 'memory.example', installationId: 'memory-install', exp: Date.now()/1000 + 60, nonce: 'fixture' });
  const headers = { authorization: '', cookie: `mc_tenant_session=${token}` };
  assert.equal((await collection.GET(req('GET', '?workspace_id=memory-ceo-uuid', undefined, headers))).status, 200);
  assert.equal((await collection.GET(req('GET', '?workspace_id=memory-foreign-ceo', undefined, headers))).status, 404);
  assert.equal((await collection.GET(req('GET', '?workspace_id=memory-foreign-ceo', undefined, { ...headers, host: 'foreign.example' }))).status, 403);
});

test('archived or invented workspace cannot receive a new memory', async () => {
  for (const workspace_id of ['memory-archived', 'invented']) assert.equal((await collection.POST(req('POST', '', { workspace_id, memory_type: 'context', content: 'x' }))).status, 404);
  assert.deepEqual(memories(), []);
});

test('real production db:seed on fresh migrated database leaves department memories empty across reruns', () => {
  const databasePath = path.join(root, 'production-seed.test.db');
  const env = { ...process.env, DATABASE_PATH: databasePath, DEMO_SEED: '' };
  for (let i = 0; i < 2; i++) {
    const result = spawnSync(process.execPath, ['--import', 'tsx', 'src/lib/db/seed.ts'], { cwd: process.cwd(), env, encoding: 'utf8', timeout: 60000 });
    assert.equal(result.status, 0, result.stderr + result.stdout);
    const actual = new Database(databasePath, { readonly: true });
    try { assert.equal((actual.prepare('SELECT count(*) n FROM dept_memory').get() as {n: number}).n, 0); }
    finally { actual.close(); }
  }
});
