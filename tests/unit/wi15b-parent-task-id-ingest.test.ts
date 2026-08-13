/**
 * WI-15b (D1 Option B — NESTED subtasks) — /api/tasks/ingest parent_task_id
 * write path, end-to-end.
 *
 * Before this fix, /api/presentations/children SELECTed
 * `FROM tasks WHERE parent_task_id = ?` but NOTHING in the codebase ever
 * wrote parent_task_id — createTaskCore's INSERT never included the column
 * and the ingest route never parsed it — so the children query was
 * permanently empty. This drives the REAL signed POST handler (exactly as
 * ingest-requester-stamp.test.ts does) to prove:
 *
 *   A. A child ingested with a valid, SAME-COMPANY parent_task_id persists
 *      the column and is returned by the /api/presentations/children query
 *      (both the raw SQL the route runs AND the real route handler).
 *   B. A child ingested with a parent_task_id belonging to a DIFFERENT
 *      company is REJECTED (400) — the write never happens.
 *   C. A child ingested with a parent_task_id that does not exist at all is
 *      REJECTED (400) the same way (never distinguishes "exists but not
 *      yours" from "doesn't exist").
 *   D. No parent_task_id at all → unaffected, byte-identical legacy behavior
 *      (column stays NULL).
 *
 * Strategy mirrors ingest-requester-stamp.test.ts: isolated temp DB + signed
 * WEBHOOK_SECRET set BEFORE `@/lib/db` / the route modules load; full
 * migration chain; COMPANY_SLUG pins the box's "active company" deterministically
 * so the cross-company scope check (resolveActiveCompanyId + boardWhereClause,
 * the SAME convention /api/presentations/children itself uses) is exercised for
 * real, not just described.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHmac } from 'node:crypto';
import { NextRequest } from 'next/server';

// ── Isolated DB + auth secret + pinned active company (BEFORE any project import) ──
const TMP_DB = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'bc-wi15b-parent-')),
  'mission-control.test.db',
);
process.env.DATABASE_PATH = TMP_DB;

const WEBHOOK_SECRET = 'test-webhook-secret-wi15b-parent';
process.env.WEBHOOK_SECRET = WEBHOOK_SECRET;
process.env.OWNER_NOTIFY_TELEGRAM_DISABLED = '1';
process.env.OPENCLAW_ROOT = '/nonexistent/openclaw-root-for-tests';
// Pin the "active company" deterministically (resolveSeedingCompanyId honours
// COMPANY_SLUG as an explicit operator override, checked first). This makes
// the cross-company rejection test (case B) deterministic regardless of row
// insertion order.
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

type RouteModule = typeof import('../../src/app/api/tasks/ingest/route');
let POST: RouteModule['POST'];

type ChildrenRouteModule = typeof import('../../src/app/api/presentations/children/route');
let childrenGET: ChildrenRouteModule['GET'];

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Correct HMAC-SHA256 hex signature over the exact raw body bytes. */
function sign(rawBody: string): string {
  return createHmac('sha256', WEBHOOK_SECRET).update(rawBody).digest('hex');
}

/** POST a signed ingest payload through the real handler. */
function callIngest(payload: Record<string, unknown>): Promise<Response> {
  const rawBody = JSON.stringify(payload);
  const req = new NextRequest('http://localhost/api/tasks/ingest', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-webhook-signature': sign(rawBody),
    },
    body: rawBody,
  });
  return POST(req) as unknown as Promise<Response>;
}

/** Call the real /api/presentations/children handler. */
function callChildren(parentId: string): Promise<Response> {
  const req = new NextRequest(
    `http://localhost/api/presentations/children?parent_id=${encodeURIComponent(parentId)}`,
  );
  return childrenGET(req) as unknown as Promise<Response>;
}

