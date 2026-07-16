/**
 * U39 / C-08 — S4 not-Done closure: producer→review→done contract proof
 * (Skill 6 ⇄ Command Center). Master spec v2
 * `skill6-blended-persona-kanban-MASTER-SPEC-v2-2026-07-13.md` §C+I.2, C-08
 * (line 1157), BINARY acceptance at line 1160.
 *
 * Leg split (per the ONB leg's own executable pytest.skip,
 * 06-ghl-install-pages/tests/test_cc_board_u39_s4_lifecycle.py:153-157):
 *   (a) both producer refusals             — ONB leg. Not this repo.
 *   (b) consumer 403, byte-parity HMAC     — CC leg.
 *   (c) QC PASS → done (audited) / QC FAIL → backlog (gap notes + reroute++) — CC leg.
 *
 * Of (b)+(c), TWO THIRDS are already landed and proven elsewhere on this repo
 * — this file does NOT duplicate that coverage, it cites it:
 *   (b)            tests/unit/task-status-transition.test.ts:239
 *                  "status=done (valid auth, Skill-6-marked card) → 403 and no mutation"
 *   (c) PASS half  tests/unit/maria-pattern-harness.test.ts:390-425
 *                  "S4b stuck-not-Done (b): the ONLY legal promote path (QC PASS)
 *                  advances review -> done, audited"
 *
 * THE ONLY GENUINELY OWED PIECE is (c)'s FAIL half — no test on this repo's
 * main asserted, before this file: a FAIL verdict through runQCOnReview (1)
 * lands the task in `backlog`, (2) persists gap notes onto the task, and (3)
 * increments `qc_reroute_attempts`. That is `[U39-c-08 FAIL]` below, driven
 * against the real, previously-untested code path at
 * src/lib/qc-scorer.ts:4664-4671 ("FAIL: return to backlog with gap notes...
 * Increment the per-task attempt counter").
 *
 * `[U39-c-08 CHAIN]` below is the optional "single chained proof" this unit's
 * scope analysis allows in lieu of duplicating the landed matrix: it re-drives
 * the already-proven 403 and QC-PASS-promote steps as a THIN chain on the SAME
 * fixture card, alongside the newly-proven FAIL step, so one test demonstrates
 * the full "only path to done" contract the spec's C-08 "what" describes —
 * without rewriting task-status-transition.test.ts or maria-pattern-harness
 * .test.ts's own dedicated matrices.
 *
 * Soft dep (spec line 1159 / Section B / U26 / B-U12): this file makes NO
 * assertion about producer-scorecard consumption in either direction, and
 * leaves QC_PRODUCER_SCORECARD_ENABLED unset so scoring stays on the
 * independent-evidence path deterministically.
 *
 * notifyOwnerDone: not asserted here (no stub/spy seam introduced by this
 * file); tests/setup/no-owner-telegram.ts + notify-no-send-in-tests.test.ts
 * already hard-block any real send under the test runner suite-wide.
 *
 * Uses an isolated temp DB, same pattern as the sibling U38/C-07 contract test
 * this unit sits beside (tests/unit/u38-c-07-qc-promote-contract.test.ts) and
 * the status-route test (tests/unit/task-status-transition.test.ts).
 *
 * Test-only unit. Revert: delete this file.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHmac } from 'node:crypto';
import { NextRequest } from 'next/server';

// ── Isolated DB + auth secrets (set BEFORE @/lib/db / route are imported) ────
const TMP_DB = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'bc-u39-c08-')),
  'mission-control.test.db',
);
process.env.DATABASE_PATH = TMP_DB;

const MC_API_TOKEN = 'test-u39-mc-token';
const WEBHOOK_SECRET = 'test-u39-webhook-secret';
process.env.MC_API_TOKEN = MC_API_TOKEN;
process.env.WEBHOOK_SECRET = WEBHOOK_SECRET;

const RUN_ID = Math.random().toString(36).slice(2, 10);

type DbModule = typeof import('../../src/lib/db');
let run: DbModule['run'];
let queryOne: DbModule['queryOne'];
let closeDb: DbModule['closeDb'];

type StatusRouteModule = typeof import('../../src/app/api/tasks/[id]/status/route');
let statusPOST: StatusRouteModule['POST'];

type QcScorerModule = typeof import('../../src/lib/qc-scorer');
let runQCOnReview: QcScorerModule['runQCOnReview'];

let taskCounter = 0;
function nextId(prefix: string) {
  return `task-u39-${prefix}-${++taskCounter}-${RUN_ID}`;
}

/** Correct HMAC-SHA256 hex signature over the exact raw body bytes — same
 * formula as cc_board.py's `_sign()` and this route's own `authenticate()`. */
function sign(rawBody: string): string {
  return createHmac('sha256', WEBHOOK_SECRET).update(rawBody).digest('hex');
}

/**
 * Seed one review-status fixture card carrying the Skill-6 board-producer
 * source marker (the legacy description fallback resolveBoardSource() reads
 * when the immutable `source` column is unset — same fixture shape
 * task-status-transition.test.ts uses), plainly worded so
 * deriveAcceptanceCriteria() never classifies it as an image/deck artifact
 * task (that is Invariant A's lane, not this one — a deliberately different
 * fixture shape than u38's).
 */
