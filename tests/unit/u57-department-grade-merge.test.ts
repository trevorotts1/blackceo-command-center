/**
 * U57 (E.2 / JM-U53) part (a) — pure unit tests for
 * `src/lib/ceo-board/department-grade-merge.ts`.
 *
 * `mergeDepartmentGrades()` is the join point between the `/ceo-board/departments`
 * grid's raw completion-percentage items and `/api/company-health`'s real
 * `computeDepartmentGrade()` output (the SAME formula the `/ceo-board/[dept]`
 * detail hero uses via `resolveDepartment()`). No React, no fetch — pure data
 * shape test, same discipline as `u55-attention-classification.test.ts`.
 *
 * Runs via the Node built-in test runner under tsx (`npm run test:unit`).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeDepartmentGrades, type DepartmentGradeSource } from '../../src/lib/ceo-board/department-grade-merge';

test('[U57] mergeDepartmentGrades — matched department gets the real grade/score/sufficientData', () => {
  const items = [{ id: 'ws-a', progress: 42 }];
  const grades: DepartmentGradeSource[] = [
    { workspaceId: 'ws-a', grade: 'B', score: 78, sufficientData: true },
  ];
  const merged = mergeDepartmentGrades(items, grades);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].grade, 'B');
  assert.equal(merged[0].gradeScore, 78);
  assert.equal(merged[0].sufficientData, true);
  // original field untouched
  assert.equal(merged[0].progress, 42);
});

test('[U57] mergeDepartmentGrades — never-72 doctrine: unmatched department gets honest nulls, not a fabricated grade', () => {
  const items = [{ id: 'ws-no-grade-yet', progress: 0 }];
  const merged = mergeDepartmentGrades(items, []);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].grade, null);
  assert.equal(merged[0].gradeScore, null);
  assert.equal(merged[0].sufficientData, false);
});

test('[U57] mergeDepartmentGrades — insufficient-data department (grade computed but null) stays null, never coerced to a letter', () => {
  const items = [{ id: 'ws-b' }];
  const grades: DepartmentGradeSource[] = [
    { workspaceId: 'ws-b', grade: null, score: null, sufficientData: false },
  ];
  const merged = mergeDepartmentGrades(items, grades);
  assert.equal(merged[0].grade, null);
  assert.equal(merged[0].gradeScore, null);
  assert.equal(merged[0].sufficientData, false);
});

test('[U57] mergeDepartmentGrades — preserves item order and count regardless of grades array order', () => {
  const items = [{ id: 'ws-1' }, { id: 'ws-2' }, { id: 'ws-3' }];
  const grades: DepartmentGradeSource[] = [
    { workspaceId: 'ws-3', grade: 'A', score: 95, sufficientData: true },
    { workspaceId: 'ws-1', grade: 'C', score: 65, sufficientData: true },
  ];
  const merged = mergeDepartmentGrades(items, grades);
  assert.deepEqual(
    merged.map((m) => m.id),
    ['ws-1', 'ws-2', 'ws-3'],
  );
  assert.equal(merged[0].grade, 'C');
  assert.equal(merged[1].grade, null); // ws-2 has no grade row
  assert.equal(merged[2].grade, 'A');
});
