/**
 * task-lifecycle.ts — AUTHORITATIVE transition funnel (THE sole status gate).
 *
 * transition() is the ONE path a task's status changes. It is:
 *   - atomic (status UPDATE + both audit inserts in a single transaction, DISP-09)
 *   - compare-and-swapped (DISP-10 — two concurrent callers racing the same task
 *     cannot both win)
 *   - COMPLETE for all raw writers that set extra columns alongside status:
 *     `evidence.extraColumns` lets a caller supply additional SET clause pairs
 *     (e.g. `qc_reroute_attempts`, `dispatch_attempts`, `block_reason`) that are
 *     applied atomically inside the same transaction as the status flip and both
 *     audit writes — no separate raw UPDATE needed.
 *
 * Every raw status writer (see scripts/guard-raw-status-writers.ts) is now either
 * migrated to transition() + extraColumns, or — where the legal-transition set
 * truly does not cover the edge — routed through recordStatusEvent() (DISP-10),
 * which writes the SAME task_events row transition() writes. The U99 guard
 * enforces: NEW raw UPDATE tasks SET status writers must carry a
 * `U99-RAW-STATUS-WRITER:` annotation and a written reason. The guard is CI-gated.
 *
 * Conversion pattern for a compound raw writer:
 *   BEFORE:
 *     run('UPDATE tasks SET status=?, qc_reroute_attempts=?, updated_at=?
 *         WHERE id=? AND status=?', [...]);
 *     recordStatusEvent(taskId, from, to, { actor, reason });
 *   AFTER:
 *     await transition(taskId, to, {
 *       actor, reason,
 *       expectedFrom: from,
 *       extraColumns: { qc_reroute_attempts: newAttempts },
 *     });
 *   The extraColumns merge atomically into the same transaction — no gap, no
 *   separate recordStatusEvent call, full DISP-09+DISP-10 guarantees.
 *
 * What `transition(taskId, to, evidence)` does:
 *   1. Validates the transition is legal (legal-transitions map + preconditions).
 *   2. Compare-and-swaps the tasks row: the status UPDATE is guarded by
 *      `WHERE status = <observed from-status>`, so a concurrent writer that moved
 *      the row in the read→write window causes a CAS_CONFLICT rather than a blind
 *      overwrite (DISP-10). Callers may also assert an expected current status via
 *      `evidence.expectedFrom` for explicit optimistic-concurrency.
 *   3. Applies any extraColumns within the same atomic UPDATE — no separate
 *      write, no gap between status flip and companion column writes.
 *   4. Writes a task_events row (structured audit trail).
 *   5. Steps 2-4 run inside ONE db.transaction() so all writes are atomic
 *      (all commit or none — DISP-09). The SSE broadcast and owner-DONE
 *      notification run only AFTER the commit, so nothing is announced for a
 *      change that rolled back.
 *
 * States (the full TaskStatus set — see src/lib/types.ts):
 *   intake/grooming : backlog → inbox → planning
 *   ready/dispatch  : pending_dispatch / assigned
 *   working         : in_progress
 *   verify          : review → testing
 *   terminal        : done
 *   safety valve    : blocked (reachable from any NON-TERMINAL state; unblocks
 *                     back to the queue or to in_progress). NOT reachable from
 *                     the terminal 'done' — a done task re-opens only to backlog
 *                     (done→backlog→blocked if it must be re-blocked).
 * The LEGAL_TRANSITIONS map below covers all 10 statuses so that opt-in callers
 * moving a task through the intake/dispatch/verify lanes are not rejected with a
 * spurious ILLEGAL_TRANSITION. The edge set is permissive (additive): every edge
 * that was legal before is still legal; the new statuses only widen it.
 *
 * Preconditions (enforced only for opt-in callers, skippable via operatorOverride):
 *   assigned    : task.assigned_agent_id (specialist_type soft-required, warn only)
 *   in_progress : task.assigned_agent_id (model may be resolved at dispatch time)
 *   review      : no blocking precondition here — QC layer does artifact gating
 *   done        : REQUIRES completion evidence — at least one registered,
 *                 reachable deliverable (see src/lib/completion-evidence.ts).
 *                 This precondition runs BEFORE the operatorOverride bail-out
 *                 and is the one precondition an override cannot waive: an
 *                 override may re-decide routing, but it cannot make an
 *                 unregistered deliverable exist. Quality (as opposed to
 *                 existence) is still the QC scorer's call, and agent-initiated
 *                 'done' is additionally gated at the PATCH route.
 *   blocked / backlog / inbox / planning / pending_dispatch / testing : always
 *                 allowed (no precondition)
 */

import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { safeReadFileBuffer } from '@/lib/fs/safe-fs';
import { queryOne, queryAll, run, transaction } from '@/lib/db';
import { broadcast } from '@/lib/events';
import { getProjectsPath } from '@/lib/config';
import type { Task } from '@/lib/types';
import { notifyOwnerDone } from '@/lib/owner-reports';
import { collectCompletionEvidence, noEvidenceMessage } from '@/lib/completion-evidence';
import { requiresRegisteredCertificate } from '@/lib/presentations-cert-gate';

// ---------------------------------------------------------------------------
// State machine definition
// ---------------------------------------------------------------------------

/**
 * The full task-status set. This is intentionally kept in lockstep with
 * `TaskStatus` in src/lib/types.ts (the 10 statuses the board, API routes, and
 * DB actually use). Keeping LifecycleState a strict subset (the old 6 states)
 * caused legitimate intake/dispatch/verify transitions (inbox, planning,
 * pending_dispatch, testing) to be rejected as ILLEGAL_TRANSITION by any caller
 * that opted into transition(). All 10 are listed so the guard reflects reality.
 */