function insertReviewCard(id: string, qcReroteAttemptsSeed: number) {
  const now = new Date().toISOString();
  run(
    `INSERT INTO tasks (id, title, description, status, priority, workspace_id, business_id, qc_reroute_attempts, created_at, updated_at)
     VALUES (?, ?, ?, 'review', 'medium', NULL, NULL, ?, ?, ?)`,
    [
      id,
      'Draft the Q3 vendor renewal memo',
      'Initial brief.\n\nSource: funnel',
      qcReroteAttemptsSeed,
      now,
      now,
    ],
  );
}

function currentStatus(id: string): string | undefined {
  return queryOne<{ status: string }>('SELECT status FROM tasks WHERE id = ?', [id])?.status;
}

function currentRow(id: string) {
  return queryOne<{ status: string; description: string | null; qc_reroute_attempts: number }>(
    'SELECT status, description, qc_reroute_attempts FROM tasks WHERE id = ?',
    [id],
  );
}

function latestDoneAudit(id: string) {
  return queryOne<{ from_status: string; to_status: string; actor: string }>(
    `SELECT from_status, to_status, actor FROM task_events
     WHERE task_id = ? AND to_status = 'done' ORDER BY created_at DESC LIMIT 1`,
    [id],
  );
}

/** Force a deterministic runQCOnReview verdict via the sanctioned test seam
 * (src/lib/fixture-guard.ts hard-fails this in NODE_ENV=production; we are
 * not in production — asserted by the maria-pattern-harness suite this
 * pattern is copied from). Always cleans up the env var + temp file. */
