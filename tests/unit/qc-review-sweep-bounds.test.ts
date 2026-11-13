/**
 * U-19 — the QC review sweep must bound everything that repeats, and must talk
 * to a human in plain words.
 *
 * Pinned here:
 *   1. OWNER TEXT: a detected identical-result loop tells the owner what
 *      happened ("the same result 3 times in a row, so this task was paused")
 *      and never leaks the internal `passed=` / `path=` scalars from the
 *      audit summary.
 *   2. JUDGE-HEAL CANARY: a still-dead judge cost one failing call EVERY tick.
 *      Two ticks inside the interval now cost exactly one call; after
 *      `__resetJudgeHealClock()` (i.e. once the interval has elapsed) the canary
 *      may run again.
 *   3. MAIN LIST BOUND: a board with 40 unscored review cards is scored
 *      25-at-a-time per tick (QC_REVIEW_SWEEP_BATCH default), never all 40.
 *
 * `runQCOnReview` is mocked at the module boundary so these tests count sweep
 * calls instead of scoring anything. Node's own module mocking is not enabled
 * in this harness (`node --import tsx --test <file>`), so the stub is installed
 * by replacing the resolved scorer module's exports in `require.cache` BEFORE
 * the sweep module is required (the sweep's compiled CJS access reads the
 * module object at call time — proved by the test itself).
 *
 * Isolated temp DB. No keys, no network, no live service.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_DB = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'bc-qc-bounds-')),
  'mission-control.test.db',
);
process.env.DATABASE_PATH = TMP_DB;

// Clean slate: keyless box, sweep enabled, default bounds under test.
delete process.env.OPENAI_API_KEY;
delete process.env.GOOGLE_API_KEY;
delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
delete process.env.GEMINI_API_KEY;
delete process.env.QC_JUDGE_MODEL;
delete process.env.OLLAMA_CLOUD_API_KEY;
delete process.env.QC_SIMULATE_PROVIDER_DOWN;
delete process.env.QC_FIXTURE_JSON_PATH;
delete process.env.DISABLE_QC_AUTO_SCORER;
delete process.env.DISABLE_QC_REVIEW_SWEEP;
delete process.env.QC_REVIEW_SWEEP_BATCH;
delete process.env.QC_JUDGE_HEAL_INTERVAL_MINUTES;
process.env.QC_RESULT_LOOP_THRESHOLD = '3';
// A blocked OWNER card fires the owner notice; never let a unit test attempt a
// live Telegram send.
process.env.OWNER_NOTIFY_TELEGRAM_DISABLED = '1';

type DbModule = typeof import('../../src/lib/db');
type SweepModule = typeof import('../../src/lib/jobs/qc-review-sweep');

let run: DbModule['run'];
let queryOne: DbModule['queryOne'];
let closeDb: DbModule['closeDb'];
let sweep: SweepModule;

/** Task ids the sweep asked the scorer about, in order, across all ticks. */
let scoredCalls: string[] = [];

async function fakeRunQCOnReview(taskId: string) {
  scoredCalls.push(taskId);
  // Heuristic: leaves the card in `review` and makes the heal canary stop after
  // one call, so "how many times was it called" is the only moving part.
  return { score: 5, pass: false, scoringPath: 'heuristic', gaps: [], reason: 'stub' } as never;
}

test.before(async () => {
  const db = await import('../../src/lib/db');
  run = db.run;
  queryOne = db.queryOne;
  closeDb = db.closeDb;
  db.getDb(); // full migration chain

  // Install the scorer stub BEFORE the sweep module is loaded.
  const scorerPath = require.resolve('@/lib/qc-scorer');
  const realScorer = require('@/lib/qc-scorer');
  require.cache[scorerPath]!.exports = { ...realScorer, runQCOnReview: fakeRunQCOnReview };

  sweep = require('@/lib/jobs/qc-review-sweep') as SweepModule;

  assert.equal(
    typeof sweep.__resetJudgeHealClock,
    'function',
    'the sweep must export __resetJudgeHealClock() so the heal interval is testable',
  );
});

test.after(() => {
  try { closeDb(); } catch { /* ignore */ }
  try { fs.rmSync(path.dirname(TMP_DB), { recursive: true, force: true }); } catch { /* ignore */ }
  delete process.env.QC_RESULT_LOOP_THRESHOLD;
  delete process.env.OWNER_NOTIFY_TELEGRAM_DISABLED;
});

let taskCounter = 0;
const nextId = (prefix: string) => `${prefix}-${++taskCounter}`;

function insertTask(id: string, status: string) {
  const now = new Date().toISOString();
  run(
    `INSERT INTO tasks (id, title, status, priority, workspace_id, business_id, created_at, updated_at)
     VALUES (?, ?, ?, 'medium', NULL, NULL, ?, ?)`,
    [id, `Task ${id}`, status, now, now],
  );
}

