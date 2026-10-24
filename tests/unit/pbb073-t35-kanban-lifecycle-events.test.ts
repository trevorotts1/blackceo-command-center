/**
 * tests/unit/pbb073-t35-kanban-lifecycle-events.test.ts
 *
 * PBB-073 / T-35 — the Kanban board is bound to REAL lifecycle events
 * (`task_events`), and stale state is explicit instead of silent.
 *
 * Every case below runs against a THROWAWAY sqlite file created per-suite in
 * os.tmpdir(): the real `tasks` + `task_events` DDL, the real loader SQL, the
 * real projection. No live database is opened (the loader takes an injectable
 * query function, which is the ONLY reason this file can obey that rule).
 *
 *   (1) a normal transition MOVES the card — newest event wins over the
 *       stale `tasks.status` mirror;
 *   (2) a deleted source record is STALE (source_missing) with its last
 *       event time, never dropped;
 *   (3) a stalled event stream past the threshold is STALE
 *       (stream_stalled) with its last event time; a finished card is exempt;
 *   (4) an unknown event type is surfaced as UNKNOWN — no throw, no column
 *       invented, and the board routes it to the explicit attention lane.
 *
 *   node --import tsx --test tests/unit/pbb073-t35-kanban-lifecycle-events.test.ts
 */

import './_isolated-db'; // MUST be first DB import: throwaway DATABASE_PATH (C8 guard).
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_STALE_AFTER_MS,
  columnForLifecycleStatus,
  loadLifecycleEvents,
  newestEvent,
  parseEventTime,
  projectLifecycleCards,
  resolveStaleAfterMs,
  type LifecycleEventRow,
} from '../../src/lib/board/lifecycle-projection';
import { taskToColumnId, STALE_COLUMN_ID, carryForwardStaleCards } from '../../src/lib/board-projection';
import type { Task } from '../../src/lib/types';

const SIX_HOURS = 6 * 60 * 60 * 1000;

let root: string;
let db: Database.Database;

/** The REAL DDL shapes (src/lib/db/schema.ts) — only the columns we read. */
function createSchema(handle: Database.Database): void {
  handle.exec(`
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE task_events (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      from_status TEXT NOT NULL,
      to_status TEXT NOT NULL,
      actor TEXT,
      reason TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX idx_task_events_task_id ON task_events(task_id, created_at);
  `);
}

function seedTask(id: string, status: string): void {
  db.prepare('INSERT INTO tasks (id, title, status) VALUES (?, ?, ?)').run(id, `Task ${id}`, status);
}

function seedEvent(
  id: string,
  taskId: string,
  from: string,
  to: string,
  createdAt: string,
): void {
  db.prepare(
    'INSERT INTO task_events (id, task_id, from_status, to_status, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(id, taskId, from, to, createdAt);
}

/** The production loader SQL, executed against the throwaway file. */
function readEvents<T>(sql: string, params: unknown[] = []): T[] {
  return db.prepare(sql).all(...params) as T[];
}

function sourceRows(): { id: string; status: string }[] {
  return db.prepare('SELECT id, status FROM tasks ORDER BY id').all() as {
    id: string;
    status: string;
  }[];
}

test.before(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'pbb073-t35-kanban-'));
  db = new Database(path.join(root, 'throwaway.db'));
  createSchema(db);
});

