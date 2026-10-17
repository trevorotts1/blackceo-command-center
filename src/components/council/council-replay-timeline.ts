/**
 * WER-020: deterministic, strictly read-only recorded Council playback core.
 *
 * Consume *committed*, authorized journal events collected from cursor 0 by
 * the owning read-only API. Never synthesize source events, inference results,
 * wall-clock timestamps, remote model calls, or action-plan mutations.
 *
 * The UI owns the timer and controls; this pure module owns validation and
 * the exact projection reconstructed when seeking to a recorded point.
 */
import { CouncilClientReducer } from '@/lib/council/events/reducer';
import type {
  CouncilSessionProjection,
  CouncilWireEvent,
} from '@/lib/council/events/types';

export type RecordedReplaySpeed = 0.5 | 1 | 2 | 4;

export interface RecordedReplayFrame {
  event: CouncilWireEvent;
  elapsedMs: number;
}

export interface RecordedCouncilReplay {
  sessionId: string;
  durationMs: number;
  frames: readonly RecordedReplayFrame[];
}

export class CouncilReplayError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CouncilReplayError';
  }
}

const MAX_EVENTS = 5000;

function timestampMs(value: string): number {
  // A local or timezone-free string is not a trustworthy recorded instant.
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?(?:Z|[+-]\d\d:\d\d)$/.test(value)) {
    throw new CouncilReplayError('A recorded event has no unambiguous timezone-aware timestamp.');
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new CouncilReplayError('A recorded event has an invalid timestamp.');
  }
  return parsed;
}

export function buildRecordedCouncilReplay(
  sessionId: string,
  events: readonly CouncilWireEvent[],
): RecordedCouncilReplay {
  if (!sessionId || events.length < 1 || events.length > MAX_EVENTS) {
    throw new CouncilReplayError('Replay requires a bounded, nonempty committed event history.');
  }
  const first = events[0];
  if (!first || first.sequence !== 1 || first.type !== 'session_created') {
    throw new CouncilReplayError('Replay history does not begin at the committed session creation.');
  }
  const initialMs = timestampMs(first.occurred_at);
  let previousMs = initialMs;
  const seen = new Set<string>();
  const frames: RecordedReplayFrame[] = [];

  for (let i = 0; i < events.length; i += 1) {
    const event = events[i];
    if (
      event.origin !== 'journal' ||
      event.session_id !== sessionId ||
      event.scope.session_id !== sessionId ||
      event.sequence !== i + 1 ||
      !event.event_id ||
      seen.has(event.event_id)
    ) {
      throw new CouncilReplayError('Replay contains a missing, duplicated, out-of-order or cross-session event.');
    }
    const when = timestampMs(event.occurred_at);
    if (when < previousMs) {
      throw new CouncilReplayError('Replay journal timestamps run backwards; timing cannot be claimed.');
    }
    previousMs = when;
    seen.add(event.event_id);
    const scope = first.scope;
    if (
      event.scope.tenant_id !== scope.tenant_id ||
      event.scope.company_id !== scope.company_id ||
      event.scope.installation_id !== scope.installation_id ||
      event.scope.owner_subject !== scope.owner_subject ||
      event.scope.visibility !== scope.visibility
    ) {
      throw new CouncilReplayError('Replay crosses scope boundaries or changes the owning principal.');
    }
    frames.push({ event, elapsedMs: when - initialMs });
  }

  return {
    sessionId,
    durationMs: previousMs - initialMs,
    frames,
  };
}

export interface RecordedReplayPosition {
  elapsedMs: number;
  appliedEvents: number;
  projection: CouncilSessionProjection | null;
  finished: boolean;
}

export function replayAtElapsedMs(
  timeline: RecordedCouncilReplay,
  elapsedMs: number,
): RecordedReplayPosition {
  if (!Number.isFinite(elapsedMs)) {
    throw new CouncilReplayError('Replay seek position must be finite.');
  }
  const position = Math.max(0, Math.min(timeline.durationMs, elapsedMs));
  const reducer = new CouncilClientReducer(timeline.sessionId);
  let applied = 0;
  for (const frame of timeline.frames) {
    if (frame.elapsedMs > position) break;
    const result = reducer.applyEvent(frame.event);
    if (result !== 'applied') {
      throw new CouncilReplayError('Replay projection could not apply an event in recorded order.');
    }
    applied += 1;
  }
  return {
    elapsedMs: position,
    appliedEvents: applied,
    projection: reducer.currentProjection,
    finished: applied === timeline.frames.length && position >= timeline.durationMs,
  };
}

export function advanceReplayClock(
  timeline: RecordedCouncilReplay,
  elapsedMs: number,
  actualElapsedMs: number,
  speed: RecordedReplaySpeed,
): RecordedReplayPosition {
  if (!Number.isFinite(actualElapsedMs) || actualElapsedMs < 0) {
    throw new CouncilReplayError('Replay timer elapsed time cannot be negative or nonfinite.');
  }
  if (![0.5, 1, 2, 4].includes(speed)) {
    throw new CouncilReplayError('Only 0.5x, 1x, 2x and 4x replay are supported.');
  }
  return replayAtElapsedMs(timeline, elapsedMs + actualElapsedMs * speed);
}
