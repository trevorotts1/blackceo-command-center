/**
 * FIX 21 (presentation rev2 waves): SYSTEM-audience QC blocks must notify the
 * OPERATOR, rate-limited to 1 notification per blocked card per cooldown window
 * (default 3600s, PRESENTATION_SYSTEM_NOTIFY_COOLDOWN_S), with additional
 * same-card blocks inside the window COALESCED into a count on the next
 * window-allowed send. Different cards never coalesce into each other.
 *
 * BROKEN (pre-fix): the isSystemBlock branch wrote a Live-Feed qc_escalation
 * row and deliberately sent NO notification at all ("no owner Telegram") — a
 * SYSTEM fault (wrong SOP, missing builder, model misbind) could sit blocked
 * forever with zero operator signal.
 *
 * Proof shape (per spec): a SYSTEM-blocked card produces ONE operator
 * notification inside the rate window; pre-fix it produced none.
 *
 * Harness: real runQCOnReview over an isolated temp DB. The verdict is forced
 * deterministically via QC_FIXTURE_JSON_PATH (scoringPath 'llm', fail, with a
 * SYSTEM gap signal). The card is parked at the reroute cap via
 * qc_reroute_attempts = QC_MAX_REROUTES so the next fail lands the
 * block-after-cap branch. The operator Telegram send is captured by an
 * `openclaw` stub on a restricted PATH (same proven pattern as
 * notify-no-send-in-tests.test.ts): notifySystem → RUNG 2 → notifyTelegram →
 * execFile('openclaw', …) → sentinel file. No network, no real gateway.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ── Isolated DB FIRST (suite convention) ────────────────────────────────────
const TMP_DB = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'bc-fix21-')),
  'mission-control.test.db',
);
process.env.DATABASE_PATH = TMP_DB;

// Un-mute the operator send path FOR THIS FILE. The suite loader
// (tests/setup/no-owner-telegram.ts) sets OWNER_NOTIFY_TELEGRAM_DISABLED=1
// before any test module runs; this test deliberately exercises the send and
// proves it cannot leave the process (stubbed openclaw on a restricted PATH),
// so it opts back in via the module's own escape hatch.
delete process.env.OWNER_NOTIFY_TELEGRAM_DISABLED;
process.env.OWNER_NOTIFY_ALLOW_SEND_IN_TEST = '1';
// Pin the operator chat id to a known-good member of the allowlist.
process.env.CC_OPERATOR_CHAT_ID = '5252140759';
// RUNG 1 (Rescue Rangers webhook) must stay inert — no outbound HTTP.
delete process.env.RESCUE_RANGERS_WEBHOOK_URL;

// Sandbox the notification state dir (throttle JSONL + cooldown state).
const WORKSPACE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-fix21-ws-'));
process.env.OPENCLAW_WORKSPACE_PATH = WORKSPACE_DIR;

// Force the deterministic fixture verdict: FAIL + SYSTEM gap signal.
// "routing error" matches the isSystemBlock signal regex but dodges every
// classifyFailure unrouteable regex (no "no ... criteria", "brief", "vague").
const FIXTURE_PATH = path.join(WORKSPACE_DIR, 'qc-fixture.json');
fs.writeFileSync(
  FIXTURE_PATH,
  JSON.stringify({
    score: 3,
    pass: false,
    reason: 'Fixture verdict: judge scored the deliverable 3.0/10.',
    gaps: ['routing error: the auto-router attached the wrong builder for this card'],
  }),
);
process.env.QC_FIXTURE_JSON_PATH = FIXTURE_PATH;

// Park the card at the cap: attempts=1, cap=1 → next fail blocks.
process.env.QC_MAX_REROUTES = '1';

delete process.env.OPENAI_API_KEY;
delete process.env.GOOGLE_API_KEY;
delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
delete process.env.GEMINI_API_KEY;
delete process.env.DISABLE_QC_AUTO_SCORER;
delete process.env.NEXTAUTH_URL;
delete process.env.NEXT_PUBLIC_APP_URL;
delete process.env.MISSION_CONTROL_URL;

// ── openclaw stub (restricted PATH) ─────────────────────────────────────────
const SHIM_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-fix21-shim-'));
const SENTINEL = path.join(SHIM_DIR, 'openclaw-was-invoked.log');
fs.writeFileSync(
  path.join(SHIM_DIR, 'openclaw'),
  '#!/bin/sh\necho "invoked: $@" >> ' + JSON.stringify(SENTINEL) + '\n',
  { mode: 0o755 },
);

/** Current number of captured send lines. */
function sendCount(): number {
  return fs.existsSync(SENTINEL)
    ? fs.readFileSync(SENTINEL, 'utf8').split('\n').filter((l) => l.startsWith('invoked:')).length
    : 0;
}

