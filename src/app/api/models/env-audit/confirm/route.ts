import { NextRequest, NextResponse } from 'next/server';
import { confirmEnvAuditSuggestion } from '@/lib/env-auditor';
import { refreshModels } from '@/lib/jobs/refresh-models';
import { getProvider } from '@/lib/model-providers';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

/**
 * POST /api/models/env-audit/confirm
 *
 * Body: { id: number }
 *
 * The ONLY place a Deep Scan suggestion can turn into an actual key write —
 * auto-wiring only happens here, and only for a suggestion id the operator
 * explicitly confirmed via the UI's [Confirm] action. Re-reads the value
 * fresh from its original source (never from the suggestions table, which
 * never stores a secret) before writing it under the suggested provider's
 * canonical env-var name. The response never echoes the value.
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const id = Number(body?.id);
    if (!Number.isInteger(id) || id <= 0) {
      return NextResponse.json({ error: 'id (a positive integer suggestion id) is required' }, { status: 400 });
    }

    const result = await confirmEnvAuditSuggestion(id);
    if (!result.ok) {
      return NextResponse.json({ error: result.error ?? 'confirm failed' }, { status: 400 });
    }

    // Best-effort: re-refresh so the newly-wired provider's catalog populates
    // immediately. A refresh failure does not undo the confirmed write.
    let refreshed = false;
    try {
      if (result.env_var) {
        const slug = result.env_var.replace(/_API_KEY$/, '').toLowerCase().replace(/_/g, '-');
        const provider = getProvider(slug);
        if (provider) {
          await refreshModels([provider]);
          refreshed = true;
        }
      }
    } catch (err) {
      console.warn('[POST /api/models/env-audit/confirm] post-confirm refresh failed (key already saved):', err);
    }

    return NextResponse.json({ ok: true, env_var: result.env_var, target: result.target, refreshed });
  } catch (err) {
    console.error('[POST /api/models/env-audit/confirm] failed:', err);
    return NextResponse.json(
      { error: 'Confirm failed', message: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
