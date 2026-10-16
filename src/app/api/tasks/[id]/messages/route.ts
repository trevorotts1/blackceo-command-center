import { NextRequest, NextResponse } from 'next/server';
import { execFileSync } from 'child_process';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { queryOne, queryAll, run, getDb, transaction } from '@/lib/db';
import { broadcast } from '@/lib/events';
import { getOpenClawClient } from '@/lib/openclaw/client';
import { resolveActiveCompanyId } from '@/lib/company';
import { tenantTaskWhere } from '@/lib/presentation-tenant-scope';
import { resolveTenantContext, TenantAccessError } from '@/lib/auth/tenant-context';
import { CEO_CHAT_CHANNEL } from '@/lib/ceo-chat/config';
import type { HqProducerEvent } from '@/lib/hq/types';
import {
  findActiveExecutionForTask,
  buildOwnerUpdateMessage,
} from '@/lib/task-kill';
import type { Task, ActivityType, TaskActivity } from '@/lib/types';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

interface RouteParams {
  params: Promise<{ id: string }>;
}

/* ==================================================================== *
 * HQ owner-note capture (SPEC S5 "Owner task note" row; plan B16)
 *
 *   Owner task note | Existing task message/activity writer
 *                   | Only text already allowed to the same task audience.
 *
 * This route IS that existing writer, so it is the capture point. It writes
 * the note to `task_activities` exactly as before and then hands the EXISTING
 * record to `appendHqActivity` — the only writer of Headquarters activity
 * (SPEC S5) — inside the SAME transaction, so the append joins the source
 * transaction through that helper's own savepoint.
 *
 * Exactly once, from the existing record: every value in the envelope is
 * derived from the source row (`activity:<row id>` source key, the row's own
 * UUID as `eventId`, its `created_at` as `issuedAt`/`occurredAt`). SPEC S5:
 * "Mint eventId and issuedAt once with the first durable source envelope and
 * reuse exact semantic bytes across all retries/backfill. Do not assign fresh
 * eventId/issuedAt while replaying same source key." Deriving them means a
 * replay is byte-identical by construction — no second table, no second write
 * path, and a duplicate therefore collapses on `UNIQUE(company_id,source_key)`.
 * ==================================================================== */

/** SPEC S5 source key for a task activity: `activity:<existingId>`. */
function ownerNoteSourceKey(activityId: string): string {
  return `activity:${activityId}`;
}

/** The `{companyId, installationId, event}` triple `appendHqActivity` accepts. */
type HqActivityAppendInput = {
  companyId: string;
  installationId: string;
  event: HqProducerEvent;
};
type HqActivityAppender = (db: unknown, input: HqActivityAppendInput) => unknown;

/**
 * Test seam. The production path below resolves the real
 * `@/lib/hq/activity` module; this hook exists only so a focused unit test can
 * stand in for it while that module is still owned by another in-flight build
 * unit (B05). It is never a product fallback: nothing sets it outside tests.
 */
type HqSeamHost = { __ccHqActivityAppenderForTests?: HqActivityAppender };

function hqActivityAppender(): HqActivityAppender | null {
  const seam = (globalThis as HqSeamHost).__ccHqActivityAppenderForTests;
  if (typeof seam === 'function') return seam;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('@/lib/hq/activity') as { appendHqActivity?: HqActivityAppender };
    return typeof mod.appendHqActivity === 'function' ? mod.appendHqActivity : null;
  } catch {
    return null;
  }
}

/**
 * Capture one owner note. Returns a bounded diagnostic string, never throws:
 * SPEC S5 requires that a telemetry failure "does not roll back
 * already-authorized business work".
 */
function captureOwnerNote(input: {
  activityId: string;
  taskId: string;
  text: string;
  occurredAt: string;
  companyId: string;
  installationId: string;
}): string | null {
  const appender = hqActivityAppender();
  if (!appender) {
    // The append helper is not installed in this build. The note is recorded
    // and the business write stands; capture health is reported honestly
    // instead of silently claiming completeness (SPEC S5).
    console.warn('[messages:capture] hq activity append helper unavailable; owner note not captured');
    return 'capture_helper_unavailable';
  }
  const event: HqProducerEvent = {
    eventId: input.activityId,
    sourceKey: ownerNoteSourceKey(input.activityId),
    installationId: input.installationId,
    companyId: input.companyId,
    issuedAt: input.occurredAt,
    occurredAt: input.occurredAt,
    taskId: input.taskId,
    actorRuntimeId: null,
    recipientRuntimeId: null,
    fromWorkspaceId: null,
    toWorkspaceId: null,
    exchangeId: null,
    kind: 'owner_note',
    phase: 'recorded',
    payload: { text: input.text },
  };
  try {
    const result = appender(getDb(), {
      companyId: input.companyId,
      installationId: input.installationId,
      event,
    }) as { status?: string } | undefined;
    // Everything except `appended`/`duplicate` is a real capture-health event.
    return result && (result.status === 'appended' || result.status === 'duplicate')
      ? null
      : `capture_${result?.status ?? 'unknown'}`;
  } catch (err) {
    return `capture_failed:${(err as Error).message ?? 'unknown'}`;
  }
}

