/**
 * PBB-073 / T-35 — Kanban cards bound to REAL lifecycle events.
 *
 * WHAT THIS IS
 * ------------
 * The board used to place a card from `tasks.status` alone — a mirror column
 * that any raw writer can leave behind the audit trail. This module derives
 * each card's column from the newest `task_events` row that actually exists
 * (the same row `transition()` / `recordStatusEvent()` write atomically with
 * the status UPDATE), and it makes the two silent failure modes loud:
 *
 *   - SOURCE RECORD GONE  → state 'stale', reason 'source_missing'. The card
 *     is still returned (it must never silently vanish into its last column),
 *     carrying the last event time it had.
 *   - EVENT STREAM STALLED → state 'stale', reason 'stream_stalled' once the
 *     newest event is older than the threshold. Terminal lanes ('done') are
 *     exempt: a finished card is supposed to stop emitting.
 *
 * An event whose `to_status` is not a known board status is surfaced as
 * `state: 'unknown'` with `unknown_event_type` set — it is NEVER dropped and
 * never coerced into a column it does not prove.
 *
 * A card with no lifecycle event at all keeps the source row's status
 * placement: there is no transition to contradict the mirror, so the module
 * does not invent one. (ponytail: legacy/never-transitioned rows. Ceiling —
 * it trusts the mirror for event-less cards. Upgrade path: make `transition()`
 * the only insert path and drop this fallback.)
 *
 * SERVER-ONLY. Imports better-sqlite3 through '@/lib/db'.
 */

import { queryAll } from '@/lib/db';
import { taskToColumnId } from '@/lib/board-projection';
import type {
  LifecycleCard,
  LifecycleCardState,
  LifecycleStaleReason,
  TaskStatus,
} from '@/lib/types';

export type { LifecycleCard, LifecycleCardState, LifecycleStaleReason };

// ─── Shapes ─────────────────────────────────────────────────────────────────

/** One `task_events` row (src/lib/db/schema.ts §3). */
export interface LifecycleEventRow {
  id: string;
  task_id: string;
  from_status: string;
  to_status: string;
  actor?: string | null;
  reason?: string | null;
  created_at: string;
}

/** The only `tasks` columns this projection needs. */
export interface LifecycleSourceRow {
  id: string;
  status?: string | null;
}

/** The board's six placement columns (see MissionQueue BOARD_PRESETS). */
export const BOARD_COLUMN_IDS = [
  'backlog',
  'todo',
  'in_progress',
  'review',
  'blocked',
  'done',
] as const;

/** Lanes that legitimately stop emitting events. Not "stalled". */
export const TERMINAL_BOARD_COLUMNS: readonly string[] = ['done'];

/** Default stall threshold: 6 hours with no new event on an in-flight card. */
export const DEFAULT_STALE_AFTER_MS = 6 * 60 * 60 * 1000;

/** Env override for the stall threshold, in hours. Malformed → default. */
export function resolveStaleAfterMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.KANBAN_EVENT_STALE_AFTER_HOURS;
  if (!raw) return DEFAULT_STALE_AFTER_MS;
  const hours = Number.parseFloat(raw);
  if (!Number.isFinite(hours) || hours <= 0) return DEFAULT_STALE_AFTER_MS;
  return hours * 60 * 60 * 1000;
}

// ─── Time parsing ───────────────────────────────────────────────────────────
/**
 * `task_events.created_at` reaches us in TWO shapes: SQLite's
 * `datetime('now')` → `YYYY-MM-DD HH:MM:SS` (UTC, no zone) and the
 * transition() path's `new Date().toISOString()` → `YYYY-MM-DDTHH:mm:ss.sssZ`.
 * `Date.parse` treats the first as LOCAL time, which would shift the stall
 * window by the box's UTC offset — so normalise the space form to UTC first.
 */
export function parseEventTime(value: string | null | undefined): number | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const trimmed = value.trim();
  const hasZone = /(?:[zZ]|[+-]\d{2}:?\d{2})$/.test(trimmed);
  const normalised = trimmed.includes(' ') ? trimmed.replace(' ', 'T') : trimmed;
  const ms = Date.parse(hasZone ? normalised : `${normalised}Z`);
  return Number.isFinite(ms) ? ms : null;
}

// ─── Column resolution ──────────────────────────────────────────────────────
/**
 * Map one lifecycle status (`task_events.to_status`) to a board column.
 * Returns null for a status the board does not know — the caller surfaces
 * that as UNKNOWN instead of dropping the event.
 */
export function columnForLifecycleStatus(status: string | null | undefined): string | null {
  if (typeof status !== 'string' || !status.trim()) return null;
  const mapped = taskToColumnId({ status: status as TaskStatus });
  return (BOARD_COLUMN_IDS as readonly string[]).includes(mapped) ? mapped : null;
}

/** Newest event wins; ties break on id so the projection is deterministic. */
export function newestEvent(events: readonly LifecycleEventRow[]): LifecycleEventRow | null {
  let best: LifecycleEventRow | null = null;
  for (const event of events) {
    if (!best) {
      best = event;
      continue;
    }
    const next = parseEventTime(event.created_at);
    const held = parseEventTime(best.created_at);
    if (next !== null && held !== null && next !== held) {
      if (next > held) best = event;
      continue;
    }
    if (next !== null && held === null) best = event;
    else if (next === null && held !== null) continue;
    else if (event.id > best.id) best = event;
  }
  return best;
}

// ─── Pure projection ────────────────────────────────────────────────────────

