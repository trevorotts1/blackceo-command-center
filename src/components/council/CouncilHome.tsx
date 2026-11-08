'use client';

/**
 * CouncilHome (CWE-033, Skill 77; CTR-104 visual-first entry; CTR-191 launch parity)
 *
 * The council home IS the chamber, at every launch point. One click on the
 * Council entry lands on the nine-seat room: no intake form stands between
 * the click and the room, and no setup page is a precondition.
 *
 * CTR-191: the previous entry rendered an intake <form action="/council/new">
 * ABOVE an always-idle room, so the room never bound a session — the page
 * opened on a setup prompt and the only "Council" it ever showed was nine
 * queued seats plus the line "Starting a run is not wired yet". The working
 * OpenClaw/claude-nine chamber opens on the sitting itself: the room, the
 * decision, the deliberation in flight, and the answer below it. This entry
 * now does the same in the Command Center's own managed store:
 *
 *   1. the chamber opens first (room stage, never a form);
 *   2. the most recent RUNNING session is bound to it, so ongoing
 *      deliberation is visible on arrival;
 *   3. a finished sitting shows its verdict, options and results below the
 *      room, on the same page;
 *   4. "New question" is an explicit control in the chamber bar, not a gate
 *      in front of the room.
 *
 * Opening the chamber starts nothing: no session is created, no model is
 * called. The reads are the existing authorized session list, one authorized
 * session read, and the existing authorized verdict read.
 *
 * Managed ownership is unchanged: this renders the Command Center's own
 * sessions through the Command Center's own authorized API. It never
 * redirects a managed session into the standalone council service.
 */

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  getCapabilities,
  getSession,
  getVerdict,
  isCouncilClientError,
  listSessions,
  type CouncilCapabilitiesData,
  type CouncilSessionListItem,
} from '@/lib/council/journey-client';
import {
  CouncilApiClient,
  FetchCouncilSessionTransport,
} from './council-session-client';
import { classifyVerdictRead } from './council-session-types';
import { council } from './council-theme';
import { CouncilLiveSession } from './CouncilLiveSession';
import { CouncilShell } from './CouncilShell';
import { CouncilVerdict } from './CouncilVerdict';
import { COUNCIL_MEDALLION_LARGE_SRC, COUNCIL_MEDALLION_SMALL_SRC } from './medallions';
import { useCouncilPortraitRelease } from './useCouncilPortraitRelease';
import { COUNCIL_SEAT_ROSTER, type CouncilRoomView } from './council-room-types';
import type { CouncilCard, DecisionBrief } from '@/lib/council/contracts';
import type { CouncilStoredSession } from '@/lib/council/store';

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

/** States where a sitting is still moving. The chamber binds these first. */
const RUNNING_STATES = new Set([
  'QUEUED',
  'PREPARING',
  'ROUND_1',
  'CRUX_REVIEW',
  'ROUND_2',
  'DRAFT_RESOLUTION',
  'ROUND_3',
  'CONSULTING',
  'VERIFYING',
]);

const TERMINAL_STATES = new Set(['COMPLETED', 'CANCELLED', 'FAILED', 'BLOCKED']);

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

/**
 * Which sitting the chamber opens on. A running one always wins; otherwise
 * a finished one so the answer is visible on arrival; otherwise none, and
 * the chamber waits with its New question control. Archived and draft
 * sittings are never opened by the chamber silently.
 */
export function selectChamberSession(
  sessions: readonly CouncilSessionListItem[],
): CouncilSessionListItem | null {
  const open = sessions.filter((s) => !s.archived && s.state !== 'DRAFT');
  const running = open.find((s) => RUNNING_STATES.has(s.state));
  if (running) return running;
  return open.find((s) => TERMINAL_STATES.has(s.state)) ?? null;
}

interface ChamberDetail {
  brief: DecisionBrief;
  title: string;
  session: CouncilStoredSession;
  accessVia: string | null;
}

