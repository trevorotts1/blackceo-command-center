/**
 * B05 — appendHqActivity: dedupe, retention bounds, savepoint isolation and
 * sanitized projection. Owner: unit B05 (`CC:src/lib/hq/activity.ts`), V04.
 *
 * Every check named in the B05 card has a case here:
 *   "Q04 dedup receipt survives visible-feed eviction; issuedAt expiry, hash
 *    conflict, receipt quota rejection, hard row+byte insertion bound, telemetry
 *    savepoint failure; no lost business write."
 *
 * FIXTURE NOTE: B01's reserved additive migration (the frozen SPEC S6 DDL for
 * `hq_activity`, `hq_activity_state`, `hq_activity_receipts`) has no commit yet;
 * this file creates those tables itself in a PRIVATE in-memory database, as the
 * swarm-plan base_policy allows ("private test stubs only for absent
 * implementations; never ship mocks"). Nothing here opens, creates, migrates or
 * queries a file-backed database, so there is no `DATABASE_PATH` to resolve.
 *
 * Run: node --import tsx --import ./tests/setup/tmp-sandbox.ts --test tests/unit/hq/B05/activity.test.ts
 */
import './../../_isolated-db'; // Repo convention for DB-touching tests: any accidental file-backed open lands in a throwaway path.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import {
  appendHqActivity,
  toPublicActivityEvent,
  HQ_ACTIVITY_BYTE_CAP,
  HQ_RECEIPT_CAP,
} from '../../../../src/lib/hq/activity';

const COMPANY = 'company-alpha';
const OTHER_COMPANY = 'company-beta';
const INSTALL = 'install-1';

/* Frozen SPEC S6 DDL (lines 227-239) + the minimum CC rows the same-company
 * validation needs. This is the private stub described in the header. */
function freshDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE companies (id TEXT PRIMARY KEY, name TEXT, slug TEXT);
    CREATE TABLE workspaces (id TEXT PRIMARY KEY, company_id TEXT, name TEXT);
    -- openclaw_agent_id is added to the real table by CC migration 133; the
    -- writer resolves a producer's runtime id against BOTH bindings (SPEC S2:
    -- display and runtime IDs are not interchangeable by convention).
    CREATE TABLE agents (id TEXT PRIMARY KEY, workspace_id TEXT, name TEXT, openclaw_agent_id TEXT);
    CREATE TABLE tasks (id TEXT PRIMARY KEY, workspace_id TEXT, title TEXT);

    CREATE TABLE hq_activity (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      company_id TEXT NOT NULL,
      source_key TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      kind TEXT NOT NULL,
      task_id TEXT, actor_agent_id TEXT, recipient_agent_id TEXT,
      from_workspace_id TEXT, to_workspace_id TEXT,
      exchange_id TEXT, phase TEXT,
      payload_json TEXT NOT NULL,
      occurred_at TEXT, received_at TEXT NOT NULL,
      UNIQUE(company_id, source_key)
    );
    CREATE INDEX idx_hq_activity_company_seq ON hq_activity(company_id, seq);
    CREATE INDEX idx_hq_activity_company_exchange_seq ON hq_activity(company_id, exchange_id, seq);

    CREATE TABLE hq_activity_state (
      company_id TEXT PRIMARY KEY,
      high_seq INTEGER NOT NULL,
      pruned_through_seq INTEGER NOT NULL,
      capture_state TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE hq_activity_receipts (
      company_id TEXT NOT NULL, source_key TEXT NOT NULL, content_hash TEXT NOT NULL,
      issued_at TEXT, accepted_at TEXT, original_seq INTEGER,
      PRIMARY KEY (company_id, source_key)
    );
  `);
  db.prepare('INSERT INTO companies (id,name,slug) VALUES (?,?,?)').run(COMPANY, 'Alpha', 'alpha');
  db.prepare('INSERT INTO companies (id,name,slug) VALUES (?,?,?)').run(OTHER_COMPANY, 'Beta', 'beta');
  db.prepare('INSERT INTO workspaces (id,company_id,name) VALUES (?,?,?)').run('w1', COMPANY, 'Ops');
  db.prepare('INSERT INTO workspaces (id,company_id,name) VALUES (?,?,?)').run('w2', OTHER_COMPANY, 'Foreign');
  db.prepare('INSERT INTO agents (id,workspace_id,name) VALUES (?,?,?)').run('a1', 'w1', 'Head');
  db.prepare('INSERT INTO tasks (id,workspace_id,title) VALUES (?,?,?)').run('t1', 'w1', 'Task one');
  db.prepare('INSERT INTO agents (id,workspace_id,name) VALUES (?,?,?)').run('a2', 'w2', 'Beta head');
  db.prepare('INSERT INTO tasks (id,workspace_id,title) VALUES (?,?,?)').run('t2', 'w2', 'Task two');
  return db;
}

const NOW = Date.parse('2026-10-04T12:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();

function taskEvent(over: Record<string, unknown> = {}) {
  return {
    eventId: randomUUID(),
    sourceKey: 'activity:t1',
    installationId: INSTALL,
    companyId: COMPANY,
    issuedAt: iso(NOW - 1000),
    occurredAt: iso(NOW - 2000),
    kind: 'task',
    phase: 'created',
    taskId: 't1',
    actorRuntimeId: null,
    recipientRuntimeId: null,
    fromWorkspaceId: null,
    toWorkspaceId: null,
    exchangeId: null,
    payload: { status: 'backlog', previousStatus: null },
    ...over,
  } as never;
}

/**
 * A RETRY is the same semantic event: S7 fixes the exact bytes once and says
 * "Do not assign fresh eventId/issuedAt while replaying same source key", and
 * "Retry changes only `sentAt` and signature, never semantic event bytes, event
 * ID or original `issuedAt`." Each source key therefore gets ONE event object,
 * minted on first use and handed out again verbatim by every replay.
 */
const retryCache = new Map<string, unknown>();
function stableEvent(key: string, over: Record<string, unknown> = {}) {
  if (!retryCache.has(key)) retryCache.set(key, taskEvent({ sourceKey: key, ...over }));
  return retryCache.get(key) as never;
}

const append = (db: Database.Database, event: unknown, companyId = COMPANY) =>
  appendHqActivity(db, { companyId, installationId: INSTALL, event: event as never, nowMs: NOW });

const count = (db: Database.Database, table: string, companyId = COMPANY) =>
  (db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE company_id = ?`).get(companyId) as { n: number }).n;

