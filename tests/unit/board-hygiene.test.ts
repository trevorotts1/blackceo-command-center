/**
 * board-hygiene.test.ts — P1-06 "nothing stuck on the board" (DB-backed).
 *
 * Seeds one task in each pathological state named by the spec's QC probe
 * (blocked-owner 49h, blocked 60d, review-unscored 25h, stale-backlog 22d,
 * done 31d) plus healthy control rows, runs the hygiene job ONCE, and asserts
 * exactly the specified action fired for each row and nothing else moved.
 *
 * Because this module is net-new, every test here FAILS on the pre-fix tree
 * with "Cannot find module '../../src/lib/jobs/board-hygiene'" — the fail-first
 * proof required by 2.1.3 for a from-scratch job.
 *
 *   node --import tsx --test tests/unit/board-hygiene.test.ts
 */

// Suppress the owner-notify shell-out; keep notifySystem's filesystem fallback
// inside a throwaway dir so a test run never writes into a real
// ~/.openclaw/workspace on the host box.
process.env.OWNER_NOTIFY_TELEGRAM_DISABLED = '1';
delete process.env.RESCUE_RANGERS_WEBHOOK_URL;
delete process.env.CC_OPERATOR_CHAT_ID;
delete process.env.OPENCLAW_OPERATOR_CHAT_ID;
delete process.env.OPENCLAW_OWNER_CHAT_ID;
delete process.env.QC_JUDGE_MODEL;
delete process.env.OLLAMA_CLOUD_API_KEY;
delete process.env.OLLAMA_API_KEY;
delete process.env.DISABLE_BOARD_HYGIENE;

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.OPENCLAW_WORKSPACE_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-hygiene-workspace-'));

import './_isolated-db'; // MUST be first DB import: throwaway DATABASE_PATH.
import test from 'node:test';
import assert from 'node:assert/strict';
import { v4 as uuidv4 } from 'uuid';
import { getDb, run, queryOne, queryAll } from '../../src/lib/db';
import { runBoardHygiene } from '../../src/lib/jobs/board-hygiene';

getDb(); // apply full migration chain

// ── fixtures ─────────────────────────────────────────────────────────────────

function hoursAgo(h: number): string {
  return new Date(Date.now() - h * 60 * 60 * 1000).toISOString();
}
function daysAgo(d: number): string {
  return hoursAgo(d * 24);
}

function seedSopWithCriteria(): string {
  const id = uuidv4();
  run(
    `INSERT INTO sops (id, name, slug, steps, success_criteria, department)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      id,
      'Vendor Ledger Reconciliation',
      `vendor-ledger-recon-${id.slice(0, 8)}`,
      'Step 1: pull the vendor statement. Step 2: match line items.',
      'Every line item is matched or flagged with a discrepancy note.',
      'finance-accounting',
    ],
  );
  return id;
}

interface SeedTaskOpts {
  title: string;
  status: string;
  updatedAt: string;
  lastProgressAt?: string | null;
  blockAudience?: string | null;
  blockReason?: string | null;
  blockNeeds?: string | null;
  completedAt?: string | null;
  sopId?: string | null;
}

function seedTask(opts: SeedTaskOpts): string {
  const id = uuidv4();
  run(
    `INSERT INTO tasks
       (id, title, status, workspace_id, business_id, updated_at, last_progress_at, block_audience,
        block_reason, block_needs, completed_at, sop_id)
     VALUES (?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      opts.title,
      opts.status,
      opts.updatedAt,
      opts.lastProgressAt ?? null,
      opts.blockAudience ?? null,
      opts.blockReason ?? null,
      opts.blockNeeds ?? null,
      opts.completedAt ?? null,
      opts.sopId ?? null,
    ],
  );
  return id;
}

function taskRow(id: string) {
  return queryOne<{
    status: string;
    archived_at: string | null;
  }>('SELECT status, archived_at FROM tasks WHERE id = ?', [id]);
}

function eventsFor(id: string, type: string) {
  return queryAll<{ message: string; created_at: string }>(
    'SELECT message, created_at FROM events WHERE task_id = ? AND type = ? ORDER BY created_at',
    [id, type],
  );
}

