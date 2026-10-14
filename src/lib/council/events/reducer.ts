/**
 * The council client reducer contract (CWE-030, directive Sections
 * 18.2, 18.3; binding B07). CWE-034's React layer consumes this
 * module; the reducer itself is transport-agnostic and is tested
 * here at the contract level.
 *
 * The rules, from Section 18:
 *   - The client persists its last applied sequence and reconnects
 *     with that cursor.
 *   - Duplicate events are ignored: dedup is by event ID AND by
 *     sequence, because the journal delivery and a live push can
 *     both deliver the same committed event (T057).
 *   - A stale event cannot revert a newer state: anything at or
 *     below the applied sequence is dropped, never folded.
 *   - A gap (an event whose sequence skips ahead) is NOT applied
 *     out of order; the reducer reports 'gap' and the client must
 *     resync (page catch-up or snapshot) instead of guessing.
 *   - Final cards are never reordered by network arrival in a way
 *     that changes seat identity: the fold is sequence-driven and
 *     seat state is keyed by seat ID from the frozen session spec.
 *
 * The reducer holds NO authority: it renders only the committed
 * events it is handed. Scope enforcement happens server-side before
 * any event reaches it (see delivery.ts); a private session's events
 * reach a non-owner's reducer never, not even redacted.
 */

import { applyJournalEvent, type JournalEventLike } from './projection';
import type {
  CouncilResyncSnapshot,
  CouncilSessionProjection,
  CouncilWireEvent,
} from './types';

export type ReduceOutcome = 'applied' | 'duplicate' | 'stale' | 'gap';

export class CouncilClientReducer {
  private readonly sessionId: string;
  private projection: CouncilSessionProjection | null = null;
  private lastAppliedSequence = 0;
  private readonly appliedEventIds = new Set<string>();
  private gapPending = false;

  constructor(sessionId: string) {
    this.sessionId = sessionId;
  }

  get currentProjection(): CouncilSessionProjection | null {
    return this.projection;
  }

  /** The cursor a reconnect must present (Section 18.3). */
  get cursor(): number {
    return this.lastAppliedSequence;
  }

  /** True after a gap: the client must resync before trusting state. */
  get needsResync(): boolean {
    return this.gapPending;
  }

  /**
   * Apply one wire event. Returns what happened so the client can
   * distinguish a healthy stream from a duplicate-heavy or gapped
   * one. A 'gap' result applies nothing.
   */
  applyEvent(event: CouncilWireEvent): ReduceOutcome {
    if (event.session_id !== this.sessionId) return 'stale';
    if (this.appliedEventIds.has(event.event_id)) return 'duplicate';
    if (event.sequence <= this.lastAppliedSequence) return 'stale';
    if (event.sequence > this.lastAppliedSequence + 1) {
      this.gapPending = true;
      return 'gap';
    }
    this.projection = applyJournalEvent(
      this.projection,
      event.scope,
      toJournalShape(event),
    );
    this.appliedEventIds.add(event.event_id);
    this.lastAppliedSequence = event.sequence;
    return 'applied';
  }

  /** Apply an ordered page; stops at the first gap. */
  applyPage(events: readonly CouncilWireEvent[]): ReduceOutcome[] {
    const outcomes: ReduceOutcome[] = [];
    for (const event of events) {
      const outcome = this.applyEvent(event);
      outcomes.push(outcome);
      if (outcome === 'gap') break;
    }
    return outcomes;
  }

  /**
   * Replace state wholesale from a server snapshot (the resync path
   * for a client too far behind, or whose cursor no longer matches
   * the journal). The snapshot is committed server state, so this
   * is the one operation allowed to move the cursor backwards or
   * forwards arbitrarily; event IDs are re-seeded by the caller
   * through subsequent pages, whose sequences now gate correctly.
   */
  applySnapshot(snapshot: CouncilResyncSnapshot): void {
    if (snapshot.session_id !== this.sessionId) return;
    this.projection = snapshot.projection;
    this.lastAppliedSequence = snapshot.last_sequence;
    this.gapPending = false;
  }
}

function toJournalShape(event: CouncilWireEvent): JournalEventLike {
  return {
    event_id: event.event_id,
    type: event.type,
    sequence: event.sequence,
    from_state: event.from_state,
    to_state: event.to_state,
    actor_subject: event.actor_subject,
    payload: event.payload,
    created_at: event.occurred_at,
  };
}
