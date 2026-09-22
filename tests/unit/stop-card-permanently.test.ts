/**
 * stop-card-permanently.test.ts — the behavioural half of "no card stops
 * permanently in silence".
 *
 * The guard test (silent-terminal-stop-guard.test.ts) proves no NEW terminal
 * write can skip the chokepoint. This file proves the chokepoint actually does
 * what the operator's rule requires, against a real database:
 *
 *   1. a permanent stop writes a plain-English block_reason, stamps
 *      blocked_notice_sent_at, and sends exactly ONE notice;
 *   2. a SECOND tick over the same stopped card sends NOTHING (the stamp is a
 *      claim, not a flag) — the restart / repeated-sweep case;
 *   3. a SYSTEM-audience stop reaches the operator and NEVER the client, and is
 *      still claimed exactly once (MOVE-IN-SILENCE is preserved, silence is not);
 *   4. the reason names the cause in words a non-technical owner can act on, and
 *      the machine detail is persisted for diagnosis WITHOUT being read out;
 *   5. a card merely WAITING — queued, held, retrying — is never notified,
 *      because the chokepoint is only ever called on a terminal stop and refuses
 *      to notify a card it could not actually block;
 *   6. leaving `blocked` RELEASES the claim, so the card's NEXT permanent stop
 *      notifies again rather than inheriting a stale stamp.
 *
 *   node --import tsx --test tests/unit/stop-card-permanently.test.ts
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_DB = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'bc-stop-card-')),
  'mission-control.test.db',
);
process.env.DATABASE_PATH = TMP_DB;
process.env.OPENCLAW_GATEWAY_URL = 'not-a-valid-url';
process.env.OPENCLAW_GATEWAY_TOKEN = '';

type DbModule = typeof import('../../src/lib/db');
type StopCardModule = typeof import('../../src/lib/stop-card');
type NotifyModule = typeof import('../../src/lib/notify');

let run: DbModule['run'];
let queryOne: DbModule['queryOne'];
let queryAll: DbModule['queryAll'];
let closeDb: DbModule['closeDb'];
let stopCardPermanently: StopCardModule['stopCardPermanently'];
let stoppedNotice: StopCardModule['stoppedNotice'];

/**
 * Sends are observed through the durable undeliverable log rather than by
 * stubbing the transport: the suite mutes every real owner send (see
 * tests/setup/no-owner-telegram.ts AND notify.ts::ownerSendsSuppressed), so a
 * muted send is exactly what a test box should produce. What matters for the
 * operator's rule is whether the chokepoint DECIDED to send and CLAIMED the
 * right to — which is observable in `blocked_notice_sent_at` and in the result
 * it returns. Counting transport calls would test the mute, not the rule.
 */
let taskSeq = 0;
function mkTask(over: Partial<{ status: string; title: string; requester_chat_id: string | null }> = {}): string {
  const id = `stop-card-${++taskSeq}`;
  run(
    `INSERT INTO tasks (id, title, description, status, department, workspace_id,
                        requester_chat_id, requester_channel)
     VALUES (?, ?, ?, ?, ?, NULL, ?, ?)`,
    [
      id,
      over.title ?? `Stop card ${taskSeq}`,
      'A card used by the no-silent-stop tests.',
      over.status ?? 'in_progress',
      'general-task',
      over.requester_chat_id === undefined ? '123456789' : over.requester_chat_id,
      'telegram',
    ],
  );
  return id;
}

function readTask(id: string) {
  return queryOne<{
    status: string;
    block_reason: string | null;
    block_needs: string | null;
    block_audience: string | null;
    blocked_notice_sent_at: string | null;
    ask: string | null;
  }>(
    `SELECT status, block_reason, block_needs, block_audience, blocked_notice_sent_at, ask
       FROM tasks WHERE id = ?`,
    [id],
  );
}

test.before(async () => {
  const db: DbModule = await import('../../src/lib/db');
  run = db.run;
  queryOne = db.queryOne;
  queryAll = db.queryAll;
  closeDb = db.closeDb;
  db.getDb(); // run the full migration chain

  const notify: NotifyModule = await import('../../src/lib/notify');
  // Sanity: the suite-wide owner mute is active, so nothing here can reach a
  // real person's phone. This is an assertion, not a setup step — if it ever
  // stops holding, this file must fail loudly rather than send.
  assert.equal(notify.ownerSendsSuppressed(), true, 'owner sends must be suppressed under the test runner');

  ({ stopCardPermanently, stoppedNotice } = await import('../../src/lib/stop-card'));
});

