import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { computeCompanyHealth } from '@/lib/grading';
import { loadCompanyConfig } from '@/lib/company-config';

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

    return NextResponse.json(health);
  } catch (err) {
    console.error('[/api/company-health] Error:', (err as Error).message);
    return NextResponse.json(
      { error: 'Failed to compute company health', detail: (err as Error).message },
      { status: 500 }
    );
  }
}
