import './_isolated-db'; // MUST be first — throwaway DB, never the live board.

import test from 'node:test';
import assert from 'node:assert/strict';
import { NextRequest } from 'next/server';
import Database from 'better-sqlite3';

import { GET, POST } from '../../src/app/api/da-challenges/route';
import { getDb } from '../../src/lib/db';
import { migrations } from '../../src/lib/db/migrations';

/**
 * Apply ONLY migration 024 to a fixture database. Running the whole array
 * against a bare fixture is not viable — later migrations reference tables an
 * isolated fixture has no reason to carry ("no such table: tasks") — and
 * running it against the real DB would prove nothing about the pre-024 shapes,
 * because the real DB is already reconciled by the time a test sees it.
 */
function apply024(db: Database.Database): void {
  const m = migrations.find((x) => x.id === '024');
  assert.ok(m, 'migration 024 must exist');
  assert.equal(m!.name, 'reconcile_da_challenges_shape');
  db.transaction(() => m!.up(db))();
}

/**
 * U59 [JM/U55] — Devil's Advocate write path + shape reconciliation.
 * Decision D15 (D-J1): content is client-visible; the PRD status lifecycle
 * (pending/approved/rejected/escalated) is canonical.
 *
 * These tests pin the two defects this branch closes:
 *   1. POST /api/da-challenges did not exist (GET-only), so the shipped
 *      onboarding-side bridge posted into a handler that was not there.
 *   2. The GET handler seeded demo rows naming columns no migration creates
 *      (department_id / challenge_text / response_text / response_deadline),
 *      which raised "no such column: department_id" on every canonically
 *      migrated box and was caught into an HTTP 500.
 */

function postReq(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/da-challenges', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** The exact wire payload shared-utils/devils-advocate-bridge.py emits. */
function wirePayload(over: Record<string, unknown> = {}) {
  return {
    trigger_type: 'critical_task',
    department: 'marketing',
    challenge: 'Ad spend is up 20% while leads grew 8% — is the spend justified?',
    specific_concern: 'Attribution window may be masking paid cannibalisation of organic.',
    assumptions: 'Assumes the 3 new ad formats are reaching a net-new audience.',
    severity: 'high',
    confidence: 0.72,
    raw_response: 'FULL UNPARSED MODEL RESPONSE ...',
    ...over,
  };
}

test('[U59] migration 024 reconciles the table: department_id + raw_response exist, PRD status CHECK is live', () => {
  const db = getDb();
  const cols = (db.prepare('PRAGMA table_info(da_challenges)').all() as { name: string }[]).map(
    (c) => c.name,
  );
  for (const c of ['department_id', 'raw_response', 'task_id', 'trigger_type', 'challenge']) {
    assert.ok(cols.includes(c), `reconciled table must carry ${c}; got ${cols.join(',')}`);
  }

  const ddl = (
    db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='da_challenges'`).get() as
      | { sql: string }
      | undefined
  )?.sql;
  assert.ok(ddl, 'da_challenges must exist');
  // The PRD lifecycle is the canonical enum (D15 (ii)).
  for (const s of ['pending', 'approved', 'rejected', 'escalated']) {
    assert.ok(ddl!.includes(`'${s}'`), `status CHECK must allow '${s}'`);
  }
  // The superseded vocabularies must be gone from the constraint.
  for (const s of ['accepted', 'dismissed', 'overridden', 'responded']) {
    assert.ok(!ddl!.includes(`'${s}'`), `status CHECK must no longer allow '${s}'`);
  }
});

test('[U59] migration 024 replays the indexes its own rebuild drops', () => {
  const db = getDb();
  const idx = (
    db
      .prepare(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='da_challenges'`)
      .all() as { name: string }[]
  ).map((i) => i.name);
  for (const want of ['idx_da_task', 'idx_da_status', 'idx_da_severity', 'idx_da_department']) {
    assert.ok(idx.includes(want), `rebuild must replay ${want}; got ${idx.join(',') || '(none)'}`);
  }
});

