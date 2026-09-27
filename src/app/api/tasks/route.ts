import { TaskContextError } from '@/lib/task-request-identity';
import { assignmentCompany, TaskAgentAccessError } from '@/lib/task-agent-assignment';
import { NextRequest, NextResponse } from 'next/server';
import { queryOne, queryAll } from '@/lib/db';
import { CreateTaskSchema } from '@/lib/validation';
import { createTaskCore } from '@/lib/tasks';
import { classify, assertTaskCreationAllowed } from '@/lib/intake';
import {
  buildTaskRowSelect,
  projectTaskRows,
  type TaskRowRaw,
} from '@/lib/board/task-row-projection';
import type { CreateTaskRequest } from '@/lib/types';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

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

    // P4-02 step 5 / A41 — the persona-blend confirm column and its guarded
    // JOIN are owned by the ONE shared projection: buildTaskRowSelect() below
    // includes blendConfirmSelectExpr() + blendConfirmJoin() and their pre-090
    // table-existence guard. This route owns no field list at all — only the
    // WHERE / ORDER / LIMIT clauses it appends.
    let sql = `${buildTaskRowSelect()}
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

    // ── Server-side full-text search (MR-26) ──────────────────────────────
    // ?q=<term> does a case-insensitive LIKE scan across title + description.
    // Boards with hundreds of tasks previously loaded every row and filtered
    // client-side (linear degradation). The server-side search lets SQLite's
    // own LIKE engine narrow the result set before the transform loop.
    const q = searchParams.get('q');
    if (q && q.trim()) {
      const term = `%${q.trim()}%`;
      sql += ' AND (t.title LIKE ? OR t.description LIKE ?)';
      params.push(term, term);
    }

    // ── Pagination (MR-26) ─────────────────────────────────────────────────
    // ?limit=N caps the result set; ?offset=N skips rows. When neither is
    // supplied the route still returns every row (unchanged behaviour for the
    // main board which receives all tasks then buckets them client-side into
    // columns). A paginated response includes `total` in the JSON envelope so
    // consumers can render a page-control UI.
    const limitRaw = searchParams.get('limit');
    const offsetRaw = searchParams.get('offset');
    const limit = limitRaw ? Math.max(1, Math.min(1000, parseInt(limitRaw, 10) || 100)) : null;
    const offset = offsetRaw ? Math.max(0, parseInt(offsetRaw, 10) || 0) : null;

    // TOTAL COUNT — needs its own query before the LIMIT clause is appended.
    // Uses the same WHERE clause and params so counts are always accurate.
    let total: number | null = null;
    if (limit !== null) {
      // Count query: SELECT COUNT(*) FROM tasks t ... WHERE ... (same joins, same WHERE)
      const countSql = sql.replace(/^[\s\S]*?FROM tasks t/, 'SELECT COUNT(*) as cnt FROM tasks t');
      const countRow = queryOne<{ cnt: number }>(countSql, params);
      total = countRow?.cnt ?? 0;
    }

    sql += ' ORDER BY t.created_at DESC';

    if (limit !== null) {
      sql += ' LIMIT ?';
      params.push(limit);
      if (offset !== null) {
        sql += ' OFFSET ?';
        params.push(offset);
      }
    }

    const tasks = queryAll<TaskRowRaw>(sql, params);

    // A41 — ONE transform, shared with detail GET, every task_updated emit site
    // and the broadcast() choke point (src/lib/board/task-row-projection.ts).
    // This route previously hand-rolled its own copy of the row shape, which is
    // exactly how the live-update and task-detail surfaces drifted out of
    // agreement with it.
    const transformedTasks = projectTaskRows(tasks);

    // MR-26 — paginated response. When ?limit was supplied the body wraps
    // `{ tasks, total }` so consumers can render a page-control UI. Without
    // ?limit the response is a flat array (unchanged back-compat).
    if (total !== null) {
      return NextResponse.json({ tasks: transformedTasks, total });
    }
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

    // WIR-121 (spec 16.2 A11, 12.2 UI door): the RAW-conversational shape —
    // a title-only call with NO workspace_id/department and NO overhead
    // keys (no routing destination, nothing a typed command would carry) —
    // goes through the EXISTING intake module: classify() then
    // assertTaskCreationAllowed, before any card exists. Definite non-work
    // verdicts (answer_only / social_conversation / existing_task_control /
    // clarification_response) return 200 created:false with NO card, so
    // createTaskCore (and everything downstream of its INSERT —
    // routeTaskDecision / commitIntakeAssignment / autoDispatchTask) never
    // runs. task_request / mixed_answer_and_task proceed through the
    // creation gate (which proves classify() ran on THIS text via the
    // message hash). unresolved falls through to card creation, and any
    // structured call (a destination or an overhead key — any TypedIngest
    // shape) carries a typed command, never re-classified (spec 4.2).
    {
      const rawTitle = validatedData.title;
      const rawKeys = body !== null && typeof body === 'object' && !Array.isArray(body)
        ? Object.keys(body as unknown as Record<string, unknown>)
        : [];
      const hasDestination = !!(validatedData.workspace_id || validatedData.department);
      const hasOverhead = rawKeys.some(
        (k) => !['title', 'description', 'workspace_id', 'department'].includes(k),
      );
      if (!hasDestination && !hasOverhead) {
        const classification = await classify(rawTitle);
        if (
          classification.intent === 'answer_only' ||
          classification.intent === 'social_conversation' ||
          classification.intent === 'existing_task_control' ||
          classification.intent === 'clarification_response'
        ) {
          return NextResponse.json(
            { ok: true, created: false, intent: classification.intent, task_id: null },
            { status: 200 },
          );
        }
        if (
          classification.intent === 'task_request' ||
          classification.intent === 'mixed_answer_and_task'
        ) {
          if (!classification.bypassAllowed || classification.controlProbe) {
            return NextResponse.json(
              { error: 'control_probe_never_creates', intent: classification.intent },
              { status: 403 },
            );
          }
          assertTaskCreationAllowed({ kind: 'raw', message: rawTitle, classification });
        }
        // unresolved falls through to card creation: an explicit bare-title
        // create is a typed command, not raw chat text (spec 4.2).
      }
    }

    const agentCompanyId = validatedData.assigned_agent_id || validatedData.created_by_agent_id
      ? await assignmentCompany(request) : undefined;

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
        idempotency_company_id: agentCompanyId,
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
    if (error instanceof TaskAgentAccessError) return NextResponse.json({ error: error.message }, { status: error.status });
    if (error instanceof TaskContextError) return NextResponse.json({error:error.message}, {status:error.status});
    console.error('Failed to create task:', error);
    return NextResponse.json({ error: 'Failed to create task' }, { status: 500 });
  }
}
