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
 *   stayed standby, no image generated, no QC. (Proven on a client box.)
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
import os from 'os';
import { queryOne, run } from '@/lib/db';
import { getOpenClawClient } from '@/lib/openclaw/client';
import { broadcast } from '@/lib/events';
import { notifyOwner } from '@/lib/notify';
import { getMissionControlUrl } from '@/lib/config';
import { detectPlatform } from '@/lib/platform';
import { resolveAndLog, resolveSpecialistType } from '@/lib/intelligence-resolver';
import { buildPersonaBlock } from '@/lib/persona-dispatch';
import { checkModelSovereignty, detectModality, type ModelSovereigntyViolation } from '@/lib/model-selector';
import { listModels } from '@/lib/model-registry';
import { getBestSOPForTask } from '@/lib/sops';
import { QC_MAX_REROUTES } from '@/lib/qc-scorer';
import { isCanonicalContext, copyCanonicalSOPForTask, authorSOPForTask } from '@/lib/sop-authoring';
import { canonicalDeptSlug } from '@/lib/routing/canonical-slug';
import { artifactDispatchPayload } from '@/lib/task-lifecycle';
import type { SOP, SOPStep } from '@/lib/sops';
import type { Task, Agent, OpenClawSession } from '@/lib/types';
import { buildContextPack, renderContextPackSection } from '@/lib/context-pack';
import { notifyOwnerStarted } from '@/lib/owner-reports';

// Statuses where dispatch must not re-fire.
const SKIP_STATUSES = new Set(['in_progress', 'review', 'done', 'blocked', 'archived']);

// ── W8.2 ANTI-FURNACE: dispatch attempt-accounting + backoff + block-on-N ─────
// The furnace was: a task that can't advance (gateway down / no sovereign model /
// no per-dept runtime) got re-fired every 2-5 min forever. We now record EVERY
// failed advance attempt, back off exponentially, and after MAX_DISPATCH_ATTEMPTS
// hard-block the task (visible + reported) so it is NEVER silently re-looped.
const MAX_DISPATCH_ATTEMPTS = Math.max(
  1,
  parseInt(process.env.MAX_DISPATCH_ATTEMPTS || '5', 10),
);
const DISPATCH_BACKOFF_BASE_SECONDS = Math.max(
  30,
  parseInt(process.env.DISPATCH_BACKOFF_BASE_SECONDS || '120', 10),
);
const DISPATCH_BACKOFF_MAX_SECONDS = Math.max(
  60,
  parseInt(process.env.DISPATCH_BACKOFF_MAX_SECONDS || '3600', 10),
);

type DispatchBlockAudience = 'OWNER' | 'SYSTEM';

/**
 * Record a FAILED advance attempt for a task. Increments dispatch_attempts,
 * stamps an exponential-backoff `next_dispatch_eligible_at` so the sweeps cannot
 * re-fire it before the window elapses, and — once the attempt count reaches
 * MAX_DISPATCH_ATTEMPTS — transitions the task to `blocked` with a classified
 * audience + an owner/operator report. Never silent, never furnaces, never throws.
 */
