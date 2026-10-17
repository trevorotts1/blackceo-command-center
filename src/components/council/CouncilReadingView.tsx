'use client';

/**
 * CouncilReadingView (CWE-032, Skill 77) - the accessible Reading view.
 *
 * Exposes ALL the information the spatial room carries, without animation
 * or spatial navigation (Sections 22.5, 23.2): the decision, the phase,
 * and every seat in roster order as a readable row with the advisor's full
 * name, responsibility, honest status, and, once a validated card is
 * committed, its stance, preferred option, decisive argument, and
 * strongest objection in plain text. Each row is a keyboard-focusable
 * button whose accessible name carries advisor, responsibility, and
 * current state (Section 23.1); activating it opens the same advisor card
 * drawer as the room. All nine seats are reachable by ordinary scrolling;
 * no pinch-zoom is ever required, and the layout holds at 320px.
 */

import { council, councilcx } from './council-theme';
import {
  orderSeatsByRoster,
  roomModeBadge,
  seatAccessibleName,
  seatIdentity,
  seatStatusLabel,
  STANCE_LABELS,
  type CouncilRoomView,
  type CouncilSeatView,
} from './council-room-types';

export interface CouncilReadingViewProps {
  room: CouncilRoomView;
  /** seatId -> resolved medallion image URL (small variant). */
  medallionSrcBySeat: Readonly<Record<string, string>>;
  selectedSeatId?: string | null;
  onSelectSeat?: (seat: CouncilSeatView) => void;
}

const STANCE_BADGE_CLASS: Record<string, string> = {
  support: council.stateSupport,
  conditional: council.stateConditional,
  oppose: council.stateOppose,
  abstain: council.stateAbstain,
};

export function CouncilReadingView({
  room,
  medallionSrcBySeat,
  selectedSeatId = null,
  onSelectSeat,
}: CouncilReadingViewProps) {
  const seats = orderSeatsByRoster(room.seats);
  const badge = roomModeBadge(room.mode);
  const completedCount = seats.filter((s) => s.status === 'completed').length;

  return (
    <section aria-label="Council reading view" data-testid="council-reading-view">
      <p className={council.eyebrow}>{room.phaseLabel}</p>
      <h2 className={council.heading} style={{ margin: '0.5rem 0' }}>
        {room.decisionTitle}
      </h2>
      <p aria-live="polite">
        {completedCount} of {seats.length} perspectives are in.
        {room.cruxLabel ? ` Current crux: ${room.cruxLabel}.` : ''} Nothing here is final
        until the verdict is validated.
        {badge ? ` This session is shown as: ${badge}.` : ''}
      </p>

      <div className={council.readingList} style={{ marginTop: '1rem' }}>
        {seats.map((seat) => {
          const identity = seatIdentity(seat.seatId);
          const statusLabel = seatStatusLabel(seat);
          const card = seat.card;
          const showStanceBadge = seat.status === 'completed' && card !== null;
          return (
            <button
              key={seat.seatId}
              type="button"
              className={councilcx(council.readingRow)}
              data-testid={`council-reading-row-${seat.seatId}`}
              data-seat-id={seat.seatId}
              data-status={seat.status}
              data-selected={selectedSeatId === seat.seatId ? 'true' : 'false'}
              aria-label={seatAccessibleName(seat)}
              aria-pressed={selectedSeatId === seat.seatId}
              onClick={() => onSelectSeat?.(seat)}
            >
              <img
                src={medallionSrcBySeat[seat.seatId] ?? ''}
                alt={identity.medallion.altText}
                width={48}
                height={48}
              />
              <span className="council-reading-row-main">
                <span className={council.seatName}>{identity.displayName}</span>
                <span className={council.seatRole} style={{ display: 'block' }}>
                  {identity.responsibility}
                </span>
                {showStanceBadge && card ? (
                  <span className={STANCE_BADGE_CLASS[card.stance]} style={{ display: 'flex' }}>
                    {STANCE_LABELS[card.stance]}
                  </span>
                ) : (
                  <span className="council-seat-status">{statusLabel}</span>
                )}
                {showStanceBadge && card ? (
                  <span className="council-reading-summary">
                    {card.decisiveArguments[0] ?? ''}
                    {card.strongestObjection
                      ? ` Strongest objection: ${card.strongestObjection}`
                      : ''}
                  </span>
                ) : (
                  <span className="council-reading-summary">
                    {seat.status === 'queued'
                      ? 'Waiting in the queue; no perspective committed yet.'
                      : seat.status === 'started'
                        ? 'Started; no validated perspective committed yet.'
                        : 'Did not complete a validated perspective.'}
                  </span>
                )}
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}
