/**
 * Shared task-creation core.
 *
 * The canonical "write a task onto the board" path used by BOTH:
 *   - the operator UI create route (POST /api/tasks), and
 *   - the universal task-ingest endpoint (POST /api/tasks/ingest).
 *
 * Extracting it here guarantees the two front doors can't drift: same INSERT,
 * same `task_created` event, same SOP auto-suggest, same persona selection,
 * same SSE broadcast, and the same outbound `task-created` webhook notify that
 * tells the OpenClaw COM/CEO agent a task is now on the board.
 *
 * IMPORTANT (ingest safety): `assigned_agent_id` / `created_by_agent_id` are
 * FK columns into `agents` and are validated as `.uuid()` by CreateTaskSchema.
 * An external OpenClaw payload cannot carry a Command Center agent UUID, so the
 * ingest endpoint MUST leave both NULL — never pass a raw external id here.
 */

import { v4 as uuidv4 } from 'uuid';
import { queryOne, run } from '@/lib/db';
import { broadcast } from '@/lib/events';
import { selectPersonaForTask } from '@/lib/persona-selector';
import { getBestSOPForTask } from '@/lib/sops';
import { routeTask } from '@/lib/routing/department-router';
import { canonicalDeptSlug } from '@/lib/routing/canonical-slug';
import type { Task, TaskPriority, Agent } from '@/lib/types';

export interface CreateTaskCoreInput {
  title: string;
  description?: string | null;
  status?: string;
  priority?: TaskPriority;
  assigned_agent_id?: string | null;
  created_by_agent_id?: string | null;
  business_id?: string | null;
  workspace_id?: string | null;
  department?: string | null;
  due_date?: string | null;
  sop_id?: string | null;
  /**
   * Free-text message stored on the `task_created` event row. When omitted a
   * default is composed. The ingest endpoint embeds its idempotency key here so
   * a retry/backfill can dedupe without a schema change.
   */
  eventMessage?: string;
}

export interface CreateTaskCoreOptions {
  /**
   * Fire the outbound `/api/webhooks/task-created` notify to the OpenClaw
   * gateway. Defaults to true so ingested tasks announce themselves exactly
   * like UI-created ones. The base URL is derived from `origin` (falling back
   * to NEXT_PUBLIC_APP_URL / localhost:4000).
   */
  notifyGateway?: boolean;
  /** Request origin used to build the absolute webhook URL. */
  origin?: string | null;
}

/**
 * Insert a task, log the creation event, run persona selection (non-fatal),
 * broadcast over SSE, and (optionally) notify the OpenClaw gateway. Returns the
 * fully-joined task row.
 */
