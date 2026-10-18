'use client';

/**
 * AdvisorSeat (CWE-032, Skill 77) - one council seat as a real button.
 *
 * Renders the CWE-031 medallion, the advisor's FULL name (16px floor via
 * the --council-text-name token, wraps to two lines, never clipped to
 * initials as the only identity), the short responsibility, and one honest
 * status line driven only by committed event state (Sections 18.4, 22.3):
 * a queued seat reads "Waiting in queue", never "thinking"; stance labels
 * (Supports / Conditional / Opposes / Abstains, with the token layer's
 * shape markers) appear only when a validated card has been committed,
 * and the seat's selected option is shown only from that validated card
 * (Section 21.3).
 *
 * The whole seat is one keyboard-focusable button whose accessible name
 * carries advisor, responsibility, and current state (Section 23.1).
 * State is never carried by color alone: every state has a text label,
 * and stance badges add the locked shape marker from council-theme.css.
 */

import { forwardRef, type CSSProperties } from 'react';
import { council, councilcx } from './council-theme';
import {
  seatIdentity,
  seatStatusLabel,
  seatAccessibleName,
  STANCE_LABELS,
  type CouncilSeatView,
} from './council-room-types';

export interface AdvisorSeatProps {
  seat: CouncilSeatView;
  /** Resolved URL for the medallion image (small variant by default). */
  medallionSrc: string;
  selected?: boolean;
  onSelect?: (seat: CouncilSeatView) => void;
  /** Room-slot positioning on the locked ellipse (CouncilRoom only). */
  style?: CSSProperties;
  /**
   * 'full' (default): medallion, name, responsibility, status, preferred
   * option. 'room': the compact stage density the locked reference uses
   * on the ellipse (medallion, name, status): at the locked 140px slot
   * width the full stack measures over 180px tall and neighbouring
   * slots overlap, a benchmark hard-gate failure. Responsibility and
   * preferred option remain in the accessible name, the reading view,
   * and the drawer in both variants.
   */
  variant?: 'full' | 'room';
}

/**
 * Only the exact canonical seat's approved room-portrait path can switch
 * visual density. A random third-party celebrity, URL or other seat's
 * portrait cannot masquerade as an approved asset in this renderer.
 * The upstream caller must load and validate the released art manifest.
 */
export function isApprovedCouncilRoomPortrait(src: string, seatId: string): boolean {
  return src === `/council/portraits/${seatId}-room.webp`;
}

const STANCE_BADGE_CLASS: Record<string, string> = {
  support: council.stateSupport,
  conditional: council.stateConditional,
  oppose: council.stateOppose,
  abstain: council.stateAbstain,
};

export const AdvisorSeat = forwardRef<HTMLButtonElement, AdvisorSeatProps>(
  function AdvisorSeat(
    { seat, medallionSrc, selected = false, onSelect, style, variant = 'full' },
    ref,
  ) {
    const identity = seatIdentity(seat.seatId);
    const statusLabel = seatStatusLabel(seat);
    const showStanceBadge = seat.status === 'completed' && seat.card !== null;
    const roomDensity = variant === 'room';
    const hasPortrait = roomDensity && isApprovedCouncilRoomPortrait(medallionSrc, seat.seatId);

    return (
      <button
        ref={ref}
        type="button"
        className={councilcx(council.seat, council.roomSeat, roomDensity && 'council-seat-room')}
        data-testid={`council-seat-${seat.seatId}`}
        data-seat-id={seat.seatId}
        data-status={seat.status}
        data-variant={variant}
        data-has-portrait={hasPortrait ? 'true' : 'false'}
        data-selected={selected ? 'true' : 'false'}
        aria-label={seatAccessibleName(seat)}
        aria-pressed={selected}
        style={style}
        onClick={() => onSelect?.(seat)}
      >
        {/* Decorative-in-context: the button's accessible name and the
            visible full name carry the identity; the image keeps the
            manifest alt text for non-button contexts. */}
        <img
          src={medallionSrc}
          alt={hasPortrait
            ? `Portrait of ${identity.displayName}`
            : identity.medallion.altText}
          width={hasPortrait ? 116 : roomDensity ? 36 : 44}
          height={hasPortrait ? 145 : roomDensity ? 36 : 44}
          className={hasPortrait ? 'council-seat-portrait-img' : undefined}
          loading="lazy"
          decoding="async"
          data-testid={hasPortrait ? `council-portrait-${seat.seatId}` : undefined}
        />
        <span className={council.seatName}>{identity.displayName}</span>
        {!roomDensity ? (
          <span className={council.seatRole}>{identity.responsibility}</span>
        ) : null}
        {showStanceBadge && seat.card ? (
          <span className={STANCE_BADGE_CLASS[seat.card.stance]}>{statusLabel}</span>
        ) : (
          <span className="council-seat-status">{statusLabel}</span>
        )}
        {!roomDensity && seat.card?.preferredOptionLabel ? (
          <span className="council-seat-prefers">
            Prefers: {seat.card.preferredOptionLabel}
          </span>
        ) : null}
      </button>
    );
  },
);

export { STANCE_LABELS };
