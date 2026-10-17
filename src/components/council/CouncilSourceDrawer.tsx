'use client';

/**
 * CouncilSourceDrawer (CWE-034, Skill 77) - the per-seat source drawer.
 *
 * Every visible claim traces to saved state (Section 21): opening a
 * seat's support shows the sources recorded for that seat, resolved
 * from the frozen brief's evidence manifest through the seat's
 * committed cards, each with its locator, source kind, content hash,
 * and the pack's recorded qualification, under the seat's Section 7
 * profile label.
 *
 * Quotation honesty (Section 8): a quotation renders as a quotation
 * ONLY when a verified quotation record exists for the seat. In this
 * build, no seat has one (all packs stand at bibliographic_only with
 * zero verified quotations), so the drawer says exactly that, in
 * plain words, instead of dressing paraphrase up as quotation.
 * Candidate quotations are counted, never displayed as quotes.
 *
 * Accessibility follows the room drawer's contract (Section 23.3):
 * role="dialog", aria-modal, focus moves in on open, Tab stays
 * inside, Escape closes, focus is restored on close.
 */

import { useEffect, useRef } from 'react';
import { council, councilcx } from './council-theme';
import {
  qualificationLabel,
  type SeatSources,
} from './council-session-types';

export interface CouncilSourceDrawerProps {
  sources: SeatSources | null;
  onClose: () => void;
}

const FOCUSABLE_SELECTOR =
  'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

export function CouncilSourceDrawer({ sources, onClose }: CouncilSourceDrawerProps) {
  const drawerRef = useRef<HTMLDivElement | null>(null);
  const restoreRef = useRef<Element | null>(null);

  useEffect(() => {
    if (!sources) return;
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
  }, [sources, onClose]);

  if (!sources) return null;

  const titleId = `council-source-drawer-title-${sources.seatId}`;

  return (
    <>
      <div className="council-drawer-backdrop" onClick={onClose} aria-hidden="true" />
      <div
        ref={drawerRef}
        className="council-drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-testid={`council-source-drawer-${sources.seatId}`}
      >
        <div className="council-drawer-head">
          <div>
            <h2 id={titleId} className={council.heading}>
              Recorded sources: {sources.displayName}
            </h2>
          </div>
          <button
            type="button"
            className={councilcx(council.btn, council.btnSecondary)}
            data-drawer-close
            onClick={onClose}
            aria-label={`Close sources for ${sources.displayName}`}
          >
            Close
          </button>
        </div>

        <p className={council.meta}>{sources.profileLabel}</p>

        <p data-testid="council-source-qualification">
          <strong>Source qualification:</strong>{' '}
          {qualificationLabel(sources.qualification)}
        </p>

        <h3 className={council.heading}>Sources recorded for this seat</h3>
        {sources.sources.length === 0 ? (
          <p data-testid="council-source-none">
            No sources are recorded for this seat in the frozen brief's
            evidence manifest. Nothing is cited on this seat's behalf.
          </p>
        ) : (
          <ul>
            {sources.sources.map((source) => (
              <li key={source.evidenceId} data-testid={`council-source-${source.evidenceId}`}>
                <strong>{source.sourceKind}</strong>: {source.locator}{' '}
                <span className={council.meta}>
                  (evidence {source.evidenceId}, content hash {source.sha256})
                </span>
              </li>
            ))}
          </ul>
        )}

        <h3 className={council.heading}>Quotations</h3>
        {sources.verifiedQuotes.length === 0 ? (
          <p data-testid="council-source-no-quotes">
            No verified quotations are recorded for this seat. A quotation is
            shown here only when a verified quotation record exists, checked
            against its source text and locator. Paraphrase and summary are
            never presented as this author's words.
            {sources.unverifiedQuoteCount > 0
              ? ` ${sources.unverifiedQuoteCount} unverified candidate quotation(s) are on record and are not displayed as quotations.`
              : ''}
          </p>
        ) : (
          <ul>
            {sources.verifiedQuotes.map((quote, i) => (
              <li key={i}>
                <blockquote>{quote.text}</blockquote>
                <span className={council.meta}>
                  Verified quotation, locator: {quote.locator} (evidence{' '}
                  {quote.evidenceId})
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}
