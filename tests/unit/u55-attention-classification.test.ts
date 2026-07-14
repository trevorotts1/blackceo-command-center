/**
 * U55 — Shared "needs attention" classification (src/lib/ceo-board/attention.ts).
 *
 * Pure-function tests, no DB / no fetch. Proves:
 *   1. isAttentionWorthy: the single predicate (rate<60 i.e. grade D/F, OR
 *      blocked>0), matching what used to be TWO different implementations
 *      (CompanyHeroCard's inline `rate < 60 || blocked > 0` and
 *      NeedsAttentionSection's `grade === 'F' | 'D' | blocked>0`).
 *   2. buildAttentionItems: N=0, N=1, N>=2 fixtures — the exact scenarios
 *      U55 binary acceptance (2) calls out. No truncation for large N (the
 *      old NeedsAttentionSection capped at 6 — removed, because a cap would
 *      make the hero's count and the panel's list length disagree).
 *   3. Zero-total departments and non-real slugs (acme-, zhw-, default) are
 *      excluded — never fabricate a problem from no data.
 *   4. Sort order: urgent items before warning items.
 *
 * Node built-in runner: node --import tsx --test tests/unit/u55-attention-classification.test.ts
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isAttentionWorthy,
  buildAttentionItem,
  buildAttentionItems,
  type AttentionSourceDepartment,
} from '../../src/lib/ceo-board/attention';

function dept(
  overrides: Partial<AttentionSourceDepartment> & { id: string },
): AttentionSourceDepartment {
  return {
    name: overrides.name ?? overrides.id,
    slug: overrides.slug ?? overrides.id,
    taskCounts: overrides.taskCounts ?? { total: 0, done: 0, in_progress: 0, blocked: 0 },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// isAttentionWorthy — the single predicate
// ---------------------------------------------------------------------------

test('isAttentionWorthy: rate >= 60 and no blocked tasks -> false (healthy)', () => {
  // 8 done / 10 total = 80% -> grade B, not attention-worthy
  assert.equal(
    isAttentionWorthy({ total: 10, done: 8, in_progress: 0, blocked: 0 }),
    false,
  );
});

test('isAttentionWorthy: rate < 60 (grade D) -> true', () => {
  // 4 done / 10 total = 40% -> grade D
  assert.equal(
    isAttentionWorthy({ total: 10, done: 4, in_progress: 0, blocked: 0 }),
    true,
  );
});

test('isAttentionWorthy: rate < 40 (grade F) -> true', () => {
  assert.equal(
    isAttentionWorthy({ total: 10, done: 1, in_progress: 0, blocked: 0 }),
    true,
  );
});

test('isAttentionWorthy: rate >= 60 but blocked > 0 -> true (the union the two old rules missed)', () => {
  // 9 done / 10 total = 90% -> grade A, but 1 blocked task must still surface.
  assert.equal(
    isAttentionWorthy({ total: 10, done: 9, in_progress: 0, blocked: 1 }),
    true,
  );
});

test('isAttentionWorthy: zero total tasks -> false (no signal, never fabricate a problem)', () => {
  assert.equal(
    isAttentionWorthy({ total: 0, done: 0, in_progress: 0, blocked: 0 }),
    false,
  );
});

test('isAttentionWorthy: exact boundary rate=60 -> false (C is not D/F, matches scoreToGrade >=60 -> C)', () => {
  // 6 done / 10 total = 60% exactly -> grade C -> not attention-worthy (no blocked)
  assert.equal(
    isAttentionWorthy({ total: 10, done: 6, in_progress: 0, blocked: 0 }),
    false,
  );
});

// ---------------------------------------------------------------------------
// buildAttentionItems — N=0, N=1, N>=2
// ---------------------------------------------------------------------------

test('buildAttentionItems: N=0 — all departments healthy, empty list', () => {
  const depts = [
    dept({ id: 'd1', taskCounts: { total: 10, done: 9, in_progress: 0, blocked: 0 } }),
    dept({ id: 'd2', taskCounts: { total: 5, done: 5, in_progress: 0, blocked: 0 } }),
  ];
  assert.deepEqual(buildAttentionItems(depts), []);
});

test('buildAttentionItems: N=1 — exactly one qualifying department', () => {
  const depts = [
    dept({ id: 'd1', name: 'Marketing', slug: 'marketing', taskCounts: { total: 10, done: 9, in_progress: 0, blocked: 0 } }),
    dept({ id: 'd2', name: 'Sales', slug: 'sales', taskCounts: { total: 10, done: 2, in_progress: 0, blocked: 0 } }),
  ];
  const items = buildAttentionItems(depts);
  assert.equal(items.length, 1);
  assert.equal(items[0].slug, 'sales');
  assert.equal(items[0].severity, 'urgent');
  assert.equal(items[0].grade, 'F');
});

test('buildAttentionItems: N>=2 (8 qualifying departments) — no truncation cap', () => {
  const depts = Array.from({ length: 8 }, (_, i) =>
    dept({
      id: `d${i}`,
      name: `Dept ${i}`,
      slug: `dept-${i}`,
      taskCounts: { total: 10, done: 1, in_progress: 0, blocked: 0 }, // grade F each
    }),
  );
  const items = buildAttentionItems(depts);
  // The old NeedsAttentionSection capped at 6 — proving that cap is gone is
  // exactly what guarantees the hero's count and the panel's list length
  // can never disagree for a company with more than 6 struggling departments.
  assert.equal(items.length, 8, 'must not truncate to 6 or any other cap');
});

test('buildAttentionItems: urgent items sort before warning items', () => {
  const depts = [
    dept({ id: 'warn', name: 'Warn Dept', slug: 'warn-dept', taskCounts: { total: 10, done: 9, in_progress: 0, blocked: 1 } }), // warning (blocked only)
    dept({ id: 'urgent', name: 'Urgent Dept', slug: 'urgent-dept', taskCounts: { total: 10, done: 1, in_progress: 0, blocked: 0 } }), // urgent (grade F)
  ];
  const items = buildAttentionItems(depts);
  assert.equal(items.length, 2);
  assert.equal(items[0].severity, 'urgent');
  assert.equal(items[1].severity, 'warning');
});

test('buildAttentionItems: non-real department slugs (acme-*, zhw-*, default) are excluded', () => {
  const depts = [
    dept({ id: 'acme', name: 'Acme Demo', slug: 'acme-demo', taskCounts: { total: 10, done: 1, in_progress: 0, blocked: 0 } }),
    dept({ id: 'zhw', name: 'ZHW Scaffold', slug: 'zhw-scaffold', taskCounts: { total: 10, done: 1, in_progress: 0, blocked: 0 } }),
    dept({ id: 'default', name: 'Default', slug: 'default', taskCounts: { total: 10, done: 1, in_progress: 0, blocked: 0 } }),
    dept({ id: 'real', name: 'Real Dept', slug: 'real-dept', taskCounts: { total: 10, done: 1, in_progress: 0, blocked: 0 } }),
  ];
  const items = buildAttentionItems(depts);
  assert.equal(items.length, 1);
  assert.equal(items[0].slug, 'real-dept');
});

test('buildAttentionItem: single-item builder returns null for a healthy department', () => {
  const result = buildAttentionItem(
    dept({ id: 'd1', taskCounts: { total: 10, done: 10, in_progress: 0, blocked: 0 } }),
  );
  assert.equal(result, null);
});

test('buildAttentionItem: blocked-only warning issue text includes the blocked count', () => {
  const result = buildAttentionItem(
    dept({ id: 'd1', name: 'Ops', slug: 'ops', taskCounts: { total: 10, done: 8, in_progress: 0, blocked: 3 } }),
  );
  assert.ok(result);
  assert.equal(result!.severity, 'warning');
  assert.match(result!.issue, /3 blocked tasks/);
});
