/**
 * task-dispatcher.ts — Server-only.
 *
 * `autoDispatchTask(taskId, context?)` fires the OpenClaw invocation for a
 * newly-routed specialist task, closing the two-step routing gap (v4.14.0).
 *
 * PROBLEM:
 *   The Command Center has always had two steps:
 *     Step 1 — routing:    createTaskCore / auto-route assigns assigned_agent_id
 *                          and writes a task_dispatched event. Task stays in backlog.
 *     Step 2 — invocation: POST /api/tasks/[id]/dispatch connects to OpenClaw,
 *                          creates a session, calls chat.send, advances to in_progress.
 *   Step 2 only fired on a manual "Send to Agent" click. Every auto-routed specialist
 *   task silently stalled — Curtis routed purple-duck to Graphics Lead → Graphics Lead
 *   stayed standby, no image generated, no QC. (Proven on Sheila's box.)
 *
 * FIX:
 *   autoDispatchTask() replicates the Step 2 logic in-process (same code path
 *   as the dispatch route handler) and is called fire-and-forget immediately after
 *   routing assigns a specialist. Fire-and-forget ensures routing never fails due
 *   to an OpenClaw connectivity issue.
 *
 * GUARDS (all inside autoDispatchTask):
 *   1. Master / CEO agents → skip (routing artifacts; CEO orchestrates, specialists execute).
 *   2. No assigned_agent_id → skip.
 *   3. Already in_progress / review / done / blocked / archived → skip.
 *   4. QC loop cap: qc_reroute_attempts > QC_MAX_REROUTES → skip (task already blocked).
 *   5. Fire-and-forget: errors logged, never thrown. Routing always succeeds.
 *
 * USAGE (call after routing sets assigned_agent_id):
 *   // non-blocking — routing must not fail if OpenClaw is down
 *   void autoDispatchTask(taskId, 'createTaskCore');
 *
 * INTEGRATION POINTS (v4.14.0):
 *   - src/lib/tasks.ts           — after in-process routing in createTaskCore
 *   - src/app/api/webhooks/auto-route/route.ts — after routing UPDATE
 *   - src/lib/jobs/ceo-delegation-sweep.ts    — after re-routing QC-fail tasks
 */

import { v4 as uuidv4 } from 'uuid';
import * as fs from 'fs';
import * as path from 'path';
import { queryOne, run } from '@/lib/db';
import { getOpenClawClient } from '@/lib/openclaw/client';
import { broadcast } from '@/lib/events';
import { getMissionControlUrl } from '@/lib/config';
import { resolveAndLog, resolveSpecialistType } from '@/lib/intelligence-resolver';
import { checkModelSovereignty, detectModality, type ModelSovereigntyViolation } from '@/lib/model-selector';
import { listModels } from '@/lib/model-registry';
import { getBestSOPForTask } from '@/lib/sops';
import { QC_MAX_REROUTES } from '@/lib/qc-scorer';
import { isCanonicalContext, copyCanonicalSOPForTask, authorSOPForTask } from '@/lib/sop-authoring';
import { artifactDispatchPayload } from '@/lib/task-lifecycle';
import type { SOP, SOPStep } from '@/lib/sops';
import type { Task, Agent, OpenClawSession } from '@/lib/types';

// Statuses where dispatch must not re-fire.
const SKIP_STATUSES = new Set(['in_progress', 'review', 'done', 'blocked', 'archived']);

/**
 * FIX 1 — resolveSpecialistSessionKey
 *
 * Every dispatch previously used the hardcoded prefix `agent:main:` which
 * always routes to the CEO orchestrator runtime (Stefanie / "main"). That
 * agent's prompt forbids building work — it re-ingests the task, creating an
 * infinite loop with zero artifacts.
 *
 * This function maps an assigned specialist agent to the correct OpenClaw
 * runtime key:
 *   • It reads the agent's workspace slug from the DB (via workspace_id).
 *   • It checks whether ~/.openclaw/agents/<slug>/ exists on disk — the
 *     presence of that directory proves a builder runtime is configured.
 *   • If found, returns `agent:<slug>:<openclaw_session_id>`.
 *   • Safe fallback: if no specialist runtime resolves (unknown dept, fresh
 *     install), keeps the legacy `agent:main:<id>` and logs a warning so
 *     no other department breaks silently.
 *
 * The dept-presentations builder runtime is one concrete example:
 *   ~/.openclaw/agents/dept-presentations/ → key agent:dept-presentations:<session>
 */