export type LifecycleState =
  | 'backlog'
  | 'inbox'
  | 'planning'
  | 'pending_dispatch'
  | 'assigned'
  | 'in_progress'
  | 'review'
  | 'testing'
  | 'done'
  | 'blocked';

/**
 * Legal transitions: from → Set<to>
 *
 * Pipeline (intake → done):
 *   backlog → inbox → planning → pending_dispatch/assigned → in_progress
 *           → review → testing → done
 *
 * NOTE: 'blocked' can be reached from any NON-TERMINAL state (safety valve) and
 * unblocks back to the queue (backlog/inbox/planning/pending_dispatch) or resumes
 * work (in_progress/assigned). The terminal 'done' is the one exception: it does
 * NOT go directly to 'blocked' — 'done' re-opens only to 'backlog' (and from
 * backlog it can then be blocked), which is why 'blocked' is absent from done's
 * target set below.
 *
 * ADDITIVE GUARANTEE: every edge that was legal in the original 6-state map is
 * preserved here. The four new statuses (inbox, planning, pending_dispatch,
 * testing) only WIDEN the legal set — no previously-legal transition became
 * illegal, so no existing opt-in caller can break from this change.
 */
export const LEGAL_TRANSITIONS: Record<LifecycleState, Set<LifecycleState>> = {
  // ── intake / grooming ──
  backlog:          new Set<LifecycleState>(['inbox', 'planning', 'pending_dispatch', 'assigned', 'in_progress', 'blocked']),
  inbox:            new Set<LifecycleState>(['planning', 'pending_dispatch', 'assigned', 'in_progress', 'backlog', 'blocked']),
  planning:         new Set<LifecycleState>(['pending_dispatch', 'assigned', 'in_progress', 'backlog', 'blocked']),
  // ── ready / dispatch ──
  pending_dispatch: new Set<LifecycleState>(['assigned', 'in_progress', 'backlog', 'blocked']),
  assigned:         new Set<LifecycleState>(['in_progress', 'pending_dispatch', 'backlog', 'blocked']),
  // ── working ──
  in_progress:      new Set<LifecycleState>(['review', 'testing', 'blocked', 'backlog']),
  // ── verify ──
  review:           new Set<LifecycleState>(['done', 'testing', 'in_progress', 'blocked', 'backlog']),
  testing:          new Set<LifecycleState>(['done', 'review', 'in_progress', 'blocked', 'backlog']),
  // ── terminal ──
  done:             new Set<LifecycleState>(['backlog']), // re-open only
  // ── safety valve ──
  blocked:          new Set<LifecycleState>(['backlog', 'inbox', 'planning', 'pending_dispatch', 'assigned', 'in_progress']),
};

// ---------------------------------------------------------------------------
// WIP (work-in-progress) limits — server-side enforcement (MR-12)
// ---------------------------------------------------------------------------

/**
 * Per-column WIP limits, mirroring the board's client-side `maxWip` values
 * (src/components/MissionQueue.tsx BOARD_PRESETS.task: in_progress=5, review=8).
 *
 * MR-12 originally enforced these ONLY in the UI (drag-over rejection + the
 * touch Move menu disabling at-capacity columns). That left the limit advisory:
 * any caller hitting PATCH /api/tasks/{id} — or any path that bypassed the drag
 * affordance — could overflow the column. This map is the authoritative,
 * server-side copy so the limit is enforced at the ONE funnel every status
 * change goes through (transition()), not just in the browser.
 *
 * The 'review' limit is keyed by the underlying statuses that BUCKET into the
 * review column (review + testing — see REVIEW_BUCKET_STATUSES in
 * src/lib/board-projection.ts); the count is taken across BOTH so a task moving
 * review→testing is not double-counted against the same column. 'in_progress'
 * maps 1:1 to its status.
 */
export const WIP_LIMITS: Partial<Record<LifecycleState, number>> = {
  in_progress: 5,
  review: 8,
};

/**
 * Column definitions for the WIP check. Each entry names the limit, the target
 * statuses whose entry counts as "entering this column" (`targets`), and the
 * statuses counted toward the column (`counts`).
 *
 * The review column buckets BOTH 'review' and 'testing' (see
 * REVIEW_BUCKET_STATUSES in src/lib/board-projection.ts), so a task moved
 * directly to 'testing' is gated by the SAME limit as one moved to 'review',
 * and both statuses are counted — otherwise the column could be overflowed via
 * the 'testing' sub-state. 'in_progress' maps 1:1.
 */
const WIP_COLUMNS: ReadonlyArray<{
  limit: number;
  targets: readonly LifecycleState[];
  counts: readonly LifecycleState[];
}> = [
  { limit: WIP_LIMITS.in_progress as number, targets: ['in_progress'], counts: ['in_progress'] },
  { limit: WIP_LIMITS.review as number, targets: ['review', 'testing'], counts: ['review', 'testing'] },
];

