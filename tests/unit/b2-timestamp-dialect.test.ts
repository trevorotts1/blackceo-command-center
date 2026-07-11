/**
 * b2-timestamp-dialect.test.ts — the timestamp-dialect fix (finding B2).
 *
 * mission-control.db stores timestamps in TWO dialects in the same TEXT columns:
 *   • ISO-8601 'T'…'Z'      — new Date().toISOString()  (Node writers)
 *   • SQLite space-separated — datetime('now')          (SQL writers)
 *
 * A naive TEXT compare `col >= datetime('now', …)` is WRONG because 'T' (0x54)
 * sorts after ' ' (0x20) at index 10, so an ISO-'T' value always compares
 * "greater" than a space-format bound — every time window degenerates.
 *
 * These tests PROVE:
 *   1. the raw bug (unnormalized compare returns the wrong answer);
 *   2. sqlTime() normalization fixes it for BOTH dialects;
 *   3. parseDbTime() parses both dialects to the SAME UTC instant;
 *   4. the stale-task sweep detects staleness correctly regardless of dialect
 *      (exercises both the SQL predicate AND the JS age math end-to-end).
 *
 *   DATABASE_PATH=/tmp/x node --import tsx --test tests/unit/b2-timestamp-dialect.test.ts
 */

import './_isolated-db'; // MUST be first.
import test from 'node:test';
import assert from 'node:assert/strict';
import { v4 as uuidv4 } from 'uuid';
import { getDb, run, queryOne, sqlTime, parseDbTime, timeNow } from '../../src/lib/db';
import { runStaleTaskSweep } from '../../src/lib/jobs/stale-task-sweep';

// Keep the sweep's notify path silent + local.
process.env.OWNER_NOTIFY_TELEGRAM_DISABLED = '1';
delete process.env.RESCUE_RANGERS_WEBHOOK_URL;
delete process.env.DISABLE_STALE_TASK_SWEEP;

const db = getDb();

function spaceFormat(msAgo: number): string {
  // SQLite 'YYYY-MM-DD HH:MM:SS' (UTC), no 'T', no 'Z'.
  return new Date(Date.now() - msAgo).toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
}
function isoFormat(msAgo: number): string {
  return new Date(Date.now() - msAgo).toISOString();
}

test('B2: the raw unnormalized compare is WRONG; sqlTime() fixes it', () => {
  // An 18:40 instant must NOT be >= a 23:58 instant. The naive TEXT compare says
  // it IS (the dialect bug); the sqlTime-wrapped compare says it is NOT.
  const iso = '2026-07-10T18:40:29.584Z';
  const spaceBound = '2026-07-10 23:58:00';

  const rawWrong = queryOne<{ v: number }>(
    `SELECT (? >= ?) AS v`,
    [iso, spaceBound],
  );
  assert.equal(rawWrong?.v, 1, 'reproduces the bug: naive TEXT compare returns 1 (wrong)');

  const fixed = queryOne<{ v: number }>(
    `SELECT (${sqlTime('?')} >= ${sqlTime('?')}) AS v`,
    [iso, spaceBound],
  );
  assert.equal(fixed?.v, 0, 'sqlTime normalization: 18:40 is correctly NOT >= 23:58');
});

test('B2: sqlTime() window selects correctly across both dialects', () => {
  // A 10-minute window: rows 2 min old (both dialects) are IN; rows 40 min old
  // (both dialects) are OUT — regardless of which dialect stored them.
  const cases = [
    { label: 'iso-fresh', ts: isoFormat(2 * 60_000), inWindow: true },
    { label: 'space-fresh', ts: spaceFormat(2 * 60_000), inWindow: true },
    { label: 'iso-old', ts: isoFormat(40 * 60_000), inWindow: false },
    { label: 'space-old', ts: spaceFormat(40 * 60_000), inWindow: false },
  ];
  for (const c of cases) {
    const row = queryOne<{ v: number }>(
      `SELECT (${sqlTime('?')} >= datetime('now','-10 minutes')) AS v`,
      [c.ts],
    );
    assert.equal(row?.v, c.inWindow ? 1 : 0, `${c.label} should be ${c.inWindow ? 'IN' : 'OUT'} of the 10-min window`);
  }
});

test('B2: parseDbTime() maps both dialects to the same UTC instant', () => {
  const isoMs = parseDbTime('2026-07-10T18:40:29Z');
  const spaceMs = parseDbTime('2026-07-10 18:40:29');
  assert.equal(Number.isNaN(isoMs), false, 'ISO parses');
  assert.equal(Number.isNaN(spaceMs), false, 'space parses');
  assert.equal(isoMs, spaceMs, 'both dialects → the SAME UTC epoch (space form is NOT misparsed as local)');
  assert.equal(isoMs, Date.UTC(2026, 6, 10, 18, 40, 29), 'parsed as UTC');
  assert.ok(Number.isNaN(parseDbTime(null)) && Number.isNaN(parseDbTime('')), 'empty → NaN');
});

test('B2 end-to-end: stale sweep detects staleness in BOTH dialects, spares fresh', async () => {
  const wsId = `ws-${uuidv4()}`;
  run('INSERT INTO workspaces (id, name, slug, sort_order) VALUES (?, ?, ?, 900)', [wsId, 'B2 WS', `b2-${uuidv4().slice(0, 8)}`]);

  // review threshold default = 12h. Two stale review tasks (20h) in each dialect,
  // one fresh review task (1h) — none carry a QC-parked marker, so the only thing
  // deciding their fate is the timestamp math the B2 fix corrects.
  const mk = (ts: string): string => {
    const id = uuidv4();
    run(
      `INSERT INTO tasks (id, title, status, workspace_id, updated_at, last_progress_at)
       VALUES (?, ?, 'review', ?, ?, ?)`,
      [id, `B2 task ${ts}`, wsId, ts, ts],
    );
    return id;
  };
  const staleIso = mk(isoFormat(20 * 60 * 60 * 1000));
  const staleSpace = mk(spaceFormat(20 * 60 * 60 * 1000));
  const freshSpace = mk(spaceFormat(1 * 60 * 60 * 1000));

  const res = await runStaleTaskSweep();
  assert.ok(res.returned >= 2, 'both stale review tasks were returned to orchestrator');

  const statusOf = (id: string) => queryOne<{ status: string }>('SELECT status FROM tasks WHERE id = ?', [id])?.status;
  assert.equal(statusOf(staleIso), 'backlog', 'ISO-dialect stale review task returned to backlog');
  assert.equal(statusOf(staleSpace), 'backlog', 'space-dialect stale review task returned to backlog (was invisible before the fix)');
  assert.equal(statusOf(freshSpace), 'review', 'fresh review task (1h) left untouched');
});

test('B2: timeNow() is the canonical ISO-UTC write format', () => {
  const now = timeNow();
  assert.match(now, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, 'ISO-8601 UTC with T and Z');
});
