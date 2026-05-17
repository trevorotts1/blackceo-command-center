import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';

export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  const db = getDb();
  const body = await request.json();
  const rating = parseInt(String(body.rating), 10);
  const note = (body.note || '').toString().slice(0, 1000);

  if (![-1, 0, 1].includes(rating)) {
    return NextResponse.json({ error: 'rating must be -1, 0, or 1' }, { status: 400 });
  }

  const result = db.prepare(`
    UPDATE persona_performance
    SET owner_rating = ?, owner_feedback_note = ?
    WHERE task_id = ?
  `).run(rating, note, params.id);

  if (result.changes === 0) {
    return NextResponse.json({ error: 'task has no performance record yet' }, { status: 404 });
  }

  // Auto-rebalance check: 3+ negatives in 7d for same persona triggers downweight
  if (rating === -1) {
    triggerRebalanceCheck(db, params.id);
  }

  return NextResponse.json({ success: true });
}

function triggerRebalanceCheck(db: any, taskId: string) {
  const task = db.prepare(`
    SELECT persona_id, department_id, task_category FROM persona_performance WHERE task_id = ?
  `).get(taskId) as any;
  if (!task) return;

  const recent = db.prepare(`
    SELECT COUNT(*) AS c FROM persona_performance
    WHERE persona_id = ?
      AND owner_rating = -1
      AND completed_at >= datetime('now', '-7 days')
  `).get(task.persona_id) as any;

  if (recent.c >= 3) {
    db.prepare(`
      INSERT INTO persona_weight_overrides
        (persona_id, department_id, task_category, adjustment_factor, reason, expires_at)
      VALUES (?, ?, ?, ?, ?, datetime('now', '+30 days'))
    `).run(
      task.persona_id,
      task.department_id,
      task.task_category,
      0.85,
      `Auto-downweight: ${recent.c} negative owner ratings in 7 days`
    );
  }
}
