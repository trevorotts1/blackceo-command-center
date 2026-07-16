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
 *   7. (skill6-v2 U33 / C-02) Triad-incomplete (checkTriad, sops.ts:432) → HOLD,
 *      loudly (`triad_gate_hold` event) — never claimable until description +
 *      SOP + persona are all real, same gate the UI PATCH path enforces.
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
import { notifyOwner, notifySystem } from '@/lib/notify';
import { getMissionControlUrl } from '@/lib/config';
import { detectPlatform } from '@/lib/platform';
import { resolveAndLog, resolveSpecialistType } from '@/lib/intelligence-resolver';
import { buildPersonaBlock, buildPersonaPlanBlock } from '@/lib/persona-dispatch';
import { loadSubtaskPersonas } from '@/lib/persona-selector';
import { checkModelSovereignty, detectModality, type ModelSovereigntyViolation } from '@/lib/model-selector';
import { listModels } from '@/lib/model-registry';
import { getBestSOPForTask, checkTriad } from '@/lib/sops';
import { triadMissingPillText, type TriadMissingKey } from '@/lib/board-labels';
import { QC_MAX_REROUTES } from '@/lib/qc-scorer';
import { isCanonicalContext, copyCanonicalSOPForTask, authorSOPForTask } from '@/lib/sop-authoring';
import { canonicalDeptSlug } from '@/lib/routing/canonical-slug';
import { artifactDispatchPayload } from '@/lib/task-lifecycle';
import { healPhantomAgentAssignment } from '@/lib/jobs/heal-phantom-assignments';
import type { SOP, SOPStep } from '@/lib/sops';
import type { Task, Agent, OpenClawSession } from '@/lib/types';
import {
  buildContextPack,
  renderContextPackSection,
  matchSkillsForTask,
  type MatchedSkill,
} from '@/lib/context-pack';
import { notifyOwnerStarted } from '@/lib/owner-reports';
import { checkTaskWriteAuth, renderWriteBackInstructions } from '@/lib/mc-auth';

