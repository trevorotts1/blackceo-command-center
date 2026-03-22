import { NextResponse } from 'next/server';
import { queryOne, queryAll } from '@/lib/db';

// GET /api/recommendations/effectiveness - Aggregate effectiveness stats
export async function GET() {
  try {
    // Total approved recommendations
    const totalResult = queryOne<{ count: number }>(
      `SELECT COUNT(*) as count FROM recommendations WHERE status = 'approved'`
    );
    const totalApproved = totalResult?.count ?? 0;

    // Average improvement across all outcomes
    const avgResult = queryOne<{ avg_improvement: number | null; tracked: number }>(
      `SELECT AVG(improvement_pct) as avg_improvement, COUNT(*) as tracked
       FROM recommendation_outcomes`
    );
    const avgImprovement = avgResult?.avg_improvement != null
      ? Math.round(avgResult.avg_improvement * 10) / 10
      : 0;
    const tracked = avgResult?.tracked ?? 0;

    // Top performing department
    const topDept = queryOne<{ department_id: string; avg_improvement: number }>(
      `SELECT r.department_id, AVG(ro.improvement_pct) as avg_improvement
       FROM recommendation_outcomes ro
       JOIN recommendations r ON r.id = ro.recommendation_id
       GROUP BY r.department_id
       ORDER BY avg_improvement DESC
       LIMIT 1`
    );

    return NextResponse.json({
      totalApproved,
      tracked,
      avgImprovement,
      topDepartment: topDept?.department_id
        ? topDept.department_id.replace('-dept', '')
        : 'N/A',
      topDepartmentImprovement: topDept
        ? Math.round(topDept.avg_improvement * 10) / 10
        : 0,
    });
  } catch (error) {
    console.error('Failed to fetch effectiveness stats:', error);
    return NextResponse.json(
      { error: 'Failed to fetch effectiveness stats' },
      { status: 500 }
    );
  }
}