test('[U59] GET no longer fabricates demo rows into a client-facing feed (U55b purge)', async () => {
  const res = await GET();
  assert.equal(res.status, 200, 'GET must be 200, not the 500 the demo-seed produced');
  const body = await res.json();
  assert.deepEqual(body.challenges, [], 'an empty table must render as an empty feed, not demo data');

  const db = getDb();
  const n = (db.prepare('SELECT COUNT(*) AS n FROM da_challenges').get() as { n: number }).n;
  assert.equal(n, 0, 'GET must never write rows');
});

test('[U59] ROUND TRIP: bridge wire payload -> POST -> row lands -> GET returns it', async () => {
  const res = await POST(postReq(wirePayload({ task_id: 't-round-trip' })));
  assert.equal(res.status, 201, `POST must create; got ${res.status}`);

  const created = (await res.json()).challenge;
  assert.ok(created?.id, 'POST must return the created row');
  assert.equal(created.trigger_type, 'critical_task');
  assert.equal(created.challenge, wirePayload().challenge);
  assert.equal(created.specific_concern, wirePayload().specific_concern);
  assert.equal(created.assumptions, wirePayload().assumptions);
  assert.equal(created.severity, 'high');
  assert.equal(created.confidence, 0.72);
  assert.equal(created.raw_response, 'FULL UNPARSED MODEL RESPONSE ...');
  assert.equal(created.task_id, 't-round-trip');
  assert.equal(created.status, 'pending', 'a new challenge enters the PRD lifecycle as pending');

  // The row is really in the table, not just echoed back.
  const db = getDb();
  const row = db
    .prepare('SELECT * FROM da_challenges WHERE id = ?')
    .get(created.id) as Record<string, unknown>;
  assert.ok(row, 'row must be persisted');
  assert.equal(row.challenge, wirePayload().challenge);

  // ...and the feed's own endpoint returns it.
  const feed = await GET();
  assert.equal(feed.status, 200);
  const listed = (await feed.json()).challenges;
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, created.id);
  assert.equal(listed[0].challenge, wirePayload().challenge);
});

test('[U59] POST keeps an unresolvable department identifier rather than dropping it', async () => {
  const res = await POST(
    postReq(wirePayload({ department: 'no-such-department-slug', task_id: 'keep-dept' })),
  );
  assert.equal(res.status, 201);
  const created = (await res.json()).challenge;
  assert.equal(
    created.department_id,
    'no-such-department-slug',
    'an unresolved department must be preserved verbatim, never nulled',
  );
});

test('[U59] POST rejects a payload missing the contract’s required fields', async () => {
  const res = await POST(postReq({ department: 'marketing' })); // no trigger_type, no challenge
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.error, 'Validation failed');
});

test('[U59] POST rejects a severity outside the table CHECK, before SQLite has to', async () => {
  const res = await POST(postReq(wirePayload({ severity: 'catastrophic' })));
  assert.equal(res.status, 400, 'zod must reject an out-of-enum severity at the door');
});

test('[U59] migration 024 carries CANONICAL rows over and maps the old status vocabulary', () => {
  // A box that ran 020 and collected rows under open/accepted/dismissed/overridden.
  const tmp = `${process.env.DATABASE_PATH}.canonical-fixture.db`;
  const db = new Database(tmp);
  db.exec(`
    CREATE TABLE da_challenges (
      id TEXT PRIMARY KEY,
      task_id TEXT,
      campaign_id TEXT,
      trigger_type TEXT NOT NULL,
      challenge TEXT NOT NULL,
      specific_concern TEXT,
      assumptions TEXT,
      severity TEXT CHECK(severity IN ('low','medium','high')),
      confidence REAL,
      status TEXT DEFAULT 'open' CHECK(status IN ('open','accepted','dismissed','overridden')),
      dismissal_reason TEXT,
      outcome TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      resolved_at TEXT
    );
    INSERT INTO da_challenges (id, trigger_type, challenge, severity, status, created_at)
      VALUES ('c1','kpi_swing','Old canonical challenge','high','overridden','2026-01-01T00:00:00Z'),
             ('c2','critical_task','Another one','low','accepted','2026-01-02T00:00:00Z');
  `);
  apply024(db);

  const rows = db
    .prepare('SELECT id, status, challenge FROM da_challenges ORDER BY id')
    .all() as { id: string; status: string; challenge: string }[];
  assert.equal(rows.length, 2, 'no canonical row may be lost in the rebuild');
  assert.equal(rows[0].status, 'escalated', "overridden -> escalated");
  assert.equal(rows[1].status, 'approved', "accepted -> approved");
  assert.equal(rows[0].challenge, 'Old canonical challenge', 'content must survive');
  db.close();
});

