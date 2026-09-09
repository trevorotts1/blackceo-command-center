/**
 * social-f01-publish-tenant.test.ts — F01 acceptance (CC half).
 *
 * "Through automation APIs, client A cannot list, enqueue, append to or
 * publish for client B by substituting a B task or sheet ID. Direct editing
 * through an intentionally shared planner link remains allowed. Unauthenticated
 * and replayed requests are rejected without side effects."
 *
 * Proven in-process against an isolated temp DB (real migration chain incl.
 * 135) and the REAL route handlers:
 *   1. Unauthenticated GET/POST -> 403, zero queue rows.
 *   2. Company A cannot enqueue with company B's task_id -> 404, zero B writes.
 *   3. Company A cannot list company B's queue rows by substituting B's
 *      task_id -> 404; GET returns only A's own rows.
 *   4. Company A cannot enqueue with a B-registered or unregistered sheet_id
 *      -> 404, zero writes (F01-D1 enforcement through POST, not just the
 *      helper); a valid A sheet_id succeeds and sheet_id is persisted.
 *   5. Company A cannot enqueue/list a task in a 'default' workspace, and a
 *      task in no workspace is foreign to a non-default company (F01-D2).
 *   6. A valid A request succeeds once, stamps company_id, and appears in
 *      A's list; re-reading A's list never returns B's rows.
 *   7. Migration 135 added publish_queue.company_id (column + index) and
 *      publish_queue.sheet_id (F01-D1 repair).
 *   8. The enqueue broadcasts a per-company event type
 *      (publish_queued:<company_id>) carrying the payload (F01-D3).
 *
 * Run:
 *   node --import tsx --import ./tests/setup/no-owner-telegram.ts \
 *     --test tests/unit/social-f01-publish-tenant.test.ts
 */
import './_isolated-db'; // MUST be first DB import: throwaway DATABASE_PATH.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { NextRequest } from 'next/server';
import { getDb, queryOne, run, closeDb } from '../../src/lib/db';
import { POST as publishPOST, GET as publishGET } from '../../src/app/api/skill-35/publish/route';
import { publishIdempotencyKey } from '../../src/lib/jobs/social-publish-dispatcher';
import {
  resolvePublishCompany,
  assertTaskOwnedByCompany,
  assertPlannerSheetOwnedByCompany,
  ensureSocialBindingTables,
} from '../../src/lib/social/company-context';

getDb(); // trigger the full migration chain (incl. 135) against the isolated temp DB

// ─── tenant fixtures: two companies, registry + signed session cookies ──────
const SECRET = 'f01-test-secret';
process.env.MC_TENANT_SESSION_SECRET = SECRET;
process.env.NODE_ENV = 'production';

function registryEntry(companyId: string, clientId: string) {
  return {
    tenantId: `tenant-${companyId}`,
    companyId,
    clientId,
    kind: 'client' as const,
    installationId: `install-${companyId}`,
  };
}

function setTenantRegistry(hostA: string, hostB: string): void {
  process.env.MC_TENANT_REGISTRY_JSON = JSON.stringify({
    [hostA]: registryEntry('company-a', 'client-a'),
    [hostB]: registryEntry('company-b', 'client-b'),
  });
}

function tenantCookie(host: string, companyId: string): string {
  const payload = Buffer
    .from(JSON.stringify({
      purpose: 'session',
      tenantId: `tenant-${companyId}`,
      companyId,
      subject: 'owner:fixture',
      host,
      installationId: `install-${companyId}`,
      exp: Date.now() / 1000 + 3600,
      nonce: 'f01-test',
    }))
    .toString('base64url');
  const sig = createHmac('sha256', SECRET)
    .update(payload)
    .digest('base64url');
  return `mc_tenant_session=${payload}.${sig}`;
}

function requestFor(host: string, companyId: string, init?: RequestInit): NextRequest {
  const headers = new Headers(init?.headers);
  headers.set('host', host); // NextRequest does not derive Host from the URL
  if (companyId) headers.set('cookie', tenantCookie(host, companyId));
  const method = init?.method || 'GET';
  const body = init?.body;
  return new NextRequest(`http://${host}/api/skill-35/publish`, {
    method,
    headers,
    body,
  });
}

const HOST_A = 'a-f01.example.com';
const HOST_B = 'b-f01.example.com';

