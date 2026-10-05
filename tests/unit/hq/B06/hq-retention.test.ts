/**
 * B06 — Headquarters age-only retention sweep (migration V04, acceptance Q04
 * retention cases: age, count, clock rollback, interleaved seq, empty).
 *
 * FAIL-FIRST: before B06, `src/lib/jobs/hq-retention.ts` does not exist and this
 * file fails at import. Nothing aged out Headquarters activity, dedup receipts
 * or private turn/session content: S6's 30-day feed sweep, 48-hour receipt life,
 * 30-day turn-content redaction and 90-day tombstones had no implementation.
 *
 * FIXTURE NOTE. The HQ tables are B01's additive migration and are NOT in this
 * unit's base, so this test creates the S6 DDL itself, verbatim from SPEC S6,
 * inside its own isolated database. That is a test fixture for an absent
 * dependency, not a shipped mock: `src/lib/jobs/hq-retention.ts` creates no
 * table and a missing table is asserted to be zero work, never an exception.
 *
 * Run:
 *   node --import tsx --import tests/setup/no-owner-telegram.ts \
 *     --import tests/setup/tmp-sandbox.ts --test tests/unit/hq/B06/hq-retention.test.ts
 */

import './../../_isolated-db';

import assert from 'node:assert/strict';
import test from 'node:test';

import { getDb, queryAll, queryOne, run } from '../../../../src/lib/db';
import {
  HQ_RETENTION_CRON_EXPR,
  formatHqRetentionSummary,
  runHqRetention,
} from '../../../../src/lib/jobs/hq-retention';

// ── S6 DDL (fixture for the not-yet-landed B01 migration) ───────────────────

const HQ_DDL = `
CREATE TABLE IF NOT EXISTS hq_activity (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  company_id TEXT NOT NULL,
  source_key TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  kind TEXT NOT NULL,
  task_id TEXT,
  actor_agent_id TEXT,
  recipient_agent_id TEXT,
  from_workspace_id TEXT,
  to_workspace_id TEXT,
  exchange_id TEXT,
  phase TEXT,
  payload_json TEXT NOT NULL,
  occurred_at TEXT,
  received_at TEXT NOT NULL,
  UNIQUE(company_id, source_key)
);
CREATE INDEX IF NOT EXISTS idx_hq_activity_company_seq ON hq_activity(company_id, seq);
CREATE TABLE IF NOT EXISTS hq_activity_state (
  company_id TEXT PRIMARY KEY,
  high_seq INTEGER NOT NULL,
  pruned_through_seq INTEGER NOT NULL,
  capture_state TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS hq_activity_receipts (
  company_id TEXT NOT NULL,
  source_key TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  issued_at TEXT,
  accepted_at TEXT,
  original_seq INTEGER,
  PRIMARY KEY(company_id, source_key)
);
CREATE TABLE IF NOT EXISTS hq_chat_sessions (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  owner_subject TEXT NOT NULL,
  installation_id TEXT NOT NULL,
  head_agent_id TEXT NOT NULL,
  runtime_agent_id TEXT,
  created_at TEXT NOT NULL,
  last_activity_at TEXT NOT NULL,
  closed_at TEXT
);
CREATE TABLE IF NOT EXISTS hq_chat_turns (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  owner_subject TEXT NOT NULL,
  client_request_id TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  message_text TEXT NOT NULL,
  reply_text TEXT,
  state TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  lease_token TEXT,
  lease_expires_at TEXT,
  gateway_session_key TEXT UNIQUE,
  source_run_id TEXT,
  task_id TEXT,
  error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  terminal_at TEXT,
  content_expired_at TEXT,
  UNIQUE(company_id, session_id, client_request_id)
);
`;

function ensureHqTables(): void {
  getDb().exec(HQ_DDL);
}

function dropHqTables(): void {
  const db = getDb();
  for (const t of [
    'hq_chat_turns',
    'hq_chat_sessions',
    'hq_activity_receipts',
    'hq_activity_state',
    'hq_activity',
  ]) {
    db.exec(`DROP TABLE IF EXISTS ${t}`);
  }
}

function clearHqTables(): void {
  ensureHqTables();
  for (const t of [
    'hq_chat_turns',
    'hq_chat_sessions',
    'hq_activity_receipts',
    'hq_activity_state',
    'hq_activity',
  ]) {
    run(`DELETE FROM ${t}`, []);
  }
}