export interface ProjectLifecycleInput {
  /** Live `tasks` rows (the source records). */
  tasks: readonly LifecycleSourceRow[];
  /** `task_events` rows for the same cards (plus any orphan events). */
  events: readonly LifecycleEventRow[];
  /**
   * Card ids the board was already showing. An id here with no matching
   * source row is a DELETED source record — surfaced as STALE, never dropped.
   */
  knownCardIds?: readonly string[];
  now?: number | string | Date;
  staleAfterMs?: number;
}

export interface LifecycleProjection {
  /** One card per id seen in tasks, events, or knownCardIds. */
  cards: Map<string, LifecycleCard>;
  /** Ids whose source row is gone (stale_reason 'source_missing'). */
  missingSourceIds: string[];
}

function toMs(now: number | string | Date | undefined): number {
  if (now === undefined) return Date.now();
  if (now instanceof Date) return now.getTime();
  if (typeof now === 'number') return now;
  const parsed = parseEventTime(now);
  return parsed ?? Date.now();
}

/**
 * Derive every card's column + freshness. Pure: no DB, no clock of its own
 * when `now` is supplied, so the four lifecycle behaviours are unit-testable.
 */
export function projectLifecycleCards(input: ProjectLifecycleInput): LifecycleProjection {
  const nowMs = toMs(input.now);
  const staleAfterMs =
    typeof input.staleAfterMs === 'number' && Number.isFinite(input.staleAfterMs)
      ? input.staleAfterMs
      : DEFAULT_STALE_AFTER_MS;

  const eventsByTask = new Map<string, LifecycleEventRow[]>();
  for (const event of input.events) {
    const bucket = eventsByTask.get(event.task_id);
    if (bucket) bucket.push(event);
    else eventsByTask.set(event.task_id, [event]);
  }

  const sourceById = new Map<string, LifecycleSourceRow>();
  for (const task of input.tasks) sourceById.set(task.id, task);

  const ids: string[] = [];
  const seen = new Set<string>();
  const push = (id: string) => {
    if (!id || seen.has(id)) return;
    seen.add(id);
    ids.push(id);
  };
  for (const task of input.tasks) push(task.id);
  for (const event of input.events) push(event.task_id);
  for (const id of input.knownCardIds ?? []) push(id);

  const cards = new Map<string, LifecycleCard>();
  const missingSourceIds: string[] = [];

  for (const id of ids) {
    const source = sourceById.get(id);
    const last = newestEvent(eventsByTask.get(id) ?? []);

    // A transition is only believed when an event proves it. With no event,
    // the source mirror is the only evidence and is used as-is.
    const eventColumn = last ? columnForLifecycleStatus(last.to_status) : null;
    const unknownEventType = last && eventColumn === null ? last.to_status : null;

    let column: string | null;
    if (last) column = eventColumn;
    else column = source ? columnForLifecycleStatus(source.status) : null;

    let state: LifecycleCardState = 'live';
    let staleReason: LifecycleStaleReason | null = null;

    if (!source) {
      state = 'stale';
      staleReason = 'source_missing';
      missingSourceIds.push(id);
    } else if (unknownEventType !== null) {
      state = 'unknown';
    } else if (last) {
      const lastMs = parseEventTime(last.created_at);
      const inTerminalLane = column !== null && TERMINAL_BOARD_COLUMNS.includes(column);
      if (lastMs !== null && !inTerminalLane && nowMs - lastMs > staleAfterMs) {
        state = 'stale';
        staleReason = 'stream_stalled';
      }
    }

    cards.set(id, {
      task_id: id,
      column,
      state,
      stale_reason: staleReason,
      last_event_at: last?.created_at ?? null,
      last_event_id: last?.id ?? null,
      unknown_event_type: unknownEventType,
    });
  }

  return { cards, missingSourceIds };
}

// ─── DB loader ──────────────────────────────────────────────────────────────

export const LIFECYCLE_EVENT_COLUMNS =
  'id, task_id, from_status, to_status, actor, reason, created_at';

/** SQLite caps bound parameters; chunk the IN list well under it. */
const ID_CHUNK = 400;

type QueryAll = <T>(sql: string, params?: unknown[]) => T[];

/** Read the real lifecycle events for a set of cards (one query per chunk). */
export function loadLifecycleEvents(
  taskIds: readonly string[],
  query: QueryAll = queryAll,
): LifecycleEventRow[] {
  const ids = Array.from(new Set(taskIds.filter((id) => typeof id === 'string' && id.length > 0)));
  const out: LifecycleEventRow[] = [];
  for (let i = 0; i < ids.length; i += ID_CHUNK) {
    const chunk = ids.slice(i, i + ID_CHUNK);
    const placeholders = chunk.map(() => '?').join(', ');
    out.push(
      ...query<LifecycleEventRow>(
        `SELECT ${LIFECYCLE_EVENT_COLUMNS}
           FROM task_events
          WHERE task_id IN (${placeholders})
          ORDER BY task_id, created_at, id`,
        chunk,
      ),
    );
  }
  return out;
}

/**
 * One call the board route can make: load the events, project the cards.
 * `knownCardIds` is what the client was already rendering — an id that no
 * longer has a source row comes back STALE instead of disappearing.
 */
export function loadLifecycleProjection(
  tasks: readonly LifecycleSourceRow[],
  options: {
    knownCardIds?: readonly string[];
    now?: number | string | Date;
    staleAfterMs?: number;
  } = {},
): LifecycleProjection {
  const events = loadLifecycleEvents(tasks.map((task) => task.id));
  return projectLifecycleCards({
    tasks,
    events,
    knownCardIds: options.knownCardIds,
    now: options.now,
    staleAfterMs: options.staleAfterMs ?? resolveStaleAfterMs(),
  });
}
