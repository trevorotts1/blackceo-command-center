/**
 * Department grade merge — single-source metric unification (U57 / JM-U53).
 *
 * Before this module existed, `/ceo-board/departments` (`DepartmentPerformanceSection`
 * → `DepartmentCard`) rendered a raw all-time `done/total` completion percentage
 * as its headline "Completion" stat, computed inline from `/api/workspaces?stats=true`
 * + `/api/tasks` — a THIRD, independent metric alongside the department detail
 * hero's real weighted grade (`computeDepartmentGrade()`, via `resolveDepartment()`)
 * and the CEO Board overview's `DepartmentGradeCards` (via `/api/company-health`).
 * Three surfaces, three different numbers for "how is this department doing".
 *
 * This module makes the grid card headline the SAME grade as the detail hero:
 * both ultimately read `computeDepartmentGrade()`'s output for the same
 * department/window/config — the hero via `resolveDepartment()`, the grid via
 * `GET /api/company-health` (already the CEO Board overview's data source,
 * reused here rather than adding a fourth endpoint). Pure, framework-free —
 * no React, no fetch — so it can be unit-tested without a DOM harness, same
 * discipline as `src/lib/ceo-board/attention.ts`.
 *
 * All-time completion is NOT deleted — it demotes to a labeled secondary stat
 * (see `DepartmentCard.tsx`), never the headline.
 */

import type { Grade } from '../grading';

/** The subset of `/api/company-health`'s per-department grade this module needs. */
export interface DepartmentGradeSource {
  workspaceId: string;
  grade: Grade | null;
  score: number | null;
  sufficientData: boolean;
}

export interface DepartmentGradeFields {
  /** Real weighted grade from computeDepartmentGrade(); null = insufficient data — never a fabricated letter. */
  grade: Grade | null;
  /** Real grade score (0-100); null = insufficient data — never 0 or a fabricated number. */
  gradeScore: number | null;
  sufficientData: boolean;
}

/**
 * Merges per-department grades (from `/api/company-health`'s `departments`
 * array) onto any list of items keyed by workspace/department id. Items with
 * no matching grade (e.g. a department health hasn't computed for yet) get
 * the honest null/false triple — never a substituted number.
 */
export function mergeDepartmentGrades<T extends { id: string }>(
  items: T[],
  grades: DepartmentGradeSource[],
): (T & DepartmentGradeFields)[] {
  const byId = new Map(grades.map((g) => [g.workspaceId, g]));
  return items.map((item) => {
    const match = byId.get(item.id);
    return {
      ...item,
      grade: match?.grade ?? null,
      gradeScore: match?.score ?? null,
      sufficientData: match?.sufficientData ?? false,
    };
  });
}
