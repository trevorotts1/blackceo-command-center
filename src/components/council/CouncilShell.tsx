'use client';

/**
 * CouncilShell (CWE-032, Skill 77) - the council room shell.
 *
 * Owns the scoped .council-theme wrapper (importing the CWE-031 token
 * stylesheet and the CWE-032 room layout exactly once), the shell header
 * with the persistent mode badge, the Room / Reading view toggle, the
 * selected-seat state, and the advisor card drawer. It renders no session
 * data of its own: everything shown comes from the typed CouncilRoomView
 * input, so live, replay, and sample data all flow through the same
 * honest rendering path (T101: only real persisted state drives the
 * indicators; replay and sample badges stay visible).
 *
 * Phase changes are announced politely by the views' aria-live regions;
 * individual seat status changes are never announced (Section 23.4).
 * Reduced motion is honored two ways: the token layer collapses
 * transitions under prefers-reduced-motion, and the shell mirrors the
 * preference onto data-reduced-motion so the behavior is inspectable.
 * The Reading view carries no motion or spatial navigation at all.
 */

import { useCallback, useEffect, useState } from 'react';
import './council-theme.css';
import './council-room.css';
import { council, councilcx } from './council-theme';
import { CouncilRoom } from './CouncilRoom';
import { CouncilReadingView } from './CouncilReadingView';
import { AdvisorCardDrawer } from './AdvisorCardDrawer';
import {
  roomModeBadge,
  seatIdentity,
  type CouncilRoomView,
  type CouncilSeatView,
} from './council-room-types';

export type CouncilViewMode = 'room' | 'reading';

export interface CouncilShellProps {
  room: CouncilRoomView;
  /** seatId -> resolved medallion image URL (small variant). */
  medallionSrcBySeat: Readonly<Record<string, string>>;
  /** seatId -> resolved medallion image URL (master variant, drawer). */
  medallionLargeSrcBySeat?: Readonly<Record<string, string>>;
  initialView?: CouncilViewMode;
}

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState<boolean>(() =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
      : false,
  );
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onChange = (event: MediaQueryListEvent) => setReduced(event.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);
  return reduced;
}

export function CouncilShell({
  room,
  medallionSrcBySeat,
  medallionLargeSrcBySeat,
  initialView = 'room',
}: CouncilShellProps) {
  const [view, setView] = useState<CouncilViewMode>(initialView);
  const [selectedSeat, setSelectedSeat] = useState<CouncilSeatView | null>(null);
  const reducedMotion = usePrefersReducedMotion();
  const badge = roomModeBadge(room.mode);

  const handleSelectSeat = useCallback((seat: CouncilSeatView) => {
    setSelectedSeat(seat);
  }, []);
  const handleCloseDrawer = useCallback(() => setSelectedSeat(null), []);

  return (
    <div
      className={council.theme}
      data-testid="council-shell"
      data-reduced-motion={reducedMotion ? 'true' : 'false'}
    >
      <div className="council-shell-head">
        <h1 className={council.heading}>Council of Wise Elders</h1>
        {badge ? (
          <span className="council-mode-badge" data-testid="council-shell-mode-badge">
            {badge}
          </span>
        ) : null}
        <div className="council-view-toggle" role="group" aria-label="Choose how to view the council">
          <button
            type="button"
            className={councilcx(council.btn, council.btnQuiet)}
            data-testid="council-view-room"
            aria-pressed={view === 'room'}
            onClick={() => setView('room')}
          >
            Room view
          </button>
          <button
            type="button"
            className={councilcx(council.btn, council.btnQuiet)}
            data-testid="council-view-reading"
            aria-pressed={view === 'reading'}
            onClick={() => setView('reading')}
          >
            Reading view
          </button>
        </div>
      </div>

      {view === 'room' ? (
        <CouncilRoom
          room={room}
          medallionSrcBySeat={medallionSrcBySeat}
          selectedSeatId={selectedSeat?.seatId ?? null}
          onSelectSeat={handleSelectSeat}
        />
      ) : (
        <CouncilReadingView
          room={room}
          medallionSrcBySeat={medallionSrcBySeat}
          selectedSeatId={selectedSeat?.seatId ?? null}
          onSelectSeat={handleSelectSeat}
        />
      )}

      <AdvisorCardDrawer
        seat={selectedSeat}
        medallionSrc={
          selectedSeat
            ? (medallionLargeSrcBySeat?.[selectedSeat.seatId] ??
              medallionSrcBySeat[selectedSeat.seatId] ??
              '')
            : ''
        }
        onClose={handleCloseDrawer}
      />

      <p className={council.meta} style={{ marginTop: '1rem' }}>
        Each member is an AI perspective inspired by the published work of the named author.
        Not the individual and not an endorsement.
        {selectedSeat ? ` Selected seat: ${seatIdentity(selectedSeat.seatId).displayName}.` : ''}
      </p>
    </div>
  );
}
