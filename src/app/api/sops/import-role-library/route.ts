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
/**
 * Shared-secret gate. When CRON_SECRET is set, both POST and GET require either
 * `?token=<secret>` or `Authorization: Bearer <secret>`. Unset → unauthenticated
 * (dev mode), same convention as /api/cron/sop-learning. Returns a 401
 * NextResponse to short-circuit, or null when the request is authorized.
 */
function checkAuth(req: NextRequest): NextResponse | null {
  const secret = process.env.CRON_SECRET;
  if (!secret) return null;
  const url = new URL(req.url);
  const tokenParam = url.searchParams.get('token');
  const auth = req.headers.get('authorization') || '';
  const tokenHeader = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (tokenParam !== secret && tokenHeader !== secret) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  return null;
}

async function handler(req: NextRequest) {
  const denied = checkAuth(req);
  if (denied) return denied;

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
 *
 * Gated by the same CRON_SECRET as POST: it discloses a resolved filesystem
 * path, so when a secret is configured this read must be authenticated too.
 */
export async function GET(req: NextRequest) {
  const denied = checkAuth(req);
  if (denied) return denied;

  const url = new URL(req.url);
  const departmentsPath = url.searchParams.get('departments_path') || undefined;
  return NextResponse.json({
    departments_path: resolveDepartmentsPath(departmentsPath),
    hint: 'POST to this endpoint (optionally with { "departments_path", "prune_missing" }) to import.',
  });
}
