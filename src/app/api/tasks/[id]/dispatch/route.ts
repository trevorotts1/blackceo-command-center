import { NextRequest, NextResponse } from 'next/server';
import * as fs from 'fs';
import * as path from 'path';
import os from 'os';
import { v4 as uuidv4 } from 'uuid';
import { queryOne, queryAll, run } from '@/lib/db';
import { getOpenClawClient } from '@/lib/openclaw/client';
import { broadcast } from '@/lib/events';
import { getProjectsPath, getMissionControlUrl } from '@/lib/config';
import { detectPlatform } from '@/lib/platform';
import { resolveAndLog, resolveSpecialistType } from '@/lib/intelligence-resolver';
import { buildPersonaBlock, buildPersonaPlanBlock } from '@/lib/persona-dispatch';
import { loadSubtaskPersonas } from '@/lib/persona-selector';
import { checkModelSovereignty, detectModality } from '@/lib/model-selector';
import { listModels } from '@/lib/model-registry';
import { canonicalDeptSlug } from '@/lib/routing/canonical-slug';
import { recordDispatchFailure } from '@/lib/task-dispatcher';
import type { SOP, SOPStep } from '@/lib/sops';
import type { Task, Agent, OpenClawSession } from '@/lib/types';
import { notifyOwnerStarted } from '@/lib/owner-reports';
import { matchSkillsForTask, renderMatchedSkillsSection } from '@/lib/context-pack';

/**
 * P1-5 FIX — no hardcoded operator home.
 *
 * Was `process.env.HOME ?? <hardcoded operator absolute path>`: when HOME is
 * unset (PM2/systemd/container contexts), a CLIENT box silently resolved the
 * OPERATOR's own home path — wrong runtime dir AND an operator-identifying
 * string baked into a fleet-wide repo.
 *
 * Mirrors the established platform convention (src/lib/platform.ts
 * detectPlatform() + src/lib/context-pack.ts agentsRoot()): VPS Docker
 * installs keep `/data/.openclaw` as the persistent-volume marker, and any
 * home-relative fallback resolves via `os.homedir()`, never a literal path.
 */
function homeDir(): string {
  return process.env.HOME || process.env.USERPROFILE || os.homedir();
}

const AGENTS_ROOT = detectPlatform() === 'vps-docker'
  ? '/data/.openclaw/agents'
  : path.join(homeDir(), '.openclaw', 'agents');

/**
 * FIX 1 — resolveSpecialistSessionKey (route handler copy)
 *
 * Maps an assigned specialist agent to its actual OpenClaw runtime key.
 * Previously hardcoded to `agent:main:…`, which routes every dispatch to the
 * CEO orchestrator (Stefanie) whose prompt forbids building — she re-ingests
 * the task, causing an infinite loop.
 *
 * Resolution order:
 *   1. workspace slug → ~/.openclaw/agents/dept-<slug>/ THEN ~/.openclaw/agents/<slug>/
 *      (live box dirs are dept-funnels / dept-web-development; bare dirs do NOT exist)
 *   2. role-derived slug → ~/.openclaw/agents/dept-<role>/
 *   3. agent name slug → ~/.openclaw/agents/<name>/
 *   4. No runtime found → return null (HOLD; do NOT fall back to agent:main).
 *      The caller must NOT flip status to in_progress — log routed_but_not_dispatched instead.
 *
 * Kept byte-for-byte equivalent with the task-dispatcher.ts copy in Attempt 1
 * dept-prefix logic to satisfy the CC QC lockstep check.
 */