/** Wait until the sentinel has at least `n` lines (send is fire-and-forget). */
async function waitForSends(n: number, timeoutMs = 5000): Promise<string[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const lines = fs.existsSync(SENTINEL)
      ? fs.readFileSync(SENTINEL, 'utf8').split('\n').filter((l) => l.startsWith('invoked:'))
      : [];
    if (lines.length >= n) return lines;
    if (Date.now() > deadline) return lines;
    await new Promise((r) => setTimeout(r, 50));
  }
}

type DbModule = typeof import('../../src/lib/db');
let run: DbModule['run'];
let queryOne: DbModule['queryOne'];
let getDb: DbModule['getDb'];
let closeDb: DbModule['closeDb'];

type QCScorerModule = typeof import('../../src/lib/qc-scorer');
let runQCOnReview: QCScorerModule['runQCOnReview'];
let __resetSystemBlockNotifyForTests: QCScorerModule["__resetSystemBlockNotifyForTests"] | undefined;
let SYSTEM_NOTIFY_COOLDOWN_S_val: QCScorerModule['SYSTEM_NOTIFY_COOLDOWN_S'];

let taskCounter = 0;
function nextId(prefix: string) {
  return `fix21-${prefix}-${Date.now()}-${++taskCounter}`;
}

/** Insert a task in `review`, parked at the reroute cap. */
function insertTask(id: string) {
  const now = new Date().toISOString();
  run(
    `INSERT INTO tasks (id, title, status, priority, workspace_id, created_at, updated_at)
     VALUES (?, ?, 'review', 'medium', NULL, ?, ?)`,
    // Title deliberately contains NO image/deck words (describesImageOrDeckDeliverable,
    // isImageTask, isDeckTask) so the card takes the Mode-B description path,
    // not invariant A's artifact handback.
    [id, `Quarterly ops memo ${id}`, now, now],
  );
  run(`UPDATE tasks SET qc_reroute_attempts = 1 WHERE id = ?`, [id]);
}

test.before(async () => {
  const savedPath = process.env.PATH;
  process.env.PATH = SHIM_DIR; // notifyTelegram must resolve ONLY our stub
  try {
    const db = await import('../../src/lib/db');
    run = db.run;
    queryOne = db.queryOne;
    getDb = db.getDb;
    closeDb = db.closeDb;
    getDb(); // trigger the full migration chain

    const scorer = await import('../../src/lib/qc-scorer');
    runQCOnReview = scorer.runQCOnReview;
    __resetSystemBlockNotifyForTests = scorer.__resetSystemBlockNotifyForTests;
    SYSTEM_NOTIFY_COOLDOWN_S_val = scorer.SYSTEM_NOTIFY_COOLDOWN_S;
  } finally {
    process.env.PATH = savedPath;
  }
});

test.after(() => {
  try { closeDb(); } catch { /* ignore */ }
  for (const d of [path.dirname(TMP_DB), WORKSPACE_DIR, SHIM_DIR]) {
    try { fs.rmSync(d, { force: true, recursive: true }); } catch { /* ignore */ }
  }
  delete process.env.QC_MAX_REROUTES;
  delete process.env.QC_FIXTURE_JSON_PATH;
  delete process.env.OWNER_NOTIFY_ALLOW_SEND_IN_TEST;
  delete process.env.CC_OPERATOR_CHAT_ID;
});

