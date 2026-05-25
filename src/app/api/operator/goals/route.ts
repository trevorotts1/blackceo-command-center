/**
 * GET  /api/operator/goals       — list goals (optional filters)
 * POST /api/operator/goals       — create a new goal
 *
 * Track B6 (Operator Console Goals, PRD Section 4.7).
 *
 * Filters:
 *   ?category=<string>          — limit to a category
 *   ?completed=true|false       — limit by completion state
 *
 * POST body:
 *   { title: string (required, <=200 chars), body?: string, category?: string, sort_order?: number }
 *
 * On any mutation we re-render the vault mirror under `<vault>/goals.md` and
 * `<vault>/goals/<category>.md`. Mirror write failures do not fail the API.
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createGoal, listGoals, writeVaultMirror } from '@/lib/operator/goals';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const createSchema = z.object({
  title: z.string().min(1).max(200),
  body: z.string().max(20000).optional().nullable(),
  category: z.string().max(80).optional().nullable(),
  sort_order: z.number().int().optional(),
});

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const categoryParam = url.searchParams.get('category');
  const completedParam = url.searchParams.get('completed');
  const opts: { category?: string | null; completed?: boolean | null } = {};
  if (categoryParam !== null) opts.category = categoryParam;
  if (completedParam !== null) {
    if (completedParam === 'true') opts.completed = true;
    else if (completedParam === 'false') opts.completed = false;
  }
  try {
    const goals = listGoals(opts);
    return NextResponse.json({ items: goals, total: goals.length });
  } catch (err) {
    return NextResponse.json(
      { error: 'list_failed', detail: err instanceof Error ? err.message : 'unknown' },
      { status: 500 }
    );
  }
}

export async function POST(req: NextRequest) {
  let parsed;
  try {
    const json = await req.json();
    parsed = createSchema.parse(json);
  } catch (err) {
    return NextResponse.json(
      { error: 'invalid_body', detail: err instanceof Error ? err.message : 'unknown' },
      { status: 400 }
    );
  }
  try {
    const goal = createGoal({
      title: parsed.title,
      body: parsed.body ?? null,
      category: parsed.category ?? null,
      sort_order: parsed.sort_order,
    });
    // Fire and forget. The DB row is the source of truth.
    void writeVaultMirror();
    return NextResponse.json(goal, { status: 201 });
  } catch (err) {
    return NextResponse.json(
      { error: 'create_failed', detail: err instanceof Error ? err.message : 'unknown' },
      { status: 500 }
    );
  }
}