function recordDispatchFailure(
  taskId: string,
  agentId: string | null,
  opts: { reason: string; audience: DispatchBlockAudience; needs: string; context: string },
): void {
  try {
    const row = queryOne<{ dispatch_attempts: number | null; title: string }>(
      'SELECT dispatch_attempts, title FROM tasks WHERE id = ?',
      [taskId],
    );
    const attempts = (row?.dispatch_attempts ?? 0) + 1;
    const now = new Date().toISOString();
    const backoffSeconds = Math.min(
      DISPATCH_BACKOFF_MAX_SECONDS,
      DISPATCH_BACKOFF_BASE_SECONDS * Math.pow(2, Math.max(0, attempts - 1)),
    );
    const nextEligible = new Date(Date.now() + backoffSeconds * 1000).toISOString();

    if (attempts >= MAX_DISPATCH_ATTEMPTS) {
      // Cap reached → BLOCK (visible on the board + reported). No re-loop.
      const blockNote =
        `[dispatch-blocked] ${opts.reason} after ${attempts} failed advance attempt(s) ` +
        `(cap ${MAX_DISPATCH_ATTEMPTS}). ${opts.needs}`;
      run(
        `UPDATE tasks SET status = 'blocked', dispatch_attempts = ?, last_dispatch_attempt_at = ?,
           next_dispatch_eligible_at = NULL, block_reason = ?, block_needs = ?, block_audience = ?, updated_at = ?
         WHERE id = ? AND status NOT IN ('done','archived')`,
        [attempts, now, opts.reason, opts.needs, opts.audience, now, taskId],
      );
      run(
        `INSERT INTO events (id, type, agent_id, task_id, message, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
        [uuidv4(), 'task_blocked', agentId, taskId, blockNote, now],
      );
      try {
        const updated = queryOne<Task>('SELECT * FROM tasks WHERE id = ?', [taskId]);
        if (updated) broadcast({ type: 'task_updated', payload: updated });
      } catch { /* broadcast best-effort */ }
      try {
        notifyOwner(`🚫 Task blocked: "${row?.title ?? taskId}" — ${opts.needs}`);
      } catch { /* owner notify best-effort */ }
      console.warn(`[${opts.context}] recordDispatchFailure: task ${taskId} BLOCKED (${opts.reason})`);
    } else {
      run(
        `UPDATE tasks SET dispatch_attempts = ?, last_dispatch_attempt_at = ?, next_dispatch_eligible_at = ? WHERE id = ?`,
        [attempts, now, nextEligible, taskId],
      );
      run(
        `INSERT INTO events (id, type, agent_id, task_id, message, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
        [
          uuidv4(), 'task_dispatch_deferred', agentId, taskId,
          `[${opts.context}] advance attempt ${attempts}/${MAX_DISPATCH_ATTEMPTS} failed (${opts.reason}); backing off ${backoffSeconds}s`,
          now,
        ],
      );
      console.warn(
        `[${opts.context}] recordDispatchFailure: task ${taskId} attempt ${attempts}/${MAX_DISPATCH_ATTEMPTS} (${opts.reason}), backoff ${backoffSeconds}s`,
      );
    }
  } catch (err) {
    // Pre-migration DB (no attempt-accounting columns) or any other failure —
    // never throw on the fire-and-forget dispatch path.
    console.warn(`[${opts.context}] recordDispatchFailure non-fatal:`, (err as Error).message);
  }
}

/** Clear attempt-accounting after a task successfully advances to in_progress. */
function recordDispatchSuccess(taskId: string): void {
  try {
    run(
      `UPDATE tasks SET dispatch_attempts = 0, next_dispatch_eligible_at = NULL, last_dispatch_attempt_at = ? WHERE id = ?`,
      [new Date().toISOString(), taskId],
    );
  } catch { /* pre-migration tolerant */ }
}

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
export function resolveSpecialistSessionKey(
  agent: Agent,
  openclawSessionId: string,
  workspaceId: string | undefined,
  context: string,
): string | null {
  // P1-5 FIX — no hardcoded operator home. Was `process.env.HOME ?? <hardcoded operator
  // absolute path>`: on a box where HOME is unset (PM2/systemd/container contexts), a
  // CLIENT box silently resolved the OPERATOR's own home path. Mirrors
  // src/lib/context-pack.ts agentsRoot() / src/lib/platform.ts detectPlatform(): VPS
  // Docker keeps the `/data/.openclaw` persistent-volume marker; any home-relative
  // fallback goes through `os.homedir()`.
  const homeDir = process.env.HOME || process.env.USERPROFILE || os.homedir();
  const AGENTS_ROOT = detectPlatform() === 'vps-docker'
    ? '/data/.openclaw/agents'
    : path.join(homeDir, '.openclaw', 'agents');

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
        // Attempt 1b — legacy/aliased slug → CANONICAL runtime. A workspace slug
        // like `ceo` or `app-development` has its runtime dir under the canonical
        // name (`master-orchestrator`, `engineering`). Probe the canonical slug
        // before giving up so an aliased department DISPATCHES instead of falsely
        // reporting no_specialist_runtime and looping in the W8 backoff.
        const canonicalSlug = canonicalDeptSlug(candidateSlug);
        if (canonicalSlug && canonicalSlug !== candidateSlug) {
          const canonDeptDir = path.join(AGENTS_ROOT, `dept-${canonicalSlug}`);
          const canonBareDir = path.join(AGENTS_ROOT, canonicalSlug);
          if (fs.existsSync(canonDeptDir)) {
            const key = `agent:dept-${canonicalSlug}:${openclawSessionId}`;
            console.log(`[${context}] resolveSpecialistSessionKey: slug "${candidateSlug}" → canonical "${canonicalSlug}" → dept-prefixed runtime → key ${key}`);
            return key;
          }
          if (fs.existsSync(canonBareDir)) {
            const key = `agent:${canonicalSlug}:${openclawSessionId}`;
            console.log(`[${context}] resolveSpecialistSessionKey: slug "${candidateSlug}" → canonical "${canonicalSlug}" → bare runtime → key ${key}`);
            return key;
          }
        }
        console.warn(`[${context}] resolveSpecialistSessionKey: workspace slug "${candidateSlug}" (canonical "${canonicalDeptSlug(candidateSlug)}") has no runtime dir at ${deptPrefixedDir} or ${bareDir} — trying agent role slug`);
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

    // GUARD 6 (W8.2 anti-furnace backoff): if a prior advance attempt failed and
    // set a backoff window, do NOT re-fire until it elapses. A task that has hit
    // the attempt cap is already status='blocked' (caught by GUARD 3); this guard
    // covers the pre-cap backoff so the sweeps cheaply skip a still-deferred task
    // instead of hammering it every tick.
    const nextEligibleAt = (task as Task & { next_dispatch_eligible_at?: string | null })
      .next_dispatch_eligible_at;
    if (nextEligibleAt && nextEligibleAt > now) {
      console.log(
        `[${context}] autoDispatchTask: task ${taskId} in dispatch backoff until ${nextEligibleAt} — skip`,
      );
      return;
    }

    // ── OpenClaw connection ─────────────────────────────────────────────────
    const client = getOpenClawClient();
    if (!client.isConnected()) {
      try {
        await client.connect();
      } catch (connectErr) {
        // W8.5: gateway down is NO LONGER a silent return. Record the failed
        // attempt (visible event), back off, and block+report once the cap is hit
        // so the owner/operator sees a stuck task instead of an invisible re-loop.
        console.error(
          `[${context}] autoDispatchTask: OpenClaw connect failed for task ${taskId}:`,
          connectErr,
        );
        recordDispatchFailure(task.id, agent.id, {
          reason: 'gateway_down',
          audience: 'SYSTEM',
          needs:
            'OpenClaw gateway unreachable at dispatch. Restore the gateway to release this task ' +
            '(it retries with backoff and stays visible until then).',
          context,
        });
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

    // ── SYNCHRONOUS PERSONA DISPATCH GATE (F3.1 / F4.1 — heal, not stall) ────
    // resolveAndLog reads tasks.persona_id first (Hop 10), so a pinned persona is
    // ALREADY delivered. But if the task reached dispatch naked (a create-time
    // selection that silently failed / a pre-existing backlog card), settings.persona
    // resolves to the 'auto' self-select sentinel. Rather than tell the doer to
    // self-select (the F3.6 bug), we HEAL the task here: apply the deterministic
    // fallback chain, pin it, and deliver THAT persona. Never HOLD a task for a
    // persona — the fallback makes NULL impossible (availability > purity). Dynamic
    // import avoids the tasks<->task-dispatcher static cycle.
    if (settings.persona === 'auto') {
      try {
        const { ensurePersonaForDispatch } = await import('@/lib/tasks');
        const healDept =
          canonicalDeptSlug(task.department || task.workspace_id || '') || 'general';
        const healed = ensurePersonaForDispatch(task.id, healDept);
        settings.persona = healed.persona_name;
        settings.personaMode = healed.persona_mode;
        console.warn(
          `[${context}] persona dispatch gate: task ${task.id} was naked — ` +
            `delivering ${healed.healed ? 'healed' : 'pinned'} persona "${healed.persona_name}".`,
        );
      } catch (healErr) {
        // Never block dispatch on the heal — a matched persona is preferred, but an
        // unhealed 'auto' still ships (degraded) rather than stalling the board.
        console.error(`[${context}] persona dispatch gate failed for task ${task.id}:`, healErr);
      }
    }

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
      // W8.2/W8.5: account for the failed advance + back off so the sweeps don't
      // re-fire a model-less task every tick; block+report once the cap is hit.
      // With the sovereign-default (W8.5) this gate should now only trip on a
      // genuine modality gap (e.g. a vision task with no vision model).
      recordDispatchFailure(task.id, agent.id, {
        reason: `model_sovereignty_${sovereigntyViolation.reason}`,
        audience: 'OWNER',
        needs:
          'No sovereign model resolved for this task. Assign/approve a model ' +
          '(Settings → Models) to release it.',
        context,
      });
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
    let resolvedSopName: string | null = null; // W5.3: captured for START notification
    if (resolvedSopId) {
      const sop = queryOne<SOP>(
        `SELECT id, name, steps, success_criteria, department, role
         FROM sops WHERE id = ? AND deleted_at IS NULL`,
        [resolvedSopId],
      );
      if (sop) {
        resolvedSopName = sop.name;
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

    // ── F3.4: SOP-aware persona RESCORE at dispatch ─────────────────────────
    // Persona selection runs at task CREATION — before we know which SOP will
    // govern the work. If the SOP resolved at dispatch (canonical copy, the
    // getBestSOPForTask re-pull above, or an operator edit) differs from the one
    // the creation-time selection saw (`task.sop_id` at dispatch entry — most
    // commonly: selection saw NONE and an SOP was resolved here), re-run
    // selection WITH the SOP context so the persona actually DELIVERED reflects
    // the governing SOP + its curated `persona_hints`. Bounded (single-shot,
    // heuristic-mode timeout), fail-closed (never downgrades an existing
    // persona), and fully non-fatal — dispatch proceeds regardless. Persists a
    // queryable `persona_rescored_at_dispatch` event.
    const selectionSopId = task.sop_id ?? null; // SOP the creation-time selection consumed
    if (resolvedSopId && resolvedSopId !== selectionSopId) {
      try {
        // Dynamic import: tasks.ts already imports this module (autoDispatchTask),
        // so resolve the rescore helpers lazily to avoid a static import cycle —
        // same pattern as the task-lifecycle import below.
        const { rescorePersonaWithSOP, loadSopSelectorContextById } = await import('@/lib/tasks');
        const sopContext = loadSopSelectorContextById(resolvedSopId);
        if (sopContext) {
          const deptForSelector =
            canonicalDeptSlug(task.department ?? task.workspace_id ?? '') || 'general';
          const rescoreDescription =
            `${task.title}${task.description ? `. ${task.description}` : ''}`.trim();
          const rescored = await rescorePersonaWithSOP(
            task.id,
            rescoreDescription,
            deptForSelector,
            sopContext,
          );
          // Patch the in-memory row so buildPersonaBlock DELIVERS the rescored
          // persona in this same dispatch message (not just on the board).
          task.persona_id = rescored.persona_id;
          task.persona_name = rescored.persona_name;
          task.persona_mode = rescored.persona_mode;
          if (rescored.changed) {
            console.log(
              `[${context}] SOP-aware rescore: task ${task.id} persona → ${rescored.persona_id} ` +
              `(SOP ${resolvedSopId} differed from selection-time SOP ${selectionSopId ?? '(none)'})`,
            );
          }
        }
      } catch (rescoreErr) {
        console.warn(
          `[${context}] SOP-aware persona rescore failed (non-fatal):`,
          (rescoreErr as Error).message,
        );
      }
    }
    // ── End F3.4 rescore ────────────────────────────────────────────────────

    // ── W4.2: Full-context handoff — build ContextPack (never throws) ──────
    // Resolved SOP is available at this point (resolvedSopId + sop local).
    // We look it up again (or reuse the already-queried row) for the pack.
    let resolvedSopForPack: Parameters<typeof buildContextPack>[0]['sop'] | null = null;
    if (resolvedSopId) {
      try {
        resolvedSopForPack = queryOne<SOP & { references?: string | null; doc_index?: string | null }>(
          `SELECT id, name, department, role FROM sops WHERE id = ? AND deleted_at IS NULL`,
          [resolvedSopId],
        ) ?? null;
      } catch {
        /* non-fatal — pack degrades gracefully */
      }
    }
    const contextPack = (() => {
      try {
        return buildContextPack({
          task: {
            id: task.id,
            title: task.title,
            description: task.description,
            department: task.department,
            workspace_id: task.workspace_id,
          },
          agent: {
            id: agent.id,
            name: agent.name,
            role: agent.role ?? undefined,
            agents_md: (agent as Agent & { agents_md?: string }).agents_md,
            tools_md: (agent as Agent & { tools_md?: string }).tools_md,
            memory_md: (agent as Agent & { memory_md?: string }).memory_md,
            workspace_id: agent.workspace_id,
          },
          specialistType,
          sop: resolvedSopForPack,
        });
      } catch {
        return null;
      }
    })();

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
${buildPersonaBlock(task, settings)}
**Specialist Type:** ${specialistType}
${artifactFragment}${contextPack ? renderContextPackSection(contextPack) : ''}
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
      // W8.2: account for the failed advance + back off so the sweeps don't
      // re-select this un-wireable task every tick; block+report (SYSTEM — wire
      // the dept runtime) once the cap is hit instead of re-looping forever.
      recordDispatchFailure(task.id, agent.id, {
        reason: 'no_specialist_runtime',
        audience: 'SYSTEM',
        needs: `No OpenClaw runtime for "${agent.name}". Wire ~/.openclaw/agents/<dept-slug>/ to release this department.`,
        context,
      });
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

    // W8.2: task advanced — clear attempt-accounting so a future re-queue starts
    // from a clean slate (only CONSECUTIVE failures accumulate toward the cap).
    recordDispatchSuccess(task.id);

    // W5.3 — START owner notification (spec §5): persona + dept + specialist + SOP + role.
    // All five values are in local scope at this point. Best-effort; gateway-routed; never throws.
    try {
      notifyOwnerStarted(task.id, {
        persona: settings.persona !== 'auto' ? settings.persona : null,
        department: task.department ?? null,
        specialist: agent.name,
        role: agent.role ?? null,
        sop: resolvedSopName,
      });
    } catch { /* non-fatal */ }

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
