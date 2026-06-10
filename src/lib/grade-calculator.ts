/**
 * Grade Calculator — SHIM (PRD 2.10)
 *
 * This file is a thin re-export shim kept for one release cycle so existing
 * imports in CompanyHeroCard, CompanyHealthSection, and company-config.ts
 * continue to compile without changes during the transition to the new
 * grading module (src/lib/grading.ts).
 *
 * DO NOT add logic here. All grading logic lives in src/lib/grading.ts.
 * This shim will be deleted in a follow-up PR once callers are migrated.
 *
 * @deprecated import from '@/lib/grading' instead.
 */

import { scoreToGrade, gradeToColor, gradeToLabel, type Grade } from './grading';

// Re-export the primitives so existing callers compile
export { scoreToGrade, gradeToColor, gradeToLabel, type Grade };

/** Input parameters for the legacy 4-factor grade formula */
export interface GradeInput {
  kpiAchievement: number;
  agentPerformance: number;
  daCompliance: number;
  recommendationFollowThrough: number;
}

/** Weights for the legacy 4-factor formula */
export interface GradeWeights {
  kpiAchievement: number;
  agentPerformance: number;
  daCompliance: number;
  recommendationFollowThrough: number;
}

/** Default weights — kept so company-config.ts compiles unchanged */
export const DEFAULT_GRADE_WEIGHTS: GradeWeights = {
  kpiAchievement: 0.4,
  agentPerformance: 0.3,
  daCompliance: 0.15,
  recommendationFollowThrough: 0.15,
};

/** @deprecated Use computeCompanyHealth from grading.ts */
export function calculateWeightedScore(input: GradeInput, weights?: GradeWeights): number {
  const w = weights || DEFAULT_GRADE_WEIGHTS;
  const clamp = (n: number) => Math.max(0, Math.min(100, n));
  return Math.round(
    clamp(
      clamp(input.kpiAchievement) * w.kpiAchievement +
      clamp(input.agentPerformance) * w.agentPerformance +
      clamp(input.daCompliance) * w.daCompliance +
      clamp(input.recommendationFollowThrough) * w.recommendationFollowThrough
    ) * 100
  ) / 100;
}

export interface GradeResult {
  score: number;
  grade: Grade;
  color: string;
  label: string;
  weights: GradeWeights;
}

/** @deprecated Use computeCompanyHealth from grading.ts */
export function calculateGrade(input: GradeInput, weights?: GradeWeights): GradeResult {
  const w = weights || DEFAULT_GRADE_WEIGHTS;
  const score = calculateWeightedScore(input, w);
  const grade = scoreToGrade(score);
  return { score, grade, color: gradeToColor(grade), label: gradeToLabel(grade), weights: w };
}

/** @deprecated Proxy kept for UI components — use throughput input from grading.ts */
export function computeAgentPerformanceScore(
  departments: { taskCounts?: { total?: number; done?: number; in_progress?: number } }[]
): number {
  const totalTasks = departments.reduce((s, d) => s + (d.taskCounts?.total || 0), 0);
  const doneTasks = departments.reduce((s, d) => s + (d.taskCounts?.done || 0), 0);
  const inProgressTasks = departments.reduce((s, d) => s + (d.taskCounts?.in_progress || 0), 0);
  if (totalTasks === 0) return 0;
  const effectiveDone = doneTasks + inProgressTasks * 0.5;
  return Math.round((effectiveDone / totalTasks) * 100);
}

/** @deprecated Use kpiAttainment input from grading.ts */
export function computeKpiAchievementScore(kpis: { value: number; target: number | null }[]): number {
  if (kpis.length === 0) return 0;
  let total = 0;
  let count = 0;
  for (const kpi of kpis) {
    if (kpi.target && kpi.target > 0) {
      total += Math.min(100, Math.round((kpi.value / kpi.target) * 100));
      count++;
    }
  }
  return count > 0 ? Math.round(total / count) : 0;
}

/** @deprecated Use grading.ts */
export function computeDaComplianceScore(challenges: { total: number; addressed: number }): number {
  if (challenges.total === 0) return 0;
  return Math.round((challenges.addressed / challenges.total) * 100);
}

/** @deprecated Use grading.ts */
export function computeRecommendationFollowThroughScore(
  recommendations: { total: number; actedOn: number }
): number {
  if (recommendations.total === 0) return 0;
  return Math.round((recommendations.actedOn / recommendations.total) * 100);
}
