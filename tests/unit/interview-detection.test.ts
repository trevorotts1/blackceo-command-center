/**
 * Unit tests for the interview-completion detection fix
 * (src/lib/conversational-ai/interview-state.ts).
 *
 * Runs via the Node built-in test runner under tsx (`npm run test:unit`).
 *
 * Root cause this guards against:
 *   The original getInterviewState() short-circuited on `clientFlag === false`
 *   (DB row present but interview_complete=0) BEFORE checking filesystem
 *   signals. A client whose interview WAS complete (evidenced by e.g.
 *   workforce-interview-answers.md or a completed build-state JSON) but
 *   whose DB row still had the default 0 would be permanently false-gated from
 *   Layer-2 analytics.
 *
 * Fix: filesystem signals are now checked even when clientFlag===false, and the
 * DB flag is auto-backfilled when a positive filesystem signal fires.
 *
 * Test approach:
 *   We import interview-state.ts once and call getInterviewState() with
 *   OPENCLAW_WORKSPACE_ROOT pointing at a tmp dir that we control per-test.
 *   Because the module reads fs paths at call time (not import time) this works
 *   correctly with a single import + env manipulation.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Point DATABASE_PATH at a fresh DB BEFORE any module that imports @/lib/db.
const TMP_DB = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'bc-interview-db-')),
  'mission-control.test.db',
);
process.env.DATABASE_PATH = TMP_DB;

// Pre-allocate a tmp workspace directory that persists across the whole suite.
// Each test writes/deletes specific files inside it and cleans up after itself.
const TMP_WORKSPACE = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-interview-ws-'));
process.env.OPENCLAW_WORKSPACE_ROOT = TMP_WORKSPACE;

type StateModule = typeof import('../../src/lib/conversational-ai/interview-state');
let getInterviewState: StateModule['getInterviewState'];

type DbModule = typeof import('../../src/lib/db');
let getDb: DbModule['getDb'];
let closeDb: DbModule['closeDb'];

// Files the tests create inside TMP_WORKSPACE.
const ANSWERS_FILE = path.join(TMP_WORKSPACE, 'workforce-interview-answers.md');
const BUILD_STATE_FILE = path.join(TMP_WORKSPACE, '.workforce-build-state.json');
const SUBDIR = path.join(TMP_WORKSPACE, 'my-company');
const BUILD_PROGRESS_FILE = path.join(SUBDIR, 'build-progress.json');

function cleanFiles() {
  for (const f of [ANSWERS_FILE, BUILD_STATE_FILE, BUILD_PROGRESS_FILE]) {
    try { fs.unlinkSync(f); } catch { /* ignore */ }
  }
  try { fs.rmdirSync(SUBDIR); } catch { /* ignore */ }
}

test.before(async () => {
  const db = await import('../../src/lib/db');
  getDb = db.getDb;
  closeDb = db.closeDb;
  getDb(); // runs full migration chain

  const stateModule = await import('../../src/lib/conversational-ai/interview-state');
  getInterviewState = stateModule.getInterviewState;
});

test.after(() => {
  try { closeDb(); } catch { /* ignore */ }
  cleanFiles();
  try { fs.rmdirSync(TMP_WORKSPACE); } catch { /* ignore */ }
});

// ── helpers ───────────────────────────────────────────────────────────────────

/** Reset the self-client interview_complete flag to 0 between tests so
 *  the auto-backfill from one test doesn't pollute the next. */
function resetClientFlag() {
  try {
    const db = getDb();
    db.prepare(`UPDATE clients SET interview_complete = 0 WHERE is_self = 1`).run();
  } catch {
    // No clients table yet (pre-migration env) — ok.
  }
}

// ── tests ─────────────────────────────────────────────────────────────────────

test('getInterviewState: returns complete=false when no filesystem signals', () => {
  cleanFiles();
  resetClientFlag();
  const state = getInterviewState();
  // No files exist, no DB flag.
  // configSignal depends on a company-config.json with real KPIs — on a fresh
  // clone this is empty so configSignal() returns false.
  // Result: complete=false (either unknown or known=true from client-flag).
  assert.equal(state.complete, false, 'no signal → complete must be false');
});

