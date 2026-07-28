/**
 * U044 -- Quiet-hours carve-out: DONE and BLOCKED-on-owner bypass the 22:00-07:00 hold.
 *
 * planSends is pure (no IO, no clock reads beyond ctx.now), so every case below is a
 * direct call with isNight: true|false -- no database, no clock manipulation.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

type EngineModule = typeof import('../../src/lib/jobs/trust-engine');
type TrustTaskRow = import('../../src/lib/jobs/trust-engine').TrustTaskRow;

let engine: EngineModule;

function mkTask(over: Partial<TrustTaskRow>): TrustTaskRow {
  return {
    id: over.id ?? 'task-x',
    title: over.title ?? 'Sample task',
    status: over.status ?? 'backlog',
    department: over.department ?? 'sales',
    assigned_agent_name: over.assigned_agent_name ?? null,
    created_at: over.created_at ?? '2026-07-01T00:00:00.000Z',
    requester_channel: over.requester_channel ?? 'telegram',
    requester_chat_id: 'requester_chat_id' in over ? over.requester_chat_id : '12345',
    ack_sent_at: over.ack_sent_at ?? null,
    progress_last_sent_at: over.progress_last_sent_at ?? null,
    completion_sent_at: over.completion_sent_at ?? null,
    block_audience: over.block_audience ?? null,
    block_needs: over.block_needs ?? null,
  };
}

const NIGHT = new Date(2026, 6, 25, 2, 0, 0);
const noDeliverable = () => null;

test.before(async () => {
  engine = await import('../../src/lib/jobs/trust-engine');
});

function ctx(isNight: boolean, blockedChatIds?: Set<string>) {
  return {
    now: NIGHT,
    deliverableFor: noDeliverable,
    isNight,
    blockedChatIds,
  };
}

function stamps(plans: ReturnType<typeof engine.planSends>) {
  return plans
    .flatMap((p) => p.stamps)
    .map((s) => `${s.taskId}:${s.guardColumn}`)
    .sort();
}

test('case 1: DONE task at night is carved out', () => {
  const plans = engine.planSends(
    [mkTask({ id: 'd1', status: 'done' })],
    ctx(true) as any,
  );
  assert.equal(plans.length, 1);
  assert.equal(plans[0].stamps[0].guardColumn, 'completion_sent_at');
});

test('case 2: BLOCKED-on-OWNER task at night is carved out', () => {
  const plans = engine.planSends(
    [mkTask({ id: 'b1', status: 'blocked', block_audience: 'OWNER', block_needs: 'a logo' })],
    ctx(true) as any,
  );
  assert.equal(plans.length, 1);
  assert.equal(plans[0].stamps[0].guardColumn, 'progress_last_sent_at');
  assert.ok(plans[0].message.includes('paused waiting on you'));
});

test('case 3: BLOCKED with SYSTEM audience at night is HELD', () => {
  const plans = engine.planSends(
    [mkTask({ id: 'b2', status: 'blocked', block_audience: 'SYSTEM', ack_sent_at: null })],
    ctx(true) as any,
  );
  assert.equal(plans.length, 0);
});

test('case 4: in_progress task at night is held', () => {
  const plans = engine.planSends(
    [mkTask({ id: 'p1', status: 'in_progress' })],
    ctx(true) as any,
  );
  assert.equal(plans.length, 0);
});

test('case 5: backlog task past grace at night is held', () => {
  const oldCreated = new Date(NIGHT.getTime() - 11 * 60 * 1000).toISOString();
  const plans = engine.planSends(
    [mkTask({ id: 'a1', status: 'backlog', ack_sent_at: null, created_at: oldCreated })],
    ctx(true) as any,
  );
  assert.equal(plans.length, 0);
});

test('case 6: five mixed tasks at night produce exactly two carved-out plans', () => {
  const oldCreated = new Date(NIGHT.getTime() - 11 * 60 * 1000).toISOString();
  const rows = [
    mkTask({ id: 'd1', status: 'done', requester_chat_id: 'c1' }),
    mkTask({ id: 'b1', status: 'blocked', block_audience: 'OWNER', block_needs: 'x', requester_chat_id: 'c2' }),
    mkTask({ id: 'b2', status: 'blocked', block_audience: 'SYSTEM', ack_sent_at: null, requester_chat_id: 'c3' }),
    mkTask({ id: 'p1', status: 'in_progress', requester_chat_id: 'c4' }),
    mkTask({ id: 'a1', status: 'backlog', ack_sent_at: null, created_at: oldCreated, requester_chat_id: 'c5' }),
  ];
  const plans = engine.planSends(rows, ctx(true) as any);
  assert.equal(plans.length, 2);
  const s = stamps(plans);
  assert.deepStrictEqual(s, ['b1:progress_last_sent_at', 'd1:completion_sent_at']);
});

test('case 7: five mixed tasks by day produce all five stamps in one digest', () => {
  const oldCreated = new Date(NIGHT.getTime() - 11 * 60 * 1000).toISOString();
  const rows = [
    mkTask({ id: 'd1', status: 'done' }),
    mkTask({ id: 'b1', status: 'blocked', block_audience: 'OWNER', block_needs: 'x' }),
    mkTask({ id: 'b2', status: 'blocked', block_audience: 'SYSTEM', ack_sent_at: null }),
    mkTask({ id: 'p1', status: 'in_progress' }),
    mkTask({ id: 'a1', status: 'backlog', ack_sent_at: null, created_at: oldCreated }),
  ];
  const plans = engine.planSends(rows, ctx(false) as any);
  assert.equal(plans.length, 1);
  const s = stamps(plans);
  assert.deepStrictEqual(
    s,
    ['a1:ack_sent_at', 'b1:progress_last_sent_at', 'b2:ack_sent_at', 'd1:completion_sent_at', 'p1:progress_last_sent_at'],
  );
});

test('case 8: five DONE tasks at night coalesce into one digest', () => {
  const rows = [0, 1, 2, 3, 4].map((i) =>
    mkTask({ id: `d${i}`, status: 'done', requester_chat_id: 'shared-chat' }),
  );
  const plans = engine.planSends(rows, ctx(true) as any);
  assert.equal(plans.length, 1);
  assert.equal(plans[0].stamps.length, 5);
  assert.ok(String(plans[0].message).startsWith('Here are 5 quick updates:'));
});

test('case 9: DONE with null requester_chat_id produces no plan at night', () => {
  const plans = engine.planSends(
    [mkTask({ id: 'd1', status: 'done', requester_chat_id: null })],
    ctx(true) as any,
  );
  assert.equal(plans.length, 0);
});

test('case 10: DONE targeting blocked operator chat produces no plan at night', () => {
  const plans = engine.planSends(
    [mkTask({ id: 'd1', status: 'done', requester_chat_id: 'op-chat' })],
    ctx(true, new Set(['op-chat'])) as any,
  );
  assert.equal(plans.length, 0);
});
