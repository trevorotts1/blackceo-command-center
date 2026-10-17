/**
 * Council projections as a pure fold of the durable journal
 * (CWE-030, directive Sections 16.4, 18.1, 18.3).
 *
 * The session projection, the room state inside it, and the session
 * list are built ONLY from committed CWE-006 journal events. There
 * is no in-memory side state: folding the same journal always
 * produces the same projection, a rebuild after a restart reproduces
 * the live projection byte for byte, and out-of-order or duplicate
 * journal rows fold to the same result as in-order rows because the
 * fold is driven by sequence, not arrival order (callers pass rows
 * sorted by sequence; this module also sorts defensively and drops
 * exact duplicate sequences keeping the first, which is the
 * committed one under the journal's primary key).
 *
 * Honest activity (Section 18.4, T070): a seat reads 'queued'
 * (waiting) until a committed card_accepted event proves it
 * completed a round. No journal event proves a seat is "thinking",
 * so the projection never claims one is. Progress is a count of
 * committed cards and the journal's own timestamps, never a
 * percentage invented from elapsed time.
 */

import type {
  CouncilEventScope,
  CouncilSessionListEntry,
  CouncilSessionProjection,
  CouncilWireEvent,
} from './types';

/**
 * The structural shape of a committed journal row this fold reads.
 * The CWE-006 store's journal event type satisfies it (it carries
 * additional hash-chain fields the fold does not need), and the
 * client reducer's wire events map onto it, so one fold serves both
 * the server projection and the client contract.
 */
export interface JournalEventLike {
  event_id: string;
  type: string;
  sequence: number;
  from_state: string | null;
  to_state: string | null;
  actor_subject: string;
  payload: Record<string, unknown>;
  created_at: string;
}

const STATE_CARRYING_TYPES: ReadonlySet<string> = new Set([
  'session_created',
  'session_state_changed',
  'session_paused',
  'session_cancelled',
  'session_blocked',
  'session_failed',
]);

interface StateRecordShape {
  state?: unknown;
  state_version?: unknown;
  brief_revision?: unknown;
  updated_at?: unknown;
}

interface SpecShape {
  mode?: unknown;
  seat_ids?: unknown;
}

