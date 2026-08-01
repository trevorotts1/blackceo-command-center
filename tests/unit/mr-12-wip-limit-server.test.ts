/**
 * MR-12 — server-side WIP limit enforcement.
 *
 * The board's per-column WIP limits (in_progress=5, review=8) were originally
 * enforced ONLY in the UI (MissionQueue drag-over rejection + the touch Move
 * menu). This suite proves the limit is now ALSO enforced at the authoritative
 * status funnel, transition() in src/lib/task-lifecycle.ts, so a caller that
 * bypasses the drag affordance (e.g. PATCH /api/tasks/{id}) cannot overflow a
 * capped column.
 *
 * Cases:
 *   1. moving a task INTO a full 'in_progress' column → WIP_LIMIT (no write)
 *   2. the same move WITH operatorOverride → allowed (deliberate override)
 *   3. moving a task INTO a 'review' column with capacity → allowed
 *   4. an UNCAPPED target ('blocked') is never WIP-limited
 *   5. an idempotent / intra-column move is not double-counted against itself
 *
 * Strategy mirrors task-status-transition.test.ts: point DATABASE_PATH at a
 * throwaway temp file BEFORE @/lib/db is imported (dynamic import in
 * test.before), run the full migration chain, seed fixtures, then drive the
 * real transition().
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ── Isolated DB (set BEFORE @/lib/db is imported) ────────────────────────────
const TMP_DB = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'bc-mr12-wip-')),
  'mission-control.test.db',
);
process.env.DATABASE_PATH = TMP_DB;

const RUN_ID = Math.random().toString(36).slice(2, 10);
const WS_ID = `ws-mr12-${RUN_ID}`;

type DbModule = typeof import('../../src/lib/db');
let run: DbModule['run'];
let queryOne: DbModule['queryOne'];
let closeDb: DbModule['closeDb'];

type LifecycleModule = typeof import('../../src/lib/task-lifecycle');
let transition: LifecycleModule['transition'];
let TransitionError: LifecycleModule['TransitionError'];

const now = new Date().toISOString();

/** Insert a task at a given status (raw INSERT — no lifecycle preconditions).
 * assigned_agent_id is left NULL: the WIP check runs BEFORE the agent
 * preconditions in transition(), so the capped-column refusals below are
 * decided on the column count alone, and the uncapped/override cases target
 * statuses with no agent precondition. */
function seedTask(id: string, status: string): void {
  run(
    `INSERT INTO tasks (id, title, description, status, priority, workspace_id, business_id, created_at, updated_at)
     VALUES (?, ?, 'seed', ?, 'high', ?, 'default', ?, ?)`,
    [id, `MR-12 ${id}`, status, WS_ID, now, now],
  );
}

function statusOf(id: string): string | undefined {
  return queryOne<{ status: string }>('SELECT status FROM tasks WHERE id = ?', [id])?.status;
}

function countByStatus(status: string): number {
  return queryOne<{ n: number }>('SELECT COUNT(*) AS n FROM tasks WHERE status = ?', [status])?.n ?? 0;
}

/** Empty the review bucket so bucket-level cases are deterministic regardless
 * of what earlier tests seeded (shared temp DB). Leftover review/testing tasks
 * are moved to 'done' (an uncapped, out-of-bucket status) via UPDATE rather
 * than DELETE, so the many FK child rows written by earlier transition() calls
 * are never orphaned. */
function clearReviewBucket(): void {
  run(`UPDATE tasks SET status = 'done' WHERE status IN ('review', 'testing')`);
}

