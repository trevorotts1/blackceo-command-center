import { NextRequest, NextResponse } from 'next/server';
import { detectPatternsAndPropose } from '@/lib/sop-learning';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * GET/POST /api/cron/sop-learning
 *
 * Nightly cron endpoint. External cron (Vercel cron, GitHub Actions, or a
 * Hostinger crontab pinging via curl) hits this once a day.
 *
 * Optional shared-secret auth: set `CRON_SECRET` in the environment and pass
 * `?token=...` or `Authorization: Bearer ...`. If `CRON_SECRET` is unset,
 * the endpoint runs unauthenticated (dev mode).
 */
async function handler(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const url = new URL(req.url);
    const tokenParam = url.searchParams.get('token');
    const auth = req.headers.get('authorization') || '';
    const tokenHeader = auth.startsWith('Bearer ') ? auth.slice(7) : null;
    if (tokenParam !== secret && tokenHeader !== secret) {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
    }
  }

  try {
    const result = detectPatternsAndPropose();
    return NextResponse.json({
      ok: true,
      ran_at: new Date().toISOString(),
      ...result,
    });
  } catch (error) {
    console.error('[CRON /api/cron/sop-learning] Failed:', error);
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}

export async function GET(req: NextRequest) {
  return handler(req);
}

export async function POST(req: NextRequest) {
  return handler(req);
}
