/**
 * workforce-health.ts — Read-only workforce health aggregation.
 *
 * MR-08: Provides a single-pane view of the operator workforce health —
 * stuck-task counts, dispatch failures, agent connectivity, and SLA
 * violations. Everything is computed on-read from existing SQL rows;
 * nothing is persisted.
 *
 * Honesty contract: every counter is a real integer. null scores indicate
 * "insufficient data" and must render as such in the UI — never as 0.
 * The module never throws (callers expect a safe JSON response).
 */

import { getDb } from '@/lib/db';
import { resolveSlaThreshold } from '@/lib/board-slas';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface StuckTaskCounters {
  /** Tasks currently status = 'blocked'. */
  blocked: number;
  /** Blocked tasks where block_audience = 'OWNER' (needs human). */
  blockedByOwner: number;
  /** Blocked tasks where block_audience = 'SYSTEM' (needs operator). */
  blockedSystem: number;
  /** Tasks in pending_dispatch for more than 2 hours (stuck in dispatch). */
  dispatchStuck: number;
  /** Tasks in review for more than 24 hours without a QC result. */
  reviewStuck: number;
  /** Tasks in in_progress for more than 12 hours without updates. The 12h
   * threshold mirrors MR-07's stuck-in-progress hard ceiling
   * (DEFAULT_STUCK_IN_PROGRESS_HARD_CEILING_MINUTES = 720): the sweep
   * guarantees no in_progress card outlives 12h, so the dashboard must flag
   * stale cards at the same horizon — a 48h threshold would stay blind to
   * cards the sweep has already given up on for two days. */
  inProgressStale: number;
}

export interface AgentConnectivityRow {
  agentId: string;
  agentName: string;
  agentRole: string;
  avatarEmoji: string;
  status: string;
  currentTaskCount: number;
  completedCount: number;
  lastActiveAt: string | null;
  /** Minutes since last activity; null if never active. */
  idleMinutes: number | null;
  health: 'healthy' | 'idle' | 'stale' | 'offline';
}

export interface DispatchFailurePoint {
  /** ISO hour bucket label, e.g. '2026-07-31T14:00:00Z'. */
  hour: string;
  /** Total dispatches attempted in this hour. */
  dispatched: number;
  /** Dispatch attempts that failed (OpenClaw errors, timeouts, etc.). */
  failed: number;
  /** Dispatch attempts held at the triad gate. */
  held: number;
}

export interface SlaViolationSummary {
  /** Count of blocked tasks past the owner-re-ping threshold. */
  blockedPastOwnerReping: number;
  /** Count of blocked tasks past the operator-escalate threshold. */
  blockedPastEscalate: number;
  /** Count of review-lane tasks past the unscored threshold. */
  reviewPastUnscored: number;
  /** Count of backlog/inbox tasks past the stale-nudge threshold. */
  backlogPastNudge: number;
}

export interface WorkforceHealthPayload {
  /** ISO timestamp of when this snapshot was computed. */
  computedAt: string;
  /** Stuck/stale task counters across all lanes. */
  stuckTasks: StuckTaskCounters;
  /** Per-agent connectivity and activity. */
  agents: AgentConnectivityRow[];
  /** Hourly dispatch success/failure/held sparkline (last 48 hours). */
  dispatchSparkline: DispatchFailurePoint[];
  /** SLA violations against configured thresholds. */
  slaViolations: SlaViolationSummary;
}

// ---------------------------------------------------------------------------
// Default SLA fallbacks (matches board-hygiene.ts / stale-task-sweep.ts)
// ---------------------------------------------------------------------------

const DEFAULT_BLOCKED_OWNER_REPING_HOURS = 4;
const DEFAULT_BLOCKED_ESCALATE_HOURS = 24;
const DEFAULT_REVIEW_UNSCORED_HOURS = 48;
const DEFAULT_STALE_BACKLOG_NUDGE_DAYS = 7;

// ---------------------------------------------------------------------------
// Query helpers
// ---------------------------------------------------------------------------

interface CountRow {
  c: number;
}

