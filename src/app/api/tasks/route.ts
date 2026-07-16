import { NextRequest, NextResponse } from 'next/server';
import { queryAll, queryOne } from '@/lib/db';
import { CreateTaskSchema } from '@/lib/validation';
import { createTaskCore } from '@/lib/tasks';
import { loadSubtaskPersonas, loadPersonaBundleScopes } from '@/lib/persona-selector';
import { getOpenPersonaMismatch } from '@/lib/persona-mismatch';
import { getOpenDispatchHold } from '@/lib/dispatch-hold';
import { getQcHeuristicPark } from '@/lib/qc-promote';
import type { Task, CreateTaskRequest } from '@/lib/types';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// P4-02 step 5 — does this box carry the persona-blend bundle table (migration
// 090)? Cached: schema presence is stable per process, and a pre-090 box must
// not have its board fetch break on a JOIN to a missing table.
let _bundleTablePresent: boolean | null = null;
function bundleTableExists(): boolean {
  if (_bundleTablePresent !== null) return _bundleTablePresent;
  try {
    const row = queryOne<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='task_persona_bundle'",
      [],
    );
    _bundleTablePresent = !!row;
  } catch {
    _bundleTablePresent = false;
  }
  return _bundleTablePresent;
}

// A-U5 — does this box carry the scoped-bundle table (migration 104)? Same
// cached table-existence guard pattern as bundleTableExists() above, so a
// pre-104 box's board fetch never breaks attaching persona_bundle_scopes.
let _scopeTablePresent: boolean | null = null;
function scopeTableExists(): boolean {
  if (_scopeTablePresent !== null) return _scopeTablePresent;
  try {
    const row = queryOne<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='task_persona_bundle_scope'",
      [],
    );
    _scopeTablePresent = !!row;
  } catch {
    _scopeTablePresent = false;
  }
  return _scopeTablePresent;
}

