/**
 * DISPATCH-IDEMPOTENCY-WINDOW (2026-08-27) — suppress ACCIDENTAL duplicate
 * manual dispatches without blocking deliberate operator re-dispatch.
 *
 * DEFECT (live 2026-08-27, task f4a2de9a): the manual "Send to Agent" route
 * (src/app/api/tasks/[id]/dispatch/route.ts) has no status precondition except
 * `blocked`, so a second POST 25s after a successful one fired a FULL second
 * chat.send — the agent received the same task twice (task_activities rows at
 * 18:54:12.794Z and 18:54:37.814Z; model_runtime_confirmed events at 19:02:43
 * and 19:03:23). The gateway-side idempotencyKey (DISP-01) keys on the attempt
 * counter and only collapses CONCURRENT sends — two sends seconds apart carry
 * the same key but the gateway does not hold it that long, so it dedups
 * nothing there.
 *
 * OPERATOR SEMANTICS (preserved, this is the contract):
 *   1. A DELIBERATE re-dispatch after the window elapses works exactly as
 *      before — the code comment on the route says operator re-dispatch is
 *      intentional, and that stays true.
 *   2. An EXPLICIT override — request body { "force": true } — always
 *      dispatches, even inside the window. Deliberate re-dispatch is never
 *      blocked; it only has to say so when it lands inside the window.
 *   3. A REASSIGNMENT (task re-pointed at a different agent) is never
 *      suppressed — the window only matches a repeat send to the SAME agent,
 *      so "assign to someone else and push" keeps working with no flag.
 *   4. BLOCKED-task behavior is untouched: the acknowledgeBlock gate runs
 *      BEFORE this check and is unchanged.
 *
 * NEVER SILENT: a suppressed duplicate writes a queryable
 * `duplicate_dispatch_suppressed` events row (live feed) AND a
 * task_activities row (Activity tab), plus a console.warn. The operator can
 * always see that a duplicate was swallowed and why.
 *
 * WINDOW SOURCE OF TRUTH: the most recent SUCCESSFUL dispatch event
 * (events.type = 'task_dispatched') for the task — the same audit row the
 * route writes after a real send. `tasks.last_dispatch_attempt_at` is NOT
 * usable here: it is stamped by failure accounting and only cleared by the
 * AUTO path's recordDispatchSuccess (task-dispatcher.ts) — the manual route
 * never wrote it on success (live task f4a2de9a carried a stale
 * 18:42:59 stamp across both successful 18:54 sends).
 *
 * ENV: DISPATCH_IDEMPOTENCY_WINDOW_SECONDS (default 120; 0 disables the
 * window entirely). The observed live duplicate landed 25s apart; 120s
 * covers double-clicks, double-fires and the PATCH-triggered internal
 * re-dispatch, while staying far below any deliberate re-dispatch cadence.
 */

import { queryOne } from '@/lib/db';

export const DISPATCH_IDEMPOTENCY_WINDOW_SECONDS_DEFAULT = 120;

/** Event type written (by the dispatch route) when a duplicate is suppressed. */
export const DUPLICATE_SUPPRESSED_EVENT_TYPE = 'duplicate_dispatch_suppressed';

/** The events.type row a successful dispatch writes — the window's anchor. */
const DISPATCH_SUCCESS_EVENT_TYPE = 'task_dispatched';

/**
 * Resolve the idempotency window in seconds. Non-numeric or negative env
 * values fall back to the default (never disable by typo); an explicit 0
 * disables the window.
 */
export function getDispatchIdempotencyWindowSeconds(): number {
  const raw = parseInt(process.env.DISPATCH_IDEMPOTENCY_WINDOW_SECONDS ?? '', 10);
  if (Number.isNaN(raw) || raw < 0) {
    return DISPATCH_IDEMPOTENCY_WINDOW_SECONDS_DEFAULT;
  }
  return raw;
}

export interface DuplicateDispatchCheck {
  /** true = this POST is a duplicate inside the window and must be suppressed. */
  suppressed: boolean;
  reason: 'duplicate_within_idempotency_window' | null;
  /** created_at of the last successful dispatch event (raw DB value), or null. */
  last_dispatched_at: string | null;
  /** Whole seconds since that dispatch, or null when there is none. */
  elapsed_seconds: number | null;
  /** The resolved window (also reported when suppressed=false, for the response). */
  window_seconds: number;
  /** agent_id on the last dispatch event — suppression requires a SAME-agent match. */
  last_dispatch_agent_id: string | null;
}

