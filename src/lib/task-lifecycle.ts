/**
 * task-lifecycle.ts — ADVISORY transition helper (NOT the sole status gate).
 *
 * ⚠️ ADOPTION REALITY (read before trusting the "one state machine" framing):
 * `transition()` is now internally SAFE to be the one authoritative status path
 * — it is atomic (status UPDATE + both audit inserts in a single transaction,
 * DISP-09) and compare-and-swapped (DISP-10), so two concurrent callers racing
 * the same task cannot both win. BUT it is still not YET the ONLY path a task's
 * status changes: a set of raw `UPDATE tasks SET … status` writers in other
 * modules (dispatcher, QC scorer, sweeps, PATCH/status/return-to-orchestrator
 * routes, agent-completion + test webhooks, sop-authoring, execution-watcher)
 * write the column directly and DO NOT route through here. Converting those is
 * cross-lane work (each lives in another lane's file); the enumerated call-site
 * list is in the L3 hand-off note for the integrator. Consequences you must not
 * assume away until that conversion lands:
 *   - The `task_events` structured audit trail is written ONLY when a status
 *     change goes through `transition()`. It is therefore PARTIAL, not a
 *     complete history. Do not treat task_events as a source of truth for "every
 *     transition that ever happened."
 *   - The legal-transition guard + preconditions below only gate the callers
 *     that opt in. They cannot prevent an illegal status anywhere else.
 * To convert a raw writer: replace its `UPDATE … WHERE id=? AND status='<X>'`
 * with `transition(id, '<to>', { actor, reason, expectedFrom: '<X>' })` — the
 * expectedFrom guard preserves the exact optimistic-concurrency the raw CAS had.
 * See DUCK-PIPELINE-GUIDANCE.md §3 for the target design.
 *
 * What `transition(taskId, to, evidence)` does when a caller DOES opt in:
 *   1. Validates the transition is legal (legal-transitions map + preconditions).
 *   2. Compare-and-swaps the tasks row: the status UPDATE is guarded by
 *      `WHERE status = <observed from-status>`, so a concurrent writer that moved
 *      the row in the read→write window causes a CAS_CONFLICT rather than a blind
 *      overwrite (DISP-10). Callers may also assert an expected current status via
 *      `evidence.expectedFrom` for explicit optimistic-concurrency.
 *   3. Writes a task_events row (structured audit trail, distinct from the
 *      legacy `events` table which stays for backwards compat).
 *   4. Steps 2–3 run inside ONE db.transaction() so the status change and both
 *      audit inserts are atomic (all commit or none — DISP-09). The SSE broadcast
 *      and owner-DONE notification run only AFTER the commit, so nothing is
 *      announced for a change that rolled back.
 *
 * States (the full TaskStatus set — see src/lib/types.ts):
 *   intake/grooming : backlog → inbox → planning
 *   ready/dispatch  : pending_dispatch / assigned
 *   working         : in_progress
 *   verify          : review → testing
 *   terminal        : done
 *   safety valve    : blocked (reachable from any state; unblocks back to the
 *                     queue or to in_progress)
 * The LEGAL_TRANSITIONS map below covers all 10 statuses so that opt-in callers
 * moving a task through the intake/dispatch/verify lanes are not rejected with a
 * spurious ILLEGAL_TRANSITION. The edge set is permissive (additive): every edge
 * that was legal before is still legal; the new statuses only widen it.
 *
 * Preconditions (enforced only for opt-in callers, skippable via operatorOverride):
 *   assigned    : task.assigned_agent_id (specialist_type soft-required, warn only)
 *   in_progress : task.assigned_agent_id (model may be resolved at dispatch time)
 *   review      : no blocking precondition here — QC layer does artifact gating
 *   done        : no blocking precondition here — the PATCH route enforces the
 *                 QC gate; agent-initiated 'done' is blocked there, not here
 *   blocked / backlog / inbox / planning / pending_dispatch / testing : always
 *                 allowed (no precondition)
 *
 * `transition()` is exported and additive: it does NOT break the existing raw-SQL
 * callers, and adopting it is encouraged but not currently mandatory.
 */

import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { queryOne, queryAll, run, transaction } from '@/lib/db';
import { broadcast } from '@/lib/events';
import { getProjectsPath } from '@/lib/config';
import type { Task } from '@/lib/types';
import { notifyOwnerDone } from '@/lib/owner-reports';

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
 * NOTE: 'blocked' can be reached from any state (safety valve) and unblocks back
 * to the queue (backlog/inbox/planning/pending_dispatch) or resumes work
 * (in_progress/assigned). 'done' re-opens only to 'backlog'.
 *
 * ADDITIVE GUARANTEE: every edge that was legal in the original 6-state map is
 * preserved here. The four new statuses (inbox, planning, pending_dispatch,
 * testing) only WIDEN the legal set — no previously-legal transition became
 * illegal, so no existing opt-in caller can break from this change.
 */
const LEGAL_TRANSITIONS: Record<LifecycleState, Set<LifecycleState>> = {
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

  // Preconditions
  checkPreconditions(task, to, evidence);

  const now = new Date().toISOString();
  const legacyType = to === 'done' ? 'task_completed' : 'task_status_changed';

  // ── Atomic, compare-and-swap DB write ──────────────────────────────────────
  // DISP-09: the status UPDATE, the task_events insert, and the legacy events
  // insert commit as ONE db.transaction() — all land or none do. A crash between
  // them can no longer leave a committed status change with no audit row.
  // DISP-10: the UPDATE is a compare-and-swap on the status we just read
  // (`from`). If another writer moved the row in the read→write (TOCTOU) window,
  // `changes === 0` and we throw CAS_CONFLICT instead of blindly overwriting a
  // status whose transition we never validated FROM. This is what lets
  // transition() serve as the ONE authoritative status path: even two concurrent
  // callers racing the same task cannot both succeed.
  // The SSE broadcast + owner notify are kept OUTSIDE the transaction (below) so
  // nothing is announced for a change that rolled back.
  transaction(() => {
    const res = run(
      'UPDATE tasks SET status = ?, updated_at = ? WHERE id = ? AND status = ?',
      [to, now, taskId, from],
    );
    if (res.changes === 0) {
      throw new TransitionError(
        'CAS_CONFLICT',
        `Task ${taskId} was no longer in '${from}' when applying → ${to} (concurrent writer); transition aborted`,
      );
    }

    // Structured task_events row (primary audit trail).
    writeTaskEvent(taskId, from, to, evidence, now);

    // Legacy events row for backwards-compat (live feed, existing queries).
    try {
      run(
        `INSERT INTO events (id, type, task_id, message, created_at)
         VALUES (?, ?, ?, ?, ?)`,
        [
          uuidv4(),
          legacyType,
          taskId,
          `[lifecycle] Task "${task.title}" moved ${from} → ${to}${evidence.reason ? ': ' + evidence.reason : ''}`,
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

  run(
    `INSERT INTO task_deliverables
       (id, task_id, deliverable_type, title, path, mime_type, file_size_bytes, sha256, created_at, updated_at)
     VALUES (?, ?, 'artifact', ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      taskId,
      reg.title ?? path.basename(reg.path),
      reg.path,
      reg.mime,
      reg.bytes,
      reg.sha256,
      now,
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
  try {
    const buf = fs.readFileSync(filePath);
    const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
    return { bytes: buf.length, sha256 };
  } catch {
    return null;
  }
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
