'use client';

/**
 * WER-020: genuine, read-only Council replay from committed event pages.
 * Fetches history from cursor zero, checks every page and timestamp, and
 * derives each visual frame from the canonical event reducer.
 *
 * No SSE connection, provider request, session mutation or action creation.
 * A snapshot of the latest state is NOT a time series and cannot be replayed.
 */
import { useEffect, useMemo, useState } from 'react';
import { CouncilShell } from './CouncilShell';
import type { CouncilSessionTransport } from './council-session-client';
import {
  buildRecordedCouncilReplay,
  replayAtElapsedMs,
  advanceReplayClock,
  type RecordedCouncilReplay,
  type RecordedReplaySpeed,
} from './council-replay-timeline';
import { projectionToRoomView } from './council-session-types';
import { council, councilcx } from './council-theme';
import type { CouncilWireEvent } from '@/lib/council/events/types';

const MAX_PAGES = 100;
const MAX_EVENTS = 5000;
const TICK_MS = 100;
const SPEEDS: readonly RecordedReplaySpeed[] = [0.5, 1, 2, 4];

export interface CouncilRecordedReplayProps {
  sessionId: string;
  transport: CouncilSessionTransport;
  decisionTitle: string;
  medallionSrcBySeat: Readonly<Record<string, string>>;
  medallionLargeSrcBySeat?: Readonly<Record<string, string>>;
}

function formatElapsed(ms: number): string {
  const seconds = Math.floor(Math.max(0, ms) / 1000);
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
}

export async function readCompleteRecordedHistory(
  transport: CouncilSessionTransport,
  sessionId: string,
): Promise<readonly CouncilWireEvent[] | null> {
  let cursor = 0;
  const events: CouncilWireEvent[] = [];
  for (let pageIndex = 0; pageIndex < MAX_PAGES; pageIndex += 1) {
    const result = await transport.page(sessionId, cursor);
    if (result.kind === 'invalidation') return null;
    if (result.kind !== 'page') {
      throw new Error('This Council host cannot return complete recorded history from event zero.');
    }
    const page = result.page;
    if (page.session_id !== sessionId) {
      throw new Error('Recorded history response belongs to another session.');
    }
    if (page.events.length < 1 && page.has_more) {
      throw new Error('Recorded history did not advance; refusing an endless page loop.');
    }
    for (const event of page.events) {
      if (event.session_id !== sessionId || event.sequence !== cursor + 1) {
        throw new Error('Recorded history contains a gap or a foreign event.');
      }
      cursor = event.sequence;
      events.push(event);
      if (events.length > MAX_EVENTS) {
        throw new Error('Recorded history exceeds the supported bounded playback size.');
      }
    }
    if (!page.has_more) {
      if (page.last_sequence > cursor) {
        throw new Error('Recorded event history is incomplete at the current cursor.');
      }
      return events;
    }
  }
  throw new Error('Recorded history exceeds the supported page count.');
}

