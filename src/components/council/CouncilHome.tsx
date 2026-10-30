'use client';

/**
 * CouncilHome (CWE-033, Skill 77; CTR-104 visual-first entry)
 *
 * The council home renders the nine-seat chamber FIRST. The Council nav
 * entry points here, so one click lands on the visual room with the
 * question box inside it: no intake form stands between the click and
 * the chamber. The guided intake is the conversation that starts AFTER
 * the question (one question at a time on /council/new), never a gate
 * before entry.
 *
 * Opening the chamber starts nothing: no session is created, no model
 * is called, and the only requests are the existing authorized session
 * list and capability probe. Existing sessions and the session history
 * stay on this page below the chamber, and the foundation readiness
 * summary stays stated honestly. Loading, empty, and error remain three
 * different renders; an error never poses as an empty list.
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import {
  getCapabilities,
  isCouncilClientError,
  listSessions,
  type CouncilCapabilitiesData,
  type CouncilSessionListItem,
} from '@/lib/council/journey-client';
import { CHAMBER_QUESTION_MAX } from './council-journey-types';
import { council } from './council-theme';
import { CouncilShell } from './CouncilShell';
import { COUNCIL_MEDALLION_SMALL_SRC } from './medallions';
import { COUNCIL_SEAT_ROSTER, type CouncilRoomView } from './council-room-types';

const STATE_LABELS: Record<string, string> = {
  DRAFT: 'Draft brief',
  READY: 'Ready to start',
  QUEUED: 'Queued',
  PREPARING: 'Preparing',
  ROUND_1: 'Round 1: Openings',
  CRUX_REVIEW: 'Crux review',
  ROUND_2: 'Round 2: Challenge',
  DRAFT_RESOLUTION: 'Draft resolution',
  ROUND_3: 'Round 3: Judgment',
  CONSULTING: 'Consulting',
  VERIFYING: 'Verifying',
  COMPLETED: 'Completed',
  PAUSE_REQUESTED: 'Pause requested',
  PAUSED: 'Paused',
  CANCEL_REQUESTED: 'Cancel requested',
  CANCELLED: 'Cancelled',
  FAILED: 'Failed',
  BLOCKED: 'Blocked',
};

export function sessionStateLabel(state: string): string {
  return STATE_LABELS[state] ?? state;
}

/**
 * The honest pre-sitting room: the nine roster seats in their locked
 * slots, all queued, with no question on the table yet. Static roster
 * data only, so rendering it performs no I/O and starts nothing.
 */
export const IDLE_CHAMBER_ROOM: CouncilRoomView = {
  decisionTitle: 'No question on the table yet',
  phaseLabel: 'The chamber is open',
  currentRound: null,
  cruxLabel: null,
  mode: 'idle',
  seats: COUNCIL_SEAT_ROSTER.map((seat) => ({
    seatId: seat.seatId,
    status: 'queued' as const,
    card: null,
  })),
};

export function CouncilHome() {
  const [sessions, setSessions] = useState<CouncilSessionListItem[] | null>(null);
  const [capabilities, setCapabilities] = useState<CouncilCapabilitiesData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [list, caps] = await Promise.all([listSessions(), getCapabilities()]);
        if (cancelled) return;
        setSessions(list.sessions);
        setCapabilities(caps);
      } catch (caught) {
        if (cancelled) return;
        setError(
          isCouncilClientError(caught)
            ? `${caught.code}: ${caught.message}`
            : 'The council home could not be loaded.',
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="council-journey-stack" data-testid="council-home">
      <section className="council-chamber-panel" data-testid="council-chamber">
        <h2 className={council.heading} style={{ marginTop: 0 }}>
          Ask the council
        </h2>
        <p className={council.meta} id="council-chamber-hint">
          Type the decision you are facing. The chamber is already open below; the intake
          questions come after, one at a time, and nothing is spent or started until you
          choose a model route and freeze the brief.
        </p>
        {/* A native GET form: no client router needed, and the question
            arrives on /council/new as ?question=… for the composer. */}
        <form
          action="/council/new"
          method="get"
          className="council-chamber-ask"
          data-testid="council-chamber-ask"
        >
          <label className={council.meta} htmlFor="council-chamber-question">
            Your question
          </label>
          <input
            id="council-chamber-question"
            name="question"
            type="text"
            required
            maxLength={CHAMBER_QUESTION_MAX}
            autoComplete="off"
            className="council-journey-input council-chamber-input"
            aria-describedby="council-chamber-hint"
            data-testid="council-chamber-question"
          />
          <button
            type="submit"
            className={council.btnPrimary}
            data-testid="council-chamber-submit"
          >
            Ask the council
          </button>
        </form>
        <CouncilShell
          room={IDLE_CHAMBER_ROOM}
          medallionSrcBySeat={COUNCIL_MEDALLION_SMALL_SRC}
        />

        <p className={council.meta}>
          Prefer the full guided intake from the start?{' '}
          <Link href="/council/new" data-testid="council-chamber-guided-intake">
            Open the guided intake
          </Link>
          .
        </p>
      </section>

      {capabilities ? (
        <p className={council.meta} data-testid="council-readiness-summary">
          Foundation status: {capabilities.endpoints.ready} of {capabilities.endpoints.total}{' '}
          registered council endpoints are wired. Starting a run is not wired yet; the session
          page shows that endpoint’s typed readiness state instead of simulating a run.
        </p>
      ) : null}

      <section>
        <h2 className={council.heading}>Your council sessions</h2>
        {error ? (
          <div className="council-journey-notice council-journey-notice-error" role="alert">
            {error}
          </div>
        ) : sessions === null ? (
          <p className={council.meta} data-testid="council-sessions-loading">
            Loading your sessions…
          </p>
        ) : sessions.length === 0 ? (
          <p className={council.meta} data-testid="council-sessions-empty">
            No council sessions yet. Your first decision starts above.
          </p>
        ) : (
          <div className="council-journey-grid" data-testid="council-sessions-list">
            {sessions.map((session) => (
              <article key={session.session_id} className="council-journey-kind">
                <h3 style={{ marginTop: 0 }}>
                  <Link href={`/council/${session.session_id}`}>
                    Session {session.session_id.slice(0, 8)}
                  </Link>
                </h3>
                <p className={council.meta}>
                  {sessionStateLabel(session.state)} · mode {session.mode} · brief revision{' '}
                  {session.brief_revision}
                  {session.archived ? ' · archived' : ''}
                </p>
                <p className={council.meta}>
                  Updated {new Date(session.updated_at).toLocaleString()}
                </p>
              </article>
            ))}
          </div>
        )}
        <p className={council.meta}>
          <Link href="/council/history" data-testid="council-history-link">
            Session history
          </Link>
        </p>
      </section>
    </div>
  );
}