/**
 * Parse an events.created_at value into epoch ms. The events table holds a MIX:
 * ISO strings with 'Z' (every dispatch writer uses new Date().toISOString())
 * and SQLite's 'YYYY-MM-DD HH:MM:SS' (the column's datetime('now') default,
 * which is UTC but parses as LOCAL time in V8 unless normalized). Normalize
 * the bare-SQLite shape to UTC so a mixed table cannot skew the window.
 */
export function parseEventTimestamp(value: string | null | undefined): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(trimmed)) {
    const ms = Date.parse(trimmed.replace(' ', 'T') + 'Z');
    return Number.isNaN(ms) ? null : ms;
  }
  const ms = Date.parse(trimmed);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Decide whether THIS dispatch of `taskId` is an accidental duplicate.
 *
 * A duplicate is: a successful dispatch event exists for this task, it was
 * recorded for the SAME assigned agent, and it is younger than the window.
 * Any other shape — no prior dispatch, a different agent (reassignment), an
 * elapsed window, or window=0 — dispatches normally.
 *
 * Pure read: never writes, never throws into the caller's path (a DB error
 * degrades to "not a duplicate" — the pre-fix behavior — rather than
 * blocking every manual dispatch because the lookup failed).
 */
export function checkDuplicateDispatch(
  taskId: string,
  assignedAgentId: string | null | undefined,
  now: Date = new Date(),
): DuplicateDispatchCheck {
  const windowSeconds = getDispatchIdempotencyWindowSeconds();
  const base: DuplicateDispatchCheck = {
    suppressed: false,
    reason: null,
    last_dispatched_at: null,
    elapsed_seconds: null,
    window_seconds: windowSeconds,
    last_dispatch_agent_id: null,
  };
  if (windowSeconds <= 0) return base;

  let last: { agent_id: string | null; created_at: string } | null | undefined = null;
  try {
    last = queryOne<{ agent_id: string | null; created_at: string }>(
      `SELECT agent_id, created_at FROM events
       WHERE task_id = ? AND type = ?
       ORDER BY created_at DESC
       LIMIT 1`,
      [taskId, DISPATCH_SUCCESS_EVENT_TYPE],
    );
  } catch (err) {
    console.warn(
      `[dispatch-idempotency] lookup failed for task ${taskId} — treating as not-a-duplicate (pre-fix behavior):`,
      (err as Error).message,
    );
    return base;
  }
  if (!last?.created_at) return base;

  const lastMs = parseEventTimestamp(last.created_at);
  if (lastMs === null) {
    console.warn(
      `[dispatch-idempotency] unparseable created_at "${last.created_at}" on last dispatch event for task ${taskId} — treating as not-a-duplicate`,
    );
    return base;
  }

  const elapsedSeconds = Math.max(0, Math.round((now.getTime() - lastMs) / 1000));
  const sameAgent = !!assignedAgentId && last.agent_id === assignedAgentId;
  const suppressed = sameAgent && elapsedSeconds < windowSeconds;

  return {
    suppressed,
    reason: suppressed ? 'duplicate_within_idempotency_window' : null,
    last_dispatched_at: last.created_at,
    elapsed_seconds: elapsedSeconds,
    window_seconds: windowSeconds,
    last_dispatch_agent_id: last.agent_id,
  };
}

/**
 * Operator-facing message for a suppressed duplicate — names the task, the
 * agent, the elapsed time and the window, and documents the explicit override
 * so the operator is never left guessing how to force a genuine re-dispatch.
 */
export function buildDuplicateSuppressedMessage(args: {
  taskTitle: string;
  agentName: string;
  elapsedSeconds: number | null;
  windowSeconds: number;
}): string {
  const ago =
    args.elapsedSeconds === null
      ? 'moments'
      : `${args.elapsedSeconds}s`;
  return (
    `[duplicate_dispatch_suppressed] Task "${args.taskTitle}" was already dispatched to ` +
    `${args.agentName} ${ago} ago (within the ${args.windowSeconds}s dispatch idempotency ` +
    `window). The duplicate send was SUPPRESSED so the agent does not receive the task ` +
    `twice. To re-dispatch deliberately, repeat the request with { "force": true }.`
  );
}