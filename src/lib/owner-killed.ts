/**
 * FIX-17 (Error 12 / Rule R12) — OWNER-KILLED tasks must never be re-dispatched.
 *
 * THE INCIDENT (from PRESENTATION-DEPARTMENT-ERRORS-DETECTED.md, Error 12):
 *   Aug 5 the orchestrator re-dispatched `fb2a8e72` — a task Kofi killed Jul 21
 *   05:21 EDT (sermon already delivered). The dispatch claimed "LIVE: This is the
 *   live request Kofi is waiting on" while its own body quoted the kill notice
 *   "do NOT start any new presentation work until the owner sends the new
 *   request." The stale-return sweeper ignored the kill note → 4 identical
 *   handback stalls (not 4 different problems).
 *
 * RULE: A task explicitly marked OWNER KILLED must not be re-dispatched.
 *
 * TWO KILL SIGNALS (either one makes the task terminal-for-dispatch):
 *   1. STRUCTURED — the `tasks.killed_at` column (migration 123). The
 *      authoritative owner-kill timestamp; a NULL value means "not killed".
 *   2. TEXT MARKER — the literal `OWNER KILLED` marker in the task's
 *      description/notes (the incident's "do NOT start any new presentation
 *      work" body carried the kill intent; the canonical marker is the string
 *      `OWNER KILLED`). This is the pre-migration / hand-marked path and stays
 *      guarded independently so the two signals cannot drift.
 *
 * PERMANENT, NOT WINDOWED. `killTimeWithinWindow()` is deliberately NOT
 * implemented: Error 12 is the proof that a window would revive a task the owner
 * killed (Jul 21 kill, Aug 5 revival). Once killed, always killed — an un-kill is
 * an explicit owner action (clear `killed_at` / remove the marker), never an
 * elapsed-clock default. This is fail-closed in the direction that matters.
 *
 * FAIL-SOFT ON COLUMN PRESENCE. The guard reads `killed_at` defensively: on a
 * pre-migration-123 DB the column is absent (`undefined`), the structured path is
 * simply unavailable, and the TEXT-MARKER path still applies. A missing column
 * can never throw a re-dispatch path into an error state.
 */

import { queryOne, run } from '@/lib/db';
import { v4 as uuidv4 } from 'uuid';

/** The canonical owner-kill text marker (case-insensitive match). */
export const OWNER_KILLED_MARKER = 'OWNER KILLED';

/** The durable event type written when a re-dispatch of a killed task is blocked. */
export const OWNER_KILLED_BLOCK_EVENT = 'dispatch_blocked_owner_killed';

export interface OwnerKillResult {
  killed: boolean;
  /** Which signal fired: 'killed_at' (structured column) | 'note_marker' (text) | null. */
  source: 'killed_at' | 'note_marker' | null;
  /** The kill timestamp when known (the column value, or a timestamp parsed from the marker line). */
  killedAt: string | null;
}

/**
 * Is this task owner-killed? Accepts a partial task-like row (whatever fields the
 * caller already loaded) — only `killed_at` and `description`/`notes` are read.
 * `description` is the canonical "notes" column on the tasks table; some callers
 * also carry a `notes` alias — both are consulted so the guard works everywhere.
 */
export function isOwnerKilled(input: {
  killed_at?: string | null;
  description?: string | null;
  notes?: string | null;
}): OwnerKillResult {
  // 1. Structured column (authoritative — migration 123).
  if (input.killed_at && String(input.killed_at).trim() !== '') {
    return { killed: true, source: 'killed_at', killedAt: String(input.killed_at) };
  }

  // 2. Text marker in description/notes.
  const notesText = [input.description, input.notes].filter((s): s is string => !!s).join('\n');
  const markerIdx = notesText.toUpperCase().indexOf(OWNER_KILLED_MARKER);
  if (markerIdx !== -1) {
    // Best-effort timestamp extraction from the marker line, purely for the
    // audit message — the guard itself needs only the marker's presence.
    return { killed: true, source: 'note_marker', killedAt: extractMarkerTimestamp(notesText, markerIdx) };
  }

  return { killed: false, source: null, killedAt: null };
}

/**
 * Defensive read of the `killed_at` column. On a pre-migration-123 DB the column
 * does not exist and a raw `SELECT killed_at` throws "no such column" — a sweep
 * per-task try/catch would swallow that as a task "failure" log. This returns
 * null instead of throwing, so callers can feed `killed_at: null` into the guard
 * and rely on the text-marker path (which is always available). Fail-soft by
 * design — the guard's job (not dispatching) never depends on this read.
 */