function seedWorkspace(id: string, companyId: string): void {
  const now = new Date().toISOString();
  // companies row first — workspaces.company_id has an FK on companies(id).
  run(
    `INSERT OR IGNORE INTO companies (id, name, slug, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)`,
    [companyId, `Company ${companyId}`, `co-${companyId}`, now, now],
  );
  run(
    `INSERT OR IGNORE INTO workspaces (id, name, slug, company_id, sort_order, created_at, updated_at)
     VALUES (?, ?, ?, ?, 1000, ?, ?)`,
    [id, `ws-${id}`, `ws-${id}`, companyId, now, now],
  );
}

function seedTask(id: string, workspaceId: string): void {
  const now = new Date().toISOString();
  run(
    `INSERT INTO tasks (id, title, status, workspace_id, created_at, updated_at)
     VALUES (?, ?, 'backlog', ?, ?, ?)`,
    [id, `F01 task ${id}`, workspaceId, now, now],
  );
}

function queueCount(): number {
  return (queryOne<{ c: number }>('SELECT COUNT(*) AS c FROM publish_queue')?.c ?? 0);
}

test.after(() => {
  try { closeDb(); } catch { /* ignore */ }
});

// ─── migration 135: the company column and its index exist ──────────────────

test('F01 migration 135: publish_queue has company_id + sheet_id columns + company index', () => {
  const db = getDb();
  const cols = (db.prepare('PRAGMA table_info(publish_queue)').all() as { name: string }[])
    .map((c) => c.name);
  assert.ok(cols.includes('company_id'), 'company_id column must exist');
  assert.ok(cols.includes('sheet_id'), 'sheet_id column must exist (F01-D1 repair)');
  const indexes = (db.prepare('PRAGMA index_list(publish_queue)').all() as { name: string }[])
    .map((i) => i.name);
  assert.ok(
    indexes.includes('idx_publish_queue_company'),
    'idx_publish_queue_company must exist',
  );
  const applied = queryOne<{ id: string }>("SELECT id FROM _migrations WHERE id = '135'");
  assert.ok(applied, 'migration 135 must be recorded as applied');
});

// ─── unauthenticated: 403 with zero side effects ────────────────────────────

test('F01 unauthenticated GET/POST -> 403, zero queue writes', async () => {
  setTenantRegistry(HOST_A, HOST_B);
  const before = queueCount();

  const getRes = await publishGET(new NextRequest(`http://${HOST_A}/api/skill-35/publish`));
  assert.equal(getRes.status, 403);

  const postRes = await publishPOST(new NextRequest(`http://${HOST_A}/api/skill-35/publish`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ topic: 'sneak', platforms: ['linkedin'] }),
  }));
  assert.equal(postRes.status, 403);

  assert.equal(queueCount(), before, 'no queue rows may be written');
});

// ─── cross-company: A cannot enqueue with B's task_id ───────────────────────

test('F01 company A cannot enqueue with company B task_id -> 404, zero B writes', async () => {
  setTenantRegistry(HOST_A, HOST_B);
  seedWorkspace('ws-b', 'company-b');
  seedWorkspace('ws-a', 'company-a');
  seedTask('task-b-1', 'ws-b');
  seedTask('task-a-1', 'ws-a');
  const before = queueCount();

  const res = await publishPOST(requestFor(HOST_A, 'company-a', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ task_id: 'task-b-1', topic: 'steal', platforms: ['linkedin'] }),
  }));
  assert.equal(res.status, 404);
  assert.equal(queueCount(), before, 'a substituted foreign task_id must enqueue nothing');

  const body = (await res.json()) as { error?: string };
  assert.equal(body.error, 'task not found');
});

// ─── cross-company: A cannot list B rows by substituting B task_id ──────────

test('F01 company A cannot list company B queue rows via B task_id -> 404', async () => {
  setTenantRegistry(HOST_A, HOST_B);
  // B enqueues its own row.
  const bRes = await publishPOST(requestFor(HOST_B, 'company-b', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ task_id: 'task-b-1', topic: 'B topic', platforms: ['x'] }),
  }));
  assert.equal(bRes.status, 201);
  const bItem = ((await bRes.json()) as { publish: { id: string } }).publish;
  assert.equal(bItem.id && typeof bItem.id, 'string');

  // A substitutes B's task_id in a GET -> 404, and B's row is not in the body.
  const res = await publishGET(new NextRequest(`http://${HOST_A}/api/skill-35/publish?task_id=task-b-1`, {
    headers: { cookie: tenantCookie(HOST_A, 'company-a'), host: HOST_A },
  }));
  assert.equal(res.status, 404);

  // A's own list never contains B's row.
  const aList = await publishGET(requestFor(HOST_A, 'company-a'));
  assert.equal(aList.status, 200);
  const rows = ((await aList.json()) as { publishes: Array<{ id: string }> }).publishes;
  assert.ok(!rows.some((r) => r.id === bItem.id), 'A list must not leak B rows');
});

