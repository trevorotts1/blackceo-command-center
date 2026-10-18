'use client';

/**
 * SessionDetail (CWE-033, Skill 77)
 *
 * The session home (Section 21): the frozen brief, the pinned route
 * snapshot, CWE-032's council room embedded (never rebuilt), the
 * verdict in Section 21's fixed order, and the linked-consult entry.
 * The page uses the already-wired CWE-030 journal snapshot/SSE service
 * after a run is queued, instead of guessing completed advisor seats
 * from the coarse session state. The pre-run room remains an explicit
 * waiting-only preview. Failed/private event reads show their real
 * state; never pretend an unavailable stream returned advisor answers.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  featureNotReadyState,
  getModels,
  getSession,
  getVerdict,
  isCouncilClientError,
  newIdempotencyKey,
  startSession,
  type CouncilStartReceipt,
  type CouncilStoredSession,
  type CouncilVerdictData,
  type FeatureNotReadyState,
} from '@/lib/council/journey-client';
import type { RouteCatalogEntry } from '@/lib/council/providers';
import { council } from './council-theme';
import { CouncilShell } from './CouncilShell';
import { CouncilLiveSession } from './CouncilLiveSession';
import { CouncilApiClient, FetchCouncilSessionTransport } from './council-session-client';
import type { CouncilRoomView } from './council-room-types';
import { COUNCIL_MEDALLION_LARGE_SRC, COUNCIL_MEDALLION_SMALL_SRC } from './medallions';
import { identityLevelLabel } from './ModelRoutePicker';
import { BriefReview } from './BriefReview';
import { VerdictView } from './VerdictView';
import { ConsultPanel } from './ConsultPanel';
import { sessionStateLabel } from './CouncilHome';

/**
 * Only draft/ready sessions can be projected directly from their session
 * summary. Once queued, advisor status MUST come from committed journal
 * receipts via CouncilLiveSession; a COMPLETED aggregate is not proof
 * that all nine advisor cards exist or passed validation.
 */
export function roomViewFromSession(session: CouncilStoredSession): CouncilRoomView {
  const state = session.state.state;
  if (state !== 'DRAFT' && state !== 'READY') {
    throw new Error('Post-start advisor states require a committed event projection.');
  }
  return {
    decisionTitle: session.brief.question,
    phaseLabel: sessionStateLabel(state),
    currentRound: null,
    cruxLabel: null,
    mode: 'live',
    seats: session.spec.seat_ids.map((seatId) => ({
      seatId,
      status: 'queued' as const,
      card: null,
    })),
  };
}

