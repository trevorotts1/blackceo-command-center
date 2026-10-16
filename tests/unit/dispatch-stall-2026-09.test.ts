/**
 * dispatch-stall-2026-09.test.ts — the two REPO-testable legs of the live
 * dispatch-stall fix (the third, execution quarantine expiry, is locked in
 * tests/unit/execution-attempt-ownership.test.ts next to its siblings).
 *
 *   A. persona blend backfill is RETRYABLE.
 *      The `blend_backfilled` marker used to exclude a task from the pool
 *      forever. A blend attempt that FAILED (selector timeout) therefore left
 *      the content task with no `task_persona_bundle` row, which made
 *      checkPersonaDispatchReady return `persona_bundle_required` on every
 *      dispatch tick for the life of the box. The exclusion is now windowed by
 *      PERSONA_BACKFILL_RETRY_HOURS (default 6): a recent marker still
 *      suppresses, an old one is retried.
 *
 *   C. matchSkillsForTask's embedding call is CACHED.
 *      Every dispatch re-embedded the task text plus `name. description` for
 *      EVERY installed SKILL.md. The Google provider embeds sequentially with a
 *      250 ms sleep per text, so ~80 skills cost ~40 s per dispatch and blew the
 *      90 s job lease (`scheduler_lease_lost`). embedTextsCached() keeps a
 *      process-lifetime sha256(text) → vector map, so only NEW texts are fetched.
 *
 * Runs via the Node built-in test runner under tsx (`npm run test:unit`).
 *   node --import tsx --test tests/unit/dispatch-stall-2026-09.test.ts
 */

import './_isolated-db'; // MUST be the first DB-reaching import (C8 guard).
import test from 'node:test';
import assert from 'node:assert/strict';
import { v4 as uuidv4 } from 'uuid';
import { getDb, run, queryOne } from '../../src/lib/db';
import { runPersonaBlendBackfill } from '../../src/lib/jobs/persona-backfill-sweep';
import { embedTextsCached, clearEmbeddingCache } from '../../src/lib/context-pack';
import type { EmbeddingResult } from '../../src/lib/sop-embeddings';

getDb(); // apply the migration chain (tasks, events, task_persona_bundle).

const HOUR = 60 * 60 * 1000;
const hoursAgo = (h: number) => new Date(Date.now() - h * HOUR).toISOString();

/** A blend-shaped selector fixture: pins a persona AND returns a real bundle. */
const BUNDLE_FIXTURE = JSON.stringify({
  persona_id: 'shonda-rhimes',
  persona_name: 'Shonda Rhimes',
  score: 0.9,
  interaction_mode: 'leadership',
  mode: 'blend',
  content_task: true,
  topic: 'email marketing',
  blend_directive: "Write in Shonda Rhimes's VOICE while carrying Russell Brunson's EXPERTISE.",
  confirm_required: false,
  voice: {
    audience_persona: { id: 'shonda-rhimes', why: 'audience voice' },
    topic_persona: { id: 'russell-brunson', why: 'topic expertise' },
    collapsed: false,
    collapsed_persona_id: null,
  },
  resolved_audience: { source: 'onboarding_icp', confidence: 'high', candidates: ['black women'] },
  catalog_version: '1.3',
});

function seedContentTask(title: string): string {
  const id = uuidv4();
  const created = hoursAgo(48);
  run(
    `INSERT INTO tasks (id, title, description, status, department, workspace_id,
                        persona_id, blend_directive, created_at, updated_at, archived_at)
     VALUES (?, ?, NULL, 'in_progress', 'marketing', NULL, 'covey-7-habits', NULL, ?, ?, NULL)`,
    [id, title, created, created],
  );
  return id;
}

function seedBackfillMarker(taskId: string, createdAt: string): void {
  run(`INSERT INTO events (id, type, task_id, message, created_at) VALUES (?, 'blend_backfilled', ?, 'prior attempt', ?)`, [
    uuidv4(),
    taskId,
    createdAt,
  ]);
}

const directiveOf = (taskId: string): string | null =>
  queryOne<{ blend_directive: string | null }>('SELECT blend_directive FROM tasks WHERE id = ?', [taskId])
    ?.blend_directive ?? null;

// ── A. backfill retry window ────────────────────────────────────────────────