async function runQcWithFixture(
  taskId: string,
  verdict: { score: number; pass: boolean; reason: string; gaps: string[] },
) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-u39-qc-fixture-'));
  const fixturePath = path.join(dir, 'verdict.json');
  fs.writeFileSync(fixturePath, JSON.stringify(verdict));
  process.env.QC_FIXTURE_JSON_PATH = fixturePath;
  try {
    return await runQCOnReview(taskId);
  } finally {
    delete process.env.QC_FIXTURE_JSON_PATH;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Drive the real consumer route with a signed status=done request — the
 * exact producer shape (Bearer + byte-parity HMAC over the raw body). */
function callDoneRoute(id: string) {
  const rawBody = JSON.stringify({ status: 'done' });
  const req = new NextRequest(`http://localhost/api/tasks/${id}/status`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${MC_API_TOKEN}`,
      'x-webhook-signature': sign(rawBody),
    },
    body: rawBody,
  });
  return statusPOST(req, { params: Promise.resolve({ id }) }) as unknown as Promise<Response>;
}

test.before(async () => {
  const db = (await import('../../src/lib/db')) as DbModule;
  run = db.run;
  queryOne = db.queryOne;
  closeDb = db.closeDb;
  db.getDb(); // runs the full migration chain against the isolated temp DB

  const statusRoute = (await import('../../src/app/api/tasks/[id]/status/route')) as StatusRouteModule;
  statusPOST = statusRoute.POST;

  const qcScorer = (await import('../../src/lib/qc-scorer')) as QcScorerModule;
  runQCOnReview = qcScorer.runQCOnReview;
});

test.after(() => {
  try { closeDb(); } catch { /* best-effort */ }
  try { fs.rmSync(path.dirname(TMP_DB), { recursive: true, force: true }); } catch { /* best-effort */ }
});

// ─────────────────────────────────────────────────────────────────────────
// [U39-c-08 FAIL] — the genuinely owed acceptance: QC FAIL lands `backlog`,
// persists gap notes on the task, and increments `qc_reroute_attempts`.
// ─────────────────────────────────────────────────────────────────────────

test('[U39-c-08 FAIL] QC FAIL fixture (score 7.0 < 8.5) on a review card lands backlog, persists gap notes, and increments qc_reroute_attempts by exactly one (seeded prevAttempts=2 -> 3, proving a real increment, not a coincidental 1)', async () => {
  const id = nextId('fail-owed');
  insertReviewCard(id, /* qcReroteAttemptsSeed */ 2);

  const result = await runQcWithFixture(id, {
    score: 7.0,
    pass: false,
    reason: 'Fixture FAIL: memo is missing the renewal-terms section.',
    gaps: ['Renewal terms section is missing', 'No signature block present'],
  });

  assert.ok(result, 'runQCOnReview must return a verdict');
  assert.equal(result?.pass, false, 'the fixture-forced verdict must FAIL');
  // Defensive: pin the scoring path so this test can never silently drift
  // onto the heuristic or no-criteria lanes (classifyFailure() would treat
  // 'no-criteria' as un-reroutable and this task would stay in `review`
  // instead of exercising the backlog+increment path under test).
  assert.equal(result?.scoringPath, 'llm', 'the fixture seam must force scoringPath=llm, not heuristic/no-criteria');

  const row = currentRow(id);
  assert.equal(row?.status, 'backlog', 'a FAIL verdict must land the task in backlog');
  assert.equal(row?.qc_reroute_attempts, 3, 'qc_reroute_attempts must be incremented by exactly one (2 -> 3)');
  assert.match(
    row?.description ?? '',
    /Renewal terms section is missing/,
    'the gap note must be persisted onto the task description, not just returned on the verdict object',
  );
  assert.match(row?.description ?? '', /\[QC-FAIL\]/, 'the persisted note must carry the [QC-FAIL] marker');
});

test('[U39-c-08 FAIL] a second consecutive FAIL on a fresh lineage increments again (1 -> 2), proving the counter accumulates rather than resetting', async () => {
  const id = nextId('fail-accumulate');
  insertReviewCard(id, 1);

  await runQcWithFixture(id, {
    score: 6.5,
    pass: false,
    reason: 'Fixture FAIL: still missing the renewal-terms section.',
    gaps: ['Renewal terms section is missing'],
  });

  const row = currentRow(id);
  assert.equal(row?.status, 'backlog', 'still under the QC_MAX_REROUTES cap must land backlog, not blocked');
  assert.equal(row?.qc_reroute_attempts, 2, 'a second FAIL must increment again, not reset to 1');
});

// ─────────────────────────────────────────────────────────────────────────
// [U39-c-08 CHAIN] — thin re-drive of the already-landed (b) and (c)-PASS
// steps on the SAME fixture id, chained with the newly-proven FAIL step, so
// one test demonstrates the full "only path to done" contract C-08's "what"
// describes. Does not duplicate the dedicated matrices in
// task-status-transition.test.ts or maria-pattern-harness.test.ts — see the
// file header for exact citations.
// ─────────────────────────────────────────────────────────────────────────

test('[U39-c-08 CHAIN] one fixture card: consumer 403 on done (auth present) -> QC FAIL (backlog, gap notes, reroute++) -> resubmitted -> QC PASS (done, audited event, reroute count untouched)', async () => {
  const id = nextId('chain');
  insertReviewCard(id, /* qcReroteAttemptsSeed */ 1);

  // ── Step 1 (cites task-status-transition.test.ts:239) — the consumer 403.
  // Auth is present and correct (Bearer + byte-parity HMAC) so the refusal is
  // the done-gate itself, not an auth failure.
  const doneRes = await callDoneRoute(id);
  assert.equal(doneRes.status, 403, 'status=done must be refused even with valid signed auth');
  const doneBody = (await doneRes.json()) as { hint: string };
  assert.match(doneBody.hint, /QC auto-scorer/, 'the refusal must point at the QC auto-scorer as the real done-gate');
  assert.equal(currentStatus(id), 'review', 'the refused done write must not touch the DB');

  // ── Step 2 (the owed piece) — QC FAIL lands backlog + gap notes + reroute++.
  const failResult = await runQcWithFixture(id, {
    score: 7.2,
    pass: false,
    reason: 'Fixture FAIL: memo lacks a termination clause.',
    gaps: ['Termination clause is missing'],
  });
  assert.equal(failResult?.pass, false);
  let row = currentRow(id);
  assert.equal(row?.status, 'backlog', 'FAIL must land the card in backlog');
  assert.equal(row?.qc_reroute_attempts, 2, 'reroute counter must increment from the seeded 1 to 2');
  assert.match(row?.description ?? '', /Termination clause is missing/);

  // ── Step 3 — a fixture shortcut standing in for the real re-dispatch
  // pipeline (backlog-redispatch sweep -> in_progress -> review), the same
  // "direct write standing in for the other actor" convention the sibling
  // u38 CAS tests use for their concurrent-writer fixture. This test does
  // NOT claim to exercise the redispatch sweep itself — only that a card
  // legitimately back in `review` is eligible for the QC PASS promote path.
  run(`UPDATE tasks SET status = 'review', updated_at = ? WHERE id = ?`, [
    new Date().toISOString(),
    id,
  ]);
  assert.equal(currentStatus(id), 'review');

  // ── Step 4 (cites maria-pattern-harness.test.ts:390-425) — QC PASS is the
  // ONLY legal promote path: review -> done, audited.
  const passResult = await runQcWithFixture(id, {
    score: 9.0,
    pass: true,
    reason: 'Fixture PASS: revised memo includes all required sections.',
    gaps: [],
  });
  assert.equal(passResult?.pass, true, 'the second fixture-forced verdict must PASS');

  row = currentRow(id);
  assert.equal(row?.status, 'done', 'a genuine PASS verdict is the only thing that may promote review -> done');
  assert.equal(
    row?.qc_reroute_attempts,
    2,
    'a PASS must never touch qc_reroute_attempts — the counter stays exactly where the FAIL step left it',
  );

  const audit = latestDoneAudit(id);
  assert.equal(audit?.from_status, 'review', 'task_events must record review as the promote origin');
  assert.equal(audit?.to_status, 'done', 'task_events must record done as the promote destination');
  assert.equal(audit?.actor, 'qc-auto-scorer', 'the audited actor must be the QC auto-scorer, never a builder self-grading its own card');
});