function agoIso(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

function agoHoursIso(hours: number): string {
  return new Date(Date.now() - hours * 3_600_000).toISOString();
}

let seqCounter = 0;
function seedActivity(companyId: string, receivedAt: string): number {
  seqCounter += 1;
  const info = run(
    `INSERT INTO hq_activity
       (id, company_id, source_key, content_hash, kind, payload_json, occurred_at, received_at)
     VALUES (?, ?, ?, ?, 'task', '{}', NULL, ?)`,
    [`evt-${seqCounter}-${companyId}`, companyId, `task:${companyId}:${seqCounter}`, `hash-${seqCounter}`, receivedAt],
  );
  return Number(info.lastInsertRowid);
}

function seedState(companyId: string, highSeq: number): void {
  run(
    `INSERT INTO hq_activity_state (company_id, high_seq, pruned_through_seq, capture_state, updated_at)
     VALUES (?, ?, 0, 'ok', ?)`,
    [companyId, highSeq, agoIso(0)],
  );
}

function seedReceipt(companyId: string, key: string, acceptedAt: string): void {
  run(
    `INSERT INTO hq_activity_receipts (company_id, source_key, content_hash, issued_at, accepted_at, original_seq)
     VALUES (?, ?, 'h', ?, ?, 1)`,
    [companyId, key, acceptedAt, acceptedAt],
  );
}

function seedSession(id: string, companyId: string, lastActivityAt: string, closedAt: string | null = null): void {
  run(
    `INSERT INTO hq_chat_sessions
       (id, company_id, owner_subject, installation_id, head_agent_id, runtime_agent_id, created_at, last_activity_at, closed_at)
     VALUES (?, ?, 'owner-1', 'inst-1', 'head-1', 'runtime-1', ?, ?, ?)`,
    [id, companyId, lastActivityAt, lastActivityAt, closedAt],
  );
}

function seedTurn(
  id: string,
  companyId: string,
  sessionId: string,
  state: string,
  terminalAt: string | null,
): void {
  run(
    `INSERT INTO hq_chat_turns
       (id, company_id, session_id, owner_subject, client_request_id, payload_hash,
        message_text, reply_text, state, attempts, gateway_session_key, created_at, updated_at, terminal_at)
     VALUES (?, ?, ?, 'owner-1', ?, 'ph', ?, ?, ?, 1, ?, ?, ?, ?)`,
    [
      id,
      companyId,
      sessionId,
      `req-${id}`,
      `secret message ${id}`,
      `secret reply ${id}`,
      state,
      `agent:runtime-1:hq-${id}`,
      agoIso(200),
      agoIso(200),
      terminalAt,
    ],
  );
}

function activityCount(companyId: string): number {
  return (
    queryOne<{ n: number }>(`SELECT COUNT(*) AS n FROM hq_activity WHERE company_id = ?`, [companyId])
      ?.n ?? 0
  );
}

function state(companyId: string): { pruned_through_seq: number; updated_at: string } {
  return queryOne<{ pruned_through_seq: number; updated_at: string }>(
    `SELECT pruned_through_seq, updated_at FROM hq_activity_state WHERE company_id = ?`,
    [companyId],
  )!;
}

function countOf(table: string): number {
  return queryOne<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`, [])?.n ?? 0;
}

// ── 1. AGE ──────────────────────────────────────────────────────────────────

test('AGE: expired feed rows and receipts age out; fresh rows survive', async () => {
  clearHqTables();
  seqCounter = 0;

  const old1 = seedActivity('co-a', agoIso(31));
  const fresh = seedActivity('co-a', agoIso(1));
  seedState('co-a', 2);

  seedReceipt('co-a', 'old-receipt', agoHoursIso(49));
  seedReceipt('co-a', 'fresh-receipt', agoHoursIso(47));

  const result = await runHqRetention();

  assert.equal(result.skippedReason, undefined, 'no kill flag set');
  assert.equal(result.deleted.activity, 1, 'exactly the 31-day feed row aged out');

  const remaining = queryAll<{ seq: number }>(`SELECT seq FROM hq_activity`, []).map((r) => r.seq);
  assert.deepEqual(remaining, [fresh], 'only the fresh feed row remains');
  assert.ok(!remaining.includes(old1), 'the 31-day row is gone');

  assert.equal(result.deleted.receipts, 1, 'exactly the 49-hour receipt expired');
  assert.equal(
    queryOne<{ n: number }>(
      `SELECT COUNT(*) AS n FROM hq_activity_receipts WHERE source_key = 'fresh-receipt'`,
      [],
    )?.n,
    1,
    'a 47-hour receipt is inside the 48-hour window and survives',
  );
  assert.equal(
    queryOne<{ n: number }>(
      `SELECT COUNT(*) AS n FROM hq_activity_receipts WHERE accepted_at = ? AND source_key = 'old-receipt'`,
      [agoHoursIso(49)],
    )?.n,
    0,
    'expired receipt row is removed',
  );

  assert.equal(
    /activity=1 receipts=1/.test(formatHqRetentionSummary(result)),
    true,
    'the shared summary line carries the run’s own counts',
  );
});

test('AGE: turn content redacts at 30 days; the 90-day tombstone policy holds', async () => {
  clearHqTables();
  seedSession('s1', 'co-a', agoIso(200));

  seedTurn('t-old', 'co-a', 's1', 'replied', agoIso(31)); // content expired, row stays
  seedTurn('t-fresh', 'co-a', 's1', 'replied', agoIso(1)); // too young to touch
  seedTurn('t-pending', 'co-a', 's1', 'awaiting_reply', null); // never auto-pruned
  seedTurn('t-tombstone', 'co-a', 's1', 'refused', agoIso(91)); // past the 90-day tombstone

  const result = await runHqRetention();

  const old = queryOne<{ message_text: string; reply_text: string | null; content_expired_at: string | null; state: string }>(
    `SELECT message_text, reply_text, content_expired_at, state FROM hq_chat_turns WHERE id = 't-old'`,
    [],
  )!;
  assert.equal(old.message_text, '[expired]', 'expired content is replaced, not left readable');
  assert.equal(old.reply_text, null, 'the reply text is dropped with the message');
  assert.equal(old.state, 'replied', 'the state tombstone survives redaction');
  assert.ok(old.content_expired_at, 'the redaction time is recorded');

  const fresh = queryOne<{ message_text: string; content_expired_at: string | null }>(
    `SELECT message_text, content_expired_at FROM hq_chat_turns WHERE id = 't-fresh'`,
    [],
  )!;
  assert.equal(fresh.message_text, 'secret message t-fresh', 'a 1-day-old terminal turn keeps its text');
  assert.equal(fresh.content_expired_at, null, 'no redaction stamp on a young turn');

  const pending = queryOne<{ message_text: string }>(
    `SELECT message_text FROM hq_chat_turns WHERE id = 't-pending'`,
    [],
  )!;
  assert.equal(
    pending.message_text,
    'secret message t-pending',
    'a nonterminal turn is neither redacted nor pruned, at any age',
  );

  assert.equal(
    queryOne<{ n: number }>(`SELECT COUNT(*) AS n FROM hq_chat_turns WHERE id = 't-tombstone'`, [])?.n,
    0,
    'a terminal turn past 90 days is removed',
  );
  // Two terminal turns are past the 30-day content window (t-old and the
  // 91-day row that is about to be deleted); redaction runs first and is
  // reported for both, so the two rules stay independent.
  assert.equal(result.deleted.turn_contents_redacted, 2, 'both expired terminal turns redacted');
  assert.equal(result.deleted.turns, 1, 'one tombstone removed');
});

// ── 2. COUNT (the SPEC’s 500-rows-per-minute rate) ──────────────────────────

test('COUNT: the feed sweep stops at 500 rows per run, and resumes on the next', async () => {
  clearHqTables();
  seqCounter = 0;
  for (let i = 0; i < 1200; i += 1) seedActivity('co-a', agoIso(40));
  seedState('co-a', 1200);

  const first = await runHqRetention();
  assert.equal(first.deleted.activity, 500, 'exactly the 500-row rate, never more');
  assert.equal(activityCount('co-a'), 700, '700 rows remain for later runs');

  const second = await runHqRetention();
  assert.equal(second.deleted.activity, 500, 'the next run spends its own 500');
  assert.equal(activityCount('co-a'), 200);

  const third = await runHqRetention();
  assert.equal(third.deleted.activity, 200, 'the last run drains the remainder');
  assert.equal(activityCount('co-a'), 0);

  const fourth = await runHqRetention();
  assert.equal(fourth.deleted.activity, 0, 'an exhausted sweep is idempotent');
});

// ── 3. CLOCK ROLLBACK / FUTURE ROWS ─────────────────────────────────────────

test('CLOCK: a future-dated row is never deleted, and the watermark never passes a retained row', async () => {
  clearHqTables();
  seqCounter = 0;

  // A forward-skewed writer stamped a row in the future; the sweep must not
  // treat it as expired even though the box clock is behind it.
  const futureSeq = seedActivity('co-a', new Date(Date.now() + 3 * 86_400_000).toISOString());
  const oldSeq = seedActivity('co-a', agoIso(60));
  seedState('co-a', 2);

  const result = await runHqRetention();

  assert.equal(result.deleted.activity, 1, 'only the genuinely old row leaves');
  const remaining = queryAll<{ seq: number }>(`SELECT seq FROM hq_activity ORDER BY seq`, []).map((r) => r.seq);
  assert.deepEqual(remaining, [futureSeq], 'the future-dated row survives untouched');
  assert.ok(!remaining.includes(oldSeq));

  // The watermark may never advance to or past a row that is still retained:
  // forward pagination is `seq > cursor`, so that row would become unreachable.
  const s = state('co-a');
  assert.ok(
    s.pruned_through_seq < futureSeq,
    `watermark ${s.pruned_through_seq} must stay below retained seq ${futureSeq}`,
  );
  assert.ok(s.updated_at, 'the state row is updated in the same pass');
});

test('CLOCK: a NULL received_at never matches a window', async () => {
  clearHqTables();
  seqCounter = 0;
  seedState('co-a', 1);
  // Direct insert bypassing the helper so received_at can be NULL — the column
  // is NOT NULL by DDL, so the honest case is an UNPARSEABLE value.
  run(
    `INSERT INTO hq_activity (id, company_id, source_key, content_hash, kind, payload_json, occurred_at, received_at)
     VALUES ('evt-odd', 'co-a', 'task:odd', 'h', 'task', '{}', NULL, 'not-a-timestamp')`,
    [],
  );

  const result = await runHqRetention();
  assert.equal(result.deleted.activity, 0, 'an unparseable timestamp is not an old row');
  assert.equal(activityCount('co-a'), 1, 'the row survives');
});

// ── 4. INTERLEAVED SEQ ──────────────────────────────────────────────────────

test('INTERLEAVED: two companies advance their own watermarks over interleaved seqs', async () => {
  clearHqTables();
  seqCounter = 0;

  const aOld: number[] = [];
  const bOld: number[] = [];
  const aFresh: number[] = [];
  const bFresh: number[] = [];
  for (let i = 0; i < 4; i += 1) {
    aOld.push(seedActivity('co-a', agoIso(40)));
    bOld.push(seedActivity('co-b', agoIso(40)));
    aFresh.push(seedActivity('co-a', agoIso(2)));
    bFresh.push(seedActivity('co-b', agoIso(2)));
  }
  seedState('co-a', 8);
  seedState('co-b', 8);

  const result = await runHqRetention();
  assert.equal(result.deleted.activity, 8, 'both companies’ expired rows evicted');

  for (const [company, old, fresh] of [
    ['co-a', aOld, aFresh],
    ['co-b', bOld, bFresh],
  ] as const) {
    const left = queryAll<{ seq: number }>(
      `SELECT seq FROM hq_activity WHERE company_id = ? ORDER BY seq`,
      [company],
    ).map((r) => r.seq);
    assert.deepEqual(left, [...fresh], `${company} keeps exactly its fresh rows`);
    assert.ok(!left.some((s) => old.includes(s)), `${company} old rows are gone`);

    // Interleaved companies mean a company's own fresh rows can carry LOWER
    // seqs than its oldest just-evicted row (co-a holds 1,5,9,13 evicted and
    // 3,7,11,15 retained), so "max evicted" would strand live rows below the
    // watermark. The sweep records the greatest seq it may honestly claim —
    // never past its oldest retained row — which is what `after` pagination
    // (`seq > cursor`) requires to reach every row it kept.
    const s = state(company);
    const expected = Math.min(Math.max(...old), Math.min(...fresh) - 1);
    assert.equal(s.pruned_through_seq, expected, `${company} watermark is the greatest honest pruned seq`);
    assert.ok(
      s.pruned_through_seq <= Math.max(...old),
      `${company} watermark never claims more than was evicted`,
    );
    assert.ok(
      s.pruned_through_seq < Math.min(...fresh),
      `${company} watermark stays below its oldest retained row`,
    );
  }
});

// ── 5. EMPTY ────────────────────────────────────────────────────────────────

test('EMPTY: no rows reports zeros; an absent table is zero work, never an exception', async () => {
  clearHqTables();
  const empty = await runHqRetention();
  assert.equal(empty.skippedReason, undefined, 'an empty sweep is not a skip');
  assert.deepEqual(
    empty.deleted,
    { activity: 0, receipts: 0, turn_contents_redacted: 0, turns: 0, sessions_closed: 0, sessions: 0 },
    'nothing to do reports zeroes, not invented counts',
  );

  // A half-migrated box: B01's migration has not run, so the HQ tables do not
  // exist yet. The sweep must be a no-op there too.
  dropHqTables();
  const absent = await runHqRetention();
  assert.deepEqual(
    absent.deleted,
    { activity: 0, receipts: 0, turn_contents_redacted: 0, turns: 0, sessions_closed: 0, sessions: 0 },
    'missing HQ tables are zero work',
  );

  ensureHqTables();
});

test('EMPTY: a company with no state row is not swept (no watermark to record the prune)', async () => {
  clearHqTables();
  seqCounter = 0;
  seedActivity('co-stateful', agoIso(60));
  seedActivity('co-orphan', agoIso(60));
  seedState('co-stateful', 1);

  const result = await runHqRetention();
  assert.equal(result.deleted.activity, 1, 'only the company holding a state row is swept');
  assert.equal(activityCount('co-stateful'), 0);
  assert.equal(activityCount('co-orphan'), 1, 'an unwatermarked company keeps its rows');
});

// ── 6. SESSIONS ─────────────────────────────────────────────────────────────

test('SESSIONS: idle sessions close at 30 days; the tombstone waits for 90 and for its turns', async () => {
  clearHqTables();

  seedSession('s-idle', 'co-a', agoIso(31));
  seedSession('s-live', 'co-a', agoIso(1));
  seedSession('s-closed-new', 'co-a', agoIso(200), agoIso(10)); // closed, tombstone not due
  seedSession('s-closed-old', 'co-a', agoIso(200), agoIso(91)); // closed and past 90
  seedSession('s-closed-old-with-turn', 'co-a', agoIso(200), agoIso(91));
  seedTurn('t-keeps-session', 'co-a', 's-closed-old-with-turn', 'reconciling', null);

  const result = await runHqRetention();

  assert.equal(result.deleted.sessions_closed, 1, 'exactly the idle open session was closed');
  assert.ok(
    queryOne<{ closed_at: string | null }>(`SELECT closed_at FROM hq_chat_sessions WHERE id = 's-idle'`, [])!
      .closed_at,
    'the idle session carries a closed_at stamp',
  );
  assert.equal(
    queryOne<{ closed_at: string | null }>(`SELECT closed_at FROM hq_chat_sessions WHERE id = 's-live'`, [])!
      .closed_at,
    null,
    'a session active yesterday stays open',
  );

  assert.equal(
    queryOne<{ n: number }>(`SELECT COUNT(*) AS n FROM hq_chat_sessions WHERE id = 's-closed-old'`, [])?.n,
    0,
    'a 91-day closed tombstone is removed',
  );
  assert.equal(
    queryOne<{ n: number }>(`SELECT COUNT(*) AS n FROM hq_chat_sessions WHERE id = 's-closed-new'`, [])?.n,
    1,
    'a 10-day closed tombstone is retained',
  );
  assert.equal(
    queryOne<{ n: number }>(`SELECT COUNT(*) AS n FROM hq_chat_sessions WHERE id = 's-closed-old-with-turn'`, [])?.n,
    1,
    'a session is never removed while a turn still references it',
  );
  assert.equal(
    queryOne<{ n: number }>(`SELECT COUNT(*) AS n FROM hq_chat_turns WHERE id = 't-keeps-session'`, [])?.n,
    1,
    'and its unprunable pending turn is untouched',
  );
  assert.equal(result.deleted.sessions, 1, 'one session tombstone removed');
});

// ── 7. job contract ─────────────────────────────────────────────────────────

test('JOB: kill flag skips everything; cron expression is exported for the one A01 registration', async () => {
  clearHqTables();
  seqCounter = 0;
  seedActivity('co-a', agoIso(400));
  seedState('co-a', 1);
  seedReceipt('co-a', 'r1', agoHoursIso(400));

  process.env.DISABLE_HQ_RETENTION = '1';
  let skipped;
  try {
    skipped = await runHqRetention();
  } finally {
    delete process.env.DISABLE_HQ_RETENTION;
  }

  assert.equal(skipped.skippedReason, 'DISABLE_HQ_RETENTION set');
  assert.equal(activityCount('co-a'), 1, 'feed untouched under the kill flag');
  assert.equal(countOf('hq_activity_receipts'), 1, 'receipts untouched under the kill flag');
  assert.equal(state('co-a').pruned_through_seq, 0, 'watermark untouched under the kill flag');

  assert.match(HQ_RETENTION_CRON_EXPR, /^\* \* \* \* \*$/, 'once per minute, to meet the 500-row rate');
});
