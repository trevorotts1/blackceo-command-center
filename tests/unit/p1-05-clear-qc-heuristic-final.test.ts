/**
 * P1-05 (c)2 — "un-terminal the false finals" (scripts/clear-qc-heuristic-final.ts).
 *
 * End-to-end proof, against a REAL isolated DB and the REAL qc-scorer /
 * qc-review-sweep code (not hand-crafted fixture strings):
 *
 *   1. Drive a task to the actual terminal [QC-HEURISTIC-FINAL] state the
 *      SAME way qc-scorer.ts does it for real (no key configured, run
 *      runQCOnReview() until QC_HEURISTIC_NO_KEY_MAX_PASSES escalates it).
 *   2. FAIL-FIRST: prove the pre-fix behavior — qc-review-sweep's own
 *      NOT-EXISTS guard permanently excludes the task; runQCReviewSweep()
 *      scans right past it forever, even after the box gets a real judge.
 *   3. Run the remediation script's pure functions (findClearCandidates /
 *      buildClearLedger / applyClearLedger) and prove:
 *        - the marker event's `id` is unchanged (UPDATE, never DELETE)
 *        - the original score/reason/gaps text is preserved verbatim
 *        - the literal `[QC-HEURISTIC-FINAL]` substring no longer appears
 *          (so it no longer matches the sweep's LIKE guard)
 *        - a task NOT in `review` status is left untouched (scope guard)
 *   4. THE PROOF THAT MATTERS: with a live judge now configured (stubbed
 *      Ollama Cloud response), runQCReviewSweep() picks the task back up and
 *      writes a fresh event carrying `[path:llm]` — the exact "re-scored
 *      former-heuristic task shows [path:llm] in its event" break-it check
 *      named in SUPER-SPEC-2026-07-11 P1-05 (e).
 *
 * Runs via the Node built-in test runner (`npm run test:unit`). Isolated
 * temp DB — never touches the shared mission-control.db.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_DB = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'bc-p105-clear-')),
  'mission-control.test.db',
);
process.env.DATABASE_PATH = TMP_DB;

// Clean slate — no judge, no key, until each test opts in.
delete process.env.QC_JUDGE_MODEL;
delete process.env.OLLAMA_CLOUD_API_KEY;
delete process.env.OLLAMA_API_KEY;
delete process.env.OPENAI_API_KEY;
delete process.env.GOOGLE_API_KEY;
delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
delete process.env.GEMINI_API_KEY;
delete process.env.QC_SIMULATE_PROVIDER_DOWN;
process.env.QC_HEURISTIC_NO_KEY_MAX_PASSES = '1'; // escalate to FINAL on the first pass
// A real judge PASS below advances a task to `done`, which fires an owner
// notification that shells out to the real `openclaw` CLI. Suppress it the
// same way every other owner-notify-adjacent suite in this repo does — never
// let a unit test attempt a live Telegram send.
process.env.OWNER_NOTIFY_TELEGRAM_DISABLED = '1';

import test from 'node:test';
import assert from 'node:assert/strict';

type DbModule = typeof import('../../src/lib/db');
let run: DbModule['run'];
let queryOne: DbModule['queryOne'];
let queryAll: DbModule['queryAll'];
let closeDb: DbModule['closeDb'];

type ScorerModule = typeof import('../../src/lib/qc-scorer');
let runQCOnReview: ScorerModule['runQCOnReview'];

type SweepModule = typeof import('../../src/lib/jobs/qc-review-sweep');
let runQCReviewSweep: SweepModule['runQCReviewSweep'];

type ClearModule = typeof import('../../scripts/clear-qc-heuristic-final');
let FINAL_MARKER: ClearModule['FINAL_MARKER'];
let clearedMessage: ClearModule['clearedMessage'];
let findClearCandidates: ClearModule['findClearCandidates'];
let buildClearLedger: ClearModule['buildClearLedger'];
let applyClearLedger: ClearModule['applyClearLedger'];

let taskCounter = 0;
function nextId(prefix: string) {
  return `${prefix}-${++taskCounter}`;
}

const SOP_ID = 'sop-p105-clear-fixture';

function insertReviewTask(id: string) {
  const now = new Date().toISOString();
  run(
    `INSERT INTO tasks (id, title, description, status, priority, workspace_id, business_id, sop_id, created_at, updated_at)
     VALUES (?, ?, ?, 'review', 'medium', NULL, NULL, ?, ?, ?)`,
    [id, `P1-05 clear-fixture task ${id}`, 'A completed deliverable ready for QC inspection.', SOP_ID, now, now],
  );
}

function stubFetch(impl: (url: string, init?: RequestInit) => Promise<Response>): () => void {
  const orig = (globalThis as Record<string, unknown>).fetch;
  (globalThis as Record<string, unknown>).fetch = impl;
  return () => {
    if (orig === undefined) delete (globalThis as Record<string, unknown>).fetch;
    else (globalThis as Record<string, unknown>).fetch = orig;
  };
}

test.before(async () => {
  const db = await import('../../src/lib/db');
  run = db.run;
  queryOne = db.queryOne;
  queryAll = db.queryAll;
  closeDb = db.closeDb;
  db.getDb();

  const now = new Date().toISOString();
  run(
    `INSERT OR IGNORE INTO sops (id, name, slug, success_criteria, steps, department, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      SOP_ID,
      'P1-05 Clear-Fixture SOP',
      'p105-clear-fixture',
      'Deliverable must be complete, verified, and meet all stated requirements.',
      JSON.stringify([{ step: 1, action: 'Complete the deliverable' }]),
      'general-task',
      now,
      now,
    ],
  );

  const scorer = await import('../../src/lib/qc-scorer');
  runQCOnReview = scorer.runQCOnReview;

  const sweep = await import('../../src/lib/jobs/qc-review-sweep');
  runQCReviewSweep = sweep.runQCReviewSweep;

  const clearMod = await import('../../scripts/clear-qc-heuristic-final');
  FINAL_MARKER = clearMod.FINAL_MARKER;
  clearedMessage = clearMod.clearedMessage;
  findClearCandidates = clearMod.findClearCandidates;
  buildClearLedger = clearMod.buildClearLedger;
  applyClearLedger = clearMod.applyClearLedger;
});

test.after(() => {
  try { closeDb(); } catch { /* ignore */ }
  try { fs.rmSync(path.dirname(TMP_DB), { recursive: true, force: true }); } catch { /* ignore */ }
  delete process.env.QC_HEURISTIC_NO_KEY_MAX_PASSES;
  delete process.env.OWNER_NOTIFY_TELEGRAM_DISABLED;
});