/* ============================ dedupe / conflict ============================ */

test('same source key + same content is a duplicate success, not a second row', () => {
  const db = freshDb();
  const event = taskEvent();

  const first = append(db, event);
  assert.equal(first.status, 'appended');
  assert.equal(first.status === 'appended' && first.duplicate, false);

  const second = append(db, event); // retry after a lost response
  assert.equal(second.status, 'duplicate');
  assert.equal(second.status === 'duplicate' && second.originalSeq, (first as { seq: number }).seq);
  assert.equal(second.status === 'duplicate' && second.visible, true);
  assert.equal(count(db, 'hq_activity'), 1, 'retry must not insert a second row');
});

test('same source key + different content is a conflict: recorded, never overwritten', () => {
  const db = freshDb();
  assert.equal(append(db, stableEvent('activity:t1')).status, 'appended');
  const changed = append(db, taskEvent({ sourceKey: 'activity:t1', payload: { status: 'assigned', previousStatus: 'backlog' } }));

  assert.equal(changed.status, 'conflict');
  assert.equal(changed.status === 'conflict' && changed.code, 'content_conflict');
  assert.equal(count(db, 'hq_activity'), 1, 'conflict must not overwrite the stored row');
  const stored = db.prepare('SELECT payload_json FROM hq_activity').get() as { payload_json: string };
  assert.match(stored.payload_json, /backlog/, 'the FIRST content stays authoritative');

  // The exact original event still succeeds as a duplicate after the conflict
  // was observed: the conflict was diagnostic, and the receipt is untouched.
  assert.equal(append(db, stableEvent('activity:t1')).status, 'duplicate');
});

test('duplicate response keeps originalSeq for a retry that arrives out of order', () => {
  const db = freshDb();
  const a = append(db, stableEvent('activity:a'));
  const b = append(db, stableEvent('activity:b'));
  assert.notEqual((a as { seq: number }).seq, (b as { seq: number }).seq);
  const replay = append(db, stableEvent('activity:a'));
  assert.equal(replay.status === 'duplicate' && replay.originalSeq, (a as { seq: number }).seq);
});

