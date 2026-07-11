import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { queryOne } from '@/lib/db';
import { canonicalDeptSlug } from '@/lib/routing/canonical-slug';
import {
  confirmTaskAudience,
  evaluateAudienceConfirmGate,
  rescoreAudienceBlend,
} from '@/lib/tasks';
import type { Task } from '@/lib/types';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * /api/tasks/[id]/audience — D3 (persona-blend audience-confirm).
 *
 * A content task that went through the voice-first `--blend` (D1) carries a
 * persona bundle with `confirm_required: true`. Per the ALWAYS-confirm rule
 * (persona_blend.py resolve_audience), the resolved ICP audience is NEVER
 * written without operator sign-off — evaluateAudienceConfirmGate HOLDs the
 * dispatcher's write step until this route is called, or up to
 * AUDIENCE_CONFIRM_DEADLINE_MS (default 30 min) elapses, at which point the
 * task releases under house-voice governance ONLY (never-naked, but the
 * audience voice never landed).
 *
 * Before this route existed, `confirmTaskAudience` (src/lib/tasks.ts) had ZERO
 * callers outside its own unit tests — every gated content task was
 * unconditionally 30-min timing out. This route is the missing caller, plus
 * the voice re-score `confirmTaskAudience`'s own doc says the caller must run
 * on confirm (rescoreAudienceBlend — re-runs `--blend` with ENV
 * OPENCLAW_AUDIENCE so the VOICE decision actually reflects the confirmed
 * audience instead of the pre-confirm neutral-house-voice directive).
 *
 * AUTH — same posture as the sibling operator-driven task routes (dispatch,
 * rating, the main PATCH /api/tasks/[id]): this is NOT a webhook route (it is
 * deliberately absent from src/middleware.ts WEBHOOK_SECRET_ROUTES), so it
 * inherits the standard operator gate — Cloudflare Access (when
 * REQUIRE_CF_ACCESS=true) + the same-origin/MC_API_TOKEN layer in
 * src/middleware.ts. An external caller without the bearer token is rejected
 * before this handler ever runs.
 *
 * GET  → the current gate status (evaluateAudienceConfirmGate): hold/state/
 *        prompt/candidates, for the Kanban confirm panel to render.
 * POST → { audienceLabel: string, audienceId?: string } confirms (or changes)
 *        the audience, then re-scores the voice.
 */

const AudienceConfirmSchema = z.object({
  audienceLabel: z.string().trim().min(1, 'audienceLabel is required'),
  audienceId: z.string().trim().min(1).optional().nullable(),
});

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function GET(_request: NextRequest, { params }: RouteParams) {
  const { id } = await params;
  const task = queryOne<{ id: string }>('SELECT id FROM tasks WHERE id = ?', [id]);
  if (!task) {
    return NextResponse.json({ error: 'Task not found' }, { status: 404 });
  }
  const gate = evaluateAudienceConfirmGate(id);
  return NextResponse.json(gate, { status: 200 });
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params;

    const task = queryOne<Task>('SELECT * FROM tasks WHERE id = ?', [id]);
    if (!task) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }

    let payload: unknown;
    try {
      payload = await request.json();
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }
    const validation = AudienceConfirmSchema.safeParse(payload);
    if (!validation.success) {
      return NextResponse.json(
        {
          error: 'Validation failed',
          details: validation.error.issues,
          hint: 'audienceLabel (string, required); audienceId (string, optional).',
        },
        { status: 400 },
      );
    }
    const { audienceLabel, audienceId } = validation.data;

    // A task with no persona-blend bundle at all has nothing to confirm — this
    // route only applies to content tasks that went through --blend (D1).
    const gateBefore = evaluateAudienceConfirmGate(id);
    if (gateBefore.state === 'no_bundle') {
      return NextResponse.json(
        {
          error: 'This task has no persona-blend audience gate to confirm.',
          hint: 'Only content tasks selected via --blend (D1) carry a resolved_audience gate.',
        },
        { status: 409 },
      );
    }

    const priorLabel = task.audience_label ?? null;
    const changed =
      Boolean(priorLabel) && priorLabel!.trim().toLowerCase() !== audienceLabel.trim().toLowerCase();

    // Flip confirm_state -> 'confirmed' and mirror the audience onto tasks.*
    // NOW, so the dispatcher's gate releases the write immediately even if the
    // voice re-score below is slow or fails (never-naked: an operator confirm
    // must never itself become a NEW 30-min stall).
    confirmTaskAudience(id, { audienceId: audienceId ?? null, audienceLabel, changed });

    // Re-run the blend with the confirmed audience so the VOICE decision
    // (audience persona / collapse / blend_directive) actually reflects it.
    const dept = canonicalDeptSlug(task.department || task.workspace_id || '') || 'general';
    const taskDescription = `${task.title}${task.description ? `. ${task.description}` : ''}`.trim();
    const { rescored } = await rescoreAudienceBlend(id, taskDescription, dept, audienceLabel);

    const updated = queryOne<Task>(
      `SELECT t.*,
          aa.name as assigned_agent_name,
          aa.avatar_emoji as assigned_agent_emoji,
          ca.name as created_by_agent_name,
          ca.avatar_emoji as created_by_agent_emoji
         FROM tasks t
         LEFT JOIN agents aa ON t.assigned_agent_id = aa.id
         LEFT JOIN agents ca ON t.created_by_agent_id = ca.id
        WHERE t.id = ?`,
      [id],
    );

    return NextResponse.json({ success: true, changed, rescored, task: updated }, { status: 200 });
  } catch (error) {
    console.error('[audience] Failed to confirm task audience:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
