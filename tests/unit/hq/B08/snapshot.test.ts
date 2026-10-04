/**
 * B08 (milestone V08) — authorized state snapshot: Q08 transaction-consistent
 * snapshot, no false empty state, scoped rows and validated reset conditions.
 *
 * Isolated database first, before anything that could open one (qc.md Q1):
 * `_isolated-db` points DATABASE_PATH at a throwaway temp file and the receipt
 * records the resolved path.
 *
 * FIXTURE STUB, STATED NOT HIDDEN: base `hq/contracts` carries only P01's frozen
 * `types.ts`. B01's reserved migration `169` (the `hq_*` tables) is committed on
 * its own branch and is not in this tree, so the three tables this unit reads
 * are created here with the EXACT S6 DDL from `evidence/contracts/storage-auth.md`
 * — the frozen contract this unit builds against. This is the documented
 * "private test stub for an absent implementation" that `swarm-plan.json`
 * `base_policy` allows; it is not shipped code and it is not a second source of
 * truth: the column names below are the frozen ones, and B01's decoder output is
 * structurally assignable to the row types this module declares.
 *
 * The layout builder and the public-projection function are injected stubs for
 * the same reason (B04/B05 own them). Their real behavior is covered by their
 * own units; what is asserted here is that this unit passes the right facts into
 * them and surfaces their results faithfully.
 */
import '../../_isolated-db';
import assert from 'node:assert/strict';
import test from 'node:test';
import type Database from 'better-sqlite3';
import { getDb, getDbPath } from '../../../../src/lib/db';
import type { HqActivityEvent, HqDepartment } from '../../../../src/lib/hq/types';
import {
  deriveHqTaskLinks,
  HQ_CAPTURE_STATE_UNREPORTED,
  HQ_SNAPSHOT_FEED_SIZE,
  isHqCursor,
  loadHqSnapshot,
  parseHqSnapshotCursor,
  resolveHqSnapshotFeedPlan,
  summarizeHqCaptureHealth,
  type HqSnapshotActivityRow,
  type HqSnapshotDeps,
  type HqSnapshotLayoutInput,
} from '../../../../src/lib/hq/snapshot';

/* ------------------------------------------------------------------ *
 * Fixture: the frozen S6 tables (stub for B01 migration 169)
 * ------------------------------------------------------------------ */

function createHqTables(db: Database.Database): void {
  db.exec(`
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
      payload_bytes INTEGER NOT NULL DEFAULT 0,
      UNIQUE(company_id, source_key)
    )`);
  db.exec(`
    CREATE TABLE IF NOT EXISTS hq_activity_state (
      company_id TEXT PRIMARY KEY,
      high_seq INTEGER NOT NULL,
      pruned_through_seq INTEGER NOT NULL,
      capture_state TEXT NOT NULL,
      retained_bytes INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    )`);
}

/**
 * The roster/scoping tables (`companies`, `workspaces`, `agents`) are the REAL
 * existing schema — `getDb()` ran the real migrations before this fixture, so
 * rows are inserted with the columns that schema requires (`slug`, `role`), not
 * into a second invented shape. Rows are removed again by `clearCompany`.
 */
function seedCompanies(db: Database.Database, companyId: string): void {
  db.prepare('INSERT OR IGNORE INTO companies (id, name, slug) VALUES (?, ?, ?)')
    .run(companyId, `Company ${companyId}`, `company-${companyId}`);
  db.prepare('INSERT OR IGNORE INTO workspaces (id, name, slug, company_id) VALUES (?, ?, ?, ?)')
    .run(`ws-${companyId}`, `Workspace ${companyId}`, `ws-${companyId}`, companyId);
  db.prepare('INSERT OR IGNORE INTO agents (id, name, role, workspace_id) VALUES (?, ?, ?, ?)')
    .run(`agent-${companyId}`, `Agent ${companyId}`, 'head', `ws-${companyId}`);
}

