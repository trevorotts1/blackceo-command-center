import { NextRequest, NextResponse } from 'next/server';
import { queryAll } from '@/lib/db';

/**
 * GET /api/ad-campaigns/[id] — feed the CampaignSpotlightCard display block with the real
 * cards for one campaign (id == the receipt-number / campaign_id). Returns the parent (epic)
 * card and the seven stage cards with their live status, so the board can render the campaign
 * as one grouped unit.
 */

interface CardRow {
  id: string;
  campaign_id?: string;
  stage_slug?: string;
  status?: string;
  title?: string;
  blocked_reason?: string;
  assigned_agent_id?: string;
  department?: string;
  updated_at?: string;
}

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const cards = queryAll<CardRow>(
      `SELECT id, campaign_id, stage_slug, status, title, blocked_reason,
              assigned_agent_id, department, updated_at
       FROM tasks WHERE campaign_id = ? ORDER BY stage_slug`,
      [id]
    );
    if (cards.length === 0) {
      return NextResponse.json({ error: `no campaign found for ${id}` }, { status: 404 });
    }
    const parent = cards.find(c => c.stage_slug === 'epic') || null;
    const stages = cards.filter(c => c.stage_slug !== 'epic');
    return NextResponse.json({
      campaign_id: id,
      parent,
      stages,
      counts: stages.reduce((acc: Record<string, number>, c) => {
        const s = c.status || 'unknown';
        acc[s] = (acc[s] || 0) + 1;
        return acc;
      }, {}),
    });
  } catch (error) {
    console.error('[GET /api/ad-campaigns/[id]] failed:', error);
    return NextResponse.json({ error: 'Failed to fetch campaign' }, { status: 500 });
  }
}