// ── clearedMessage: pure rewrite, preserves content, breaks the LIKE match ───

test('[P1-05] clearedMessage renames the bracket token and preserves the rest verbatim', () => {
  const original =
    '[QC-HEURISTIC-FINAL] Score: 6.5/10 | QC ran in heuristic mode 1 time(s) with NO client ' +
    'Ollama Cloud judge configured — this box cannot auto-advance review→done. Some gap text. [path:heuristic] [scorer:global-heuristic]';
  const rewritten = clearedMessage(original, '2026-07-11T12:00:00.000Z');

  assert.ok(!rewritten.includes(FINAL_MARKER), `must no longer contain the literal ${FINAL_MARKER} token`);
  assert.ok(rewritten.includes('[QC-HEURISTIC-FINAL-CLEARED-P1-05]'), 'must carry the renamed marker');
  assert.ok(rewritten.includes('Score: 6.5/10'), 'original score text must survive verbatim');
  assert.ok(rewritten.includes('Some gap text.'), 'original gap text must survive verbatim');
  assert.ok(rewritten.includes('[path:heuristic]'), 'original path tag must survive verbatim');
  assert.ok(rewritten.includes('[P1-05-REMEDIATION]'), 'must append a remediation note');
  assert.ok(rewritten.includes('2026-07-11T12:00:00.000Z'), 'remediation note must carry the clear timestamp');
});

// ── End-to-end: drive a task to the REAL terminal state, prove exclusion, clear it ──

