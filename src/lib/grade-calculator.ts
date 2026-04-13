/**
 * Grade Calculator - Canonical company grade computation
 *
 * Per PRD:
 *   grade = (kpiAchievement * 0.4) + (agentPerformance * 0.3) + (daCompliance * 0.15) + (recommendationFollowThrough * 0.15)
 *
 * Each input is 0-100. Output is 0-100.
 */

import { scoreToGrade, gradeToColor, gradeToLabel, type Grade } from './grading';

/** Input parameters for the 4-factor grade formula */
export interface GradeInput {
  /** KPI achievement score (0-100) — how well the company is hitting its KPI targets */
  kpiAchievement: number;
  /** Agent performance score (0-100) — task completion rate and quality across agents */
  agentPerformance: number;
  /** Devil's Advocate compliance score (0-100) — how many DA challenges were addressed */
  daCompliance: number;
  /** Recommendation follow-through score (0-100) — how many approved recommendations were acted on */
  recommendationFollowThrough: number;
}

/** Weights per PRD — can be overridden by company config */
export interface GradeWeights {
  kpiAchievement: number;
  agentPerformance: number;
  daCompliance: number;
  recommendationFollowThrough: number;
}

/** Default weights matching PRD */
export const DEFAULT_GRADE_WEIGHTS: GradeWeights = {
  kpiAchievement: 0.4,
  agentPerformance: 0.3,
  daCompliance: 0.15,
  recommendationFollowThrough: 0.15,
};

/**
 * Calculate the weighted company grade score (0-100).
 *
 * Formula: grade = (kpiAchievement * 0.4) + (agentPerformance * 0.3) + (daCompliance * 0.15) + (recommendationFollowThrough * 0.15)
 *
 * Weights can be overridden via company-config.json gradingWeights.
 */
export function calculateWeightedScore(input: GradeInput, weights?: GradeWeights): number {
  const w = weights || DEFAULT_GRADE_WEIGHTS;

  // Clamp each input to 0-100
  const clamp = (n: number) => Math.max(0, Math.min(100, n));
  const kpi = clamp(input.kpiAchievement);
  const agent = clamp(input.agentPerformance);
  const da = clamp(input.daCompliance);
  const rec = clamp(input.recommendationFollowThrough);

  const score = (kpi * w.kpiAchievement) + (agent * w.agentPerformance) + (da * w.daCompliance) + (rec * w.recommendationFollowThrough);

  return Math.round(clamp(score) * 100) / 100;
}

/**
 * Full grade result with letter grade, color, and label.
 */
export interface GradeResult {
  score: number;
  grade: Grade;
  color: string;
  label: string;
  weights: GradeWeights;
}

/**
 * Calculate the full grade result from input parameters.
 */
export function calculateGrade(input: GradeInput, weights?: GradeWeights): GradeResult {
  const w = weights || DEFAULT_GRADE_WEIGHTS;
  const score = calculateWeightedScore(input, w);
  const grade = scoreToGrade(score);

  return {
    score,
    grade,
    color: gradeToColor(grade),
    label: gradeToLabel(grade),
    weights: w,
  };
}

/**
 * Compute agent performance score from workspace stats.
 * Based on task completion rate across departments.
 * Returns 0-100.
 */
export function computeAgentPerformanceScore(departments: { taskCounts?: { total?: number; done?: number; in_progress?: number } }[]): number {
  const totalTasks = departments.reduce((s, d) => s + (d.taskCounts?.total || 0), 0);
  const doneTasks = departments.reduce((s, d) => s + (d.taskCounts?.done || 0), 0);
  const inProgressTasks = departments.reduce((s, d) => s + (d.taskCounts?.in_progress || 0), 0);

  if (totalTasks === 0) return 0;

  // Full credit for done, half credit for in-progress
  const effectiveDone = doneTasks + (inProgressTasks * 0.5);
  return Math.round((effectiveDone / totalTasks) * 100);
}

/**
 * Compute KPI achievement score from KPI snapshots.
 * Returns 0-100. Returns 0 if no KPI data.
 */
export function computeKpiAchievementScore(kpis: { value: number; target: number | null }[]): number {
  if (kpis.length === 0) return 0;

  let totalScore = 0;
  let count = 0;

  for (const kpi of kpis) {
    if (kpi.target && kpi.target > 0) {
      const achievement = Math.min(100, Math.round((kpi.value / kpi.target) * 100));
      totalScore += achievement;
      count++;
    }
  }

  return count > 0 ? Math.round(totalScore / count) : 0;
}

/**
 * Compute DA compliance score from challenge data.
 * Returns 0-100. Returns 0 if no challenges exist.
 */
export function computeDaComplianceScore(challenges: { total: number; addressed: number }): number {
  if (challenges.total === 0) return 0;
  return Math.round((challenges.addressed / challenges.total) * 100);
}

/**
 * Compute recommendation follow-through score.
 * Returns 0-100. Returns 0 if no recommendations exist.
 */
export function computeRecommendationFollowThroughScore(recommendations: { total: number; actedOn: number }): number {
  if (recommendations.total === 0) return 0;
  return Math.round((recommendations.actedOn / recommendations.total) * 100);
}