function stateRecordOf(event: JournalEventLike): StateRecordShape | null {
  const record = (event.payload as { state_record?: unknown }).state_record;
  if (typeof record !== 'object' || record === null) return null;
  return record as StateRecordShape;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Apply one committed journal event to a projection. Returns a new
 * projection object; the input is not mutated. A projection exists
 * only after session_created; events for a session whose creation
 * event has not been folded are held by returning null, never by
 * inventing a session shell.
 */
export function applyJournalEvent(
  projection: CouncilSessionProjection | null,
  scope: CouncilEventScope,
  event: JournalEventLike,
): CouncilSessionProjection | null {
  if (event.type === 'session_created') {
    const spec = (event.payload as { spec?: SpecShape }).spec ?? {};
    const record = stateRecordOf(event) ?? {};
    const seatIds = Array.isArray(spec.seat_ids)
      ? spec.seat_ids.filter((id): id is string => typeof id === 'string')
      : [];
    return {
      session_id: scope.session_id,
      scope,
      mode: asString(spec.mode) ?? 'full',
      sample: (event.payload as { sample?: unknown }).sample === true,
      state: asString(record.state) ?? event.to_state ?? 'DRAFT',
      state_version: asNumber(record.state_version) ?? 0,
      brief_revision: asNumber(record.brief_revision) ?? 1,
      seats: seatIds.map((seat_id) => ({
        seat_id,
        status: 'queued' as const,
        last_card: null,
      })),
      activity: {
        completed_cards: 0,
        total_seats: seatIds.length,
        last_event_sequence: event.sequence,
        last_event_type: event.type,
        last_event_at: event.created_at,
      },
      verdict: null,
      updated_at: asString(record.updated_at) ?? event.created_at,
    };
  }

  if (projection === null) return null;

  const next: CouncilSessionProjection = {
    ...projection,
    seats: projection.seats,
    activity: {
      ...projection.activity,
      last_event_sequence: event.sequence,
      // Journal rows carry only the frozen CWE-003 vocabulary (the
      // store validates on write); see toWireEvents.
      last_event_type: event.type as CouncilSessionProjection['activity']['last_event_type'],
      last_event_at: event.created_at,
    },
    updated_at: projection.updated_at,
  };

  if (STATE_CARRYING_TYPES.has(event.type)) {
    const record = stateRecordOf(event);
    if (record) {
      next.state = asString(record.state) ?? next.state;
      next.state_version = asNumber(record.state_version) ?? next.state_version;
      next.brief_revision = asNumber(record.brief_revision) ?? next.brief_revision;
      next.updated_at = asString(record.updated_at) ?? event.created_at;
    } else if (event.to_state) {
      next.state = event.to_state;
      next.updated_at = event.created_at;
    }
  }

  if (event.type === 'brief_revised') {
    const revision = asNumber(
      (event.payload as { brief_revision?: unknown }).brief_revision,
    );
    if (revision !== null) next.brief_revision = revision;
  }

  if (event.type === 'card_accepted') {
    const seatId = asString((event.payload as { seat_id?: unknown }).seat_id);
    const round = asNumber((event.payload as { round?: unknown }).round) ?? 0;
    const cardHash =
      asString((event.payload as { card_hash?: unknown }).card_hash) ?? '';
    next.activity = {
      ...next.activity,
      completed_cards: next.activity.completed_cards + 1,
    };
    if (seatId !== null) {
      next.seats = projection.seats.map((seat) =>
        seat.seat_id === seatId
          ? {
              seat_id: seat.seat_id,
              status: 'completed' as const,
              last_card: { round, card_hash: cardHash, sequence: event.sequence },
            }
          : seat,
      );
    }
  }

  if (event.type === 'verdict_validated') {
    next.verdict = {
      verdict_revision:
        asNumber((event.payload as { verdict_revision?: unknown }).verdict_revision) ?? 0,
      result_kind:
        asString((event.payload as { result_kind?: unknown }).result_kind) ?? 'scored',
      content_sha256:
        asString((event.payload as { content_sha256?: unknown }).content_sha256) ?? '',
      sequence: event.sequence,
    };
  }

  return next;
}

/** Sort by sequence and drop duplicate sequences (first wins). */
export function orderJournalEvents(
  events: readonly JournalEventLike[],
): JournalEventLike[] {
  const bySequence = new Map<number, JournalEventLike>();
  for (const event of events) {
    if (!bySequence.has(event.sequence)) bySequence.set(event.sequence, event);
  }
  return [...bySequence.values()].sort((a, b) => a.sequence - b.sequence);
}

/** Fold a session's whole journal into its projection. */
export function projectSession(
  scope: CouncilEventScope,
  events: readonly JournalEventLike[],
): CouncilSessionProjection | null {
  let projection: CouncilSessionProjection | null = null;
  for (const event of orderJournalEvents(events)) {
    projection = applyJournalEvent(projection, scope, event);
  }
  return projection;
}

/**
 * Convert journal rows to wire events, stamping each with the
 * aggregate state_version in effect immediately after it. The stamp
 * is computed by folding in sequence order, so a replayed page and
 * the live projection always agree about versions.
 */
export function toWireEvents(
  scope: CouncilEventScope,
  events: readonly JournalEventLike[],
): CouncilWireEvent[] {
  let projection: CouncilSessionProjection | null = null;
  const wire: CouncilWireEvent[] = [];
  for (const event of orderJournalEvents(events)) {
    projection = applyJournalEvent(projection, scope, event);
    wire.push({
      event_id: event.event_id,
      session_id: scope.session_id,
      scope,
      sequence: event.sequence,
      state_version: projection?.state_version ?? 0,
      // The journal only ever stores the frozen CWE-003 vocabulary
      // (the store validates event types on write), so the widened
      // string narrows back to it here.
      type: event.type as CouncilWireEvent['type'],
      from_state: event.from_state,
      to_state: event.to_state,
      actor_subject: event.actor_subject,
      payload: event.payload,
      occurred_at: event.created_at,
      origin: 'journal',
    });
  }
  return wire;
}

/** The session-list summary of a folded projection. */
export function summarizeProjection(
  projection: CouncilSessionProjection,
): CouncilSessionListEntry {
  return {
    session_id: projection.session_id,
    scope: projection.scope,
    mode: projection.mode,
    state: projection.state,
    state_version: projection.state_version,
    brief_revision: projection.brief_revision,
    visibility: projection.scope.visibility,
    sample: projection.sample,
    last_event_sequence: projection.activity.last_event_sequence,
    last_event_at: projection.activity.last_event_at,
    updated_at: projection.updated_at,
  };
}
