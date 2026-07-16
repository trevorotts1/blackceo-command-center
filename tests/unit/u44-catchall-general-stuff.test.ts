/**
 * U44 (master spec v2 C-13 / D-C2) — catch-all conformance fixture proof.
 *
 * BINARY acceptance (spec section C+I.2, C-13, line 1190):
 *   (b) a signed ingest carrying `department_slug:'funnels'` (no funnels
 *       department exists) lands in the catch-all tagged
 *       `resolvedBy: 'unrecognized-slug->general'`, and renders under the
 *       catch-all on the board.
 *
 * D-C2 (line 1212-1217) sets the client-facing display name to "General
 * Stuff" while freezing the slug at `general-task`. "Renders under the
 * catch-all" is proven here as: (1) the task's `department` column and
 * `workspace_id` both resolve to the general-task workspace, driving
 * MissionQueue's real per-card department chip lookup
 * (`departmentNames['general-task']`, MissionQueue.tsx:155 + :1055), and
 * (2) the workspace DISPLAY NAME a client actually sees is "General Stuff",
 * not "General Task" — proven two ways: (a) the config default
 * (departments.config.ts) and (b) migration 106's idempotent rename of an
 * ALREADY-PROVISIONED box's `workspaces.name` row (the scope this fixture
 * seeds: a pre-existing box that has general-task from before this unit
 * landed, exactly what migration 059's own comment concedes may already
 * exist — "row may not exist yet on a fresh install" implies it DOES exist
 * on upgraded installs).
 *
 * FAIL-THEN-PASS (git-anchored): every assertion in this file that reads a
 * workspace/department DISPLAY NAME asserts "General Stuff". Against the
 * unmodified parent commit (d2f3ac124179c75c34139dfb3d8241dea7ea195e) this
 * fails: departments.config.ts:867 still says 'General Task', no migration
 * 106 exists to rename an already-provisioned row, and
 * MissionQueue.tsx:155's chip map still says 'General Task'. All three go
 * green only after this unit's source changes land.
 *
 * Real production code exercised (never reimplemented):
 *   - POST /api/tasks/ingest (src/app/api/tasks/ingest/route.ts) — the real
 *     signed HTTP handler, mirroring tests/unit/ingest-requester-stamp.test.ts.
 *   - The full migration chain via getDb() (src/lib/db/migrations.ts),
 *     including the new migration 106.
 *   - DEFAULT_DEPARTMENTS (src/lib/routing/departments.config.ts).
 *   - departmentNames (src/components/MissionQueue.tsx) — the exact map the
 *     board reads at :510 (column header) and :1055 (card chip).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHmac } from 'node:crypto';
import { NextRequest } from 'next/server';
import Database from 'better-sqlite3';
import { schema } from '../../src/lib/db/schema';
import { runMigrations } from '../../src/lib/db/migrations';

// ── Isolated DB + auth secret (set BEFORE @/lib/db / route are imported) ──────
const TMP_DB = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'bc-u44-catchall-')),
  'mission-control.test.db',
);
process.env.DATABASE_PATH = TMP_DB;

const WEBHOOK_SECRET = 'test-webhook-secret-u44-catchall';
process.env.WEBHOOK_SECRET = WEBHOOK_SECRET;
process.env.OWNER_NOTIFY_TELEGRAM_DISABLED = '1';
process.env.OPENCLAW_ROOT = '/nonexistent/openclaw-root-for-tests';

const RUN_ID = Math.random().toString(36).slice(2, 10);
const GENERAL_WS_ID = `ws-general-${RUN_ID}`;

type DbModule = typeof import('../../src/lib/db');
let run: DbModule['run'];
let queryOne: DbModule['queryOne'];
let closeDb: DbModule['closeDb'];
let getDb: DbModule['getDb'];

type RouteModule = typeof import('../../src/app/api/tasks/ingest/route');
let POST: RouteModule['POST'];

function sign(rawBody: string): string {
  return createHmac('sha256', WEBHOOK_SECRET).update(rawBody).digest('hex');
}

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

test.before(async () => {
  // ── Simulate an ALREADY-PROVISIONED box upgrading through the full
  // migration chain for the FIRST time this unit's migration 106 exists. ──
  //
  // The module's getDb() memoizes its DB handle for the life of the process
  // (`if (db) return db;`), so a second in-process getDb() call is a pure
  // no-op — it can never be used to "re-run migrations against newly-seeded
  // data". To seed a pre-existing general-task row that migration 106
  // actually sees on ITS one and only run, we open our own raw handle,
  // apply the base schema, insert the STALE pre-D-C2 row, then drive the
  // real runMigrations() (the exact function getDb() calls) directly —
  // BEFORE the module's own getDb() is ever invoked in this process.
  const now = new Date().toISOString();
  const seedDb = new Database(TMP_DB);
  seedDb.exec(schema);
  seedDb
    .prepare(
      `INSERT INTO companies (id, name, slug, config, created_at, updated_at)
       VALUES ('default', 'Default', 'default', '{}', ?, ?)`,
    )
    .run(now, now);
  // Pre-existing general-task workspace with the STALE pre-D-C2 display name
  // "General Task" — exactly what an upgraded fleet box looks like the
  // moment before this unit's migration 106 first runs on it.
  seedDb
    .prepare(
      `INSERT INTO workspaces (id, slug, name, icon, company_id, sort_order, created_at, updated_at)
       VALUES (?, 'general-task', 'General Task', '📋', 'default', 99, ?, ?)`,
    )
    .run(GENERAL_WS_ID, now, now);
  runMigrations(seedDb); // the FULL chain 001..HEAD, including migration 106, against the pre-seeded row.
  seedDb.close();

  // Now bring up the module's own DB layer against the SAME (already fully
  // migrated) file. getDb() re-execs the schema (idempotent CREATE TABLE IF
  // NOT EXISTS) and re-invokes runMigrations(), which sees every migration
  // already recorded in `_migrations` and applies nothing further.
  const db = (await import('../../src/lib/db')) as DbModule;
  run = db.run;
  queryOne = db.queryOne;
  closeDb = db.closeDb;
  getDb = db.getDb;
  getDb();

  const route = (await import('../../src/app/api/tasks/ingest/route')) as RouteModule;
  POST = route.POST;
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

// ── (a)-adjacent: migration 106 renames an ALREADY-PROVISIONED box's row ──────
test('migration 106 renamed the already-provisioned general-task workspace row to "General Stuff"', () => {
  const ws = queryOne<{ name: string; slug: string }>(
    'SELECT name, slug FROM workspaces WHERE id = ?',
    [GENERAL_WS_ID],
  );
  assert.ok(ws, 'seeded general-task workspace row must still exist');
  assert.equal(ws!.slug, 'general-task', 'slug stays FROZEN per D-C2 — routing must never key on display name');
  assert.equal(
    ws!.name,
    'General Stuff',
    'an already-provisioned box\'s general-task workspace name must be renamed to "General Stuff" by migration 106',
  );
});

// ── (b) — the funnels-ingest fixture: resolvedBy + board rendering ────────────
test('signed ingest with department_slug:"funnels" (no funnels dept) resolves unrecognized-slug->general and renders under General Stuff', async () => {
  const res = await callIngest({
    title: `Funnel build task [${RUN_ID}]`,
    department_slug: 'funnels',
    source: 'skill6',
    idempotency_key: `funnels-fixture-${RUN_ID}`,
  });

  assert.equal(res.status, 201, 'a fresh signed ingest must return 201');
  const body = (await res.json()) as { task_id: string; resolved_by: string; workspace_id: string };

  assert.equal(
    body.resolved_by,
    'unrecognized-slug->general',
    'INGEST-06: an explicit-but-unrecognized department_slug must resolve to the honest catch-all tag',
  );
  assert.equal(body.workspace_id, GENERAL_WS_ID, 'the card must land in the general-task workspace');

  // "Renders under the catch-all on the board": the persisted task row is
  // what MissionQueue.tsx reads for both the department chip (:1055,
  // `departmentNames[task.department.toLowerCase()]`) and workspace scoping.
  const task = queryOne<{ department: string | null; workspace_id: string }>(
    'SELECT department, workspace_id FROM tasks WHERE id = ?',
    [body.task_id],
  );
  assert.ok(task, 'created task row must be retrievable');
  assert.equal(task!.department, 'general-task', 'task.department must be the catch-all slug');
  assert.equal(task!.workspace_id, GENERAL_WS_ID, 'task.workspace_id must be the (renamed) general-task workspace');

  // The DISPLAY NAME the client actually sees for that workspace.
  const ws = queryOne<{ name: string }>('SELECT name FROM workspaces WHERE id = ?', [task!.workspace_id]);
  assert.equal(ws!.name, 'General Stuff', 'the board-visible workspace name must be "General Stuff" per D-C2');
});

// ── D-C2 name-fallback addition: INGEST-06 must resolve by NAME alone when
// the slug fallbacks miss (belt-and-braces defense named explicitly by D-C2's
// "cons" line — this is the ONE scenario where it is not redundant with the
// frozen-slug fast path: a workspace whose slug drifted from 'general-task'
// but whose DISPLAY NAME is still "General Stuff") ───────────────────────────
test('INGEST-06 name-only fallback: an unrecognized department_slug resolves via "general stuff" name match when no recognized slug exists', async () => {
  // Retire the recognized-slug catch-all row out of THIS test's matcher path
  // (UPDATE not DELETE — an earlier test's task row FK-references it) so the
  // only row left able to satisfy either WHERE clause must be reached by
  // NAME, not slug. No later test in this file depends on GENERAL_WS_ID's
  // slug/name — the remaining suites read DEFAULT_DEPARTMENTS/MissionQueue
  // directly, not the DB.
  run(`UPDATE workspaces SET slug = 'retired-for-test', name = 'Retired For Test' WHERE id = ?`, [GENERAL_WS_ID]);

  const DRIFTED_WS_ID = `ws-drifted-general-${RUN_ID}`;
  const now = new Date().toISOString();
  run(
    `INSERT INTO workspaces (id, slug, name, icon, company_id, sort_order, created_at, updated_at)
     VALUES (?, 'legacy-catchall-slug', 'General Stuff', '📋', 'default', 98, ?, ?)`,
    [DRIFTED_WS_ID, now, now],
  );

  const res = await callIngest({
    title: `Drifted-slug catch-all fixture [${RUN_ID}]`,
    department_slug: 'not-a-real-department',
    source: 'skill6',
    idempotency_key: `drifted-fixture-${RUN_ID}`,
  });

  assert.equal(res.status, 201);
  const body = (await res.json()) as { resolved_by: string; workspace_id: string };
  assert.equal(body.resolved_by, 'unrecognized-slug->general');
  assert.equal(
    body.workspace_id,
    DRIFTED_WS_ID,
    'with no recognized slug present, the INGEST-06 fallback must still find the catch-all by its ' +
      '"general stuff" display name (ingest/route.ts:275) rather than leaving the task unrouted',
  );
});

// ── D-C2 config default: fresh installs seed the display name correctly ───────
test('DEFAULT_DEPARTMENTS config default for the catch-all is "General Stuff" (fresh-install seed)', async () => {
  const { DEFAULT_DEPARTMENTS } = await import('../../src/lib/routing/departments.config');
  const catchAll = DEFAULT_DEPARTMENTS.find((d) => d.id === 'general-task');
  assert.ok(catchAll, 'general-task must exist in DEFAULT_DEPARTMENTS');
  assert.equal(catchAll!.name, 'General Stuff', 'D-C2: the catch-all default display name must be "General Stuff"');
});

// ── MissionQueue's real board chip/header map (the thing a client sees) ───────
test('MissionQueue departmentNames["general-task"] renders "General Stuff" (board header + card chip)', async () => {
  const mod = await import('../../src/components/MissionQueue');
  const names = (mod as unknown as { departmentNames: Record<string, string> }).departmentNames;
  assert.ok(names, 'MissionQueue must export departmentNames for this to be a real, non-reimplemented guard');
  assert.equal(
    names['general-task'],
    'General Stuff',
    'MissionQueue.tsx:155 drives BOTH the board header (:510) and every card chip (:1055) — ' +
      'a DB-only rename without this edit produces a split-brain display (D-C2\'s own failure mode)',
  );
});
