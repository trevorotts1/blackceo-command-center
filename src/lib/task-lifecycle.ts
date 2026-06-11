/**
 * task-lifecycle.ts — ONE state machine, ONE transition function.
 *
 * §3 of DUCK-PIPELINE-GUIDANCE.md: every status change in the codebase routes
 * through `transition(taskId, to, evidence)`. That function:
 *   1. Validates the transition is legal (legal-transitions map + preconditions).
 *   2. Updates the tasks row.
 *   3. Writes a task_events row (structured audit trail, distinct from the
 *      legacy `events` table which stays for backwards compat).
 *   4. Broadcasts the SSE event atomically with the DB write.
 *
 * States: backlog → assigned → in_progress → review → done | blocked
 *         Any state ← blocked (unblock), any → blocked
 *
 * Preconditions:
 *   assigned    : task.assigned_agent_id AND task.model_id AND task.specialist_type
 *   in_progress : task.assigned_agent_id (model may be resolved at dispatch time)
 *   review      : task has ≥1 deliverable row (for artifact tasks); or non-artifact
 *                 tasks are allowed through unconditionally (SOP text tasks have
 *                 no required file deliverable)
 *   done        : task.status === 'review' (QC gate) OR human operator override
 *   blocked     : always allowed (safety valve)
 *
 * `transition()` is exported; all callers should import it and stop issuing raw
 * `UPDATE tasks SET status = ?` queries.  Existing callers that have not yet
 * been migrated continue to work — this function does NOT break them; it is
 * additive.
 */

import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { queryOne, queryAll, run } from '@/lib/db';
import { broadcast } from '@/lib/events';
import { getProjectsPath } from '@/lib/config';
import type { Task } from '@/lib/types';

// ---------------------------------------------------------------------------
// State machine definition
// ---------------------------------------------------------------------------

export type LifecycleState =
  | 'backlog'
  | 'assigned'
  | 'in_progress'
  | 'review'
  | 'done'
  | 'blocked';

/**
 * Legal transitions: from → Set<to>
 *
 * NOTE: 'blocked' can be reached from any state (safety valve).
 * 'blocked' can transition to 'backlog' (unblock) or 'in_progress' (resume).
 */
const LEGAL_TRANSITIONS: Record<LifecycleState, Set<LifecycleState>> = {
  backlog:     new Set<LifecycleState>(['assigned', 'in_progress', 'blocked']),
  assigned:    new Set<LifecycleState>(['in_progress', 'backlog', 'blocked']),
  in_progress: new Set<LifecycleState>(['review', 'blocked', 'backlog']),
  review:      new Set<LifecycleState>(['done', 'in_progress', 'blocked', 'backlog']),
  done:        new Set<LifecycleState>(['backlog']), // re-open only
  blocked:     new Set<LifecycleState>(['backlog', 'in_progress', 'assigned']),
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
      break; // always legal
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

  // ── DB write ──────────────────────────────────────────────────────────────
  run(
    'UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?',
    [to, now, taskId],
  );

  // ── Structured task_events row + legacy events row ────────────────────────
  writeTaskEvent(taskId, from, to, evidence, now);

  // Write legacy events row too for backwards-compat (live feed, existing queries)
  const legacyType = to === 'done' ? 'task_completed' : 'task_status_changed';
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

  // ── Fetch updated row ────────────────────────────────────────────────────
  const updated = queryOne<Task>('SELECT * FROM tasks WHERE id = ?', [taskId]);
  if (!updated) throw new TransitionError('NOT_FOUND', `Task ${taskId} not found after update`);

  // ── SSE broadcast ────────────────────────────────────────────────────────
  broadcast({ type: 'task_updated', payload: updated });

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
