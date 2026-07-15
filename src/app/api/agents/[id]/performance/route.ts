import { NextRequest, NextResponse } from 'next/server';
import { getAgentPerformance } from '@/lib/agents/performance';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// GET /api/agents/[id]/performance
//
// U58 (Skill 6 Blended-Persona Kanban v2, Stage 2 / exec-summary item 9) —
// read-only per-agent performance surface: completed count, avg QC score,
// pass-rate, throughput, and a weekly trend series, computed on-read by
// JOINing tasks x task_qc_results (see @/lib/agents/performance). No new
// table, no migration.
//
// Segment is named [id] (not [agentId]) to match the existing sibling
// routes under src/app/api/agents/[id]/ (route.ts, memory-logs, openclaw) —
// Next.js's filesystem router forbids two different dynamic-segment names
// at the same path position, which mixing [agentId] in here with the
// pre-existing [id] siblings did (getSortedRoutes hard-fails `next build`
// for the entire app, not just this route). The page route
// src/app/agents/[agentId]/ is a separate route tree (UI pages, not this
// API) and is unaffected — it only builds this route's URL as a plain
// string, so it needs no change.
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const performance = getAgentPerformance(id);

    if (!performance) {
      return NextResponse.json({ error: 'Agent not found' }, { status: 404 });
    }

    return NextResponse.json(performance);
  } catch (error) {
    console.error('Failed to compute agent performance:', error);
    return NextResponse.json({ error: 'Failed to compute agent performance' }, { status: 500 });
  }
}
