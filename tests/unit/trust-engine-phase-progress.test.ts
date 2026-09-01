/**
 * U065 — Per-phase progress: un-collide blocked from progress, add phase-progress
 * message kind, plus the five-stamp-per-five-message guarantee.
 *
 * These are the U065 VERIFY checks V1–V6 rendered as real, failable tests plus
 * coverage for the five-stamp property and the priority ladder.
 *
 * The planner (planSends) is pure and is tested directly. Every test constructs
 * synthetic TrustTaskRow objects and PlanContext — no database, no network, no sends.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_DB = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'bc-trust-phase-progress-')),
  'mission-control.test.db',
);
process.env.DATABASE_PATH = TMP_DB;
process.env.OWNER_NOTIFY_TELEGRAM_DISABLED = '1';

type EngineModule = typeof import('../../src/lib/jobs/trust-engine');
type TrustTaskRow = import('../../src/lib/jobs/trust-engine').TrustTaskRow;

let engine: EngineModule;

const DAYTIME = new Date(2026, 6, 11, 15, 0, 0);
const NIGHT = new Date(2026, 6, 11, 4, 0, 0);
const noDeliverable = () => null;

function mkTask(over: Partial<TrustTaskRow>): TrustTaskRow {
  return {
    id: over.id ?? 'task-x',
    title: over.title ?? 'Sample task',
    status: over.status ?? 'backlog',
    department: over.department ?? 'sales',
    assigned_agent_name: over.assigned_agent_name ?? null,
    created_at: over.created_at ?? new Date().toISOString(),
    requester_channel: 'requester_channel' in over ? (over.requester_channel ?? null) : 'telegram',
    requester_chat_id: 'requester_chat_id' in over ? (over.requester_chat_id ?? null) : '12345',
    requester_session_key:
      'requester_session_key' in over ? (over.requester_session_key ?? null) : null,
    ack_sent_at: over.ack_sent_at ?? null,
    progress_last_sent_at: over.progress_last_sent_at ?? null,
    completion_sent_at: over.completion_sent_at ?? null,
    block_audience: over.block_audience ?? null,
    block_needs: over.block_needs ?? null,
    blocked_notice_sent_at: over.blocked_notice_sent_at ?? null,
    phase_progress_sent_at: over.phase_progress_sent_at ?? null,
    last_reported_phase_label: over.last_reported_phase_label ?? null,
  };
}

test.before(async () => {
  engine = await import('../../src/lib/jobs/trust-engine');
});

// ── V1 — the collision is gone: blocked-then-running gets its estimate ────────

test('V1: a task that blocked before its first progress message DOES receive progress-with-estimate afterwards', () => {
  const row = mkTask({
    id: 'v1',
    status: 'in_progress',
    title: 'Deck for Q3',
    department: 'presentations',
    assigned_agent_name: 'Deck Bot',
    progress_last_sent_at: null,  // never received progress — the defect before U065
    blocked_notice_sent_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(), // blocked 1h ago
  });
  const plans = engine.planSends([row], { now: DAYTIME, deliverableFor: noDeliverable });
  assert.equal(plans.length, 1, 'must produce exactly one plan');
  assert.match(plans[0].message, /is in progress with/);
  assert.match(plans[0].message, /Estimated completion:/);
  assert.equal(plans[0].stamps[0].guardColumn, 'progress_last_sent_at');
});

// ── V2 — blocked is immediate, not twelve hours late ──────────────────────────

test('V2: a task that blocks 10 min after a progress message is reported as blocked IMMEDIATELY', () => {
  const tenMinAgo = new Date(DAYTIME.getTime() - 10 * 60 * 1000).toISOString();
  const row = mkTask({
    id: 'v2',
    status: 'blocked',
    title: 'Brand deck',
    block_audience: 'OWNER',
    block_needs: 'the brand palette',
    progress_last_sent_at: tenMinAgo,
    blocked_notice_sent_at: null,
  });
  const plans = engine.planSends([row], { now: DAYTIME, deliverableFor: noDeliverable });
  assert.equal(plans.length, 1, 'must produce exactly one plan — blocked must fire immediately');
  assert.match(plans[0].message, /is paused waiting on you/);
  assert.match(plans[0].message, /the brand palette/);
  assert.equal(plans[0].stamps[0].guardColumn, 'blocked_notice_sent_at');
});

// V2-bis: blocked with the new stamp set is throttled (re-notify interval comes from blocked_notice_sent_at)
test('V2-bis: a recently blocked task is NOT re-sent within the re-notify interval', () => {
  const thirtyMinAgo = new Date(DAYTIME.getTime() - 30 * 60 * 1000).toISOString();
  const row = mkTask({
    id: 'v2b',
    status: 'blocked',
    title: 'Already blocked',
    block_audience: 'OWNER',
    block_needs: 'the Q3 figure',
    progress_last_sent_at: new Date(DAYTIME.getTime() - 60 * 60 * 1000).toISOString(),
    blocked_notice_sent_at: thirtyMinAgo,
    ack_sent_at: new Date(DAYTIME.getTime() - 2 * 60 * 60 * 1000).toISOString(),
  });
  const plans = engine.planSends([row], { now: DAYTIME, deliverableFor: noDeliverable });
  assert.equal(plans.length, 0, 'already blocked 30 min ago — must NOT re-notify');
});

// ── V3 — the ladder is intact ─────────────────────────────────────────────────

test('V3: a task that is simultaneously blocked and phase-eligible produces the BLOCKED message, not phase-progress', () => {
  const row = mkTask({
    id: 'v3',
    status: 'blocked',
    title: 'Conflict task',
    block_audience: 'OWNER',
    block_needs: 'the price list',
    progress_last_sent_at: new Date(DAYTIME.getTime() - 60 * 60 * 1000).toISOString(),
    blocked_notice_sent_at: null,
    ack_sent_at: null,
  });
  const phaseCtx: Parameters<typeof engine.planSends>[1] = {
    now: DAYTIME,
    deliverableFor: noDeliverable,
    phaseFor: () => ({ label: 'Script', budgetMs: 15 * 60 * 1000, doneCount: 2, totalCount: 7 }),
  };
  const plans = engine.planSends([row], phaseCtx);
  assert.equal(plans.length, 1, 'exactly ONE plan');
  assert.match(plans[0].message, /is paused waiting on you/);
  assert.doesNotMatch(plans[0].message, /I'll tell you when the next step/);
});

// ── V4 — non-pipeline task produces no phase noise ────────────────────────────

test('V4: a non-pipeline task (phaseFor returns null) produces NO phase message', () => {
  const row = mkTask({
    id: 'v4',
    status: 'in_progress',
    title: 'Non-pipeline task',
    progress_last_sent_at: new Date(DAYTIME.getTime() - 2 * 60 * 60 * 1000).toISOString(),
    phase_progress_sent_at: null,
    ack_sent_at: new Date(DAYTIME.getTime() - 3 * 60 * 60 * 1000).toISOString(),
  });
  const noPhaseCtx: Parameters<typeof engine.planSends>[1] = {
    now: DAYTIME,
    deliverableFor: noDeliverable,
    phaseFor: () => null,
  };
  const plans = engine.planSends([row], noPhaseCtx);
  assert.equal(plans.length, 0, 'no phaseFor result → no phase message');
});

// Also test with no phaseFor at all in context (the dormant case)
test('V4-bis: when phaseFor is not in context, no phase message is produced', () => {
  const row = mkTask({
    id: 'v4b',
    status: 'in_progress',
    title: 'Dormant task',
    progress_last_sent_at: new Date(DAYTIME.getTime() - 2 * 60 * 60 * 1000).toISOString(),
    phase_progress_sent_at: null,
    ack_sent_at: new Date(DAYTIME.getTime() - 3 * 60 * 60 * 1000).toISOString(),
  });
  // phaseFor is omitted — the branch is dormant
  const plans = engine.planSends([row], { now: DAYTIME, deliverableFor: noDeliverable });
  assert.equal(plans.length, 0, 'no phaseFor in context → branch dormant → no phase message');
});

// ── V5 — quiet hours hold the phase message ──────────────────────────────────

test('V5: quiet hours hold the phase message but not blocked/done', () => {
  const phaseRow = mkTask({
    id: 'v5-phase',
    status: 'in_progress',
    title: 'Phase task',
    progress_last_sent_at: new Date(NIGHT.getTime() - 2 * 60 * 60 * 1000).toISOString(),
    phase_progress_sent_at: null,
    ack_sent_at: new Date(NIGHT.getTime() - 3 * 60 * 60 * 1000).toISOString(),
  });
  const doneRow = mkTask({
    id: 'v5-done',
    status: 'done',
    title: 'Done task',
    completion_sent_at: null,
  });
  const blockedRow = mkTask({
    id: 'v5-blocked',
    status: 'blocked',
    title: 'Blocked task',
    block_audience: 'OWNER',
    block_needs: 'the answer',
    blocked_notice_sent_at: null,
  });

  // All three rows during quiet hours, with isNight=true
  const phaseCtx: Parameters<typeof engine.planSends>[1] = {
    now: NIGHT,
    isNight: true,
    deliverableFor: noDeliverable,
    phaseFor: () => ({ label: 'Script', budgetMs: 15 * 60 * 1000, doneCount: 1, totalCount: 7 }),
  };

  const plans = engine.planSends([phaseRow, doneRow, blockedRow], phaseCtx);
  // This test's own title says quiet hours hold the phase message "but not
  // blocked/done". The old assertion said 0 ('hold everything'), contradicting
  // the title. Production is right and the title is right: trust-engine.ts
  // carves done and blocked-on-OWNER OUT of quiet hours and holds ONLY the phase
  // report ("Held during quiet hours ... unlike done and blocked, a phase report
  // is never urgent enough to wake anyone. U044 must NOT carve this out.").
  // So exactly two plans survive, and the phase task is NOT one of them.
  assert.equal(plans.length, 2, 'done + blocked-on-OWNER survive quiet hours; the phase report does not');
  // PlannedSend carries no taskId of its own -- the task id lives on each stamp.
  const ids = plans.flatMap((pl) => pl.stamps.map((st) => st.taskId)).sort();
  assert.deepStrictEqual(ids, ['v5-blocked', 'v5-done'], 'the phase task must be the one held');
});

test('V5-bis: phase message at night with isNight=false (permissive) still respects the !night guard', () => {
  // isNight defaults to isQuietHour(ctx.now), which for NIGHT (4am) is true
  const row = mkTask({
    id: 'v5b',
    status: 'in_progress',
    title: 'Night phase task',
    progress_last_sent_at: new Date(NIGHT.getTime() - 2 * 60 * 60 * 1000).toISOString(),
    phase_progress_sent_at: null,
    ack_sent_at: new Date(NIGHT.getTime() - 3 * 60 * 60 * 1000).toISOString(),
  });
  const phaseCtx: Parameters<typeof engine.planSends>[1] = {
    now: NIGHT,
    deliverableFor: noDeliverable,
    phaseFor: () => ({ label: 'Script', budgetMs: 15 * 60 * 1000, doneCount: 1, totalCount: 7 }),
  };
  // Without isNight override, planSends uses isQuietHour(NIGHT)=true → held
  const plans = engine.planSends([row], phaseCtx);
  assert.equal(plans.length, 0, 'phase message held during quiet hours even without explicit isNight=true');
});

// ── V6 — no repeat on the same phase ─────────────────────────────────────────

test('V6: two consecutive sweeps with the same phase label produce only ONE message', () => {
  const now1 = new Date(DAYTIME.getTime());
  const row1 = mkTask({
    id: 'v6',
    status: 'in_progress',
    title: 'Same phase task',
    progress_last_sent_at: new Date(now1.getTime() - 2 * 60 * 60 * 1000).toISOString(),
    phase_progress_sent_at: null,
    last_reported_phase_label: null,
    ack_sent_at: new Date(now1.getTime() - 3 * 60 * 60 * 1000).toISOString(),
  });
  const phaseCtx: Parameters<typeof engine.planSends>[1] = {
    now: now1,
    deliverableFor: noDeliverable,
    phaseFor: () => ({ label: 'Script', budgetMs: 15 * 60 * 1000, doneCount: 1, totalCount: 7 }),
  };

  const plans1 = engine.planSends([row1], phaseCtx);
  assert.equal(plans1.length, 1, 'first sweep sends the phase-progress message');

  // Simulate that the first sweep stamped phase_progress_sent_at and last_reported_phase_label
  const stampedNow = new Date(now1.getTime() + 60 * 1000).toISOString();
  // Second sweep: same phase label, already reported
  const row2 = mkTask({
    id: 'v6',
    status: 'in_progress',
    title: 'Same phase task',
    progress_last_sent_at: new Date(now1.getTime() - 2 * 60 * 60 * 1000).toISOString(),
    phase_progress_sent_at: stampedNow,
    last_reported_phase_label: 'Script',
    ack_sent_at: new Date(now1.getTime() - 3 * 60 * 60 * 1000).toISOString(),
  });
  const now2 = new Date(now1.getTime() + 2 * 60 * 1000); // 2 min later — before budget
  const plans2 = engine.planSends([row2], { now: now2, deliverableFor: noDeliverable, phaseFor: () => ({ label: 'Script', budgetMs: 15 * 60 * 1000, doneCount: 1, totalCount: 7 }) });
  assert.equal(plans2.length, 0, 'second sweep must not re-send same phase label');
});

// ── V6-bis — advanced to a new phase after budget elapsed ────────────────────

test('V6-bis: a task that advanced to a new phase AFTER the budget elapsed fires phase-progress', () => {
  const oneHourAgo = new Date(DAYTIME.getTime() - 60 * 60 * 1000).toISOString();
  const row = mkTask({
    id: 'v6b',
    status: 'in_progress',
    title: 'Advancing task',
    progress_last_sent_at: new Date(DAYTIME.getTime() - 3 * 60 * 60 * 1000).toISOString(),
    phase_progress_sent_at: oneHourAgo,
    last_reported_phase_label: 'Script',
    ack_sent_at: new Date(DAYTIME.getTime() - 4 * 60 * 60 * 1000).toISOString(),
  });
  const phaseCtx: Parameters<typeof engine.planSends>[1] = {
    now: DAYTIME,
    deliverableFor: noDeliverable,
    phaseFor: () => ({ label: 'Prompts', budgetMs: 15 * 60 * 1000, doneCount: 3, totalCount: 7 }),
  };
  const plans = engine.planSends([row], phaseCtx);
  assert.equal(plans.length, 1, 'new phase label after old budget elapsed → must fire');
  assert.match(plans[0].message, /Prompts/);
  assert.match(plans[0].message, /step 3 of 7/);
});

// ── FIVE STAMPS FOR FIVE MESSAGE KINDS ────────────────────────────────────────

test('five message kinds, five distinct stamps: no sharing', () => {
  // ack uses ack_sent_at
  const ackRow = mkTask({ id: 'stamp-ack', status: 'assigned', ack_sent_at: null });
  const ackPlans = engine.planSends([ackRow], { now: DAYTIME, deliverableFor: noDeliverable });
  assert.equal(ackPlans.length, 1);
  assert.equal(ackPlans[0].stamps[0].guardColumn, 'ack_sent_at');

  // progress uses progress_last_sent_at
  const progRow = mkTask({ id: 'stamp-prog', status: 'in_progress', progress_last_sent_at: null });
  const progPlans = engine.planSends([progRow], { now: DAYTIME, deliverableFor: noDeliverable });
  assert.equal(progPlans.length, 1);
  assert.equal(progPlans[0].stamps[0].guardColumn, 'progress_last_sent_at');

  // blocked uses blocked_notice_sent_at
  const blkRow = mkTask({ id: 'stamp-blk', status: 'blocked', block_audience: 'OWNER', block_needs: 'thing', blocked_notice_sent_at: null });
  const blkPlans = engine.planSends([blkRow], { now: DAYTIME, deliverableFor: noDeliverable });
  assert.equal(blkPlans.length, 1);
  assert.equal(blkPlans[0].stamps[0].guardColumn, 'blocked_notice_sent_at');

  // phase-progress uses phase_progress_sent_at
  const phRow = mkTask({
    id: 'stamp-ph',
    status: 'in_progress',
    progress_last_sent_at: new Date(DAYTIME.getTime() - 2 * 60 * 60 * 1000).toISOString(),
    phase_progress_sent_at: null,
    ack_sent_at: new Date(DAYTIME.getTime() - 3 * 60 * 60 * 1000).toISOString(),
  });
  const phCtx: Parameters<typeof engine.planSends>[1] = {
    now: DAYTIME,
    deliverableFor: noDeliverable,
    phaseFor: () => ({ label: 'Intake', budgetMs: 15 * 60 * 1000, doneCount: 0, totalCount: 7 }),
  };
  const phPlans = engine.planSends([phRow], phCtx);
  assert.equal(phPlans.length, 1);
  assert.equal(phPlans[0].stamps[0].guardColumn, 'phase_progress_sent_at');

  // done uses completion_sent_at
  const doneRow = mkTask({ id: 'stamp-done', status: 'done', completion_sent_at: null });
  const donePlans = engine.planSends([doneRow], { now: DAYTIME, deliverableFor: noDeliverable });
  assert.equal(donePlans.length, 1);
  assert.equal(donePlans[0].stamps[0].guardColumn, 'completion_sent_at');

  // Verify all five are distinct
  const stamps = [
    ackPlans[0].stamps[0].guardColumn,
    progPlans[0].stamps[0].guardColumn,
    blkPlans[0].stamps[0].guardColumn,
    phPlans[0].stamps[0].guardColumn,
    donePlans[0].stamps[0].guardColumn,
  ];
  assert.equal(new Set(stamps).size, 5, 'all five message kinds must have distinct stamp columns');
});

// ── PHASE MESSAGE TEXT CONTAINS NO INTERNAL IDENTIFIERS ────────────────────────

test('phase message contains no internal identifier, file path, or tool trace', () => {
  const row = mkTask({
    id: 'qc3',
    status: 'in_progress',
    title: 'Internal phase check',
    progress_last_sent_at: new Date(DAYTIME.getTime() - 2 * 60 * 60 * 1000).toISOString(),
    phase_progress_sent_at: null,
    ack_sent_at: new Date(DAYTIME.getTime() - 3 * 60 * 60 * 1000).toISOString(),
  });
  const phaseCtx: Parameters<typeof engine.planSends>[1] = {
    now: DAYTIME,
    deliverableFor: noDeliverable,
    phaseFor: () => ({ label: 'Images', budgetMs: 15 * 60 * 1000, doneCount: 41, totalCount: 62 }),
  };
  const plans = engine.planSends([row], phaseCtx);
  assert.equal(plans.length, 1);
  const msg = plans[0].message;
  // Must contain the human label
  assert.match(msg, /Images/);
  // Must NOT contain any internal phase identifier pattern
  assert.doesNotMatch(msg, /P-\d/);
  assert.doesNotMatch(msg, /P-SP-/);
  assert.doesNotMatch(msg, /Exec run/);
  assert.doesNotMatch(msg, /python3/);
  assert.doesNotMatch(msg, /\.py/);
  assert.doesNotMatch(msg, /\/Users\//);
  assert.doesNotMatch(msg, /inline script/);
});

// ── BLOCKED_REASK: after the re-notify interval, blocked fires again ───────────

test('a task blocked more than BLOCKED_RENOTIFY_INTERVAL_MS ago fires again — re-ask is useful reminder', () => {
  const sevenHoursAgo = new Date(DAYTIME.getTime() - 7 * 60 * 60 * 1000).toISOString();
  const row = mkTask({
    id: 'reask',
    status: 'blocked',
    title: 'Old block',
    block_audience: 'OWNER',
    block_needs: 'the logo file',
    blocked_notice_sent_at: sevenHoursAgo,
    ack_sent_at: new Date(DAYTIME.getTime() - 10 * 60 * 60 * 1000).toISOString(),
  });
  const plans = engine.planSends([row], { now: DAYTIME, deliverableFor: noDeliverable });
  assert.equal(plans.length, 1, 'past the 6h re-notify window → must remind');
  assert.match(plans[0].message, /is paused waiting on you/);
  assert.match(plans[0].message, /the logo file/);
  assert.equal(plans[0].stamps[0].guardColumn, 'blocked_notice_sent_at');
});
