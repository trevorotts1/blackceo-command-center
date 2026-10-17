/**
 * Council realtime event contracts (CWE-030, directive Sections 16,
 * 17, 18; binding B07).
 *
 * These types are the delivery contract between the CWE-006 durable
 * journal and every council event consumer (the session events route,
 * the CWE-034 client, and CWE-050's composition root). They exist
 * because the host's shared SSE path (src/lib/events.ts) cannot carry
 * council events safely at the current HEAD:
 *
 *   - Its connection registry keys connections by company only. There
 *     is no owner dimension, so a private session has no way to be
 *     owner-only on that path.
 *   - Its scope rule delivers every event whose scope resolves to
 *     null to EVERY company connection, and operator (null-scope)
 *     connections receive everything. An unrecognized council event
 *     type resolves to null scope there, which is exactly the B07
 *     unscoped fan-out.
 *   - Its fan-out journal (sse_event_log) is deleted after five
 *     minutes by the stream route's cleanup, which is a fan-out
 *     cache lifetime, not the Section 16 retention council history
 *     requires.
 *
 * Council events therefore travel ONLY on the types in this module:
 * every delivered event carries its full scope (installation,
 * tenant, company, session, visibility, and the private owner
 * subject), delivery is decided server-side against that scope, and
 * the durable source is always the CWE-006 council journal, never
 * the host's in-memory registry or its five-minute fan-out table.
 */

import type {
  CouncilEventType,
  SessionState,
  SessionVisibility,
} from '../contracts';

/**
 * The full scope a council event belongs to. `owner_subject` is the
 * recorded private owner for private sessions and null for company
 * sessions. A delivered event ALWAYS carries this object; there is
 * no null-scope council event.
 */
export interface CouncilEventScope {
  tenant_id: string;
  company_id: string;
  installation_id: string;
  session_id: string;
  visibility: SessionVisibility;
  owner_subject: string | null;
}

/**
 * One committed journal event as delivered to an authorized consumer.
 * `type` is the frozen CWE-003 journal vocabulary (session_created,
 * card_accepted, ...); Section 18.1's dotted names are the proposal
 * those journal types implement. `state_version` is the session's
 * aggregate version immediately after this event, computed by folding
 * the journal in sequence order. `occurred_at` is the journal's own
 * committed timestamp, carried verbatim (T070: real timestamps only;
 * no elapsed-time fabrication happens at this layer).
 */
export interface CouncilWireEvent {
  event_id: string;
  session_id: string;
  scope: CouncilEventScope;
  sequence: number;
  state_version: number;
  type: CouncilEventType;
  from_state: string | null;
  to_state: string | null;
  actor_subject: string;
  payload: Record<string, unknown>;
  occurred_at: string;
  origin: 'journal';
}

/**
 * The ONLY thing a non-owner may ever receive about a private
 * session's activity: a non-sensitive signal that the session
 * changed, with no event type, payload, actor, or content. The
 * consumer's next step is an authorized fetch through the normal
 * read path (Section 18.2). Support principals on the events
 * surface receive at most this signal for private sessions.
 */
export interface CouncilInvalidationSignal {
  kind: 'council.session.invalidated';
  session_id: string;
  scope: CouncilEventScope;
  state_version: number;
  last_sequence: number;
  occurred_at: string;
}

/**
 * Honest seat activity (Section 18.4). A seat is 'queued' (waiting)
 * until a committed card proves it completed a round; there is no
 * 'thinking' status at this layer because no committed journal
 * event proves a seat is mid-thought, and QUEUED must never be
 * dressed up as thinking.
 */
export type SeatActivityStatus = 'queued' | 'completed';

export interface CouncilSeatProjection {
  seat_id: string;
  status: SeatActivityStatus;
  last_card: { round: number; card_hash: string; sequence: number } | null;
}

export interface CouncilVerdictProjection {
  verdict_revision: number;
  result_kind: string;
  content_sha256: string;
  sequence: number;
}

/**
 * The room/session projection: a pure fold of one session's journal.
 * It is built ONLY from committed journal events (via the outbox
 * fanout or a direct journal read), never from ad hoc in-memory
 * state, and a rebuild from the journal alone reproduces it exactly.
 */
export interface CouncilSessionProjection {
  session_id: string;
  scope: CouncilEventScope;
  mode: string;
  sample: boolean;
  state: SessionState | string;
  state_version: number;
  brief_revision: number;
  seats: CouncilSeatProjection[];
  activity: {
    /** Count of committed advisor cards; a count, never a fabricated percent. */
    completed_cards: number;
    total_seats: number;
    last_event_sequence: number;
    last_event_type: CouncilEventType | null;
    /** The journal timestamp of the last committed event, verbatim. */
    last_event_at: string | null;
  };
  verdict: CouncilVerdictProjection | null;
  updated_at: string | null;
}

/** A page of committed events after a cursor, in sequence order. */
export interface CouncilEventPage {
  kind: 'events';
  session_id: string;
  events: CouncilWireEvent[];
  /** Highest journal sequence for the session at read time. */
  last_sequence: number;
  has_more: boolean;
}

/** The private-session answer for a consumer without content access. */
export interface CouncilInvalidationPage {
  kind: 'invalidation';
  signal: CouncilInvalidationSignal;
}

export type CouncilEventPageResult = CouncilEventPage | CouncilInvalidationPage;

/** A wholesale state replacement for a client too far behind to page. */
export interface CouncilResyncSnapshot {
  kind: 'snapshot';
  session_id: string;
  projection: CouncilSessionProjection;
  last_sequence: number;
}

export type CouncilCatchUp =
  | { kind: 'page'; page: CouncilEventPage }
  | { kind: 'snapshot'; snapshot: CouncilResyncSnapshot }
  | { kind: 'invalidation'; signal: CouncilInvalidationSignal };

/** One row of the session-list projection (per authorized scope). */
export interface CouncilSessionListEntry {
  session_id: string;
  scope: CouncilEventScope;
  mode: string;
  state: SessionState | string;
  state_version: number;
  brief_revision: number;
  visibility: SessionVisibility;
  sample: boolean;
  last_event_sequence: number;
  last_event_at: string | null;
  updated_at: string | null;
}
