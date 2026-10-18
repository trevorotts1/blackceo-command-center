'use client';

/**
 * CouncilRoom (CWE-032, Skill 77) - the nine-seat room stage.
 *
 * Seats sit on the locked CWE-031 ellipse geometry (COUNCIL_SEAT_SLOTS,
 * keyed by stable seat ID) inside the nested dark stage. Slots NEVER
 * shuffle by arrival order, score, or model: the seats prop arrives in
 * event-arrival order and is always re-ordered by roster slot before
 * rendering (orderSeatsByRoster). The quiet center holds the current
 * decision and round, plus the committed crux when there is one.
 *
 * Below a ~920px container the CWE-031 container rule unpins the seats
 * and council-room.css turns the frame into a designed 3-column grid
 * (2 columns on phone): the table is never scaled down to illegibility
 * (Sections 22.4, 22.5). All nine seats stay reachable by scrolling, and
 * the page never needs two-dimensional scrolling at 320px.
 */

import { council, councilcx } from './council-theme';
import { AdvisorSeat } from './AdvisorSeat';
import { RoundStepper } from './RoundStepper';
import {
  orderSeatsByRoster,
  roomModeBadge,
  seatSlot,
  type CouncilRoomView,
  type CouncilSeatView,
} from './council-room-types';

export interface CouncilRoomProps {
  room: CouncilRoomView;
  /** seatId -> resolved medallion image URL (small variant). */
  medallionSrcBySeat: Readonly<Record<string, string>>;
  selectedSeatId?: string | null;
  onSelectSeat?: (seat: CouncilSeatView) => void;
}

export function CouncilRoom({
  room,
  medallionSrcBySeat,
  selectedSeatId = null,
  onSelectSeat,
}: CouncilRoomProps) {
  const seats = orderSeatsByRoster(room.seats);
  const badge = roomModeBadge(room.mode);
  const completedCount = seats.filter((s) => s.status === 'completed').length;

  return (
    <section
      className={council.stage}
      aria-label="Council room"
      data-testid="council-room"
      style={{ padding: 'clamp(0.75rem, 2.5vw, 1.5rem)' }}
    >
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          gap: '0.75rem 1rem',
          marginBottom: '1rem',
        }}
      >
        <p style={{ margin: 0 }} aria-live="polite">
          <strong>{room.phaseLabel}</strong>{' '}
          <span style={{ color: 'var(--council-stage-muted)' }}>
            {completedCount} of {seats.length} perspectives are in. Nothing here is final
            until the verdict is validated.
          </span>
        </p>
        {badge ? (
          <span className="council-mode-badge" data-testid="council-mode-badge">
            {badge}
          </span>
        ) : null}
      </div>

      <RoundStepper currentRound={room.currentRound} />

      <div className={councilcx(council.room)} style={{ marginTop: '1rem' }}>
        <div className={council.roomFrame}>
          <div className="council-room-center">
            <p className={council.meta} style={{ margin: '0 0 0.5rem' }}>
              THE DECISION
            </p>
            <p className="council-room-center-decision">{room.decisionTitle}</p>
            {room.cruxLabel ? (
              <p className={council.meta} style={{ margin: '0.75rem 0 0' }}>
                Current crux: {room.cruxLabel}
              </p>
            ) : null}
          </div>

          {seats.map((seat) => {
            const slot = seatSlot(seat.seatId);
            return (
              <AdvisorSeat
                key={seat.seatId}
                seat={seat}
                medallionSrc={medallionSrcBySeat[seat.seatId] ?? ''}
                selected={selectedSeatId === seat.seatId}
                onSelect={onSelectSeat}
                variant="room"
                style={{ left: `${slot.xPct}%`, top: `${slot.yPct}%` }}
              />
            );
          })}
        </div>
      </div>
    </section>
  );
}
