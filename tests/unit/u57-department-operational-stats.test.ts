/**
 * U57 (E.2 / JM-U53) part (c) — pure unit tests for
 * `src/lib/ceo-board/department-operational-stats.ts`.
 *
 * BINARY acceptance (5): "the department detail page renders blocked count,
 * velocity, and a blockers list whose length equals the count for a fixture
 * with 2 blocked tasks." This file proves that guarantee at the pure-function
 * layer (blockedTasks.length === blockedCount always, by construction — same
 * array, never independently derived) plus the honesty-doctrine null cases.
 *
 * No React, no fetch, no DB — pure data shape test, same discipline as
 * `u55-attention-classification.test.ts`.
 *
 * Runs via the Node built-in test runner under tsx (`npm run test:unit`).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeDepartmentOperationalStats,
  type OperationalTaskInput,
} from '../../src/lib/ceo-board/department-operational-stats';

function task(overrides: Partial<OperationalTaskInput> & { id: string }): OperationalTaskInput {
  return {
    title: `Task ${overrides.id}`,
    status: 'backlog',
    updated_at: new Date().toISOString(),
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

test('[U57] computeDepartmentOperationalStats — blockedTasks.length always equals blockedCount (fixture with 2 blocked tasks)', () => {
  const tasks: OperationalTaskInput[] = [
    task({ id: 't1', status: 'blocked', block_needs: 'Needs API key' }),
    task({ id: 't2', status: 'blocked', block_reason: 'QC reroute cap hit' }),
    task({ id: 't3', status: 'done' }),
    task({ id: 't4', status: 'in_progress' }),
  ];
  const stats = computeDepartmentOperationalStats(tasks);
  assert.equal(stats.blockedCount, 2);
  assert.equal(stats.blockedTasks.length, 2, 'blockers list length must equal the count');
  const ids = stats.blockedTasks.map((t) => t.id).sort();
  assert.deepEqual(ids, ['t1', 't2']);
});

test('[U57] computeDepartmentOperationalStats — a real zero blocked count still renders 0, not omitted', () => {
  const tasks: OperationalTaskInput[] = [task({ id: 't1', status: 'done' })];
  const stats = computeDepartmentOperationalStats(tasks);
  assert.equal(stats.blockedCount, 0);
  assert.deepEqual(stats.blockedTasks, []);
});

test('[U57] computeDepartmentOperationalStats — never-fabricate doctrine: zero tasks yields null velocity, not a fake 0', () => {
  const stats = computeDepartmentOperationalStats([]);
  assert.equal(stats.avgVelocity, null);
  assert.equal(stats.blockedCount, 0);
});

test('[U57] computeDepartmentOperationalStats — real zero completions in-window (but tasks exist) is an honest 0, not null', () => {
  const oldDate = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000).toISOString();
  const tasks: OperationalTaskInput[] = [
    task({ id: 't1', status: 'backlog' }),
    task({ id: 't2', status: 'done', completed_at: oldDate, updated_at: oldDate }),
  ];
  const stats = computeDepartmentOperationalStats(tasks, 30);
  assert.equal(stats.avgVelocity, 0, 'tasks exist but none completed in-window — real zero, not insufficient-data');
});

test('[U57] computeDepartmentOperationalStats — velocity matches the KPIStatCards.tsx formula (completed-in-window / windowDays * 7)', () => {
  const now = Date.now();
  const withinWindow = new Date(now - 5 * 24 * 60 * 60 * 1000).toISOString();
  const tasks: OperationalTaskInput[] = [];
  // 6 tasks completed within the last 30 days -> 6/30*7 = 1.4 per week
  for (let i = 0; i < 6; i++) {
    tasks.push(
      task({ id: `done-${i}`, status: 'done', completed_at: withinWindow, updated_at: withinWindow }),
    );
  }
  const stats = computeDepartmentOperationalStats(tasks, 30);
  assert.equal(stats.avgVelocity, 1.4);
});

test('[U57] computeDepartmentOperationalStats — falls back to updated_at when completed_at is absent (pre-migration-073 rows)', () => {
  const withinWindow = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
  const tasks: OperationalTaskInput[] = [
    task({ id: 't1', status: 'done', updated_at: withinWindow, completed_at: null }),
  ];
  const stats = computeDepartmentOperationalStats(tasks, 30);
  assert.equal(stats.avgVelocity, Math.round((1 / 30) * 7 * 10) / 10);
});

test('[U57] computeDepartmentOperationalStats — blockers list sorted most-recently-updated first', () => {
  const older = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
  const newer = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString();
  const tasks: OperationalTaskInput[] = [
    task({ id: 'old', status: 'blocked', updated_at: older }),
    task({ id: 'new', status: 'blocked', updated_at: newer }),
  ];
  const stats = computeDepartmentOperationalStats(tasks);
  assert.deepEqual(
    stats.blockedTasks.map((t) => t.id),
    ['new', 'old'],
  );
});

test('[U57] computeDepartmentOperationalStats — reason prefers block_needs over block_reason, falls back to an honest default', () => {
  const tasks: OperationalTaskInput[] = [
    task({ id: 't1', status: 'blocked', block_needs: 'Owner approval', block_reason: 'stale reason' }),
    task({ id: 't2', status: 'blocked', block_reason: 'QC cap hit' }),
    task({ id: 't3', status: 'blocked' }),
  ];
  const stats = computeDepartmentOperationalStats(tasks);
  const byId = Object.fromEntries(stats.blockedTasks.map((t) => [t.id, t.reason]));
  assert.equal(byId.t1, 'Owner approval');
  assert.equal(byId.t2, 'QC cap hit');
  assert.equal(byId.t3, 'Blocked — no reason recorded');
});