test.before(async () => {
  const db = (await import('../../src/lib/db')) as DbModule;
  run = db.run;
  queryOne = db.queryOne;
  closeDb = db.closeDb;
  db.getDb(); // runs the full migration chain against the temp DB

  // FK parents: company → workspace.
  run(
    `INSERT OR IGNORE INTO companies (id, name, slug, config, created_at, updated_at)
     VALUES ('default', 'Default', 'default', '{}', ?, ?)`,
    [now, now],
  );
  run(
    `INSERT OR IGNORE INTO workspaces (id, slug, name, icon, company_id, sort_order, created_at, updated_at)
     VALUES (?, ?, 'MR-12 WIP', '🧪', 'default', 1, ?, ?)`,
    [WS_ID, `mr12-wip-${RUN_ID}`, now, now],
  );

  const lc = (await import('../../src/lib/task-lifecycle')) as LifecycleModule;
  transition = lc.transition;
  TransitionError = lc.TransitionError;
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

// ── 1. moving INTO a full 'in_progress' column → WIP_LIMIT (no write) ────────
test('transition into a full in_progress column is refused with WIP_LIMIT', async () => {
  // Fill the in_progress column to its limit (5).
  for (let i = 0; i < 5; i++) seedTask(`mr12-ip-fill-${RUN_ID}-${i}`, 'in_progress');
  assert.equal(countByStatus('in_progress'), 5, 'precondition: 5 in_progress tasks');

  // A task sitting in backlog that we try to move into the full column.
  const mover = `mr12-ip-mover-${RUN_ID}`;
  seedTask(mover, 'backlog');

  await assert.rejects(
    () => transition(mover, 'in_progress', { actor: 'test' }),
    (err: unknown) =>
      err instanceof TransitionError && err.code === 'WIP_LIMIT',
    'moving into a full in_progress column must throw WIP_LIMIT',
  );

  assert.equal(statusOf(mover), 'backlog', 'the refused move must not change the task status');
  assert.equal(countByStatus('in_progress'), 5, 'the column must not overflow');
});

// ── 2. the same move WITH operatorOverride → allowed ─────────────────────────
test('operatorOverride exceeds the WIP limit deliberately', async () => {
  const mover = `mr12-ip-override-${RUN_ID}`;
  seedTask(mover, 'backlog');

  const updated = await transition(mover, 'in_progress', { actor: 'operator', operatorOverride: true });
  assert.equal(updated.status, 'in_progress', 'operatorOverride must allow exceeding the limit');
  assert.equal(statusOf(mover), 'in_progress', 'the override move must persist');
});

// ── 3. moving INTO a 'review' column with capacity → allowed ─────────────────
test('transition into a review column under its limit is allowed', async () => {
  // review column limit is 8 (review + testing bucket). Seed a few, stay under.
  for (let i = 0; i < 3; i++) seedTask(`mr12-rv-fill-${RUN_ID}-${i}`, 'review');

  const mover = `mr12-rv-mover-${RUN_ID}`;
  seedTask(mover, 'in_progress');

  const updated = await transition(mover, 'review', { actor: 'test' });
  assert.equal(updated.status, 'review', 'a review column with capacity must accept the move');
});

// ── 4. an UNCAPPED target is never WIP-limited ───────────────────────────────
test('transition into an uncapped column (blocked) is never WIP-limited', async () => {
  const mover = `mr12-bl-mover-${RUN_ID}`;
  seedTask(mover, 'in_progress');

  const updated = await transition(mover, 'blocked', { actor: 'test' });
  assert.equal(updated.status, 'blocked', 'blocked has no WIP limit and must be allowed');
});

// ── 5. intra-column move is not double-counted against itself ────────────────
test('a task already in the column is not counted against its own move', async () => {
  clearReviewBucket();
  // Fill the review bucket to exactly the limit (8) using review + testing,
  // where the mover is one of the 8.
  for (let i = 0; i < 4; i++) seedTask(`mr12-bucket-a-${RUN_ID}-${i}`, 'review');
  for (let i = 0; i < 3; i++) seedTask(`mr12-bucket-b-${RUN_ID}-${i}`, 'testing');
  const mover = `mr12-bucket-mover-${RUN_ID}`;
  seedTask(mover, 'review');
  // Bucket holds 8 (the limit); the mover is one of them.

  const updated = await transition(mover, 'testing', { actor: 'test' });
  assert.equal(
    updated.status,
    'testing',
    'review→testing stays within the same capped bucket and must not be refused (mover excluded from its own count)',
  );
});

// ── 6. a DIRECT move to 'testing' is gated by the same review-column limit ──
test('a direct move into testing is refused when the review bucket is full', async () => {
  clearReviewBucket();
  // Fill the bucket to exactly the limit (8) with tasks that are NOT the mover.
  for (let i = 0; i < 5; i++) seedTask(`mr12-full-a-${RUN_ID}-${i}`, 'review');
  for (let i = 0; i < 3; i++) seedTask(`mr12-full-b-${RUN_ID}-${i}`, 'testing');

  // A fresh task OUTSIDE the bucket trying to enter via 'testing' must be
  // refused — proving the limit is keyed on the whole bucket, not just 'review'.
  const mover = `mr12-testing-mover-${RUN_ID}`;
  seedTask(mover, 'in_progress');

  await assert.rejects(
    () => transition(mover, 'testing', { actor: 'test' }),
    (err: unknown) => err instanceof TransitionError && err.code === 'WIP_LIMIT',
    'a direct move into a full review bucket (via testing) must throw WIP_LIMIT',
  );
  assert.equal(statusOf(mover), 'in_progress', 'the refused move must not change the task status');
});