/* ====================== expiry on the RECEIVER's clock ===================== */

test('issuedAt older than 24h expires; a fresh sentAt cannot renew it', () => {
  const db = freshDb();
  const expired = append(db, taskEvent({ issuedAt: iso(NOW - 24 * 60 * 60 * 1000 - 1) }));
  assert.equal(expired.status, 'event_expired');
  assert.equal(count(db, 'hq_activity'), 0);

  // Boundary: exactly 24h old is still inside the window.
  assert.equal(append(db, taskEvent({ issuedAt: iso(NOW - 24 * 60 * 60 * 1000) })).status, 'appended');
});

test('issuedAt more than five minutes in the future is rejected', () => {
  const db = freshDb();
  assert.equal(append(db, taskEvent({ issuedAt: iso(NOW + 5 * 60 * 1000 + 1) })).status, 'event_not_yet_valid');
  assert.equal(append(db, taskEvent({ issuedAt: iso(NOW + 5 * 60 * 1000) })).status, 'appended');
});

/* ============================ retention bounds ============================ */

test('row bound: the 5,001st distinct event evicts the oldest prefix and the receipt survives it', () => {
  const db = freshDb();
  const first = append(db, stableEvent('activity:first'));
  assert.equal(first.status, 'appended');

  for (let i = 0; i < 5000; i += 1) {
    const r = append(db, stableEvent(`activity:bulk:${i}`));
    assert.equal(r.status, 'appended');
  }

  assert.equal(count(db, 'hq_activity'), 5000, 'at most 5,000 rows, never 5,001');
  const state = db.prepare('SELECT high_seq, pruned_through_seq FROM hq_activity_state WHERE company_id = ?').get(COMPANY) as {
    high_seq: number;
    pruned_through_seq: number;
  };
  assert.equal(state.high_seq, 5001, 'high-water reflects every accepted event');
  assert.equal(state.pruned_through_seq, 1, 'the maximum evicted seq is recorded');

  // Q04: "prune the visible event after lost acknowledgment, then retry: the
  // separate receipt still dedupes."
  const replay = append(db, stableEvent('activity:first'));
  assert.equal(replay.status, 'duplicate');
  assert.equal(replay.status === 'duplicate' && replay.originalSeq, (first as { seq: number }).seq);
  assert.equal(replay.status === 'duplicate' && replay.visible, false, 'no longer visible, still deduped');
  assert.equal(count(db, 'hq_activity'), 5000, 'a deduped retry adds nothing');
});

test('byte bound: an already-full feed is evicted by encoded payload bytes, not row count', () => {
  const db = freshDb();
  // Fixture setup, not a writer claim: seed a feed whose retained bytes exceed
  // 32 MiB while its row count is far below 5,000.
  const seed = db.prepare(
    `INSERT INTO hq_activity (id, company_id, source_key, content_hash, kind, phase, payload_json, occurred_at, received_at)
     VALUES (?, ?, ?, ?, 'task', 'created', ?, NULL, ?)`,
  );
  const big = JSON.stringify({ status: 'x'.repeat(1024 * 1024), previousStatus: null });
  db.transaction(() => {
    for (let i = 0; i < 40; i += 1) seed.run(randomUUID(), COMPANY, `activity:big:${i}`, 'h'.repeat(64), big, iso(NOW));
  })();

  const before = db
    .prepare('SELECT COUNT(*) AS n, SUM(length(CAST(payload_json AS BLOB))) AS b FROM hq_activity WHERE company_id = ?')
    .get(COMPANY) as { n: number; b: number };
  assert.ok(before.b > HQ_ACTIVITY_BYTE_CAP, 'fixture really is over the byte bound');
  assert.ok(before.n < 5000, 'and under the row bound, so only the byte rule can fire');

  const r = append(db, taskEvent({ sourceKey: 'activity:after-bytes' }));
  assert.equal(r.status, 'appended');
  assert.notEqual((r as { evictedThroughSeq: number | null }).evictedThroughSeq, null);

  const after = db
    .prepare('SELECT COUNT(*) AS n, SUM(length(CAST(payload_json AS BLOB))) AS b FROM hq_activity WHERE company_id = ?')
    .get(COMPANY) as { n: number; b: number };
  assert.ok(after.b <= HQ_ACTIVITY_BYTE_CAP, `retained bytes ${after.b} must be <= 32 MiB`);
  const evicted = (r as { evictedThroughSeq: number }).evictedThroughSeq;
  assert.equal(
    db.prepare('SELECT COUNT(*) AS n FROM hq_activity WHERE company_id = ? AND seq <= ?').get(COMPANY, evicted).n,
    0,
    'eviction is a contiguous prefix, so nothing at or below the watermark survives',
  );
});

