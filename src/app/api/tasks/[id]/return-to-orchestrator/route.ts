/**
 * POST /api/tasks/[id]/return-to-orchestrator
 *
 * Worker handback endpoint (N36 / SOP-01-Blocked-vs-Return).
 *
 * This is the CORRECT path for worker agents that cannot complete a task.
 * Workers NEVER set status=blocked directly -- they call this endpoint instead.
 *
 * The endpoint:
 *   1. Validates the structured handback schema.
 *   2. Writes a task_returned event to the events table (audit trail).
 *   3. Sets task status = 'backlog' so the ceo-delegation-sweep picks it up.
 *   4. Increments qc_reroute_attempts.
 *   5. If qc_reroute_attempts >= cap (default 3), flags the task for operator
 *      escalation instead of re-routing (broadcasts task_escalated event).
 *   6. Bumps last_progress_at (stale sweep reads this).
 *   7. Broadcasts task_updated so the board card moves visibly.
 *
 * The ceo-delegation-sweep picks up the backlog task, reads the
 * stored handback note in description, runs routeTask(), and re-assigns
 * or drops to Backlog with an escalation.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { queryOne, run } from '@/lib/db';
import { broadcast } from '@/lib/events';
import { v4 as uuidv4 } from 'uuid';
import type { Task } from '@/lib/types';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const MAX_REROUTES = parseInt(process.env.QC_MAX_REROUTES || '3', 10);

const HandbackSchema = z.object({
  /** One concise line describing exactly what failed. */
  problem: z.string().min(1).max(2000),
  /** Brief summary of approaches the worker tried. */
  what_i_tried: z.string().min(1).max(2000),
  /** Diagnosis: what the right department or resource would be. */
  what_i_think_it_needs: z.string().min(1).max(2000),
  /** Optional routing hint for the orchestrator's re-router. */
  suggested_department: z.string().max(100).optional().nullable(),
  /** Agent id of the returning worker (for audit trail). */
  returned_by_agent_id: z.string().uuid().optional().nullable(),
});

export type HandbackInput = z.infer<typeof HandbackSchema>;

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const body = await request.json();

    const validation = HandbackSchema.safeParse(body);
    if (!validation.success) {
      return NextResponse.json(
        {
          error: 'Invalid handback schema',
          details: validation.error.issues,
          hint: 'Required fields: problem (string), what_i_tried (string), what_i_think_it_needs (string). Optional: suggested_department (string|null), returned_by_agent_id (uuid|null).',
        },
        { status: 400 },
      );
    }

    const data = validation.data;

    const existing = queryOne<Task & { qc_reroute_attempts?: number | null }>(
      'SELECT * FROM tasks WHERE id = ?',
      [id],
    );
    if (!existing) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }

    const now = new Date().toISOString();
    const currentAttempts = existing.qc_reroute_attempts ?? 0;
    const newAttempts = currentAttempts + 1;
    const hitCap = newAttempts >= MAX_REROUTES;

    // Build the handback note that goes into the task description so the
    // ceo-delegation-sweep can read the diagnosis without a separate table.
    const handbackNote = [
      `[HANDBACK #${newAttempts}/${MAX_REROUTES}] ${now}`,
      `Problem: ${data.problem}`,
      `Tried: ${data.what_i_tried}`,
      `Needs: ${data.what_i_think_it_needs}`,
      data.suggested_department ? `Suggested dept: ${data.suggested_department}` : null,
    ]
      .filter(Boolean)
      .join('\n');

    // Prepend the handback note to the description (preserve existing description).
    const updatedDescription = existing.description
      ? `${handbackNote}\n\n---\n\n${existing.description}`
      : handbackNote;

    // Update the task: set status=backlog, increment attempt counter, bump progress.
    run(
      `UPDATE tasks SET
        status = 'backlog',
        description = ?,
        qc_reroute_attempts = ?,
        last_progress_at = ?,
        updated_at = ?
       WHERE id = ?`,
      [updatedDescription, newAttempts, now, now, id],
    );

    // Write the task_returned event (audit trail).
    run(
      `INSERT INTO events (id, type, agent_id, task_id, message, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        uuidv4(),
        'task_returned',
        data.returned_by_agent_id ?? null,
        id,
        hitCap
          ? `[RETURN-CAP] Attempt ${newAttempts}/${MAX_REROUTES} -- escalating to operator. Problem: ${data.problem}`
          : `[RETURN #${newAttempts}/${MAX_REROUTES}] ${data.problem}${data.suggested_department ? ` -- suggests: ${data.suggested_department}` : ''}`,
        now,
      ],
    );

    if (hitCap) {
      // Cap reached: also write a task_escalated event so the operator gets notified.
      // The ceo-delegation-sweep reads qc_reroute_attempts >= cap and escalates
      // via Rescue Rangers webhook rather than re-routing.
      run(
        `INSERT INTO events (id, type, agent_id, task_id, message, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          uuidv4(),
          'task_escalated',
          null,
          id,
          `[ESCALATE] Task "${existing.title}" has been returned ${newAttempts} times with no resolution. Operator review required. Last problem: ${data.problem}`,
          now,
        ],
      );
    }

    // Broadcast so the board card moves visibly.
    const updated = queryOne<Task>(
      `SELECT t.*,
        aa.name as assigned_agent_name,
        aa.avatar_emoji as assigned_agent_emoji
       FROM tasks t
       LEFT JOIN agents aa ON t.assigned_agent_id = aa.id
       WHERE t.id = ?`,
      [id],
    );
    if (updated) {
      broadcast({ type: 'task_updated', payload: updated });
    }

    return NextResponse.json({
      ok: true,
      task_id: id,
      status: 'backlog',
      reroute_attempts: newAttempts,
      cap_reached: hitCap,
      message: hitCap
        ? `Return cap reached (${newAttempts}/${MAX_REROUTES}). Task flagged for operator escalation.`
        : `Task returned to orchestrator (attempt ${newAttempts}/${MAX_REROUTES}). The ceo-delegation-sweep will re-route it.`,
    });
  } catch (error) {
    console.error('[return-to-orchestrator] Error:', error);
    return NextResponse.json({ error: 'Internal error processing handback' }, { status: 500 });
  }
}