test('backfill: a FAILED blend attempt is retried once the retry window elapses', async () => {
  // Only this test's rows are in the pool (the sweep skips archived tasks).
  run(`UPDATE tasks SET archived_at = ? WHERE archived_at IS NULL`, [new Date().toISOString()]);
  const graceCutoff = new Date().toISOString();

  const recent = seedContentTask('write a marketing email for the spring launch');
  seedBackfillMarker(recent, hoursAgo(1)); // inside the 6h window → still excluded
  const stale = seedContentTask('write a promotional email for the summer launch');
  seedBackfillMarker(stale, hoursAgo(30)); // past the window → retried

  process.env.PERSONA_FIXTURE_JSON = BUNDLE_FIXTURE;
  let result;
  try {
    result = await runPersonaBlendBackfill(10, graceCutoff);
  } finally {
    delete process.env.PERSONA_FIXTURE_JSON;
  }

  assert.equal(result.blendScanned, 1, 'only the task past the retry window re-enters the pool');
  assert.equal(result.blendBackfilled, 1, 'the retried task acquired a blend directive');
  assert.ok(directiveOf(stale), 'the stalled task was healed on the retry');
  assert.equal(directiveOf(recent), null, 'a just-attempted task is not re-attempted');

  // The retry stamps a SECOND marker (the audit trail shows both attempts).
  const markers = queryOne<{ n: number }>(
    `SELECT COUNT(*) AS n FROM events WHERE task_id = ? AND type = 'blend_backfilled'`,
    [stale],
  );
  assert.equal(markers?.n, 2);
});

test('backfill: PERSONA_BACKFILL_RETRY_HOURS widens the window (old never-retry behavior)', async () => {
  run(`UPDATE tasks SET archived_at = ? WHERE archived_at IS NULL`, [new Date().toISOString()]);
  const graceCutoff = new Date().toISOString();

  const stale = seedContentTask('write a launch announcement email');
  seedBackfillMarker(stale, hoursAgo(30));

  process.env.PERSONA_BACKFILL_RETRY_HOURS = '87600'; // 10 years ≈ never
  process.env.PERSONA_FIXTURE_JSON = BUNDLE_FIXTURE;
  let result;
  try {
    result = await runPersonaBlendBackfill(10, graceCutoff);
  } finally {
    delete process.env.PERSONA_BACKFILL_RETRY_HOURS;
    delete process.env.PERSONA_FIXTURE_JSON;
  }

  assert.equal(result.blendScanned, 0, 'a wide retry window keeps the marker permanent');
  assert.equal(directiveOf(stale), null);
});

// ── C. skill-embedding cache ────────────────────────────────────────────────

/** Fake embedder: records every batch it is asked for, vector = [len, code]. */
function recordingFetcher(batches: string[][]) {
  return async (texts: string[]): Promise<EmbeddingResult[]> => {
    batches.push([...texts]);
    return texts.map((t, index) => ({ index, embedding: [t.length, t.charCodeAt(0)] }));
  };
}

test('embed cache: only texts never seen before are sent to the embedder', async () => {
  clearEmbeddingCache();
  const batches: string[][] = [];
  const fetcher = recordingFetcher(batches);

  const skillA = 'agw-ledger-tick. The 5-minute mechanical heartbeat.';
  const skillB = 'fleet-roll. Roll the update across every box.';

  const first = await embedTextsCached(['task one', skillA, skillB], fetcher);
  assert.deepEqual(batches, [['task one', skillA, skillB]], 'cold cache embeds everything once');
  assert.deepEqual(first, [
    [8, 't'.charCodeAt(0)],
    [skillA.length, skillA.charCodeAt(0)],
    [skillB.length, skillB.charCodeAt(0)],
  ]);

  const second = await embedTextsCached(['task two', skillA, skillB], fetcher);
  assert.equal(batches.length, 2, 'a second call still hits the embedder…');
  assert.deepEqual(batches[1], ['task two'], '…but ONLY for the text it has never seen');
  // Cached vectors come back in the caller's order, unchanged.
  assert.deepEqual(second?.[1], [skillA.length, skillA.charCodeAt(0)]);
  assert.deepEqual(second?.[2], [skillB.length, skillB.charCodeAt(0)]);

  // A repeated text inside ONE call is fetched once, not twice.
  const third = await embedTextsCached(['brand new', 'brand new'], fetcher);
  assert.deepEqual(batches[2], ['brand new']);
  assert.deepEqual(third, [
    ['brand new'.length, 'b'.charCodeAt(0)],
    ['brand new'.length, 'b'.charCodeAt(0)],
  ]);
});

test('embed cache: a short batch from the provider degrades to null (keyword fallback)', async () => {
  clearEmbeddingCache();
  const short = async (): Promise<EmbeddingResult[]> => [{ index: 0, embedding: [1] }];
  assert.equal(await embedTextsCached(['a', 'b'], short), null);
});