test('a single payload larger than the whole byte budget is refused, not stored and never a capture failure', () => {
  const db = freshDb();
  const huge = append(db, taskEvent({ payload: { status: 'x'.repeat(HQ_ACTIVITY_BYTE_CAP), previousStatus: null } }));
  assert.equal(huge.status, 'oversize');
  assert.equal(count(db, 'hq_activity'), 0);
  assert.equal(count(db, 'hq_activity_state'), 0, 'a refusal is not degradation');
});

/* ============================ receipt capacity ============================ */

test('receipt quota rejects a new distinct event, preserves live keys, and still dedupes them', () => {
  const db = freshDb();
  const first = append(db, stableEvent('activity:known'));
  assert.equal(first.status, 'appended');

  const seed = db.prepare(
    `INSERT INTO hq_activity_receipts (company_id, source_key, content_hash, issued_at, accepted_at, original_seq)
     VALUES (?, ?, ?, ?, ?, 0)`,
  );
  db.transaction(() => {
    for (let i = 0; i < HQ_RECEIPT_CAP - 1; i += 1) {
      seed.run(COMPANY, `activity:seed:${i}`, 'h'.repeat(64), iso(NOW - 1000), iso(NOW - 1000));
    }
  })();
  assert.equal(count(db, 'hq_activity_receipts'), HQ_RECEIPT_CAP);

  const rejected = append(db, taskEvent({ sourceKey: 'activity:new-distinct' }));
  assert.equal(rejected.status, 'receipt_capacity');
  assert.equal(rejected.status === 'receipt_capacity' && rejected.code, 'receipt_capacity');
  assert.equal(count(db, 'hq_activity'), 1, 'the rejected event is not stored');
  assert.equal(
    db.prepare('SELECT capture_state FROM hq_activity_state WHERE company_id = ?').get(COMPANY).capture_state,
    'degraded',
    'capacity exhaustion records capture degradation',
  );

  // S6: "Identical existing retries still receive duplicate response."
  assert.equal(append(db, stableEvent('activity:known')).status, 'duplicate');
  assert.equal(count(db, 'hq_activity_receipts'), HQ_RECEIPT_CAP, 'no unexpired key was evicted to make room');
});

test('expired receipts are cleaned first, then capacity is evaluated', () => {
  const db = freshDb();
  const seed = db.prepare(
    `INSERT INTO hq_activity_receipts (company_id, source_key, content_hash, issued_at, accepted_at, original_seq)
     VALUES (?, ?, ?, ?, ?, 0)`,
  );
  const stale = iso(NOW - 48 * 60 * 60 * 1000 - 1);
  db.transaction(() => {
    for (let i = 0; i < HQ_RECEIPT_CAP; i += 1) seed.run(COMPANY, `activity:old:${i}`, 'h'.repeat(64), stale, stale);
  })();

  assert.equal(append(db, taskEvent({ sourceKey: 'activity:fresh' })).status, 'appended');
  assert.equal(count(db, 'hq_activity_receipts'), 1, 'the expired block was removed, never the live key');
});

/* ================== savepoint isolation / no lost business write ================== */