test.after(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

test('(1) a normal transition moves the card — newest event wins over the status mirror', () => {
  seedTask('t1', 'backlog'); // mirror never caught up
  seedEvent('e1a', 't1', 'backlog', 'in_progress', '2026-10-24T08:00:00.000Z');
  seedEvent('e1b', 't1', 'in_progress', 'review', '2026-10-24T09:00:00.000Z');

  const events = loadLifecycleEvents(['t1'], readEvents);
  assert.equal(events.length, 2, 'both real events are read from the throwaway DB');

  const projection = projectLifecycleCards({
    tasks: sourceRows(),
    events,
    now: '2026-10-24T09:30:00.000Z',
    staleAfterMs: SIX_HOURS,
  });
  const card = projection.cards.get('t1')!;

  assert.equal(card.state, 'live');
  assert.equal(card.column, 'review', 'newest event (review) wins over tasks.status=backlog');
  assert.equal(card.last_event_at, '2026-10-24T09:00:00.000Z');
  assert.equal(card.last_event_id, 'e1b');
  assert.equal(taskToColumnId({ status: 'backlog', lifecycle: card }), 'review',
    'the BOARD places the card from the event, not the mirror');
});

test('(2) a deleted source record is STALE with its last event time, never dropped', () => {
  seedTask('gone-1', 'review');
  seedEvent('e2a', 'gone-1', 'review', 'done', '2026-10-24T07:15:00.000Z');

  // What the board rendered BEFORE the record was deleted.
  const before = projectLifecycleCards({
    tasks: [{ id: 'gone-1', status: 'review' }],
    events: loadLifecycleEvents(['gone-1'], readEvents),
    now: '2026-10-24T07:30:00.000Z',
    staleAfterMs: SIX_HOURS,
  });
  const liveCard = before.cards.get('gone-1')!;
  assert.equal(liveCard.state, 'live');
  assert.equal(liveCard.column, 'done');
  assert.equal(liveCard.last_event_at, '2026-10-24T07:15:00.000Z');

  const previousTask = { id: 'gone-1', lifecycle: liveCard } as unknown as Task;

  // The source record is DELETED — task_events cascades with it.
  db.prepare('DELETE FROM tasks WHERE id = ?').run('gone-1');
  assert.ok(!sourceRows().some((row) => row.id === 'gone-1'));
  assert.deepEqual(loadLifecycleEvents(['gone-1'], readEvents), [],
    'the event row cascaded with the source record');

  const carried = carryForwardStaleCards([previousTask], sourceRows() as unknown as Task[]);
  assert.equal(carried.length, 1, 'deleted card is CARRIED FORWARD, not dropped');
  const card = carried[0].lifecycle!;
  assert.equal(card.state, 'stale');
  assert.equal(card.stale_reason, 'source_missing');
  assert.equal(card.last_event_at, '2026-10-24T07:15:00.000Z',
    'the last event time the board observed survives the deletion');
  assert.equal(card.column, 'done', 'the last provable column is kept for the tooltip');
  assert.equal(taskToColumnId({ status: 'done', lifecycle: card }), STALE_COLUMN_ID,
    'the board shows it in the explicit stale lane, not its last column');

  // No-doubt case: the pure projection also flags a known-but-gone id.
  const projection = projectLifecycleCards({
    tasks: sourceRows(),
    events: [],
    knownCardIds: ['gone-1'],
    now: '2026-10-24T09:30:00.000Z',
  });
  assert.equal(projection.cards.get('gone-1')!.state, 'stale');
  assert.deepEqual(projection.missingSourceIds, ['gone-1']);
});

test('(3) a stalled stream past the threshold is STALE with its timestamp; done is exempt', () => {
  seedTask('t3', 'in_progress');
  seedEvent('e3a', 't3', 'assigned', 'in_progress', '2026-10-23T20:00:00.000Z'); // 13.5h ago

  seedTask('t3-done', 'done');
  seedEvent('e3b', 't3-done', 'review', 'done', '2026-10-20T00:00:00.000Z'); // days ago

  const now = '2026-10-24T09:30:00.000Z';
  const events = loadLifecycleEvents(['t3', 't3-done'], readEvents);
  const projection = projectLifecycleCards({
    tasks: sourceRows(),
    events,
    now,
    staleAfterMs: SIX_HOURS,
  });

  const stalled = projection.cards.get('t3')!;
  assert.equal(stalled.state, 'stale');
  assert.equal(stalled.stale_reason, 'stream_stalled');
  assert.equal(stalled.last_event_at, '2026-10-23T20:00:00.000Z',
    'the stamp shown is the REAL last event time');
  assert.equal(stalled.column, 'in_progress', 'the last provable column is kept for the tooltip');

  const finished = projection.cards.get('t3-done')!;
  assert.equal(finished.state, 'live', 'a terminal card is supposed to stop emitting');
  assert.equal(finished.column, 'done');

  // Just under the threshold is NOT stale.
  const fresh = projectLifecycleCards({
    tasks: [{ id: 't3', status: 'in_progress' }],
    events: events.filter((event) => event.task_id === 't3'),
    now: '2026-10-24T01:30:00.000Z', // 5.5h after the last event
    staleAfterMs: SIX_HOURS,
  });
  assert.equal(fresh.cards.get('t3')!.state, 'live');
});

test('(4) an unknown event type is surfaced as UNKNOWN — no throw, no invented column', () => {
  seedTask('t4', 'in_progress');
  seedEvent('e4a', 't4', 'in_progress', 'teleported', '2026-10-24T09:00:00.000Z');

  const events = loadLifecycleEvents(['t4'], readEvents);
  let projection: ReturnType<typeof projectLifecycleCards> | null = null;
  assert.doesNotThrow(() => {
    projection = projectLifecycleCards({
      tasks: sourceRows(),
      events,
      now: '2026-10-24T09:30:00.000Z',
      staleAfterMs: SIX_HOURS,
    });
  });

  const card = projection!.cards.get('t4')!;
  assert.equal(card.state, 'unknown');
  assert.equal(card.column, null, 'no column is invented for an unrecognised status');
  assert.equal(card.unknown_event_type, 'teleported');
  assert.equal(card.last_event_at, '2026-10-24T09:00:00.000Z');
  assert.equal(columnForLifecycleStatus('teleported'), null);
  assert.equal(taskToColumnId({ status: 'in_progress', lifecycle: card }), STALE_COLUMN_ID,
    'UNKNOWN is surfaced on the board, never dropped');
});

test('helpers: UTC-normalised timestamps, deterministic newest event, fail-closed threshold', () => {
  // SQLite `datetime('now')` has no zone; Date.parse would read it as LOCAL.
  assert.equal(parseEventTime('2026-10-24 09:00:00'), Date.parse('2026-10-24T09:00:00Z'));
  assert.equal(parseEventTime('2026-10-24T09:00:00.000Z'), Date.parse('2026-10-24T09:00:00.000Z'));
  assert.equal(parseEventTime('not-a-date'), null);

  const rows: LifecycleEventRow[] = [
    { id: 'b', task_id: 'x', from_status: 'a', to_status: 'in_progress', created_at: '2026-10-24 09:00:00' },
    { id: 'a', task_id: 'x', from_status: 'a', to_status: 'review', created_at: '2026-10-24 09:00:00' },
    { id: 'c', task_id: 'x', from_status: 'a', to_status: 'done', created_at: '2026-10-24T08:00:00.000Z' },
  ];
  assert.equal(newestEvent(rows)!.id, 'b', 'same-instant tie breaks on id, deterministically');

  assert.equal(resolveStaleAfterMs({} as NodeJS.ProcessEnv), DEFAULT_STALE_AFTER_MS);
  assert.equal(resolveStaleAfterMs({ KANBAN_EVENT_STALE_AFTER_HOURS: 'nope' } as NodeJS.ProcessEnv), DEFAULT_STALE_AFTER_MS);
  assert.equal(resolveStaleAfterMs({ KANBAN_EVENT_STALE_AFTER_HOURS: '-1' } as NodeJS.ProcessEnv), DEFAULT_STALE_AFTER_MS);
  assert.equal(resolveStaleAfterMs({ KANBAN_EVENT_STALE_AFTER_HOURS: '2' } as NodeJS.ProcessEnv), 2 * 60 * 60 * 1000);
});