function resolveSpecialistSessionKey(
  agent: Agent,
  openclawSessionId: string,
  workspaceId: string | undefined,
): string | null {
  // Attempt 1: workspace slug — probe dept-prefixed dir FIRST, then bare.
  // On live boxes the runtime dirs are dept-funnels / dept-web-development;
  // bare workspace-slug dirs do NOT exist, so the dept- probe must come first.
  if (workspaceId) {
    try {
      const ws = queryOne<{ slug: string }>(
        'SELECT slug FROM workspaces WHERE id = ? LIMIT 1',
        [workspaceId],
      );
      if (ws?.slug) {
        const candidateSlug = ws.slug.toLowerCase();
        // Check BOTH the bare slug dir AND the dept- prefixed dir.
        const deptPrefixedSlug = `dept-${candidateSlug}`;
        const deptPrefixedDir = path.join(AGENTS_ROOT, deptPrefixedSlug);
        const bareDir = path.join(AGENTS_ROOT, candidateSlug);
        if (fs.existsSync(deptPrefixedDir)) {
          const key = `agent:${deptPrefixedSlug}:${openclawSessionId}`;
          console.log(`[Dispatch] resolveSpecialistSessionKey: workspace slug "${candidateSlug}" → dept-prefixed runtime found → key ${key}`);
          return key;
        }
        if (fs.existsSync(bareDir)) {
          const key = `agent:${candidateSlug}:${openclawSessionId}`;
          console.log(`[Dispatch] resolveSpecialistSessionKey: workspace slug "${candidateSlug}" → bare runtime found → key ${key}`);
          return key;
        }
        // Attempt 1b — legacy/aliased slug → CANONICAL runtime. DISP-06: ported
        // from task-dispatcher.ts so the route (manual "Send to Agent") copy no
        // longer DRIFTS from the auto-dispatch copy. A workspace slug like `ceo`
        // or `app-development` has its runtime dir under the canonical name
        // (`master-orchestrator`, `engineering`); probe the canonical slug before
        // giving up so an aliased department DISPATCHES instead of falsely
        // reporting no_specialist_runtime.
        const canonicalSlug = canonicalDeptSlug(candidateSlug);
        if (canonicalSlug && canonicalSlug !== candidateSlug) {
          const canonDeptDir = path.join(AGENTS_ROOT, `dept-${canonicalSlug}`);
          const canonBareDir = path.join(AGENTS_ROOT, canonicalSlug);
          if (fs.existsSync(canonDeptDir)) {
            const key = `agent:dept-${canonicalSlug}:${openclawSessionId}`;
            console.log(`[Dispatch] resolveSpecialistSessionKey: slug "${candidateSlug}" → canonical "${canonicalSlug}" → dept-prefixed runtime → key ${key}`);
            return key;
          }
          if (fs.existsSync(canonBareDir)) {
            const key = `agent:${canonicalSlug}:${openclawSessionId}`;
            console.log(`[Dispatch] resolveSpecialistSessionKey: slug "${candidateSlug}" → canonical "${canonicalSlug}" → bare runtime → key ${key}`);
            return key;
          }
        }
        console.warn(`[Dispatch] resolveSpecialistSessionKey: workspace slug "${candidateSlug}" (canonical "${canonicalDeptSlug(candidateSlug)}") has no runtime dir at ${deptPrefixedDir} or ${bareDir} — trying role slug`);
      }
    } catch (err) {
      console.warn(`[Dispatch] resolveSpecialistSessionKey: workspace lookup failed (non-fatal):`, (err as Error).message);
    }
  }

  // Attempt 2: role-derived slug.
  if (agent.role) {
    const roleSlug = `dept-${agent.role.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '')}`;
    if (fs.existsSync(path.join(AGENTS_ROOT, roleSlug))) {
      const key = `agent:${roleSlug}:${openclawSessionId}`;
      console.log(`[Dispatch] resolveSpecialistSessionKey: role slug "${roleSlug}" → key ${key}`);
      return key;
    }
  }

  // Attempt 3: agent name slug.
  const nameSlug = agent.name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
  if (nameSlug && fs.existsSync(path.join(AGENTS_ROOT, nameSlug))) {
    const key = `agent:${nameSlug}:${openclawSessionId}`;
    console.log(`[Dispatch] resolveSpecialistSessionKey: name slug "${nameSlug}" → key ${key}`);
    return key;
  }

  // RESOLVER-DISPATCH FIX: NO per-department runtime resolved.
  //
  // Refuse the agent:main fallback — the CEO/Stefanie orchestrator's prompt
  // FORBIDS building; routing there re-ingests the task, burns turns, and
  // produces ZERO artifacts. Return null so the caller can HOLD the task
  // (visible as routed_but_not_dispatched) rather than feed the CEO loop.
  // Matches the hardened null-return in task-dispatcher.ts:139-153.
  console.error(
    `[Dispatch] resolveSpecialistSessionKey: NO specialist runtime for agent "${agent.name}" ` +
    `(workspace_id=${workspaceId ?? 'none'}, role=${agent.role ?? 'none'}). ` +
    `REFUSING silent agent:main fallback — task will be held as 'routed_but_not_dispatched'. ` +
    `Add ~/.openclaw/agents/<dept-slug>/ to wire this department.`,
  );
  return null;
}