// ─── The load-bearing proof ──────────────────────────────────────────────────

test('FIX 21: SYSTEM-blocked card sends exactly ONE operator notification per cooldown window', async () => {
  const savedPath = process.env.PATH;
  process.env.PATH = SHIM_DIR;
  try {
    const notifyMod = await import('../../src/lib/notify');
    (notifyMod as { __resetNotifyThrottleForTests: () => void }).__resetNotifyThrottleForTests();
    __resetSystemBlockNotifyForTests?.();

    const taskId = nextId('sys');
    insertTask(taskId);

    const before = fs.existsSync(SENTINEL)
      ? fs.readFileSync(SENTINEL, 'utf8').split('\n').filter((l) => l.startsWith('invoked:')).length
      : 0;

    const result = await runQCOnReview(taskId);

    // The card really hit the SYSTEM block (audience classification proof).
    assert.ok(result, 'runQCOnReview returned a result');
    assert.equal(result.pass, false, 'fixture verdict must fail');
    const task = queryOne<{ status: string; block_audience: string | null }>(
      'SELECT status, block_audience FROM tasks WHERE id = ?',
      [taskId],
    );
    assert.ok(task, 'task row exists');
    assert.equal(task.status, 'blocked', 'card must be BLOCKED at the cap');
    assert.equal(task.block_audience, 'SYSTEM', 'block audience must be SYSTEM');
    const escEvent = queryOne<{ type: string; message: string }>(
      `SELECT type, message FROM events WHERE task_id = ? AND type = 'qc_escalation'`,
      [taskId],
    );
    assert.ok(escEvent, 'qc_escalation Live-Feed event still lands (unchanged)');

    // THE FIX-21 PROOF: one operator notification within the rate window.
    // Pre-fix this count was 0 — the branch explicitly sent nothing.
    const lines = await waitForSends(before + 1);
    assert.ok(
      lines.length > before,
      `SYSTEM block must notify the operator — expected >=1 openclaw send, got ${lines.length - before}`,
    );
    assert.equal(
      lines.length - before,
      1,
      `exactly ONE notification inside the cooldown window, got ${lines.length - before}`,
    );
    const sent = lines[lines.length - 1];
    assert.ok(sent.includes('--channel telegram'), 'send must be gateway Telegram');
    assert.ok(sent.includes('--target 5252140759'), 'send must target the OPERATOR chat');
    assert.ok(
      sent.includes('QC-SYSTEM-BLOCK') || sent.includes(taskId),
      `notification must name the blocked card, got: ${sent}`,
    );
  } finally {
    process.env.PATH = savedPath;
  }
});

test('FIX 21: second SYSTEM block of the SAME card inside the window coalesces (no new send)', async () => {
  const savedPath = process.env.PATH;
  process.env.PATH = SHIM_DIR;
  try {
    const notifyMod = await import('../../src/lib/notify');
    (notifyMod as { __resetNotifyThrottleForTests: () => void }).__resetNotifyThrottleForTests();
    __resetSystemBlockNotifyForTests?.();

    const taskId = nextId('coalesce');
    insertTask(taskId);

    const baseline = sendCount();
    await runQCOnReview(taskId);
    // The first block for a fresh card must send exactly one line.
    const afterFirst = (await waitForSends(baseline + 1)).length;
    assert.equal(afterFirst, baseline + 1, 'first block sent exactly one notification');

    // Re-block the SAME card: flip it back to review at the cap, re-run.
    run(`UPDATE tasks SET status = 'review', qc_reroute_attempts = 1 WHERE id = ?`, [taskId]);
    await runQCOnReview(taskId);
    await new Promise((r) => setTimeout(r, 400)); // fire-and-forget settle

    const afterSecond = sendCount();
    assert.equal(
      afterSecond - afterFirst,
      0,
      `same-card re-block inside the ${SYSTEM_NOTIFY_COOLDOWN_S_val}s window must NOT send again ` +
      `(coalesced) — delta was ${afterSecond - afterFirst}`,
    );

    // Coalesced count is recorded durably: the next window-eligible send for
    // this card must carry the accumulated "Nth block" note.
    const statePath = path.join(WORKSPACE_DIR, '.qc-system-block-notify.json');
    assert.ok(fs.existsSync(statePath), 'per-card cooldown state file must exist');
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8')) as Record<string, unknown>;
    const entry = state[taskId] as { count: number } | undefined;
    assert.ok(entry, `state must key by card id (${taskId})`);
    assert.ok(entry.count >= 2, `coalesced blocks must be counted, got ${entry?.count}`);
  } finally {
    process.env.PATH = savedPath;
  }
});

