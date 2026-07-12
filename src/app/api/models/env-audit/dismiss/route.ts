import { NextRequest, NextResponse } from 'next/server';
import { dismissEnvAuditSuggestion } from '@/lib/env-auditor';

export const dynamic = 'force-dynamic';

/**
 * POST /api/models/env-audit/dismiss
 *
 * Body: { id: number }
 *
 * Marks a pending Deep Scan suggestion as dismissed. Never writes a key —
 * this is the operator saying "no, that's not it" for a suggestion row.
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const id = Number(body?.id);
    if (!Number.isInteger(id) || id <= 0) {
      return NextResponse.json({ error: 'id (a positive integer suggestion id) is required' }, { status: 400 });
    }

    const result = dismissEnvAuditSuggestion(id);
    if (!result.ok) {
      return NextResponse.json({ error: result.error ?? 'dismiss failed' }, { status: 400 });
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error('[POST /api/models/env-audit/dismiss] failed:', err);
    return NextResponse.json(
      { error: 'Dismiss failed', message: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
