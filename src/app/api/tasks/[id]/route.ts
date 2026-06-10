import { NextRequest, NextResponse } from 'next/server';
import { v4 as uuidv4 } from 'uuid';
import { queryOne, run, queryAll } from '@/lib/db';
import { broadcast } from '@/lib/events';
import { getMissionControlUrl } from '@/lib/config';
import { UpdateTaskSchema } from '@/lib/validation';
import type { Task, UpdateTaskRequest, Agent, TaskDeliverable } from '@/lib/types';
import { checkTriad } from '@/lib/sops';
import { proposeDraftFromTask } from '@/lib/sop-learning';
import { runQCOnReview } from '@/lib/qc-scorer';
import { spawnRecordCompletion } from '@/lib/persona-selector';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// GET /api/tasks/[id] - Get a single task
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const task = queryOne<Task>(
      `SELECT t.*,
        aa.name as assigned_agent_name,
        aa.avatar_emoji as assigned_agent_emoji,
        mr.label as model_label,
        mr.provider as model_provider,
        mr.input_cost_per_million as model_input_cost_per_million,
        mr.output_cost_per_million as model_output_cost_per_million
       FROM tasks t
       LEFT JOIN agents aa ON t.assigned_agent_id = aa.id
       LEFT JOIN model_registry mr ON t.model_id = mr.model_id
       WHERE t.id = ?`,
      [id]
    );

    if (!task) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }

    return NextResponse.json(task);
  } catch (error) {
    console.error('Failed to fetch task:', error);
    return NextResponse.json({ error: 'Failed to fetch task' }, { status: 500 });
  }
}