// ─── cross-company sheet: B-registered sheet is foreign to A ────────────────

test('F01 foreign sheet_id resolves null for company A; A-registered resolves', () => {
  setTenantRegistry(HOST_A, HOST_B);
  // Register the planner sheet to company B.
  ensureSocialBindingTables();
  run(
    `INSERT OR REPLACE INTO social_sheet_registry
       (company_id, planner_kind, sheet_id, sheet_url, schema_version, sharing, verified_at)
     VALUES ('company-b', 'social-planner', 'sheet-B-registered', 'https://sheets/B', '1', 'anyone,writer', NULL)`,
  );

  const asA = assertPlannerSheetOwnedByCompany('sheet-B-registered', 'company-a');
  assert.equal(asA.sheet, null, 'a B-registered sheet must be foreign to A');

  const asB = assertPlannerSheetOwnedByCompany('sheet-B-registered', 'company-b');
  assert.ok(asB.sheet, 'the registered sheet resolves for its own company');

  const absent = assertPlannerSheetOwnedByCompany('sheet-never-registered', 'company-b');
  assert.equal(absent.sheet, null, 'an unregistered sheet is foreign to everyone');
});

// ─── F01-D1 enforcement: foreign sheet_id through POST -> 404, zero writes ──

test('F01-D1 POST with B-registered sheet_id -> 404, zero rows written', async () => {
  setTenantRegistry(HOST_A, HOST_B);
  ensureSocialBindingTables();
  run(
    `INSERT OR REPLACE INTO social_sheet_registry
       (company_id, planner_kind, sheet_id, sheet_url, schema_version, sharing, verified_at)
     VALUES ('company-b', 'social-planner', 'sheet-B-post', 'https://sheets/B-post', '1', 'anyone,writer', NULL)`,
  );
  const before = queueCount();

  const res = await publishPOST(requestFor(HOST_A, 'company-a', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ task_id: 'task-a-1', topic: 'steal-sheet', platforms: ['linkedin'], sheet_id: 'sheet-B-post' }),
  }));
  assert.equal(res.status, 404);
  const body = (await res.json()) as { error?: string };
  assert.equal(body.error, 'sheet not found');
  assert.equal(queueCount(), before, 'a substituted foreign sheet_id must enqueue nothing');
});

test('F01-D1 POST with unregistered sheet_id -> 404, zero rows written', async () => {
  setTenantRegistry(HOST_A, HOST_B);
  const before = queueCount();

  const res = await publishPOST(requestFor(HOST_A, 'company-a', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ task_id: 'task-a-1', topic: 'ghost-sheet', platforms: ['linkedin'], sheet_id: 'sheet-never-registered-post' }),
  }));
  assert.equal(res.status, 404);
  assert.equal(queueCount(), before, 'an unregistered sheet_id must enqueue nothing');
});

test('F01-D1 POST with own registered sheet_id -> 201, sheet_id persisted', async () => {
  setTenantRegistry(HOST_A, HOST_B);
  ensureSocialBindingTables();
  run(
    `INSERT OR REPLACE INTO social_sheet_registry
       (company_id, planner_kind, sheet_id, sheet_url, schema_version, sharing, verified_at)
     VALUES ('company-a', 'social-planner', 'sheet-A-owned', 'https://sheets/A', '1', 'anyone,writer', NULL)`,
  );
  const before = queueCount();

  const res = await publishPOST(requestFor(HOST_A, 'company-a', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ task_id: 'task-a-1', topic: 'own-sheet', platforms: ['linkedin'], sheet_id: 'sheet-A-owned' }),
  }));
  assert.equal(res.status, 201);
  const item = ((await res.json()) as { publish: { id: string; sheet_id: string | null } }).publish;
  assert.equal(queueCount(), before + 1);
  const dbRow = queryOne<{ sheet_id: string | null }>(
    'SELECT sheet_id FROM publish_queue WHERE id = ?',
    [item.id],
  );
  assert.equal(dbRow?.sheet_id, 'sheet-A-owned', 'enforced sheet_id must persist on the row');
});