export function loadKilledAtDefensive(taskId: string): string | null {
  try {
    const row = queryOne<{ killed_at?: string | null }>(
      `SELECT killed_at FROM tasks WHERE id = ?`,
      [taskId],
    );
    return row?.killed_at ?? null;
  } catch {
    return null; // pre-114 DB or read error — treated as "not killed" by column
  }
}

/**
 * Write a durable `dispatch_blocked_owner_killed` event row. DEDUPED: at most one
 * such event is ever written per task (NOT EXISTS guard), so the 10-minute stale
 * sweep cannot spam the events table — and the single row is the stable evidence
 * the FIX-17 QC gate reads. Fail-soft: a pre-migration DB (no events table) must
 * never throw into the dispatch path.
 */
export function writeOwnerKilledBlockEvent(
  taskId: string,
  taskTitle: string,
  kill: OwnerKillResult,
  context: string,
): void {
  try {
    const existing = queryOne<{ n: number }>(
      `SELECT COUNT(*) AS n FROM events WHERE task_id = ? AND type = ?`,
      [taskId, OWNER_KILLED_BLOCK_EVENT],
    );
    if ((existing?.n ?? 0) > 0) return; // already recorded — one row is the evidence

    const sourceLabel =
      kill.source === 'killed_at'
        ? `killed_at=${kill.killedAt ?? '(timestamp)'}`
        : `note marker "${OWNER_KILLED_MARKER}"${kill.killedAt ? ` (${kill.killedAt})` : ''}`;

    const message =
      `[dispatch_blocked_owner_killed] Task "${taskTitle}" (${taskId}) was KILLED by the owner ` +
      `(${sourceLabel}) — re-dispatch BLOCKED (${context}); task stays dead per Rule R12.`;

    run(
      `INSERT INTO events (id, type, task_id, message, created_at) VALUES (?, ?, ?, ?, ?)`,
      [uuidv4(), OWNER_KILLED_BLOCK_EVENT, taskId, message, new Date().toISOString()],
    );
  } catch (err) {
    // Non-fatal: the guard's job (not dispatching) is unaffected by a failed audit write.
    console.warn(
      `[owner-killed] failed to write ${OWNER_KILLED_BLOCK_EVENT} for task ${taskId} (non-fatal):`,
      (err as Error).message,
    );
  }
}

/**
 * Best-effort: find a timestamp token on (or just after) the marker line.
 * Handles both `OWNER KILLED <ISO>` and the incident's human form
 * (`OWNER KILLED Jul 21 05:21 EDT`). Returns null when nothing parseable is
 * found — the guard never depends on this.
 */
function extractMarkerTimestamp(notes: string, markerIdx: number): string | null {
  const lineStart = notes.lastIndexOf('\n', markerIdx) + 1;
  const lineEnd = notes.indexOf('\n', markerIdx);
  const line = notes.slice(lineStart, lineEnd === -1 ? notes.length : lineEnd);
  const afterMarker = line.slice(markerIdx + OWNER_KILLED_MARKER.length).trim();

  // ISO 8601 (e.g. 2026-07-21T05:21:00Z or 2026-07-21 05:21 EDT).
  const iso = afterMarker.match(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?(?:\s*(?:Z|[+-]\d{2}:?\d{2}|[A-Z]{3}))?/);
  if (iso) return iso[0];

  // Human form: "Jul 21 05:21 EDT" — parse-agnostic, returned verbatim for the audit line.
  const human = afterMarker.match(/[A-Z][a-z]{2}\s+\d{1,2}(?:\s+\d{2}:\d{2})?(?:\s+\d{4})?/);
  if (human) return human[0];

  return null;
}

/**
 * Convenience: full guard for a task already loaded as a row. Combines the kill
 * check + the deduped event write. Returns true when the dispatch was blocked so
 * callers can short-circuit with a single expression.
 */
export function blockDispatchIfOwnerKilled(
  task: { id: string; title: string; killed_at?: string | null; description?: string | null; notes?: string | null },
  context: string,
): boolean {
  const kill = isOwnerKilled(task);
  if (!kill.killed) return false;
  writeOwnerKilledBlockEvent(task.id, task.title, kill, context);
  return true;
}