// GET /api/tasks - List all tasks with optional filters
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const status = searchParams.get('status');
    const businessId = searchParams.get('business_id');
    const workspaceId = searchParams.get('workspace_id');
    const assignedAgentId = searchParams.get('assigned_agent_id');
    const department = searchParams.get('department');
    const departmentId = searchParams.get('department_id');
    const campaignId = searchParams.get('campaign_id');
    // Board default: HIDE soft-archived tasks. `archived_at` is stamped by the
    // weekly Done-clear job and the manual archive path (migration 058); it is
    // the canonical "this card is off the board" marker. Every board consumer
    // (main queue, all-tasks, workspace/department/campaign boards, analytics)
    // reads this route, so filtering here hides archived cards everywhere in one
    // place. ESCAPE HATCH: `?includeArchived=true` skips the filter so archived
    // tasks stay fully retrievable (audit, restore) — they are hidden, not gone.
    const includeArchived = searchParams.get('includeArchived') === 'true';

    // P4-02 step 5 — surface the persona-blend audience-confirm state onto each
    // board row so the card can flag 'pending' (awaiting audience confirm). Only
    // joined when the table exists (pre-090 boxes get a NULL literal instead).
    const hasBundle = bundleTableExists();
    const blendConfirmSelect = hasBundle
      ? 'tpb.confirm_state as blend_confirm_state'
      : 'NULL as blend_confirm_state';
    const blendConfirmJoin = hasBundle
      ? 'LEFT JOIN task_persona_bundle tpb ON tpb.task_id = t.id'
      : '';

    let sql = `
      SELECT
        t.*,
        t.workspace_id as department_id,
        aa.name as assigned_agent_name,
        aa.avatar_emoji as assigned_agent_emoji,
        ca.name as created_by_agent_name,
        mr.label as model_label,
        mr.provider as model_provider,
        mr.input_cost_per_million as model_input_cost_per_million,
        mr.output_cost_per_million as model_output_cost_per_million,
        ${blendConfirmSelect}
      FROM tasks t
      LEFT JOIN agents aa ON t.assigned_agent_id = aa.id
      LEFT JOIN agents ca ON t.created_by_agent_id = ca.id
      LEFT JOIN model_registry mr ON t.model_id = mr.model_id
      ${blendConfirmJoin}
      WHERE 1=1
    `;
    const params: unknown[] = [];

    // Default board fetch hides soft-archived tasks; ?includeArchived=true opts in.
    if (!includeArchived) {
      sql += ' AND t.archived_at IS NULL';
    }

    if (status) {
      // Support comma-separated status values (e.g., status=inbox,testing,in_progress)
      const statuses = status.split(',').map(s => s.trim()).filter(Boolean);
      if (statuses.length === 1) {
        sql += ' AND t.status = ?';
        params.push(statuses[0]);
      } else if (statuses.length > 1) {
        sql += ` AND t.status IN (${statuses.map(() => '?').join(',')})`;
        params.push(...statuses);
      }
    }
    if (businessId) {
      sql += ' AND t.business_id = ?';
      params.push(businessId);
    }
    if (workspaceId) {
      sql += ' AND t.workspace_id = ?';
      params.push(workspaceId);
    }
    if (assignedAgentId) {
      sql += ' AND t.assigned_agent_id = ?';
      params.push(assignedAgentId);
    }
    if (department) {
      sql += ' AND t.department = ?';
      params.push(department);
    }
    if (departmentId) {
      // department_id maps to workspace_id (workspaces = departments)
      sql += ' AND t.workspace_id = ?';
      params.push(departmentId);
    }
    if (campaignId) {
      // Campaign board (/campaigns/[id]) filters tasks to one campaign. The
      // tasks.campaign_id column exists (migration 017) but was never wired as
      // a query filter, so the board previously received EVERY task. (B7)
      sql += ' AND t.campaign_id = ?';
      params.push(campaignId);
    }

    sql += ' ORDER BY t.created_at DESC';

    const tasks = queryAll<Task & { assigned_agent_name?: string; assigned_agent_emoji?: string; created_by_agent_name?: string }>(sql, params);

    // Transform to include nested agent info.
    // ROBUST null-name guard (AF-TASKBOARD-NULLNAME): only emit the nested
    // assigned_agent object when BOTH the id AND a non-empty name are present.
    // A LEFT JOIN can return an agent_id whose joined agent row was deleted /
    // has a NULL name, which previously produced a truthy { name: null } object.
    // Every board consumer (MissionQueue avatar `.name.charAt`, the agent pill,
    // DepartmentBrowser, the dept focus view, TaskModal) gates on
    // `task.assigned_agent ?` being truthy, so a null-name object slipped past
    // the gate and crashed the client with "Cannot read properties of null
    // (reading 'charAt')". Returning `undefined` here eliminates the crash at
    // the source for ALL consumers. Component-level guards remain as
    // belt-and-suspenders.
    const transformedTasks = tasks.map((task) => ({
      ...task,
      assigned_agent:
        task.assigned_agent_id && task.assigned_agent_name
          ? {
              id: task.assigned_agent_id,
              name: task.assigned_agent_name,
              avatar_emoji: task.assigned_agent_emoji,
            }
          : undefined,
      // DEP-5 / F3.7 — attach the multi-persona plan rows so the kanban card can
      // render slot chips on reload (SSE carries them live at selection time).
      // loadSubtaskPersonas is tolerant: [] on a single-persona task or a
      // pre-migration-088 box, so this never breaks the board.
      subtask_personas: loadSubtaskPersonas(task.id),
      // A-U5 — attach the per-page/scoped persona-blend rows (migration 104)
      // behind the same table-existence guard as bundleTableExists() above;
      // loadPersonaBundleScopes is itself tolerant, so this is belt-and-
      // suspenders — [] on a pre-104 box or a task with no scoped bundles.
      persona_bundle_scopes: scopeTableExists() ? loadPersonaBundleScopes(task.id) : [],
      // B-U6 / U20 — declared-vs-used comparator. Only a task with a resolved
      // voice_persona_id can ever mismatch (a bundle-less task never blended),
      // so short-circuit the per-row events lookup for every other card.
      // getOpenPersonaMismatch is fail-soft: never breaks the board.
      persona_mismatch: task.voice_persona_id ? getOpenPersonaMismatch(task.id) : null,
      // U37 (C-06) — S2 class-b visibility: the "routed but not runnable" hold
      // (task-dispatcher.ts RESOLVER-DISPATCH gate) surfaced onto the card.
      // No status/type guard needed (unlike persona_mismatch, which only ever
      // applies to a blended task) — any card can be routed to an agent with
      // no wired runtime. getOpenDispatchHold is fail-soft: never breaks the
      // board, and derives from the LATEST activity so a later successful
      // dispatch clears the chip automatically.
      dispatch_hold: getOpenDispatchHold(task.id),
      // U38 (C-07) — human-promote control gate. Short-circuited to every
      // non-review card (mirrors the persona_mismatch short-circuit above):
      // only a `review` task can ever carry a heuristic-parked qc_review
      // event, so this skips the per-row events lookup for the rest of the
      // board. getQcHeuristicPark is fail-soft: never breaks the board.
      qc_heuristic_park: task.status === 'review' ? getQcHeuristicPark(task.id) : null,
    }));

    return NextResponse.json(transformedTasks);
  } catch (error) {
    console.error('Failed to fetch tasks:', error);
    return NextResponse.json({ error: 'Failed to fetch tasks' }, { status: 500 });
  }
}