test('getInterviewState: interview-answers-file → complete:true', () => {
  cleanFiles();
  resetClientFlag();
  fs.writeFileSync(ANSWERS_FILE, '# AI Workforce Interview\nBusiness: Test Corp\n');
  const state = getInterviewState();
  fs.unlinkSync(ANSWERS_FILE);
  resetClientFlag(); // undo auto-backfill

  assert.equal(state.complete, true, 'interview-answers-file should unlock complete:true');
  assert.equal(state.known, true);
  // Signal may be 'client-flag' if backfill wrote it mid-call, or
  // 'interview-answers-file' if clientFlag was still null. Either means it worked.
  assert.ok(
    ['interview-answers-file', 'client-flag'].includes(state.signal),
    `signal must be interview-answers-file or client-flag, got: ${state.signal}`,
  );
});

test('getInterviewState: build-state stage=complete → complete:true', () => {
  cleanFiles();
  resetClientFlag();
  fs.writeFileSync(
    BUILD_STATE_FILE,
    JSON.stringify({ stage: 'complete', documents_total: 5, documents_complete: 5 }),
  );
  const state = getInterviewState();
  fs.unlinkSync(BUILD_STATE_FILE);
  resetClientFlag();

  assert.equal(state.complete, true, 'stage=complete should unlock');
  assert.ok(
    ['build-state-complete', 'client-flag'].includes(state.signal),
    `signal must be build-state-complete or client-flag, got: ${state.signal}`,
  );
});

test('getInterviewState: build-progress.json interviewComplete=true → complete:true', () => {
  cleanFiles();
  resetClientFlag();
  fs.mkdirSync(SUBDIR, { recursive: true });
  fs.writeFileSync(
    BUILD_PROGRESS_FILE,
    JSON.stringify({ interviewComplete: true, documents_total: 3, documents_complete: 1 }),
  );
  const state = getInterviewState();
  cleanFiles();
  resetClientFlag();

  assert.equal(state.complete, true, 'interviewComplete:true should unlock');
  assert.ok(
    ['build-state-complete', 'client-flag'].includes(state.signal),
    `signal must be build-state-complete or client-flag, got: ${state.signal}`,
  );
});

test('getInterviewState: documents_complete >= documents_total → complete:true', () => {
  cleanFiles();
  resetClientFlag();
  fs.writeFileSync(
    BUILD_STATE_FILE,
    JSON.stringify({ documents_total: 10, documents_complete: 10 }),
  );
  const state = getInterviewState();
  fs.unlinkSync(BUILD_STATE_FILE);
  resetClientFlag();

  assert.equal(state.complete, true, 'documents_complete >= documents_total should unlock');
  assert.ok(
    ['build-state-complete', 'client-flag'].includes(state.signal),
    `signal must be build-state-complete or client-flag, got: ${state.signal}`,
  );
});

test('getInterviewState: partial build (5/10 docs) → complete:false', () => {
  cleanFiles();
  resetClientFlag();
  fs.writeFileSync(
    BUILD_STATE_FILE,
    JSON.stringify({ documents_total: 10, documents_complete: 5 }),
  );
  const state = getInterviewState();
  fs.unlinkSync(BUILD_STATE_FILE);

  assert.equal(state.complete, false, 'partial build must not trigger complete');
});

// ── regression: clientFlag===false (or null) must NOT block filesystem signals ──
//
// Core regression guard. We verify that when a positive filesystem signal fires,
// the result is complete:true regardless of the DB flag state. We reset the
// client flag to 0 (false) BEFORE each check so the DB says "not complete",
// then write a filesystem artifact that SHOULD override it.
//
// In the old code, clientFlag===false caused an immediate return of complete:false.
// In the fixed code, the filesystem signals are checked even when clientFlag===false.

test('regression: interview-answers-file wins even when DB flag is false (0)', () => {
  cleanFiles();
  resetClientFlag(); // explicitly set interview_complete=0 in DB

  fs.writeFileSync(ANSWERS_FILE, '# Interview\nDone.\n');
  const state = getInterviewState();
  fs.unlinkSync(ANSWERS_FILE);
  resetClientFlag(); // clean up backfill

  assert.equal(
    state.complete,
    true,
    'interview-answers-file must win even when DB interview_complete=0',
  );
});

test('regression: build-state signal wins even when DB flag is false (0)', () => {
  cleanFiles();
  resetClientFlag();

  fs.writeFileSync(
    BUILD_STATE_FILE,
    JSON.stringify({ stage: 'done' }),
  );
  const state = getInterviewState();
  fs.unlinkSync(BUILD_STATE_FILE);
  resetClientFlag();

  assert.equal(
    state.complete,
    true,
    'build-state (stage=done) must win even when DB interview_complete=0',
  );
});