// ─── F01-D2: 'default'-company tasks are not ownable by other companies ──────

test('F01-D2 company A cannot enqueue/list a task in a default workspace', async () => {
  setTenantRegistry(HOST_A, HOST_B);
  seedWorkspace('ws-default', 'default');
  seedTask('task-default-1', 'ws-default');
  const before = queueCount();

  const res = await publishPOST(requestFor(HOST_A, 'company-a', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ task_id: 'task-default-1', topic: 'legacy-steal', platforms: ['linkedin'] }),
  }));
  assert.equal(res.status, 404);
  assert.equal(queueCount(), before, 'a default-workspace task must enqueue nothing for company A');

  const getRes = await publishGET(new NextRequest(`http://${HOST_A}/api/skill-35/publish?task_id=task-default-1`, {
    headers: { cookie: tenantCookie(HOST_A, 'company-a'), host: HOST_A },
  }));
  assert.equal(getRes.status, 404);

  const helper = assertTaskOwnedByCompany('task-default-1', 'company-a');
  assert.equal(helper.owned, false);
  const sameCompany = assertTaskOwnedByCompany('task-default-1', 'default');
  assert.equal(sameCompany.owned, true, 'caller default keeps owning default rows');
});

test('F01-D2 workspace-less task is foreign to a non-default company', () => {
  // tasks.workspace_id carries an FK to workspaces(id) with FK enforcement ON,
  // so a dangling workspace_id cannot be seeded. Simulate the legacy shape the
  // LEFT JOIN guards against — workspace row deleted after the task was made —
  // with FK temporarily off, restoring enforcement immediately after.
  const now = new Date().toISOString();
  run(
    `INSERT OR IGNORE INTO workspaces (id, name, slug, company_id, sort_order, created_at, updated_at)
     VALUES ('ws-doomed', 'ws-doomed', 'ws-doomed', 'company-a', 1000, ?, ?)`,
    [now, now],
  );
  run(
    `INSERT OR IGNORE INTO tasks (id, title, status, workspace_id, created_at, updated_at)
     VALUES ('task-no-ws', 'F01 no-workspace task', 'backlog', 'ws-doomed', ?, ?)`,
    [now, now],
  );
  const db = getDb();
  db.pragma('foreign_keys = OFF');
  try {
    db.prepare(`DELETE FROM workspaces WHERE id = 'ws-doomed'`).run();
  } finally {
    db.pragma('foreign_keys = ON');
  }
  const asA = assertTaskOwnedByCompany('task-no-ws', 'company-a');
  assert.equal(asA.owned, false, 'workspace-less task must not be ownable by company A');
});

// ─── F01-D3: per-company event scope on enqueue ──────────────────────────────

test('F01-D3 enqueue broadcasts publish_queued:<company_id> with the payload', async () => {
  setTenantRegistry(HOST_A, HOST_B);
  // The publish route broadcasts through the shared fan-out, which journals to
  // sse_event_log: read the latest journal row the enqueue just wrote.
  const res = await publishPOST(requestFor(HOST_A, 'company-a', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ task_id: 'task-a-1', topic: 'scoped-event', platforms: ['linkedin'] }),
  }));
  assert.equal(res.status, 201);
  const item = ((await res.json()) as { publish: { id: string; company_id: string } }).publish;
  const last = queryOne<{ event_type: string; payload: string }>(
    'SELECT event_type, payload FROM sse_event_log ORDER BY id DESC LIMIT 1',
  );
  assert.ok(last, 'enqueue must journal an SSE event');
  assert.equal(last?.event_type, 'publish_queued:company-a');
  const envelope = JSON.parse(last?.payload ?? '{}') as { type?: string; payload?: { id?: string; company_id?: string } };
  assert.equal(envelope.type, 'publish_queued:company-a');
  assert.equal(envelope.payload?.id, item.id);
  assert.equal(envelope.payload?.company_id, 'company-a');
});

// ─── the valid path: A succeeds once, stamped company_id, scoped reads ──────

