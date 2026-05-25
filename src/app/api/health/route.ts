import { NextResponse } from 'next/server';
import { getDb, getMigrationStatus } from '@/lib/db';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * GET /api/health
 *
 * PRD 3.10: surface applied + expected migrations so the System Status
 * Panel can flag schema drift between client deployments. Older v3.6
 * installs that upgrade to v4.0 must show their pending migrations.
 *
 * Response shape:
 *   {
 *     status: 'ok' | 'degraded',
 *     timestamp: ISO-8601,
 *     migrations: {
 *       applied: string[],       // migration ids that have run on this DB
 *       expected: string[],      // every known migration id, sorted numerically
 *       pending: string[],       // expected \ applied
 *       gap: number,             // pending.length, convenience field
 *     }
 *   }
 *
 * If the DB or migration runner itself errors we still return 200 with
 * status='degraded' so the System Status Panel can render a red light
 * without the homepage flipping to OFFLINE (the existing top-bar pill
 * only cares about HTTP 200).
 */
export async function GET() {
  try {
    const db = getDb();
    const { applied, pending } = getMigrationStatus(db);

    // expected = the union of applied + pending in sort order.
    const expected = Array.from(new Set([...applied, ...pending])).sort((a, b) => {
      const an = parseInt(a, 10);
      const bn = parseInt(b, 10);
      if (!Number.isNaN(an) && !Number.isNaN(bn) && an !== bn) return an - bn;
      return a.localeCompare(b);
    });

    return NextResponse.json({
      status: pending.length === 0 ? 'ok' : 'degraded',
      timestamp: new Date().toISOString(),
      migrations: {
        applied,
        expected,
        pending,
        gap: pending.length,
      },
    });
  } catch (error) {
    return NextResponse.json(
      {
        status: 'degraded',
        timestamp: new Date().toISOString(),
        migrations: {
          applied: [],
          expected: [],
          pending: [],
          gap: 0,
        },
        error: error instanceof Error ? error.message : 'unknown',
      },
      { status: 200 }
    );
  }
}
