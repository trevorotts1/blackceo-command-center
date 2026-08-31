/**
 * FIX 24 (presentation rev2 waves) — BEHAVIORAL stall-window fixtures.
 *
 * BROKEN (pre-fix): presentations stale-exempt 72h, blocked first re-ping 72h
 * (half of the 144h return window), operator escalation 144h total, progress
 * throttle 12h. A blocked card sat silent for a business day and escalated
 * only days later.
 *
 * FIX (shipped defaults): stale-exempt 24h, first re-ping 2h, operator
 * escalation/return 6h total from first block, progress at most once per 1h.
 * FIX 21's immediate SYSTEM-block notification is NOT touched (qc-scorer.ts
 * is out of scope and its own suite is the regression guard for t=0).
 *
 * These tests import ONLY pre-existing module exports (runStaleTaskSweep,
 * planSends, STALE_TASK_SWEEP_GLOBAL_DEFAULTS) so the SAME file is the red
 * proof on the pre-fix tree and the green proof post-fix.
 *
 *   node --import tsx --import ./tests/setup/no-owner-telegram.ts --test tests/unit/fix24-stall-windows-behavior.test.ts
 */

process.env.OWNER_NOTIFY_TELEGRAM_DISABLED = '1';
delete process.env.RESCUE_RANGERS_WEBHOOK_URL;
delete process.env.DISABLE_STALE_TASK_SWEEP;
delete process.env.STALE_BLOCKED_REPING_HOURS;
delete process.env.STALE_BLOCKED_REPINGED_HOURS;
delete process.env.PRESENTATIONS_RENDER_EXEMPT_HOURS;
delete process.env.TRUST_ENGINE_PROGRESS_MIN_INTERVAL_HOURS;
delete process.env.STALE_REPING_DEDUP_HOURS;

import './_isolated-db'; // MUST be first.
import test from 'node:test';
import assert from 'node:assert/strict';
import { v4 as uuidv4 } from 'uuid';
import { getDb, run, queryOne } from '../../src/lib/db';
import {
  runStaleTaskSweep,
  resolveBlockedWindows,
  STALE_BLOCKED_REPING_HOURS,
  STALE_TASK_SWEEP_GLOBAL_DEFAULTS,
  PRESENTATIONS_RENDER_EXEMPT_HOURS,
} from '../../src/lib/jobs/stale-task-sweep';
import {
  planSends,
  PROGRESS_MIN_INTERVAL_MS,
  resolveProgressMinIntervalHours,
} from '../../src/lib/jobs/trust-engine';

getDb(); // apply the full migration chain (071 last_progress_at, 104 ask invariant)

function hoursAgo(h: number): string {
  return new Date(Date.now() - h * 60 * 60 * 1000).toISOString();
}

function seedWorkspace(label: string): string {
  const id = `ws-${uuidv4()}`;
  run('INSERT INTO workspaces (id, name, slug, sort_order) VALUES (?, ?, ?, 1000)', [
    id,
    label,
    `${label}-${uuidv4().slice(0, 8)}`,
  ]);
  return id;
}

function seedAgent(workspaceId: string): string {
  const id = uuidv4();
  run('INSERT INTO agents (id, name, role, workspace_id, is_master, status) VALUES (?, ?, ?, ?, 0, ?)', [
    id,
    'Deck Designer',
    'Department Head',
    workspaceId,
    'working',
  ]);
  return id;
}

/** Blocked task with a non-empty ask (migration-104 invariant) + real workspace. */
function seedBlockedTask(who: 'operator' | 'owner', ageHours: number, department: string | null = null): string {
  const id = uuidv4();
  const wsId = seedWorkspace('operations');
  run(
    `INSERT INTO tasks (id, title, status, workspace_id, department, blocked_on_human, blocked_reason, ask, updated_at, last_progress_at)
     VALUES (?, ?, 'blocked', ?, ?, ?, 'decision', 'Awaiting a human decision (fixture)', ?, ?)`,
    [id, `Blocked task ${id.slice(0, 8)}`, wsId, department, who, hoursAgo(ageHours), hoursAgo(ageHours)],
  );
  return id;
}

