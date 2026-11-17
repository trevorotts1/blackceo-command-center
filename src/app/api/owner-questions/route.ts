import { NextRequest, NextResponse } from 'next/server';
import { resolveTenantContext, TenantAccessError } from '@/lib/auth/tenant-context';
import { listOpenOwnerQuestions } from '@/lib/owner-questions';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * GET /api/owner-questions?status=open — the questions waiting on the client.
 * Both the agent bearer and the verified owner may read. Operator/system
 * faults are never owner questions, so they never appear here.
 * Response: { questions: [{ id, task_id, task_title, kind, short_code, question,
 * recommendation, asked_at, pushed_at }] }
 */
export async function GET(request: NextRequest) {
  try {
    await resolveTenantContext(request);
  } catch (err) {
    if (err instanceof TenantAccessError) return NextResponse.json({ error: 'tenant_identity_required' }, { status: 403 });
    throw err;
  }
  const status = request.nextUrl.searchParams.get('status') ?? 'open';
  if (status !== 'open') return NextResponse.json({ error: 'invalid_status', detail: 'status is open' }, { status: 400 });
  let questions: ReturnType<typeof listOpenOwnerQuestions> = [];
  try { questions = listOpenOwnerQuestions(); } catch { questions = []; }
  return NextResponse.json({ questions });
}
