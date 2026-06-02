import { NextRequest, NextResponse } from 'next/server';
import { importRoleLibrary, resolveDepartmentsPath } from '@/lib/role-library-import';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * POST /api/sops/import-role-library
 *
 * Ingest the Skill-23 on-disk role library (departments/<dept>/<NN-role>/how-to.md)
 * into the Command Center `sops` table, tagged with department + role +
 * source='role-library'. Idempotent (upsert by stable slug role-library:<dept>/<role>),
 * never duplicates, never deletes user-authored SOPs.
 *
 * Body (all optional):
 *   { "departments_path": "/abs/path/to/.../departments",  // else ROLE_LIBRARY_PATH
 *                                                            // else <workspace>/departments
 *     "prune_missing": false }                              // soft-delete role-library
 *                                                            // rows gone from disk
 *
 * Optional shared-secret auth: set `CRON_SECRET` and pass `?token=...` or
 * `Authorization: Bearer ...`. Unset → runs unauthenticated (dev mode). Same
 * convention as /api/cron/sop-learning.
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
    const body = await req.json().catch(() => ({} as Record<string, unknown>));
    const departmentsPath =
      typeof body.departments_path === 'string' ? body.departments_path : undefined;
    const pruneMissing = body.prune_missing === true;

    const result = importRoleLibrary({ departmentsPath, pruneMissing });
    return NextResponse.json({ ok: true, ran_at: new Date().toISOString(), ...result });
  } catch (error) {
    console.error('[POST /api/sops/import-role-library] Failed:', error);
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  return handler(req);
}

/**
 * GET /api/sops/import-role-library
 *
 * Returns the resolved departments path that POST would scan (no writes). Lets
 * an operator confirm WHERE the importer will read before triggering it.
 */
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const departmentsPath = url.searchParams.get('departments_path') || undefined;
  return NextResponse.json({
    departments_path: resolveDepartmentsPath(departmentsPath),
    hint: 'POST to this endpoint (optionally with { "departments_path", "prune_missing" }) to import.',
  });
}