test('telemetry failure rolls back its own savepoint, records degradation, and never loses business work', () => {
  const db = freshDb();
  db.exec(`
    CREATE TABLE business (id INTEGER PRIMARY KEY, note TEXT);
    CREATE TRIGGER hq_boom BEFORE INSERT ON hq_activity WHEN NEW.source_key = 'exchange:boom:requested'
      BEGIN SELECT RAISE(ABORT, 'injected telemetry failure'); END;
  `);

  // The source transaction: authorized business write + the telemetry append,
  // exactly as S5 describes ("insert within the source transaction using a savepoint").
  const sourceTx = db.transaction(() => {
    db.prepare('INSERT INTO business (note) VALUES (?)').run('authorized-work');
    const result = append(db, exchangeEvent({ sourceKey: 'exchange:boom:requested' }));
    assert.equal(result.status, 'capture_failed');
    assert.match((result as { reason: string }).reason, /injected telemetry failure/);
    db.prepare('INSERT INTO business (note) VALUES (?)').run('work-after-failure');
  });
  sourceTx();

  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM business').get() as { n: number }).n, 2, 'no lost business write');
  assert.equal(count(db, 'hq_activity'), 0, 'the failed append left no row');
  assert.equal(db.inTransaction, false, 'the wrapper leaves no open transaction');
  assert.equal(
    db.prepare('SELECT capture_state FROM hq_activity_state WHERE company_id = ?').get(COMPANY).capture_state,
    'degraded',
    'a bounded capture-health failure was recorded',
  );

  // Same business transaction, append that WORKS: both writes land together.
  db.transaction(() => {
    db.prepare('INSERT INTO business (note) VALUES (?)').run('work-with-good-append');
    assert.equal(append(db, taskEvent()).status, 'appended');
  })();
  assert.equal(count(db, 'hq_activity'), 1);
});

test('a recorded capture degradation is not silently cleared by a later success', () => {
  const db = freshDb();
  db.exec(`CREATE TRIGGER hq_boom BEFORE INSERT ON hq_activity WHEN NEW.source_key = 'activity:boom'
    BEGIN SELECT RAISE(ABORT, 'injected'); END;`);

  assert.equal(append(db, taskEvent({ sourceKey: 'activity:boom' })).status, 'capture_failed');
  assert.equal(
    db.prepare('SELECT capture_state FROM hq_activity_state WHERE company_id = ?').get(COMPANY).capture_state,
    'degraded',
  );

  // A later success must not erase the fact that capture failed at some point
  // (the SPEC's dropped-count channel is a separate gap; this unit only keeps
  // the state honest rather than claiming recovered completeness).
  assert.equal(append(db, taskEvent({ sourceKey: 'activity:fine' })).status, 'appended');
  assert.equal(
    db.prepare('SELECT capture_state FROM hq_activity_state WHERE company_id = ?').get(COMPANY).capture_state,
    'degraded',
    'a success proves the pipeline works now, not that the earlier failure dropped nothing',
  );
});

test('a business transaction that later fails takes the already-appended row with it (one transaction)', () => {
  const db = freshDb();
  const sourceTx = db.transaction(() => {
    append(db, taskEvent());
    throw new Error('source work rolled back');
  });
  assert.throws(() => sourceTx(), /source work rolled back/);
  assert.equal(count(db, 'hq_activity'), 0, 'append joined the source transaction; no orphan row');
  assert.equal(count(db, 'hq_activity_receipts'), 0, 'and no orphan receipt');
});

/* ============================ trust boundary ============================ */

test('a forged company or installation is rejected before persistence', () => {
  const db = freshDb();
  const forgedCompany = append(db, taskEvent({ companyId: OTHER_COMPANY }), COMPANY);
  assert.equal(forgedCompany.status, 'foreign_source_id');
  const forgedInstall = append(db, taskEvent({ installationId: 'somebody-else' }));
  assert.equal(forgedInstall.status, 'foreign_source_id');
  assert.equal(count(db, 'hq_activity'), 0);
});

test('a source ID belonging to another company is rejected', () => {
  const db = freshDb();
  assert.equal(append(db, taskEvent({ sourceKey: 'activity:foreign-ws', fromWorkspaceId: 'w2' })).status, 'foreign_source_id');
  assert.equal(append(db, taskEvent({ sourceKey: 'activity:own-ws', taskId: 't1', fromWorkspaceId: 'w1' })).status, 'appended');
  assert.equal(append(db, taskEvent({ sourceKey: 'activity:missing-task', taskId: 'no-such-task' })).status, 'foreign_source_id');
  assert.equal(count(db, 'hq_activity'), 1, 'only the same-company row is stored');
});

