/**
 * THE STARTER CARD IS A PLACEHOLDER, NOT WORK.
 *
 * `POST /api/departments` (CREATE mode, the allow_unwired JS-only path this
 * repo owns) seeds a "Welcome to <department>" card. It carries a head agent
 * and sits in `backlog`, which made it indistinguishable from real work to
 * every dispatch path. Measured on a client box: a department re-sync dropped
 * 10 of them, each parked at the triad gate for want of a matching SOP, and
 * five spawned a dead "Author SOP: Welcome to <dept>" sub-task.
 *
 * Two properties are pinned here:
 *
 *   1. THE CARD IS BORN HELD. `dispatch_hold = 1` on the row.
 *      `reserveExecution()` (src/lib/execution-attempts.ts) is the single
 *      chokepoint that mints an execution and it refuses outright on
 *      `dispatch_hold`, so one column stops both halves — never auto-dispatched,
 *      and therefore never SOP-authored (the fast loop fires at DISPATCH time,
 *      src/lib/sop-authoring.ts). `intake-advance-sweep` honors it too.
 *
 *   2. A RE-SYNC SEEDS NOTHING. Re-creating a department that already has a
 *      workspace row returns `already_exists` and adds no second card — under
 *      the exact slug AND under the `dept-`-prefixed spelling a Skill-23
 *      manifest re-sync uses, which canonicalizes onto the same department.
 *      This is the property the 10 dropped cards violated; it has never had a
 *      test, so nothing would have caught its removal.
 *
 * Drives the REAL POST handler against an isolated temp DB, with HOME pinned to
 * a nonexistent path so the host add-department.sh lookup deterministically
 * misses and the JS-only path under test runs every time — the same technique
 * tests/unit/departments-requester-stamp.test.ts uses.
 */

// C8 — must stay the FIRST import: isolates DATABASE_PATH *and*
// CC_TEST_FIXTURE_ROOT before any module that reaches '@/lib/db' is evaluated,
// so the boot reseed this route triggers can never read the operator's real
// departments.json. See tests/unit/c8-db-isolation-guard.test.ts.
import './_isolated-db';

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NextRequest } from 'next/server';

// ── Isolated DB (set BEFORE @/lib/db / the route module are imported) ───────
const TMP_DB = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'bc-starter-hold-')),
  'mission-control.test.db',
);
process.env.DATABASE_PATH = TMP_DB;

const RUN_ID = Math.random().toString(36).slice(2, 10);
const REAL_HOME = process.env.HOME;
const NONEXISTENT_HOME = path.join(os.tmpdir(), `bc-starter-hold-nohome-${RUN_ID}`);

type DbModule = typeof import('../../src/lib/db');
let run: DbModule['run'];
let queryAll: DbModule['queryAll'];
let closeDb: DbModule['closeDb'];

type RouteModule = typeof import('../../src/app/api/departments/route');
let POST: RouteModule['POST'];

async function callCreateDept(payload: Record<string, unknown>): Promise<Response> {
  process.env.HOME = NONEXISTENT_HOME;
  try {
    const req = new NextRequest('http://localhost/api/departments', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ create: true, allow_unwired: true, ...payload }),
    });
    return (await POST(req)) as unknown as Response;
  } finally {
    process.env.HOME = REAL_HOME;
  }
}

function starterCards(workspaceId: string): { id: string; title: string; status: string; dispatch_hold: number }[] {
  return queryAll<{ id: string; title: string; status: string; dispatch_hold: number }>(
    `SELECT id, title, status, dispatch_hold FROM tasks WHERE workspace_id = ? ORDER BY id`,
    [workspaceId],
  );
}

test.before(async () => {
  const db = (await import('../../src/lib/db')) as DbModule;
  run = db.run;
  queryAll = db.queryAll;
  closeDb = db.closeDb;
  db.getDb(); // full migration chain against the temp DB

  const now = new Date().toISOString();
  run(
    `INSERT OR IGNORE INTO companies (id, name, slug, config, created_at, updated_at)
     VALUES ('default', 'Default', 'default', '{}', ?, ?)`,
    [now, now],
  );

  const route = (await import('../../src/app/api/departments/route')) as RouteModule;
  POST = route.POST;
});

test.after(() => {
  process.env.HOME = REAL_HOME;
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

// ── 1. the card is born held ────────────────────────────────────────────────

test('REGRESSION: the starter card is created with dispatch_hold = 1', async () => {
  const slug = `growth-hold-${RUN_ID}`;
  const res = await callCreateDept({ name: `Growth Hold ${RUN_ID}`, slug });
  const bodyText = await res.clone().text();
  assert.equal(res.status, 201, `expected 201, got ${res.status}. Body: ${bodyText}`);
  const body = (await res.json()) as { department: { status: string; workspace_id: string } };
  assert.equal(body.department.status, 'created');

  const cards = starterCards(body.department.workspace_id);
  assert.equal(cards.length, 1, 'exactly one starter card');
  assert.equal(cards[0].title, `Welcome to Growth Hold ${RUN_ID}`);
  assert.equal(cards[0].dispatch_hold, 1, 'the starter card must never be auto-dispatchable');
  assert.equal(cards[0].status, 'backlog', 'it still sits on the board, visible and editable');
});

// ── 2. a re-sync seeds nothing ──────────────────────────────────────────────

test('REGRESSION: re-creating the SAME department seeds no second starter card', async () => {
  const slug = `resync-same-${RUN_ID}`;
  const first = await callCreateDept({ name: `Resync Same ${RUN_ID}`, slug });
  assert.equal(first.status, 201);
  const firstBody = (await first.json()) as { department: { status: string; workspace_id: string } };
  assert.equal(firstBody.department.status, 'created');
  const wsId = firstBody.department.workspace_id;
  assert.equal(starterCards(wsId).length, 1);

  const second = await callCreateDept({ name: `Resync Same ${RUN_ID}`, slug });
  assert.equal(second.status, 201);
  const secondBody = (await second.json()) as { department: { status: string; workspace_id: string } };
  assert.equal(secondBody.department.status, 'already_exists', 'a re-sync must not re-provision');
  assert.equal(secondBody.department.workspace_id, wsId, 'and must resolve to the same workspace');

  assert.equal(starterCards(wsId).length, 1, 'still exactly one card — a re-sync drops none');
});

test('REGRESSION: the `dept-`-prefixed re-sync spelling seeds no second starter card', async () => {
  // A Skill-23 manifest re-sync POSTs `dept-<slug>`; it canonicalizes onto the
  // department the bare slug already owns, so it must be recognised as present.
  const bare = `resync-prefix-${RUN_ID}`;
  const first = await callCreateDept({ name: `Resync Prefix ${RUN_ID}`, slug: bare });
  assert.equal(first.status, 201);
  const firstBody = (await first.json()) as { department: { status: string; workspace_id: string } };
  const wsId = firstBody.department.workspace_id;
  assert.equal(starterCards(wsId).length, 1);

  const second = await callCreateDept({ name: `Resync Prefix ${RUN_ID}`, slug: `dept-${bare}` });
  assert.equal(second.status, 201);
  const secondBody = (await second.json()) as { department: { status: string; workspace_id: string } };
  assert.equal(secondBody.department.status, 'already_exists');
  assert.equal(secondBody.department.workspace_id, wsId);

  assert.equal(starterCards(wsId).length, 1, 'no card under the bare slug');
  assert.equal(
    starterCards(`dept-${bare}`).length,
    0,
    'and no second workspace minted under the prefixed id',
  );
});
