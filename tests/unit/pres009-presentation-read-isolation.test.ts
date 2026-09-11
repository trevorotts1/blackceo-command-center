/**
 * PRES-009 — presentation READ isolation (phases / deliverables / children).
 *
 * Proves the read routes use the ingest-grade ownership predicate
 * (src/lib/presentation-tenant-scope.ts — workspace-with-company OR
 * task_request_keys identity) instead of `workspace_id IS NULL OR ...`:
 *
 *   1. OWN company task with an attributed workspace reads (200/200/200).
 *   2. OWN company NULL-workspace task WITH a durable task_request_keys
 *      identity reads — durable request identity is honored (QC 2).
 *   3. OWN company NULL-workspace task WITHOUT any durable identity is 404 —
 *      NULL workspace alone is never proof (QC 2).
 *   4. FOREIGN company attributed task is 404 from every route, leaking
 *      neither filenames, links, status, nor child rows (QC 2).
 *   5. FOREIGN NULL-workspace task (ambiguous legacy shape) is 404 too.
 *   6. A foreign parent's children are unreachable through an in-scope
 *      id-collision attempt — parent gate closes the whole child set.
 *
 * Strategy mirrors wi15b-parent-task-id-ingest.test.ts: isolated temp DB,
 * WEBHOOK_SECRET set before project imports, COMPANY_SLUG pins the active
 * company, full migration chain, real route handlers.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHmac } from 'node:crypto';
import { NextRequest } from 'next/server';

const TMP_DB = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'bc-pres009-reads-')),
  'mission-control.test.db',
);
process.env.DATABASE_PATH = TMP_DB;

const WEBHOOK_SECRET = 'test-webhook-secret-pres009-reads';
process.env.WEBHOOK_SECRET = WEBHOOK_SECRET;
process.env.OWNER_NOTIFY_TELEGRAM_DISABLED = '1';
process.env.OPENCLAW_ROOT = '/nonexistent/openclaw-root-for-tests';
process.env.COMPANY_SLUG = 'company-a';

const RUN_ID = Math.random().toString(36).slice(2, 10);
const COMPANY_A_ID = `company-a-${RUN_ID}`;
const COMPANY_B_ID = `company-b-${RUN_ID}`;
const WS_A_SLUG = `pres-a-${RUN_ID}`;
const WS_B_SLUG = `pres-b-${RUN_ID}`;
const WS_A_ID = `ws-${WS_A_SLUG}`;
const WS_B_ID = `ws-${WS_B_SLUG}`;

type DbModule = typeof import('../../src/lib/db');
let run: DbModule['run'];
let queryOne: DbModule['queryOne'];
let closeDb: DbModule['closeDb'];

type IngestModule = typeof import('../../src/app/api/tasks/ingest/route');
let ingestPOST: IngestModule['POST'];

type PhasesModule = typeof import('../../src/app/api/presentations/[taskId]/phases/route');
let phasesGET: PhasesModule['GET'];

type DeliverablesModule = typeof import('../../src/app/api/presentations/[taskId]/deliverables/route');
let deliverablesGET: DeliverablesModule['GET'];

type ChildrenModule = typeof import('../../src/app/api/presentations/children/route');
let childrenGET: ChildrenModule['GET'];

function sign(rawBody: string): string {
  return createHmac('sha256', WEBHOOK_SECRET).update(rawBody).digest('hex');
}

function callIngest(payload: Record<string, unknown>): Promise<Response> {
  const rawBody = JSON.stringify(payload);
  const req = new NextRequest('http://localhost/api/tasks/ingest', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-webhook-signature': sign(rawBody) },
    body: rawBody,
  });
  return ingestPOST(req) as unknown as Promise<Response>;
}

async function callPhases(taskId: string): Promise<Response> {
  return phasesGET(new NextRequest(`http://localhost/api/presentations/${taskId}/phases`), {
    params: Promise.resolve({ taskId }),
  }) as unknown as Promise<Response>;
}

async function callDeliverables(taskId: string): Promise<Response> {
  return deliverablesGET(new NextRequest(`http://localhost/api/presentations/${taskId}/deliverables`), {
    params: Promise.resolve({ taskId }),
  }) as unknown as Promise<Response>;
}

function callChildren(parentId: string): Promise<Response> {
  return childrenGET(
    new NextRequest(`http://localhost/api/presentations/children?parent_id=${encodeURIComponent(parentId)}`),
  ) as unknown as Promise<Response>;
}

async function statusOf(p: Promise<Response>): Promise<number> {
  return (await p).status;
}

/** Directly stamp a durable task_request_keys identity (as ingest itself does). */
function stampRequestIdentity(taskId: string, companyId: string, operationId: string): void {
  run(
    `INSERT INTO task_request_keys (company_id, source, operation_id, payload_sha256, task_id, created_at)
     VALUES (?, 'pres009-test', ?, 'testfp', ?, ?)`,
    [companyId, operationId, taskId, new Date().toISOString()],
  );
}

