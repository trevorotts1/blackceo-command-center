import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { queryOne, run } from '@/lib/db';
import { canonicalDeptSlug } from '@/lib/routing/canonical-slug';
import {
  confirmTaskAudience,
  evaluateAudienceConfirmGate,
  rescoreAudienceBlend,
} from '@/lib/tasks';
import { CLIENT_FINAL_PERSONA_SOURCES } from '@/lib/types';
import type { Task } from '@/lib/types';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * POST /api/tasks/[id]/persona-choice — U064 persona picker write endpoint.
 *
 * Two mutually-exclusive actions:
 *
 *   `reaim`      — changes an input (audience_label, topic_hint) and re-runs
 *                  the blend.  Writes NO client_persona_id.  Governance stays on.
 *                  This is the DEFAULT action; the interface leads with it.
 *
 *   `name-voice` — an express client choice.  Writes client_persona_id +
 *                  persona_source + client_persona_set_at.  Suppresses the blend
 *                  for this task.  NEVER pre-selected.  persona_source is
 *                  validated against CLIENT_FINAL_PERSONA_SOURCES — anything else
 *                  is 400'd because the seam (persona_for_job.py:450) silently
 *                  ignores a non-member value and the blend runs anyway.
 *
 * A task with no task_persona_bundle row returns 409 — there is nothing to
 * override yet (same posture as the audience route).
 */

const ReaimSchema = z.object({
  action: z.literal('reaim'),
  topic_hint: z.string().trim().min(1).optional(),
  audience_label: z.string().trim().min(1).optional(),
});

const NameVoiceSchema = z.object({
  action: z.literal('name-voice'),
  persona_id: z.string().trim().min(1, 'persona_id is required'),
  persona_source: z.string().trim().min(1, 'persona_source is required'),
});

const PersonaChoiceSchema = z.discriminatedUnion('action', [
  ReaimSchema,
  NameVoiceSchema,
]);

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params;

    const task = queryOne<Task>('SELECT * FROM tasks WHERE id = ?', [id]);
    if (!task) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }

    // Verify the task has a bundle row — nothing to override otherwise.
    const bundleRow = queryOne<{ id: string }>(
      'SELECT id FROM task_persona_bundle WHERE task_id = ?',
      [id],
    );
    if (!bundleRow) {
      return NextResponse.json(
        {
          error: 'This task has no persona-blend bundle to override.',
          hint: 'Only content tasks that went through the blend carry a persona-bundle row.',
        },
        { status: 409 },
      );
    }

    let payload: unknown;
    try {
      payload = await request.json();
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    const validation = PersonaChoiceSchema.safeParse(payload);
    if (!validation.success) {
      return NextResponse.json(
        {
          error: 'Validation failed',
          details: validation.error.issues,
          hint: 'action must be "reaim" or "name-voice".  reaim: optional topic_hint, audience_label.  name-voice: required persona_id + persona_source.',
        },
        { status: 400 },
      );
    }

    const msg = validation.data;

    if (msg.action === 'reaim') {
      // ── re-aim: change an input, re-run the blend ──────────────────────
      // Writes NO client persona id.  Governance stays on.

      if (msg.audience_label) {
        const gateBefore = evaluateAudienceConfirmGate(id);
        if (gateBefore.state !== 'no_bundle') {
          const priorLabel = task.audience_label ?? null;
          const changed =
            Boolean(priorLabel) && priorLabel!.trim().toLowerCase() !== msg.audience_label.trim().toLowerCase();

          confirmTaskAudience(id, {
            audienceId: null,
            audienceLabel: msg.audience_label,
            changed,
          });
        }
      }

      const dept = canonicalDeptSlug(task.department || task.workspace_id || '') || 'general';
      const taskDescription = `${task.title}${task.description ? `. ${task.description}` : ''}`.trim();
      const audienceLabel = msg.audience_label || task.audience_label || '';
      const { rescored } = await rescoreAudienceBlend(id, taskDescription, dept, audienceLabel);

      return NextResponse.json({ success: true, rescored }, { status: 200 });
    }

    // ── name-voice: express client choice ──────────────────────────────

    // Validate persona_source against the seam's closed vocabulary.
    const validSources: ReadonlyArray<string> = CLIENT_FINAL_PERSONA_SOURCES as unknown as ReadonlyArray<string>;
    const validSet: Set<string> = new Set(validSources);
    if (!validSet.has(msg.persona_source)) {
      return NextResponse.json(
        {
          error: `Invalid persona_source "${msg.persona_source}".`,
          hint: `Must be one of: ${validSources.slice().sort().join(', ')}.`,
        },
        { status: 400 },
      );
    }

    const now = new Date().toISOString();

    // Write the three client-choice columns.
    run(
      `UPDATE task_persona_bundle
         SET client_persona_id = ?,
             client_persona_source = ?,
             client_persona_set_at = ?
       WHERE task_id = ?`,
      [msg.persona_id, msg.persona_source, now, id],
    );

    // Idempotent activity row — no duplicate for the same persona_id + source.
    const existingActivity = queryOne<{ id: string }>(
      `SELECT id FROM task_activities
        WHERE task_id = ?
          AND activity_type = 'persona_choice'
          AND json_extract(metadata, '$.persona_id') = ?
          AND json_extract(metadata, '$.persona_source') = ?
       LIMIT 1`,
      [id, msg.persona_id, msg.persona_source],
    );
    if (!existingActivity) {
      const activityMeta = JSON.stringify({
        action: 'name-voice',
        persona_id: msg.persona_id,
        persona_source: msg.persona_source,
      });
      run(
        `INSERT INTO task_activities (task_id, activity_type, message, metadata, created_at)
         VALUES (?, 'persona_choice', ?, ?, ?)`,
        [id, `Operator named voice persona "${msg.persona_id}" (source: ${msg.persona_source})`, activityMeta, now],
      );
    }

    return NextResponse.json(
      {
        success: true,
        blend_suppressed: true,
        persona_id: msg.persona_id,
        persona_source: msg.persona_source,
      },
      { status: 200 },
    );
  } catch (error) {
    console.error('[persona-choice] Failed to process persona choice:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