/** in_progress presentations task with REAL recent activity (an events row). */
function seedPresentationsInProgress(ageHours: number): string {
  const id = uuidv4();
  const wsId = seedWorkspace('presentations');
  const agentId = seedAgent(wsId);
  run(
    `INSERT INTO tasks (id, title, status, workspace_id, department, assigned_agent_id, updated_at, last_progress_at)
     VALUES (?, ?, 'in_progress', ?, 'presentations', ?, ?, ?)`,
    [id, `Deck render ${id.slice(0, 8)}`, wsId, agentId, hoursAgo(ageHours), hoursAgo(ageHours)],
  );
  run('INSERT INTO events (id, type, task_id, message, created_at) VALUES (?, ?, ?, ?, ?)', [
    uuidv4(),
    'phase_exit',
    id,
    'render phase exited (fixture activity)',
    new Date().toISOString(),
  ]);
  return id;
}

function taskStatus(id: string): string | undefined {
  return queryOne<{ status: string }>('SELECT status FROM tasks WHERE id = ?', [id])?.status;
}

function repingEventCount(taskId: string): number {
  const row = queryOne<{ n: number }>(
    `SELECT COUNT(*) AS n FROM events
      WHERE task_id = ? AND type IN ('stale_repinged', 'stale_blocked_repinged')`,
    [taskId],
  );
  return row?.n ?? 0;
}

// ── 1. immediate notify at t=0 (FIX 21 path untouched; blocked-first-notice immediate) ──

test('FIX24 t=0: a blocked card with NO prior notice is notified IMMEDIATELY, not throttled', () => {
  const row = {
    id: 't0',
    title: 'Brand deck',
    status: 'blocked',
    department: 'presentations',
    assigned_agent_name: null,
    created_at: new Date().toISOString(),
    requester_channel: 'telegram',
    requester_chat_id: '12345',
    ack_sent_at: null,
    progress_last_sent_at: null,
    completion_sent_at: null,
    block_audience: 'OWNER',
    block_needs: 'the palette',
    blocked_notice_sent_at: null,
    phase_progress_sent_at: null,
    last_reported_phase_label: null,
    process_certificate_sha: null,
    source: null,
  } as import('../..//src/lib/jobs/trust-engine').TrustTaskRow;
  const plans = planSends([row], { now: new Date(2026, 6, 11, 15, 0, 0), deliverableFor: () => null });
  assert.equal(plans.length, 1, 'first block notice must be immediate — assert on the plan, not a wall clock');
  assert.equal(plans[0].stamps[0].guardColumn, 'blocked_notice_sent_at');
});

// ── 2. presentations stale exemption: 72h -> 24h ──────────────────────────────

test('FIX24 stale: a presentations render idle 25h is STALE (exempt only 24h) and returns', async () => {
  const id = seedPresentationsInProgress(25);
  const result = await runStaleTaskSweep();
  assert.equal(taskStatus(id), 'backlog', `25h idle presentation with recent activity must return (exempt window is 24h, not 72h) — got ${taskStatus(id)}`);
  assert.ok(result.returned >= 1, 'the returned counter must reflect it');
});

test('FIX24 stale: a presentations render idle 23h is STILL EXEMPT (no false stale closure)', async () => {
  const id = seedPresentationsInProgress(23);
  const result = await runStaleTaskSweep();
  assert.equal(taskStatus(id), 'in_progress', '23h idle presentation remains exempt — a live render is legitimately long');
  assert.equal((result.returnedIds ?? []).includes(id), false, 'not returned');
});

// ── 3. blocked first re-ping: 72h -> 2h (fires at 2h, never at 72h) ───────────

