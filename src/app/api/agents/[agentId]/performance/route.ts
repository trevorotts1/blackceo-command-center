import { NextRequest, NextResponse } from 'next/server';
import { getAgentPerformance } from '@/lib/agents/performance';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// GET /api/agents/[agentId]/performance
//
// U58 (Skill 6 Blended-Persona Kanban v2, Stage 2 / exec-summary item 9) —
// read-only per-agent performance surface: completed count, avg QC score,
// pass-rate, throughput, and a weekly trend series, computed on-read by
// JOINing tasks x task_qc_results (see @/lib/agents/performance). No new
// table, no migration.
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ agentId: string }> },
) {
  try {
    const { agentId } = await params;
    const performance = getAgentPerformance(agentId);

    if (!performance) {
      return NextResponse.json({ error: 'Agent not found' }, { status: 404 });
    }

    return NextResponse.json(performance);
  } catch (error) {
    console.error('Failed to compute agent performance:', error);
    return NextResponse.json({ error: 'Failed to compute agent performance' }, { status: 500 });
  }
}