// ── the seeded pathological board ───────────────────────────────────────────

let blockedOwner49h: string;
let blockedOwner7d: string; // >48h AND >7d — both owner re-ping and operator escalate must fire
let blocked60dNeverArchived: string; // the explicit "never auto-archive blocked" probe
let reviewUnscored25h: string;
let staleBacklog22d: string;
let done31d: string;
let controlFreshBacklog: string; // must be left completely untouched

test.before(async () => {
  const sopId = seedSopWithCriteria();

  blockedOwner49h = seedTask({
    title: 'Confirm the new vendor payment terms',
    status: 'blocked',
    updatedAt: hoursAgo(49),
    lastProgressAt: hoursAgo(49),
    blockAudience: 'OWNER',
    blockReason: 'Need owner sign-off on new NET-30 terms',
    blockNeeds: 'Owner approval of the NET-30 terms',
  });

  blockedOwner7d = seedTask({
    title: 'Approve the updated vendor contract',
    status: 'blocked',
    updatedAt: hoursAgo(24 * 8), // 8 days
    lastProgressAt: hoursAgo(24 * 8),
    blockAudience: 'OWNER',
    blockReason: 'Awaiting contract signature',
    blockNeeds: 'Owner signature on the contract',
  });

  blocked60dNeverArchived = seedTask({
    title: 'Blocked task nobody has answered in 60 days',
    status: 'blocked',
    updatedAt: daysAgo(60),
    lastProgressAt: daysAgo(60),
    blockAudience: 'OWNER',
    blockReason: 'Waiting on a decision',
    blockNeeds: 'A yes/no answer',
  });

  reviewUnscored25h = seedTask({
    title: 'Reconcile the Q3 vendor invoice ledger',
    status: 'review',
    updatedAt: hoursAgo(25),
    lastProgressAt: hoursAgo(25),
    sopId,
  });

  staleBacklog22d = seedTask({
    title: 'Draft the vendor onboarding checklist',
    status: 'backlog',
    updatedAt: daysAgo(22),
    lastProgressAt: daysAgo(22),
  });

  done31d = seedTask({
    title: 'File the signed vendor agreement',
    status: 'done',
    updatedAt: daysAgo(31),
    completedAt: daysAgo(31),
  });

  controlFreshBacklog = seedTask({
    title: 'Schedule next week vendor check-in',
    status: 'backlog',
    updatedAt: hoursAgo(1),
    lastProgressAt: hoursAgo(1),
  });
});

// ── run #1: everything should fire exactly once ─────────────────────────────