test('[P1-05] end-to-end: real [QC-HEURISTIC-FINAL] escalation -> permanently excluded -> cleared -> re-scored with [path:llm]', async () => {
  const id = nextId('p105-e2e');
  insertReviewTask(id);

  // ── Step 1: drive the REAL terminal escalation (no key configured; MAX_PASSES=1) ──
  const firstResult = await runQCOnReview(id);
  assert.ok(firstResult !== null);
  assert.equal(firstResult.scoringPath, 'heuristic');

  const finalEvent = queryOne<{ id: string; message: string }>(
    `SELECT id, message FROM events WHERE task_id = ? AND message LIKE '%[QC-HEURISTIC-FINAL]%' LIMIT 1`,
    [id],
  );
  assert.ok(finalEvent, 'the REAL scorer must have written a [QC-HEURISTIC-FINAL] event (QC_HEURISTIC_NO_KEY_MAX_PASSES=1)');

  const taskAfterFinal = queryOne<{ status: string }>(`SELECT status FROM tasks WHERE id = ?`, [id]);
  assert.equal(taskAfterFinal?.status, 'review', 'task stays in review even after terminal escalation');

  // Real fleet [QC-HEURISTIC-FINAL] markers are OLD (written before v19.48.0
  // fixed judge provisioning — days/weeks ago), well outside
  // qc-review-sweep's unrelated 10-minute "already scored recently" window.
  // Backdate the marker so this test exercises exactly the P1-05 exclusion
  // (the permanent LIKE-marker guard) without tripping over that separate,
  // unrelated freshness rule as a test-timing artifact.
  const oldTs = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  run(`UPDATE events SET created_at = ? WHERE id = ?`, [oldTs, finalEvent!.id]);

  // ── Step 2 (FAIL-FIRST): prove the pre-clear exclusion is real, using the sweep itself ──
  const sweepBefore = await runQCReviewSweep();
  const eventsBefore = queryAll<{ id: string }>(`SELECT id FROM events WHERE task_id = ?`, [id]);
  assert.equal(
    eventsBefore.length,
    1,
    'BEFORE clearing: the sweep must NOT have touched this task (still exactly the 1 original event) — proves the exclusion is real',
  );

  // ── Step 3: the remediation script finds it, clears it, and NEVER deletes the row ──
  const candidatesBefore = findClearCandidates();
  assert.ok(
    candidatesBefore.some((c) => c.taskId === id),
    'findClearCandidates must surface this task',
  );

  const clearedAt = new Date().toISOString();
  const ledger = buildClearLedger(clearedAt);
  const entry = ledger.find((e) => e.taskId === id);
  assert.ok(entry, 'buildClearLedger must include this task');
  assert.equal(entry!.eventId, finalEvent!.id, 'ledger must target the exact same event id');

  const cleared = applyClearLedger([entry!]);
  assert.equal(cleared, 1, 'exactly one event must be updated');

  const eventAfterClear = queryOne<{ id: string; message: string }>(
    `SELECT id, message FROM events WHERE id = ?`,
    [finalEvent!.id],
  );
  assert.ok(eventAfterClear, 'the event row must still exist (UPDATE, never DELETE)');
  assert.equal(eventAfterClear!.id, finalEvent!.id, 'row id is unchanged — proves this is an UPDATE, not a delete+reinsert');
  assert.ok(!eventAfterClear!.message.includes(FINAL_MARKER), 'the literal [QC-HEURISTIC-FINAL] token must be gone from the stored message');
  assert.ok(eventAfterClear!.message.includes('Score:'), 'original score text preserved in the stored row');

  // findClearCandidates must now be empty for this task.
  const candidatesAfter = findClearCandidates();
  assert.ok(!candidatesAfter.some((c) => c.taskId === id), 'task must no longer be a clear candidate after clearing');

  // ── Step 4: THE PROOF THAT MATTERS — with a real judge now live, the sweep
  //    picks the task back up and re-scores it via the REAL llm path. ──
  process.env.QC_JUDGE_MODEL = 'deepseek-v3:cloud';
  process.env.OLLAMA_CLOUD_API_KEY = 'sk-now-provisioned';
  const restoreFetch = stubFetch(async (url) => {
    const u = String(url);
    if (u.includes('/v1/chat/completions')) {
      return new Response(
        JSON.stringify({
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: JSON.stringify({ score: 9.0, pass: true, reason: 'Deliverable complete.', gaps: [] }),
              },
            },
          ],
        }),
        { status: 200 },
      );
    }
    throw new Error(`unexpected fetch to ${u}`);
  });

  try {
    const sweepAfter = await runQCReviewSweep();
    assert.equal(sweepAfter.scanned >= 1, true, 'AFTER clearing: the sweep must pick the task back up (no longer excluded)');

    const llmEvent = queryOne<{ message: string }>(
      `SELECT message FROM events WHERE task_id = ? AND message LIKE '%[path:llm]%' ORDER BY created_at DESC LIMIT 1`,
      [id],
    );
    assert.ok(
      llmEvent,
      'a re-scored former-heuristic task must show [path:llm] in its event once a real judge is provisioned',
    );

    const taskAfterRescore = queryOne<{ status: string }>(`SELECT status FROM tasks WHERE id = ?`, [id]);
    assert.equal(taskAfterRescore?.status, 'done', 'a real llm PASS (score 9.0 >= 8.5) must advance the task to done');
  } finally {
    restoreFetch();
    delete process.env.QC_JUDGE_MODEL;
    delete process.env.OLLAMA_CLOUD_API_KEY;
  }
});

// ── Scope guard: a task NOT in `review` is never touched ──────────────────────

test('[P1-05] scope guard: a [QC-HEURISTIC-FINAL] event on a task NOT in review is left untouched', async () => {
  const id = nextId('p105-not-review');
  insertReviewTask(id);

  await runQCOnReview(id); // escalates to FINAL (MAX_PASSES=1) while still in review
  const finalEvent = queryOne<{ id: string }>(
    `SELECT id FROM events WHERE task_id = ? AND message LIKE '%[QC-HEURISTIC-FINAL]%' LIMIT 1`,
    [id],
  );
  assert.ok(finalEvent, 'precondition: task has a real FINAL marker');

  // Move the task out of review (e.g. an operator manually promoted it).
  run(`UPDATE tasks SET status = 'done' WHERE id = ?`, [id]);

  const candidates = findClearCandidates();
  assert.ok(
    !candidates.some((c) => c.taskId === id),
    'a task that already left review must NOT be a clear candidate, even though its FINAL marker still exists',
  );
});