export function CouncilHome() {
  const [sessions, setSessions] = useState<CouncilSessionListItem[] | null>(null);
  const [capabilities, setCapabilities] = useState<CouncilCapabilitiesData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ChamberDetail | null>(null);
  const [verdictRead, setVerdictRead] = useState<unknown>(null);
  // Committed cards join this read at CWE-050 assembly; the screens render
  // their explicit no-card-detail state until then.
  const [cards] = useState<readonly CouncilCard[]>([]);

  const portraits = useCouncilPortraitRelease();
  const client = useMemo(() => new CouncilApiClient(), []);
  const transport = useMemo(() => new FetchCouncilSessionTransport(client), [client]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [list, caps] = await Promise.all([listSessions(), getCapabilities()]);
        if (cancelled) return;
        setSessions(list.sessions);
        setCapabilities(caps);
        setSelectedId(selectChamberSession(list.sessions)?.session_id ?? null);
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

  // One authorized read of the sitting the chamber is bound to. Nothing is
  // created here; the read only names what the room will show.
  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      setVerdictRead(null);
      return;
    }
    let cancelled = false;
    setDetail(null);
    setVerdictRead(null);
    getSession(selectedId)
      .then(({ session, accessVia }) => {
        if (cancelled) return;
        const brief = session.brief ?? null;
        if (brief) setDetail({ brief, title: brief.question, session, accessVia });
      })
      .catch(() => {
        /* the room reports its own load state; nothing is guessed here */
      });
    getVerdict(selectedId)
      .then((data) => {
        if (!cancelled) setVerdictRead(data);
      })
      .catch(() => {
        if (!cancelled) setVerdictRead(null);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedId]);

  const selected = sessions?.find((s) => s.session_id === selectedId) ?? null;
  const selectedIsRunning = selected ? RUNNING_STATES.has(selected.state) : false;

  const optionLabels = useMemo(() => {
    const labels: Record<string, string> = {};
    for (const option of detail?.brief.options ?? []) labels[option.id] = option.label;
    return labels;
  }, [detail]);

  const verdictIsValid = useMemo(
    () => (verdictRead ? classifyVerdictRead(verdictRead).kind === 'valid' : false),
    [verdictRead],
  );

  const medallionSrcBySeat =
    portraits?.status === 'approved'
      ? portraits.images.roomSrcBySeat
      : COUNCIL_MEDALLION_SMALL_SRC;
  const medallionLargeSrcBySeat =
    portraits?.status === 'approved'
      ? portraits.images.detailSrcBySeat
      : COUNCIL_MEDALLION_LARGE_SRC;

  return (
    <div className="council-journey-stack" data-testid="council-home">
      <section className="council-chamber-panel" data-testid="council-chamber">
        {/* The chamber bar. Every control is a chamber control, reachable
            without leaving the room; no control gates the room itself. */}
        <div className="council-chamber-bar" data-testid="council-chamber-bar">
          <h2 className={council.heading} style={{ margin: 0 }}>
            Council of Wise Elders
          </h2>
          <div className="council-chamber-actions">
            <Link
              href="/council/new"
              className={council.btnPrimary}
              data-testid="council-chamber-new-question"
            >
              New question
            </Link>
            <Link
              href="/council/history"
              className={council.btnQuiet}
              data-testid="council-chamber-past-sessions"
            >
              Past sessions
            </Link>
            <Link
              href="/council/advisors"
              className={council.btnQuiet}
              data-testid="council-chamber-advisors"
            >
              The nine advisors
            </Link>
          </div>
        </div>

        {selected ? (
          <p className={council.meta} data-testid="council-chamber-sitting" aria-live="polite">
            {selectedIsRunning ? 'Sitting in progress' : 'Sitting'}{' '}
            {selected.session_id.slice(0, 8)} · {sessionStateLabel(selected.state)} · mode{' '}
            {selected.mode}.{' '}
            <Link href={`/council/${selected.session_id}`}>Open the full sitting</Link>
          </p>
        ) : null}

        {selected ? (
          <CouncilLiveSession
            key={selected.session_id}
            sessionId={selected.session_id}
            transport={transport}
            decisionTitle={detail?.title ?? 'Council session'}
            medallionSrcBySeat={medallionSrcBySeat}
            medallionLargeSrcBySeat={medallionLargeSrcBySeat}
          />
        ) : (
          <CouncilShell room={IDLE_CHAMBER_ROOM} medallionSrcBySeat={medallionSrcBySeat} />
        )}

        {portraits?.status === 'unavailable' ? (
          <p role="status" data-testid="council-portrait-unavailable">
            Portraits are unavailable. The room shows symbolic advisor medallions.
          </p>
        ) : null}

        {/* Results stay on this page, directly below the room, exactly as the
            working chamber shows them. */}
        {detail && verdictIsValid ? (
          <CouncilVerdict
            verdictRead={verdictRead}
            optionLabels={optionLabels}
            cards={cards}
            brief={detail.brief}
            mode="live"
            sessionId={selectedId ?? ''}
            createExport={(body, key) => client.createExport(body, key)}
          />
        ) : null}

        {capabilities ? (
          <p className={council.meta} data-testid="council-readiness-summary">
            Foundation status: {capabilities.endpoints.ready} of {capabilities.endpoints.total}{' '}
            registered council endpoints are wired. A sitting that is not startable says so
            on its own session controls; nothing here simulates a run.
          </p>
        ) : null}
      </section>

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