test('FIX24 reping: a blocked card idle just past 2h is re-pinged (first re-ping window)', async () => {
  // 2.1h: the candidate fetch is `age > tightestWindow` (strict), so EXACTLY 2h
  // sits on the boundary between ticks — a real box catches it on the next
  // */10 cron tick. Just past 2h is the inbound side of the window.
  const id = seedBlockedTask('operator', 2.1);
  const result = await runStaleTaskSweep();
  assert.equal(result.repinged, 1, `2h-old blocked card must be re-pinged — got repinged=${result.repinged}`);
  assert.equal(repingEventCount(id), 1, 'dedup key written');
  assert.equal(taskStatus(id), 'blocked', 're-ping never mutates status');
});

test('FIX24 reping: a blocked card idle 1.5h is NOT re-pinged (before the window)', async () => {
  const id = seedBlockedTask('operator', 1.5);
  const result = await runStaleTaskSweep();
  assert.equal(result.repinged, 0, `1.5h-old blocked card must NOT be re-pinged — got repinged=${result.repinged}`);
  assert.equal(repingEventCount(id), 0, 'no dedup key before the window');
  assert.equal(taskStatus(id), 'blocked');
});

test('FIX24 reping: at 72h the card already ESCALATED (returned at 6h) — it is retired, not re-pinged', async () => {
  const id = seedBlockedTask('operator', 72);
  const result = await runStaleTaskSweep();
  assert.equal(result.repinged, 0, `a 72h-old card must NOT be re-pinged — it escalated at 6h; got repinged=${result.repinged}`);
  assert.equal(result.returned, 1, `a 72h-old blocked card must be returned to the orchestrator — got returned=${result.returned}`);
  assert.equal(taskStatus(id), 'backlog', 'escalation is the return transition');
});

// ── 4. operator escalation window: 144h total -> 6h total ─────────────────────

test('FIX24 escalate: a blocked card idle 6h is ESCALATED (return to orchestrator)', async () => {
  const id = seedBlockedTask('operator', 6);
  const result = await runStaleTaskSweep();
  assert.equal(result.returned, 1, `6h-old blocked card must escalate (return) — got returned=${result.returned}`);
  assert.equal(taskStatus(id), 'backlog');
});

test('FIX24 escalate: a blocked card idle 5.9h is NOT yet escalated', async () => {
  const id = seedBlockedTask('operator', 5.9);
  const result = await runStaleTaskSweep();
  assert.equal(result.returned, 0, `5.9h-old blocked card must not escalate yet — got returned=${result.returned}`);
  assert.equal(taskStatus(id), 'blocked');
});

// ── 5. progress throttle: 12h -> 1h (at most once per hour) ───────────────────

function progressRow(id: string, phaseSentHoursAgo: number | null, label: string) {
  const DAYTIME = new Date(2026, 6, 11, 15, 0, 0);
  return {
    id,
    title: 'Deck phase task',
    status: 'in_progress',
    department: 'presentations',
    assigned_agent_name: null,
    created_at: new Date(DAYTIME.getTime() - 5 * 60 * 60 * 1000).toISOString(),
    requester_channel: 'telegram',
    requester_chat_id: '12345',
    ack_sent_at: new Date(DAYTIME.getTime() - 4 * 60 * 60 * 1000).toISOString(),
    progress_last_sent_at: new Date(DAYTIME.getTime() - 3 * 60 * 60 * 1000).toISOString(),
    completion_sent_at: null,
    block_audience: null,
    block_needs: null,
    blocked_notice_sent_at: null,
    phase_progress_sent_at: phaseSentHoursAgo === null ? null : new Date(DAYTIME.getTime() - phaseSentHoursAgo * 60 * 60 * 1000).toISOString(),
    last_reported_phase_label: 'Script',
    process_certificate_sha: null,
    source: null,
  } as import('../..//src/lib/jobs/trust-engine').TrustTaskRow;
}
const phaseCtx = (label: string) => ({
  now: new Date(2026, 6, 11, 15, 0, 0),
  deliverableFor: () => null,
  phaseFor: () => ({ label, budgetMs: 15 * 60 * 1000, doneCount: 1, totalCount: 7 }), // budget is SHORTER than the 1h floor
});

