import { NextRequest, NextResponse } from 'next/server';
import { getAgentGrade, DEFAULT_AGENT_WINDOW_DAYS } from '@/lib/agents/performance';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// GET /api/agents/[id]/performance?window=30
//
// U58 (Skill 6 Blended-Persona Kanban v2, Stage 2 / exec-summary item 9) —
// read-only per-agent performance surface. Response mirrors DepartmentGrade's
// shape (inputs/score/grade/sufficientData — src/lib/grading.ts) scoped to one
// agent's own tasks, plus the windowed completion rate, blocked-task count +
// list, a windowed velocity figure, and the all-time completed count + weekly
// trend series. See @/lib/agents/performance's getAgentGrade for the full
// computation (on-read JOIN of tasks x task_qc_results — see @/lib/agents/
// performance's module doc for why that table, not a literal `qc_reviews`,
// is the J.0.4-correct source). No new table, no migration.
//
// `window` accepts any positive integer number of days; an absent, blank, or
// invalid value falls back to the same 30-day default computeDepartmentGrade /
// computeCompanyHealth use, so an agent's grade is comparable to a
// department's grade for the same window.
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
function parseWindowDays(raw: string | null): number {
  if (!raw) return DEFAULT_AGENT_WINDOW_DAYS;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) return DEFAULT_AGENT_WINDOW_DAYS;
  return n;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const windowDays = parseWindowDays(request.nextUrl.searchParams.get('window'));
    const grade = getAgentGrade(id, windowDays);

    if (!grade) {
      return NextResponse.json({ error: 'Agent not found' }, { status: 404 });
    }

    return NextResponse.json(grade);
  } catch (error) {
    console.error('Failed to compute agent performance:', error);
    return NextResponse.json({ error: 'Failed to compute agent performance' }, { status: 500 });
  }
}