function insertParentTask(id: string, workspaceId: string, title: string): void {
  const now = new Date().toISOString();
  run(
    `INSERT INTO tasks (id, title, status, priority, workspace_id, business_id, department, source, created_at, updated_at)
     VALUES (?, ?, 'in_progress', 'medium', ?, 'default', 'presentations', 'build_deck', ?, ?)`,
    [id, title, workspaceId, now, now],
  );
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

test.before(async () => {
  const db = (await import('../../src/lib/db')) as DbModule;
  run = db.run;
  queryOne = db.queryOne;
  closeDb = db.closeDb;
  db.getDb(); // runs the full migration chain (incl. migration 124: parent_task_id)

  const now = new Date().toISOString();

  // Two REAL (non-placeholder) companies — 'company-a' / 'company-b' slugs
  // clear isPlaceholderCompany()'s default/command-center/acme- exclusions.
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

  // WS_A belongs to company A (the active/in-scope company per COMPANY_SLUG
  // above). WS_B belongs to company B (out of scope).
  run(
    `INSERT OR IGNORE INTO workspaces (id, slug, name, icon, company_id, sort_order, created_at, updated_at)
     VALUES (?, ?, 'Presentations A', '🖼️', ?, 1, ?, ?)`,
    [WS_A_ID, WS_A_SLUG, COMPANY_A_ID, now, now],
  );
  run(
    `INSERT OR IGNORE INTO workspaces (id, slug, name, icon, company_id, sort_order, created_at, updated_at)
     VALUES (?, ?, 'Presentations B', '🖼️', ?, 1, ?, ?)`,
    [WS_B_ID, WS_B_SLUG, COMPANY_B_ID, now, now],
  );

  const route = (await import('../../src/app/api/tasks/ingest/route')) as RouteModule;
  POST = route.POST;
  const childrenRoute = (await import('../../src/app/api/presentations/children/route')) as ChildrenRouteModule;
  childrenGET = childrenRoute.GET;
});

test.after(() => {
  try {
    if (typeof closeDb === 'function') closeDb();
  } catch {
    /* best-effort */
  }
  try {
    fs.rmSync(path.dirname(TMP_DB), { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

// ── A. Valid same-company parent_task_id → persisted + returned by children query ──
test('ingest with a valid same-company parent_task_id persists the column and is returned by /api/presentations/children', async () => {
  const parentId = `parent-in-scope-${RUN_ID}`;
  insertParentTask(parentId, WS_A_ID, `Deck run A [${RUN_ID}]`);

  const res = await callIngest({
    title: `Research [${RUN_ID}]`,
    department_slug: WS_A_SLUG,
    source: 'build_deck',
    parent_task_id: parentId,
    idempotency_key: `wi15b-a-${RUN_ID}`,
  });
  const bodyText = await res.text();
  assert.equal(res.status, 201, `expected 201, got ${res.status}: ${bodyText}`);
  const body = JSON.parse(bodyText) as { task_id: string };

  // 1. Raw column assertion — the actual bug: nothing wrote parent_task_id before.
  const row = queryOne<{ parent_task_id: string | null }>(
    'SELECT parent_task_id FROM tasks WHERE id = ?',
    [body.task_id],
  );
  assert.ok(row, 'created child task must exist');
  assert.equal(row!.parent_task_id, parentId, 'parent_task_id column must persist verbatim');

  // 2. The EXACT query /api/presentations/children runs must return it.
  const directChildren = queryOne<{ n: number }>(
    'SELECT COUNT(*) as n FROM tasks WHERE parent_task_id = ?',
    [parentId],
  );
  assert.equal(directChildren!.n, 1, 'the children route\'s own WHERE parent_task_id = ? query must find exactly 1 row');

  // 3. The REAL children route handler must return it too (end-to-end, not
  //    just the SQL in isolation).
  const childrenRes = await callChildren(parentId);
  assert.equal(childrenRes.status, 200, 'children route must return 200 for an in-scope parent');
  const childrenBody = (await childrenRes.json()) as {
    parent: { id: string };
    children: Array<{ id: string; title: string }>;
  };
  assert.equal(childrenBody.parent.id, parentId);
  assert.equal(childrenBody.children.length, 1, 'children route must return exactly the 1 child just created');
  assert.equal(childrenBody.children[0].id, body.task_id);
});

// ── B. Cross-company parent_task_id → REJECTED, nothing written ──────────────
test('ingest with a parent_task_id belonging to a DIFFERENT company is rejected (400) and writes nothing', async () => {
  const foreignParentId = `parent-out-of-scope-${RUN_ID}`;
  insertParentTask(foreignParentId, WS_B_ID, `Deck run B (foreign company) [${RUN_ID}]`);

  const res = await callIngest({
    title: `Outline [${RUN_ID}]`,
    department_slug: WS_A_SLUG, // caller is operating in company A's scope
    source: 'build_deck',
    parent_task_id: foreignParentId, // but the named parent belongs to company B
    idempotency_key: `wi15b-b-${RUN_ID}`,
  });
  const bodyText = await res.text();
  assert.equal(res.status, 400, `expected 400 for a cross-company parent, got ${res.status}: ${bodyText}`);
  const body = JSON.parse(bodyText) as { detail?: string };
  assert.equal(body.detail, 'parent_not_found_or_out_of_scope');

  // No task must have been created attached to the foreign parent.
  const attached = queryOne<{ n: number }>(
    'SELECT COUNT(*) as n FROM tasks WHERE parent_task_id = ?',
    [foreignParentId],
  );
  assert.equal(attached!.n, 0, 'a cross-company parent must never gain a child row');

  // The children route (called AS company A, since COMPANY_SLUG pins scope)
  // must 404 the foreign parent too — same "not found" treatment.
  const childrenRes = await callChildren(foreignParentId);
  assert.equal(childrenRes.status, 404, 'the foreign parent must be 404 from the company-A-scoped children route');
});

// ── C. Nonexistent parent_task_id → REJECTED the same way ────────────────────
test('ingest with a parent_task_id that does not exist at all is rejected (400)', async () => {
  const res = await callIngest({
    title: `Draft [${RUN_ID}]`,
    department_slug: WS_A_SLUG,
    source: 'build_deck',
    parent_task_id: `does-not-exist-${RUN_ID}`,
    idempotency_key: `wi15b-c-${RUN_ID}`,
  });
  assert.equal(res.status, 400);
  const body = (await res.json()) as { detail?: string };
  assert.equal(body.detail, 'parent_not_found_or_out_of_scope');
});

// ── D. No parent_task_id at all → legacy behavior unaffected (column NULL) ───
test('ingest with NO parent_task_id leaves the column NULL (legacy behavior byte-identical)', async () => {
  const res = await callIngest({
    title: `Standalone task [${RUN_ID}]`,
    department_slug: WS_A_SLUG,
    source: 'ingest',
    idempotency_key: `wi15b-d-${RUN_ID}`,
  });
  assert.equal(res.status, 201);
  const body = (await res.json()) as { task_id: string };
  const row = queryOne<{ parent_task_id: string | null }>(
    'SELECT parent_task_id FROM tasks WHERE id = ?',
    [body.task_id],
  );
  assert.equal(row!.parent_task_id, null);
});