test('an actor resolved by its runtime binding is accepted, and a foreign runtime id still refused', () => {
  const db = freshDb();
  db.prepare('UPDATE agents SET openclaw_agent_id = ? WHERE id = ?').run('runtime-xyz', 'a1');
  db.prepare('UPDATE agents SET openclaw_agent_id = ? WHERE id = ?').run('runtime-foreign', 'a2');

  assert.equal(append(db, taskEvent({ sourceKey: 'activity:runtime-own', actorRuntimeId: 'runtime-xyz' })).status, 'appended');
  assert.equal(append(db, taskEvent({ sourceKey: 'activity:runtime-other', actorRuntimeId: 'runtime-foreign' })).status, 'foreign_source_id');
  assert.equal(append(db, taskEvent({ sourceKey: 'activity:runtime-unknown', actorRuntimeId: 'runtime-nobody' })).status, 'foreign_source_id');
  assert.equal(count(db, 'hq_activity'), 1);
});

test('an event that is not the frozen shape is refused, never stored', () => {
  const db = freshDb();
  assert.equal(append(db, { ...taskEvent(), surprise: true }).status, 'invalid_event');
  assert.equal(append(db, { ...taskEvent(), payload: { status: 5, previousStatus: null } }).status, 'invalid_event');
  assert.equal(count(db, 'hq_activity'), 0);
});

/* ==================== sanitized public projection (G-08/G-09) ==================== */

function exchangeEvent(over: Record<string, unknown> = {}) {
  return taskEvent({
    kind: 'exchange',
    phase: 'replied',
    exchangeId: 'e'.repeat(64),
    actorRuntimeId: 'a1',
    payload: {
      message: 'Build the thing',
      summary: 'requested a build',
      toolName: 'sessions_send',
      toolCallId: 'tc-1',
      callerRunId: 'run-caller',
      targetRunId: 'run-target',
      callerSessionKey: 'agent:caller:main',
      targetSessionKey: 'agent:target:main',
      sourceHook: 'after_tool_call',
      nativeStatus: 'ok',
      targetDisposition: 'queued',
      correlationStatus: 'linked',
    },
    ...over,
  });
}

test('the public projection carries the SPEC field list and strips every internal routing key', () => {
  const db = freshDb();
  const r = append(db, exchangeEvent());
  assert.equal(r.status, 'appended');
  const row = db.prepare('SELECT * FROM hq_activity WHERE company_id = ?').get(COMPANY) as never;
  const event = toPublicActivityEvent(row, (id) => (id === 'a1' ? 'Head' : null));

  assert.deepEqual(Object.keys(event).sort(), [
    'actorLabel', 'id', 'kind', 'occurredAt', 'payload', 'phase', 'receivedAt', 'recipientLabel', 'reference', 'seq', 'taskId',
  ]);
  assert.deepEqual(Object.keys(event.payload).sort(), ['message', 'summary']);
  assert.equal(event.actorLabel, 'Head', 'labels resolve from current scope');
  assert.equal(event.recipientLabel, null, 'an unbound/removed target is null, not a retained historical name');
  assert.equal(event.reference, 'activity:t1', 'the SPEC source reference is the source key');

  const serialized = JSON.stringify(event);
  for (const secretish of ['toolCallId', 'callerRunId', 'targetRunId', 'callerSessionKey', 'targetSessionKey', 'sourceHook', 'nativeStatus', 'targetDisposition', 'correlationStatus', 'tc-1', 'run-caller', 'agent:caller:main']) {
    assert.equal(serialized.includes(secretish), false, `${secretish} must never reach the public projection`);
  }
});

test('an exchange with no proven task audience never has its message text persisted', () => {
  const db = freshDb();
  const r = append(db, exchangeEvent({ taskId: null, sourceKey: 'exchange:unbound:requested' }));
  assert.equal(r.status, 'appended');

  const row = db.prepare('SELECT payload_json, task_id FROM hq_activity WHERE company_id = ?').get(COMPANY) as {
    payload_json: string;
    task_id: string | null;
  };
  const stored = JSON.parse(row.payload_json) as { message: string | null; summary: string };
  assert.equal(row.task_id, null);
  assert.equal(stored.message, null, 'S5: an unbound exchange is coverage metadata only');
  assert.equal(stored.summary, 'requested a build', 'the required non-null summary still travels');

  const event = toPublicActivityEvent({ ...(row as never as object), id: 'x', seq: 1, kind: 'exchange', phase: 'replied', actor_agent_id: null, recipient_agent_id: null, occurred_at: null, received_at: iso(NOW), source_key: 'k' } as never, () => null);
  assert.equal(JSON.stringify(event).includes('Build the thing'), false);
});

