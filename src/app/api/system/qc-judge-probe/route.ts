/**
 * GET /api/system/qc-judge-probe
 *
 * On-demand QC judge-proof probe (P1-05). Fires ONE real chat-completion call
 * to the box's configured QC_JUDGE_MODEL and reports
 * `judge_ok | judge_auth_dead | judge_unprovisioned` — never trusting
 * `GET /v1/models` alone (the documented mirage: an unauthenticated or dead
 * key can still return 200 + a full model catalog).
 *
 * Deliberately NOT part of `GET /api/system/status` (the 30-second-cache
 * dashboard panel): that endpoint is polled passively on page load, and a
 * live LLM call here spends the client's own Ollama Cloud GPU-seconds. This
 * route exists so the P6-01 fleet rollout script can call it ONCE per box per
 * wave and record the verdict into that box's rollout ledger row — normal
 * `/api/*` middleware auth (MC_API_TOKEN bearer for external callers) applies
 * exactly as it does for every other route under this path; no special-casing
 * added here.
 *
 * Same route protected under the ordinary bearer subject to standard
 * middleware rules — see src/middleware.ts.
 */

import { NextResponse } from 'next/server';
import { checkJudgeProvisioning } from '@/lib/probes/qc-judge-probe';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET() {
  try {
    const outcome = await checkJudgeProvisioning();
    return NextResponse.json(
      {
        verdict: outcome.verdict,
        judgeModel: outcome.judgeModel,
        reason: outcome.reason,
        probedAt: new Date().toISOString(),
      },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (err) {
    console.error('[/api/system/qc-judge-probe] failed:', err);
    return NextResponse.json(
      {
        verdict: 'judge_auth_dead',
        judgeModel: process.env.QC_JUDGE_MODEL || null,
        reason: err instanceof Error ? err.message : String(err),
        probedAt: new Date().toISOString(),
      },
      { status: 500, headers: { 'Cache-Control': 'no-store' } },
    );
  }
}