// PATCH /api/tasks/[id] - Update a task
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const body: UpdateTaskRequest & { updated_by_agent_id?: string } = await request.json();

    // Validate input with Zod
    const validation = UpdateTaskSchema.safeParse(body);
    if (!validation.success) {
      return NextResponse.json(
        { error: 'Validation failed', details: validation.error.issues },
        { status: 400 }
      );
    }

    const validatedData = validation.data;

    const existing = queryOne<Task>('SELECT * FROM tasks WHERE id = ?', [id]);
    if (!existing) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }

    const updates: string[] = [];
    const values: unknown[] = [];
    const now = new Date().toISOString();

    // Workflow enforcement for agent-initiated approvals (review → done gate).
    //
    // The approving authority is the ITEM'S OWN DEPARTMENT QC agent
    // (role_type='qc', workspace_id matches the task's workspace). This
    // implements the per-department QC model: the Marketing QC Specialist
    // gates marketing tasks, the Sales QC Specialist gates sales tasks, etc.
    //
    // Fallback hierarchy (in order):
    //   1. Task's dept QC agent (role_type='qc' in the task's workspace)
    //   2. Any master agent in the task's workspace (dept head approval)
    //   3. Any global master agent (last resort, keeps legacy behavior)
    //
    // User-initiated moves (no updated_by_agent_id) are always allowed so
    // human operators are never blocked.
    if (validatedData.status === 'done' && existing.status === 'review' && validatedData.updated_by_agent_id) {
      const updatingAgent = queryOne<Agent & { role_type?: string }>(
        'SELECT id, is_master, role_type, workspace_id FROM agents WHERE id = ?',
        [validatedData.updated_by_agent_id]
      );

      if (!updatingAgent) {
        return NextResponse.json(
          { error: 'Forbidden: updating agent not found' },
          { status: 403 }
        );
      }

      // Check if the updating agent is the dept's QC specialist (primary path)
      const isQCSpecialist = updatingAgent.role_type === 'qc';

      // Check if the updating agent is a master agent in this workspace (dept head)
      const isMasterInWorkspace = updatingAgent.is_master &&
        (updatingAgent.workspace_id === existing.workspace_id ||
         updatingAgent.workspace_id === existing.department);

      // Check if the updating agent is a global master (legacy fallback)
      const isGlobalMaster = updatingAgent.is_master;

      // Verify the QC agent actually belongs to this task's department
      // (prevents a Marketing QC agent from approving Sales tasks)
      let isAuthorizedQC = false;
      if (isQCSpecialist) {
        isAuthorizedQC =
          updatingAgent.workspace_id === existing.workspace_id ||
          updatingAgent.workspace_id === existing.department;
      }

      // Also check: is there a dept QC agent registered? If so, only that agent
      // (or a master) can approve. If no QC agent is registered yet (fresh
      // install before migration 060), fall back to master-agent check only.
      let hasDeptQCAgent = false;
      try {
        // Guard: role_type column must exist
        const colCheck = queryOne<{ role_type: string }>(
          "SELECT role_type FROM agents WHERE workspace_id = ? AND role_type = 'qc' LIMIT 1",
          [existing.workspace_id ?? 'default']
        );
        hasDeptQCAgent = !!colCheck;
      } catch {
        // Pre-migration-060 DB: no role_type column → hasDeptQCAgent stays false
      }

      const approved = hasDeptQCAgent
        ? isAuthorizedQC || isMasterInWorkspace || isGlobalMaster
        : isGlobalMaster; // Pre-QC-migration fallback: any master can approve

      if (!approved) {
        return NextResponse.json(
          {
            error: 'Forbidden: only the department QC Specialist (or a master agent) can approve tasks from review',
            hint: hasDeptQCAgent
              ? `The QC agent for this task's department must approve it. Use the auto-QC scorer (runQCOnReview) or assign the approval to the dept QC agent.`
              : 'No QC agent seeded yet for this department. Run migration 060 or seed a role_type=qc agent.'
          },
          { status: 403 }
        );
      }
    }

    if (validatedData.title !== undefined) {
      updates.push('title = ?');
      values.push(validatedData.title);
    }
    if (validatedData.description !== undefined) {
      updates.push('description = ?');
      values.push(validatedData.description);
    }
    if (validatedData.priority !== undefined) {
      updates.push('priority = ?');
      values.push(validatedData.priority);
    }
    if (validatedData.due_date !== undefined) {
      updates.push('due_date = ?');
      values.push(validatedData.due_date);
    }
    if (validatedData.sop_id !== undefined) {
      updates.push('sop_id = ?');
      values.push(validatedData.sop_id);
    }
    if (validatedData.sop_step_progress !== undefined) {
      updates.push('sop_step_progress = ?');
      values.push(validatedData.sop_step_progress);
    }

    // Track if we need to dispatch task
    let shouldDispatch = false;

    // Handle status change
    if (validatedData.status !== undefined && validatedData.status !== existing.status) {
      // Triad Rule gate: leaving backlog requires description + valid SOP + valid persona.
      // Evaluated against the POST-merge state (incoming sop_id beats existing).
      if (existing.status === 'backlog' && validatedData.status !== 'backlog') {
        const merged = {
          description: validatedData.description !== undefined ? validatedData.description : existing.description,
          sop_id: validatedData.sop_id !== undefined ? validatedData.sop_id : (existing as Task).sop_id,
          persona_id: (existing as Task).persona_id,
        };
        const { missing } = checkTriad(merged);
        if (missing.length > 0) {
          // Auto-draft: when the ONLY/also-missing piece is the SOP, turn the
          // block into a pre-filled DRAFT proposal the dept head can approve,
          // instead of just bouncing a 400 with nothing to act on. Best-effort
          // and idempotent (one pending draft per task) — a failure here must
          // never change the gate's behavior, so we swallow and still 400.
          let sop_draft_proposal_id: string | null = null;
          if (missing.includes('sop_id')) {
            try {
              const draft = proposeDraftFromTask({
                task_id: id,
                title: validatedData.title !== undefined ? validatedData.title : existing.title,
                description: merged.description,
                department: (existing as Task).department || (existing as Task).workspace_id || null,
                persona_id: merged.persona_id,
              });
              sop_draft_proposal_id = draft.proposal_id;
            } catch (err) {
              console.warn('[tasks PATCH] Triad auto-draft skipped:', (err as Error).message);
            }
          }
          return NextResponse.json(
            {
              error: 'Triad incomplete',
              missing,
              task_id: id,
              sop_draft_proposal_id,
              message: `Cannot leave backlog. Missing: ${missing.join(', ')}. The Triad Rule requires a description, a SOP, and a persona before a task can start.${
                sop_draft_proposal_id ? ' A draft SOP was prepared for review at /sops/proposals.' : ''
              }`,
            },
            { status: 400 }
          );
        }
      }

      updates.push('status = ?');
      values.push(validatedData.status);

      // Auto-dispatch when moving to in_progress with an assigned agent
      if (validatedData.status === 'in_progress' && existing.assigned_agent_id) {
        shouldDispatch = true;
      }

      // Log status change event
      const eventType = validatedData.status === 'done' ? 'task_completed' : 'task_status_changed';
      run(
        `INSERT INTO events (id, type, task_id, message, created_at)
         VALUES (?, ?, ?, ?, ?)`,
        [uuidv4(), eventType, id, `Task "${existing.title}" moved to ${validatedData.status}`, now]
      );

      // Append to task_history (migration 027) so /api/performance can
      // compute durations + agent attribution per transition. Best-effort:
      // older DBs without the table won't have this row.
      try {
        const actingAgentId = validatedData.updated_by_agent_id || existing.assigned_agent_id || null;
        let actingAgentName: string | null = null;
        if (actingAgentId) {
          const a = queryOne<Agent>('SELECT name FROM agents WHERE id = ?', [actingAgentId]);
          actingAgentName = a?.name ?? null;
        }
        run(
          `INSERT INTO task_history (id, task_id, status_from, status_to, changed_at, changed_by_agent_id, agent_name)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [uuidv4(), id, existing.status, validatedData.status, now, actingAgentId, actingAgentName]
        );
      } catch (err) {
        // task_history table missing on older DBs — just log and move on.
        console.warn('[tasks PATCH] task_history append skipped:', (err as Error).message);
      }
    }

    // Handle assignment change
    if (validatedData.assigned_agent_id !== undefined && validatedData.assigned_agent_id !== existing.assigned_agent_id) {
      updates.push('assigned_agent_id = ?');
      values.push(validatedData.assigned_agent_id);

      if (validatedData.assigned_agent_id) {
        const agent = queryOne<Agent>('SELECT name FROM agents WHERE id = ?', [validatedData.assigned_agent_id]);
        if (agent) {
          run(
            `INSERT INTO events (id, type, agent_id, task_id, message, created_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [uuidv4(), 'task_assigned', validatedData.assigned_agent_id, id, `"${existing.title}" assigned to ${agent.name}`, now]
          );

          // Auto-dispatch if already in in_progress status or being moved to in_progress now
          if (existing.status === 'in_progress' || validatedData.status === 'in_progress') {
            shouldDispatch = true;
          }
        }
      }
    }

    if (updates.length === 0) {
      return NextResponse.json({ error: 'No updates provided' }, { status: 400 });
    }

    updates.push('updated_at = ?');
    values.push(now);
    values.push(id);

    run(`UPDATE tasks SET ${updates.join(', ')} WHERE id = ?`, values);

    // Fetch updated task with all joined fields
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

    // Broadcast task update via SSE
    if (task) {
      broadcast({
        type: 'task_updated',
        payload: task,
      });
    }

    // ── Persona completion feedback loop (PRD 1.4) ─────────────────────────
    // When a task transitions to `done` via human approval (PATCH status=done),
    // fire record-completion so persona_performance accumulates outcome data.
    // Skip when persona_id is null (unassigned tasks) — per PRD spec.
    // The QC auto-approve path is handled inside runQCOnReview (qc-scorer.ts).
    const transitionedToDone =
      validatedData.status === 'done' && existing.status !== 'done';
    if (transitionedToDone && task?.persona_id) {
      const deptSlug = (task as Task & { department?: string | null }).department
        ?? task.workspace_id
        ?? null;
      spawnRecordCompletion(id, task.persona_id, deptSlug);
    }

    // ── QC-Agent auto-scorer ────────────────────────────────────────────────
    // When a task transitions INTO `review`, fire the QC auto-scorer (fire and
    // forget — never blocks the HTTP response). The scorer:
    //   1. Fetches the task's assigned SOP + success_criteria.
    //   2. Uses the configured LLM (OPENAI/GOOGLE key) or a heuristic fallback.
    //   3. Score ≥8.5 → moves task to `done` + writes task_completed event.
    //      Score <8.5 → returns to `in_progress` + appends gap notes.
    //   4. Always writes a `qc_review` event for the audit trail.
    //
    // Disable with DISABLE_QC_AUTO_SCORER=1 (env).
    const transitionedToReview =
      validatedData.status === 'review' && existing.status !== 'review';
    if (transitionedToReview) {
      // Fire-and-forget: don't await — QC runs asynchronously after response.
      runQCOnReview(id).catch((err) => {
        console.error('[tasks PATCH] QC auto-scorer fire-and-forget error:', err);
      });
    }

    // Trigger auto-dispatch if needed
    if (shouldDispatch) {
      // Call dispatch endpoint asynchronously (don't wait for response)
      const missionControlUrl = getMissionControlUrl();
      fetch(`${missionControlUrl}/api/tasks/${id}/dispatch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      }).catch(err => {
        console.error('Auto-dispatch failed:', err);
      });
    }

    return NextResponse.json(task);
  } catch (error) {
    console.error('Failed to update task:', error);
    return NextResponse.json({ error: 'Failed to update task' }, { status: 500 });
  }
}

// DELETE /api/tasks/[id] - Delete a task
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const existing = queryOne<Task>('SELECT * FROM tasks WHERE id = ?', [id]);

    if (!existing) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }

    // Delete or nullify related records first (foreign key constraints)
    // Note: task_activities and task_deliverables have ON DELETE CASCADE
    run('DELETE FROM openclaw_sessions WHERE task_id = ?', [id]);
    run('DELETE FROM events WHERE task_id = ?', [id]);
    // Conversations reference tasks - nullify or delete
    run('UPDATE conversations SET task_id = NULL WHERE task_id = ?', [id]);

    // Now delete the task (cascades to task_activities and task_deliverables)
    run('DELETE FROM tasks WHERE id = ?', [id]);

    // Broadcast deletion via SSE
    broadcast({
      type: 'task_deleted',
      payload: { id },
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Failed to delete task:', error);
    return NextResponse.json({ error: 'Failed to delete task' }, { status: 500 });
  }
}