test.after(() => {
  try { closeDb(); } catch { /* already closed */ }
  fs.rmSync(path.dirname(TMP_DB), { recursive: true, force: true });
});

test('a permanent stop writes a plain-English reason, stamps the claim, and notifies exactly once', async () => {
  const id = mkTask();

  const first = await stopCardPermanently({
    taskId: id,
    source: 'qc-scorer',
    reason: 'This work did not pass our quality check after 3 attempt(s), so it has stopped rather than go out wrong.',
    needs: 'Tell us which of the two headlines you want and we will finish it.',
    audience: 'OWNER',
    gaps: ['headline not chosen', 'no source cited'],
    retriesExhausted: true,
    machineDetail: 'qc_score=4.2/10 attempts=3 cap=3',
  });

  assert.equal(first.blocked, true, 'the card must actually be blocked');
  assert.equal(first.notified, true, 'the first call must win the notice claim');

  const row = readTask(id);
  assert.equal(row?.status, 'blocked');
  assert.ok(row?.blocked_notice_sent_at, 'blocked_notice_sent_at must be stamped — this is the live defect');
  assert.equal(row?.block_audience, 'OWNER');
  assert.equal(row?.ask, 'Tell us which of the two headlines you want and we will finish it.');

  // Plain English, for a person who does not know what QC is.
  const reason = row?.block_reason ?? '';
  assert.match(reason, /did not pass our quality check/, 'the reason must name the cause in words');
  assert.doesNotMatch(reason, /qc_score|cap=|EDEADLK|\bnull\b/i, 'the reason must carry no machine detail');

  // The machine detail is persisted for diagnosis, in the durable events lane.
  const detail = queryAll<{ message: string }>(
    `SELECT message FROM events WHERE task_id = ? AND type = 'task_blocked'`,
    [id],
  );
  assert.ok(
    detail.some((e) => e.message.includes('qc_score=4.2/10 attempts=3 cap=3')),
    'the machine detail must be recoverable from the database for diagnosis',
  );
});

test('a second tick over the same stopped card does NOT re-notify', async () => {
  const id = mkTask();

  const first = await stopCardPermanently({
    taskId: id,
    source: 'stuck-in-progress-sweep',
    reason: 'This work was picked up but then went quiet, so it has been stopped.',
    needs: 'Check the session log, then re-run or close it.',
    audience: 'OWNER',
  });
  assert.equal(first.notified, true);
  const stampAfterFirst = readTask(id)?.blocked_notice_sent_at;

  // The sweep ticks again over the same card — and a process restart between
  // the two looks identical from here.
  const second = await stopCardPermanently({
    taskId: id,
    source: 'stuck-in-progress-sweep',
    reason: 'This work was picked up but then went quiet, so it has been stopped.',
    needs: 'Check the session log, then re-run or close it.',
    audience: 'OWNER',
  });

  assert.equal(second.blocked, true, 'the card is still stopped');
  assert.equal(second.notified, false, 'the second tick must NOT re-notify');
  assert.equal(second.delivery, 'already-claimed');
  assert.equal(
    readTask(id)?.blocked_notice_sent_at,
    stampAfterFirst,
    'the claim stamp must not move on a repeated tick',
  );
});

test('a SYSTEM-audience stop goes to the operator lane, never the client, and is still claimed once', async () => {
  const id = mkTask();

  const first = await stopCardPermanently({
    taskId: id,
    source: 'backlog-redispatch-sweep',
    reason: 'We tried to start this 4 time(s) over more than 6 hours and it never got going, so it has stopped retrying.',
    needs: 'Diagnose why the card cannot advance, then re-route or fix it.',
    audience: 'SYSTEM',
    retriesExhausted: true,
  });

  assert.equal(first.blocked, true);
  assert.equal(first.notified, true);
  assert.equal(first.delivery, 'system', 'a SYSTEM stop must never take the client lane');
  assert.equal(readTask(id)?.block_audience, 'SYSTEM');
  assert.ok(readTask(id)?.blocked_notice_sent_at, 'a SYSTEM stop is claimed too — it must not be silent either');

  const second = await stopCardPermanently({
    taskId: id,
    source: 'backlog-redispatch-sweep',
    reason: 'We tried to start this 4 time(s) over more than 6 hours and it never got going, so it has stopped retrying.',
    needs: 'Diagnose why the card cannot advance, then re-route or fix it.',
    audience: 'SYSTEM',
  });
  assert.equal(second.notified, false, 'the operator is not paged twice for one stop');
});