/**
 * SPEC S9: Headquarters' private head conversation uses its own explicit
 * requester channel, and SPEC S5 excludes the private head chat from
 * company-wide activity: "Private head chat | S9 transcript | Excluded from
 * company-wide activity. Optional public task outcome uses task's existing
 * permissions, not chat text." SPEC S7: "Private chat content/turn IDs are
 * never emitted on the company-wide bus." The existing private owner
 * conversation (`ceo-chat`) is the same class of surface, so a note on a task
 * from either channel stays on the task and is never copied into the company
 * feed or the company-wide event bus.
 */
const HQ_PRIVATE_CHAT_CHANNEL = 'hq-chat';
const PRIVATE_REQUESTER_CHANNELS: ReadonlySet<string> = new Set([
  HQ_PRIVATE_CHAT_CHANNEL,
  CEO_CHAT_CHANNEL,
]);

function isPrivateConversationTask(requesterChannel: string | null | undefined): boolean {
  return typeof requesterChannel === 'string' && PRIVATE_REQUESTER_CHANNELS.has(requesterChannel.trim());
}

/** B16 freezes the owner-note bound left open by interfaces.md gap G-11: 8,000 characters, never truncated. */
const OWNER_NOTE_MAX_CHARS = 8000;

/** Existing repo convention for a retryable write (see `/api/tasks/ingest`). */
const IDEMPOTENCY_HEADER = 'idempotency-key';

/** The note row already recorded for this retry key, if this is a retry. */
function findActivityByRetryKey(taskId: string, retryKey: string): TaskActivity | undefined {
  return queryOne<TaskActivity>(
    `SELECT id, task_id, activity_type, message, metadata, created_at
       FROM task_activities
      WHERE task_id = ?
        AND json_valid(metadata)
        AND json_extract(metadata, '$.idempotency_key') = ?
      ORDER BY created_at ASC
      LIMIT 1`,
    [taskId, retryKey]
  );
}

// GET /api/tasks/[id]/messages — list all messages (task_activities of type 'message')
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params;

    // Company scope: the SAME ownership predicate the ingest front door uses
    // (src/lib/presentation-tenant-scope.ts). A foreign or unknown task is 404,
    // indistinguishable from a wrong id, so this read is not an existence oracle.
    const own = tenantTaskWhere(resolveActiveCompanyId());
    const task = queryOne<{ id: string }>(
      `SELECT t.id FROM tasks t WHERE t.id = ? AND ${own.sql}`,
      [id, ...own.params]
    );
    if (!task) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }

    const messages = queryAll<{
      id: string;
      task_id: string;
      activity_type: string;
      message: string;
      metadata: string | null;
      created_at: string;
    }>(
      `SELECT id, task_id, activity_type, message, metadata, created_at
       FROM task_activities
       WHERE task_id = ? AND activity_type IN ('message', 'owner_message', 'agent_message')
       ORDER BY created_at ASC`,
      [id]
    );

    return NextResponse.json({ messages });
  } catch (error) {
    console.error('[messages:GET]', error);
    return NextResponse.json({ error: 'Failed to fetch messages' }, { status: 500 });
  }
}

