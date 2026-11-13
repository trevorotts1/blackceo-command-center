/**
 * stale-and-hygiene-fourth-pass.test.ts — U-17 acceptance (CC-052, CC-054,
 * CC-063, CC-064, CC-051 on the board-hygiene messages).
 *
 * Eight cases, one temporary database:
 *   1. A stale in_progress card returns to backlog with its description EXACTLY
 *      as its author wrote it — no [STALE-RETURN] note is pasted in (CC-052).
 *   2. A card blocked on its OWNER leaves Blocked only after a reminder that
 *      really went out and the answer window that follows it (CC-054).
 *   3. That reminder is a plain-English "Reminder:" message — no tag, no task id
 *      — and nothing is recorded while owner sends are muted.
 *   4. A card blocked on the OPERATOR is returned at the window, unchanged.
 *   5. Backlog cards no longer crowd the candidate list out of live cards.
 *   6. A stale card whose requester was never asked is recorded as unasked and
 *      is NEVER auto-archived (CC-064 / CC-051).
 *   7. A card whose own row was saved after the nudge is never auto-archived.
 *   8. No client-facing message contains an internal tag, a column name or a
 *      task id.
 *
 *   node --import tsx --test tests/unit/stale-and-hygiene-fourth-pass.test.ts
 */

// SAFETY: sends are enabled ONLY so they can reach the stub `openclaw` placed on
// PATH below — the real gateway binary is never first on PATH, so no message can
// reach a live chat. The operator lane has no webhook.
process.env.OWNER_NOTIFY_ALLOW_SEND_IN_TEST = '1';
delete process.env.OWNER_NOTIFY_TELEGRAM_DISABLED;
delete process.env.RESCUE_RANGERS_WEBHOOK_URL;
delete process.env.CC_OPERATOR_CHAT_ID;
delete process.env.OPENCLAW_OPERATOR_CHAT_ID;
delete process.env.DISABLE_STALE_TASK_SWEEP;
delete process.env.DISABLE_BOARD_HYGIENE;
delete process.env.STALE_REPING_DEDUP_HOURS;
delete process.env.STALE_BLOCKED_REPING_HOURS;
delete process.env.STALE_BLOCKED_REPINGED_HOURS;

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-u17-fourth-pass-'));
const SHIM_DIR = path.join(SANDBOX, 'bin');
const SENTINEL = path.join(SANDBOX, 'openclaw-sent.log');
fs.mkdirSync(SHIM_DIR, { recursive: true });
// A stub `openclaw` that records every invocation and never talks to a network.
fs.writeFileSync(
  path.join(SHIM_DIR, 'openclaw'),
  `#!/bin/sh\necho "$@" >> ${JSON.stringify(SENTINEL)}\n`,
  { mode: 0o755 },
);

process.env.OPENCLAW_WORKSPACE_PATH = path.join(SANDBOX, 'workspace');
fs.mkdirSync(process.env.OPENCLAW_WORKSPACE_PATH, { recursive: true });
// A real owner record so the owner-facing path is genuinely exercised.
process.env.OPENCLAW_OWNER_CHAT_ID = '5550002222';
// An empty projects dir: no fixture title can match a real folder on disk.
process.env.PROJECTS_PATH = path.join(SANDBOX, 'projects');
fs.mkdirSync(process.env.PROJECTS_PATH, { recursive: true });

import './_isolated-db'; // MUST be first DB import: throwaway DATABASE_PATH.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { v4 as uuidv4 } from 'uuid';
import { getDb, run, queryOne, queryAll } from '../../src/lib/db';
import { runStaleTaskSweep, __setStaleSweepClockForTests } from '../../src/lib/jobs/stale-task-sweep';
import { runBoardHygiene } from '../../src/lib/jobs/board-hygiene';

getDb(); // apply the full migration chain

const REAL_PATH = process.env.PATH ?? '';
const TWO_PM = () => new Date(2026, 0, 15, 14, 0, 0); // 2:00 PM, box-local

before(() => {
  process.env.PATH = `${SHIM_DIR}:${REAL_PATH}`;
  // The sweep's quiet-hours check is the one clock-sensitive decision.
  __setStaleSweepClockForTests(TWO_PM);
  // Keep the hygiene run to the two lanes these cases need; the review lane
  // would spawn a scorer, and the rest have nothing to act on.
  process.env.DISABLE_BOARD_HYGIENE_REVIEW = '1';
  process.env.DISABLE_BOARD_HYGIENE_DONE = '1';
  process.env.DISABLE_BOARD_HYGIENE_TRIAD = '1';
  process.env.DISABLE_BOARD_HYGIENE_ENGINE_OWNED = '1';
  process.env.DISABLE_BOARD_HYGIENE_BLEND_REGRESSION = '1';
  process.env.DISABLE_BOARD_HYGIENE_BLEND_INVARIANT = '1';
  process.env.DISABLE_BOARD_HYGIENE_WINNER_HARVEST = '1';
});