test('a card that is merely WAITING is never notified — the chokepoint refuses a card it could not block', async () => {
  // A queued card that nothing has stopped. The chokepoint is only ever called
  // on a terminal stop, and this proves the failure mode is safe: when the
  // status flip does not land, nothing is claimed and nothing is sent.
  const waiting = mkTask({ status: 'backlog' });

  const result = await stopCardPermanently({
    taskId: waiting,
    source: 'test-illegal-edge',
    reason: 'should never be delivered',
    needs: 'should never be delivered',
    audience: 'OWNER',
    // CAS against a status the card is NOT in — the transition is refused.
    expectedFrom: 'review',
  });

  assert.equal(result.blocked, false, 'a refused transition must not report the card as stopped');
  assert.equal(result.notified, false, 'a card that was not stopped is never announced as stopped');
  const row = readTask(waiting);
  assert.equal(row?.status, 'backlog', 'the waiting card is untouched');
  assert.equal(row?.blocked_notice_sent_at, null, 'no claim is taken for a stop that did not happen');
  assert.equal(row?.block_reason, null);
});

test('an unknown task id is a no-op, not a throw — a notice must never take down its caller', async () => {
  const result = await stopCardPermanently({
    taskId: 'no-such-task-id',
    source: 'test',
    reason: 'x',
    needs: 'y',
    audience: 'OWNER',
  });
  assert.deepEqual(result, { blocked: false, notified: false, delivery: 'not-blocked' });
});

test('leaving blocked RELEASES the claim, so the next permanent stop notifies again', async () => {
  const { transition } = await import('../../src/lib/task-lifecycle');
  const id = mkTask();

  const first = await stopCardPermanently({
    taskId: id,
    source: 'task-dispatcher',
    reason: 'We tried to start this work 5 time(s) and it did not go through, so it has stopped.',
    needs: 'Check the connection to the assistant, then re-send the card.',
    audience: 'OWNER',
    retriesExhausted: true,
  });
  assert.equal(first.notified, true);
  assert.ok(readTask(id)?.blocked_notice_sent_at);

  // Someone resolves it and the card goes back to work.
  await transition(id, 'backlog', { actor: 'operator', reason: 'unblocked by hand' });
  assert.equal(
    readTask(id)?.blocked_notice_sent_at,
    null,
    'leaving blocked must clear the claim — otherwise the SECOND stop is permanently silent',
  );

  // It fails again. The owner must hear about it again.
  const second = await stopCardPermanently({
    taskId: id,
    source: 'task-dispatcher',
    reason: 'We tried to start this work 5 time(s) and it did not go through, so it has stopped.',
    needs: 'Check the connection to the assistant, then re-send the card.',
    audience: 'OWNER',
    retriesExhausted: true,
  });
  assert.equal(second.blocked, true);
  assert.equal(second.notified, true, 'a NEW permanent stop must produce a NEW notice');
});

test('the notice names the card, the cause, the exhausted retries, and the one thing to do', () => {
  const withRetries = stoppedNotice({
    title: 'Episode 12 show notes',
    reason: 'The files we needed to write from could not be opened.',
    needs: 'Re-upload the handoff package and we will pick it straight back up.',
    retriesExhausted: true,
  });
  assert.match(withRetries, /Episode 12 show notes/);
  assert.match(withRetries, /could not be opened/);
  assert.match(withRetries, /used up its automatic retries/);
  assert.match(withRetries, /Re-upload the handoff package/);

  const withoutRetries = stoppedNotice({
    title: 'Episode 12 show notes',
    reason: 'The files we needed to write from could not be opened.',
    needs: 'Re-upload the handoff package.',
  });
  assert.doesNotMatch(withoutRetries, /used up its automatic retries/);
  assert.match(withoutRetries, /will not start again on its own/);
});
