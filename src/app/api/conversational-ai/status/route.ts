import { NextResponse } from 'next/server';
import { getInterviewState } from '@/lib/conversational-ai/interview-state';
import { ROUND3_DATA_CONTRACT, resolveLogFile, resolveLogDir } from '@/lib/conversational-ai/sources';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * GET /api/conversational-ai/status
 *
 * The Layer-2 gate. Reports whether the AI Workforce interview is complete
 * (which unlocks Layer-2 persona-tuned views) plus which Round-3 data sources
 * are currently present. The page polls this so Layer 2 can appear in real
 * time the moment the interview completes — no reload required.
 *
 * Always returns 200 with a graceful shape; never throws to the client.
 */
export async function GET() {
  try {
    const interview = getInterviewState();

    const sources = ROUND3_DATA_CONTRACT.map((c) => {
      const found = c.kind === 'dir' ? resolveLogDir(c.name) : resolveLogFile(c.name);
      return { name: c.name, metric: c.metric, kind: c.kind, present: !!found };
    });

    const anySource = sources.some((s) => s.present);

    return NextResponse.json({
      ok: true,
      layer: interview.complete ? 2 : 1,
      interview,
      sources,
      anySource,
      generatedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[/api/conversational-ai/status] failed:', err);
    // Graceful default: never crash the dashboard. Default to Layer 1.
    return NextResponse.json({
      ok: false,
      layer: 1,
      interview: {
        complete: false,
        signal: 'none',
        detail: 'Status check failed; defaulting to Layer 1.',
        checkedAt: new Date().toISOString(),
      },
      sources: [],
      anySource: false,
      generatedAt: new Date().toISOString(),
    });
  }
}