export const dynamic = 'force-dynamic';
export const revalidate = 0;

interface RouteParams {
  params: Promise<{ id: string }>;
}

/**
 * POST /api/tasks/[id]/dispatch
 * 
 * Dispatches a task to its assigned agent's OpenClaw session.
 * Creates session if needed, sends task details to agent.
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params;

    // Get task with agent info
    const task = queryOne<Task & { assigned_agent_name?: string; workspace_id: string }>(
      `SELECT t.*, a.name as assigned_agent_name, a.is_master
       FROM tasks t
       LEFT JOIN agents a ON t.assigned_agent_id = a.id
       WHERE t.id = ?`,
      [id]
    );

    if (!task) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }

    if (!task.assigned_agent_id) {
      return NextResponse.json(
        { error: 'Task has no assigned agent' },
        { status: 400 }
      );
    }

    // Get agent details
    const agent = queryOne<Agent>(
      'SELECT * FROM agents WHERE id = ?',
      [task.assigned_agent_id]
    );

    if (!agent) {
      return NextResponse.json({ error: 'Assigned agent not found' }, { status: 404 });
    }

    // Check if dispatching to the master agent while there are other orchestrators available
    if (agent.is_master) {
      // Check for other master agents in the same workspace (excluding this one)
      const otherOrchestrators = queryAll<{
        id: string;
        name: string;
        role: string;
      }>(
        `SELECT id, name, role
         FROM agents
         WHERE is_master = 1
         AND id != ?
         AND workspace_id = ?
         AND status != 'offline'`,
        [agent.id, task.workspace_id]
      );

      if (otherOrchestrators.length > 0) {
        return NextResponse.json({
          success: false,
          warning: 'Other orchestrators available',
          message: `There ${otherOrchestrators.length === 1 ? 'is' : 'are'} ${otherOrchestrators.length} other orchestrator${otherOrchestrators.length === 1 ? '' : 's'} available in this workspace: ${otherOrchestrators.map(o => o.name).join(', ')}. Consider assigning this task to them instead.`,
          otherOrchestrators,
        }, { status: 409 }); // 409 Conflict - indicating there's an alternative
      }
    }

    // Connect to OpenClaw Gateway
    const client = getOpenClawClient();
    if (!client.isConnected()) {
      try {
        await client.connect();
      } catch (err) {
        console.error('Failed to connect to OpenClaw Gateway:', err);
        return NextResponse.json(
          { error: 'Failed to connect to the backend gateway' },
          { status: 503 }
        );
      }
    }

    // Get or create OpenClaw session for this agent
    let session = queryOne<OpenClawSession>(
      'SELECT * FROM openclaw_sessions WHERE agent_id = ? AND status = ?',
      [agent.id, 'active']
    );

    const now = new Date().toISOString();

    if (!session) {
      // Create session record
      const sessionId = uuidv4();
      const openclawSessionId = `mission-control-${agent.name.toLowerCase().replace(/\s+/g, '-')}`;
      
      // FIX 2: bind task_id so completion webhook / execution-reconcile can attribute the turn.
      // The task_id column + idx_openclaw_sessions_task index already exist in schema.ts:213/360.
      run(
        `INSERT INTO openclaw_sessions (id, agent_id, openclaw_session_id, channel, status, task_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [sessionId, agent.id, openclawSessionId, 'mission-control', 'active', id, now, now]
      );

      session = queryOne<OpenClawSession>(
        'SELECT * FROM openclaw_sessions WHERE id = ?',
        [sessionId]
      );

      // Log session creation
      run(
        `INSERT INTO events (id, type, agent_id, message, created_at)
         VALUES (?, ?, ?, ?, ?)`,
        [uuidv4(), 'agent_status_changed', agent.id, `${agent.name} session created`, now]
      );
    }

    if (!session) {
      return NextResponse.json(
        { error: 'Failed to create agent session' },
        { status: 500 }
      );
    }

    // --- INTELLIGENCE SETTINGS RESOLUTION ---
    // Resolve which model and persona this dispatch should use.
    // Resolution order: role override > department default > hardcoded default.
    const settings = resolveAndLog(task.id, agent.id, task.workspace_id);
    const specialistType = resolveSpecialistType(agent);

    // ── SYNCHRONOUS PERSONA DISPATCH GATE (F3.1 / F4.1 — heal, not stall) ────
    // Mirror of the auto-dispatch path: resolveAndLog delivers a pinned persona
    // (Hop 10). If the task is naked, settings.persona is the 'auto' self-select
    // sentinel — heal it deterministically here and deliver the pinned persona
    // instead of telling the doer to self-select (F3.6). Never stalls the board.
    if (settings.persona === 'auto') {
      try {
        const { ensurePersonaForDispatch } = await import('@/lib/tasks');
        const { canonicalDeptSlug } = await import('@/lib/routing/canonical-slug');
        const healDept =
          canonicalDeptSlug(task.department || task.workspace_id || '') || 'general';
        const healed = ensurePersonaForDispatch(task.id, healDept);
        settings.persona = healed.persona_name;
        settings.personaMode = healed.persona_mode;
        console.warn(
          `[Dispatch] persona gate: task ${task.id} was naked — delivering ` +
            `${healed.healed ? 'healed' : 'pinned'} persona "${healed.persona_name}".`,
        );
      } catch (healErr) {
        console.error(`[Dispatch] persona gate failed for task ${task.id}:`, healErr);
      }
    }

    const dispatchInventory = listModels();
    const dispatchModality = settings.required_modality ??
      detectModality(task.title, task.description);
    const sovereigntyViolation = checkModelSovereignty(settings.model, dispatchInventory, dispatchModality);
    if (sovereigntyViolation) {
      const blockMsg =
        `AF-MODEL-SOVEREIGNTY: model=${sovereigntyViolation.model_id ?? 'null'} ` +
        `reason=${sovereigntyViolation.reason} modality=${sovereigntyViolation.required_modality ?? 'unknown'}`;
      console.warn(`[Dispatch] BLOCKED task ${task.id}: ${blockMsg}`);
      run(
        `INSERT INTO task_activities (id, task_id, agent_id, activity_type, message, metadata, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          uuidv4(), task.id, agent.id, 'af_model_sovereignty_block', blockMsg,
          JSON.stringify(sovereigntyViolation), new Date().toISOString(),
        ],
      );
      return NextResponse.json(
        {
          error: 'AF-MODEL-SOVEREIGNTY: no valid model resolved',
          detail: sovereigntyViolation,
          message: 'Assign a valid model to this agent or department before dispatching.',
        },
        { status: 422 },
      );
    }

    console.log(`[Dispatch] Task ${task.id} → Agent "${agent.name}" | model=${settings.model} (${settings.modelSource}) | modality=${dispatchModality} | persona=${settings.persona} (${settings.personaSource}) | specialist=${specialistType}`);
    // --- END INTELLIGENCE RESOLUTION ---

    // --- SOP PULL (RC-1) ---
    // JOIN sops on task.sop_id and embed name + steps + success_criteria so the
    // specialist has actionable instructions, not just raw task metadata.
    let sopBlock = '';
    let resolvedSopName: string | null = null; // W5.3: captured for START notification
    if (task.sop_id) {
      const sop = queryOne<SOP>(
        `SELECT id, name, steps, success_criteria, department, role FROM sops WHERE id = ? AND deleted_at IS NULL`,
        [task.sop_id]
      );
      if (sop) {
        resolvedSopName = sop.name;
        let parsedSteps: SOPStep[] = [];
        try {
          parsedSteps = typeof sop.steps === 'string' ? JSON.parse(sop.steps) : (sop.steps as unknown as SOPStep[]);
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
    // --- END SOP PULL ---

    // Build task message for agent
    const priorityEmoji = {
      low: '🔵',
      medium: '⚪',
      high: '🟡',
      critical: '🔴'
    }[task.priority] || '⚪';

    // Get project path for deliverables
    const projectsPath = getProjectsPath();
    const projectDir = task.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const taskProjectDir = `${projectsPath}/${projectDir}`;
    const missionControlUrl = getMissionControlUrl();

    // DEP-5 / F3.7 — mirror the fast-loop dispatcher: deliver the PERSONA PLAN
    // block for a decomposed multi-persona task. buildPersonaPlanBlock returns ''
    // for a single-persona task, so this path is a no-op regression there. Keeps
    // the two dispatch messages byte-identical for the persona section (FDN-3).
    const subtaskPlan = loadSubtaskPersonas(task.id);
    const personaPlanBlock = buildPersonaPlanBlock(subtaskPlan, settings);
    const personaSection = personaPlanBlock
      ? `${buildPersonaBlock(task, settings)}\n${personaPlanBlock}`
      : buildPersonaBlock(task, settings);

    // Layer A (departments-that-use-skills): match installed SKILL.md files to
    // the task and deliver the top-3 to the doer — parity with the auto path.
    // Never throws (degrades to '').
    let skillsBlock = '';
    try {
      const matchedSkills = await matchSkillsForTask({
        title: task.title,
        description: task.description,
        department: task.department,
      });
      skillsBlock = renderMatchedSkillsSection(matchedSkills);
    } catch {
      skillsBlock = '';
    }

    const taskMessage = `${priorityEmoji} **NEW TASK ASSIGNED**

**Title:** ${task.title}
${task.description ? `**Description:** ${task.description}\n` : ''}
**Priority:** ${task.priority.toUpperCase()}
${task.due_date ? `**Due:** ${task.due_date}\n` : ''}
**Task ID:** ${task.id}
${sopBlock ? `${sopBlock}` : ''}**Agent Model:** ${settings.model}
${personaSection}
**Specialist Type:** ${specialistType}
${skillsBlock}
**OUTPUT DIRECTORY:** ${taskProjectDir}
Create this directory and save all deliverables there.

**IMPORTANT:** After completing work, you MUST call these APIs:
1. Log activity: POST ${missionControlUrl}/api/tasks/${task.id}/activities
   Body: {"activity_type": "completed", "message": "Description of what was done"}
2. Register deliverable: POST ${missionControlUrl}/api/tasks/${task.id}/deliverables
   Body: {"deliverable_type": "file", "title": "File name", "path": "${taskProjectDir}/filename.html"}
3. Update status: PATCH ${missionControlUrl}/api/tasks/${task.id}
   Body: {"status": "review"}

When complete, reply with:
\`TASK_COMPLETE: [brief summary of what you did]\`

If you need help or clarification, ask the orchestrator.`;

    // FIX 1 (cont.): resolve the specialist's actual OpenClaw runtime key.
    // Returns null when no dept runtime dir exists — see resolveSpecialistSessionKey above.
    // Previously hardcoded to agent:main which always hit the CEO orchestrator
    // (Stefanie), whose prompt forbids building — she re-ingested the task,
    // causing an infinite CEO→ingest→CEO loop with zero artifacts produced.
    const sessionKey = resolveSpecialistSessionKey(agent, session.openclaw_session_id, task.workspace_id);

    // ── RESOLVER-DISPATCH gate (Gap E) — matches task-dispatcher.ts:518-553 ──
    // No per-department OpenClaw runtime → HOLD the task; do NOT flip to
    // in_progress; do NOT call agent:main. Emit a loud, queryable
    // 'routed_but_not_dispatched' event so the misroute is visible on the board.
    if (!sessionKey) {
      const holdMsg =
        `[routed_but_not_dispatched] Task "${task.title}" (${task.id}) routed to "${agent.name}" ` +
        `but NO per-department OpenClaw runtime exists (~/.openclaw/agents/<dept-slug>/ missing; ` +
        `workspace_id=${task.workspace_id ?? 'none'}, role=${agent.role ?? 'none'}). ` +
        `Dispatch HELD to avoid the agent:main re-ingest loop. Wire the department runtime to release.`;
      console.error(`[Dispatch] ${holdMsg}`);
      const nowHold = new Date().toISOString();
      run(
        `INSERT INTO task_activities (id, task_id, agent_id, activity_type, message, metadata, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          uuidv4(), task.id, agent.id, 'routed_but_not_dispatched', holdMsg,
          JSON.stringify({ workspace_id: task.workspace_id ?? null, role: agent.role ?? null, reason: 'no_specialist_runtime' }),
          nowHold,
        ],
      );
      run(
        `INSERT INTO events (id, type, agent_id, task_id, message, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [uuidv4(), 'routed_but_not_dispatched', agent.id, task.id, holdMsg, nowHold],
      );
      // DISP-07: this HOLD previously returned 202 with NO attempt-accounting,
      // so repeated dispatches of an un-wireable dept were never capped. Share
      // the auto path's anti-furnace accounting (recordDispatchFailure): back
      // off + BLOCK with a SYSTEM "wire the dept runtime" report once the cap is
      // hit, instead of returning an uncapped soft HOLD every time.
      recordDispatchFailure(task.id, agent.id, {
        reason: 'no_specialist_runtime',
        audience: 'SYSTEM',
        needs: `No OpenClaw runtime for "${agent.name}". Wire ~/.openclaw/agents/<dept-slug>/ to release this department.`,
        context: 'manual-dispatch',
      });
      // Leave task in backlog (no status change) so the misroute is visible on the board.
      return NextResponse.json(
        {
          success: false,
          held: true,
          reason: 'routed_but_not_dispatched',
          message: holdMsg,
        },
        { status: 202 },
      );
    }

    try {
      // Send message to agent's session using chat.send.
      //
      // GATEWAY CONTRACT (verified against installed OpenClaw 2026.5.28 source,
      // dist `ChatSendParamsSchema`): chat.send accepts ONLY
      //   { sessionKey, sessionId?, message, thinking?, fastMode?, deliver?,
      //     originating*?, attachments?, timeoutMs?, system*?, idempotencyKey }
      // with `additionalProperties: false`. It does NOT accept `model` or
      // `persona`; passing them makes the gateway REJECT the whole call with
      // INVALID_REQUEST. There is also no operator-callable `sessions.create`
      // RPC on this version that would let us set the model per session. So the
      // CC has no supported path to override the model per dispatch — the agent
      // runs on whatever model its own openclaw.json/agent config selects.
      //
      // The resolved model is therefore communicated to the agent in the task
      // message body (Agent Model / Agent Persona above) and pinned on the task
      // as the INTENDED model (see the 🤖 pill relabel in MissionQueue). We do
      // NOT claim it is the model that actually ran.
      // DISP-01: stable idempotency key (was `Date.now()`). Keyed on the attempt
      // counter so a genuine retry gets a fresh key while two sends racing the
      // same window share one → the gateway can dedup a concurrent double-send.
      await client.call('chat.send', {
        sessionKey,
        message: taskMessage,
        idempotencyKey: `dispatch-${task.id}-${task.dispatch_attempts ?? 0}`,
      });

      // Update task status to in_progress, and pin the resolved model_id so
      // the UI (MissionQueue 🤖 pill) and downstream auditing can show which
      // model this task was INTENDED to run on. NOTE: this is the model the CC
      // resolved/requested, not a gateway-confirmed runtime model — the gateway
      // selects the agent's own configured model (see contract note above). The
      // pill is labeled accordingly. v4.0.1 P0-7 / B1.
      run(
        'UPDATE tasks SET status = ?, model_id = ?, updated_at = ? WHERE id = ?',
        ['in_progress', settings.model || null, now, id]
      );

      // Broadcast task update
      const updatedTask = queryOne<Task>('SELECT * FROM tasks WHERE id = ?', [id]);
      if (updatedTask) {
        broadcast({
          type: 'task_updated',
          payload: updatedTask,
        });
      }

      // W5.3 — START owner notification (spec §5): persona + dept + specialist + SOP + role.
      // All five values are in local scope. Best-effort; gateway-routed; never blocks response.
      try {
        notifyOwnerStarted(id, {
          persona: settings.persona !== 'auto' ? settings.persona : null,
          department: task.department ?? null,
          specialist: agent.name,
          role: agent.role ?? null,
          sop: resolvedSopName,
        });
      } catch { /* non-fatal */ }

      // Update agent status to working
      run(
        'UPDATE agents SET status = ?, updated_at = ? WHERE id = ?',
        ['working', now, agent.id]
      );

      // Log dispatch event to events table
      const eventId = uuidv4();
      run(
        `INSERT INTO events (id, type, agent_id, task_id, message, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [eventId, 'task_dispatched', agent.id, task.id, `Task "${task.title}" dispatched to ${agent.name}`, now]
      );

      // Log dispatch activity to task_activities table (for Activity tab)
      const activityId = crypto.randomUUID();
      run(
        `INSERT INTO task_activities (id, task_id, agent_id, activity_type, message, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [activityId, task.id, agent.id, 'status_changed', `Task dispatched to ${agent.name} - Agent is now working on this task`, now]
      );

      return NextResponse.json({
        success: true,
        task_id: task.id,
        agent_id: agent.id,
        session_id: session.openclaw_session_id,
        message: 'Task dispatched to agent'
      });
    } catch (err) {
      console.error('Failed to send message to agent:', err);
      return NextResponse.json(
        { error: 'Internal server error' },
        { status: 500 }
      );
    }
  } catch (error) {
    console.error('Failed to dispatch task:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
