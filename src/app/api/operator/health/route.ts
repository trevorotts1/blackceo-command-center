/**
 * GET /api/operator/health
 *
 * Read-only per-module health for the Operator Console (Feature 2). Reports,
 * for each persisting sub-module (Goals, Journal, Notebook, Studio, Research),
 * whether it is actually persisting to the database AND whether the last write
 * reached the operator vault.
 *
 * Status vocabulary matches the System Status Panel (`src/lib/system-status.ts`)
 * so the dots share one visual language:
 *   live    → green  (vault write confirmed)
 *   busy    → amber  (saved to DB, vault mirror unconfirmed)
 *   offline → red    (DB error, or last vault write failed)
 *   unknown → grey   (nothing determinable yet)
 *
 * The handler NEVER throws and NEVER fabricates a green: when vault state cannot
 * be determined it returns `unknown`, not `live`. It is a pure probe — no
 * mutations, no provider calls. Protected by the same Cloudflare Access +
 * MC_API_TOKEN middleware as every other `/api/*` route.
 *
 * Query params:
 *   ?module=goals|journal|notebook|studio|research  — limit to one module.
 */

import { NextRequest, NextResponse } from 'next/server';
import {
  getAllModuleHealth,
  getModuleHealth,
  type ModuleId,
} from '@/lib/operator/module-health';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const VALID_MODULES: ModuleId[] = ['goals', 'journal', 'notebook', 'studio', 'research'];

function worst(statuses: string[]): string {
  // Same priority order as worstStatus() in src/lib/probes/types.ts.
  const order = ['offline', 'degraded', 'busy', 'working', 'unknown', 'live'];
  for (const s of order) {
    if (statuses.includes(s)) return s;
  }
  return 'unknown';
}

export async function GET(req: NextRequest) {
  const moduleParam = new URL(req.url).searchParams.get('module');

  try {
    if (moduleParam) {
      if (!VALID_MODULES.includes(moduleParam as ModuleId)) {
        return NextResponse.json(
          { error: 'invalid_module', valid: VALID_MODULES },
          { status: 400 }
        );
      }
      const health = await getModuleHealth(moduleParam as ModuleId);
      return NextResponse.json(
        { overall: health.status, modules: [health], probedAt: new Date().toISOString() },
        { headers: { 'cache-control': 'no-store' } }
      );
    }

    const modules = await getAllModuleHealth();
    const overall = worst(modules.map((m) => m.status));
    return NextResponse.json(
      { overall, modules, probedAt: new Date().toISOString() },
      { headers: { 'cache-control': 'no-store' } }
    );
  } catch (err) {
    // Defensive: getModuleHealth/getAllModuleHealth are designed never to throw,
    // but if something upstream does, report unknown rather than 500-ing the UI.
    return NextResponse.json(
      {
        overall: 'unknown',
        modules: [],
        probedAt: new Date().toISOString(),
        error: err instanceof Error ? err.message : 'unknown',
      },
      { status: 200, headers: { 'cache-control': 'no-store' } }
    );
  }
}
