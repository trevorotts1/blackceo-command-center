import { NextResponse } from 'next/server';
import { registerCronJobs, listJobs } from '@/lib/jobs/scheduler';

export const dynamic = 'force-dynamic';

/**
 * GET /api/cron/register
 *
 * Registers the in-process cron jobs (idempotent) and returns the current job
 * list with next-run timestamps. Safe to hit repeatedly. Useful as a health
 * check from external monitoring or as a one-shot "wake up" on platforms that
 * lazy-boot Next.js workers.
 */
export async function GET() {
  try {
    const jobs = registerCronJobs();
    return NextResponse.json({
      ok: true,
      registered_at: new Date().toISOString(),
      jobs,
    });
  } catch (error) {
    console.error('[GET /api/cron/register] Failed:', error);
    return NextResponse.json(
      {
        ok: false,
        error: (error as Error).message,
        jobs: listJobs(),
      },
      { status: 500 }
    );
  }
}