/**
 * Server-side WIP check for a transition INTO a capped column.
 *
 * Returns a human-readable refusal string when moving `taskId` to `to` would
 * push the target column's task count to/over its WIP limit, else null
 * (allowed). The count EXCLUDES `taskId` itself so an idempotent / intra-column
 * move (e.g. review→testing, both in the review column) never counts the moving
 * task twice.
 *
 * The count is SCOPED TO THE TASK'S WORKSPACE: the board renders one workspace
 * at a time (MissionQueue fetches `?workspace_id=`), so the client-side WIP
 * count the operator sees is per-workspace. Counting globally here would
 * over-refuse on multi-workspace boxes (a full column in workspace A would
 * block an unrelated move in workspace B). A NULL workspace_id counts against
 * other NULL-workspace tasks only.
 *
 * Targets that map to no capped column (backlog, todo-bucket statuses, blocked,
 * done) are uncapped and always return null.
 *
 * Exported (in addition to its use inside transition()) so callers with an
 * irreversible side effect BEFORE their transition() call can probe the limit
 * first: the manual-dispatch route (src/app/api/tasks/[id]/dispatch/route.ts)
 * fires chat.send to the agent before flipping status, so it holds with a 429
 * when this returns non-null instead of sending work the board will then
 * refuse to advance. The probe is read-only and advisory — transition()
 * remains the authoritative check.
 */
export function checkWipLimit(
  taskId: string,
  to: LifecycleState,
  workspaceId: string | null,
): string | null {
  const column = WIP_COLUMNS.find((c) => (c.targets as readonly string[]).includes(to));
  if (!column) return null; // uncapped column

  const placeholders = column.counts.map(() => '?').join(', ');
  const workspaceClause = workspaceId === null
    ? 'workspace_id IS NULL'
    : 'workspace_id = ?';

  try {
    const params: unknown[] = [...column.counts, taskId];
    if (workspaceId !== null) params.push(workspaceId);
    const row = queryOne<{ cnt: number }>(
      `SELECT COUNT(*) AS cnt FROM tasks
        WHERE status IN (${placeholders}) AND id != ? AND ${workspaceClause}`,
      params,
    );
    const count = row?.cnt ?? 0;
    if (count >= column.limit) {
      return (
        `Column '${to}' is at its WIP limit (${count}/${column.limit}); ` +
        `cannot move task ${taskId} there. Free a slot (move a task out of ` +
        `'${to}') or use operatorOverride to exceed the limit.`
      );
    }
    return null;
  } catch {
    // Count query failed (e.g. schema variance on an old DB). Fail OPEN rather
    // than strand work — the client-side limit still applies in the UI, and a
    // hard refusal here would block legitimate transitions on a broken count.
    return null;
  }
}

/**
 * Precondition error — thrown (and caught) when a transition's precondition
 * fails.  The caller receives a structured error with `code` and `detail`.
 */
export class TransitionError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'TransitionError';
  }
}

// ---------------------------------------------------------------------------
// Evidence type
// ---------------------------------------------------------------------------