function resolveSpecialistSessionKey(
  agent: Agent,
  openclawSessionId: string,
  workspaceId: string | undefined,
  context: string,
): string | null {
  const AGENTS_ROOT = path.join(
    process.env.HOME ?? '/Users/blackceomacmini',
    '.openclaw',
    'agents',
  );

  // Attempt 1: lookup workspace slug from DB.
  if (workspaceId) {
    try {
      const ws = queryOne<{ slug: string }>(
        'SELECT slug FROM workspaces WHERE id = ? LIMIT 1',
        [workspaceId],
      );
      if (ws?.slug) {
        const candidateSlug = ws.slug.toLowerCase();
        // Check BOTH the bare slug dir AND the dept- prefixed dir.
        // On live boxes the runtime dirs are dept-funnels / dept-web-development
        // (bare ones do NOT exist), so we must probe the dept- prefix first.
        const deptPrefixedSlug = `dept-${candidateSlug}`;
        const deptPrefixedDir = path.join(AGENTS_ROOT, deptPrefixedSlug);
        const bareDir = path.join(AGENTS_ROOT, candidateSlug);
        if (fs.existsSync(deptPrefixedDir)) {
          const key = `agent:${deptPrefixedSlug}:${openclawSessionId}`;
          console.log(`[${context}] resolveSpecialistSessionKey: workspace slug "${candidateSlug}" → dept-prefixed runtime found → key ${key}`);
          return key;
        }
        if (fs.existsSync(bareDir)) {
          const key = `agent:${candidateSlug}:${openclawSessionId}`;
          console.log(`[${context}] resolveSpecialistSessionKey: workspace slug "${candidateSlug}" → bare runtime found → key ${key}`);
          return key;
        }
        console.warn(`[${context}] resolveSpecialistSessionKey: workspace slug "${candidateSlug}" has no runtime dir at ${deptPrefixedDir} or ${bareDir} — trying agent role slug`);
      }
    } catch (err) {
      console.warn(`[${context}] resolveSpecialistSessionKey: workspace lookup failed (non-fatal):`, (err as Error).message);
    }
  }

  // Attempt 2: derive a slug from the agent's role field (e.g. "Presentations Lead" → "dept-presentations").
  if (agent.role) {
    const roleSlug = `dept-${agent.role.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '')}`;
    const runtimeDir = path.join(AGENTS_ROOT, roleSlug);
    if (fs.existsSync(runtimeDir)) {
      const key = `agent:${roleSlug}:${openclawSessionId}`;
      console.log(`[${context}] resolveSpecialistSessionKey: role slug "${roleSlug}" → runtime found → key ${key}`);
      return key;
    }
  }

  // Attempt 3: try agent name slug directly (e.g. agent named "dept-presentations").
  const nameSlug = agent.name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
  if (nameSlug) {
    const runtimeDir = path.join(AGENTS_ROOT, nameSlug);
    if (fs.existsSync(runtimeDir)) {
      const key = `agent:${nameSlug}:${openclawSessionId}`;
      console.log(`[${context}] resolveSpecialistSessionKey: name slug "${nameSlug}" → runtime found → key ${key}`);
      return key;
    }
  }

  // RESOLVER-DISPATCH FIX (Gap E): NO per-department runtime resolved.
  //
  // The legacy behavior silently returned `agent:main:<id>` — the CEO/Stefanie
  // orchestrator, whose prompt FORBIDS building. That key re-ingests the task
  // into the loop-gate, burns turns, and produces ZERO artifacts; worse, the
  // silent fallback HIDES the misroute (the card looks dispatched but nothing
  // is built). We refuse the agent:main fallback and return null so the caller
  // can emit a loud, queryable 'routed but not dispatched' signal and HOLD the
  // task (visible) instead of feeding the loop. This changes the loop-gate's
  // VISIBILITY/AVOIDANCE only — not the loop-gate behavior itself.
  console.error(
    `[${context}] resolveSpecialistSessionKey: NO specialist runtime for agent "${agent.name}" ` +
    `(workspace_id=${workspaceId ?? 'none'}, role=${agent.role ?? 'none'}). ` +
    `REFUSING silent agent:main fallback — task will be held as 'routed but not dispatched'. ` +
    `Add ~/.openclaw/agents/<dept-slug>/ to wire this department.`,
  );
  return null;
}

