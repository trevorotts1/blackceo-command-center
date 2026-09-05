import { capturePersonaSnapshot } from '@/lib/persona-state';
import { renderPersonaConformanceInstructions } from '@/lib/persona-conformance';
import { NextRequest, NextResponse } from 'next/server';
import * as fs from 'fs';
import * as path from 'path';
import os from 'os';
import { v4 as uuidv4 } from 'uuid';
import { beginExecutionSend, executionSessionId, reserveExecution, recordExecutionAcceptance, recordExecutionUnknown } from '@/lib/execution-attempts';
import { queryOne, queryAll, run } from '@/lib/db';
import { getOpenClawClient } from '@/lib/openclaw/client';
import { broadcast } from '@/lib/events';
import { getProjectsPath, getMissionControlUrl } from '@/lib/config';
import { detectPlatform } from '@/lib/platform';
import { resolveAndLog, resolveSpecialistType } from '@/lib/intelligence-resolver';
import { buildPersonaBlock, buildPersonaPlanBlock } from '@/lib/persona-dispatch';
import { renderOwnerMessagesSection } from '@/lib/owner-messages';
import { loadSubtaskPersonas } from '@/lib/persona-selector';
import { checkModelSovereignty, detectModality } from '@/lib/model-selector';
import { listModels } from '@/lib/model-registry';
import { canonicalDeptSlug } from '@/lib/routing/canonical-slug';
import { recordDispatchFailure } from '@/lib/task-dispatcher';
import { blockDispatchIfOwnerKilled } from '@/lib/owner-killed';
import {
  checkDuplicateDispatch,
  buildDuplicateSuppressedMessage,
  DUPLICATE_SUPPRESSED_EVENT_TYPE,
} from '@/lib/dispatch-idempotency';
import { checkTaskWriteAuth, renderWriteBackInstructions } from '@/lib/mc-auth';
import { transition, recordStatusEvent, checkWipLimit } from '@/lib/task-lifecycle';
import {
  resolveAgentRuntimeModel,
  modelsMatch,
  recordModelSkewEvent,
  reconcileTaskModelRecord,
  type RuntimeModelResolution,
} from '@/lib/runtime-model';
import type { SOP, SOPStep } from '@/lib/sops';
import type { Task, Agent, OpenClawSession } from '@/lib/types';
import { notifyOwnerStarted } from '@/lib/owner-reports';
import { notifySystem } from '@/lib/notify';
import { matchSkillsForTask, renderMatchedSkillsSection, type MatchedSkill } from '@/lib/context-pack';
import {
  PODCAST_SKILL_SLUG,
  isPodcastTask,
  podcastProcessorActivationStatus,
  podcastActivationRefusalMessage,
} from '@/lib/capability-manifest';

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

    // TICKET 4b: this route has no status precondition at all — it fires
    // chat.send and then routes `transition(id, 'in_progress', ...)` below
    // unconditionally on every POST. `blocked -> in_progress` is a LEGAL edge
    // in transition()'s own state machine (an operator resolving a block and
    // re-dispatching is a normal, designed action), so transition() alone
    // cannot distinguish that from a stale/duplicate POST replaying against a
    // task that was blocked/escalated moments ago and never actually reviewed.
    // Confirmed mechanism for the escalation-overridden-by-redispatch defect:
    // escalateStuckBacklogTask() (backlog-redispatch-sweep.ts) already excludes
    // an escalated task from its OWN next SELECT correctly (the status flip to
    // 'blocked' is itself one of the query's own WHERE-clause columns) — the
    // override came through THIS route instead, which a detached/ghost dispatch
    // caller (L-10, confirmed) could hit at any time with no awareness of an
    // intervening block. Require an explicit acknowledgement to revive a
    // blocked task from here; a bare retry/replay POST no longer silently wins.
    if (task.status === 'blocked') {
      let acknowledgeBlock = false;
      try {
        const body = await request.clone().json();
        acknowledgeBlock = body?.acknowledgeBlock === true;
      } catch {
        acknowledgeBlock = false; // no/invalid JSON body — default to refusing
      }
      if (!acknowledgeBlock) {
        return NextResponse.json(
          {
            success: false,
            held: true,
            reason: 'blocked_requires_acknowledgement',
            message:
              `Task "${task.title}" is currently BLOCKED (block_reason: ${task.block_reason ?? 'none recorded'}). ` +
              `Manual dispatch will not silently revive a blocked task. Resolve the block, then retry this ` +
              `request with { "acknowledgeBlock": true } to confirm the block was reviewed.`,
          },
          { status: 409 },
        );
      }
    }

    // FIX-17 / Error 12 / Rule R12: an OWNER-KILLED task (killed_at column OR
    // the "OWNER KILLED" note marker) is terminal-for-dispatch — the manual
    // "Send to Agent" route must refuse to revive it, exactly like every auto
    // re-dispatch path. One deduped `dispatch_blocked_owner_killed` event row
    // records the block.
    if (blockDispatchIfOwnerKilled(task, 'manual-dispatch-route')) {
      return NextResponse.json(
        {
          success: false,
          held: true,
          reason: 'owner_killed',
          message: `Task "${task.title}" was killed by the owner (Rule R12) and is terminal-for-dispatch. It will not be revived. Clear the kill (killed_at / OWNER KILLED note) to re-enable dispatch.`,
        },
        { status: 409 },
      );
    }

    // ── DISPATCH-IDEMPOTENCY-WINDOW (2026-08-27) — suppress ACCIDENTAL
    // duplicate sends, never deliberate operator re-dispatch. ─────────────────
    //
    // DEFECT (live, task f4a2de9a 2026-08-27): this route's only status
    // precondition was the blocked-ack gate above, so a second POST against an
    // in_progress task 25s after the first fired a FULL second chat.send — the
    // agent received the same task twice. The DISP-01 gateway idempotencyKey
    // below keys on dispatch_attempts and only collapses CONCURRENT sends; it
    // cannot see two sends seconds apart once both have fired.
    //
    // OPERATOR SEMANTICS (unchanged — the intentional-re-dispatch contract
    // documented on this route stays intact; see src/lib/dispatch-idempotency.ts
    // for the full contract):
    //   • After the window elapses, a plain re-POST dispatches exactly as before.
    //   • An EXPLICIT override — body { "force": true } — always dispatches,
    //     even inside the window. Deliberate re-dispatch is never blocked.
    //   • A REASSIGNMENT (task re-pointed to a different agent) is never
    //     suppressed — the window only matches a repeat send to the SAME agent.
    //   • BLOCKED tasks are unaffected: the acknowledgeBlock gate above runs
    //     first and is byte-for-byte unchanged.
    //
    // NEVER SILENT: a suppressed duplicate is recorded as a queryable
    // `duplicate_dispatch_suppressed` events row + task_activities row so the
    // board shows exactly what was swallowed and how to override.
    let forceDispatch = false;
    try {
      const body = await request.clone().json();
      forceDispatch = body?.force === true;
    } catch {
      forceDispatch = false; // no/invalid JSON body — normal path
    }
    if (!forceDispatch) {
      const dup = checkDuplicateDispatch(task.id, task.assigned_agent_id);
      if (dup.suppressed) {
        const agentNameForMsg =
          task.assigned_agent_name ?? (task.assigned_agent_id ?? 'the assigned agent');
        const suppressMsg = buildDuplicateSuppressedMessage({
          taskTitle: task.title,
          agentName: agentNameForMsg,
          elapsedSeconds: dup.elapsed_seconds,
          windowSeconds: dup.window_seconds,
        });
        console.warn(`[Dispatch] ${suppressMsg}`);
        const nowDup = new Date().toISOString();
        // Activity tab row — the operator sees the suppressed duplicate where
        // they were just looking (they clicked Send a second time).
        run(
          `INSERT INTO task_activities (id, task_id, agent_id, activity_type, message, metadata, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [
            uuidv4(), task.id, task.assigned_agent_id, DUPLICATE_SUPPRESSED_EVENT_TYPE, suppressMsg,
            JSON.stringify({
              reason: dup.reason,
              window_seconds: dup.window_seconds,
              elapsed_seconds: dup.elapsed_seconds,
              last_dispatched_at: dup.last_dispatched_at,
              last_dispatch_agent_id: dup.last_dispatch_agent_id,
              forced: false,
            }),
            nowDup,
          ],
        );
        // Live-feed events row — queryable, same sink the successful dispatch
        // itself is recorded in, so the suppressed duplicate is visible next to
        // the dispatch it shadows (and OPUS-08's idx lands on this lookup).
        run(
          `INSERT INTO events (id, type, agent_id, task_id, message, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [uuidv4(), DUPLICATE_SUPPRESSED_EVENT_TYPE, task.assigned_agent_id, task.id, suppressMsg, nowDup],
        );
        broadcast({ type: 'task_updated', payload: task });
        return NextResponse.json(
          {
            success: false,
            held: true,
            suppressed: true,
            reason: 'duplicate_within_idempotency_window',
            message: suppressMsg,
            elapsed_seconds: dup.elapsed_seconds,
            window_seconds: dup.window_seconds,
          },
          { status: 409 },
        );
      }
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

    // ── Unit 3.4 — CAPABILITY-MANIFEST gate (manual-dispatch mirror of
    // task-dispatcher.ts GUARD 8). A PODCAST task must NEVER be dispatched on a
    // box whose Skill 58 processor is not activated. The operator click must not
    // bypass the fail-closed manifest gate the auto path enforces — without this
    // mirror an empty materialized dept-podcast dir (created for every discovered
    // department by materialize-dept-agents.sh) lets a skill-less session
    // dispatch. Refuse loudly with "run SOP-PODCAST-07", record the failed
    // attempt + terminal block (anti-furnace), and NEVER mint an agent id.
    if (isPodcastTask(task.department ?? task.workspace_id)) {
      const activation = podcastProcessorActivationStatus();
      if (!activation.activated) {
        const refusal = podcastActivationRefusalMessage();
        const holdMsg =
          `[podcast_activation_refused] Task "${task.title}" (${task.id}) is a podcast task ` +
          `but this box has NO activated podcast processor. ${activation.reason} ${refusal} ` +
          `Manual dispatch REFUSED — no agent id invented, no skill-less session spawned.`;
        console.error(`[Dispatch] ${holdMsg}`);
        const nowHold = new Date().toISOString();
        run(
          `INSERT INTO task_activities (id, task_id, agent_id, activity_type, message, metadata, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [
            uuidv4(), task.id, agent.id, 'routed_but_not_dispatched', holdMsg,
            JSON.stringify({ workspace_id: task.workspace_id ?? null, role: agent.role ?? null, reason: 'podcast_not_activated' }),
            nowHold,
          ],
        );
        run(
          `INSERT INTO events (id, type, agent_id, task_id, message, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [uuidv4(), 'routed_but_not_dispatched', agent.id, task.id, holdMsg, nowHold],
        );
        // SYSTEM audience — operator/rescue channel only, NEVER the client's
        // Telegram (MOVE-IN-SILENCE). Names the rescue SOP.
        notifySystem(holdMsg, { agent: 'manual-dispatch', action: 'escalate' });
        // W8.2 / P1-01: reach a TERMINAL blocked state (non-transient — a retry
        // can never materialize the activation layer), exactly like the auto path.
        recordDispatchFailure(task.id, agent.id, {
          reason: 'podcast_not_activated',
          audience: 'SYSTEM',
          needs: refusal,
          context: 'manual-dispatch',
          hardBlock: true,
        });
        return NextResponse.json(
          {
            success: false,
            held: true,
            blocked: true,
            reason: 'podcast_not_activated',
            message: holdMsg,
          },
          { status: 422 },
        );
      }
    }
    // ── End Unit 3.4 capability-manifest gate ────────────────────────────────

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

    const now = new Date().toISOString();
    const { refreshPersonaDecisionIfNeeded } = await import('@/lib/tasks');
    await refreshPersonaDecisionIfNeeded(task.id);
    const refreshedTask=queryOne<Task>('SELECT * FROM tasks WHERE id=?',[task.id]);
    const stableFields=['assigned_agent_id','workspace_id','department','assignment_version','status','source','killed_at','archived_at'];
    if(!refreshedTask || stableFields.some(key=>(refreshedTask as unknown as Record<string,unknown>)[key] !== (task as unknown as Record<string,unknown>)[key])) { return NextResponse.json({success:false,held:true,reason:'assignment_or_state_changed'},{status:409}); }
    Object.assign(task,refreshedTask);
    const personaSendSnapshot=capturePersonaSnapshot(task.id);
    const executionId = uuidv4();
    const session = { openclaw_session_id: executionSessionId(agent.id, executionId) };

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
    // Unit 3.2: pass agentId so the matcher intersects the filesystem search
    // with the assigned agent's agent_skills bindings (migration 122).
    // Never throws (degrades to []).
    let matchedSkills: MatchedSkill[] = [];
    let skillsBlock = '';
    try {
      matchedSkills = await matchSkillsForTask({
        title: task.title,
        description: task.description,
        department: task.department,
      }, { agentId: agent.id });
      skillsBlock = renderMatchedSkillsSection(matchedSkills);
    } catch {
      skillsBlock = '';
    }

    // ── Unit 3.6(b) — PUSH-DISPATCH ASSERTION (manual-dispatch mirror of
    // task-dispatcher.ts). A PODCAST task MUST resolve Skill 58
    // (podcast-production-engine) before dispatch; a skill-less podcast session
    // is the phantom-agent failure mode. This is the SECOND gate (after the
    // capability-manifest gate above) that catches a box where the skill tree is
    // absent/not searchable even though activation reports green. Fail-closed:
    // record the failed attempt + terminal block, never dispatch.
    if (isPodcastTask(task.department ?? task.workspace_id)) {
      const skill58Match = matchedSkills.find((s) => {
        const hay = `${s.name} ${s.location}`.toLowerCase();
        return (
          s.name.toLowerCase().includes(PODCAST_SKILL_SLUG) ||
          hay.includes('58-podcast-production-engine') ||
          hay.includes('58-podcast')
        );
      });
      if (!skill58Match) {
        const skillHoldMsg =
          `[podcast_skill_not_resolvable] Task "${task.title}" (${task.id}) is a podcast task ` +
          `but matchSkillsForTask resolved NO Skill 58 (podcast-production-engine) match on this ` +
          `box (matched ${matchedSkills.length} non-58 skills) — the skill files are not ` +
          `installed/searchable in the CC skill roots. Dispatching a skill-less podcast session ` +
          `is refused (phantom-agent risk). Install the 58-podcast-production-engine skill tree ` +
          `and re-run SOP-PODCAST-07.`;
        console.error(`[Dispatch] ${skillHoldMsg}`);
        const nowSkill = new Date().toISOString();
        run(
          `INSERT INTO task_activities (id, task_id, agent_id, activity_type, message, metadata, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [
            uuidv4(), task.id, agent.id, 'routed_but_not_dispatched', skillHoldMsg,
            JSON.stringify({
              workspace_id: task.workspace_id ?? null,
              role: agent.role ?? null,
              reason: 'podcast_skill_not_resolvable',
              matched_skill_count: matchedSkills.length,
              skill58_resolved: false,
            }),
            nowSkill,
          ],
        );
        run(
          `INSERT INTO events (id, type, agent_id, task_id, message, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [uuidv4(), 'routed_but_not_dispatched', agent.id, task.id, skillHoldMsg, nowSkill],
        );
        try {
          notifySystem(skillHoldMsg, { agent: 'manual-dispatch', action: 'escalate' });
        } catch { /* notify best-effort */ }
        recordDispatchFailure(task.id, agent.id, {
          reason: 'podcast_skill_not_resolvable',
          audience: 'SYSTEM',
          needs:
            'Skill 58 (podcast-production-engine) did not resolve for a podcast task. ' +
            'Install the skill tree on this box and re-run SOP-PODCAST-07.',
          context: 'manual-dispatch',
          hardBlock: true,
        });
        return NextResponse.json(
          {
            success: false,
            held: true,
            blocked: true,
            reason: 'podcast_skill_not_resolvable',
            message: skillHoldMsg,
          },
          { status: 422 },
        );
      }
    }
    // ── End Unit 3.6(b) assertion ────────────────────────────────────────────

    const taskMessage = `${priorityEmoji} **NEW TASK ASSIGNED**

**Title:** ${task.title}
${task.description ? `**Description:** ${task.description}\n` : ''}
**Priority:** ${task.priority.toUpperCase()}
${task.due_date ? `**Due:** ${task.due_date}\n` : ''}
**Task ID:** ${task.id}
${sopBlock ? `${sopBlock}` : ''}**Agent Model:** ${settings.model}
${personaSection}
**Specialist Type:** ${specialistType}
${renderOwnerMessagesSection(task.id)}${skillsBlock}
**OUTPUT DIRECTORY:** ${taskProjectDir}
Create this directory and save all deliverables there.

${renderWriteBackInstructions(missionControlUrl, task.id, 'file', `${taskProjectDir}/filename.html`, executionId)}

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

    // ── FAIL-LOUD write-back auth guard (PREVENTION, src/lib/mc-auth.ts) ──────
    // Before flipping this task to in_progress, verify a dispatched agent can
    // AUTHENTICATE its write-backs. If MC_API_TOKEN is unset on a box that will
    // reject the agent's external POST/PATCH (src/middleware.ts Gate B), the
    // agent finishes but every write-back 401s and the card freezes in_progress
    // until the stuck sweep blocks it (the carded-but-trapped defect). Surface
    // it NOW — HOLD + SYSTEM report — instead of dispatching work that cannot
    // report back. Dev boxes in ALLOW_INSECURE_OPEN_API mode pass (ok:true).
    const writeAuth = checkTaskWriteAuth();
    if (!writeAuth.ok) {
      console.error(`[Dispatch] HELD task ${task.id}: task-API write-back auth not provisioned — ${writeAuth.reason}`);
      recordDispatchFailure(task.id, agent.id, {
        reason: 'mc_api_token_unset',
        audience: 'SYSTEM',
        needs: writeAuth.reason,
        context: 'manual-dispatch',
      });
      return NextResponse.json(
        { success: false, held: true, reason: 'mc_api_token_unset', message: writeAuth.reason },
        { status: 503 },
      );
    }

    // ── MR-12 WIP-limit hold (PRE-SEND, read-only) ──────────────────────────
    // transition() enforces the in_progress column's WIP limit server-side and
    // throws WIP_LIMIT when the column is full — but that check runs AFTER
    // chat.send below. Without this pre-check a full column would let the agent
    // RECEIVE the work (chat.send already fired) while the board never advances
    // the card (transition throws → outer catch → bare 500): an agent running
    // invisible work with no audit trail. So probe the limit BEFORE sending —
    // read-only, no write — and hold exactly like the routed_but_not_dispatched
    // / mc_api_token_unset holds above: the task stays in its current status,
    // the attempt is recorded (backoff + escalation ladder via
    // recordDispatchFailure), and the operator gets a 429 naming the full
    // column. The authoritative check + status flip + model_id pin still happen
    // atomically in the post-send transition() below (MR-04); this probe only
    // moves the refusal ahead of the irreversible send. The auto-dispatch sweep
    // is unaffected — it uses task-dispatcher's raw status writer, which (like
    // the other automated pipelines) is exempt from the operator-facing gate.
    const wipViolation = checkWipLimit(task.id, 'in_progress', task.workspace_id ?? null);
    if (wipViolation) {
      console.error(`[Dispatch] HELD task ${task.id}: in_progress column at its WIP limit — ${wipViolation}`);
      recordDispatchFailure(task.id, agent.id, {
        reason: 'wip_limit_in_progress',
        audience: 'SYSTEM',
        needs:
          'The in_progress column is at its WIP limit. Move a task out of it ' +
          '(to review/blocked/backlog) to free a slot, then re-dispatch.',
        context: 'manual-dispatch',
      });
      return NextResponse.json(
        { success: false, held: true, reason: 'wip_limit_in_progress', message: wipViolation },
        { status: 429 },
      );
    }

    const { checkPersonaDispatchReady } = await import('@/lib/tasks');
    const personaReady = checkPersonaDispatchReady(task.id);
    if (!personaReady.ready) return NextResponse.json({success:false,held:true,reason:personaReady.reason},{status:409});
    const claim = reserveExecution({...task,persona_snapshot:personaSendSnapshot},sessionKey,executionId);
    if (!claim.execution) return NextResponse.json({success:false,held:true,reason:claim.reason},{status:409});
    const execution=claim.execution;
    if (!beginExecutionSend(execution)) return NextResponse.json({success:false,held:true,reason:'claim_superseded'},{status:409});
    let acknowledged = false;
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
      const acknowledgement = await client.call('chat.send', {
        sessionKey,
        message: `${taskMessage}\n\n${renderPersonaConformanceInstructions(task.id, executionId, agent.id, missionControlUrl)}\n\n**Execution ID:** ${executionId}\nInclude execution_id: "${executionId}" in completion webhook JSON.`,
        idempotencyKey: execution.idempotency_key,
        timeoutMs: 30000,
      });

      recordExecutionAcceptance(execution,acknowledgement);
      acknowledged = true;

      // FIX-15 (Error 7 / R7 — model skew): pin the ACTUAL runtime model on the
      // task, not the CC's "intended" resolution. The gateway has no supported
      // per-dispatch model override (see contract note above), so the agent runs
      // on whatever its OWN openclaw.json agent config selects. We resolve that
      // runtime model (openclaw.json `agents.list[i].model.primary`, cross-checked
      // against the live gateway session when one is up) and write IT to
      // tasks.model_id — so the owner's model pill reflects what actually ran,
      // not the registry default that was never honored.
      //
      // When the intended and runtime models diverge, a `model_skew_detected`
      // event row is written (queryable — the FIX-15 QC gate reads it). Best
      // effort: never throws, never fails the dispatch; falls back to the
      // intended model when the runtime model is unresolvable.
      const runtimeResolved: RuntimeModelResolution = await resolveAgentRuntimeModel(
        agent,
        task.workspace_id,
        session.openclaw_session_id,
      );
      const intendedModel = settings.model || null;
      const runtimeModel = runtimeResolved.model_id || intendedModel;
      const skew = !!(intendedModel && runtimeModel && !modelsMatch(intendedModel, runtimeModel));
      if (skew) {
        console.warn(
          `[Dispatch] FIX-15 MODEL-SKEW task ${id}: intended="${intendedModel}" runtime="${runtimeModel}" ` +
            `(source=${runtimeResolved.source})`,
        );
      }
      recordModelSkewEvent({
        taskId: id,
        agentId: agent.id,
        intended: intendedModel,
        runtime: runtimeModel,
        skew,
        detail: {
          source: runtimeResolved.source,
          config_agent_id: runtimeResolved.configAgentId,
          config_primary: runtimeResolved.configPrimary,
          gateway_model: runtimeResolved.gatewayModel,
          model_source: settings.modelSource,
          manual_dispatch: true,
        },
      });

      // Update task status to in_progress, and pin the resolved model_id so
      // the UI (MissionQueue 🤖 pill) and downstream auditing can show which
      // model this task will ACTUALLY run on (FIX-15: runtime model, resolved
      // from the agent's openclaw.json config / live gateway session above —
      // not the CC "intended" resolution). v4.0.1 P0-7 / B1.
      // MR-04: route through transition() with extraColumns so model_id lands
      // atomically with the status flip AND the legal-transition guard + CAS run.
      // FIX-15 keeps the runtime-model pin inside the same atomic transition so
      // the UI 🤖 pill never shows a stale model for an in_progress task.
      await transition(id, 'in_progress', {
        actor: 'manual-dispatch',
        reason: 'operator-triggered dispatch (Send to Agent)',
        extraColumns: { model_id: runtimeModel || settings.model || null },
      });

      // Runtime beat the recorded intent: reconcile the paperwork so the record
      // itself says runtime won, instead of leaving a stale intended model behind
      // for the next dispatch to re-detect and re-alarm on.
      if (skew) {
        reconcileTaskModelRecord({
          taskId: id,
          agentId: agent.id,
          intended: intendedModel,
          runtime: runtimeModel,
          detail: {
            source: runtimeResolved.source,
            config_agent_id: runtimeResolved.configAgentId,
            model_source: settings.modelSource,
            manual_dispatch: true,
          },
        });
      }

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
      // DISPATCH-LAG (2026-08-27): stamped when WRITTEN, not with `now` (captured
      // at the top of this handler, before the gateway connect + chat.send). The
      // stale stamp made the trail contradict itself — on task f4a2de9a the two
      // manual dispatches logged `task_dispatched` at 18:54:12.794Z/18:54:37.814Z
      // while the model_runtime_confirmed rows they wrote EARLIER in this same
      // handler (recordModelSkewEvent, which stamps at write time) landed at
      // 19:02:43/19:03:23, i.e. ~8.5 minutes "after" an event that in code runs
      // before them. Same class of artifact as the auto-dispatch path.
      const dispatchedAt = new Date().toISOString();
      const eventId = uuidv4();
      run(
        `INSERT INTO events (id, type, agent_id, task_id, message, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [eventId, 'task_dispatched', agent.id, task.id, `Task "${task.title}" dispatched to ${agent.name}`, dispatchedAt]
      );

      // Log dispatch activity to task_activities table (for Activity tab)
      const activityId = crypto.randomUUID();
      run(
        `INSERT INTO task_activities (id, task_id, agent_id, activity_type, message, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [activityId, task.id, agent.id, 'status_changed', `Task dispatched to ${agent.name} - Agent is now working on this task`, dispatchedAt]
      );

      return NextResponse.json({
        success: true,
        task_id: task.id,
        agent_id: agent.id,
        session_id: session.openclaw_session_id,
        message: 'Task dispatched to agent'
      });
    } catch (err) {
      console.error('Dispatch acknowledgement/bookkeeping failed:', err);
      if (acknowledged) return NextResponse.json({success:true,task_id:task.id,execution_id:executionId,warning:'accepted_bookkeeping_failed'});
      recordExecutionUnknown(execution);
      return NextResponse.json({success:false,task_id:task.id,execution_id:executionId,
        reason:'send_acceptance_unknown',message:'Reconcile this execution before retrying.'},{status:202});
    }
  } catch (error) {
    console.error('Failed to dispatch task:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