let seqSeed = 0;
function appendRow(
  db: Database.Database,
  row: Partial<HqSnapshotActivityRow> & { company_id: string },
): number {
  seqSeed += 1;
  const info = db
    .prepare(
      `INSERT INTO hq_activity
         (id, company_id, source_key, content_hash, kind, task_id, actor_agent_id, recipient_agent_id,
          exchange_id, phase, payload_json, occurred_at, received_at, payload_bytes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, NULL, ?, ?)`,
    )
    .run(
      row.id ?? `evt-${seqSeed}`,
      row.company_id,
      row.source_key ?? `key-${seqSeed}`,
      row.content_hash ?? 'hash',
      row.kind ?? 'task',
      row.task_id ?? null,
      row.actor_agent_id ?? null,
      row.recipient_agent_id ?? null,
      row.phase ?? 'created',
      row.payload_json ?? '{"status":"done","previousStatus":null}',
      '2026-10-04T00:00:00Z',
      10,
    );
  return Number(info.lastInsertRowid);
}

/** Deletes this test file's rows so the shared isolated DB stays reusable. */
function clearCompany(db: Database.Database, companyId: string): void {
  db.prepare('DELETE FROM hq_activity WHERE company_id = ?').run(companyId);
  db.prepare('DELETE FROM hq_activity_state WHERE company_id = ?').run(companyId);
  db.prepare('DELETE FROM agents WHERE id = ?').run(`agent-${companyId}`);
  db.prepare('DELETE FROM workspaces WHERE id = ?').run(`ws-${companyId}`);
  db.prepare('DELETE FROM companies WHERE id = ?').run(companyId);
}

/* ------------------------------------------------------------------ *
 * Injected collaborators (B04 / B05 stubs)
 * ------------------------------------------------------------------ */

type Captured = { layoutInputs: HqSnapshotLayoutInput[] };

function makeDeps(captured: Captured): HqSnapshotDeps {
  return {
    buildLayout: async (roster) => {
      captured.layoutInputs.push(roster);
      return { revision: 'rev-fixture', rooms: [] };
    },
    projectEvent: (row, resolveLabel): HqActivityEvent => ({
      id: row.id,
      seq: row.seq,
      kind: row.kind,
      phase: row.phase as HqActivityEvent['phase'],
      taskId: row.task_id ?? null,
      actorLabel: row.actor_agent_id ? resolveLabel(row.actor_agent_id) : null,
      recipientLabel: row.recipient_agent_id ? resolveLabel(row.recipient_agent_id) : null,
      occurredAt: row.occurred_at ?? null,
      receivedAt: row.received_at,
      reference: row.source_key,
      payload: { status: 'done', previousStatus: null },
    }),
  };
}

const emptyRoster: HqDepartment[] = [];

test('isolated database is real: the snapshot reads the resolved temp DB, not the live one', () => {
  const path = getDbPath();
  assert.ok(path.length > 0);
  assert.ok(!path.endsWith('mission-control.db'), `refusing to test against a live-looking DB: ${path}`);
  console.error(`[B08 receipt] resolved DATABASE_PATH = ${path}`);
});

/* ------------------------------------------------------------------ *
 * Pure helpers — feed plan and cursor validation
 * ------------------------------------------------------------------ */

test('resolveHqSnapshotFeedPlan: first visit initializes the feed at highSeq and labels it recent', () => {
  const plan = resolveHqSnapshotFeedPlan({ previousCursor: null, highSeq: 42, prunedThroughSeq: 0 });
  assert.deepEqual(plan, { feedStart: 'recent', feedCursor: 42, resetRequired: false });
});

test('resolveHqSnapshotFeedPlan: a live cursor is preserved, never jumped to highSeq', () => {
  const plan = resolveHqSnapshotFeedPlan({ previousCursor: 10, highSeq: 42, prunedThroughSeq: 0 });
  assert.deepEqual(plan, { feedStart: 'resumed', feedCursor: 10, resetRequired: false });
});

test('resolveHqSnapshotFeedPlan: cursor below the pruned watermark resets; gaps alone never do', () => {
  const expired = resolveHqSnapshotFeedPlan({ previousCursor: 4, highSeq: 90, prunedThroughSeq: 5 });
  assert.equal(expired.resetRequired, true);
  assert.equal(expired.feedStart, 'recent');
  assert.equal(expired.feedCursor, 90);
  // Legal global seq gap with a cursor inside the retained window: NO reset (S8 step 5).
  const gap = resolveHqSnapshotFeedPlan({ previousCursor: 3, highSeq: 90, prunedThroughSeq: 0 });
  assert.equal(gap.resetRequired, false);
  assert.equal(gap.feedCursor, 3);
  // Cursor exactly at the pruned boundary is retained history, not expired.
  const boundary = resolveHqSnapshotFeedPlan({ previousCursor: 5, highSeq: 90, prunedThroughSeq: 5 });
  assert.equal(boundary.resetRequired, false);
});