function queryCount(sql: string, ...params: unknown[]): number {
  try {
    const db = getDb();
    const row = db.prepare(sql).get(...params) as CountRow | undefined;
    return row?.c ?? 0;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Stuck-task counters
// ---------------------------------------------------------------------------

function computeStuckTaskCounters(): StuckTaskCounters {
  const blocked = queryCount(
    `SELECT COUNT(*) AS c FROM tasks WHERE status = 'blocked' AND archived_at IS NULL`,
  );

  const blockedByOwner = queryCount(
    `SELECT COUNT(*) AS c FROM tasks WHERE status = 'blocked' AND block_audience = 'OWNER' AND archived_at IS NULL`,
  );

  const blockedSystem = queryCount(
    `SELECT COUNT(*) AS c FROM tasks WHERE status = 'blocked' AND block_audience = 'SYSTEM' AND archived_at IS NULL`,
  );

  // Tasks stuck in pending_dispatch for more than 2 hours.
  // NOTE: the subtraction MUST be parenthesised before the *24 hours
  // conversion — `julianday('now') - julianday(updated_at) * 24` binds the
  // multiplication to julianday(updated_at) first (SQL precedence), yielding
  // a large negative number that is never > 2, i.e. every counter would
  // silently report 0 forever.
  const dispatchStuck = queryCount(
    `SELECT COUNT(*) AS c FROM tasks
      WHERE status = 'pending_dispatch'
        AND archived_at IS NULL
        AND (julianday('now') - julianday(updated_at)) * 24 > 2`,
  );

  // Tasks in review for more than 24 hours without a QC result
  const reviewStuck = queryCount(
    `SELECT COUNT(*) AS c FROM tasks t
      WHERE t.status = 'review'
        AND t.archived_at IS NULL
        AND (julianday('now') - julianday(t.updated_at)) * 24 > 24
        AND NOT EXISTS (
          SELECT 1 FROM task_qc_results q
          WHERE q.task_id = t.id AND q.scoring_path = 'llm'
        )`,
  );

  // Tasks in in_progress for more than 12 hours without updates — aligned
  // with MR-07's hard ceiling (720 min / 12h) in stuck-in-progress-sweep.ts,
  // so the dashboard surfaces stale cards at the same horizon the sweep
  // guarantees no card outlives (a 48h threshold would report 0 for up to
  // two days after the ceiling had already condemned the card).
  const inProgressStale = queryCount(
    `SELECT COUNT(*) AS c FROM tasks
      WHERE status = 'in_progress'
        AND archived_at IS NULL
        AND (julianday('now') - julianday(updated_at)) * 24 > 12`,
  );

  return {
    blocked,
    blockedByOwner,
    blockedSystem,
    dispatchStuck,
    reviewStuck,
    inProgressStale,
  };
}

// ---------------------------------------------------------------------------
// Agent connectivity grid
// ---------------------------------------------------------------------------

interface AgentTaskRow {
  id: string;
  name: string;
  role: string;
  avatar_emoji: string;
  status: string;
  current_tasks: number;
  completed: number;
  last_active_at: string | null;
}

function computeAgentConnectivity(): AgentConnectivityRow[] {
  const rows = getDb()
    .prepare(
      `SELECT
         a.id,
         a.name,
         a.role,
         COALESCE(a.avatar_emoji, '🤖') AS avatar_emoji,
         a.status,
         (SELECT COUNT(*) FROM tasks t
           WHERE t.assigned_agent_id = a.id
             AND t.status IN ('in_progress', 'assigned', 'pending_dispatch', 'review', 'testing')
             AND t.archived_at IS NULL) AS current_tasks,
         (SELECT COUNT(*) FROM tasks t
           WHERE t.assigned_agent_id = a.id
             AND t.status = 'done') AS completed,
         COALESCE(
           (SELECT MAX(e.created_at) FROM events e
             WHERE e.agent_id = a.id),
           a.updated_at
         ) AS last_active_at
       FROM agents a
       ORDER BY a.name ASC`,
    )
    .all() as AgentTaskRow[];

  return rows.map((r) => {
    const idleMinutes =
      r.last_active_at
        ? Math.round(
            (Date.now() - new Date(r.last_active_at.replace(' ', 'T') + 'Z').getTime()) / 60000,
          )
        : null;

    let health: AgentConnectivityRow['health'] = 'healthy';
    if (r.status === 'offline') {
      health = 'offline';
    } else if (idleMinutes !== null && idleMinutes > 60 * 24) {
      health = 'stale';
    } else if (idleMinutes !== null && idleMinutes > 60) {
      health = 'idle';
    }

    return {
      agentId: r.id,
      agentName: r.name,
      agentRole: r.role,
      avatarEmoji: r.avatar_emoji,
      status: r.status,
      currentTaskCount: r.current_tasks,
      completedCount: r.completed,
      lastActiveAt: r.last_active_at,
      idleMinutes,
      health,
    };
  });
}

// ---------------------------------------------------------------------------
// Dispatch failure sparkline (last 48 hours, hourly buckets)
// ---------------------------------------------------------------------------

interface DispatchHourRow {
  hourBucket: string;
  total: number;
  failed: number;
  held: number;
}

function computeDispatchSparkline(): DispatchFailurePoint[] {
  // Dispatch failures are recorded by task-dispatcher.ts as
  // 'task_dispatch_deferred' events (transient failure + backoff); there is
  // no 'dispatch_failed' event type in this codebase, so counting that would
  // always yield 0. 'triad_gate_hold' rows carry task_id only (agent_id is
  // NULL), which is fine here — the sparkline never groups by agent.
  const rows = getDb()
    .prepare(
      `SELECT
         strftime('%Y-%m-%dT%H:00:00Z', e.created_at) AS hourBucket,
         COUNT(*) AS total,
         SUM(CASE WHEN e.type = 'task_dispatch_deferred' THEN 1 ELSE 0 END) AS failed,
         SUM(CASE WHEN e.type = 'triad_gate_hold' THEN 1 ELSE 0 END) AS held
       FROM events e
       WHERE e.type IN ('task_dispatched', 'task_dispatch_deferred', 'triad_gate_hold')
         AND e.created_at >= datetime('now', '-48 hours')
       GROUP BY strftime('%Y-%m-%dT%H:00:00Z', e.created_at)
       ORDER BY hourBucket ASC`,
    )
    .all() as DispatchHourRow[];

  return rows.map((r) => ({
    hour: r.hourBucket,
    dispatched: Math.max(0, r.total - r.failed - r.held),
    failed: r.failed,
    held: r.held,
  }));
}

// ---------------------------------------------------------------------------
// SLA violations (computed against the live board-slas config)
// ---------------------------------------------------------------------------

interface SlaTaskRow {
  id: string;
  department: string | null;
  status: string;
  updated_at: string;
  block_audience: string | null;
}

function computeSlaViolations(): SlaViolationSummary {
  const tasks = getDb()
    .prepare(
      `SELECT id, department, status, updated_at, block_audience
         FROM tasks
        WHERE archived_at IS NULL
          AND status IN ('blocked', 'review', 'backlog', 'inbox', 'planning')`,
    )
    .all() as SlaTaskRow[];

  let blockedPastOwnerReping = 0;
  let blockedPastEscalate = 0;
  let reviewPastUnscored = 0;
  let backlogPastNudge = 0;

  const now = Date.now();
  const MS_PER_HOUR = 60 * 60 * 1000;

  for (const t of tasks) {
    const updatedMs = new Date((t.updated_at || '').replace(' ', 'T') + 'Z').getTime();
    if (Number.isNaN(updatedMs)) continue;
    const ageHours = (now - updatedMs) / MS_PER_HOUR;

    if (t.status === 'blocked') {
      const ownerRepingHours = resolveSlaThreshold(
        t.department,
        'blockedOwnerRepingHours',
        DEFAULT_BLOCKED_OWNER_REPING_HOURS,
      );
      const escalateHours = resolveSlaThreshold(
        t.department,
        'blockedOperatorEscalateHours',
        DEFAULT_BLOCKED_ESCALATE_HOURS,
      );
      if (ageHours > ownerRepingHours) blockedPastOwnerReping++;
      if (ageHours > escalateHours) blockedPastEscalate++;
    }

    if (t.status === 'review') {
      const unscoredHours = resolveSlaThreshold(
        t.department,
        'reviewUnscoredHours',
        DEFAULT_REVIEW_UNSCORED_HOURS,
      );
      if (ageHours > unscoredHours) reviewPastUnscored++;
    }

    if (t.status === 'backlog' || t.status === 'inbox' || t.status === 'planning') {
      const nudgeDays = resolveSlaThreshold(
        t.department,
        'staleBacklogNudgeDays',
        DEFAULT_STALE_BACKLOG_NUDGE_DAYS,
      );
      if (ageHours > nudgeDays * 24) backlogPastNudge++;
    }
  }

  return {
    blockedPastOwnerReping,
    blockedPastEscalate,
    reviewPastUnscored,
    backlogPastNudge,
  };
}

// ---------------------------------------------------------------------------
// Top-level aggregation
// ---------------------------------------------------------------------------

export function getWorkforceHealth(): WorkforceHealthPayload {
  const stuckTasks = computeStuckTaskCounters();
  const agents = computeAgentConnectivity();
  const dispatchSparkline = computeDispatchSparkline();
  const slaViolations = computeSlaViolations();

  return {
    computedAt: new Date().toISOString(),
    stuckTasks,
    agents,
    dispatchSparkline,
    slaViolations,
  };
}