function insertTask(id: string, workspaceId: string | null, status = 'in_progress'): void {
  const now = new Date().toISOString();
  run(
    `INSERT INTO tasks (id, title, status, priority, workspace_id, business_id, department, source, created_at, updated_at)
     VALUES (?, ?, ?, 'medium', ?, 'default', 'presentations', 'build_deck', ?, ?)`,
    [id, `Task ${id}`, status, workspaceId, now, now],
  );
}

test.before(async () => {
  const db = (await import('../../src/lib/db')) as DbModule;
  run = db.run;
  queryOne = db.queryOne;
  closeDb = db.closeDb;
  db.getDb();

  const now = new Date().toISOString();
  run(
    `INSERT OR IGNORE INTO companies (id, name, slug, config, created_at, updated_at)
     VALUES (?, 'Company A', 'company-a', '{}', ?, ?)`,
    [COMPANY_A_ID, now, now],
  );
  run(
    `INSERT OR IGNORE INTO companies (id, name, slug, config, created_at, updated_at)
     VALUES (?, 'Company B', 'company-b', '{}', ?, ?)`,
    [COMPANY_B_ID, now, now],
  );
  run(
    `INSERT OR IGNORE INTO workspaces (id, slug, name, icon, company_id, sort_order, created_at, updated_at)
     VALUES (?, ?, 'Presentations A', 'p', ?, 1, ?, ?)`,
    [WS_A_ID, WS_A_SLUG, COMPANY_A_ID, now, now],
  );
  run(
    `INSERT OR IGNORE INTO workspaces (id, slug, name, icon, company_id, sort_order, created_at, updated_at)
     VALUES (?, ?, 'Presentations B', 'p', ?, 1, ?, ?)`,
    [WS_B_ID, WS_B_SLUG, COMPANY_B_ID, now, now],
  );

  const ingestRoute = (await import('../../src/app/api/tasks/ingest/route')) as IngestModule;
  ingestPOST = ingestRoute.POST;
  const phasesRoute = (await import('../../src/app/api/presentations/[taskId]/phases/route')) as PhasesModule;
  phasesGET = phasesRoute.GET;
  const delivRoute = (await import('../../src/app/api/presentations/[taskId]/deliverables/route')) as DeliverablesModule;
  deliverablesGET = delivRoute.GET;
  const childrenRoute = (await import('../../src/app/api/presentations/children/route')) as ChildrenModule;
  childrenGET = childrenRoute.GET;
});

test.after(() => {
  try { if (typeof closeDb === 'function') closeDb(); } catch { /* best-effort */ }
  try { fs.rmSync(path.dirname(TMP_DB), { recursive: true, force: true }); } catch { /* best-effort */ }
});

// ── 1. Own attributed task reads from every route ────────────────────────────
test('own company task with attributed workspace reads from phases, deliverables, children', async () => {
  const ownId = `own-attributed-${RUN_ID}`;
  insertTask(ownId, WS_A_ID);

  assert.equal(await statusOf(callPhases(ownId)), 200, 'phases must read own attributed task');
  assert.equal(await statusOf(callDeliverables(ownId)), 200, 'deliverables must read own attributed task');
  assert.equal(await statusOf(callChildren(ownId)), 200, 'children must read own attributed parent');
});

// ── 2. Own NULL-workspace task WITH durable request identity reads ──────────
test('own NULL-workspace task WITH durable task_request_keys identity may be read', async () => {
  const ownKeyId = `own-keyed-${RUN_ID}`;
  insertTask(ownKeyId, null);
  stampRequestIdentity(ownKeyId, COMPANY_A_ID, `op-${ownKeyId}`);

  assert.equal(await statusOf(callPhases(ownKeyId)), 200, 'phases must honor durable request identity');
  assert.equal(await statusOf(callDeliverables(ownKeyId)), 200, 'deliverables must honor durable request identity');
  assert.equal(await statusOf(callChildren(ownKeyId)), 200, 'children must honor durable request identity');
});

// ── 3. Own NULL-workspace task WITHOUT any identity is NOT readable ─────────
test('own NULL-workspace task WITHOUT durable identity returns 404 from every route (never proof)', async () => {
  const ownNullId = `own-null-${RUN_ID}`;
  insertTask(ownNullId, null);

  for (const [name, call] of [
    ['phases', () => callPhases(ownNullId)],
    ['deliverables', () => callDeliverables(ownNullId)],
    ['children', () => callChildren(ownNullId)],
  ] as Array<[string, () => Promise<Response>]>) {
    const res = await call();
    const bodyText = await res.text();
    assert.equal(res.status, 404, `${name} must 404 a NULL-workspace task with no durable identity: ${bodyText}`);
  }
});