// POST /api/tasks/[id]/messages — send a message; runs mid-task mode-switch check
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params;
    const body: { content: string; sender?: 'owner' | 'agent'; system_context?: string } =
      await request.json();

    if (!body.content?.trim()) {
      return NextResponse.json({ error: 'content is required' }, { status: 400 });
    }
    // Bound the note before it can reach the public feed (gap G-11). Oversize is
    // rejected, never truncated — an owner note that was cut in half is not the
    // owner's note.
    if (body.content.trim().length > OWNER_NOTE_MAX_CHARS) {
      return NextResponse.json(
        { error: `content exceeds ${OWNER_NOTE_MAX_CHARS} characters` },
        { status: 413 }
      );
    }

    // ── Trusted identity and company scope ──────────────────────────────────
    // Verified installation for this request host; a failure here is an access
    // failure, not a task failure.
    let installationId: string;
    try {
      installationId = (await resolveTenantContext(request)).installationId;
    } catch (err) {
      if (err instanceof TenantAccessError) {
        return NextResponse.json({ error: 'Verified tenant identity required' }, { status: 403 });
      }
      throw err;
    }

    const activeCompanyId = resolveActiveCompanyId();
    const own = tenantTaskWhere(activeCompanyId);

    const currentTask = queryOne<Task & {
      persona_id: string | null;
      persona_name: string | null;
      persona_mode: string | null;
      persona_score: number | null;
      department_id: string | null;
      requester_channel: string | null;
      workspace_company_id: string | null;
    }>(
      `SELECT t.*, w.company_id AS workspace_company_id, a.name as assigned_agent_name
       FROM tasks t
       LEFT JOIN agents a ON t.assigned_agent_id = a.id
       LEFT JOIN workspaces w ON w.id = t.workspace_id
       WHERE t.id = ? AND ${own.sql}`,
      [id, ...own.params]
    );

    if (!currentTask) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }

    // A note on a private conversation's task stays on that task (SPEC S5/S7).
    const isPrivateTask = isPrivateConversationTask(currentTask.requester_channel);
    // The feed entry belongs to the company that owns the task.
    const feedCompanyId = currentTask.workspace_company_id || activeCompanyId || 'default';

    // ── Mid-task mode-switch check ──────────────────────────────────────────
    // If the task is in_progress and already has a persona+mode assigned,
    // check whether the incoming message should trigger a mode switch.
    // The persona does NOT change — only which section of the blueprint governs.
    if (currentTask.status === 'in_progress' && currentTask.persona_id && currentTask.persona_mode) {
      try {
        const openclaw_root =
          process.env.OPENCLAW_ROOT ||
          (process.platform === 'darwin'
            ? `${process.env.HOME}/.openclaw`
            : '/data/.openclaw');

        const scriptPath = path.join(
          openclaw_root,
          'skills',
          '23-ai-workforce-blueprint',
          'scripts',
          'select-persona-for-task.py'
        );

        const switchOutput = execFileSync(
          'python3',
          [
            scriptPath,
            '--mode-switch',
            '--current-persona', currentTask.persona_id,
            '--current-mode',   currentTask.persona_mode,
            '--message',        body.content,
          ],
          { encoding: 'utf-8', timeout: 5000 }
        );

        const switchResult: {
          persona_id: string;
          mode: string;
          mode_switched: boolean;
          blueprint_section: number;
          instruction: string;
          previous_mode: string;
        } = JSON.parse(switchOutput);

        if (switchResult.mode_switched) {
          // Update the task's active mode
          run(
            `UPDATE tasks SET persona_mode = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
            [switchResult.mode, currentTask.id]
          );

          // Log the mode switch in persona_selection_log for Intelligence Settings history.
          //
          // Bug 3 (v4.0.2): refuse to insert when task_id is null/empty/sentinel.
          // Orphan rows ('(no-task-id)' sentinel) trigger the FK breakage in
          // migration 034. This is a non-critical log, so skip + warn rather
          // than throw.
          const taskIdForLog = currentTask.id;
          if (
            taskIdForLog == null ||
            taskIdForLog === '' ||
            taskIdForLog === '(no-task-id)'
          ) {
            console.warn(
              '[persona_selection_log] skipping insert: invalid task_id',
              { taskIdForLog }
            );
          } else {
            run(
              `INSERT INTO persona_selection_log
                 (task_id, persona_id, persona_name, mode, score, layer_scores, department_id, selected_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
              [
                taskIdForLog,
                switchResult.persona_id,
                currentTask.persona_name,
                switchResult.mode,
                currentTask.persona_score,
                JSON.stringify({ mode_switch: true, previous_mode: switchResult.previous_mode }),
                currentTask.department_id,
              ]
            );
          }

          // Prepend mode-switch instruction so the agent knows which blueprint section to use
          body.system_context = switchResult.instruction;
        }
      } catch {
        // Mode switch detection failed silently — do not block message delivery
      }
    }

    // ── Save the message as a task activity, and capture it in the SAME
    // transaction (SPEC S5: "where source write is in the same database, insert
    // within the source transaction using a savepoint") ─────────────────────
    const activityType: ActivityType =
      body.sender === 'agent' ? 'agent_message' : 'owner_message';
    const isOwnerNote = activityType === 'owner_message';

    // Existing repo convention for a retryable write: when the caller supplies
    // an idempotency key, a retry reuses the record already written instead of
    // adding a second one. Two notes with identical text but no key stay two
    // notes — an owner saying the same thing twice did say it twice.
    const retryKey = request.headers.get(IDEMPOTENCY_HEADER)?.trim() || null;

    const outcome = transaction(() => {
      if (retryKey) {
        const existing = findActivityByRetryKey(id, retryKey);
        if (existing) return { activity: existing, duplicate: true, captureHealth: null };
      }

      const activityId = uuidv4();
      const now = new Date().toISOString();
      // Only carry metadata when there is something to carry, so a plain note
      // keeps the exact NULL the route has always written.
      const metadata =
        !body.system_context && !retryKey
          ? null
          : JSON.stringify({
              ...(body.system_context ? { system_context: body.system_context } : {}),
              ...(retryKey ? { idempotency_key: retryKey } : {}),
            });

      run(
        `INSERT INTO task_activities (id, task_id, activity_type, message, metadata, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [activityId, id, activityType, body.content.trim(), metadata, now]
      );

      const activity: TaskActivity = {
        id: activityId,
        task_id: id,
        activity_type: activityType,
        message: body.content.trim(),
        metadata: metadata ?? undefined,
        created_at: now,
      };

      // Capture exactly once, from this record. Agent reports are not owner
      // notes, and a private conversation's note is excluded from the
      // company-wide feed entirely (SPEC S5 capture-boundaries table).
      const captureHealth =
        isOwnerNote && !isPrivateTask
          ? captureOwnerNote({
              activityId,
              taskId: id,
              text: activity.message,
              occurredAt: now,
              companyId: feedCompanyId,
              installationId,
            })
          : null;

      return { activity, duplicate: false, captureHealth };
    });

    const { activity, duplicate } = outcome;

    // A private conversation's note is never emitted on the company-wide bus
    // (SPEC S7). Its own authorized reader polls its private turn endpoint.
    if (!duplicate && !isPrivateTask) {
      broadcast({ type: 'task_message', payload: { task_id: id, activity } });
    }

    if (duplicate) {
      return NextResponse.json({
        activity,
        system_context: null,
        duplicate: true,
        delivered_live: false,
        delivery_target: 'none',
        delivery_error: null,
        note: 'duplicate of an already-recorded note; not re-delivered',
      });
    }

    // CANC-101 (finding 10): the recorded note never reached the agent. After
    // the insert above (unchanged), attempt LIVE delivery of the owner's EXACT
    // note text to the task's running agent session: same active-execution
    // lookup + chat.send primitive as the dispatch route and the archive
    // (cancel) route. Best-effort — insert already committed, delivery failure
    // never fails the POST. NEVER sets killed_at: this route is note-delivery
    // ONLY; only POST /api/tasks/[id]/archive cancels.
    // Owner notes only: an agent_message is the agent's own report — sending
    // it back into its session would be an echo. Owner (default) notes go live.
    let deliveredLive = false;
    let deliveryTarget: 'session' | 'none' = 'none';
    let deliveryError: string | null = null;
    try {
      const live = isOwnerNote ? findActiveExecutionForTask(id) : null;
      if (live) {
        deliveryTarget = 'session';
        try {
          const client = getOpenClawClient();
          if (!client.isConnected()) await client.connect();
          await client.call('chat.send', {
            sessionKey: live.session_key,
            message: buildOwnerUpdateMessage(id, body.content.trim()),
          });
          deliveredLive = true;
        } catch (err) {
          deliveryError = (err as Error).message ?? 'unknown delivery error';
        }
      }
    } catch (err) {
      deliveryError = (err as Error).message ?? 'unknown lookup error';
    }

    const deliveryNote = deliveredLive
      ? 'delivered live to running agent'
      : deliveryError
        ? `note recorded; live delivery FAILED (${deliveryError}) — owner can retry`
        : 'note recorded; no running agent session right now — it will be seen on next turn/dispatch';

    return NextResponse.json({
      activity,
      system_context: body.system_context || null,
      delivered_live: deliveredLive,
      delivery_target: deliveryTarget,
      delivery_error: deliveryError,
      capture_health: outcome.captureHealth,
      note: deliveryNote,
    });
  } catch (error) {
    console.error('[messages:POST]', error);
    return NextResponse.json({ error: 'Failed to send message' }, { status: 500 });
  }
}