/**
 * Auto-dispatch a newly-routed task to its assigned specialist via OpenClaw.
 *
 * Fire-and-forget: `void autoDispatchTask(taskId, ctx)` — never awaited on the
 * routing hot-path.
 */
export async function autoDispatchTask(
  taskId: string,
  context = 'auto-dispatch',
): Promise<void> {
  try {
    // ── Load task (join agent for is_master check) ──────────────────────────
    const task = queryOne<
      Task & { is_master?: number | boolean; workspace_id: string }
    >(
      `SELECT t.*, a.is_master
       FROM tasks t
       LEFT JOIN agents a ON t.assigned_agent_id = a.id
       WHERE t.id = ?`,
      [taskId],
    );

    if (!task) {
      console.warn(`[${context}] autoDispatchTask: task ${taskId} not found — skipping`);
      return;
    }

    // GUARD 1: must have an assigned agent.
    if (!task.assigned_agent_id) {
      console.warn(`[${context}] autoDispatchTask: task ${taskId} has no assigned_agent_id — skipping`);
      return;
    }

    // GUARD 2: skip master/CEO agents — they are routing artifacts.
    const isMaster =
      task.is_master === 1 || task.is_master === true;
    if (isMaster) {
      console.log(
        `[${context}] autoDispatchTask: task ${taskId} assigned to master/CEO — operator-click only`,
      );
      return;
    }

    // GUARD 3: skip terminal statuses.
    if (SKIP_STATUSES.has(task.status)) {
      console.log(
        `[${context}] autoDispatchTask: task ${taskId} already "${task.status}" — skip`,
      );
      return;
    }

    // GUARD 4: QC loop cap.
    const qcAttempts = (task as Task).qc_reroute_attempts ?? 0;
    if (qcAttempts > QC_MAX_REROUTES) {
      console.warn(
        `[${context}] autoDispatchTask: task ${taskId} hit QC cap (${qcAttempts}/${QC_MAX_REROUTES}) — blocked`,
      );
      return;
    }

    // GUARD 5 (PRD 2.12-cc): recursion guard — SOP-authoring sub-tasks MUST NOT
    // trigger the fast loop themselves (infinite recursion prevention).
    const sopAuthoringLink = (task as Task & { sop_authoring_for_task_id?: string | null }).sop_authoring_for_task_id;
    if (sopAuthoringLink) {
      console.log(
        `[${context}] autoDispatchTask: task ${taskId} is a SOP-authoring sub-task (for ${sopAuthoringLink}) — skipping fast loop`,
      );
      // Fall through to normal dispatch (the sub-task itself is just a regular task).
    }

    // ── Load full agent row ─────────────────────────────────────────────────
    const agent = queryOne<Agent>(
      'SELECT * FROM agents WHERE id = ?',
      [task.assigned_agent_id],
    );

    if (!agent) {
      console.warn(
        `[${context}] autoDispatchTask: agent ${task.assigned_agent_id} not found — skipping`,
      );
      return;
    }

    // Double-check on the live agent row (covers stale JOIN snapshots).
    if (agent.is_master) {
      console.log(
        `[${context}] autoDispatchTask: agent "${agent.name}" is_master=1 — skipping`,
      );
      return;
    }

    const now = new Date().toISOString();

    // ── OpenClaw connection ─────────────────────────────────────────────────
    const client = getOpenClawClient();
    if (!client.isConnected()) {
      try {
        await client.connect();
      } catch (connectErr) {
        console.error(
          `[${context}] autoDispatchTask: OpenClaw connect failed for task ${taskId}:`,
          connectErr,
        );
        return;
      }
    }

    // ── Session: active or create ───────────────────────────────────────────
    let session = queryOne<OpenClawSession>(
      'SELECT * FROM openclaw_sessions WHERE agent_id = ? AND status = ?',
      [agent.id, 'active'],
    );

    if (!session) {
      const sessionId = uuidv4();
      const openclawSessionId = `mission-control-${agent.name.toLowerCase().replace(/\s+/g, '-')}`;

      // FIX 2: bind task_id so completion webhook / execution-reconcile can attribute the turn.
      // The task_id column + idx_openclaw_sessions_task index already exist in schema.ts:213/360.
      run(
        `INSERT INTO openclaw_sessions (id, agent_id, openclaw_session_id, channel, status, task_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [sessionId, agent.id, openclawSessionId, 'mission-control', 'active', task.id, now, now],
      );

      session = queryOne<OpenClawSession>(
        'SELECT * FROM openclaw_sessions WHERE id = ?',
        [sessionId],
      );

      run(
        `INSERT INTO events (id, type, agent_id, message, created_at) VALUES (?, ?, ?, ?, ?)`,
        [uuidv4(), 'agent_status_changed', agent.id, `${agent.name} session created`, now],
      );
    }

    if (!session) {
      console.error(
        `[${context}] autoDispatchTask: could not create session for agent ${agent.id}`,
      );
      return;
    }

    // ── Intelligence resolution ─────────────────────────────────────────────
    const settings = resolveAndLog(task.id, agent.id, task.workspace_id);
    const specialistType = resolveSpecialistType(agent);

    // ── AF-MODEL-SOVEREIGNTY gate ───────────────────────────────────────────
    // Block dispatch if resolved model is null, free default, forbidden, or
    // modality-wrong. Routes to needs_owner_input — never silently downgrades.
    const inventory = listModels();
    const required_modality = settings.required_modality ??
      detectModality(task.title, task.description);
    const sovereigntyViolation: ModelSovereigntyViolation | null = checkModelSovereignty(
      settings.model,
      inventory,
      required_modality,
    );
    if (sovereigntyViolation) {
      const blockMsg =
        `[af_model_sovereignty] Task "${task.title}" (${task.id}) BLOCKED — ` +
        `reason=${sovereigntyViolation.reason} model=${sovereigntyViolation.model_id ?? 'null'} ` +
        `modality=${sovereigntyViolation.required_modality ?? 'unknown'} ` +
        `agent=${agent.name}. Owner input required.`;
      console.warn(`[${context}] ${blockMsg}`);
      const now2 = new Date().toISOString();
      run(
        `INSERT INTO task_activities (id, task_id, agent_id, activity_type, message, metadata, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          uuidv4(), task.id, agent.id, 'af_model_sovereignty_block', blockMsg,
          JSON.stringify(sovereigntyViolation), now2,
        ],
      );
      run(
        `INSERT INTO events (id, type, agent_id, task_id, message, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [uuidv4(), 'af_model_sovereignty_block', agent.id, task.id, blockMsg, now2],
      );
      // Leave task in backlog (no status change) so owner can assign a model.
      return;
    }
    // ── End AF-MODEL-SOVEREIGNTY gate ──────────────────────────────────────

    console.log(
      `[${context}] autoDispatchTask: Task "${task.title}" (${task.id}) → "${agent.name}" | model=${settings.model} (${settings.modelSource}) | modality=${required_modality} | specialist=${specialistType}`,
    );

    // ── SOP pull ────────────────────────────────────────────────────────────
    let resolvedSopId = task.sop_id ?? null;
    if (!resolvedSopId) {
      try {
        const best = await getBestSOPForTask({
          title: task.title,
          description: task.description ?? undefined,
          department: task.department ?? undefined,
          workspace_id: task.workspace_id ?? undefined,
        });
        if (best) resolvedSopId = best.id;
      } catch {
        /* non-fatal */
      }
    }

    // ── PRD 2.12-cc: no-SOP detection → fast loop or canonical copy ──────────
    // Only fires when:
    //   (a) still no SOP after the pull above,
    //   (b) the fast-loop kill switch is NOT set,
    //   (c) this task is NOT itself a SOP-authoring sub-task (recursion guard).
    if (!resolvedSopId && process.env.DISABLE_SOP_FAST_LOOP !== '1' && !sopAuthoringLink) {
      try {
        const deptSlug = task.department ?? task.workspace_id ?? '';
        const agentRoleSlug = agent.role ?? null;
        const ctx = isCanonicalContext(deptSlug, agentRoleSlug);

        if (ctx.canonical) {
          // Canonical path: copy from library (near-zero tokens).
          const copied = copyCanonicalSOPForTask(
            { title: task.title, description: task.description, department: task.department, workspace_id: task.workspace_id },
            agentRoleSlug,
          );
          if (copied) {
            resolvedSopId = copied.id;
            // Attach the library SOP to the task for future dispatches.
            run(`UPDATE tasks SET sop_id = ?, updated_at = ? WHERE id = ?`, [
              copied.id,
              new Date().toISOString(),
              task.id,
            ]);
            console.log(`[${context}] autoDispatchTask: canonical SOP copy "${copied.name}" attached to task ${taskId}`);
          } else {
            // No library row → loud library-gap event; dispatch proceeds SOP-less.
            const gapMsg = `[sop_library_gap] Canonical dept "${deptSlug}" has no role-library SOP for task "${task.title}" (${taskId}). Library/build gap — human review required.`;
            console.warn(gapMsg);
            run(
              `INSERT INTO events (id, type, task_id, message, created_at) VALUES (?, 'sop_library_gap', ?, ?, ?)`,
              [uuidv4(), taskId, gapMsg, new Date().toISOString()],
            );
          }
        } else {
          // Custom dept → fire the authoring fast loop and HOLD this dispatch.
          // The original task stays in backlog; authorSOPForTask will re-fire
          // dispatch (via 'sop-authored-resume') after the SOP is filed.
          console.log(`[${context}] autoDispatchTask: custom dept "${deptSlug}" — firing SOP authoring fast loop for task ${taskId}`);
          void authorSOPForTask({
            originalTaskId: task.id,
            title: task.title,
            description: task.description ?? null,
            department: task.department ?? null,
            agentRoleSlug,
            workspaceId: task.workspace_id ?? null,
          });
          return; // HOLD: abort this dispatch; authorSOPForTask re-fires it.
        }
      } catch (fastLoopErr) {
        // Fast loop errors are non-fatal — dispatch proceeds SOP-less.
        console.error(`[${context}] autoDispatchTask: fast-loop error (non-fatal):`, (fastLoopErr as Error).message);
      }
    }
    // ── End PRD 2.12-cc fast loop ──────────────────────────────────────────────

    let sopBlock = '';
    if (resolvedSopId) {
      const sop = queryOne<SOP>(
        `SELECT id, name, steps, success_criteria, department, role
         FROM sops WHERE id = ? AND deleted_at IS NULL`,
        [resolvedSopId],
      );
      if (sop) {
        let parsedSteps: SOPStep[] = [];
        try {
          parsedSteps =
            typeof sop.steps === 'string'
              ? JSON.parse(sop.steps)
              : (sop.steps as unknown as SOPStep[]);
        } catch {
          parsedSteps = [];
        }
        const stepLines = parsedSteps.map((s, i) => {
          const checklistLines = s.checklist?.length
            ? '\n' + s.checklist.map((c) => `     - ${c}`).join('\n')
            : '';
          const criteria = s.success_criteria ? `\n     ✓ ${s.success_criteria}` : '';
          return `  ${i + 1}. **${s.name}**${checklistLines}${criteria}`;
        });
        sopBlock = `
**SOP: ${sop.name}** (id: ${sop.id})
${sop.success_criteria ? `**Success Criteria:** ${sop.success_criteria}\n` : ''}**Steps:**
${stepLines.join('\n')}
`;
      }
    }

    // ── Build task message (identical spec to dispatch/route.ts) ───────────
    const priorityEmoji =
      ({ low: '🔵', medium: '⚪', high: '🟡', critical: '🔴' } as Record<string, string>)[
        task.priority
      ] ?? '⚪';

    // ── Artifact save path (duck-fix) ──────────────────────────────────────
    // §3 Artifact Contract: artifacts live at <PROJECTS_PATH>/artifacts/<task-id>/
    // The specialist is TOLD the exact directory via ARTIFACT_DIR in the dispatch
    // message — it never chooses its own path.  ensureArtifactDir() creates the
    // directory at dispatch time so the specialist can write immediately.
    const missionControlUrl = getMissionControlUrl();
    const { artifactDir: taskArtifactDir, messageFragment: artifactFragment } =
      artifactDispatchPayload(task.id);

    const taskMessage = `${priorityEmoji} **NEW TASK ASSIGNED**

**Title:** ${task.title}
${task.description ? `**Description:** ${task.description}\n` : ''}
**Priority:** ${task.priority.toUpperCase()}
${task.due_date ? `**Due:** ${task.due_date}\n` : ''}
**Task ID:** ${task.id}
${sopBlock ? `${sopBlock}` : ''}**Agent Model:** ${settings.model}
**Agent Persona:** ${
      settings.persona === 'auto'
        ? 'AUTO-SELECT. Run the 5-Layer Persona Matching Protocol before starting:'
        : settings.persona
    }
${
  settings.persona === 'auto'
    ? `
1. **Layer 1 (Company Mission):** Does this persona align with the company's stated mission?
2. **Layer 2 (Owner Values):** Does this persona match the owner's beliefs and style (see USER.md)?
3. **Layer 3 (Company Goals):** Does this persona support the company's current goals/KPIs?
4. **Layer 4 (Department Goals):** Does this persona fit this department's objectives/KPIs?
5. **Layer 5 (Task Fit):** Is this persona the right guide for THIS specific task?

After selecting, log your choice to persona-selection-log.md:
[date] [task-id] [candidates-considered] [selected-persona] [layer-3-reason] [layer-4-reason] [layer-5-reason]`
    : ''
}
**Specialist Type:** ${specialistType}
${artifactFragment}
**IMPORTANT:** After completing work, you MUST call these APIs:
1. Log activity: POST ${missionControlUrl}/api/tasks/${task.id}/activities
   Body: {"activity_type": "completed", "message": "Description of what was done"}
2. Register deliverable: POST ${missionControlUrl}/api/tasks/${task.id}/deliverables
   Body: {"deliverable_type": "artifact", "title": "File name", "path": "${taskArtifactDir}/filename.png"}
3. Update status: PATCH ${missionControlUrl}/api/tasks/${task.id}
   Body: {"status": "review"}

When complete, reply with:
\`TASK_COMPLETE: [brief summary of what you did]\`

If you need help or clarification, ask the orchestrator.`;

    // ── chat.send (same contract as dispatch/route.ts) ──────────────────────
    // FIX 1: resolve the specialist's actual OpenClaw runtime key instead of
    // always targeting agent:main (the CEO/Stefanie orchestrator, whose prompt
    // forbids building and re-ingests the task, causing infinite loops).
    //
    // Mapping logic:
    //   1. If agent.workspace_id matches a known ~/.openclaw/agents/<slug>
    //      directory we derive the runtime slug from the workspace slug and use
    //      agent:<slug>:<openclaw_session_id>.
    //   2. Fallback: if no specialist runtime is resolvable we keep the legacy
    //      agent:main:… key and log a warning so other departments are not broken.
    const sessionKey = resolveSpecialistSessionKey(agent, session.openclaw_session_id, task.workspace_id, context);

    // ── RESOLVER-DISPATCH gate (Gap E) ─────────────────────────────────────
    // No per-department OpenClaw runtime → do NOT silently dispatch to
    // agent:main (the CEO orchestrator), which re-ingests the task into the
    // loop-gate and builds nothing. Instead HOLD the task in backlog and emit a
    // loud, queryable 'routed_but_not_dispatched' signal so the misroute is
    // visible (pairs with the wiring-gate assertion). Same hold pattern as the
    // AF-MODEL-SOVEREIGNTY block above: no status change, durable events.
    if (!sessionKey) {
      const holdMsg =
        `[routed_but_not_dispatched] Task "${task.title}" (${task.id}) routed to "${agent.name}" ` +
        `but NO per-department OpenClaw runtime exists (~/.openclaw/agents/<dept-slug>/ missing; ` +
        `workspace_id=${task.workspace_id ?? 'none'}, role=${agent.role ?? 'none'}). ` +
        `Dispatch HELD to avoid the agent:main re-ingest loop. Wire the department runtime to release.`;
      console.error(`[${context}] ${holdMsg}`);
      const nowHold = new Date().toISOString();
      run(
        `INSERT INTO task_activities (id, task_id, agent_id, activity_type, message, metadata, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          uuidv4(), task.id, agent.id, 'routed_but_not_dispatched', holdMsg,
          JSON.stringify({
            workspace_id: task.workspace_id ?? null,
            role: agent.role ?? null,
            reason: 'no_specialist_runtime',
          }),
          nowHold,
        ],
      );
      run(
        `INSERT INTO events (id, type, agent_id, task_id, message, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [uuidv4(), 'routed_but_not_dispatched', agent.id, task.id, holdMsg, nowHold],
      );
      // Leave task in backlog (no status change) so the misroute is visible.
      return;
    }

    await client.call('chat.send', {
      sessionKey,
      message: taskMessage,
      idempotencyKey: `auto-dispatch-${task.id}-${Date.now()}`,
    });

    // ── Advance task to in_progress via lifecycle transition ───────────────
    // Pin model_id first (not part of the state machine itself), then transition.
    if (settings.model) {
      run('UPDATE tasks SET model_id = ?, updated_at = ? WHERE id = ?', [settings.model, now, task.id]);
    }

    try {
      const { transition } = await import('@/lib/task-lifecycle');
      await transition(task.id, 'in_progress', { actor: agent.id, reason: `[${context}] auto-dispatched to ${agent.name}` });
    } catch (tErr) {
      // transition() may throw if the task is already in_progress (concurrent dispatch).
      // Fall back to direct SQL to keep the fire-and-forget guarantee.
      console.warn(`[${context}] autoDispatchTask: transition() failed (${(tErr as Error).message}), falling back to direct SQL`);
      run('UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?', ['in_progress', now, task.id]);
      const updatedTask = queryOne<Task>('SELECT * FROM tasks WHERE id = ?', [task.id]);
      if (updatedTask) broadcast({ type: 'task_updated', payload: updatedTask });
    }

    // ── Agent status → working ──────────────────────────────────────────────
    run('UPDATE agents SET status = ?, updated_at = ? WHERE id = ?', ['working', now, agent.id]);

    // ── Audit events ────────────────────────────────────────────────────────
    run(
      `INSERT INTO events (id, type, agent_id, task_id, message, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        uuidv4(),
        'task_dispatched',
        agent.id,
        task.id,
        `[${context}] Task "${task.title}" auto-dispatched to ${agent.name}`,
        now,
      ],
    );

    run(
      `INSERT INTO task_activities (id, task_id, agent_id, activity_type, message, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        uuidv4(),
        task.id,
        agent.id,
        'status_changed',
        `[${context}] Task auto-dispatched to ${agent.name} — Agent is now working on this task`,
        now,
      ],
    );

    console.log(
      `[${context}] autoDispatchTask: Task "${task.title}" (${task.id}) → "${agent.name}" → in_progress ✓`,
    );
  } catch (err) {
    // Fire-and-forget: NEVER throw — routing must succeed even if dispatch fails.
    console.error(
      `[${context}] autoDispatchTask: failed for task ${taskId}: ${(err as Error).message}`,
    );
  }
}
