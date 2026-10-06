/**
 * Persona backfill × triad gate deadlock (2026-10-06).
 *
 * Live failure: a card whose create-time persona selection threw
 * (persona_company_context_missing) got its ONE once-ever backfill attempt,
 * failed, then the triad gate parked it `blocked / triad_incomplete` after 3
 * holds. The backfill sweep skipped `blocked` cards and never retried, so the
 * card sat forever while the stale sweep re-pinged the operator every day.
 *
 * Proves: the sweep re-tries a triad-parked persona-less card once the retry
 * window has elapsed, pins a persona, and releases it to backlog with its
 * dispatch budget reset — and leaves every other blocked card alone.
 */
import './_isolated-db'; // MUST be the first DB-reaching import (C8 guard).
import test from 'node:test';
import assert from 'node:assert/strict';
import { v4 as uuidv4 } from 'uuid';
import { getDb, run, queryOne } from '../../src/lib/db';
import { runPersonaBackfillSweep } from '../../src/lib/jobs/persona-backfill-sweep';

getDb();

const HOUR = 60 * 60 * 1000;
const hoursAgo = (h: number) => new Date(Date.now() - h * HOUR).toISOString();

const FIXTURE = JSON.stringify({
  persona_id: 'covey-7-habits',
  persona_name: 'Covey 7 Habits',
  score: 0.9,
  interaction_mode: 'leadership',
});

function seedBlocked(blockReason: string, markerHoursAgo: number): string {
  const id = uuidv4();
  const created = hoursAgo(72);
  run(
    `INSERT INTO tasks (id, title, description, status, department, workspace_id, persona_id,
                        block_reason, block_needs, block_audience, dispatch_attempts,
                        created_at, updated_at, archived_at)
     VALUES (?, 'Plan the quarterly budget review', NULL, 'blocked', 'finance-ops', NULL, NULL,
             ?, 'Missing: persona.', 'SYSTEM', 5, ?, ?, NULL)`,
    [id, blockReason, created, created],
  );
  run(`INSERT INTO events (id, type, task_id, message, created_at) VALUES (?, 'persona_backfill_attempt', ?, 'prior failed attempt', ?)`, [
    uuidv4(), id, hoursAgo(markerHoursAgo),
  ]);
  return id;
}

const card = (id: string) =>
  queryOne<{ status: string; persona_id: string | null; dispatch_attempts: number; block_reason: string | null }>(
    'SELECT status, persona_id, dispatch_attempts, block_reason FROM tasks WHERE id = ?',
    [id],
  )!;

test('backfill heals a triad-parked persona-less card and releases it to backlog', async () => {
  run(`UPDATE tasks SET archived_at = ? WHERE archived_at IS NULL`, [new Date().toISOString()]);

  const parked = seedBlocked('triad_incomplete', 30);   // failed attempt, window elapsed → heal
  const recent = seedBlocked('triad_incomplete', 1);    // inside the retry window → untouched
  const gateway = seedBlocked('gateway_down', 30);      // a different block → never touched

  process.env.PERSONA_FIXTURE_JSON = FIXTURE;
  let result;
  try {
    result = await runPersonaBackfillSweep();
  } finally {
    delete process.env.PERSONA_FIXTURE_JSON;
  }

  assert.equal(result.scanned, 1, 'only the triad-parked card past the retry window is scanned');
  assert.equal(result.pinned, 1);

  const healed = card(parked);
  assert.equal(healed.persona_id, 'covey-7-habits');
  assert.equal(healed.status, 'backlog', 'released out of blocked');
  assert.equal(healed.dispatch_attempts, 0, 'triad-hold attempts do not count against the dispatch cap');
  assert.equal(healed.block_reason, null);

  assert.equal(card(recent).status, 'blocked');
  assert.equal(card(recent).persona_id, null);
  assert.equal(card(gateway).status, 'blocked');
  assert.equal(card(gateway).persona_id, null);
});