after(() => {
  __setStaleSweepClockForTests(null);
  process.env.PATH = REAL_PATH;
  fs.rmSync(SANDBOX, { recursive: true, force: true });
});

function hoursAgo(h: number): string {
  return new Date(Date.now() - h * 60 * 60 * 1000).toISOString();
}
function daysAgo(d: number): string {
  return hoursAgo(d * 24);
}

function seedWorkspace(): string {
  const id = `ws-${uuidv4()}`;
  run('INSERT INTO workspaces (id, name, slug, sort_order) VALUES (?, ?, ?, 1000)', [
    id,
    'operations',
    `operations-${uuidv4().slice(0, 8)}`,
  ]);
  return id;
}

interface SeedOpts {
  title: string;
  status: string;
  ageHours: number;
  description?: string | null;
  updatedHoursAgo?: number;
  blockedOn?: 'owner' | 'operator';
  requesterChatId?: string | null;
  blockAudience?: string | null;
  blockNeeds?: string | null;
}

function seedTask(opts: SeedOpts): string {
  const id = uuidv4();
  const ws = seedWorkspace();
  const updated = opts.updatedHoursAgo !== undefined ? hoursAgo(opts.updatedHoursAgo) : hoursAgo(opts.ageHours);
  run(
    `INSERT INTO tasks (id, title, status, workspace_id, description, blocked_on_human, blocked_reason,
                        ask, block_audience, block_needs, requester_chat_id, updated_at, last_progress_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      opts.title,
      opts.status,
      ws,
      opts.description ?? null,
      opts.blockedOn ?? null,
      opts.blockedOn ? 'decision' : null,
      opts.blockedOn ? 'A decision on the fixture item' : null,
      opts.blockAudience ?? null,
      opts.blockNeeds ?? null,
      opts.requesterChatId ?? null,
      updated,
      hoursAgo(opts.ageHours),
    ],
  );
  return id;
}

function taskRow(id: string) {
  return queryOne<{ status: string; description: string | null; archived_at: string | null }>(
    'SELECT status, description, archived_at FROM tasks WHERE id = ?',
    [id],
  );
}

function eventRows(id: string, type: string) {
  return queryAll<{ message: string }>(
    'SELECT message FROM events WHERE task_id = ? AND type = ? ORDER BY created_at',
    [id, type],
  );
}

function taskReturnedCount(id: string): number {
  return (
    queryOne<{ n: number }>(
      `SELECT COUNT(*) AS n FROM events WHERE task_id = ? AND type = 'task_returned'`,
      [id],
    )?.n ?? 0
  );
}

async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 80));
}

/** Every line the stub `openclaw` recorded, as one string. */
function sentLog(): string {
  try {
    return fs.readFileSync(SENTINEL, 'utf8');
  } catch {
    return '';
  }
}

/** Wait (briefly) until the stub log satisfies `check`, and return the log. */
async function waitForLog(check: (log: string) => boolean, timeoutMs = 3_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let log = sentLog();
  while (!check(log) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 40));
    log = sentLog();
  }
  return log;
}

// ── 1. No note in the client's description (CC-052) ─────────────────────────
test('1. a stale in_progress card returns to backlog with its description EXACTLY unchanged', async () => {
  const id = seedTask({
    title: 'Weekly newsletter draft',
    status: 'in_progress',
    ageHours: 25,
    description: 'Write the newsletter',
  });

  const result = await runStaleTaskSweep();
  await flush();

  assert.ok(result.returned >= 1, 'the stale card was returned');
  const row = taskRow(id);
  assert.equal(row?.status, 'backlog', 'the card returned to backlog');
  assert.equal(row?.description, 'Write the newsletter', 'the description is byte-identical to what its author wrote');
  assert.equal(taskReturnedCount(id), 1, 'the handback is recorded on ONE task_returned event');
});

// ── 2. A card waiting on its owner leaves only after a sent reminder ────────
test('2. an owner-blocked card leaves Blocked only after a reminder and its answer window (CC-054)', async () => {
  const noReminder = seedTask({
    title: 'Approve the vendor terms',
    status: 'blocked',
    ageHours: 7,
    blockedOn: 'owner',
  });
  const remindedRecently = seedTask({
    title: 'Confirm the vendor address',
    status: 'blocked',
    ageHours: 7,
    blockedOn: 'owner',
  });
  const remindedLongAgo = seedTask({
    title: 'Sign the vendor contract',
    status: 'blocked',
    ageHours: 7,
    blockedOn: 'owner',
  });
  run(
    `INSERT INTO events (id, type, task_id, message, created_at)
     VALUES (?, 'stale_blocked_repinged', ?, 'fixture reminder', ?)`,
    [uuidv4(), remindedRecently, hoursAgo(1)],
  );
  run(
    `INSERT INTO events (id, type, task_id, message, created_at)
     VALUES (?, 'stale_blocked_repinged', ?, 'fixture reminder', ?)`,
    [uuidv4(), remindedLongAgo, hoursAgo(5)],
  );

  await runStaleTaskSweep();
  await flush();

  assert.equal(
    taskRow(noReminder)?.status,
    'blocked',
    'no reminder can be proven sent ⇒ the card stays Blocked and a reminder is attempted instead',
  );
  assert.equal(
    taskRow(remindedRecently)?.status,
    'blocked',
    'a reminder sent 1h ago is still inside the 4h answer window ⇒ the card stays Blocked',
  );
  assert.equal(
    taskRow(remindedLongAgo)?.status,
    'backlog',
    'a reminder sent 5h ago cleared the answer window ⇒ the card returns to the orchestrator',
  );
});

// ── 3. The reminder is a plain message, and a mute records nothing ──────────
test('3. the owner reminder is plain English with no tag and no task id; a mute records nothing', async () => {
  const id = seedTask({
    title: 'Pick the venue for the summit',
    status: 'blocked',
    ageHours: 3,
    blockedOn: 'owner',
    requesterChatId: '5550001111',
  });
  const rowsBefore = (
    queryOne<{ n: number }>(
      `SELECT COUNT(*) AS n FROM events WHERE task_id = ? AND type = 'stale_blocked_repinged'`,
      [id],
    )?.n ?? 0
  );
  const linesBefore = sentLog().split('\n').filter((l) => l.trim()).length;

  await runStaleTaskSweep();
  const log = await waitForLog(
    (l) => l.split('\n').some((line) => line.includes('5550001111') && line.includes('Reminder:')),
  );

  const mine = log
    .split('\n')
    .filter((l) => l.trim())
    .slice(linesBefore)
    .filter((l) => l.includes('5550001111') && l.includes('Reminder:'));
  assert.equal(mine.length, 1, 'exactly one "Reminder:" message went to the requester');
  assert.equal(mine[0].includes('['), false, 'the message carries no tag');
  assert.equal(mine[0].includes(id), false, 'and it never leaks the task id');

  const rowsAfter = (
    queryOne<{ n: number }>(
      `SELECT COUNT(*) AS n FROM events WHERE task_id = ? AND type = 'stale_blocked_repinged'`,
      [id],
    )?.n ?? 0
  );
  assert.equal(rowsAfter, rowsBefore + 1, 'the delivered reminder is recorded once');

  // The same card shape under a mute: nothing is recorded, so the next run retries.
  const muted = seedTask({
    title: 'Choose the summit date',
    status: 'blocked',
    ageHours: 3,
    blockedOn: 'owner',
    requesterChatId: '5550003333',
  });
  process.env.OWNER_NOTIFY_TELEGRAM_DISABLED = '1';
  try {
    await runStaleTaskSweep();
    await flush();
    assert.equal(
      eventRows(muted, 'stale_blocked_repinged').length,
      0,
      'a muted reminder is not recorded — it did not go out',
    );
    assert.equal(taskRow(muted)?.status, 'blocked');
  } finally {
    delete process.env.OWNER_NOTIFY_TELEGRAM_DISABLED;
  }
});

// ── 4. An operator-blocked card is returned at the window, unchanged ────────
test('4. a card blocked on the OPERATOR 7 hours is returned to backlog (unchanged behaviour)', async () => {
  const id = seedTask({
    title: 'Grant the storage credential',
    status: 'blocked',
    ageHours: 7,
    blockedOn: 'operator',
  });

  await runStaleTaskSweep();
  await flush();

  assert.equal(taskRow(id)?.status, 'backlog', 'an operator-blocked card keeps today\'s behaviour');
});

// ── 5. Backlog cards no longer crowd live cards out of the scan ─────────────
test('5. 120 stale backlog cards do not stop a live in_progress card being returned (CC-063)', async () => {
  const ws = seedWorkspace();
  for (let i = 0; i < 120; i++) {
    run(
      `INSERT INTO tasks (id, title, status, workspace_id, updated_at, last_progress_at)
       VALUES (?, ?, 'backlog', ?, ?, ?)`,
      [uuidv4(), `Parked idea ${i}`, ws, daysAgo(5), daysAgo(5)],
    );
  }
  // Created LAST, and therefore the newest candidate — pre-fix it never reached
  // the scan behind the older backlog rows.
  const live = seedTask({ title: 'Quarterly plan refresh', status: 'in_progress', ageHours: 30 });

  const result = await runStaleTaskSweep();
  await flush();

  assert.ok(result.returned >= 1, 'the sweep returned a card');
  assert.equal(taskRow(live)?.status, 'backlog', 'the live card behind 120 backlog rows is still swept');
  assert.equal(taskReturnedCount(live), 1, 'exactly one handback event for it');
});

// ── 6. A card nobody was asked is never auto-archived ───────────────────────
test('6. a stale card with no requester is recorded unasked and is never archived (CC-064)', async () => {
  const id = seedTask({ title: 'Revisit the pricing page copy', status: 'backlog', ageHours: 22 * 24 });

  await runBoardHygiene();
  assert.equal(eventRows(id, 'board_hygiene_stale_nudged').length, 0, 'nobody was asked, so there is no nudge row');
  assert.equal(eventRows(id, 'board_hygiene_stale_unasked').length, 1, 'the unasked state is recorded once');
  assert.equal(taskRow(id)?.archived_at, null, 'and the card is not archived');

  // Eight days later, with the unasked record long past the grace window: still
  // not archived, because the archive clock starts only from a real nudge.
  run(
    `UPDATE events SET created_at = ? WHERE task_id = ? AND type = 'board_hygiene_stale_unasked'`,
    [daysAgo(8), id],
  );
  await runBoardHygiene();
  assert.equal(taskRow(id)?.archived_at, null, 'a card nobody was asked is never auto-archived');
  assert.equal(eventRows(id, 'board_hygiene_stale_unasked').length, 1, 'the unasked record is not duplicated');
});

// ── 7. Saving any change keeps the card (CC-051) ────────────────────────────
test('7. a nudged card whose row was saved after the nudge is never archived', async () => {
  // last_progress_at never moved (22d) but the card itself was saved 1 day ago —
  // exactly what the message promises keeps it.
  const id = seedTask({
    title: 'Update the case study',
    status: 'backlog',
    ageHours: 22 * 24,
    updatedHoursAgo: 24,
    requesterChatId: '5550004444',
  });

  await runBoardHygiene();
  assert.equal(eventRows(id, 'board_hygiene_stale_nudged').length, 1, 'the requester was really asked');

  // The grace window is long past; the saved row is what keeps it.
  run(
    `UPDATE events SET created_at = ? WHERE task_id = ? AND type = 'board_hygiene_stale_nudged'`,
    [daysAgo(8), id],
  );
  await runBoardHygiene();

  assert.equal(taskRow(id)?.archived_at, null, 'a saved change keeps the card — it must NOT auto-archive');
});

// ── 8. No internal vocabulary reaches a client ──────────────────────────────
test('8. no client-facing message carries a tag, a column name or a task id', async () => {
  const staleOwner = seedTask({
    title: 'Approve the printer quote',
    status: 'blocked',
    ageHours: 49,
    blockedOn: 'owner',
    blockAudience: 'OWNER',
    blockNeeds: 'Your approval of the printer quote',
    requesterChatId: '5550005555',
  });
  const staleNudge = seedTask({
    title: 'Refresh the onboarding photos',
    status: 'backlog',
    ageHours: 22 * 24,
    requesterChatId: '5550006666',
  });
  const sweepReminder = seedTask({
    title: 'Confirm the delivery window',
    status: 'blocked',
    ageHours: 3,
    blockedOn: 'owner',
    requesterChatId: '5550007777',
  });

  fs.writeFileSync(SENTINEL, '', 'utf8');
  await runBoardHygiene();
  await runStaleTaskSweep();
  const log = await waitForLog(
    (l) =>
      l.includes('5550005555') && l.includes('5550006666') && l.includes('5550007777'),
  );

  const messages = log.split('\n').filter((l) => l.trim());
  assert.ok(messages.length >= 3, 'the three client messages really went out');

  for (const line of messages) {
    assert.equal(line.includes('[BOARD-HYGIENE]'), false, `internal tag leaked: ${line}`);
    assert.equal(/backlog/i.test(line), false, `internal column name leaked: ${line}`);
    assert.equal(/inbox/i.test(line), false, `internal column name leaked: ${line}`);
    for (const id of [staleOwner, staleNudge, sweepReminder]) {
      assert.equal(line.includes(id), false, `task id leaked: ${line}`);
    }
  }
});