test('a decision projection keeps nulls as null and never invents confidence zero', () => {
  const db = freshDb();
  append(
    db,
    taskEvent({
      kind: 'decision',
      phase: 'unavailable',
      sourceKey: 'decision:corr-1:unavailable',
      payload: {
        intent: 'route-to-marketing',
        routeAction: null,
        departmentSlug: null,
        confidenceBps: null,
        fallback: true,
        mode: 'fallback',
        resolvedBy: 'rule',
      },
    }),
  );
  const row = db.prepare('SELECT * FROM hq_activity WHERE company_id = ?').get(COMPANY) as never;
  const event = toPublicActivityEvent(row, () => null);
  assert.deepEqual(event.payload, {
    intent: 'route-to-marketing',
    routeAction: null,
    departmentSlug: null,
    confidenceBps: null,
    fallback: true,
    mode: 'fallback',
    resolvedBy: 'rule',
  });
});

/* ============================ watermark honesty ============================ */

test('the state row is created on first append and its watermark never moves backwards', () => {
  const db = freshDb();
  assert.equal(count(db, 'hq_activity_state'), 0);
  append(db, taskEvent({ sourceKey: 'activity:one' }));
  const first = db.prepare('SELECT high_seq, pruned_through_seq, capture_state FROM hq_activity_state WHERE company_id = ?').get(COMPANY) as {
    high_seq: number; pruned_through_seq: number; capture_state: string;
  };
  assert.deepEqual(first, { high_seq: 1, pruned_through_seq: 0, capture_state: 'ok' });

  append(db, taskEvent({ sourceKey: 'activity:two' }));
  append(db, taskEvent({ sourceKey: 'activity:three' }));
  const later = db.prepare('SELECT high_seq, pruned_through_seq FROM hq_activity_state WHERE company_id = ?').get(COMPANY) as {
    high_seq: number; pruned_through_seq: number;
  };
  assert.equal(later.high_seq, 3);
  assert.equal(later.pruned_through_seq, 0, 'nothing was evicted, so nothing claims to be pruned');

  // A duplicate does not advance the cursor.
  append(db, taskEvent({ sourceKey: 'activity:three' }));
  assert.equal(
    (db.prepare('SELECT high_seq FROM hq_activity_state WHERE company_id = ?').get(COMPANY) as { high_seq: number }).high_seq,
    3,
  );
});

test('two companies are bounded and deduped independently', () => {
  const db = freshDb();
  // Intentionally the SAME source key string as company-alpha's own event: the
  // unique key is (company_id, source_key), so this must be a separate row with
  // its own receipt, its own cursor and its own bounds.
  const other = appendHqActivity(db, {
    companyId: OTHER_COMPANY,
    installationId: INSTALL,
    event: taskEvent({ companyId: OTHER_COMPANY, sourceKey: 'activity:t1', taskId: 't2' }) as never,
    nowMs: NOW,
  });
  assert.equal(other.status, 'appended', 'the same source key in another company is its own key space');

  assert.equal(append(db, stableEvent('activity:t1')).status, 'appended');
  assert.equal(count(db, 'hq_activity', COMPANY), 1);
  assert.equal(count(db, 'hq_activity', OTHER_COMPANY), 1);
  assert.equal(count(db, 'hq_activity_receipts', COMPANY), 1);
  assert.equal(count(db, 'hq_activity_receipts', OTHER_COMPANY), 1);

  // A duplicate in one company does not touch the other company's state row.
  const otherHigh = db.prepare('SELECT high_seq FROM hq_activity_state WHERE company_id = ?').get(OTHER_COMPANY) as { high_seq: number };
  assert.equal(append(db, stableEvent('activity:t1')).status, 'duplicate');
  assert.equal(
    (db.prepare('SELECT high_seq FROM hq_activity_state WHERE company_id = ?').get(OTHER_COMPANY) as { high_seq: number }).high_seq,
    otherHigh.high_seq,
  );
});