test('[U59] migration 024 rescues a LEGACY table that migration 020 no-ops on forever', () => {
  // The shape 020 explicitly defers to 024 — the box class that has been stuck
  // since PR #11 never landed.
  //
  // This DDL is the REAL legacy shape, copied verbatim from the last schema.ts
  // revision that carried it (commit 5bd9ba3) — NOT a paraphrase. That matters:
  // the legacy table's `status` is a genuine CHECK constraint
  // (open|responded|escalated), plus department_id and challenge_text are NOT
  // NULL. An earlier version of this fixture used a bare `status TEXT` with no
  // constraint and nullable columns, which would have let a mapping bug pass
  // here and still fail on a real legacy box.
  const tmp = `${process.env.DATABASE_PATH}.legacy-fixture.db`;
  const db = new Database(tmp);
  db.exec(`
    CREATE TABLE IF NOT EXISTS da_challenges (
      id TEXT PRIMARY KEY,
      department_id TEXT NOT NULL,
      challenge_text TEXT NOT NULL,
      response_text TEXT,
      status TEXT DEFAULT 'open' CHECK (status IN ('open', 'responded', 'escalated')),
      created_at TEXT DEFAULT (datetime('now')),
      response_deadline TEXT,
      resolved_at TEXT
    );
    INSERT INTO da_challenges (id, department_id, challenge_text, response_text, status, created_at)
      VALUES ('L1','sales-dept','Legacy challenge text','A human reply','responded','2026-01-01T00:00:00Z'),
             ('L2','ops-dept','An open legacy challenge',NULL,'open','2026-01-02T00:00:00Z'),
             ('L3','sales-dept','An escalated legacy challenge',NULL,'escalated','2026-01-03T00:00:00Z');
  `);
  apply024(db);

  const cols = (db.prepare('PRAGMA table_info(da_challenges)').all() as { name: string }[]).map(
    (c) => c.name,
  );
  assert.ok(cols.includes('task_id'), 'legacy table must be reconciled to the canonical shape');

  const row = db.prepare('SELECT * FROM da_challenges WHERE id = ?').get('L1') as Record<
    string,
    unknown
  >;
  assert.ok(row, 'the legacy row must survive');
  assert.equal(row.challenge, 'Legacy challenge text', 'challenge_text -> challenge');
  assert.equal(row.outcome, 'A human reply', 'response_text -> outcome, never dropped');
  assert.equal(row.status, 'approved', 'legacy responded -> approved');
  assert.equal(row.department_id, 'sales-dept', 'department_id carries over');
  assert.equal(row.trigger_type, 'legacy_import', 'NOT NULL trigger_type gets an honest marker');

  // Every member of the legacy CHECK's vocabulary must map, not just the one.
  const all = db
    .prepare('SELECT id, status FROM da_challenges ORDER BY id')
    .all() as { id: string; status: string }[];
  assert.equal(all.length, 3, 'no legacy row may be lost in the rebuild');
  assert.deepEqual(
    all.map((r) => `${r.id}:${r.status}`),
    ['L1:approved', 'L2:pending', 'L3:escalated'],
    'legacy responded->approved, open->pending, escalated->escalated',
  );

  // The reconciled table must carry the PRD CHECK, not the legacy one — i.e.
  // the constraint really was replaced, not merely the column values rewritten.
  const newDdl = (
    db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='da_challenges'`).get() as
      | { sql: string }
      | undefined
  )?.sql;
  assert.ok(newDdl?.includes("'pending'"), 'reconciled table must carry the PRD CHECK');
  assert.ok(!newDdl?.includes("'responded'"), 'the legacy CHECK must be gone');
  db.close();
});
