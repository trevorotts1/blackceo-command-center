import { NextRequest, NextResponse } from 'next/server';
import { v4 as uuidv4 } from 'uuid';
import { queryAll, queryOne, run } from '@/lib/db';
import { broadcast } from '@/lib/events';

/**
 * Skill 48 — Facebook Ad Generator board wiring.
 *
 * POST /api/ad-campaigns — "open the job". Groups one ad run's cards under one campaign.
 *
 * IDEMPOTENT on the receipt-number (`job_id` == `campaign_id`): if a campaign already
 * exists for this job_id it returns the existing campaign and creates ZERO new cards
 * (a retry never double-boards). Otherwise it inserts one parent (epic) card + seven
 * stage cards (S1…S7), all sharing `campaign_id`, all `department` (default
 * 'paid-advertisement'), all assigned to the given agent — then broadcasts the same
 * events the normal create path does so every card appears live.
 *
 * This is the ONLY net-new app code Skill 48 needs; the stage moves, dispatch,
 * deliverables, activities, completion-to-review, and the boss-only approve rule all
 * reuse routes that already exist.
 */

const STAGES: { slug: string; title: string }[] = [
  { slug: 's1-overlays', title: 'S1 — Overlay menu (then pick-10)' },
  { slug: 's2-primary', title: 'S2 — Ad bodies' },
  { slug: 's3-headlines', title: 'S3 — Headlines' },
  { slug: 's4-prompts', title: 'S4 — Image prompts' },
  { slug: 's5-images', title: 'S5 — Images (paid)' },
  { slug: 's6-targeting', title: 'S6 — Targeting brief' },
  { slug: 's7-deliver', title: 'S7 — Host + ad-text doc + PLAI package (then approve)' },
];

interface CardRow {
  id: string;
  campaign_id?: string;
  stage_slug?: string;
  status?: string;
  title?: string;
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const jobId: string = String(body.job_id || '').trim();
    if (!jobId) {
      return NextResponse.json({ error: 'job_id (the receipt-number) is required' }, { status: 400 });
    }

    const showName: string = String(body.show_name || body.campaign_name || 'Facebook ad campaign').trim();
    const date: string = String(body.date || new Date().toISOString().slice(0, 10));
    const workspaceId: string = String(body.workspace_id || 'default');
    const owner: string | null = body.owner ? String(body.owner) : null;
    const ceilingUsd = body.money_ceiling_usd ?? body.ceiling_usd ?? null;
    const agentId: string | null = body.agent_id ? String(body.agent_id) : null;
    const department: string = String(body.department || 'paid-advertisement');

    // ---- Idempotency: a campaign for this job_id already exists -> return it, create nothing.
    const existing = queryAll<CardRow>(
      'SELECT id, campaign_id, stage_slug, status, title FROM tasks WHERE campaign_id = ? ORDER BY stage_slug',
      [jobId]
    );
    if (existing.length > 0) {
      const parent = existing.find(c => c.stage_slug === 'epic') || existing[0];
      return NextResponse.json({
        campaign_id: jobId,
        parent_id: parent.id,
        created: false,
        idempotent: true,
        stages: existing.filter(c => c.stage_slug !== 'epic').map(c => ({ slug: c.stage_slug, id: c.id })),
      }, { status: 200 });
    }

    // ---- Pre-flight: confirm the assigned agent exists (don't let dispatch go nowhere).
    if (agentId) {
      const agent = queryOne<{ id: string }>('SELECT id FROM agents WHERE id = ?', [agentId]);
      if (!agent) {
        return NextResponse.json(
          { error: `agent_id ${agentId} not found — add the ${department} agent first or pass a real agent id` },
          { status: 400 }
        );
      }
    }

    const now = new Date().toISOString();
    const created: CardRow[] = [];

    const insertCard = (title: string, stageSlug: string, status: string): string => {
      const id = uuidv4();
      // Our own endpoint can write department directly (the stock create path cannot).
      run(
        `INSERT INTO tasks (id, title, description, status, priority, assigned_agent_id,
            workspace_id, business_id, department, campaign_id, stage_slug, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id, title,
          `Facebook ad campaign ${jobId} (${showName}, ${date})` +
            (ceilingUsd != null ? ` · ceiling $${ceilingUsd}` : ''),
          status, 'high', agentId, workspaceId, 'default', department, jobId, stageSlug, now, now,
        ]
      );
      const row = queryOne<CardRow>('SELECT id, campaign_id, stage_slug, status, title FROM tasks WHERE id = ?', [id]);
      if (row) created.push(row);
      return id;
    };

    // One parent (epic) card + seven stage cards, all sharing campaign_id == jobId.
    const parentId = insertCard(`Campaign: ${showName} (${jobId})`, 'epic', 'backlog');
    const stages = STAGES.map(s => ({ slug: s.slug, id: insertCard(s.title, s.slug, 'backlog') }));

    // Broadcast the same event the normal create path does, so all cards appear live.
    for (const row of created) {
      broadcast({ type: 'task_created', payload: row } as never);
    }

    // Optionally kick off stage 1.
    if (body.start_stage_1 === true) {
      run('UPDATE tasks SET status = ?, updated_at = ? WHERE campaign_id = ? AND stage_slug = ?',
        ['in_progress', new Date().toISOString(), jobId, 's1-overlays']);
      const s1 = queryOne<CardRow>('SELECT id, campaign_id, stage_slug, status, title FROM tasks WHERE campaign_id = ? AND stage_slug = ?', [jobId, 's1-overlays']);
      if (s1) broadcast({ type: 'task_updated', payload: s1 } as never);
    }

    return NextResponse.json({
      campaign_id: jobId,
      parent_id: parentId,
      created: true,
      stages,
    }, { status: 201 });
  } catch (error) {
    console.error('[POST /api/ad-campaigns] failed:', error);
    return NextResponse.json({ error: 'Failed to create ad campaign' }, { status: 500 });
  }
}

// GET /api/ad-campaigns — list every campaign (grouped) for a dashboard rollup.
export async function GET() {
  try {
    const rows = queryAll<CardRow>(
      "SELECT id, campaign_id, stage_slug, status, title FROM tasks WHERE campaign_id IS NOT NULL ORDER BY campaign_id, stage_slug"
    );
    const byCampaign: Record<string, CardRow[]> = {};
    for (const r of rows) {
      const cid = r.campaign_id as string;
      (byCampaign[cid] = byCampaign[cid] || []).push(r);
    }
    return NextResponse.json(Object.entries(byCampaign).map(([campaign_id, cards]) => ({ campaign_id, cards })));
  } catch (error) {
    console.error('[GET /api/ad-campaigns] failed:', error);
    return NextResponse.json({ error: 'Failed to list ad campaigns' }, { status: 500 });
  }
}
