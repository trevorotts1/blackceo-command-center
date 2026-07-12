import { NextResponse } from 'next/server';
import { runEnvAudit, listPendingSuggestions } from '@/lib/env-auditor';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

/**
 * GET /api/models/env-audit
 *
 * List the current pending suggestions from the last "Deep Scan" run, without
 * running a new scan. Never returns a secret value — only env-var names,
 * source labels, and the suggested provider.
 */
export async function GET() {
  try {
    const suggestions = listPendingSuggestions();
    return NextResponse.json({ suggestions });
  } catch (err) {
    console.error('[GET /api/models/env-audit] failed:', err);
    return NextResponse.json(
      { error: 'Failed to load env-audit suggestions', message: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}

/**
 * POST /api/models/env-audit  ("Deep Scan")
 *
 * Runs the LLM env-auditor: gathers candidate env-var NAMES from the
 * documented surfaces, REDACTS every value before it reaches the box's own
 * cheap/quick-tier model, and persists suggestions for operator review.
 * Never auto-wires a key — see /api/models/env-audit/confirm.
 */
export async function POST() {
  try {
    const result = await runEnvAudit();
    const suggestions = listPendingSuggestions();
    return NextResponse.json({ ...result, suggestions });
  } catch (err) {
    console.error('[POST /api/models/env-audit] failed:', err);
    return NextResponse.json(
      { error: 'Deep Scan failed', message: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