test('resolveHqSnapshotFeedPlan: a cursor newer than the server high-water mark resets (restore)', () => {
  const restored = resolveHqSnapshotFeedPlan({ previousCursor: 500, highSeq: 12, prunedThroughSeq: 0 });
  assert.equal(restored.resetRequired, true);
  assert.equal(restored.feedCursor, 12);
  assert.equal(restored.feedStart, 'recent');
});

test('parseHqSnapshotCursor: only nonnegative safe integers become a cursor', () => {
  assert.equal(parseHqSnapshotCursor('17'), 17);
  assert.equal(parseHqSnapshotCursor('0'), 0);
  assert.equal(parseHqSnapshotCursor(null), null);
  assert.equal(parseHqSnapshotCursor(''), null);
  assert.equal(parseHqSnapshotCursor('-1'), null);
  assert.equal(parseHqSnapshotCursor('1.5'), null);
  assert.equal(parseHqSnapshotCursor('abc'), null);
  assert.equal(parseHqSnapshotCursor('9007199254740993'), null);
  assert.equal(isHqCursor(Number.NaN), false);
});

/* ------------------------------------------------------------------ *
 * Capture health (G-01 freeze)
 * ------------------------------------------------------------------ */

test('captureHealth: an unreported capture state is never rendered as a healthy one', () => {
  const missing = summarizeHqCaptureHealth(null);
  assert.equal(missing.state, HQ_CAPTURE_STATE_UNREPORTED);
  assert.equal(missing.reported, false);
  assert.equal(missing.updatedAt, null);
  assert.equal(missing.retainedBytes, null);
  const blank = summarizeHqCaptureHealth({
    company_id: 'c', high_seq: 0, pruned_through_seq: 0, capture_state: '   ', retained_bytes: 0, updated_at: 't',
  });
  assert.equal(blank.reported, false);
  const degraded = summarizeHqCaptureHealth({
    company_id: 'c', high_seq: 9, pruned_through_seq: 2, capture_state: 'degraded', retained_bytes: 4096,
    updated_at: '2026-10-04T00:00:00Z',
  });
  assert.deepEqual(degraded, {
    state: 'degraded', reported: true, updatedAt: '2026-10-04T00:00:00Z', retainedBytes: 4096,
  });
});

/* ------------------------------------------------------------------ *
 * Snapshot reads — one company scope, one transaction
 * ------------------------------------------------------------------ */

test('snapshot: rows of another company are never returned (scoped rows)', async () => {
  const db = getDb();
  createHqTables(db);
  seedCompanies(db, 'co-a');
  seedCompanies(db, 'co-b');
  clearCompany(db, 'co-a');
  clearCompany(db, 'co-b');
  appendRow(db, { company_id: 'co-a', task_id: 'task-a' });
  appendRow(db, { company_id: 'co-b', task_id: 'task-b' });
  appendRow(db, { company_id: 'co-b', task_id: 'task-b2' });

  const snapshot = await loadHqSnapshot(db, { companyId: 'co-a', departments: emptyRoster }, makeDeps({ layoutInputs: [] }));
  assert.equal(snapshot.activities.length, 1);
  assert.equal(snapshot.activities[0].taskId, 'task-a');
  assert.ok(snapshot.taskLinks.every((link) => link.taskId !== 'task-b'));
  clearCompany(db, 'co-a');
  clearCompany(db, 'co-b');
});

