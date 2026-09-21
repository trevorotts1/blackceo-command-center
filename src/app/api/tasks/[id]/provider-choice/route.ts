import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { queryOne } from '@/lib/db';
import { applyProviderChoice, latestAsk } from '@/lib/capacity/ask-at-capacity';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * /api/tasks/[id]/provider-choice — the owner's answer to a capacity question.
 *
 * When a card's own preferred model cannot serve it and something material is
 * at stake, the dispatcher holds the card and asks the owner (see
 * src/lib/capacity/ask-at-capacity.ts). This is where that answer lands.
 *
 * ONLY TWO ANSWERS EXIST, because only two are honest. The gateway takes no
 * per-run model, so "run it on X" is not an instruction this box can carry out:
 *
 *   overflow_ok   proceed now; the run takes whichever pool in the agent's own
 *                 chain has room. This is also what a silent owner gets when
 *                 the answer window lapses.
 *   primary_only  do NOT run while the agent's own primary is blocked. The
 *                 card keeps waiting for that subscription, and the answer is
 *                 remembered so the same question is never asked twice.
 *
 * ONE ANSWER CAN CLEAR A QUEUE. Past the hourly message budget, later cards are
 * attached to the question that was actually SENT rather than generating more
 * messages. Answering that question applies to every card batched behind it,
 * and the response says which ids moved.
 *
 * AUTH — the same posture as the sibling operator-driven task routes (dispatch,
 * audience, persona-choice): NOT a webhook route, so it inherits the standard
 * operator gate in src/middleware.ts (Cloudflare Access when enabled, plus the
 * same-origin / MC_API_TOKEN layer). An external caller without the bearer is
 * rejected before this handler runs.
 *
 * GET  → the open question for this card, for a board panel to render.
 * POST → { choice: 'overflow_ok' | 'primary_only' }
 */

const ChoiceSchema = z.object({
  choice: z.enum(['overflow_ok', 'primary_only']),
});

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function GET(_request: NextRequest, { params }: RouteParams) {
  const { id } = await params;
  const task = queryOne<{ id: string; provider_choice: string | null }>(
    'SELECT id, provider_choice FROM tasks WHERE id = ?',
    [id],
  );
  if (!task) return NextResponse.json({ error: 'Task not found' }, { status: 404 });
  const ask = latestAsk(id);
  return NextResponse.json({
    taskId: id,
    choice: task.provider_choice,
    ask: ask
      ? {
          question: ask.question,
          recommendation: ask.recommendation,
          askedAt: ask.asked_at,
          delivered: ask.delivered,
          answeredAt: ask.answered_at,
          answer: ask.answer,
          batchId: ask.batch_id,
        }
      : null,
  });
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  const { id } = await params;
  const task = queryOne<{ id: string }>('SELECT id FROM tasks WHERE id = ?', [id]);
  if (!task) return NextResponse.json({ error: 'Task not found' }, { status: 404 });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Body must be JSON' }, { status: 400 });
  }
  const parsed = ChoiceSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'choice must be "overflow_ok" or "primary_only"', detail: parsed.error.issues },
      { status: 400 },
    );
  }

  const applied = applyProviderChoice(id, parsed.data.choice);
  return NextResponse.json({ taskId: id, choice: parsed.data.choice, applied });
}
