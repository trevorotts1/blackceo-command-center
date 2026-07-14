import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { computeCompanyHealth, getRealDepartmentTaskCounts } from '@/lib/grading';
import { loadCompanyConfig } from '@/lib/company-config';
import { buildAttentionItems } from '@/lib/ceo-board/attention';

export const dynamic = 'force-dynamic';

/**
 * GET /api/company-health?window=30
 *
 * Returns the PRD 2.10 CompanyHealth object: company score/grade, per-department
 * grades computed from the four observable DB inputs (throughput, QC pass rate,
 * SOP coverage, KPI attainment), and the up-to-3 worst-trending departments.
 *
 * This endpoint is the single source of truth for the Performance board.
 * It does NOT extend /api/performance — that route serves separate cards
 * (bottlenecks, utilization, persona coverage).
 *
 * Query params:
 *   window  — rolling window in days (default: 30; overridden by company-config.json
 *             gradingWindowDays if not explicitly passed)
 */
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const config = loadCompanyConfig();

    // Window: explicit QS param → config file → 30-day default
    const windowParam = searchParams.get('window');
    const windowDays = windowParam
      ? Math.max(1, parseInt(windowParam, 10) || 30)
      : (config.gradingWindowDays ?? 30);

    const db = getDb();
    const health = computeCompanyHealth(db, {
      windowDays,
      weights: config.gradingInputWeights,
    });

    // U55: all-time task totals (hero's "All time" secondary stat) + the
    // shared Needs Attention classification (src/lib/ceo-board/attention.ts).
    // Deliberately all-time, not windowed — a department with a long bad
    // history should still surface even if its recent window looks fine.
    // Both the hero's attention count and the Needs Attention panel's list
    // read this SAME array, so their lengths can never disagree.
    const deptTaskCounts = getRealDepartmentTaskCounts(db);
    const allTimeTotalTasks = deptTaskCounts.reduce((sum, d) => sum + d.total, 0);
    const allTimeCompletedTasks = deptTaskCounts.reduce((sum, d) => sum + d.done, 0);
    const attentionItems = buildAttentionItems(
      deptTaskCounts.map((d) => ({
        id: d.workspaceId,
        name: d.name,
        slug: d.slug,
        taskCounts: {
          total: d.total,
          done: d.done,
          in_progress: d.in_progress,
          blocked: d.blocked,
        },
      }))
    );

    return NextResponse.json({
      ...health,
      allTime: {
        totalTasks: allTimeTotalTasks,
        completedTasks: allTimeCompletedTasks,
        completionRate:
          allTimeTotalTasks > 0
            ? Math.round((allTimeCompletedTasks / allTimeTotalTasks) * 100)
            : null,
      },
      attentionItems,
      attentionCount: attentionItems.length,
    });
  } catch (err) {
    console.error('[/api/company-health] Error:', (err as Error).message);
    return NextResponse.json(
      { error: 'Failed to compute company health', detail: (err as Error).message },
      { status: 500 }
    );
  }
}
