'use client';

/**
 * CouncilLiveSession (CWE-034, Skill 77) - the live session screen.
 *
 * Composes CWE-032's CouncilShell room over CWE-030's reducer via
 * useCouncilLiveSession: snapshot first, then the ordered stream.
 * The screen's states are all explicit (Section 21.3): loading,
 * private, load error, disconnected (with the last committed state
 * still visible and a reconnect control), resyncing, and the
 * recorded session-state notices for blocked, failed, cancelled, and
 * paused sessions. A disconnected or unfinished session is never
 * presented as completed, and replay mode is labeled persistently
 * by the room's own mode badge (T101).
 */

import { council, councilcx } from './council-theme';
import { CouncilShell } from './CouncilShell';
import { CouncilRecordedReplay } from './CouncilRecordedReplay';
import { useCouncilLiveSession } from './useCouncilLiveSession';
import {
  projectionToRoomView,
  sessionStateNotice,
} from './council-session-types';
import type { CouncilSessionTransport } from './council-session-client';

export interface CouncilLiveSessionProps {
  sessionId: string;
  transport: CouncilSessionTransport;
  decisionTitle: string;
  /** True when this screen is a recorded replay, not the live session. */
  replay?: boolean;
  medallionSrcBySeat: Readonly<Record<string, string>>;
  medallionLargeSrcBySeat?: Readonly<Record<string, string>>;
}

export function CouncilLiveSession(props: CouncilLiveSessionProps) {
  // Keep replay separate from the live-stream hook. It reconstructs
  // history from cursor zero and cannot reuse the latest live snapshot.
  if (props.replay) {
    return <CouncilRecordedReplay
      sessionId={props.sessionId}
      transport={props.transport}
      decisionTitle={props.decisionTitle}
      medallionSrcBySeat={props.medallionSrcBySeat}
      medallionLargeSrcBySeat={props.medallionLargeSrcBySeat}
    />;
  }
  return <RunningCouncilSession {...props} />;
}

function RunningCouncilSession({
  sessionId,
  transport,
  decisionTitle,
  replay = false,
  medallionSrcBySeat,
  medallionLargeSrcBySeat,
}: CouncilLiveSessionProps) {
  const live = useCouncilLiveSession(sessionId, transport, { replay });

  if (live.loadState === 'loading') {
    return (
      <div className={council.theme} data-testid="council-live-loading">
        <h1 className={council.heading}>Council session</h1>
        <p aria-live="polite">
          Loading the committed session record. The room appears only when
          saved state has been read; nothing is previewed in its place.
        </p>
      </div>
    );
  }

  if (live.loadState === 'private') {
    return (
      <div className={council.theme} data-testid="council-live-private">
        <h1 className={council.heading}>Private session</h1>
        <p>
          This session is private. Its room, cards, sources, and events are
          visible only to its owner, and this screen received only the
          non-sensitive signal that the session changed. No content is
          requested or shown here.
        </p>
      </div>
    );
  }

  if (live.loadState === 'error' || !live.projection) {
    return (
      <div className={council.theme} data-testid="council-live-error">
        <h1 className={council.heading}>The session could not be loaded</h1>
        <p>
          {live.errorMessage ??
            'The committed session record could not be read. No session state is shown rather than guessed.'}
        </p>
        <button
          type="button"
          className={councilcx(council.btn, council.btnSecondary)}
          data-testid="council-live-retry"
          onClick={() => void live.reconnect()}
        >
          Try again
        </button>
      </div>
    );
  }

  const projection = live.projection;
  const notice = sessionStateNotice(projection.state);
  const room = projectionToRoomView(projection, {
    decisionTitle,
    mode: replay ? 'replay' : undefined,
  });

  return (
    <div data-testid="council-live-session">
      {live.connection === 'disconnected' && !replay ? (
        <div
          role="alert"
          data-testid="council-live-disconnected"
          className={council.theme}
          style={{ padding: '0.75rem 1rem' }}
        >
          <strong>Disconnected.</strong> The live event stream dropped. The
          room below shows the last committed state exactly as saved; it is
          not live, and this session is not shown as complete.{' '}
          <button
            type="button"
            className={councilcx(council.btn, council.btnSecondary)}
            data-testid="council-live-reconnect"
            onClick={() => void live.reconnect()}
          >
            Reconnect and catch up
          </button>
        </div>
      ) : null}
      {live.connection === 'resyncing' ? (
        <div
          role="status"
          data-testid="council-live-resyncing"
          className={council.theme}
          style={{ padding: '0.75rem 1rem' }}
        >
          <strong>Resyncing.</strong> Events arrived out of order, so the
          screen is re-reading the committed record from the last applied
          sequence. Partial updates are never applied.
        </div>
      ) : null}
      {live.connection === 'connecting' && !replay ? (
        <div role="status" className={council.theme} style={{ padding: '0.75rem 1rem' }}>
          Connecting to the live event stream...
        </div>
      ) : null}
      {replay ? (
        <div
          role="status"
          data-testid="council-live-replay-note"
          className={council.theme}
          style={{ padding: '0.75rem 1rem' }}
        >
          <strong>Recorded replay.</strong> You are viewing the committed
          record of a finished session. A replay cannot create production
          work, and exports started here are labeled as replay exports.
        </div>
      ) : null}
      {notice ? (
        <div
          role="status"
          data-testid={`council-live-state-${notice.tone}`}
          className={council.theme}
          style={{ padding: '0.75rem 1rem' }}
        >
          {notice.text}
        </div>
      ) : null}
      <p className={council.meta} data-testid="council-live-activity" aria-live="polite">
        {projection.activity.completed_cards} of {projection.activity.total_seats}{' '}
        perspectives committed.
        {projection.activity.last_event_at
          ? ` Last committed event at ${projection.activity.last_event_at}.`
          : ''}
      </p>
      <CouncilShell
        room={room}
        medallionSrcBySeat={medallionSrcBySeat}
        medallionLargeSrcBySeat={medallionLargeSrcBySeat}
      />
    </div>
  );
}