export async function createTaskCore(
  input: CreateTaskCoreInput,
  options: CreateTaskCoreOptions = {}
): Promise<Task | undefined> {
  const id = uuidv4();
  const now = new Date().toISOString();

  // Derive workspace_id from the canonical department slug when not explicitly
  // supplied, instead of falling back to 'default' (which has no row in the
  // workspaces table and causes a FK crash).  The canonical department slug IS
  // the workspace id by convention (seed-workspaces + add-department.sh both
  // use the slug as the workspace primary key).  If neither is available, we
  // leave workspace_id NULL rather than inserting a nonexistent 'default' row.
  let workspaceId: string | null = input.workspace_id || null;
  if (!workspaceId && input.department) {
    const canon = canonicalDeptSlug(input.department);
    if (canon) {
      // Verify the workspace exists before stamping it
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { getDb } = require('@/lib/db');
        const db = getDb();
        const ws = db.prepare('SELECT id FROM workspaces WHERE id = ? OR slug = ?').get(canon, canon) as { id: string } | undefined;
        if (ws) workspaceId = ws.id;
      } catch {
        // non-fatal — leave workspaceId null
      }
    }
  }
  const status = input.status || 'backlog';

  // Auto-suggest SOP if none provided. Scored by department + keyword overlap;
  // anything below 0.5 leaves sop_id NULL so the operator picks manually.
  let sopId: string | null = input.sop_id ?? null;
  if (!sopId) {
    try {
      const best = getBestSOPForTask({
        title: input.title,
        description: input.description ?? undefined,
        department: input.department ?? undefined,
        workspace_id: workspaceId,
      });
      if (best) sopId = best.id;
    } catch (err) {
      console.warn('[createTaskCore] SOP auto-suggest failed (non-fatal):', err);
    }
  }

  run(
    `INSERT INTO tasks (id, title, description, status, priority, assigned_agent_id, created_by_agent_id, workspace_id, business_id, department, due_date, sop_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.title,
      input.description || null,
      status,
      input.priority || 'medium',
      input.assigned_agent_id || null,
      input.created_by_agent_id || null,
      workspaceId,   // NULL when no valid workspace found — avoids FK crash on 'default'
      input.business_id || null,
      input.department ? canonicalDeptSlug(input.department) : null,
      input.due_date || null,
      sopId,
      now,
      now,
    ]
  );

  // --- INSTANT IN-PROCESS ROUTING (B4 / B8) ---
  // If no agent was explicitly assigned (UI quick-add, or any inbound
  // Telegram/Discord/Slack task via /api/tasks/ingest which always lands
  // unassigned), route by CONTENT the moment the task is created instead of
  // dumping it unassigned in the CEO/workspace backlog.
  //
  // routeTask() is a synchronous in-process DB function (no HTTP hop, no
  // gateway round-trip), so this adds no latency and supersedes the broken
  // `/api/webhooks/task-created` HTTP-to-gateway notify (which targeted a WS
  // URL with an HTTP shape and silently no-op'd).
  //
  // Safe-fallback chain (all inside comDispatch): explicit department tag →
  // keyword score → least-loaded role-fit agent → least-loaded master/CEO
  // agent. If routeTask returns null (no agents seeded yet), we leave the task
  // unassigned in backlog — the correct human-review fallback, identical to the
  // prior ingest behavior. The CEO is thus a dispatcher, not a dumping ground:
  // a task only stays on the CEO when it genuinely scores to a master agent.
  let resolvedAgentId: string | null = input.assigned_agent_id || null;
  let routedDepartment: string | null = input.department || null;
  let routedReason: string | null = null;
  if (!resolvedAgentId) {
    try {
      // Pass workspace_id: null so routeTask considers agents across ALL
      // departments, not just the workspace the task happened to land in. This
      // is what lets a CEO/default-landed inbound task get delegated DOWN to
      // the right department (B8) instead of staying stuck on the CEO. The
      // winning department is stamped back onto the task below.
      const routing = routeTask({
        title: input.title,
        description: input.description ?? '',
        priority: (input.priority as TaskPriority) || 'medium',
        workspace_id: null,
        department: input.department ?? undefined,
      });
      if (routing) {
        resolvedAgentId = routing.agentId;
        routedDepartment = routing.department || routedDepartment;
        routedReason = routing.reason;
        run(
          `UPDATE tasks SET assigned_agent_id = ?, department = ?, updated_at = ? WHERE id = ?`,
          [resolvedAgentId, routedDepartment, now, id]
        );
        // Surface the routing decision so an operator can see why a task moved
        // (comDispatch already produces a human-readable reason string).
        run(
          `INSERT INTO events (id, type, agent_id, task_id, message, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [uuidv4(), 'task_dispatched', resolvedAgentId, id, `Auto-routed: ${routedReason}`, now]
        );
      }
    } catch (routeErr) {
      // Never fail task creation on a routing error — the task simply stays
      // unassigned in backlog for manual triage.
      console.warn('[createTaskCore] In-process routing failed (non-fatal):', routeErr);
    }
  }
  // --- END INSTANT ROUTING ---

  // Log event. Caller may supply an explicit message (the ingest path embeds
  // its idempotency/provenance marker here).
  let eventMessage = input.eventMessage ?? `New task: ${input.title}`;
  if (!input.eventMessage && input.created_by_agent_id) {
    const creator = queryOne<Agent>('SELECT name FROM agents WHERE id = ?', [input.created_by_agent_id]);
    if (creator) {
      eventMessage = `${creator.name} created task: ${input.title}`;
    }
  }

  run(
    `INSERT INTO events (id, type, agent_id, task_id, message, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [uuidv4(), 'task_created', input.created_by_agent_id || null, id, eventMessage, now]
  );

  // Persona selection (Hop 10): non-blocking. Task creation must still succeed
  // if the selector can't run. Skips known sentinel/fallback IDs that come out
  // of an unpatched selector on a stale install.
  try {
    const taskDescription =
      `${input.title}${input.description ? `. ${input.description}` : ''}`.trim();
    const departmentForSelector = workspaceId || 'general';

    const persona = await selectPersonaForTask(id, taskDescription, departmentForSelector);

    const SENTINEL_IDS = new Set([
      'schemaVersion',
      'created',
      'domainTags',
      'perspectiveTags',
      'personas',
    ]);

    if (
      persona &&
      persona.persona_id &&
      !SENTINEL_IDS.has(persona.persona_id) &&
      !persona.no_persona_required
    ) {
      const personaSelectedAt = new Date().toISOString();
      run(
        `UPDATE tasks
            SET persona_id = ?,
                persona_name = ?,
                persona_mode = ?,
                persona_score = ?,
                persona_version = ?,
                persona_selected_at = ?
          WHERE id = ?`,
        [
          persona.persona_id,
          persona.persona_name,
          persona.interaction_mode,
          persona.score ?? null,
          persona.persona_version ?? 1,
          personaSelectedAt,
          id,
        ]
      );
    }
  } catch (personaError) {
    // Never fail task creation on persona-selector errors.
    console.error(`[createTaskCore] Persona selection threw for task ${id}:`, personaError);
  }

  // Fetch created task with all joined fields.
  const task = queryOne<Task>(
    `SELECT t.*,
      aa.name as assigned_agent_name,
      aa.avatar_emoji as assigned_agent_emoji,
      ca.name as created_by_agent_name,
      ca.avatar_emoji as created_by_agent_emoji
     FROM tasks t
     LEFT JOIN agents aa ON t.assigned_agent_id = aa.id
     LEFT JOIN agents ca ON t.created_by_agent_id = ca.id
     WHERE t.id = ?`,
    [id]
  );

  // Broadcast task creation via SSE (live-updates the board with no UI change).
  if (task) {
    broadcast({
      type: 'task_created',
      payload: task,
    });
  }

  // Notify the OpenClaw gateway asynchronously — don't block.
  // NOTE (B4): routing now happens IN-PROCESS above via routeTask(), so this
  // outbound notify is no longer the routing mechanism (the old
  // /api/webhooks/task-created HTTP-to-WS-gateway call was a silent no-op). It
  // is retained only as a best-effort "a task exists" announcement and is fully
  // non-fatal; routing does not depend on it.
  if (task && options.notifyGateway !== false) {
    const origin =
      options.origin || process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:4000';
    const webhookUrl = `${origin}/api/webhooks/task-created`;
    (async () => {
      try {
        const webhookResponse = await fetch(webhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            taskId: task.id,
            title: task.title,
            description: task.description,
            department: task.department,
            priority: task.priority,
            workspaceId: task.workspace_id,
          }),
        });
        if (!webhookResponse.ok) {
          console.error('[createTaskCore] Webhook notification failed:', await webhookResponse.text());
        }
      } catch (webhookError) {
        // Log but never fail the task creation.
        console.error('[createTaskCore] Failed to trigger webhook:', webhookError);
      }
    })();
  }

  return task;
}