test('FIX24 progress: a new phase reported 30 min ago is NOT sent again (1h floor, was 12h)', () => {
  const plans = planSends([progressRow('p30', 0.5, 'Prompts')], phaseCtx('Prompts'));
  assert.equal(plans.length, 0, `advanced phase 30 min after the last report must be held — got ${plans.length} plan(s)`);
});

test('FIX24 progress: a new phase reported 61 min ago IS sent (floor elapsed)', () => {
  const plans = planSends([progressRow('p61', 61 / 60, 'Prompts')], phaseCtx('Prompts'));
  assert.equal(plans.length, 1, '1h floor elapsed -> phase progress may fire');
  assert.match(plans[0].message, /Prompts/);
});

test('FIX24 progress: the FIRST phase report (never reported) fires at once', () => {
  const plans = planSends([progressRow('p0', null, 'Prompts')], phaseCtx('Prompts'));
  assert.equal(plans.length, 1, 'first phase report is immediate');
});

// ── 6. shipped defaults (the numbers the fixtures above bake in) ──────────────

test('FIX24 defaults: shipped window values are 24h stale-exempt / 2h re-ping / 6h escalate / 1h progress', () => {
  assert.equal(PRESENTATIONS_RENDER_EXEMPT_HOURS, 24, 'presentations stale-exempt ships at 24h (was 72)');
  assert.equal(STALE_BLOCKED_REPING_HOURS, 2, 'first re-ping ships at 2h (was 72)');
  assert.equal(STALE_TASK_SWEEP_GLOBAL_DEFAULTS.staleBlockedRepingedHours, 6, 'escalation/return window ships at 6h (was 144)');
  assert.equal(STALE_TASK_SWEEP_GLOBAL_DEFAULTS.staleBlockedRepingHours, 2, 'defaults table exposes the 2h re-ping too');
  assert.equal(PROGRESS_MIN_INTERVAL_MS, 60 * 60 * 1000, 'progress throttle ships at 1h (was 12h)');
});

// ── 7. validation: non-positive and internally inverted overrides are REJECTED ──

test('FIX24 validation: a 0-hour override is rejected, the shipped default ships', () => {
  assert.deepEqual(resolveBlockedWindows('0', '0'), { reping: 2, returned: 6 });
  assert.equal(resolveProgressMinIntervalHours('0'), 1);
});

test('FIX24 validation: a -1-hour override is rejected, the shipped default ships', () => {
  assert.deepEqual(resolveBlockedWindows('-1', '-1'), { reping: 2, returned: 6 });
  assert.equal(resolveProgressMinIntervalHours('-1'), 1);
});

test('FIX24 validation: a non-numeric override is rejected, the shipped default ships', () => {
  assert.deepEqual(resolveBlockedWindows('abc', 'def'), { reping: 2, returned: 6 });
  assert.equal(resolveProgressMinIntervalHours('abc'), 1);
});

test('FIX24 validation: escalation shorter than the first re-ping is REJECTED (inverted windows)', () => {
  const inverted = resolveBlockedWindows('8', '3');
  assert.deepEqual(inverted, { reping: 2, returned: 6 }, 'escalation must never be shorter than re-ping — both overrides rejected');
  assert.equal(resolveBlockedWindows('24', '4').returned, 6, 'same rule for any inverted pair');
  assert.equal(resolveBlockedWindows('2', '2').reping, 2, 'equal windows are NOT inverted — reping 2h + return 2h is legal');
  assert.equal(resolveBlockedWindows('2', '2').returned, 2, 'equal windows are NOT inverted — return carries its own value');
});

test('FIX24 validation: blank overrides mean "use the shipped default"', () => {
  assert.deepEqual(resolveBlockedWindows('  ', ''), { reping: 2, returned: 6 });
  assert.deepEqual(resolveBlockedWindows(undefined, undefined), { reping: 2, returned: 6 });
  assert.equal(resolveProgressMinIntervalHours('   '), 1);
});
