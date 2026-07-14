/**
 * Shared "needs attention" classification — single source of truth (U55 / J.0.1).
 *
 * Before this module existed, the CEO hero card computed its own "N items
 * need attention" count inline (`rate < 60 || blocked > 0` over all-time task
 * counts, CompanyHeroCard.tsx) while the Needs Attention panel computed a
 * DIFFERENT classification (`grade === 'F' | 'D'` OR `blocked > 0`,
 * NeedsAttentionSection.tsx). The two happened to be numerically equivalent
 * (rate < 60 is exactly the D/F boundary — see `scoreToGrade` in grading.ts)
 * but lived as two separately-maintained implementations that could drift
 * apart on the next edit, plus the panel additionally truncated its render
 * to 6 items while the hero's count was never capped — so for any company
 * with more than 6 departments needing attention, the two numbers could
 * still disagree.
 *
 * This module is now the ONLY place that decides whether a department needs
 * attention, and `buildAttentionItems()` never truncates — the hero's count
 * and the panel's list length are guaranteed identical because both come
 * from calling this ONE function once (`GET /api/company-health`'s
 * `attentionItems` array), not from two independent computations.
 *
 * Server-safe: no React, no fetch, no browser globals — importable from a
 * Next.js route handler (server) or a 'use client' component (browser).
 */

import { scoreToGrade, isRealDepartment, type Grade } from '../grading';

export type AttentionSeverity = 'urgent' | 'warning';

export interface AttentionTaskCounts {
  total: number;
  done: number;
  in_progress: number;
  blocked: number;
}

export interface AttentionSourceDepartment {
  id: string;
  name: string;
  slug: string;
  taskCounts: AttentionTaskCounts;
}

export interface AttentionItem {
  id: string;
  name: string;
  slug: string;
  severity: AttentionSeverity;
  issue: string;
  timeContext: string;
  grade: Grade;
}

/** Derived rate: done + half-credit for in-progress, over total. */
function attentionRate(counts: AttentionTaskCounts): number {
  if (!counts || counts.total <= 0) return 0;
  return Math.round(((counts.done + counts.in_progress * 0.5) / counts.total) * 100);
}

function attentionGrade(counts: AttentionTaskCounts): Grade {
  return scoreToGrade(attentionRate(counts));
}

/**
 * The single predicate: a department needs attention when its derived rate
 * is below the C threshold (grade D or F — identical to `rate < 60`) OR it
 * has at least one blocked task. Departments with zero total tasks are
 * never flagged (no signal, not a fabricated problem).
 */
export function isAttentionWorthy(counts: AttentionTaskCounts): boolean {
  if (!counts || counts.total <= 0) return false;
  const grade = attentionGrade(counts);
  return grade === 'D' || grade === 'F' || counts.blocked > 0;
}

/** Builds one AttentionItem for a department, or null if it doesn't qualify. */
export function buildAttentionItem(dept: AttentionSourceDepartment): AttentionItem | null {
  if (!isRealDepartment(dept.slug)) return null;

  const { taskCounts } = dept;
  if (!isAttentionWorthy(taskCounts)) return null;

  const grade = attentionGrade(taskCounts);
  const blocked = taskCounts.blocked;

  if (grade === 'F') {
    return {
      id: dept.id,
      name: dept.name,
      slug: dept.slug,
      severity: 'urgent',
      issue: `${dept.name} is at grade F -- immediate attention required`,
      timeContext: '3 days',
      grade,
    };
  }
  if (grade === 'D') {
    return {
      id: dept.id,
      name: dept.name,
      slug: dept.slug,
      severity: 'urgent',
      issue: `${dept.name} is at grade D -- immediate attention required`,
      timeContext: '2 days',
      grade,
    };
  }
  // grade is C/B/A here (rate >= 60) but blocked > 0 is what qualified it.
  return {
    id: dept.id,
    name: dept.name,
    slug: dept.slug,
    severity: 'warning',
    issue: `${dept.name} has ${blocked} blocked task${blocked > 1 ? 's' : ''}`,
    timeContext: '1 day',
    grade,
  };
}

/**
 * Builds the full, UN-TRUNCATED attention list, urgent items first (stable
 * sort — ties keep their input order). No slice() cap: the hero's count is
 * this array's length, so capping here would make the two numbers disagree
 * for any company with more qualifying departments than the cap.
 */
export function buildAttentionItems(
  departments: AttentionSourceDepartment[],
): AttentionItem[] {
  const items = departments
    .map(buildAttentionItem)
    .filter((item): item is AttentionItem => item !== null);

  items.sort((a, b) => {
    if (a.severity === 'urgent' && b.severity !== 'urgent') return -1;
    if (a.severity !== 'urgent' && b.severity === 'urgent') return 1;
    return 0;
  });

  return items;
}
