import { NextRequest, NextResponse } from 'next/server';
import { queryAll, queryOne } from '@/lib/db';
import { recordFeedback, type SOPFeedbackRow } from '@/lib/sop-learning';

/**
 * POST /api/sops/feedback
 *
 * Body: { sop_id, task_id, rating (1|-1|0), notes?, agent_id? }
 *
 * Triggered by the post-completion thumbs modal. `rating=0` records a "skip"
 * so we still know the user saw the modal — that's used to compute survey
 * fatigue and silence the modal after N consecutive skips on the same SOP.
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();

    if (typeof body.sop_id !== 'string' || !body.sop_id) {
      return NextResponse.json({ error: 'sop_id is required' }, { status: 400 });
    }
    if (typeof body.task_id !== 'string' || !body.task_id) {
      return NextResponse.json({ error: 'task_id is required' }, { status: 400 });
    }
    if (![1, -1, 0].includes(body.rating)) {
      return NextResponse.json({ error: 'rating must be 1, -1, or 0' }, { status: 400 });
    }

    const sop = queryOne<{ id: string }>('SELECT id FROM sops WHERE id = ?', [body.sop_id]);
    if (!sop) return NextResponse.json({ error: 'sop not found' }, { status: 404 });

    const task = queryOne<{ id: string }>('SELECT id FROM tasks WHERE id = ?', [body.task_id]);
    if (!task) return NextResponse.json({ error: 'task not found' }, { status: 404 });

    const row = recordFeedback({
      sop_id: body.sop_id,
      task_id: body.task_id,
      rating: body.rating,
      notes: typeof body.notes === 'string' ? body.notes.slice(0, 2000) : null,
      agent_id: typeof body.agent_id === 'string' ? body.agent_id : null,
    });

    return NextResponse.json(row, { status: 201 });
  } catch (error) {
    console.error('[POST /api/sops/feedback] Failed:', error);
    return NextResponse.json({ error: 'Failed to record feedback' }, { status: 500 });
  }
}

/**
 * GET /api/sops/feedback?sop_id=...&task_id=...
 *
 * Used by the modal to check whether feedback was already submitted for a
 * (sop, task) pair — prevents the modal from re-prompting when the user
 * lands on the same task twice.
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const sopId = searchParams.get('sop_id');
    const taskId = searchParams.get('task_id');

    let sql = 'SELECT * FROM sop_feedback WHERE 1=1';
    const params: unknown[] = [];
    if (sopId) {
      sql += ' AND sop_id = ?';
      params.push(sopId);
    }
    if (taskId) {
      sql += ' AND task_id = ?';
      params.push(taskId);
    }
    sql += ' ORDER BY created_at DESC LIMIT 100';

    const rows = queryAll<SOPFeedbackRow>(sql, params);
    return NextResponse.json(rows);
  } catch (error) {
    console.error('[GET /api/sops/feedback] Failed:', error);
    return NextResponse.json({ error: 'Failed to read feedback' }, { status: 500 });
  }
}