export function SessionDetail({ sessionId }: { sessionId: string }) {
  const [session, setSession] = useState<CouncilStoredSession | null>(null);
  const [accessVia, setAccessVia] = useState<string | null>(null);
  const [verdictData, setVerdictData] = useState<CouncilVerdictData | null>(null);
  const [routes, setRoutes] = useState<RouteCatalogEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [startNotReady, setStartNotReady] = useState<FeatureNotReadyState | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  const [startReceipt, setStartReceipt] = useState<CouncilStartReceipt | null>(null);
  const startIdempotencyKeyRef = useRef<string | null>(null);
  const startInFlightRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [sessionResult, verdict, models] = await Promise.all([
          getSession(sessionId),
          getVerdict(sessionId),
          getModels().catch(() => null),
        ]);
        if (cancelled) return;
        setSession(sessionResult.session);
        setAccessVia(sessionResult.accessVia);
        setVerdictData(verdict);
        if (models) setRoutes(models.routes);
      } catch (caught) {
        if (cancelled) return;
        setError(
          isCouncilClientError(caught)
            ? `${caught.code}: ${caught.message}`
            : 'This session could not be loaded.',
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  const preRun = session !== null &&
    (session.state.state === 'DRAFT' || session.state.state === 'READY');
  const room = useMemo(
    () => (session && preRun ? roomViewFromSession(session) : null),
    [session, preRun],
  );
  // Stable identity is critical: recreating the transport each render would
  // reopen SSE and retry snapshots continuously.
  const liveTransport = useMemo(() =>
    new FetchCouncilSessionTransport(new CouncilApiClient()), []);

  const startEligible = session !== null
    && accessVia !== 'support'
    && (session.state.state === 'DRAFT' || session.state.state === 'READY');

  const handleStart = async () => {
    if (startInFlightRef.current || !startEligible || !session) return;
    startInFlightRef.current = true;
    setStarting(true);
    setStartNotReady(null);
    setStartError(null);
    try {
      // Retain the same key across uncertain network outcomes; a second
      // click must not invent a second durable council_run operation.
      if (!startIdempotencyKeyRef.current) {
        startIdempotencyKeyRef.current = newIdempotencyKey();
      }
      const receipt = await startSession(sessionId, startIdempotencyKeyRef.current, {
        expectedVersion: session.state.state_version,
      });
      setStartReceipt(receipt);
      setSession((previous) => previous ? {
        ...previous,
        state: {
          ...previous.state,
          state: receipt.state,
          state_version: receipt.state_version,
        },
      } : previous);
    } catch (caught) {
      const state = featureNotReadyState(caught, 'council.sessions.start');
      if (state) {
        setStartNotReady(state);
      } else {
        setStartError(
          isCouncilClientError(caught)
            ? `${caught.code}: ${caught.message}`
            : 'The run could not be started.',
        );
      }
    } finally {
      startInFlightRef.current = false;
      setStarting(false);
    }
  };

  if (error) {
    return (
      <div className="council-journey-notice council-journey-notice-error" role="alert">
        {error}
      </div>
    );
  }
  if (!session) {
    return (
      <p className={council.meta} data-testid="session-loading">
        Loading the session…
      </p>
    );
  }

  const policy = session.spec.model_policy;
  const routeEntry = routes.find((r) => r.routeId === policy.route_id) ?? null;

  return (
    <div className="council-journey-stack" data-testid="session-detail">
      {accessVia === 'support' ? (
        <div className="council-journey-notice" data-testid="session-support-access">
          You are viewing this session through support access. This read is auditable, and
          support access never mutates a session.
        </div>
      ) : null}

      <section className="council-journey-kind">
        <h2 className={council.heading} style={{ marginTop: 0 }}>
          {session.brief.question}
        </h2>
        <p className={council.meta}>
          State: {sessionStateLabel(session.state.state)} · mode {session.spec.mode} ·{' '}
          {session.spec.visibility} · brief revision {session.spec.brief_revision} · panel of{' '}
          {session.spec.seat_ids.length} seats
        </p>
        <p className={council.meta}>
          Route snapshot: {policy.selection === 'explicit' ? 'your selection' : 'inherited default'}{' '}
          · {routeEntry ? routeEntry.displayLabel : policy.route_id}
          {routeEntry ? ` · identity level: ${identityLevelLabel(routeEntry.identityLevel)}` : ''}
          {policy.requested_model_id ? ` · requested model ${policy.requested_model_id}` : ''}
        </p>
        <p className={council.meta}>
          Brief hash <span className="council-journey-hash">{session.spec.brief_sha256}</span>
        </p>
      </section>

      <section className="council-journey-kind" data-testid="session-start-panel">
        <h3 className={council.heading} style={{ marginTop: 0 }}>
          Run the council
        </h3>
        <p className={council.meta}>
          Starting the run is its own authorization, separate from creating the session. A
          council vote is never an execution credential.
        </p>
        {startEligible ? (
          <button
            type="button"
            className={council.btnPrimary}
            onClick={handleStart}
            disabled={starting}
            data-testid="session-start"
          >
            {starting ? 'Contacting the run service…' : 'Start council run'}
          </button>
        ) : (
          <p className={council.meta} data-testid="session-start-unavailable">
            {accessVia === 'support'
              ? 'Support access is read-only; this account cannot start the Council.'
              : session.state.state === 'QUEUED'
                ? 'This session is already queued for Council execution.'
                : 'This session is not in a startable draft state. Review its current state before taking another action.'}
          </p>
        )}
        {startReceipt ? (
          <div className="council-journey-notice" data-testid="session-start-queued" role="status">
            Council execution was queued. Job {startReceipt.job_id}; attempt {startReceipt.attempt}.
            {startReceipt.idempotent_replay ? ' Existing queued operation reused.' : ''}
            This receipt confirms admission, not a completed Council verdict.
          </div>
        ) : null}
        {startNotReady ? (
          <div
            className="council-journey-notice"
            data-testid="session-start-not-ready"
            style={{ marginTop: '1rem' }}
          >
            <p style={{ margin: 0 }}>
              <strong>Start is not ready yet.</strong> {startNotReady.message}
            </p>
            <p className={council.meta} style={{ margin: '0.25rem 0 0' }}>
              Owning unit: {startNotReady.owningUnit}. No run was started and nothing is
              simulating one.
            </p>
          </div>
        ) : null}
        {startError ? (
          <div className="council-journey-notice council-journey-notice-error" role="alert">
            {startError}
          </div>
        ) : null}
      </section>

      <section data-testid="session-room">
        {preRun && room ? (
          <>
            <CouncilShell
              room={room}
              medallionSrcBySeat={COUNCIL_MEDALLION_SMALL_SRC}
              medallionLargeSrcBySeat={COUNCIL_MEDALLION_LARGE_SRC}
            />
            <p className={council.meta} data-testid="session-room-prerun-note">
              This session has not started. All nine advisor positions are waiting;
              no debate, stance or verdict has been inferred from a draft.
            </p>
          </>
        ) : (
          <CouncilLiveSession
            sessionId={sessionId}
            transport={liveTransport}
            decisionTitle={session.brief.question}
            medallionSrcBySeat={COUNCIL_MEDALLION_SMALL_SRC}
            medallionLargeSrcBySeat={COUNCIL_MEDALLION_LARGE_SRC}
          />
        )}
      </section>

      <section data-testid="session-verdict">
        <h2 className={council.heading}>Verdict</h2>
        {verdictData === null ? (
          <p className={council.meta}>Loading the verdict…</p>
        ) : verdictData.verdict_state === 'validated' && verdictData.verdict ? (
          <VerdictView verdict={verdictData.verdict} brief={session.brief} />
        ) : (
          <div className="council-journey-notice" data-testid="session-verdict-not-ready">
            No verdict has been committed for this session. A verdict appears here only when
            the council has actually deliberated and the record validates; it is never
            generated for display.
          </div>
        )}
      </section>

      <section data-testid="session-brief">
        <h2 className={council.heading}>The frozen brief</h2>
        <BriefReview brief={session.brief} />
        <p className={council.meta}>
          Facts that arrive after this freeze do not rewrite the brief; they are recorded as
          amendments against revision {session.brief.revision}.
        </p>
      </section>

      <ConsultPanel sessionId={sessionId} />
    </div>
  );
}
