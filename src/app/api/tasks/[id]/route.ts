import { NextRequest, NextResponse } from 'next/server';
import { v4 as uuidv4 } from 'uuid';
import { queryOne, run, queryAll, getDb } from '@/lib/db';
import {
  assertArchivedBeforeHardDelete,
  HardDeleteWithoutArchiveError,
  hardDeleteRefusedResponseBody,
} from '@/lib/delete-guard';
import { broadcast } from '@/lib/events';
import { getMissionControlUrl } from '@/lib/config';
import { UpdateTaskSchema } from '@/lib/validation';
import type { Task, UpdateTaskRequest, Agent, TaskDeliverable } from '@/lib/types';
import { checkTriad, getBestSOPForTask } from '@/lib/sops';
import { proposeDraftFromTask } from '@/lib/sop-learning';
import { runQCOnReview } from '@/lib/qc-scorer';
import { selectPersonaForTask, buildPersonaReason, loadPersonaBundleScopes } from '@/lib/persona-selector';
import { recordPersonaCompletions } from '@/lib/tasks';
import { getOpenPersonaMismatch } from '@/lib/persona-mismatch';
import { canonicalDeptSlug } from '@/lib/routing/canonical-slug';
import { notifyOwner } from '@/lib/notify';
import { notifyOwnerDone } from '@/lib/owner-reports';
import { evaluatePresentationsDoneGate } from '@/lib/presentations-cert-gate';

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

    // B-U6 / U20 — declared-vs-used comparator, same field the tasks-list GET
    // attaches (src/app/api/tasks/route.ts). Fail-soft, short-circuited when
    // this task never resolved a voice persona.
    // A-U5 — per-page/scoped persona-blend rows (migration 104). Fail-soft:
    // loadPersonaBundleScopes tolerates a pre-104 box or a table-read error
    // by returning [], never breaking this single-task fetch.
    const withMismatch: Task = {
      ...task,
      persona_mismatch: task.voice_persona_id ? getOpenPersonaMismatch(task.id) : null,
      persona_bundle_scopes: loadPersonaBundleScopes(task.id),
    };

    return NextResponse.json(withMismatch);
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

    // ── Trust-boundary operator identity (INGEST-11) ─────────────────────────
    // Cloudflare Access injects `Cf-Access-Authenticated-User-Email` ONLY after
    // it has verified the operator's SSO identity at the edge. We derive the
    // approving human's identity from that verified header — NEVER from a payload
    // field (updated_by_agent_id) nor a bare, forgeable `x-operator-email`.
    //
    // CROSS-LANE DEPENDENCY (L6 · src/middleware.ts): the middleware MUST strip
    // any inbound copy of the `Cf-Access-*` headers from external callers at the
    // trust boundary, so a request that did NOT traverse Cloudflare Access cannot
    // forge this identity. This route consumes the boundary-guaranteed value.
    const cfAccessEmail =
      request.headers.get('cf-access-authenticated-user-email')?.trim() || null;

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
    // INDEPENDENT QC (v4.45.0): the builder may NEVER advance its own task out
    // of `review`. The independent auto-scorer (runQCOnReview) is the sole
    // authority that scores + advances review→done; it runs as the SYSTEM
    // (no updated_by_agent_id), so it is never affected by this guard. A
    // builder PATCHing its own task to `done` — even if it also holds
    // role_type='qc' — is a self-grade conflict of interest and is rejected
    // with 403. This kills the builder self-grade bypass at the gate.
    //
    // Human review → done approvals (no updated_by_agent_id) are NO LONGER
    // auto-trusted (INGEST-11): they MUST carry a verified Cloudflare Access
    // identity. This guard rejects an anonymous scripted "human" that simply
    // omits updated_by_agent_id; a genuine operator authenticated through CF
    // Access carries Cf-Access-Authenticated-User-Email and passes — its value
    // is recorded as the approver in the audit trail below.
    if (
      validatedData.status === 'done' &&
      existing.status === 'review' &&
      !validatedData.updated_by_agent_id &&
      !cfAccessEmail
    ) {
      return NextResponse.json(
        {
          error: 'Forbidden: review → done requires a verified operator identity.',
          hint:
            'A human approval must arrive through Cloudflare Access (which sets a ' +
            'verified Cf-Access-Authenticated-User-Email at the trust boundary). An ' +
            'agent approval must set updated_by_agent_id to the department QC ' +
            'Specialist or a master agent. review → done is otherwise decided only ' +
            'by the independent QC auto-scorer (runQCOnReview).',
        },
        { status: 403 },
      );
    }

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

      // ── INDEPENDENT-QC GUARD: kill the builder self-grade ────────────────
      // The task's own builder (assigned_agent_id OR created_by_agent_id)
      // cannot grade its own work. Independent QC means a SEPARATE authority
      // scores the deliverable. The system-run auto-scorer carries no
      // updated_by_agent_id and is unaffected.
      const isOwnBuilder =
        validatedData.updated_by_agent_id === existing.assigned_agent_id ||
        validatedData.updated_by_agent_id === existing.created_by_agent_id;
      if (isOwnBuilder) {
        return NextResponse.json(
          {
            error: 'Forbidden: the task\'s own builder cannot grade or approve its own work (self-grade bypass blocked)',
            hint: 'review→done is decided ONLY by the independent QC auto-scorer (runQCOnReview) or a SEPARATE department QC Specialist / master agent. The builder must PATCH {"status":"review"} and let independent QC score it.',
          },
          { status: 403 }
        );
      }
      // ── End INDEPENDENT-QC GUARD ─────────────────────────────────────────

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
        // Pre-QC-migration (pre-060) fallback: a legit DEPT master must be able
        // to approve too, not only a global master (INGEST-12).
        : isMasterInWorkspace || isGlobalMaster;

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

    // ── Blocked-column gate (N36 / SOP-01-Blocked-vs-Return) ─────────────────
    // Parallel to the Triad gate (backlog → out) and QC-authority gate (review → done).
    // When an agent tries to set status=blocked, ALL conditions must hold:
    //   1. blocked_reason is one of {decision,approval,credential,payment}
    //   2. blocked_on_human is "owner" or "operator"
    //   3. ask is a non-empty string
    //   4. The requesting agent is the master orchestrator (is_master = 1)
    //
    // User-initiated moves (no updated_by_agent_id) are allowed so operators can
    // manually park a card -- but they MUST still supply the three required fields.
    //
    // Worker agents must call POST /api/tasks/[id]/return-to-orchestrator instead.
    if (validatedData.status === 'blocked') {
      const { blocked_reason, blocked_on_human, ask } = validatedData as typeof validatedData & {
        blocked_reason?: string | null;
        blocked_on_human?: string | null;
        ask?: string | null;
      };
      const missingBlockedFields: string[] = [];
      if (!blocked_reason) missingBlockedFields.push('blocked_reason');
      if (!blocked_on_human) missingBlockedFields.push('blocked_on_human');
      if (!ask || ask.trim().length === 0) missingBlockedFields.push('ask');

      if (missingBlockedFields.length > 0) {
        return NextResponse.json(
          {
            error: 'Blocked requires a human-only reason',
            missing: missingBlockedFields,
            message: `Cannot set status=blocked without: ${missingBlockedFields.join(', ')}. ` +
              `The Blocked column is ONLY for tasks waiting on a human action (decision, approval, credential, or payment). ` +
              `If your task hit an error or needs re-routing, call POST /api/tasks/${id}/return-to-orchestrator instead.`,
            hint: 'blocked_reason must be one of: decision, approval, credential, payment. blocked_on_human must be "owner" or "operator". ask must be a one-line string stating exactly what the human must do.',
          },
          { status: 400 },
        );
      }

      // Authority check: only master agents may set blocked via the API.
      // Human operators (UI drag-drop) bypass this by not supplying updated_by_agent_id.
      if (validatedData.updated_by_agent_id) {
        const blockingAgent = queryOne<Pick<Agent, 'id' | 'is_master'>>(
          'SELECT id, is_master FROM agents WHERE id = ?',
          [validatedData.updated_by_agent_id],
        );
        if (!blockingAgent?.is_master) {
          return NextResponse.json(
            {
              error: 'Forbidden: only the Master Orchestrator may set status=blocked',
              hint: 'Worker agents must call POST /api/tasks/{id}/return-to-orchestrator with a structured handback instead of setting status=blocked directly.',
            },
            { status: 403 },
          );
        }
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

    // Blocked fields (migration 071): persist when setting status=blocked.
    // Clear them when leaving blocked (transitioning to any other status).
    const newStatus = validatedData.status;
    const leavingBlocked = existing.status === 'blocked' && newStatus !== undefined && newStatus !== 'blocked';
    const enteringBlocked = newStatus === 'blocked';

    const blockedPayload = validatedData as typeof validatedData & {
      blocked_reason?: string | null;
      blocked_on_human?: string | null;
      ask?: string | null;
    };
    if (enteringBlocked) {
      if (blockedPayload.blocked_reason !== undefined) {
        updates.push('blocked_reason = ?');
        values.push(blockedPayload.blocked_reason);
      }
      if (blockedPayload.blocked_on_human !== undefined) {
        updates.push('blocked_on_human = ?');
        values.push(blockedPayload.blocked_on_human);
      }
      if (blockedPayload.ask !== undefined) {
        updates.push('ask = ?');
        values.push(blockedPayload.ask);
      }
    } else if (leavingBlocked) {
      // Clear blocked fields when the card moves out of Blocked.
      updates.push('blocked_reason = ?', 'blocked_on_human = ?', 'ask = ?');
      values.push(null, null, null);
      // B3: also clear the SYSTEM block-metadata columns the stuck-in-progress
      // sweep / recordDispatchFailure write (block_reason / block_needs /
      // block_audience). Leaving them populated made an unblocked card still read
      // as SYSTEM-blocked on the board and in audience routing. Cleared in the
      // SAME UPDATE so the unblock is atomic.
      updates.push('block_reason = ?', 'block_needs = ?', 'block_audience = ?');
      values.push(null, null, null);
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
        let missing = checkTriad(merged).missing;

        // G10-TRIAD-PERSONA-RESOLVE: persona/SOP are async best-effort at create
        // time; if the pin had not landed yet, a NULL persona_id/sop_id here would
        // hard-bounce a 400 and the human drag would silently revert. Instead of
        // bouncing, AUTO-RESOLVE the missing piece in-band (trigger SOP match +
        // persona selection), persist it, then re-check. Bounded single attempt
        // each — one in-process SOP match + at most one python selector spawn (its
        // own 30s timeout); no retry storm, no cron, no furnace.
        if (missing.length > 0) {
          const triadNow = new Date().toISOString();
          const triadDept =
            canonicalDeptSlug((existing as Task).department || '') ||
            (existing as Task).department ||
            null;

          if (missing.includes('sop_id')) {
            try {
              const best = await getBestSOPForTask({
                title: validatedData.title !== undefined ? validatedData.title : existing.title,
                description: merged.description ?? undefined,
                department: triadDept ?? undefined,
                workspace_id: (existing as Task).workspace_id ?? undefined,
              });
              if (best) {
                run('UPDATE tasks SET sop_id = ?, updated_at = ? WHERE id = ?', [best.id, triadNow, id]);
                merged.sop_id = best.id;
              }
            } catch (err) {
              console.warn('[tasks PATCH] Triad SOP auto-resolve failed (non-fatal):', (err as Error).message);
            }
          }

          if (missing.includes('persona_id')) {
            try {
              const personaTitle = validatedData.title !== undefined ? validatedData.title : existing.title;
              const personaDesc = `${personaTitle}${merged.description ? `. ${merged.description}` : ''}`.trim();
              const persona = await selectPersonaForTask(id, personaDesc, triadDept);
              if (persona && persona.persona_id && !persona.no_persona_required) {
                run(
                  `UPDATE tasks
                      SET persona_id = ?, persona_name = ?, persona_mode = ?,
                          persona_score = ?, persona_version = ?, persona_selected_at = ?, updated_at = ?
                    WHERE id = ?`,
                  [
                    persona.persona_id,
                    persona.persona_name,
                    persona.interaction_mode,
                    persona.score ?? null,
                    persona.persona_version ?? 1,
                    triadNow,
                    triadNow,
                    id,
                  ],
                );
                merged.persona_id = persona.persona_id;
                // P2-02 — store the one-sentence WHY alongside the pin (best-effort,
                // column-guarded so a pre-099 box never fails the Triad resolve).
                try {
                  const reason = buildPersonaReason(persona);
                  if (reason) run(`UPDATE tasks SET persona_reason = ? WHERE id = ?`, [reason, id]);
                } catch {
                  // persona_reason is additive telemetry — never block the pin.
                }
              }
            } catch (err) {
              console.warn('[tasks PATCH] Triad persona auto-resolve failed (non-fatal):', (err as Error).message);
            }
          }

          // Re-evaluate against the freshly-resolved state.
          missing = checkTriad(merged).missing;
        }

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

      // ── FIX C v2 — PRESENTATIONS NO-SKIP PROOF GATE (matching; supersedes v4.56.0 v1) ──
      // v4.56.0 shipped a v1 PRESENCE-only check and explicitly deferred
      // "verification against a stored certificate hash" to v2. This IS that v2:
      // the presented cert is MATCHED against the one registered on the task
      // (tasks.process_certificate_sha, migration 080) — anti-spoof — and a newly
      // presented cert is persisted as the certificate of record. Presence is still
      // required (no regression vs v1). The decision is the pure, unit-tested
      // evaluatePresentationsDoneGate(); failures keep the v1 422 + requires_* contract.
      {
        const certGate = evaluatePresentationsDoneGate({
          department: (existing as Task).department,
          currentStatus: existing.status,
          targetStatus: validatedData.status,
          storedCert: (existing as Task).process_certificate_sha,
          providedCert: (validatedData as typeof validatedData & {
            process_certificate_sha?: string | null;
          }).process_certificate_sha,
        });
        if (certGate.applies && !certGate.ok) {
          return NextResponse.json(
            {
              error: certGate.error,
              code: certGate.code,
              requires_process_certificate: true,
              remediation: certGate.remediation,
            },
            { status: 422 },
          );
        }
        if (certGate.applies && certGate.ok && certGate.persistCert) {
          updates.push('process_certificate_sha = ?');
          values.push(certGate.persistCert);
        }
      }
      // ── End presentations no-skip proof gate ────────────────────────────────────────────

      updates.push('status = ?');
      values.push(validatedData.status);

      // Auto-dispatch when moving to in_progress with an assigned agent
      if (validatedData.status === 'in_progress' && existing.assigned_agent_id) {
        shouldDispatch = true;
      }

      // ── Provenance (INGEST-14): resolve the actor ONCE and stamp it on BOTH
      // the events row (agent_id) AND the task_history row (changed_by_agent_id
      // + agent_name) so the two audit sinks never diverge. For a human
      // review → done approval with no agent id, the verified CF-Access operator
      // email (INGEST-11) is the approver of record. The canonical consolidation
      // is the shared transition() (task-lifecycle.ts, owned by L3): this route,
      // the status route, and the return-to-orchestrator route should all funnel
      // through it — see integrator note.
      const actingAgentId = validatedData.updated_by_agent_id || existing.assigned_agent_id || null;
      let actorName: string | null = null;
      if (!validatedData.updated_by_agent_id && cfAccessEmail) {
        actorName = cfAccessEmail; // verified human operator (INGEST-11)
      } else if (actingAgentId) {
        const a = queryOne<Agent>('SELECT name FROM agents WHERE id = ?', [actingAgentId]);
        actorName = a?.name ?? null;
      }
      const approverSuffix =
        !validatedData.updated_by_agent_id && cfAccessEmail ? ` (approved by ${cfAccessEmail})` : '';

      // Log status change event (with actor agent_id for a complete audit trail).
      const eventType = validatedData.status === 'done' ? 'task_completed' : 'task_status_changed';
      run(
        `INSERT INTO events (id, type, agent_id, task_id, message, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [uuidv4(), eventType, actingAgentId, id, `Task "${existing.title}" moved to ${validatedData.status}${approverSuffix}`, now]
      );

      // ── OWNER NOTIFICATION (DONE — manual/QC-agent approval) ───────────
      // W5.4: replaced bare 2-field string with notifyOwnerDone (all 5 fields:
      // who/role + where + SOP + persona). Best-effort; gateway-routed.
      if (validatedData.status === 'done' && existing.status !== 'done') {
        try {
          notifyOwnerDone(id);
        } catch (notifyErr) {
          console.error('[tasks PATCH] DONE owner notify error (non-fatal):', (notifyErr as Error).message);
        }
      }
      // ── End OWNER NOTIFICATION (DONE — manual/QC-agent approval) ────────

      // Append to task_history (migration 027) so /api/performance can
      // compute durations + agent attribution per transition. Best-effort:
      // older DBs without the table won't have this row.
      try {
        // Reuse the single actor resolution stamped on the events row above so
        // the two audit sinks agree on WHO performed the transition (INGEST-14).
        run(
          `INSERT INTO task_history (id, task_id, status_from, status_to, changed_at, changed_by_agent_id, agent_name)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [uuidv4(), id, existing.status, validatedData.status, now, actingAgentId, actorName]
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
    // Bump last_progress_at on any status change (migration 071 / stale-task-sweep).
    // This covers: status transitions, assignment changes, and explicit field updates.
    // The stale sweep reads last_progress_at to determine when a card has gone stale.
    if (validatedData.status !== undefined || validatedData.assigned_agent_id !== undefined) {
      try {
        updates.push('last_progress_at = ?');
        values.push(now);
      } catch {
        // Pre-migration-071 DB: column missing -- silently skip rather than crash.
      }
    }
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
      // PRD 2.9(f): when task.department is null, resolve the workspace slug
      // from the DB rather than falling back to workspace_id raw (which is a
      // UUID for UI-created workspaces). department_id must always be a
      // canonical slug, never a UUID, so persona_selection_log keys are stable.
      const taskDept = (task as Task & { department?: string | null }).department ?? null;
      let deptSlug: string | null = taskDept;
      if (!deptSlug && task.workspace_id) {
        try {
          const ws = queryOne<{ slug: string }>(
            'SELECT slug FROM workspaces WHERE id = ?',
            [task.workspace_id],
          );
          deptSlug = ws?.slug ?? task.workspace_id;
        } catch {
          deptSlug = task.workspace_id;
        }
      }
      // Apply canonical normalization so the slug is always in the ZHC set.
      if (deptSlug) deptSlug = canonicalDeptSlug(deptSlug) || deptSlug;
      // Pass task title + description as --task-output so the Python
      // record_completion() function can write the persona_performance row.
      // D7: credit EVERY blended persona (voice + topic + any subtask-decomposition
      // personas), not just the primary voice mirror — see recordPersonaCompletions.
      const taskOutput = [task.title, task.description].filter(Boolean).join(' — ');
      recordPersonaCompletions(id, task.persona_id, deptSlug, taskOutput);
    }

    // ── QC-Agent auto-scorer ────────────────────────────────────────────────
    // When a task transitions INTO `review`, fire the QC auto-scorer (fire and
    // forget — never blocks the HTTP response). The scorer:
    //   1. Fetches the task's assigned SOP + success_criteria.
    //   2. Uses the configured LLM (OPENAI/GOOGLE key) or a heuristic fallback.
    //   3. Score ≥8.5 → moves task to `done` + writes task_completed event.
    //      Score <8.5 → returns to `backlog` (re-enters intake/auto-route) +
    //      appends gap notes. (QC-01: the scorer writes `backlog`, not
    //      `in_progress` — a failed task re-routes through intake, it does not
    //      resume the old dispatch.)
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

    // B8 / AUD-46 — a hard DELETE is REFUSED unless a soft-archive preceded it.
    //
    // Everything below this line is IRREVERSIBLE: the task row and its cascaded
    // children (history, deliverables, QC results, events) are destroyed with no
    // tombstone. `archived_at` already exists (migration 058) and the board already
    // hides archived cards — a soft-archive is ALREADY the lossless way to take a
    // card off the board, there was just nothing forcing its use. This forces it,
    // and fails CLOSED. Archive first via POST /api/tasks/<id>/archive, then delete.
    try {
      assertArchivedBeforeHardDelete(getDb(), 'tasks', id);
    } catch (err) {
      if (err instanceof HardDeleteWithoutArchiveError) {
        return NextResponse.json(hardDeleteRefusedResponseBody(err), { status: 409 });
      }
      throw err;
    }

    // Delete or nullify related records first (foreign key constraints).
    //
    // Tables with `ON DELETE CASCADE` (task_history, planning_questions,
    // planning_specs, task_activities, task_deliverables, task_events,
    // task_qc_results) and `ON DELETE SET NULL` (execution_queue) are handled
    // automatically by SQLite. The rows below are the ones whose FK to tasks(id)
    // carries NO action clause — with `PRAGMA foreign_keys=ON` those references
    // HARD-BLOCK the task delete, which is why DELETE returned a generic 500
    // once a task had any persona-selection / persona-performance history (every
    // task acquires those the moment the persona backfill sweep runs).
    run('DELETE FROM openclaw_sessions WHERE task_id = ?', [id]);
    run('DELETE FROM events WHERE task_id = ?', [id]);
    // Conversations reference tasks - nullify (task_id is nullable there).
    run('UPDATE conversations SET task_id = NULL WHERE task_id = ?', [id]);
    // persona_selection_log / persona_performance carry a plain (no-action) FK
    // and a NOT NULL task_id, so they cannot be nullified — delete the
    // task-scoped analytics rows. Guarded: older DBs may predate these tables.
    try {
      run('DELETE FROM persona_selection_log WHERE task_id = ?', [id]);
    } catch (err) {
      console.warn('[tasks DELETE] persona_selection_log cleanup skipped:', (err as Error).message);
    }
    try {
      run('DELETE FROM persona_performance WHERE task_id = ?', [id]);
    } catch (err) {
      console.warn('[tasks DELETE] persona_performance cleanup skipped:', (err as Error).message);
    }

    // Now delete the task (cascades to the ON DELETE CASCADE children above).
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
