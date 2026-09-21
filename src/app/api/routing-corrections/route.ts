import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { queryAll } from '@/lib/db';
import { recordRoutingCorrection } from '@/lib/capacity/ask-at-capacity';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * /api/routing-corrections — the owner told the intake it got the lane wrong.
 *
 * "Just answer that" on something the agent routed, or "route that" on
 * something it answered in chat. Each correction is EVIDENCE for the intake's
 * own thresholds — never an instruction to any dispatch in flight, and never
 * something this box acts on by itself.
 *
 * `task_id` is optional on purpose: a "just answer that" correction usually
 * concerns a message that became a card, but "route that" concerns one that
 * never did, and there is nothing to point at. Refusing those would lose
 * exactly half the signal.
 *
 * AUTH — a service-to-service surface. The browser interface never calls it
 * (the intake does, from the agent side), so it is bearer-gated in
 * src/lib/bearer-required-routes.ts.
 *
 * GET  → recent corrections, newest first, for the intake to read thresholds from.
 * POST → { to_lane, from_lane?, task_id?, note? }
 */

const LANES = ['answer', 'route', 'heavy'] as const;

const CorrectionSchema = z.object({
  to_lane: z.enum(LANES),
  from_lane: z.enum(LANES).optional().nullable(),
  task_id: z.string().trim().min(1).optional().nullable(),
  note: z.string().trim().max(500).optional().nullable(),
});

export async function GET(request: NextRequest) {
  const limitRaw = Number.parseInt(new URL(request.url).searchParams.get('limit') || '50', 10);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 500) : 50;
  try {
    const rows = queryAll<{
      id: string;
      task_id: string | null;
      from_lane: string | null;
      to_lane: string;
      note: string | null;
      created_at: string;
    }>('SELECT * FROM routing_corrections ORDER BY created_at DESC LIMIT ?', [limit]);
    return NextResponse.json({ corrections: rows });
  } catch {
    // Pre-migration box: no table yet. An empty list is the honest answer and
    // is what the intake should see, rather than a 500 it would have to handle.
    return NextResponse.json({ corrections: [] });
  }
}

export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Body must be JSON' }, { status: 400 });
  }
  const parsed = CorrectionSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'to_lane is required and must be answer|route|heavy', detail: parsed.error.issues },
      { status: 400 },
    );
  }
  const recorded = recordRoutingCorrection({
    taskId: parsed.data.task_id ?? null,
    fromLane: parsed.data.from_lane ?? null,
    toLane: parsed.data.to_lane,
    note: parsed.data.note ?? null,
  });
  if (!recorded) {
    return NextResponse.json({ error: 'routing_corrections is not available on this box' }, { status: 503 });
  }
  return NextResponse.json({ recorded: true, to_lane: parsed.data.to_lane });
}
