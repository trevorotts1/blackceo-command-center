/**
 * GET    /api/operator/goals/[id] — fetch one goal
 * PATCH  /api/operator/goals/[id] — partial update (title, body, category,
 *                                   completed, sort_order)
 * DELETE /api/operator/goals/[id] — remove a goal
 *
 * Track B6 (Operator Console Goals, PRD Section 4.7).
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { deleteGoal, getGoal, updateGoal, writeVaultMirror } from '@/lib/operator/goals';

const patchSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  body: z.string().max(20000).nullable().optional(),
  category: z.string().max(80).nullable().optional(),
  completed: z.boolean().optional(),
  sort_order: z.number().int().optional(),
});

export async function GET(_req: NextRequest, ctx: { params: { id: string } }) {
  const goal = getGoal(ctx.params.id);
  if (!goal) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }
  return NextResponse.json(goal);
}

export async function PATCH(req: NextRequest, ctx: { params: { id: string } }) {
  let parsed;
  try {
    const json = await req.json();
    parsed = patchSchema.parse(json);
  } catch (err) {
    return NextResponse.json(
      { error: 'invalid_body', detail: err instanceof Error ? err.message : 'unknown' },
      { status: 400 }
    );
  }
  try {
    const updated = updateGoal(ctx.params.id, parsed);
    if (!updated) {
      return NextResponse.json({ error: 'not_found' }, { status: 404 });
    }
    void writeVaultMirror();
    return NextResponse.json(updated);
  } catch (err) {
    return NextResponse.json(
      { error: 'update_failed', detail: err instanceof Error ? err.message : 'unknown' },
      { status: 500 }
    );
  }
}

export async function DELETE(_req: NextRequest, ctx: { params: { id: string } }) {
  try {
    const removed = deleteGoal(ctx.params.id);
    if (!removed) {
      return NextResponse.json({ error: 'not_found' }, { status: 404 });
    }
    void writeVaultMirror();
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: 'delete_failed', detail: err instanceof Error ? err.message : 'unknown' },
      { status: 500 }
    );
  }
}