// Statuses where dispatch must not re-fire.
// DISP-12: 'archived' is NOT a task status (it is not in any of the 4 canonical
// TaskStatus manifests) — archival is tracked by the `archived_at` column. It was
// dead in this set; the real archival exclusion is `archived_at IS NULL`, applied
// in GUARD 3 below and the block WHERE-clause.
const SKIP_STATUSES = new Set(['in_progress', 'review', 'done', 'blocked']);

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
export function recordDispatchFailure(
  taskId: string,
  agentId: string | null,
  opts: {
    reason: string;
    audience: DispatchBlockAudience;
    needs: string;
    context: string;
    /**
     * P1-01: NON-TRANSIENT failure — block + notify on THIS attempt (no retry
     * ladder). A model-sovereignty refusal (no sovereign/modality-fit model
     * resolved) is not something a retry can cure: retrying it 5× over ~33 min
     * only delayed the owner alert. When set, the task is blocked and reported
     * immediately regardless of the attempt count.
     */
    hardBlock?: boolean;
  },
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

    if (opts.hardBlock || attempts >= MAX_DISPATCH_ATTEMPTS) {
      // Cap reached OR a non-transient hard-block class → BLOCK (visible on the
      // board + reported) immediately. No re-loop, no silent retry ladder.
      const blockNote = opts.hardBlock
        ? `[dispatch-blocked] ${opts.reason} — non-transient failure, blocked + reported on ` +
          `attempt ${attempts} (not retried). ${opts.needs}`
        : `[dispatch-blocked] ${opts.reason} after ${attempts} failed advance attempt(s) ` +
          `(cap ${MAX_DISPATCH_ATTEMPTS}). ${opts.needs}`;
      run(
        `UPDATE tasks SET status = 'blocked', dispatch_attempts = ?, last_dispatch_attempt_at = ?,
           next_dispatch_eligible_at = NULL, block_reason = ?, block_needs = ?, block_audience = ?, updated_at = ?
         WHERE id = ? AND status NOT IN ('done') AND archived_at IS NULL`,
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
        // MSG-06 / SWEEP-06: a SYSTEM-audience block is an OPERATOR concern —
        // it must NEVER reach the client's Telegram (MOVE-IN-SILENCE). Route it
        // through notifySystem() (Rescue Rangers / server log); only a genuine
        // OWNER-audience block goes to the client's own chat.
        const blockMsg = `Task blocked: "${row?.title ?? taskId}" — ${opts.needs}`;
        if (opts.audience === 'SYSTEM') {
          notifySystem(blockMsg, { agent: opts.context, action: 'escalate' });
        } else {
          notifyOwner(`🚫 ${blockMsg}`);
        }
      } catch { /* notify best-effort */ }
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
/**
 * B5: the deterministic `openclaw_session_id` for an agent — a PURE function of
 * the agent name (`mission-control-<name-slug>`). The openclaw_sessions row is
 * purgeable (a hard-delete wiped 64 rows on the live box), but the id is not: the
 * dispatcher, the completion webhook, and the execution-watcher can all re-derive
 * it from the agent name so a completion reconciles even with NO session row.
 * This MUST match the string the dispatcher stores below exactly.
 */
export function deterministicOpenclawSessionId(agentName: string): string {
  return `mission-control-${agentName.toLowerCase().replace(/\s+/g, '-')}`;
}

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

    // GUARD 3: skip terminal statuses + archived tasks (DISP-12: archival is
    // tracked by archived_at, not a status).
    if (SKIP_STATUSES.has(task.status)) {
      console.log(
        `[${context}] autoDispatchTask: task ${taskId} already "${task.status}" — skip`,
      );
      return;
    }
    if ((task as Task & { archived_at?: string | null }).archived_at) {
      console.log(
        `[${context}] autoDispatchTask: task ${taskId} is archived — skip`,
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
      // C-03 (skill6-v2 U34) — THE fake-agent root cause, made loud, capped,
      // and self-healing. This branch used to be `console.warn + return`: no
      // event, no backoff, no block, no operator alert — the card kept its
      // phantom assigned_agent_id forever and intake-advance re-selected it
      // every ~2 minutes, re-skipping it silently on every tick (the
      // Maria-pattern S2 fake-agent root cause, class (a): a phantom id sits
      // in the assignment column and nothing owns un-sticking it).
      //
      // FIX: heal it instead of skipping it. Clear the phantom
      // assigned_agent_id (durable events row + one operator SYSTEM alert) so
      // the NEXT intake-advance tick routes this card through routeTask() —
      // which only ever returns REAL agent rows — instead of re-selecting
      // and re-skipping it forever. This is self-healing, not a hard block:
      // nothing here requires a human to wire anything (compare the
      // no_specialist_runtime hold below, which genuinely does need a human
      // to add a runtime directory). CAPPED: healPhantomAgentAssignment() is
      // CAS-guarded, so a concurrent caller (e.g. intake-advance-sweep's own
      // phantom-heal tail) racing the SAME phantom id writes at most one
      // event total, never a duplicate.
      const deadAgentId = task.assigned_agent_id;
      const healed = healPhantomAgentAssignment(taskId, deadAgentId, context);
      if (healed) {
        console.error(
          `[${context}] autoDispatchTask: task ${taskId} referenced agent "${deadAgentId}" ` +
            `which has no agents row on this box — HEALED (assigned_agent_id cleared; ` +
            `will be re-routed on the next intake-advance tick)`,
        );
        try {
          notifySystem(
            `Task "${task.title}" (${taskId}) was assigned to a nonexistent agent id ` +
              `(${deadAgentId}) — auto-healed (unassigned) and will be re-routed to a ` +
              `real agent automatically. If this recurs on the same box, check for stale ` +
              `data or a foreign-keys-off migration window.`,
            { agent: context, action: 'escalate' },
          );
        } catch {
          /* notify best-effort */
        }
      } else {
        // Lost the CAS race — a concurrent healer already cleared this exact
        // phantom id. No duplicate event, no duplicate alert; the task will
        // still be re-routed on the next tick.
        console.warn(
          `[${context}] autoDispatchTask: task ${taskId}'s phantom agent "${deadAgentId}" ` +
            `was already healed by a concurrent caller — skipping`,
        );
      }
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
    // DISP-03: the 'sop-authored-resume' path is the LEGITIMATE release of a
    // fast-loop HOLD — the SOP is now filed, so it MUST bypass the anti-furnace
    // backoff that the HOLD itself set below, otherwise the just-authored task
    // would be stranded in backoff until a later sweep tick (the resume calls
    // straight back into autoDispatchTask and would otherwise skip here).
    if (nextEligibleAt && nextEligibleAt > now && context !== 'sop-authored-resume') {
      console.log(
        `[${context}] autoDispatchTask: task ${taskId} in dispatch backoff until ${nextEligibleAt} — skip`,
      );
      return;
    }

    // GUARD 7 (skill6-v2 U33 / C-02 — gate-consistency pin): the automatic
    // advancer must honor the SAME Triad gate the UI PATCH path already
    // enforces (checkTriad, sops.ts:432; PATCH gate
    // api/tasks/[id]/route.ts:357–436) before claiming a card — closing the
    // exact asymmetry the master spec records (C+I.0 point 4): today the UI
    // blocks a Triad-incomplete card from leaving Backlog while the CAS claim
    // below (DISP-02) does not care. A HELD card is NEVER silent: a
    // queryable event is written every time this branch fires, naming the
    // missing field(s) in the SAME vocabulary the card pill uses
    // (board-labels.ts triadMissingPillText). Kill switch
    // TRIAD_ADVANCER_GATE=0 restores the pre-U33 bypass (documented revert
    // path).
    if (process.env.TRIAD_ADVANCER_GATE !== '0') {
      const triad = checkTriad({
        description: task.description,
        sop_id: task.sop_id,
        persona_id: task.persona_id,
      });
      if (triad.missing.length > 0) {
        const holdMsg =
          `[triad_gate_hold] Task "${task.title}" (${task.id}) held from auto-dispatch — ` +
          `${triadMissingPillText(triad.missing as TriadMissingKey[])}. The advancer will not claim a ` +
          `Triad-incomplete card — same gate the UI PATCH enforces. Complete grooming to release.`;
        console.warn(`[${context}] autoDispatchTask: ${holdMsg}`);
        try {
          run(
            `INSERT INTO events (id, type, task_id, message, created_at) VALUES (?, ?, ?, ?, ?)`,
            [uuidv4(), 'triad_gate_hold', task.id, holdMsg, new Date().toISOString()],
          );
        } catch {
          /* audit best-effort — never block the hold on the write itself */
        }
        return; // NOT claimable — held, loudly, never silently skipped
      }
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

    // ── Session: UPSERT keyed (agent_id, status='active') ───────────────────
    // B5: the openclaw_sessions row is the fragile link in the completion chain.
    // UPSERT it — reuse the agent's active session when present (refreshing its id
    // to the deterministic form + binding the CURRENT task for attribution), else
    // create it. Storing the deterministic id (identical to
    // deterministicOpenclawSessionId) lets the webhook / watcher re-derive it if
    // the row is ever purged.
    const openclawSessionId = deterministicOpenclawSessionId(agent.name);
    let session = queryOne<OpenClawSession>(
      'SELECT * FROM openclaw_sessions WHERE agent_id = ? AND status = ?',
      [agent.id, 'active'],
    );

    if (session) {
      // Refresh the active session: pin the deterministic id (self-heals a drifted
      // row) and bind task_id so completion webhook / execution-reconcile attribute
      // this turn to the right task.
      run(
        `UPDATE openclaw_sessions SET openclaw_session_id = ?, task_id = ?, updated_at = ? WHERE id = ?`,
        [openclawSessionId, task.id, now, session.id],
      );
      session = queryOne<OpenClawSession>('SELECT * FROM openclaw_sessions WHERE id = ?', [session.id]);
    } else {
      const sessionId = uuidv4();

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

    // ── AUDIENCE-CONFIRM GATE (persona-blend — BEFORE the write step) ────────
    // A content task whose persona bundle requires audience confirmation must NOT
    // be written/dispatched until the operator confirms the audience. Held tasks
    // are quietly deferred (short poll window, NOT counted toward the anti-furnace
    // block cap) and the operator is surfaced ONCE. NEVER-NAKED: past the deadline
    // we flip to house-voice governance and proceed. Non-content tasks (no bundle)
    // skip this entirely (no regression). Dynamic import avoids the
    // tasks<->task-dispatcher static import cycle (same pattern as the heal gate).
    try {
      const {
        evaluateAudienceConfirmGate, holdForAudienceConfirm, markAudienceDeadlineFallback,
        isHardHoldConfirmDepartment, blockForOwnerConfirm,
      } = await import('@/lib/tasks');
      const gate = evaluateAudienceConfirmGate(task.id);
      if (gate.hold) {
        holdForAudienceConfirm(task.id, agent.id, gate);
        console.log(
          `[${context}] autoDispatchTask: task ${taskId} HELD for audience confirmation — write gated`,
        );
        return; // write step gated — task stays claimable until confirmed/deadline
      }
      if (gate.state === 'deadline_fallback') {
        const dept = canonicalDeptSlug(task.department || task.workspace_id || '') || 'general';
        if (isHardHoldConfirmDepartment(dept)) {
          // A-U4 / D23 — kill the silent timeout for build departments: HARD-HOLD
          // to 'blocked' (block_audience='OWNER'), NEVER a house-voice release.
          blockForOwnerConfirm(task.id, dept, gate);
          console.warn(
            `[${context}] autoDispatchTask: task ${taskId} audience unconfirmed past deadline in ` +
              `hard-hold department "${dept}" — BLOCKED for owner (no house-voice release)`,
          );
          return; // write step gated — never dispatched under house voice
        }
        // NEVER-NAKED: unconfirmed past the deadline → dispatch under house-voice
        // governance only (buildPersonaBlock's fallback governs; the blend
        // directive's guardrail still renders). Audience is NOT fabricated.
        markAudienceDeadlineFallback(task.id);
        console.warn(
          `[${context}] autoDispatchTask: task ${taskId} audience unconfirmed past deadline — ` +
            `dispatching under house-voice governance only`,
        );
      }
    } catch (gateErr) {
      // Never block dispatch on the gate machinery itself (pre-090 DB, etc.).
      console.warn(
        `[${context}] audience-confirm gate non-fatal for task ${task.id}:`,
        (gateErr as Error).message,
      );
    }
    // ── End audience-confirm gate ────────────────────────────────────────────

    // ── AF-MODEL-SOVEREIGNTY gate ───────────────────────────────────────────
    // Block dispatch if resolved model is null, free default, forbidden, or
    // modality-wrong. Routes to needs_owner_input — never silently downgrades.
    const inventory = listModels();
    const required_modality = settings.required_modality ??
      detectModality(task.title, task.description);
    // P1-01: when the resolver degraded a would-be vision task to text (no active
    // vision model on the box), record the downgrade so the safety net is auditable
    // — dispatch then proceeds as a text attempt rather than blocking on a keyword.
    if (settings.modality_downgraded) {
      const dnNow = new Date().toISOString();
      const dnMsg =
        `[modality_downgraded] Task "${task.title}" (${task.id}) had no active vision model; ` +
        `degraded to a text attempt rather than blocking dispatch (P1-01 safety net).`;
      try {
        run(
          `INSERT INTO events (id, type, agent_id, task_id, message, created_at) VALUES (?, 'modality_downgraded', ?, ?, ?, ?)`,
          [uuidv4(), agent.id, task.id, dnMsg, dnNow],
        );
      } catch { /* pre-migration events table tolerant */ }
      console.warn(`[${context}] ${dnMsg}`);
    }
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
      // P1-01: a model-sovereignty refusal is NON-TRANSIENT — no retry can cure a
      // missing sovereign/modality-fit model. The old ladder retried it 5× over
      // ~33 min and only alerted the owner at the cap (the silent-refusal defect).
      // It now BLOCKS + notifies the OWNER on attempt 1 (hardBlock). With the
      // sovereign-default (W8.5) + the P1-01 vision→text downgrade, this gate now
      // only trips on a genuine, un-downgradable modality gap (e.g. an
      // image/video/audio-generation task with no matching model).
      recordDispatchFailure(task.id, agent.id, {
        reason: `model_sovereignty_${sovereigntyViolation.reason}`,
        audience: 'OWNER',
        needs:
          'No sovereign model resolved for this task. Assign/approve a model ' +
          '(Settings → Models) to release it.',
        context,
        hardBlock: true,
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
          // DISP-03: this HOLD previously returned with NO accounting, so every
          // sweep tick re-selected the still-SOP-less card and re-fired the
          // authoring loop (~every 2 min, uncapped) — a furnace that also spawns
          // duplicate authoring sub-tasks. Record the pending attempt so the
          // sweeps back off (via next_dispatch_eligible_at + GUARD 6) between
          // ticks, and — if authoring never yields an SOP after the cap — the
          // card BLOCKS with a SYSTEM report instead of looping forever. The
          // happy path is unaffected: sop-authored-resume bypasses the backoff
          // (GUARD 6) and recordDispatchSuccess clears this counter on dispatch.
          recordDispatchFailure(task.id, agent.id, {
            reason: 'sop_authoring_pending',
            audience: 'SYSTEM',
            needs:
              `Custom dept "${deptSlug}" has no SOP yet; the authoring fast loop is running. ` +
              'It resumes automatically once the SOP is filed.',
            context,
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
          // D9: a CHANGED rescore that invalidated a stale blend directive
          // (rescorePersonaWithSOP neutralized it — see invalidateStaleBlendOnRescore
          // in tasks.ts) returns the NEW mirror value here. Patch it onto the
          // in-memory row too — otherwise buildPersonaBlock below would still render
          // the STALE directive (computed against the OLD persona) riding on top of
          // the newly-rescored persona_id. `undefined` (no bundle existed) leaves
          // task.blend_directive untouched — unchanged pre-D9 behavior.
          if (rescored.blend_directive !== undefined) {
            task.blend_directive = rescored.blend_directive;
          }
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
    // Layer A (departments-that-use-skills): match installed SKILL.md files to
    // the task and hand the top-3 to the doer. Async (embeddings) so it runs
    // BEFORE the synchronous pack builder; never throws (degrades to []).
    let matchedSkills: MatchedSkill[] = [];
    try {
      matchedSkills = await matchSkillsForTask({
        title: task.title,
        description: task.description,
        department: task.department,
      });
    } catch {
      matchedSkills = [];
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
          matchedSkills,
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

    // DEP-5 / F3.7 — when the task was decomposed into a multi-persona plan,
    // deliver a PERSONA PLAN block (one Section-4 pointer per non-mechanical
    // sub-task, buildPersonaBlock ×N) IN ADDITION to the primary persona block.
    // Single-persona tasks (0/1 plan rows) render only the primary block —
    // buildPersonaPlanBlock returns '' so there is no regression.
    const subtaskPlan = loadSubtaskPersonas(task.id);
    const personaPlanBlock = buildPersonaPlanBlock(subtaskPlan, settings);
    const personaSection = personaPlanBlock
      ? `${buildPersonaBlock(task, settings)}\n${personaPlanBlock}`
      : buildPersonaBlock(task, settings);

    const taskMessage = `${priorityEmoji} **NEW TASK ASSIGNED**

**Title:** ${task.title}
${task.description ? `**Description:** ${task.description}\n` : ''}
**Priority:** ${task.priority.toUpperCase()}
${task.due_date ? `**Due:** ${task.due_date}\n` : ''}
**Task ID:** ${task.id}
${sopBlock ? `${sopBlock}` : ''}**Agent Model:** ${settings.model}
${personaSection}
**Specialist Type:** ${specialistType}
${artifactFragment}${contextPack ? renderContextPackSection(contextPack) : ''}
${renderWriteBackInstructions(missionControlUrl, task.id, 'artifact', `${taskArtifactDir}/filename.png`)}

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

    // ── FAIL-LOUD write-back auth guard (PREVENTION, src/lib/mc-auth.ts) ──────
    // Mirror of the dispatch/route.ts guard. Before the CAS below flips this
    // task to in_progress, verify a dispatched agent can AUTHENTICATE its
    // write-backs. MC_API_TOKEN unset on a box that rejects external POST/PATCH
    // (src/middleware.ts Gate B) → the agent finishes but every write-back 401s
    // and the card freezes in_progress until the stuck sweep blocks it (the
    // carded-but-trapped defect). HOLD + SYSTEM report NOW instead of claiming
    // and dispatching work that cannot report back. Dev insecure-open passes.
    const writeAuth = checkTaskWriteAuth();
    if (!writeAuth.ok) {
      console.error(`[${context}] autoDispatchTask: HELD task ${task.id} — task-API write-back auth not provisioned: ${writeAuth.reason}`);
      const nowAuth = new Date().toISOString();
      run(
        `INSERT INTO events (id, type, agent_id, task_id, message, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [uuidv4(), 'routed_but_not_dispatched', agent.id, task.id, `[mc_api_token_unset] ${writeAuth.reason}`, nowAuth],
      );
      recordDispatchFailure(task.id, agent.id, {
        reason: 'mc_api_token_unset',
        audience: 'SYSTEM',
        needs: writeAuth.reason,
        context,
      });
      return;
    }

    // ── DISP-02: atomic CLAIM before send (close the SELECT→send TOCTOU) ────
    // Two concurrent advancers (overlapping sweeps + the create-time
    // auto-dispatch) can both pass the load-time GUARD 3 status check and reach
    // here, then each fire chat.send → double invocation. Claim the card with a
    // compare-and-swap that only matches a still-claimable status; if we don't
    // win the swap (changes !== 1) another advancer already claimed it — return
    // WITHOUT sending. Pairs with the stable idempotencyKey (DISP-01) so even a
    // same-instant collision the CAS didn't serialize is collapsed at the gateway.
    const claim = run(
      `UPDATE tasks SET status = 'in_progress', updated_at = ?
         WHERE id = ? AND status IN ('backlog','inbox','planning','pending_dispatch','assigned')`,
      [now, task.id],
    );
    if (claim.changes !== 1) {
      console.log(
        `[${context}] autoDispatchTask: task ${taskId} was already claimed by a concurrent ` +
          `advancer (CAS matched ${claim.changes} rows) — skipping send to avoid a double dispatch`,
      );
      return;
    }

    // DISP-01: stable idempotency key. Was `Date.now()`, which handed every
    // re-fire — including two advancers racing the SAME window — a UNIQUE key,
    // so the gateway could never dedup a concurrent double-send. Key on the
    // attempt counter instead: genuine retries (after recordDispatchFailure
    // bumps dispatch_attempts) get a fresh key, but two advancers in one window
    // read the same counter → identical key → the gateway collapses them.
    try {
      await client.call('chat.send', {
        sessionKey,
        message: taskMessage,
        idempotencyKey: `auto-dispatch-${task.id}-${task.dispatch_attempts ?? 0}`,
      });
    } catch (sendErr) {
      // DISP-02 send-failure rollback: we already CAS-claimed the card to
      // in_progress; a failed send must NOT strand it there. Restore the prior
      // status (only if we still hold the in_progress we set) so a sweep can
      // re-select it, then account for the failed advance (backoff → cap) so it
      // never re-fires every tick.
      console.error(`[${context}] autoDispatchTask: chat.send failed for task ${task.id} — rolling back claim:`, sendErr);
      const rollbackNow = new Date().toISOString();
      run(
        `UPDATE tasks SET status = ?, updated_at = ? WHERE id = ? AND status = 'in_progress'`,
        [task.status, rollbackNow, task.id],
      );
      try {
        const rolledBack = queryOne<Task>('SELECT * FROM tasks WHERE id = ?', [task.id]);
        if (rolledBack) broadcast({ type: 'task_updated', payload: rolledBack });
      } catch { /* broadcast best-effort */ }
      recordDispatchFailure(task.id, agent.id, {
        reason: 'chat_send_failed',
        audience: 'SYSTEM',
        needs:
          'OpenClaw chat.send failed at dispatch. The task was returned to the queue; it ' +
          'retries with backoff and stays visible until it sends or hits the cap.',
        context,
      });
      return;
    }

    // ── Post-claim bookkeeping (status already advanced by the DISP-02 CAS) ──
    // The DISP-02 CAS above ALREADY advanced the card to in_progress atomically,
    // so we do NOT re-run transition(→in_progress) here: with status already
    // in_progress, transition() takes its idempotent from===to branch (no audit
    // row, no broadcast) — and force-setting in_progress could REGRESS a task a
    // fast agent has meanwhile moved to review. Instead pin the resolved model_id
    // and broadcast the CURRENT row so the board reflects live state.
    //
    // CROSS-LANE NOTE (DISP-10 / DATA-07, Lane L3): the CAS claim is a raw status
    // write that bypasses transition()'s task_events audit. The dispatch is still
    // recorded via the 'task_dispatched' events row + task_activities below; L3's
    // lifecycle-funnel work should fold this claim into the audited path.
    if (settings.model) {
      run('UPDATE tasks SET model_id = ?, updated_at = ? WHERE id = ?', [settings.model, now, task.id]);
    }
    try {
      const updatedTask = queryOne<Task>('SELECT * FROM tasks WHERE id = ?', [task.id]);
      if (updatedTask) broadcast({ type: 'task_updated', payload: updatedTask });
    } catch { /* broadcast best-effort */ }

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