test('FIX 21: a DIFFERENT card blocked inside the window is NOT coalesced into the first card', async () => {
  const savedPath = process.env.PATH;
  process.env.PATH = SHIM_DIR;
  try {
    const notifyMod = await import('../../src/lib/notify');
    (notifyMod as { __resetNotifyThrottleForTests: () => void }).__resetNotifyThrottleForTests();
    __resetSystemBlockNotifyForTests?.();

    const taskA = nextId('cardA');
    const taskB = nextId('cardB');
    insertTask(taskA);
    insertTask(taskB);

    const baseline = sendCount();
    await runQCOnReview(taskA);
    const afterA = (await waitForSends(baseline + 1)).length;
    assert.equal(afterA, baseline + 1, 'card A notified exactly once');

    await runQCOnReview(taskB);
    const afterB = (await waitForSends(afterA + 1)).length;
    assert.equal(
      afterB - afterA,
      1,
      `different card must get its OWN notification inside the window, delta ${afterB - afterA}`,
    );
  } finally {
    process.env.PATH = savedPath;
  }
});

test('FIX 21: cooldown window config validation rejects non-positive values (falls back to default)', () => {
  assert.ok(
    SYSTEM_NOTIFY_COOLDOWN_S_val === 3600,
    `default cooldown must be 3600s, got ${SYSTEM_NOTIFY_COOLDOWN_S_val}`,
  );
});

test('FIX 21: OWNER-audience blocks never reach the SYSTEM notify path (regression guard)', async () => {
  // Same fixture path, but a gap with NO system signal → audience=OWNER → the
  // pre-existing notifyOwner branch fires (also captured by the stub); what
  // must NOT happen is a second SYSTEM-path send for the same card.
  const savedPath = process.env.PATH;
  process.env.PATH = SHIM_DIR;
  try {
    fs.writeFileSync(
      FIXTURE_PATH,
      JSON.stringify({
        score: 3,
        pass: false,
        reason: 'Fixture verdict: judge scored the deliverable 3.0/10.',
        gaps: ['tone does not match the owner brief and the closing call to action is missing'],
      }),
    );
    __resetSystemBlockNotifyForTests?.();

    const taskId = nextId('owner');
    insertTask(taskId);
    const result = await runQCOnReview(taskId);
    assert.ok(result, 'runQCOnReview returned a result');
    const task = queryOne<{ block_audience: string | null }>(
      'SELECT block_audience FROM tasks WHERE id = ?',
      [taskId],
    );
    assert.equal(task?.block_audience, 'OWNER', 'non-system gaps must classify OWNER');

    // Restore the SYSTEM fixture for other tests in this file.
    fs.writeFileSync(
      FIXTURE_PATH,
      JSON.stringify({
        score: 3,
        pass: false,
        reason: 'Fixture verdict: judge scored the deliverable 3.0/10.',
        gaps: ['routing error: the auto-router attached the wrong builder for this card'],
      }),
    );
  } finally {
    process.env.PATH = savedPath;
  }
});
