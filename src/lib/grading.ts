// Grade thresholds per PRD
export type Grade = 'A' | 'B' | 'C' | 'D' | 'F';

export function scoreToGrade(score: number): Grade {
  if (score >= 90) return 'A';
  if (score >= 75) return 'B';
  if (score >= 60) return 'C';
  if (score >= 40) return 'D';
  return 'F';
}

export function gradeToColor(grade: Grade): string {
  if (grade === 'A' || grade === 'B') return '#10B981'; // emerald
  if (grade === 'C') return '#F59E0B'; // amber
  return '#EF4444'; // red
}

export function gradeToLabel(grade: Grade): string {
  const labels = { A: 'Excellent', B: 'Good', C: 'Average', D: 'Needs Work', F: 'Critical' };
  return labels[grade];
}

// Weighted company score per PRD formula
export function calculateCompanyScore(params: {
  kpiAchievement: number;    // 0-100
  agentPerformance: number;  // 0-100
  daCompliance: number;      // 0-100
  recommendationFollowThrough: number; // 0-100
}): number {
  return (
    params.kpiAchievement * 0.40 +
    params.agentPerformance * 0.30 +
    params.daCompliance * 0.15 +
    params.recommendationFollowThrough * 0.15
  );
}
