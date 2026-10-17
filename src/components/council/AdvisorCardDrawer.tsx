'use client';

/**
 * AdvisorCardDrawer (CWE-032, Skill 77) - the seat details panel.
 *
 * An accessible modal drawer (Section 23.3): role="dialog" with
 * aria-modal, labelled by the advisor's full name; focus moves into the
 * drawer on open, Tab stays inside, Escape closes, and focus is restored
 * to the control that opened it on close. On phone it is full-width
 * (council-room.css), so a seat selection opens a full-width reading
 * panel (Section 22.5).
 *
 * Content is honest about committed state: with a validated card it shows
 * the card's own fields (stance, preferred option, decisive arguments,
 * strongest objection, conditions, critical unknowns, what would change
 * the seat's mind, evidence strength). Without one it says exactly where
 * the seat stands (waiting in queue / in progress / did not complete)
 * and invents nothing. The Section 7.1 attribution label is always shown:
 * this is an AI perspective, not the individual.
 */

import { useEffect, useRef } from 'react';
import { council, councilcx } from './council-theme';
import {
  seatIdentity,
  seatStatusLabel,
  STANCE_LABELS,
  type CouncilSeatView,
} from './council-room-types';

export interface AdvisorCardDrawerProps {
  seat: CouncilSeatView | null;
  /** Resolved URL for the medallion image (master variant). */
  medallionSrc?: string;
  onClose: () => void;
}

const FOCUSABLE_SELECTOR =
  'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

export function AdvisorCardDrawer({ seat, medallionSrc = '', onClose }: AdvisorCardDrawerProps) {
  const drawerRef = useRef<HTMLDivElement | null>(null);
  const restoreRef = useRef<Element | null>(null);
  const activeSeatId = seat?.seatId ?? null;

  useEffect(() => {
    if (!activeSeatId) return;
    restoreRef.current = document.activeElement;
    const drawer = drawerRef.current;
    const closeButton = drawer?.querySelector<HTMLButtonElement>('[data-drawer-close]');
    closeButton?.focus();

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== 'Tab' || !drawerRef.current) return;
      const focusables = Array.from(
        drawerRef.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
      ).filter((el) => !el.hasAttribute('disabled'));
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      const restore = restoreRef.current;
      if (restore instanceof HTMLElement) restore.focus();
    };
  }, [activeSeatId, onClose]);

  if (!seat) return null;

  const identity = seatIdentity(seat.seatId);
  const card = seat.card;
  const titleId = `council-drawer-title-${seat.seatId}`;

  return (
    <>
      <div className="council-drawer-backdrop" onClick={onClose} aria-hidden="true" />
      <div
        ref={drawerRef}
        className="council-drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-testid={`council-drawer-${seat.seatId}`}
      >
        <div className="council-drawer-head">
          <img src={medallionSrc} alt={identity.medallion.altText} width={72} height={72} />
          <div>
            <h2 id={titleId} className={council.heading}>
              {identity.displayName}
            </h2>
            <p className={council.lede} style={{ marginTop: '0.25rem' }}>
              {identity.responsibility}
            </p>
          </div>
          <button
            type="button"
            className={councilcx(council.btn, council.btnSecondary)}
            data-drawer-close
            onClick={onClose}
            aria-label={`Close ${identity.displayName} details`}
          >
            Close
          </button>
        </div>

        <p className={council.meta}>{identity.profileLabel}</p>
        <p>
          <strong>Current state:</strong> {seatStatusLabel(seat)}
        </p>

        {seat.status === 'completed' && card ? (
          <dl>
            <dt>Position</dt>
            <dd>
              {STANCE_LABELS[card.stance]}
              {card.preferredOptionLabel
                ? `, prefers: ${card.preferredOptionLabel}`
                : ', no preferred option recorded'}
            </dd>

            <dt>Decisive arguments</dt>
            <dd>
              <ul>
                {card.decisiveArguments.map((arg, i) => (
                  <li key={i}>{arg}</li>
                ))}
              </ul>
            </dd>

            <dt>Strongest objection</dt>
            <dd>{card.strongestObjection}</dd>

            {card.conditions.length > 0 ? (
              <>
                <dt>Conditions</dt>
                <dd>
                  <ul>
                    {card.conditions.map((c, i) => (
                      <li key={i}>{c}</li>
                    ))}
                  </ul>
                </dd>
              </>
            ) : null}

            {card.criticalUnknowns.length > 0 ? (
              <>
                <dt>Critical unknowns</dt>
                <dd>
                  <ul>
                    {card.criticalUnknowns.map((u, i) => (
                      <li key={i}>{u}</li>
                    ))}
                  </ul>
                </dd>
              </>
            ) : null}

            <dt>What would change this perspective</dt>
            <dd>{card.changeMyMind}</dd>

            <dt>Evidence strength</dt>
            <dd>{card.evidenceStrength}</dd>

            {card.minorityPosition ? (
              <>
                <dt>Minority position</dt>
                <dd>{card.minorityPosition}</dd>
              </>
            ) : null}
          </dl>
        ) : (
          <p>
            {seat.status === 'queued'
              ? 'No perspective has been committed yet. This seat is waiting in the queue; nothing has started.'
              : seat.status === 'started'
                ? 'This seat has started, but no validated perspective has been committed yet. Nothing shown here is final.'
                : 'This seat did not complete a validated perspective for this round.'}
          </p>
        )}
      </div>
    </>
  );
}