// ── 4. Foreign attributed task 404s and leaks nothing ───────────────────────
test('foreign company task returns 404 without leaking filenames, links or status', async () => {
  const foreignId = `foreign-attributed-${RUN_ID}`;
  insertTask(foreignId, WS_B_ID);
  // Foreign task carries a deliverable row with a juicy path + GHL link shape.
  run(
    `INSERT INTO task_deliverables (id, task_id, deliverable_type, title, path, mime_type, file_size_bytes, sha256, created_at)
     VALUES (?, ?, 'artifact', 'Secret Deck', '~/secrets/other-company/SECRET-FINAL.pptx', 'application/vnd.ms-powerpoint', 42, 'deadbeef', ?)`,
    [`del-${foreignId}`, foreignId, new Date().toISOString()],
  );
  // Foreign task carries an activity so a leaked status/phase would show.
  run(
    `INSERT INTO task_activities (id, task_id, activity_type, message, metadata, created_at)
     VALUES (?, ?, 'phase_completed', 'phase P4-COPY completed', '{"phase_id":"P4-COPY"}', ?)`,
    [`act-${foreignId}`, foreignId, new Date().toISOString()],
  );

  const res = await callDeliverables(foreignId);
  assert.equal(res.status, 404, 'deliverables must 404 a foreign task');
  const bodyText = await res.text();
  assert.ok(!bodyText.includes('SECRET-FINAL'), 'must never leak foreign filenames');
  assert.ok(!bodyText.includes('other-company'), 'must never leak foreign paths');
  assert.equal(await statusOf(callPhases(foreignId)), 404, 'phases must 404 a foreign task');
  assert.equal(await statusOf(callChildren(foreignId)), 404, 'children must 404 a foreign parent');
});

// ── 5. Ambiguous NULL-workspace foreign task is 404 ─────────────────────────
test('foreign/ambiguous NULL-workspace task returns not found from every route', async () => {
  const foreignNullId = `foreign-null-${RUN_ID}`;
  insertTask(foreignNullId, null);
  // A FOREIGN durable identity must not rescue it either.
  stampRequestIdentity(foreignNullId, COMPANY_B_ID, `op-${foreignNullId}`);

  for (const call of [() => callPhases(foreignNullId), () => callDeliverables(foreignNullId), () => callChildren(foreignNullId)]) {
    const res = await call();
    assert.equal(res.status, 404, 'a foreign-keyed task must be indistinguishable from nonexistent');
  }
});

// ── 6. In-scope id cannot reach a foreign parent's children ─────────────────
test('children of a foreign parent are unreachable; ingest into a foreign parent is refused', async () => {
  const foreignParentId = `foreign-parent-${RUN_ID}`;
  insertTask(foreignParentId, WS_B_ID);
  run(
    `INSERT INTO tasks (id, title, status, priority, workspace_id, parent_task_id, business_id, department, source, created_at, updated_at)
     VALUES (?, 'foreign child', 'backlog', 'medium', ?, ?, 'default', 'presentations', 'build_deck', ?, ?)`,
    [`foreign-child-${RUN_ID}`, WS_B_ID, foreignParentId, new Date().toISOString(), new Date().toISOString()],
  );

  // The children route (called as company A) 404s the foreign parent — its
  // child rows are never returned.
  const res = await callChildren(foreignParentId);
  assert.equal(res.status, 404, 'foreign parent must be 404 — children leak nothing');

  // And a company-A ingest cannot attach a new child to the foreign parent.
  const ingestRes = await callIngest({
    title: `Sneaky child [${RUN_ID}]`,
    department_slug: WS_A_SLUG,
    source: 'build_deck',
    parent_task_id: foreignParentId,
    idempotency_key: `pres009-sneaky-${RUN_ID}`,
  });
  assert.equal(ingestRes.status, 400, 'ingest must refuse a foreign parent_task_id');
  const attachCount = queryOne<{ n: number }>(
    'SELECT COUNT(*) as n FROM tasks WHERE parent_task_id = ?',
    [foreignParentId],
  );
  assert.equal(attachCount!.n, 1, 'no new child may attach to the foreign parent');
});

// ── 7. End-to-end: ingest creates an OWN keyed NULL-workspace task, reads work ─
test('ingest-stamped task_request_keys identity makes own task readable through all three routes', async () => {
  const ingestRes = await callIngest({
    title: `Keyed deck [${RUN_ID}]`,
    department_slug: WS_A_SLUG,
    source: 'build_deck',
    idempotency_key: `pres009-e2e-${RUN_ID}`,
  });
  const bodyText = await ingestRes.text();
  assert.equal(ingestRes.status, 201, `ingest must create: ${bodyText}`);
  const { task_id: createdId } = JSON.parse(bodyText) as { task_id: string };

  assert.equal(await statusOf(callPhases(createdId)), 200, 'phases reads ingest-created task');
  assert.equal(await statusOf(callDeliverables(createdId)), 200, 'deliverables reads ingest-created task');
  assert.equal(await statusOf(callChildren(createdId)), 200, 'children reads ingest-created parent');
});