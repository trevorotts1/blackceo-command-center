import { NextRequest, NextResponse } from 'next/server';
import { queryAll, queryOne, run } from '@/lib/db';
import { broadcast } from '@/lib/events';

/**
 * POST /api/ad-campaigns/[id]/resume — the explicit, proven "start the next stages" call.
 *
 * After the owner picks their top 10 (human pause #1, recorded by the skill), this moves the
 * fan-out stages (S2 bodies / S3 headlines / S4 prompts) from backlog -> in_progress. Moving a
 * task to in_progress is what auto-dispatches it to the assigned agent, so the three stages
 * truly start at the same time. The dependency ordering (S6 after S2+S3; S7 after S5+S6) is
 * enforced inside the skill by ad_director.py, not by the board.
 *
 * Body (optional): { stages: ["s2-primary","s3-headlines","s4-prompts"] } to override the set.
 */

const DEFAULT_RESUME = ['s2-primary', 's3-headlines', 's4-prompts'];

interface CardRow {
  id: string;
  campaign_id?: string;
  stage_slug?: string;
  status?: string;
  title?: string;
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    let stages = DEFAULT_RESUME;
    try {
      const body = await request.json();
      if (Array.isArray(body?.stages) && body.stages.length) stages = body.stages.map(String);
    } catch {
      // empty body -> default fan-out set
    }

    const exists = queryOne<{ c: number }>('SELECT COUNT(*) as c FROM tasks WHERE campaign_id = ?', [id]);
    if (!exists || exists.c === 0) {
      return NextResponse.json({ error: `no campaign found for ${id}` }, { status: 404 });
    }

    const now = new Date().toISOString();
    const moved: CardRow[] = [];
    for (const slug of stages) {
      run('UPDATE tasks SET status = ?, updated_at = ? WHERE campaign_id = ? AND stage_slug = ? AND status != ?',
        ['in_progress', now, id, slug, 'done']);
      const row = queryOne<CardRow>(
        'SELECT id, campaign_id, stage_slug, status, title FROM tasks WHERE campaign_id = ? AND stage_slug = ?',
        [id, slug]
      );
      if (row) {
        moved.push(row);
        broadcast({ type: 'task_updated', payload: row } as never);
      }
    }

    return NextResponse.json({ campaign_id: id, resumed: moved.map(m => ({ slug: m.stage_slug, id: m.id, status: m.status })) });
  } catch (error) {
    console.error('[POST /api/ad-campaigns/[id]/resume] failed:', error);
    return NextResponse.json({ error: 'Failed to resume campaign' }, { status: 500 });
  }
}