test('snapshot: populated rows with no state row are NOT an empty company (no false empty state)', async () => {
  const db = getDb();
  createHqTables(db);
  seedCompanies(db, 'co-a');
  clearCompany(db, 'co-a');
  appendRow(db, { company_id: 'co-a' });
  appendRow(db, { company_id: 'co-a' });
  appendRow(db, { company_id: 'co-a' });
  const newest = appendRow(db, { company_id: 'co-a' });

  const snapshot = await loadHqSnapshot(db, { companyId: 'co-a', departments: emptyRoster }, makeDeps({ layoutInputs: [] }));
  assert.equal(snapshot.activities.length, 4);
  assert.equal(snapshot.highSeq, newest, 'highSeq must reflect the retained rows, never a fabricated 0');
  assert.ok(snapshot.highSeq > 0);
  assert.equal(snapshot.stateSeq, snapshot.highSeq);
  // The no-state-row fallback must agree with the cursor facts served beside it:
  // the plan is computed against the CLAMPED high-water mark, so a first visit
  // anchors the feed at the newest retained seq instead of a clamped-for-0 cursor.
  assert.equal(snapshot.feedCursor, snapshot.highSeq, 'first visit anchors the feed at the reported high-water mark');
  assert.equal(snapshot.feedStart, 'recent');
  assert.equal(snapshot.resetRequired, false, 'a missing state row is not a retention reset for a first visit');
  const newestCursor = await loadHqSnapshot(
    db,
    { companyId: 'co-a', departments: emptyRoster, previousCursor: newest },
    makeDeps({ layoutInputs: [] }),
  );
  assert.equal(newestCursor.feedStart, 'resumed', 'a cursor at the newest retained seq is a resume, not a reset');
  assert.equal(newestCursor.feedCursor, newest);
  assert.equal(newestCursor.resetRequired, false);
  assert.equal(snapshot.captureHealth.reported, false);
  assert.notEqual(snapshot.captureHealth.state, 'ok');
  clearCompany(db, 'co-a');
});

test('snapshot: a stale state row (high_seq behind the rows) never invalidates an in-window cursor', async () => {
  const db = getDb();
  createHqTables(db);
  seedCompanies(db, 'co-a');
  clearCompany(db, 'co-a');
  appendRow(db, { company_id: 'co-a' });
  const middle = appendRow(db, { company_id: 'co-a' });
  const newest = appendRow(db, { company_id: 'co-a' });
  // Stale state row: high_seq=2 while retained rows reach seq 3.
  db.prepare(
    `INSERT INTO hq_activity_state (company_id, high_seq, pruned_through_seq, capture_state, retained_bytes, updated_at)
     VALUES ('co-a', ?, 0, 'ok', 0, '2026-10-04T00:00:00Z')`,
  ).run(middle);

  const snapshot = await loadHqSnapshot(
    db,
    { companyId: 'co-a', departments: emptyRoster, previousCursor: middle },
    makeDeps({ layoutInputs: [] }),
  );
  // The stale row must not shrink the served watermark nor fire a false reset.
  assert.equal(snapshot.highSeq, newest, 'the retained rows raise the reported high-water mark above the stale row');
  assert.equal(snapshot.resetRequired, false, 'a stale state row is not a cursor expiry');
  assert.equal(snapshot.feedStart, 'resumed');
  assert.equal(snapshot.feedCursor, middle, 'the client cursor is preserved against the clamped watermark');
  clearCompany(db, 'co-a');
});

test('snapshot: a company with no rows at all reports 0 honestly and reads no foreign row', async () => {
  const db = getDb();
  createHqTables(db);
  seedCompanies(db, 'co-empty');
  appendRow(db, { company_id: 'co-other' });
  clearCompany(db, 'co-empty');

  const snapshot = await loadHqSnapshot(db, { companyId: 'co-empty', departments: emptyRoster }, makeDeps({ layoutInputs: [] }));
  assert.equal(snapshot.activities.length, 0);
  assert.equal(snapshot.highSeq, 0);
  assert.equal(snapshot.prunedThroughSeq, 0);
  assert.equal(snapshot.resetRequired, false);
  clearCompany(db, 'co-other');
});

test('snapshot: state row supplies highSeq/prunedThroughSeq and the stored capture label verbatim', async () => {
  const db = getDb();
  createHqTables(db);
  seedCompanies(db, 'co-a');
  clearCompany(db, 'co-a');
  const newest = appendRow(db, { company_id: 'co-a' });
  db.prepare(
    `INSERT INTO hq_activity_state (company_id, high_seq, pruned_through_seq, capture_state, retained_bytes, updated_at)
     VALUES ('co-a', ?, 3, 'degraded', 2048, '2026-10-04T00:00:00Z')`,
  ).run(newest);

  const snapshot = await loadHqSnapshot(db, { companyId: 'co-a', departments: emptyRoster }, makeDeps({ layoutInputs: [] }));
  assert.equal(snapshot.highSeq, newest);
  assert.equal(snapshot.prunedThroughSeq, 3);
  assert.equal(snapshot.captureHealth.state, 'degraded');
  assert.equal(snapshot.captureHealth.reported, true);
  clearCompany(db, 'co-a');
});