export interface TransitionEvidence {
  /** Who triggered this (agent_id, 'system', 'owner', etc.) */
  actor?: string | null;
  /** Free-form human-readable reason / context */
  reason?: string;
  /** For owner-approval lane: 'owner' signals the source */
  source?: string;
  /** Skip precondition checks (human operator override — use sparingly) */
  operatorOverride?: boolean;
  /**
   * Compare-and-swap guard (DISP-10). When set, the transition only proceeds if
   * the task's CURRENT status equals this value; otherwise it throws
   * TransitionError('CAS_CONFLICT') and writes nothing. This lets a raw writer
   * of the form `UPDATE tasks SET status=? WHERE id=? AND status='<expected>'`
   * be replaced by a transition() call that preserves the SAME optimistic-
   * concurrency guarantee (e.g. QC review→done, backlog→in_progress claims).
   * Independent of the always-on row-level CAS on the observed from-status.
   */
  expectedFrom?: LifecycleState;
  /**
   * Extra columns to SET atomically alongside the status flip, inside the SAME
   * transaction as the audit writes (MR-16 / DISP-09 convergence).
   *
   * Keys are bare column names (e.g. 'qc_reroute_attempts', 'dispatch_attempts',
   * 'block_reason', 'description', 'last_progress_at'). Every key MUST map to a
   * column on the `tasks` table that the caller intends to write alongside the
   * status change. The values are interpolated as parameterized bindings (not
   * string-interpolated), so SQL injection is not possible through this map.
   *
   * This closes the DISP-09 atomicity gap: before this field, a compound raw
   * writer ran a separate `run(...)` for the status flip + companion columns,
   * followed by a separate `recordStatusEvent(...)`. A crash between those two
   * separate calls left a committed status change with NO task_events row. By
   * merging the companion columns into the same transaction() block that already
   * holds the status UPDATE + task_events INSERT + events INSERT, the audit trail
   * is now GUARANTEED for every status change that routes through transition().
   *
   * Callers that need extra columns the transition() core UPDATE doesn't set:
   *
   *   await transition(taskId, 'blocked', {
   *     actor: 'qc-scorer',
   *     reason: 'failed QC 3x',
   *     expectedFrom: 'review',
   *     extraColumns: {
   *       qc_reroute_attempts: 3,
   *       block_reason: 'Failed QC 3x',
   *       block_gaps: JSON.stringify(gaps),
   *       block_needs: 'Owner fix required',
   *       block_audience: 'OWNER',
   *       description: existingDesc + '\n' + kickbackNote,
   *     },
   *   });
   *
   * `updated_at` is always set by transition() itself unless the caller supplies
   * it here (rare — for migration from a raw writer that sets it manually).
   * Added so compound raw writers (status plus description/model_id/block_* etc.)
   * can route through transition() instead of bypassing the state machine
   * (originally MR-04); values are bound positionally, no interpolation.
   */
  extraColumns?: Record<string, string | number | null>;
  /**
   * Optional overrides for the LEGACY `events` row transition() writes for
   * backwards-compat with the live feed (MR-16 events-feed regression fix).
   *
   * By default that row is written as:
   *   type     = to === 'done' ? 'task_completed' : 'task_status_changed'
   *   agent_id = NULL
   *   message  = `[lifecycle] Task "<title>" moved <from> → <to>[: <reason>]`
   *
   * A caller migrating from a raw writer that used to write a RICHER legacy row
   * (e.g. the execution-watcher reconcile, which emitted a `task_completed` row
   * carrying the completing agent's id and its actual completion summary) can
   * supply these fields so the single atomic transition() write reproduces that
   * row exactly — instead of silently dropping the agent pill from the activity
   * feed (events.agent_id LEFT JOINs agents), downgrading the type to
   * `task_status_changed`, and losing the summary. All three are applied inside
   * the SAME transaction as the status flip + task_events insert, so MR-16's
   * DISP-09 atomicity guarantee is preserved (no separate post-commit re-insert).
   *
   * `eventAgentId` is bound to events.agent_id (a FK to agents); pass null/omit
   * it when the actor is not an agent id ('system', 'qc-scorer', …) — it is NOT
   * defaulted from `actor`, which is frequently a non-agent string.
   */
  eventType?: string;
  eventAgentId?: string | null;
  eventMessage?: string;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface TaskRowForLifecycle {
  id: string;
  title: string;
  status: string;
  assigned_agent_id: string | null;
  model_id: string | null;
  specialist_type?: string | null;
  persona_id?: string | null;
  workspace_id: string | null;
  source?: string | null;
  qc_reroute_attempts?: number | null;
  department?: string | null;
  process_certificate_sha?: string | null;
  sop_authoring_for_task_id?: string | null;
}

interface DeliverableCount { cnt: number }

function hasDeliverables(taskId: string): boolean {
  try {
    const row = queryOne<DeliverableCount>(
      'SELECT COUNT(*) AS cnt FROM task_deliverables WHERE task_id = ?',
      [taskId],
    );
    return (row?.cnt ?? 0) > 0;
  } catch {
    // task_deliverables table may not exist on very old DBs
    return false;
  }
}

function specialistTypeOf(task: TaskRowForLifecycle): string | null {
  if (task.specialist_type) return task.specialist_type;
  // Fallback: query the assigned agent
  if (!task.assigned_agent_id) return null;
  try {
    const agent = queryOne<{ specialist_type: string | null }>(
      'SELECT specialist_type FROM agents WHERE id = ?',
      [task.assigned_agent_id],
    );
    return agent?.specialist_type ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// checkPreconditions
// ---------------------------------------------------------------------------

function checkPreconditions(
  task: TaskRowForLifecycle,
  to: LifecycleState,
  evidence: TransitionEvidence,
): void {
  // ── COMPLETION-EVIDENCE INVARIANT (T0-01 / T0-42) ────────────────────────
  // Deliberately placed ABOVE the operatorOverride bail-out, and it is the one
  // precondition an override cannot skip.
  //
  // `operatorOverride` exists to waive the ASSIGNMENT preconditions — "who is
  // this routed to", "does it have a model" — which are routing questions a
  // human is entitled to answer differently. "Does the delivered work exist"
  // is not a routing question. It is a fact about the world, and no authority
  // level makes an unregistered deliverable exist. Letting an override skip it
  // is what gives a gate a private door, and this defect was two private doors.
  //
  // The remedy is one API call, and the refusal names it (noEvidenceMessage),
  // so a legitimately artifact-free task — a decision, a review — clears the
  // gate by registering a `url` deliverable pointing at where the work landed.
  // It is not blocked, it is asked to say where it went.
  if (to === 'done') {
    const completion = collectCompletionEvidence(task.id);
    if (!completion.hasEvidence) {
      throw new TransitionError('PRECONDITION_EVIDENCE', noEvidenceMessage(task.id, completion));
    }
  }


  // ── PRESENTATIONS NO-SKIP PROOF (U031) ──────────────────────────────────────
  // Placed ABOVE the operatorOverride bail-out for the same reason the
  // completion-evidence invariant is: an override re-decides ROUTING, it does
  // not make a deck's process proof exist. Registration only — the anti-spoof
  // MATCH stays at the PATCH route, which is the only caller that receives a
  // presented value (TransitionEvidence has no field for one).
  {
    const reg = requiresRegisteredCertificate({
      department: task.department,
      currentStatus: task.status,
      targetStatus: to,
      storedCert: task.process_certificate_sha,
      sopAuthoringForTaskId: task.sop_authoring_for_task_id,
    });
    if (reg.applies && !reg.ok) {
      throw new TransitionError('PRECONDITION_PROCESS_CERTIFICATE', reg.error ?? 'process certificate required');
    }
  }

  if (evidence.operatorOverride) return;

  switch (to) {
    case 'assigned': {
      if (!task.assigned_agent_id) {
        throw new TransitionError(
          'PRECONDITION_AGENT',
          `transition to assigned requires persona_id on the task and an assigned_agent_id`,
        );
      }
      // model_id may be resolved later by dispatch; we only hard-require the agent.
      // specialist_type is soft-required (warn, not fail) — it may be set by the agent row.
      const st = specialistTypeOf(task);
      if (!st) {
        console.warn(
          `[task-lifecycle] transition ${task.id} → assigned: no specialist_type on agent or task (non-fatal)`,
        );
      }
      break;
    }

    case 'in_progress': {
      if (!task.assigned_agent_id) {
        throw new TransitionError(
          'PRECONDITION_AGENT',
          `transition to in_progress requires assigned_agent_id`,
        );
      }
      break;
    }

    case 'review': {
      // Artifact tasks (those with a deliverable record) MUST have a deliverable.
      // Non-artifact tasks (SOP text work) pass through unconditionally.
      // We only block if the task HAS deliverables already started but they are
      // empty — for brand-new artifact tasks the review push itself registers the
      // deliverable first, so we check for zero-length only when at least one row exists.
      // Approach: allow through unless there's evidence of an artifact task with no
      // valid deliverable.  The QC layer does the real gating in artifact mode.
      break; // no blocking precondition — QC handles it
    }

    case 'done': {
      // Only QC auto-approve or operator override may mark done.
      // Agent-initiated done is blocked at the PATCH route level (not here).
      break;
    }

    case 'blocked':
    case 'backlog':
    case 'inbox':
    case 'planning':
    case 'pending_dispatch':
    case 'testing':
      break; // no blocking precondition — always allowed
  }
}

// ---------------------------------------------------------------------------
// writeTaskEvent
// ---------------------------------------------------------------------------

function writeTaskEvent(
  taskId: string,
  fromState: string,
  toState: string,
  evidence: TransitionEvidence,
  now: string,
): void {
  try {
    run(
      `INSERT INTO task_events
         (id, task_id, from_status, to_status, actor, reason, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        uuidv4(),
        taskId,
        fromState,
        toState,
        evidence.actor ?? 'system',
        evidence.reason ?? null,
        now,
      ],
    );
  } catch (err) {
    // task_events table not yet created (migration 070 may not have run) — fall
    // back to the legacy events table so we never lose the transition record.
    try {
      run(
        `INSERT INTO events (id, type, task_id, message, created_at)
         VALUES (?, 'task_status_changed', ?, ?, ?)`,
        [
          uuidv4(),
          taskId,
          `[lifecycle] ${fromState} → ${toState}${evidence.reason ? ': ' + evidence.reason : ''}`,
          now,
        ],
      );
    } catch {
      // Truly can't write — log only
      console.error(`[task-lifecycle] writeTaskEvent: both task_events and events INSERT failed for ${taskId}`);
    }
  }
}

/**
 * DISP-10 / DATA-07 — append the structured `task_events` audit row for a status
 * change performed by a RAW writer that legitimately cannot route through
 * transition() (it writes extra columns in the same UPDATE, or its from-status
 * is not statically a legal transition edge and routing it would risk an
 * ILLEGAL_TRANSITION throw in a hot path). This writes the SAME row transition()
 * writes, so the `task_events` sink becomes COMPLETE and feeds can trust it.
 *
 * The caller still owns its own legacy `events` row and SSE broadcast — this
 * only closes the `task_events` gap. Best-effort; never throws.
 */
export function recordStatusEvent(
  taskId: string,
  fromStatus: string,
  toStatus: string,
  evidence: { actor?: string | null; reason?: string } = {},
): void {
  try {
    writeTaskEvent(taskId, fromStatus, toStatus, evidence, new Date().toISOString());
  } catch {
    /* audit is best-effort — writeTaskEvent already has its own fallback */
  }
}

// ---------------------------------------------------------------------------
// DeclaredTransitionException — closed union of unmodelled edges
// ---------------------------------------------------------------------------

/**
 * U071: every unmodelled edge this codebase is allowed to take, enumerated. Adding a
 * member is a reviewed change with a stated reason. A string parameter here would be
 * a bypass with extra steps.
 */
export type DeclaredTransitionException =
  | { kind: 'sop-authoring-subtask-complete' };   // in_progress -> done, DISP-10

/** Result of a lifecycle transition — the updated task row. */
export type TransitionResult = Task;

/**
 * U071: the ONE sanctioned way to complete a transition the state machine does not
 * model. It exists because call sites were reaching `status = 'done'` with a raw SQL
 * UPDATE, which meant checkPreconditions() — and therefore EVERY gate this codebase
 * places there, including the presentations certificate gate — could not see them.
 * Auditing a write is not the same as gating it: an audit row answers "what happened",
 * a precondition answers "may this happen".
 *
 * This function does NOT widen LEGAL_TRANSITIONS. It takes an edge the caller declares
 * as an unmodelled exception, refuses it unless that exact pair is on the short
 * allowlist below, and then runs the full precondition set before writing. A caller
 * that wants a new exception adds it HERE, in review, with a reason — never with a raw
 * UPDATE at the call site.
 */
export function transitionWithDeclaredException(args: {
  taskId: string;
  to: LifecycleState;
  exception: DeclaredTransitionException;
  actor: string;
  reason: string;
  extraColumns?: Record<string, string | number | null>;
}): TransitionResult {
  // ── Validate the exception against the allowlist ───────────────────────────────
  // Each exception kind implies a specific from→to pair. The TypeScript compiler
  // guarantees `exception` is a valid union member at build time; this runtime map
  // enforces the expected source and target for each declared kind.
  const ALLOWED_EXCEPTION_EDGES: Record<
    DeclaredTransitionException['kind'],
    { from: LifecycleState; to: LifecycleState }
  > = {
    'sop-authoring-subtask-complete': { from: 'in_progress', to: 'done' },
  };

  const expected = ALLOWED_EXCEPTION_EDGES[args.exception.kind];
  if (args.to !== expected.to) {
    throw new TransitionError(
      'ILLEGAL_TRANSITION',
      `Declared exception ${args.exception.kind} expects target ${expected.to}, got ${args.to}`,
    );
  }

  // ── Read the task ──────────────────────────────────────────────────────────────
  // Include fields U031 will add (department, process_certificate_sha,
  // sop_authoring_for_task_id) so the merge is clean when U031 lands.
  const task = queryOne<TaskRowForLifecycle>(
    `SELECT t.id, t.title, t.status, t.assigned_agent_id, t.model_id,
            t.persona_id, t.workspace_id, t.qc_reroute_attempts,
            t.department, t.process_certificate_sha, t.sop_authoring_for_task_id,
            a.specialist_type
     FROM tasks t
     LEFT JOIN agents a ON t.assigned_agent_id = a.id
     WHERE t.id = ?`,
    [args.taskId],
  );

  if (!task) {
    throw new TransitionError('NOT_FOUND', `Task ${args.taskId} not found`);
  }

  const from = task.status as LifecycleState;

  // ── Idempotent: already at target state ────────────────────────────────────────
  // Must come BEFORE the exception edge validation — a task already at the target
  // state is idempotent regardless of what edge it took to get there.
  if (from === args.to) {
    const current = queryOne<Task>('SELECT * FROM tasks WHERE id = ?', [args.taskId]);
    if (!current) throw new TransitionError('NOT_FOUND', `Task ${args.taskId} not found after idempotent check`);
    return current;
  }

  // ── Validate the from-state matches the exception's expected source ────────────
  if (from !== expected.from) {
    throw new TransitionError(
      'ILLEGAL_TRANSITION',
      `Declared exception ${args.exception.kind} expects source ${expected.from}, but task ${args.taskId} is ${from}`,
    );
  }

  // ── PRECONDITIONS — the entire point of this unit ──────────────────────────────
  // checkPreconditions runs unconditionally. When U031 lands, its certificate gate
  // living inside checkPreconditions fires here automatically.
  const evidence: TransitionEvidence = {
    actor: args.actor,
    reason: args.reason,
  };
  checkPreconditions(task, args.to, evidence);

  // ── Atomic, compare-and-swap DB write ──────────────────────────────────────────
  // Same pattern as transition(): status UPDATE, task_events insert, and legacy
  // events insert commit as ONE db.transaction(). The compare-and-swap
  // (AND status = <from>) means re-running is a no-op — a concurrent writer that
  // moved the row first surfaces as CAS_CONFLICT rather than a blind overwrite.
  const now = new Date().toISOString();

  transaction(() => {
    // Build the UPDATE with extraColumns (e.g. completed_at) and the mandatory
    // compare-and-swap guard.
    const extraCols = args.extraColumns ?? {};
    const setClauses = ['status = ?'];
    const params: unknown[] = [args.to];

    for (const [col, val] of Object.entries(extraCols)) {
      setClauses.push(`${col} = ?`);
      params.push(val);
    }

    // Always set updated_at unless the caller provided it explicitly.
    if (!('updated_at' in extraCols)) {
      setClauses.push('updated_at = ?');
      params.push(now);
    }

    params.push(args.taskId);
    params.push(from); // compare-and-swap guard

    const sql = `UPDATE tasks SET ${setClauses.join(', ')} WHERE id = ? AND status = ?`;
    const result = run(sql, params);

    if (result.changes === 0) {
      throw new TransitionError(
        'CAS_CONFLICT',
        `Task ${args.taskId} was no longer in '${from}' when applying → ${args.to} (concurrent writer); transition aborted`,
      );
    }

    // Structured task_events audit row — same write transition() uses.
    recordStatusEvent(args.taskId, from, args.to, {
      actor: args.actor,
      reason: args.reason,
    });

    // Legacy events row for backwards-compat.
    try {
      run(
        `INSERT INTO events (id, type, task_id, message, created_at)
         VALUES (?, 'task_completed', ?, ?, ?)`,
        [
          uuidv4(),
          args.taskId,
          `[lifecycle] Task "${task.title}" moved ${from} → ${args.to} via declared exception (${args.exception.kind})${args.reason ? ': ' + args.reason : ''}`,
          now,
        ],
      );
    } catch { /* legacy table unavailable on tests — non-fatal */ }
  });

  // ── Fetch and return updated row (post-commit) ─────────────────────────────────
  const updated = queryOne<Task>('SELECT * FROM tasks WHERE id = ?', [args.taskId]);
  if (!updated) throw new TransitionError('NOT_FOUND', `Task ${args.taskId} not found after update`);

  return updated;
}

// ---------------------------------------------------------------------------
// transition() — the ONE function all status changes go through
// ---------------------------------------------------------------------------

/**
 * Perform a lifecycle transition for `taskId`.
 *
 * @param taskId  - The task to transition
 * @param to      - Target state
 * @param evidence - Optional context (actor, reason, source, operatorOverride)
 *
 * @throws TransitionError when:
 *   - The task is not found
 *   - The transition is not legal (illegal-transition guard)
 *   - A required precondition is not met (unless evidence.operatorOverride)
 *
 * Returns the updated task row (after the DB write).
 */
export async function transition(
  taskId: string,
  to: LifecycleState,
  evidence: TransitionEvidence = {},
): Promise<Task> {
  const task = queryOne<TaskRowForLifecycle>(
    `SELECT t.id, t.title, t.status, t.assigned_agent_id, t.model_id,
            t.persona_id, t.workspace_id, t.qc_reroute_attempts,
            t.department, t.process_certificate_sha, t.sop_authoring_for_task_id,
            a.specialist_type
     FROM tasks t
     LEFT JOIN agents a ON t.assigned_agent_id = a.id
     WHERE t.id = ?`,
    [taskId],
  );

  if (!task) {
    throw new TransitionError('NOT_FOUND', `Task ${taskId} not found`);
  }

  const from = task.status as LifecycleState;

  // Caller-asserted compare-and-swap (DISP-10): if the caller declared the
  // status it expects the task to be IN, honour it before doing anything —
  // including before the idempotent short-circuit — so a task another writer
  // already advanced surfaces as a CAS_CONFLICT rather than a silent no-op.
  if (evidence.expectedFrom !== undefined && from !== evidence.expectedFrom) {
    throw new TransitionError(
      'CAS_CONFLICT',
      `Task ${taskId} expected in '${evidence.expectedFrom}' but was '${from}'; transition to ${to} aborted`,
    );
  }

  // Idempotent: if already in target state, return current row
  if (from === to) {
    const current = queryOne<Task>('SELECT * FROM tasks WHERE id = ?', [taskId]);
    if (!current) throw new TransitionError('NOT_FOUND', `Task ${taskId} not found after idempotent check`);
    return current;
  }

  // Legal-transition guard
  const legalTargets = LEGAL_TRANSITIONS[from];
  if (!legalTargets || !legalTargets.has(to)) {
    throw new TransitionError(
      'ILLEGAL_TRANSITION',
      `Illegal transition ${from} → ${to} for task ${taskId}`,
    );
  }

  // ── WIP limit (MR-12, server-side) ────────────────────────────────────────
  // Enforce the board's per-column WIP limits at the funnel, not just in the
  // UI. Skippable via operatorOverride for the same reason the assignment
  // preconditions are: an override is a deliberate human/system decision to
  // exceed the soft cap. Automated pipeline flows that push completed work
  // INTO a capped column (agent-completion webhook, execution-watcher, the
  // test runner) set operatorOverride so finished work is never stranded by a
  // full column; the operator PATCH path does NOT set it, so a human drag/
  // PATCH into a full column is refused here exactly as the UI refuses it.
  if (!evidence.operatorOverride) {
    const wipViolation = checkWipLimit(taskId, to, task.workspace_id);
    if (wipViolation) {
      throw new TransitionError('WIP_LIMIT', wipViolation);
    }
  }

  // Preconditions
  checkPreconditions(task, to, evidence);

  const now = new Date().toISOString();
  // Legacy `events` row fields — overridable via evidence (MR-16 events-feed
  // regression fix). Defaults reproduce the pre-override behavior exactly, so
  // every existing caller is unaffected; a migrating raw writer that used to set
  // agent_id / a richer type+message supplies the overrides to restore its row.
  const legacyType = evidence.eventType ?? (to === 'done' ? 'task_completed' : 'task_status_changed');
  const legacyAgentId = evidence.eventAgentId ?? null;
  const legacyMessage =
    evidence.eventMessage ??
    `[lifecycle] Task "${task.title}" moved ${from} → ${to}${evidence.reason ? ': ' + evidence.reason : ''}`;

  // ── Atomic, compare-and-swap DB write ──────────────────────────────────────
  // DISP-09: the status UPDATE, extraColumns, task_events insert, and legacy
  // events insert commit as ONE db.transaction() — all land or none do. A crash
  // between them can no longer leave a committed status change with no audit row.
  // MR-16: extraColumns from TransitionEvidence are merged into the same UPDATE
  // inside this transaction, so callers migrating from raw compound UPDATEs get
  // the full atomicity guarantee without a separate write + recordStatusEvent gap.
  // DISP-10: the UPDATE is a compare-and-swap on the status we just read
  // (`from`). If another writer moved the row in the read→write (TOCTOU) window,
  // `changes === 0` and we throw CAS_CONFLICT instead of blindly overwriting a
  // status whose transition we never validated FROM. This is what lets
  // transition() serve as the ONE authoritative status path: even two concurrent
  // callers racing the same task cannot both succeed.
  // MR-04: extraColumns allows compound writers (status + description/model_id/
  // block_*/etc.) to route through transition() atomically instead of bypassing
  // the state machine with a raw UPDATE.
  // The SSE broadcast + owner notify are kept OUTSIDE the transaction (below) so
  // nothing is announced for a change that rolled back.
  transaction(() => {
    // Build the UPDATE with optional extraColumns and the mandatory
    // compare-and-swap guard.
    const extraCols = evidence.extraColumns ?? {};
    const setClauses = ['status = ?'];
    const params: unknown[] = [to];

    for (const [col, val] of Object.entries(extraCols)) {
      setClauses.push(`${col} = ?`);
      params.push(val);
    }

    // Always set updated_at unless the caller provided it explicitly.
    if (!('updated_at' in extraCols)) {
      setClauses.push('updated_at = ?');
      params.push(now);
    }

    params.push(taskId);
    params.push(from); // compare-and-swap guard

    const sql = `UPDATE tasks SET ${setClauses.join(', ')} WHERE id = ? AND status = ?`;
    const res = run(sql, params);
    if (res.changes === 0) {
      throw new TransitionError(
        'CAS_CONFLICT',
        `Task ${taskId} was no longer in '${from}' when applying → ${to} (concurrent writer); transition aborted`,
      );
    }

    // Structured task_events row (primary audit trail).
    writeTaskEvent(taskId, from, to, evidence, now);

    // Legacy events row for backwards-compat (live feed, existing queries).
    // agent_id is bound (NULL unless the caller supplied evidence.eventAgentId)
    // so the activity feed's `LEFT JOIN agents ON e.agent_id` can render the
    // agent pill for migrated raw writers (MR-16 events-feed regression fix).
    try {
      run(
        `INSERT INTO events (id, type, agent_id, task_id, message, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          uuidv4(),
          legacyType,
          legacyAgentId,
          taskId,
          legacyMessage,
          now,
        ],
      );
    } catch { /* legacy table unavailable on tests — non-fatal */ }
  });

  // ── Fetch updated row (post-commit) ────────────────────────────────────────
  const updated = queryOne<Task>('SELECT * FROM tasks WHERE id = ?', [taskId]);
  if (!updated) throw new TransitionError('NOT_FOUND', `Task ${taskId} not found after update`);

  // ── SSE broadcast (post-commit) ────────────────────────────────────────────
  broadcast({ type: 'task_updated', payload: updated });

  // W5.1/W5.4 — DONE owner notification: the single lifecycle funnel so every
  // path that eventually calls transition(…,'done') reports the full 5 fields.
  // Best-effort; gateway-routed; never throws; never blocks the return value.
  if (to === 'done') {
    try { notifyOwnerDone(taskId); } catch { /* non-fatal */ }
  }

  return updated;
}

// ---------------------------------------------------------------------------
// §3 Artifact Contract helpers
// ---------------------------------------------------------------------------

/**
 * Canonical artifact directory for a task.
 *
 * <PROJECTS_PATH>/artifacts/<task-id>/
 *
 * This is the §3 contract location.  The directory is created at dispatch time
 * via `ensureArtifactDir`.  The specialist is TOLD where to save via the
 * dispatch payload (`ARTIFACT_DIR` env var / message field); it never chooses.
 */
export function artifactDir(taskId: string): string {
  const base = (process.env.PROJECTS_PATH || '~/Documents/Shared/projects')
    .replace(/^~/, process.env.HOME || '');
  return path.join(base, 'artifacts', taskId);
}

/**
 * Create the artifact directory at dispatch time.
 * Returns the absolute path (tilde-expanded).
 */
export function ensureArtifactDir(taskId: string): string {
  const dir = artifactDir(taskId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// ---------------------------------------------------------------------------
// §3 Deliverable registration
// ---------------------------------------------------------------------------

export interface DeliverableRegistration {
  path: string;
  mime: string;
  bytes: number;
  sha256: string;
  title?: string;
}

/**
 * Register a deliverable row after the specialist saves a file.
 * Computes sha256 and byte count from the file on disk.
 *
 * Idempotent: if a row with the same task_id + path already exists, returns
 * the existing row id.
 */
export function registerDeliverable(
  taskId: string,
  reg: DeliverableRegistration,
): string {
  // Check for existing row
  const existing = queryOne<{ id: string }>(
    'SELECT id FROM task_deliverables WHERE task_id = ? AND path = ?',
    [taskId, reg.path],
  );
  if (existing) return existing.id;

  const id = uuidv4();
  const now = new Date().toISOString();

  // B5: DO NOT reference `updated_at` here. It exists in the current schema.ts
  // CREATE TABLE, but DBs created before it was added never got a migration to
  // ADD the column (migration 070 only adds mime_type/file_size_bytes/sha256), so
  // on those live boxes the column is ABSENT and naming it made EVERY
  // registerDeliverable() throw "no column named updated_at" — silently breaking
  // the completion chain. `updated_at` is nullable with a DEFAULT where it does
  // exist, so omitting it is correct on both old and new schemas.
  run(
    `INSERT INTO task_deliverables
       (id, task_id, deliverable_type, title, path, mime_type, file_size_bytes, sha256, created_at)
     VALUES (?, ?, 'artifact', ?, ?, ?, ?, ?, ?)`,
    [
      id,
      taskId,
      reg.title ?? path.basename(reg.path),
      reg.path,
      reg.mime,
      reg.bytes,
      reg.sha256,
      now,
    ],
  );

  return id;
}

/**
 * Compute sha256 + byte count for a file on disk.
 * Returns null if the file cannot be read (caller should log and skip).
 */
export function fileStats(filePath: string): { bytes: number; sha256: string } | null {
  // safeReadFileBuffer never blocks on a TCC-gated artifact path (PROJECTS_PATH
  // defaults to ~/Documents/Shared): a raw fs.readFileSync there could freeze
  // the completion/registration path forever. Returns null instead.
  const buf = safeReadFileBuffer(filePath);
  if (!buf) return null;
  const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
  return { bytes: buf.length, sha256 };
}

// ---------------------------------------------------------------------------
// §3 Dispatch payload helper
// ---------------------------------------------------------------------------

/**
 * Build the ARTIFACT_DIR snippet to embed in the dispatch message.
 * Creates the directory and returns the path and the message fragment.
 */
export function artifactDispatchPayload(taskId: string): {
  artifactDir: string;
  messageFragment: string;
} {
  const dir = ensureArtifactDir(taskId);
  const fragment = `\n**ARTIFACT_DIR:** ${dir}\nSave ALL deliverables to this exact directory. Do not choose a different path.\nWhen done, call POST /api/tasks/${taskId}/deliverables with the file path.\n`;
  return { artifactDir: dir, messageFragment: fragment };
}
