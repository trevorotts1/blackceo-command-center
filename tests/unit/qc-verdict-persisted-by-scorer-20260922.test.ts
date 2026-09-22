/**
 * QC-VERDICT-RECORD — the SCORER actually writes the reason, on a real run.
 *
 * The companion file (qc-verdict-record-20260922.test.ts) proves the columns
 * and the readers. It seeds `task_qc_results` rows directly, so it cannot tell
 * whether the scorer populates them — and a migration that adds two columns
 * nothing ever fills would leave the defect exactly where it was: a card that
 * failed at 9.0 against an 8.5 bar, with the reason unrecoverable from the
 * database and from both pm2 logs.
 *
 * So this runs the real `runQCOnReview` over an isolated database with the
 * verdict forced through the `QC_FIXTURE_JSON_PATH` seam (the same harness
 * fix21-system-block-notify.test.ts uses), and reads the row back.
 *
 * It also pins the board event, because that string is what a human reads on
 * the card: a 9.0 verdict must never publish "9.0/10 < 8.5".
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ── Isolated DB FIRST (suite convention) ────────────────────────────────────
const TMP_DB = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'bc-qcverdict-')),
  'mission-control.test.db',
);
process.env.DATABASE_PATH = TMP_DB;

const WORKSPACE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-qcverdict-ws-'));
process.env.OPENCLAW_WORKSPACE_PATH = WORKSPACE_DIR;

// The verdict under test: a score ABOVE the pass bar that still FAILS, which is
// the exact shape that was unreadable on the client board. The gap text dodges
// every QC_BLOCK_SYSTEM_SIGNALS pattern and every classifyFailure unrouteable
// pattern, so the card takes the ordinary re-route lane.
const GAP = 'the approved logo is absent from slides 3 and 7';
const REASON = 'Fixture verdict: mandatory brand check not satisfied.';
const FIXTURE_PATH = path.join(WORKSPACE_DIR, 'qc-fixture.json');
fs.writeFileSync(
  FIXTURE_PATH,
  JSON.stringify({ score: 9.0, pass: false, reason: REASON, gaps: [GAP] }),
);
process.env.QC_FIXTURE_JSON_PATH = FIXTURE_PATH;

// Plenty of headroom under the cap — this file is about the RECORD, not the cap.
process.env.QC_MAX_REROUTES = '5';

delete process.env.OPENAI_API_KEY;
delete process.env.GOOGLE_API_KEY;
delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
delete process.env.GEMINI_API_KEY;
delete process.env.DISABLE_QC_AUTO_SCORER;
delete process.env.NEXTAUTH_URL;
delete process.env.NEXT_PUBLIC_APP_URL;
delete process.env.MISSION_CONTROL_URL;

type DbModule = typeof import('../../src/lib/db');
let run: DbModule['run'];
let queryOne: DbModule['queryOne'];
let queryAll: DbModule['queryAll'];
let getDb: DbModule['getDb'];
let closeDb: DbModule['closeDb'];

type ScorerModule = typeof import('../../src/lib/qc-scorer');
let runQCOnReview: ScorerModule['runQCOnReview'];

let counter = 0;
function insertReviewTask(): string {
  const id = `qcvp-${Date.now()}-${++counter}`;
  const now = new Date().toISOString();
  run(
    `INSERT INTO tasks (id, title, description, status, priority, workspace_id, created_at, updated_at)
     VALUES (?, ?, ?, 'review', 'medium', NULL, ?, ?)`,
    // No image/deck words: keeps the card on the Mode-B description path.
    [id, `Quarterly ops memo ${id}`, 'Write the quarterly operations memo.', now, now],
  );
  return id;
}

test.before(async () => {
  const db = await import('../../src/lib/db');
  run = db.run;
  queryOne = db.queryOne;
  queryAll = db.queryAll;
  getDb = db.getDb;
  closeDb = db.closeDb;
  getDb();

  const scorer = await import('../../src/lib/qc-scorer');
  runQCOnReview = scorer.runQCOnReview;
});

test.after(() => {
  try { closeDb(); } catch { /* ignore */ }
  for (const d of [path.dirname(TMP_DB), WORKSPACE_DIR]) {
    try { fs.rmSync(d, { force: true, recursive: true }); } catch { /* ignore */ }
  }
  delete process.env.QC_FIXTURE_JSON_PATH;
  delete process.env.QC_MAX_REROUTES;
});

test('a real scored attempt persists its reason AND its gaps', async () => {
  const taskId = insertReviewTask();

  const result = await runQCOnReview(taskId);
  assert.ok(result, 'the scorer returned a verdict');
  assert.equal(result.pass, false, 'the fixture verdict fails');
  assert.equal(result.score, 9.0, 'at a score ABOVE the 8.5 bar');

  const row = queryOne<{ score: number; passed: number; reason: string | null; gaps: string | null }>(
    `SELECT score, passed, reason, gaps FROM task_qc_results
      WHERE task_id = ? ORDER BY scored_at DESC, rowid DESC LIMIT 1`,
    [taskId],
  );
  assert.ok(row, 'the scorer wrote a durable verdict row');
  assert.equal(row.score, 9.0);
  assert.equal(row.passed, 0);

  // THE PROOF. Before migration 160 both of these were structurally impossible:
  // the table had no column to put them in, and the scorer logged only a score.
  // `includes`, not equality: the scorer appends its own qualification to a
  // verdict it withholds (here: scored from the description with no deliverable
  // registered). That extra sentence is exactly the kind of context that used
  // to exist only in a log line, so the test pins that the reason ARRIVES, not
  // that the scorer is forbidden from saying more than the judge did.
  assert.ok(
    (row.reason ?? '').includes(REASON),
    `the WHY must be answerable from the database alone, got: ${row.reason}`,
  );
  const storedGaps = JSON.parse(row.gaps ?? '[]') as string[];
  assert.ok(
    storedGaps.some((g) => g.includes(GAP)),
    `the gap that failed it must be stored, got: ${JSON.stringify(storedGaps)}`,
  );
});

test('the board event never publishes "9.0/10 < 8.5"', () => {
  const events = queryAll<{ message: string }>(
    `SELECT message FROM events WHERE type = 'task_status_changed' AND message LIKE '%[QC-AUTO]%'`,
  );
  assert.ok(events.length > 0, 'the re-route wrote its board event');
  for (const e of events) {
    assert.ok(
      !/9\.0\/10 < 8\.5/.test(e.message),
      `a passing score published as a "<" comparison: ${e.message}`,
    );
    assert.ok(e.message.includes('PASSED'), `the event must say the score passed: ${e.message}`);
    assert.ok(e.message.includes(GAP), `the event must name the gap that failed it: ${e.message}`);
  }
});

test('the kickback note on the card names the gap and the reuse instruction', () => {
  const row = queryOne<{ description: string | null }>(
    'SELECT description FROM tasks WHERE description LIKE ? LIMIT 1',
    ['%[QC-FAIL]%'],
  );
  assert.ok(row?.description, 'the re-route persisted its kickback note');
  assert.ok(
    !/9\.0\/10 < 8\.5/.test(row.description),
    `the kickback note must not claim "<" at 9.0: ${row.description}`,
  );
  assert.ok(row.description.includes('PASSED'), 'it says the score passed');
  assert.ok(row.description.includes(GAP), 'it names the gap');
});