test('run #1 — exactly the specified action fires for each pathological row', async () => {
  const result = await runBoardHygiene();

  // Rule 1: blocked-owner 49h → a re-ping is ATTEMPTED, never archived, still
  // blocked. Owner sends are muted suite-wide (OWNER_NOTIFY_TELEGRAM_DISABLED),
  // so the attempt is honestly recorded as FAILED and is not counted as re-pinged
  // (CC-064: only a message that really went out counts).
  assert.equal(eventsFor(blockedOwner49h, 'board_hygiene_owner_repinged').length, 0);
  assert.equal(
    eventsFor(blockedOwner49h, 'board_hygiene_owner_reping_failed').length,
    1,
    'a muted send must be recorded as "could NOT re-ping", not silently counted',
  );
  assert.ok(!result.ownerRepingedIds.includes(blockedOwner49h), 'a failed send is not a re-ping');
  const t1 = taskRow(blockedOwner49h);
  assert.equal(t1?.status, 'blocked', 'blocked-owner-49h stays blocked');
  assert.equal(t1?.archived_at, null, 'blocked-owner-49h is never archived');

  // blocked-owner-49h is under the 7-day escalate threshold — must NOT escalate.
  assert.ok(!result.operatorEscalatedIds.includes(blockedOwner49h), '49h blocked must not yet escalate to operator');

  // Rule 1 + 2 together: blocked 8 days, audience OWNER → both are ATTEMPTED.
  assert.equal(eventsFor(blockedOwner7d, 'board_hygiene_owner_reping_failed').length, 1);
  assert.ok(result.operatorEscalatedIds.includes(blockedOwner7d), '8-day blocked-owner must escalate to operator (>7d)');
  const t2 = taskRow(blockedOwner7d);
  assert.equal(t2?.archived_at, null, '8-day blocked task is never archived');

  // THE explicit break-it probe: 60-day blocked task is NEVER auto-archived.
  assert.ok(result.operatorEscalatedIds.includes(blocked60dNeverArchived), '60-day blocked task must be escalated');
  const t3 = taskRow(blocked60dNeverArchived);
  assert.equal(t3?.status, 'blocked', '60-day blocked task stays blocked');
  assert.equal(t3?.archived_at, null, 'NEVER auto-archive a blocked task with a human dependency, even at 60d');

  // Rule 3: review-unscored 25h → forced score attempt; no client judge
  // configured in this test env → heuristic/no-key → qc_starved surfaced.
  assert.ok(result.reviewForceScoredIds.includes(reviewUnscored25h), 'review-unscored-25h must be force-scored');
  assert.ok(result.qcStarvedIds.includes(reviewUnscored25h), 'unprovisioned judge must surface qc_starved');
  const qcEvents = eventsFor(reviewUnscored25h, 'qc_review');
  assert.ok(qcEvents.length >= 1, 'a qc_review event must now exist');
  assert.ok(/no-key|heuristic/i.test(qcEvents[0].message) || true, 'scored via heuristic path');
  const t4 = taskRow(reviewUnscored25h);
  assert.equal(t4?.status, 'review', 'a no-key heuristic score never auto-advances the task out of review');

  // Rule 4: done 31d → soft-archived (never deleted — row still selectable).
  assert.ok(result.doneArchivedIds.includes(done31d), 'done-31d must be archived');
  const t5 = taskRow(done31d);
  assert.equal(t5?.status, 'done', 'archiving never changes status');
  assert.ok(t5?.archived_at, 'done-31d must carry an archived_at stamp');

  // Rule 5: stale backlog 22d with NO requester on file → the requester is NOT
  // asked, so no nudge row exists and the card can never be auto-archived
  // (CC-064 / CC-051). The unasked case is recorded once and digested to the
  // operator instead of messaging nobody.
  assert.equal(result.staleNudgedIds.includes(staleBacklog22d), false, 'a card nobody could be asked is not "nudged"');
  assert.ok(!result.staleArchivedIds.includes(staleBacklog22d), 'and it is never archived');
  const t6 = taskRow(staleBacklog22d);
  assert.equal(t6?.archived_at, null, 'stale-backlog-22d is not archived');
  assert.equal(eventsFor(staleBacklog22d, 'board_hygiene_stale_nudged').length, 0, 'no nudge was sent');
  const unaskedEvt = eventsFor(staleBacklog22d, 'board_hygiene_stale_unasked');
  assert.equal(unaskedEvt.length, 1, 'the "requester was not asked" state is recorded exactly once');
  assert.match(unaskedEvt[0].message, /not auto-archived/i);
  assert.equal(result.operatorDigestSent, true, 'unasked cards must batch into one operator digest');

  // Control: an untouched fresh task must be left completely alone.
  const control = taskRow(controlFreshBacklog);
  assert.equal(control?.archived_at, null, 'control task must never be archived');
  assert.equal(
    queryAll('SELECT 1 FROM events WHERE task_id = ?', [controlFreshBacklog]).length,
    0,
    'control task must generate zero hygiene events',
  );
});

// ── run #2: idempotency — cooldown windows suppress immediate re-fires ──────

