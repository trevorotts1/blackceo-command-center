'use client';

/**
 * CouncilHome (CWE-033, Skill 77)
 *
 * The council home (Section 21): the primary action (ask the
 * council), the client's real session list from
 * GET /api/council/sessions, and the foundation's readiness picture
 * stated honestly (how many registered endpoints are wired, and that
 * run execution is not among them yet). Loading, empty, and error are
 * three different renders; an error never poses as an empty list.
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
import { council } from './council-theme';

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
      <div className="council-journey-notice">
        <h2 className={council.heading} style={{ marginTop: 0 }}>
          Ask the council
        </h2>
        <p>
          Bring one decision. The guided intake asks one question at a time, saves your
          progress as you go, and freezes a brief the nine advisors deliberate against.
        </p>
        <Link className={council.btnPrimary} href="/council/new" data-testid="council-ask">
          Ask the council
        </Link>
      </div>

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
      </section>
    </div>
  );
}
