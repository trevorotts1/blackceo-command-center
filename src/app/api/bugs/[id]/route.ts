/**
 * PATCH /api/bugs/[id] -- lane transition for a bug ticket.
 *
 * Validates the requested status against BUG_LEGAL_TRANSITIONS, writes a
 * bug_ticket_events row, updates bug_tickets.status, and broadcasts SSE
 * { type: 'bug_updated' }.
 *
 * Returns 400 on illegal transitions (including skipping lanes like
 * REPORTED -> HEALED).  Returns 404 if the ticket does not exist.
 *
 * T3-001: tasks table + TaskStatus are never touched by this route.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { transitionBug, BugTransitionError } from '@/lib/bug-lifecycle';
import type { BugStatus } from '@/lib/types';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const BugStatusEnum = z.enum([
  'REPORTED',
  'TRIAGED',
  'HEALING',
  'VERIFYING',
  'HEALED',
  'REGRESSION WATCH',
  'CLOSED',
]);

const PatchBugSchema = z.object({
  status: BugStatusEnum,
  actor: z.string().optional(),
  reason: z.string().optional(),
});

export async function PATCH(
  request: NextRequest,
  { params }: { params: { id: string } },
): Promise<NextResponse> {
  const { id } = params;

  try {
    const body = await request.json();
    const parsed = PatchBugSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Validation failed', details: parsed.error.flatten() },
        { status: 400 },
      );
    }

    const { status, actor, reason } = parsed.data;

    const updated = await transitionBug(id, status as BugStatus, { actor, reason });
    return NextResponse.json({ bug: updated });
  } catch (err) {
    if (err instanceof BugTransitionError) {
      if (err.code === 'NOT_FOUND') {
        return NextResponse.json({ error: err.message }, { status: 404 });
      }
      // ILLEGAL_TRANSITION or any other known transition error
      return NextResponse.json({ error: err.message, code: err.code }, { status: 400 });
    }

    console.error(`[PATCH /api/bugs/${id}]`, err);
    return NextResponse.json({ error: 'Failed to transition bug ticket' }, { status: 500 });
  }
}
