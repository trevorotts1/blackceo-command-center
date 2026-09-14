import { NextRequest, NextResponse } from 'next/server';
import { timingSafeEqual } from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { queryOne, run } from '@/lib/db';
import type { Task } from '@/lib/types';
import { transition, TransitionError } from '@/lib/task-lifecycle';
import { autoDispatchTask } from '@/lib/task-dispatcher';
import { claimPreEngineRecoveryDispatch, issuePreEngineRecovery } from '@/lib/presentation-operator-recovery';
import { verifyWebhookSignatureStrict } from '@/lib/webhook-signature';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

function auth(request: NextRequest, raw: string): boolean {
  const token = process.env.MC_API_TOKEN;
  if (token) {
    const supplied = request.headers.get('authorization')?.replace(/^Bearer /, '') ?? '';
    const a = Buffer.from(supplied); const b = Buffer.from(token);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return false;
  }
  return verifyWebhookSignatureStrict(request.headers.get('x-webhook-signature'), raw);
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const raw = await request.text();
    if (!auth(request, raw)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    let evidence: unknown;
    try { evidence = JSON.parse(raw); } catch { return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }); }
    let issued;
    try { issued = issuePreEngineRecovery(id, evidence); }
    catch (error) {
      const code = (error as Error).message;
      const status = code === 'task_not_found' ? 404 : code === 'pre_engine_recovery_already_issued' ? 409 : 422;
      return NextResponse.json({ error: code }, { status });
    }
    const task = queryOne<Task>('SELECT * FROM tasks WHERE id=?', [id]);
    if (!task) return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    if (task.status === 'blocked') {
      try {
        await transition(id, 'backlog', { actor: 'operator-preengine-recovery', reason: `[operator-preengine-recovery] ${issued.recovery.id}; prior dispatch attempts retained: ${issued.recovery.prior_dispatch_attempts}`, expectedFrom: 'blocked' });
      } catch (error) {
        if (!(error instanceof TransitionError) || error.code !== 'CAS_CONFLICT') throw error;
      }
      run(`INSERT INTO task_activities (id, task_id, activity_type, message, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
        [uuidv4(), id, 'operator_preengine_recovery_issued', 'Verified deterministic pre-engine repair authorized one bridge retry; historical dispatch attempts retained.', JSON.stringify(issued.recovery), new Date().toISOString()]);
    }
    const fresh = queryOne<Task>('SELECT * FROM tasks WHERE id=?', [id]);
    if (fresh?.status === 'backlog' && claimPreEngineRecoveryDispatch(issued.recovery.id)) {
      const outcome = await autoDispatchTask(id, 'operator-preengine-recovery');
      return NextResponse.json({ success: true, authorized: true, idempotent: issued.idempotent, recovery: issued.recovery, dispatch: outcome });
    }
    return NextResponse.json({ success: true, authorized: true, idempotent: true, recovery: issued.recovery, detail: 'Recovery was already resumed or its one bridge retry was already claimed.' });
  } catch (error) {
    console.error('[operator-preengine-recovery] failed:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