function insertEvent(id: string, message: string, age: string) {
  run(
    `INSERT INTO events (id, type, task_id, message, created_at)
     VALUES (?, 'qc_review', ?, ?, datetime('now', ?))`,
    [`evt-${id}-${++taskCounter}`, id, message, age],
  );
}

/** Three identical failing `llm` results, outside the 10-minute fresh window. */
function seedIdenticalFailingLlmResults(id: string) {
  const base = Date.now() - 11 * 60_000;
  for (let i = 0; i < 3; i++) {
    const scoredAt = new Date(base + i * 1000).toISOString();
    run(
      `INSERT INTO task_qc_results (id, task_id, workspace_id, department_slug, score, passed, scoring_path, qc_agent_id, attempt, scored_at)
       VALUES (?, ?, NULL, NULL, ?, ?, 'llm', NULL, ?, ?)`,
      [`qcr-${id}-${i}`, id, 2.8, 0, i + 1, scoredAt],
    );
    run(
      `INSERT INTO events (id, type, task_id, message, created_at) VALUES (?, 'qc_review', ?, ?, ?)`,
      [
        `evt-${id}-qc-${i}`,
        id,
        `[QC-AUTO] Score: 2.8/10 | FAIL → returned to Backlog for re-route | Owner approval is required before publishing [path:llm]`,
        scoredAt,
      ],
    );
  }
}

// ─── 1. Owner text is plain English, no internal scalars ────────────────────

test('loop-detected OWNER text says what happened and carries no passed=/path=', async () => {
  const id = nextId('bounds-loop');
  insertTask(id, 'review');
  seedIdenticalFailingLlmResults(id);

  const result = await sweep.runQCReviewSweep();
  assert.equal(result.loopBlocked, 1, 'the identical-result loop must be blocked before any rescore');

  const row = queryOne<{ block_needs: string | null; ask: string | null; block_audience: string | null }>(
    `SELECT block_needs, ask, block_audience FROM tasks WHERE id = ?`,
    [id],
  );
  assert.equal(row?.block_audience, 'OWNER', 'this fixture is owner-actionable');
  const ownerText = row?.block_needs ?? '';
  assert.match(
    ownerText,
    /the quality check gave the same result 3 times in a row, so this task was paused/,
    `the owner text must say what happened in words (got: ${ownerText})`,
  );
  assert.ok(!ownerText.includes('passed='), `owner text must not leak the audit scalar passed= (got: ${ownerText})`);
  assert.ok(!ownerText.includes('path='), `owner text must not leak the audit scalar path= (got: ${ownerText})`);
  assert.ok(!(row?.ask ?? '').includes('passed='), 'the board `ask` must not leak passed= either');
  assert.ok(!(row?.ask ?? '').includes('path='), 'the board `ask` must not leak path= either');
});

// ─── 2. The judge-heal canary is bounded to one attempt per interval ────────

test('judge-heal canary: two ticks inside the interval dial the judge once', async () => {
  const id = nextId('bounds-heal');
  insertTask(id, 'review');
  insertEvent(id, '[QC-JUDGE-FAILED-FINAL] [JUDGE-MODEL-GONE] Score: 5/10 judge died', '-2 hours');

  scoredCalls = [];
  await sweep.runQCReviewSweep();
  assert.equal(
    scoredCalls.filter((t) => t === id).length,
    1,
    'the first tick must run the canary exactly once for the judge-gone card',
  );

  // One tick later — far inside the 30-minute interval.
  await sweep.runQCReviewSweep();
  assert.equal(
    scoredCalls.filter((t) => t === id).length,
    1,
    'a still-dead judge must NOT be re-dialled on the next tick',
  );

  // The interval having elapsed is what reopens the canary.
  sweep.__resetJudgeHealClock();
  await sweep.runQCReviewSweep();
  assert.equal(
    scoredCalls.filter((t) => t === id).length,
    2,
    'once the interval elapses the canary may run again',
  );
});

// ─── 3. The main scan is bounded per tick ───────────────────────────────────

test('one sweep scores at most 25 of 40 unscored review cards', async () => {
  for (let i = 0; i < 40; i++) insertTask(`bounds-batch-${String(i).padStart(2, '0')}`, 'review');

  scoredCalls = [];
  const result = await sweep.runQCReviewSweep();

  assert.equal(scoredCalls.length, 25, `a single sweep must cap scoring at 25 cards (got ${scoredCalls.length})`);
  assert.equal(result.scanned, 25, 'the sweep must report only the cards it actually scanned');
  assert.equal(result.scored, 25, 'exactly the bounded batch is scored');
});