test('snapshot: an expired cursor resets and the reset-reason flags are returned, not a misleading delta', async () => {
  const db = getDb();
  createHqTables(db);
  seedCompanies(db, 'co-a');
  clearCompany(db, 'co-a');
  const newest = appendRow(db, { company_id: 'co-a' });
  db.prepare(
    `INSERT INTO hq_activity_state (company_id, high_seq, pruned_through_seq, capture_state, retained_bytes, updated_at)
     VALUES ('co-a', ?, 999999, 'ok', 0, '2026-10-04T00:00:00Z')`,
  ).run(newest);

  const snapshot = await loadHqSnapshot(
    db,
    { companyId: 'co-a', departments: emptyRoster, previousCursor: 1 },
    makeDeps({ layoutInputs: [] }),
  );
  assert.equal(snapshot.resetRequired, true);
  assert.equal(snapshot.feedStart, 'recent');
  // prunedThroughSeq can never exceed the high-water mark it is reported beside.
  assert.equal(snapshot.prunedThroughSeq, newest);
  assert.equal(snapshot.feedCursor, newest);
  clearCompany(db, 'co-a');
});

test('snapshot: a resume preserves the client cursor and still returns rows ascending with legal seq gaps', async () => {
  const db = getDb();
  createHqTables(db);
  seedCompanies(db, 'co-a');
  clearCompany(db, 'co-a');
  const seqs = [appendRow(db, { company_id: 'co-a' }), appendRow(db, { company_id: 'co-a' }),
    appendRow(db, { company_id: 'co-a' }), appendRow(db, { company_id: 'co-a' })];
  // Delete the second row to create a LEGAL seq gap between retained rows.
  db.prepare('DELETE FROM hq_activity WHERE company_id = ? AND seq = ?').run('co-a', seqs[1]);
  db.prepare(
    `INSERT INTO hq_activity_state (company_id, high_seq, pruned_through_seq, capture_state, retained_bytes, updated_at)
     VALUES ('co-a', ?, 0, 'ok', 0, '2026-10-04T00:00:00Z')`,
  ).run(seqs[3]);

  const snapshot = await loadHqSnapshot(
    db,
    { companyId: 'co-a', departments: emptyRoster, previousCursor: seqs[0] },
    makeDeps({ layoutInputs: [] }),
  );
  assert.equal(snapshot.feedStart, 'resumed');
  assert.equal(snapshot.resetRequired, false);
  assert.equal(snapshot.feedCursor, seqs[0], 'a resume must never advance the client cursor');
  assert.deepEqual(snapshot.activities.map((event) => event.seq), [seqs[0], seqs[2], seqs[3]]);
  const ordered = snapshot.activities.map((event) => event.seq);
  assert.deepEqual(ordered, [...ordered].sort((left, right) => left - right));
  assert.ok(snapshot.activities.every((event) => event.seq <= snapshot.highSeq));
  clearCompany(db, 'co-a');
});

test('snapshot: the feed carries at most the latest 100 activities, ascending', async () => {
  const db = getDb();
  createHqTables(db);
  seedCompanies(db, 'co-a');
  clearCompany(db, 'co-a');
  for (let index = 0; index < HQ_SNAPSHOT_FEED_SIZE + 25; index += 1) appendRow(db, { company_id: 'co-a' });
  db.prepare(
    `INSERT INTO hq_activity_state (company_id, high_seq, pruned_through_seq, capture_state, retained_bytes, updated_at)
     SELECT 'co-a', MAX(seq), 0, 'ok', 0, '2026-10-04T00:00:00Z' FROM hq_activity WHERE company_id = 'co-a'`,
  ).run();

  const snapshot = await loadHqSnapshot(db, { companyId: 'co-a', departments: emptyRoster }, makeDeps({ layoutInputs: [] }));
  assert.equal(snapshot.activities.length, HQ_SNAPSHOT_FEED_SIZE);
  const seqs = snapshot.activities.map((event) => event.seq);
  assert.deepEqual(seqs, [...seqs].sort((left, right) => left - right), 'feed is ascending');
  assert.equal(seqs[seqs.length - 1], snapshot.highSeq);
  clearCompany(db, 'co-a');
});