test('F01 valid company A request succeeds once, stamps company_id, GET is company-scoped', async () => {
  setTenantRegistry(HOST_A, HOST_B);
  const before = queueCount();

  const res = await publishPOST(requestFor(HOST_A, 'company-a', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ task_id: 'task-a-1', topic: 'A topic', platforms: ['linkedin', 'x'] }),
  }));
  assert.equal(res.status, 201);
  const item = ((await res.json()) as { publish: { id: string; company_id: string } }).publish;
  assert.equal(item.company_id, 'company-a', 'the queue row must carry the caller company');
  assert.equal(queueCount(), before + 1, 'exactly one row per request');

  // Row in the DB carries the binding too.
  const dbRow = queryOne<{ company_id: string }>(
    'SELECT company_id FROM publish_queue WHERE id = ?',
    [item.id],
  );
  assert.equal(dbRow?.company_id, 'company-a');

  // A's list shows it; B's list does not.
  const aList = await publishGET(requestFor(HOST_A, 'company-a'));
  const aRows = ((await aList.json()) as { publishes: Array<{ id: string }> }).publishes;
  assert.ok(aRows.some((r) => r.id === item.id), 'A sees its own row');

  const bList = await publishGET(requestFor(HOST_B, 'company-b'));
  const bRows = ((await bList.json()) as { publishes: Array<{ id: string }> }).publishes;
  assert.ok(!bRows.some((r) => r.id === item.id), 'B list must not contain A rows');
});

// ─── F20: duplicate webhook delivery — deterministic key, one side effect ───

test('F20 duplicate webhook delivery: both deliveries derive ONE idempotency key', async () => {
  setTenantRegistry(HOST_A, HOST_B);
  const body = JSON.stringify({ task_id: 'task-a-1', topic: 'Dup Delivery', platforms: ['linkedin', 'x'] });

  const first = await publishPOST(requestFor(HOST_A, 'company-a', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  }));
  assert.equal(first.status, 201);
  // The SAME webhook delivered twice (a network retry of the SAME request).
  const second = await publishPOST(requestFor(HOST_A, 'company-a', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  }));
  assert.equal(second.status, 201);

  // The dedupe contract (F03.5): the deterministic key derives from
  // company+task+topic+platforms — identical for both deliveries — so a
  // double dispatch lands on exactly ONE canonical card, never two. If the
  // key stops being stable (e.g. case-sensitive topic or sorted platforms
  // drift) a duplicate delivery would double the side effects and this test
  // turns RED.
  const firstRow = queryOne<{ company_id: string; task_id: string | null; topic: string; platforms: string | null }>(
    'SELECT company_id, task_id, topic, platforms FROM publish_queue ORDER BY created_at DESC LIMIT 2 OFFSET 1',
  );
  const secondRow = queryOne<{ company_id: string; task_id: string | null; topic: string; platforms: string | null }>(
    'SELECT company_id, task_id, topic, platforms FROM publish_queue ORDER BY created_at DESC LIMIT 1',
  );
  assert.ok(firstRow && secondRow, 'both deliveries must enqueue their own row');
  const parsedFirst = JSON.parse(firstRow.platforms ?? '[]') as string[];
  const parsedSecond = JSON.parse(secondRow.platforms ?? '[]') as string[];
  const k1 = publishIdempotencyKey({
    companyId: firstRow.company_id, taskId: firstRow.task_id,
    topic: firstRow.topic, platforms: parsedFirst,
  });
  const k2 = publishIdempotencyKey({
    companyId: secondRow.company_id, taskId: secondRow.task_id,
    topic: secondRow.topic, platforms: parsedSecond,
  });
  assert.equal(k1, k2, 'duplicate deliveries must derive the SAME idempotency key (one card, one execution)');
});

// ─── resolvePublishCompany: registry-bound identity ─────────────────────────

test('F01 resolvePublishCompany binds tenant identity to its company', async () => {
  setTenantRegistry(HOST_A, HOST_B);
  const a = await resolvePublishCompany(requestFor(HOST_A, 'company-a'));
  assert.ok(a.ok);
  assert.equal((a as { company: { companyId: string } }).company.companyId, 'company-a');

  const b = await resolvePublishCompany(requestFor(HOST_B, 'company-b'));
  assert.ok(b.ok);
  assert.equal((b as { company: { companyId: string } }).company.companyId, 'company-b');
});

// ─── ownership helper: absent task is treated as foreign (no oracle) ────────

test('F01 absent task_id answers not-owned (no existence oracle)', () => {
  const result = assertTaskOwnedByCompany('task-does-not-exist', 'company-a');
  assert.equal(result.owned, false, 'absent task must be indistinguishable from foreign');
});