// POST /api/tasks - Create a new task
export async function POST(request: NextRequest) {
  try {
    const body: CreateTaskRequest = await request.json();
    console.log('[POST /api/tasks] Received body:', JSON.stringify(body));

    // Validate input with Zod
    const validation = CreateTaskSchema.safeParse(body);
    if (!validation.success) {
      return NextResponse.json(
        { error: 'Validation failed', details: validation.error.issues },
        { status: 400 }
      );
    }

    const validatedData = validation.data;

    // A task can never be CREATED directly in `blocked`. Blocked is a transition
    // state a task reaches only once it is in flight and waiting on a specific
    // human action (decision/approval/credential/payment) — and that transition
    // is gated by PATCH /api/tasks/[id], which requires blocked_reason +
    // blocked_on_human + ask. CreateTaskSchema/createTaskCore do not carry those
    // three fields, so accepting status:'blocked' here would silently persist a
    // "blocked" row with NO reason — a card parked in Blocked that no one can act
    // on. Reject it with a descriptive 400 pointing at the correct flow instead
    // of dropping the fields. (Surfaced by the kanban CRUD audit, v4.63.0.)
    if (validatedData.status === 'blocked') {
      return NextResponse.json(
        {
          error: 'A task cannot be created directly as blocked',
          message:
            'Blocked is a human-wait state a task enters after it is in flight. ' +
            'Create the task in backlog/inbox first, then move it to Blocked (which ' +
            'requires a reason, an audience, and what you need from the human).',
          hint: 'Set status to backlog, inbox, planning, assigned, or in_progress on create; ' +
            'reach Blocked via PATCH /api/tasks/{id} with blocked_reason, blocked_on_human, and ask.',
        },
        { status: 400 },
      );
    }

    // U94 (X.2.3) — requester-stamping completeness, Command-Center UI create
    // door. Mirrors the ingest route's own trim + empty-to-null + "chat id
    // present with no channel named defaults to telegram" normalization
    // (tests/unit/ingest-requester-stamp.test.ts) so the trust engine sees
    // identical semantics regardless of which door a task came through.
    const rawRequesterChatId =
      typeof validatedData.requester_chat_id === 'string' ? validatedData.requester_chat_id.trim() : '';
    const requesterChatId = rawRequesterChatId || null;
    const requesterChannel = requesterChatId
      ? (typeof validatedData.requester_channel === 'string' && validatedData.requester_channel.trim()
          ? validatedData.requester_channel.trim()
          : 'telegram')
      : null;

    // Delegate to the shared task-creation core so the UI create path and the
    // universal ingest endpoint (POST /api/tasks/ingest) can never drift.
    // UI creates use skipWindowDedup:true — if an operator manually creates the
    // same task twice we respect their intent rather than silently deduping it.
    const result = await createTaskCore(
      {
        title: validatedData.title,
        description: validatedData.description,
        status: validatedData.status,
        priority: validatedData.priority,
        assigned_agent_id: validatedData.assigned_agent_id,
        created_by_agent_id: validatedData.created_by_agent_id,
        business_id: validatedData.business_id,
        workspace_id: validatedData.workspace_id,
        department: validatedData.department,
        due_date: validatedData.due_date,
        sop_id: validatedData.sop_id ?? null,
        requester_channel: requesterChannel,
        requester_chat_id: requesterChatId,
        // U94 — this is the Command-Center UI create door for the
        // trust-coverage health metric (checkTrustCoverage()).
        humanDoorId: 'command-center-ui',
        // UI creates are intentional — skip the window dedup but still honour
        // any explicit idempotency_key the operator supplies.
        skipWindowDedup: true,
      },
      { origin: request.headers.get('origin') }
    );

    if (!result) {
      return NextResponse.json({ error: 'Failed to create task' }, { status: 500 });
    }

    return NextResponse.json(result.task, { status: 201 });
  } catch (error) {
    console.error('Failed to create task:', error);
    return NextResponse.json({ error: 'Failed to create task' }, { status: 500 });
  }
}