export function CouncilRecordedReplay({
  sessionId,
  transport,
  decisionTitle,
  medallionSrcBySeat,
  medallionLargeSrcBySeat,
}: CouncilRecordedReplayProps) {
  const [timeline, setTimeline] = useState<RecordedCouncilReplay | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [speed, setSpeed] = useState<RecordedReplaySpeed>(1);
  const [playing, setPlaying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPrivate, setIsPrivate] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setTimeline(null);
    setElapsedMs(0);
    setSpeed(1);
    setPlaying(false);
    setError(null);
    setIsPrivate(false);
    void readCompleteRecordedHistory(transport, sessionId).then((history) => {
      if (cancelled) return;
      if (history === null) {
        setIsPrivate(true);
        return;
      }
      setTimeline(buildRecordedCouncilReplay(sessionId, history));
    }).catch((cause: unknown) => {
      if (!cancelled) {
        setError(cause instanceof Error ? cause.message : 'Recorded event history could not be verified.');
      }
    });
    return () => { cancelled = true; };
  }, [sessionId, transport]);

  useEffect(() => {
    if (!playing || !timeline || timeline.durationMs === 0) return;
    let last = Date.now();
    const timer = setInterval(() => {
      const now = Date.now();
      const delta = Math.max(0, now - last);
      last = now;
      setElapsedMs((previous) =>
        advanceReplayClock(timeline, previous, delta, speed).elapsedMs,
      );
    }, TICK_MS);
    return () => clearInterval(timer);
  }, [playing, speed, timeline]);

  // Stop playback outside a React state updater, avoiding cross-state
  // updates during render and retaining a deterministic final frame.
  useEffect(() => {
    if (playing && timeline && elapsedMs >= timeline.durationMs) {
      setPlaying(false);
    }
  }, [elapsedMs, playing, timeline]);

  const position = useMemo(
    () => timeline ? replayAtElapsedMs(timeline, elapsedMs) : null,
    [timeline, elapsedMs],
  );

  if (isPrivate) {
    return <div className={council.theme} data-testid="council-replay-private">
      <h1 className={council.heading}>Private Council session</h1>
      <p>You do not have access to this saved Council history.</p>
    </div>;
  }
  if (error) {
    return <div className={council.theme} data-testid="council-replay-error" role="alert">
      <h1 className={council.heading}>Recorded replay unavailable</h1>
      <p>{error}</p>
    </div>;
  }
  if (!timeline || !position) {
    return <div className={council.theme} data-testid="council-replay-loading" role="status">
      Reading the recorded Council event history...
    </div>;
  }

  const room = position.projection ? projectionToRoomView(position.projection, {
    decisionTitle,
    mode: 'replay',
  }) : null;
  return (
    <div className={council.theme} data-testid="council-recorded-replay">
      <div data-testid="council-live-replay-note" role="status">
        <strong>Recorded replay.</strong> Saved, verified journal events only.
        Playback makes no new AI requests or tasks.
      </div>
      <div role="group" aria-label="Council replay controls" style={{ padding: '1rem 0' }}>
        <button type="button" data-testid="council-replay-play-pause"
          className={councilcx(council.btn, council.btnSecondary)}
          aria-label={playing ? 'Pause recorded Council replay' : 'Play recorded Council replay'}
          onClick={() => {
            if (position.finished) setElapsedMs(0);
            setPlaying((current) => !current);
          }}
          disabled={timeline.durationMs === 0}>
          {playing ? 'Pause' : 'Play'}
        </button>
        <label htmlFor="council-replay-speed" style={{ marginLeft: '0.75rem' }}>Speed</label>
        <select id="council-replay-speed" data-testid="council-replay-speed"
          className={council.btn}
          value={speed}
          onChange={(event) => setSpeed(Number(event.currentTarget.value) as RecordedReplaySpeed)}>
          {SPEEDS.map((value) => <option value={value} key={value}>{value}×</option>)}
        </select>
        <label htmlFor="council-replay-seek" style={{ display: 'block', marginTop: '0.625rem' }}>
          Recorded position: {formatElapsed(position.elapsedMs)} / {formatElapsed(timeline.durationMs)}
        </label>
        <input id="council-replay-seek" type="range"
          data-testid="council-replay-seek"
          min={0} max={Math.max(1, timeline.durationMs)} step={Math.max(1, Math.round(timeline.durationMs / 500))}
          value={position.elapsedMs}
          aria-label="Seek recorded Council replay"
          style={{ width: 'min(100%, 720px)', minHeight: '44px', display: 'block' }}
          onChange={(event) => {
            setPlaying(false);
            setElapsedMs(Math.max(0, Math.min(timeline.durationMs, Number(event.currentTarget.value))));
          }}
        />
        <p className={council.meta} data-testid="council-replay-progress">
          {position.appliedEvents} of {timeline.frames.length} recorded events.
          {position.finished ? ' Playback complete.' : ''}
        </p>
      </div>
      {room ? (
        <CouncilShell room={room}
          medallionSrcBySeat={medallionSrcBySeat}
          medallionLargeSrcBySeat={medallionLargeSrcBySeat}
        />
      ) : (
        <p>No saved Council frame is available at the selected position.</p>
      )}
    </div>
  );
}