/* ------------------------------------------------------------------ *
 * Collaborator seams and derived facts
 * ------------------------------------------------------------------ */

test('snapshot: layout is built from the caller roster and its revision is surfaced as layoutRevision', async () => {
  const db = getDb();
  createHqTables(db);
  seedCompanies(db, 'co-a');
  const captured: Captured = { layoutInputs: [] };
  const departments: HqDepartment[] = [{
    id: 'ws-co-a', slug: 'ws-co-a', name: 'Workspace co-a', headAgentId: null, provisioning: 'ready', agents: [],
  }];

  const snapshot = await loadHqSnapshot(
    db,
    { companyId: 'co-a', departments, masterWorkspaceId: 'ws-co-a', sortOrder: { 'ws-co-a': 5 } },
    makeDeps(captured),
  );
  assert.equal(snapshot.layout.revision, 'rev-fixture');
  assert.equal(captured.layoutInputs.length, 1);
  assert.equal(captured.layoutInputs[0].masterWorkspaceId, 'ws-co-a');
  assert.deepEqual(captured.layoutInputs[0].sortOrder, { 'ws-co-a': 5 });
  assert.equal(captured.layoutInputs[0].departments, departments);
});

test('taskLinks: derived only from in-scope activity references and roster task links', () => {
  const departments: HqDepartment[] = [{
    id: 'ws-1', slug: 'ws-1', name: 'One', headAgentId: 'agent-ws-1', provisioning: 'ready',
    agents: [{
      id: 'agent-ws-1', workspaceId: 'ws-1', displayName: 'Agent', role: 'head', isHead: true,
      staffing: 'permanent', runtimeBound: true, canTalk: true, runtimeAgentId: 'rt-1',
      bindingKind: 'explicit', sharedRoleIds: [], status: 'working', observedAt: null,
      activeTaskIds: ['task-roster'],
    }],
  }];
  const rows = [
    { task_id: 'task-roster', actor_agent_id: null },
    { task_id: 'task-actor', actor_agent_id: 'agent-ws-1' },
    { task_id: 'task-foreign-actor', actor_agent_id: 'agent-elsewhere' },
    { task_id: null, actor_agent_id: 'agent-ws-1' },
  ] as unknown as HqSnapshotActivityRow[];

  const links = deriveHqTaskLinks(departments, rows);
  assert.deepEqual(links.map((link) => link.taskId), ['task-actor', 'task-foreign-actor', 'task-roster']);
  assert.deepEqual(links.find((link) => link.taskId === 'task-roster'), {
    taskId: 'task-roster', workspaceId: 'ws-1', agentId: 'agent-ws-1',
  });
  assert.deepEqual(links.find((link) => link.taskId === 'task-actor'), {
    taskId: 'task-actor', workspaceId: 'ws-1', agentId: 'agent-ws-1',
  });
  // An actor outside the roster scope attaches no workspace rather than a guessed one.
  assert.deepEqual(links.find((link) => link.taskId === 'task-foreign-actor'), {
    taskId: 'task-foreign-actor', workspaceId: null, agentId: 'agent-elsewhere',
  });
  assert.equal(links.length, 3, 'a null task_id invents nothing');
});

test('snapshot: every returned event falls inside the reported cursor window', async () => {
  const db = getDb();
  createHqTables(db);
  seedCompanies(db, 'co-a');
  clearCompany(db, 'co-a');
  appendRow(db, { company_id: 'co-a' });
  appendRow(db, { company_id: 'co-a' });
  const snapshot = await loadHqSnapshot(db, { companyId: 'co-a', departments: emptyRoster }, makeDeps({ layoutInputs: [] }));
  assert.ok(snapshot.activities.every((event) => isHqCursor(event.seq) && event.seq <= snapshot.highSeq));
  assert.equal(snapshot.stateSeq, snapshot.highSeq, 'stateSeq is the snapshot freshness cursor');
  clearCompany(db, 'co-a');
});