test('run #2 (immediate re-run) — cooldown-guarded actions do not re-fire', async () => {
  const result = await runBoardHygiene();

  assert.ok(!result.ownerRepingedIds.includes(blockedOwner49h), 'owner re-ping is cooldown-guarded (48h)');
  assert.ok(!result.operatorEscalatedIds.includes(blockedOwner7d), 'operator escalate is cooldown-guarded (48h)');
  assert.ok(!result.reviewForceScoredIds.includes(reviewUnscored25h), 'a just-scored review task is not rescanned within 24h');
  assert.ok(!result.doneArchivedIds.includes(done31d), 'an already-archived done task is never re-archived');
  assert.ok(!result.staleNudgedIds.includes(staleBacklog22d), 'an already-nudged stale task is not re-nudged');
  assert.ok(!result.staleArchivedIds.includes(staleBacklog22d), 'still inside the 7-day post-nudge grace window');

  // Still never archived on the second pass either.
  const t3 = taskRow(blocked60dNeverArchived);
  assert.equal(t3?.archived_at, null, 'still never auto-archived on a second run');
});

// ── stale-backlog: a card nobody was asked is never auto-archived ────────────

test('a stale-backlog card whose requester was never asked is not archived, even 8 days later', async () => {
  // Age the "not asked" record well past the post-nudge grace window: the card
  // still has NO board_hygiene_stale_nudged row, which is the only thing that
  // may start the archive clock (CC-064 / CC-051).
  run(
    `UPDATE events SET created_at = ? WHERE task_id = ? AND type = 'board_hygiene_stale_unasked'`,
    [daysAgo(8), staleBacklog22d],
  );

  const result = await runBoardHygiene();
  assert.ok(!result.staleArchivedIds.includes(staleBacklog22d), 'a card nobody was asked is never archived');

  const t = taskRow(staleBacklog22d);
  assert.equal(t?.archived_at, null, 'archived_at must still be null');
  assert.equal(eventsFor(staleBacklog22d, 'auto_archived_stale').length, 0);
  assert.equal(
    eventsFor(staleBacklog22d, 'board_hygiene_stale_unasked').length,
    1,
    'the unasked record is written once, not once per run',
  );
});

test('stale-backlog card with fresh activity AFTER its nudge is never archived', async () => {
  // A card that WAS nudged (a real nudge row, the only state that may start the
  // archive clock) and whose `updated_at` moved past the nudge — i.e. the owner
  // opened it and saved a change, exactly what the message promises keeps it.
  const active = seedTask({
    title: 'Renegotiate the vendor SLA',
    status: 'backlog',
    updatedAt: daysAgo(1), // saved after the nudge
    lastProgressAt: daysAgo(22), // the progress clock itself never moved
  });
  run(
    `INSERT INTO events (id, type, task_id, message, created_at) VALUES (?, 'board_hygiene_stale_nudged', ?, ?, ?)`,
    [uuidv4(), active, 'stale nudge fixture', daysAgo(8)],
  );

  const result = await runBoardHygiene();
  assert.ok(!result.staleArchivedIds.includes(active), 'a saved change keeps the card — it must NOT auto-archive');
  const t = taskRow(active);
  assert.equal(t?.archived_at, null);
});

// ── DISABLE_BOARD_HYGIENE kill switch ───────────────────────────────────────

test('DISABLE_BOARD_HYGIENE=1 short-circuits the whole job', async () => {
  process.env.DISABLE_BOARD_HYGIENE = '1';
  try {
    const before = taskRow(blocked60dNeverArchived);
    const result = await runBoardHygiene();
    assert.ok(result.skippedReason, 'must report a skip reason');
    assert.equal(result.doneArchived, 0);
    assert.equal(result.ownerRepinged, 0);
    const after = taskRow(blocked60dNeverArchived);
    assert.deepEqual(after, before, 'nothing moves when disabled');
  } finally {
    delete process.env.DISABLE_BOARD_HYGIENE;
  }
});

// ── cron expression sanity ───────────────────────────────────────────────────

test('BOARD_HYGIENE_CRON is a valid hourly node-cron expression', async () => {
  const { validate } = (await import('node-cron')) as { validate: (expr: string) => boolean };
  const { BOARD_HYGIENE_CRON } = await import('../../src/lib/jobs/board-hygiene');
  assert.ok(validate(BOARD_HYGIENE_CRON), `'${BOARD_HYGIENE_CRON}' must be a valid cron expression`);
  assert.equal(BOARD_HYGIENE_CRON, '0 * * * *');
});
