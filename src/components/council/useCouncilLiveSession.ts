'use client';

/**
 * useCouncilLiveSession (CWE-034, Skill 77 Council of Wise Elders)
 *
 * Binds the CWE-030 CouncilClientReducer to a session transport over
 * the real events contract (directive Section 18): snapshot first,
 * then the ordered stream. The reducer is the only state machine
 * here; this hook owns connection lifecycle and nothing else.
 *
 * Honesty rules (Sections 18.2 to 18.4, T102):
 *   - Seats show only event-backed states, because the projection is
 *     a pure fold of committed journal events.
 *   - A disconnect shows a visible disconnected state and the last
 *     committed projection stays on screen; a disconnected session is
 *     never presented as completed.
 *   - Reconnect catch-up goes through the reducer's cursor: duplicate
 *     deliveries change nothing, a gap triggers the resync path
 *     (page, then snapshot), never partial application.
 *   - A private session answered with the invalidation signal renders
 *     the private state; no event content is requested or shown.
 *   - Replay mode reads the committed record (snapshot plus ordered
 *     pages) and never opens the live stream; the screens label it
 *     persistently as a recorded replay (T101).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CouncilClientReducer } from '@/lib/council/events/reducer';
import type {
  CouncilCatchUp,
  CouncilSessionProjection,
} from '@/lib/council/events/types';
import type { CouncilSessionTransport } from './council-session-client';

export type CouncilLoadState = 'loading' | 'ready' | 'private' | 'error';
export type CouncilConnectionState =
  | 'connecting'
  | 'live'
  | 'disconnected'
  | 'resyncing';

export interface CouncilLiveSession {
  loadState: CouncilLoadState;
  connection: CouncilConnectionState;
  projection: CouncilSessionProjection | null;
  errorMessage: string | null;
  reconnect: () => void;
}

const RECONNECT_DELAY_MS = 3000;

interface OwnedSessionState extends Omit<CouncilLiveSession, 'reconnect'> {
  owner: object;
}

export function useCouncilLiveSession(
  sessionId: string,
  transport: CouncilSessionTransport,
  options: { replay?: boolean } = {},
): CouncilLiveSession {
  const replay = options.replay ?? false;
  // Each read lifecycle owns its display state. A new identity gates the old
  // projection during render, before effect cleanup or the next read completes.
  const owner = useMemo(() => ({}), [sessionId, transport, replay]);
  const [state, setState] = useState<OwnedSessionState | null>(null);
  const reconnectRef = useRef<{ owner: object; run: () => void } | null>(null);
  const reconnect = useCallback(() => {
    if (reconnectRef.current?.owner === owner) reconnectRef.current.run();
  }, [owner]);

  useEffect(() => {
    const reducer = new CouncilClientReducer(sessionId);
    let active = true;
    let revoked = false;
    let stream: { close: () => void } | null = null;
    let streamGeneration = 0;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    const initial: OwnedSessionState = {
      owner, loadState: 'loading', connection: 'connecting',
      projection: null, errorMessage: null,
    };
    const current = () => active && !revoked;
    const publish = (patch: Partial<OwnedSessionState>) => {
      if (!current()) return;
      setState((previous) => current()
        ? { ...(previous?.owner === owner ? previous : initial), ...patch }
        : previous);
    };
    publish(initial);
    const syncProjection = () => publish({ projection: reducer.currentProjection });
    const closeStream = () => {
      streamGeneration += 1;
      stream?.close();
      stream = null;
    };
    const showPrivate = () => {
      if (!current()) return;
      closeStream();
      if (reconnectTimer) clearTimeout(reconnectTimer);
      // Revoke this lifecycle before any queued page or stream callback can
      // publish content again. A fresh authorized lifecycle is required.
      revoked = true;
      setState((previous) => active
        ? { ...initial, loadState: 'private', connection: 'disconnected' }
        : previous);
    };

    const applyCatchUp = (result: CouncilCatchUp): 'ok' | 'private' | 'gap' => {
      if (!result || typeof result !== 'object' || !('kind' in result)) {
        throw new Error('The Council events endpoint returned an invalid event response.');
      }
      if (result.kind === 'invalidation') return 'private';
      if (result.kind === 'snapshot') {
        const snapshot = result.snapshot;
        if (
          !snapshot || snapshot.kind !== 'snapshot' ||
          snapshot.session_id !== sessionId ||
          !snapshot.projection || snapshot.projection.session_id !== sessionId ||
          !Array.isArray(snapshot.projection.seats)
        ) {
          throw new Error('The Council events endpoint returned an invalid session snapshot.');
        }
        reducer.applySnapshot(snapshot);
        syncProjection();
        return 'ok';
      }
      if (
        result.kind !== 'page' || !result.page ||
        result.page.kind !== 'events' || result.page.session_id !== sessionId ||
        !Array.isArray(result.page.events)
      ) {
        throw new Error('The Council events endpoint returned an invalid event page.');
      }
      const outcomes = reducer.applyPage(result.page.events);
      syncProjection();
      return outcomes.includes('gap') ? 'gap' : 'ok';
    };

    const resync = async (): Promise<'ok' | 'private' | 'cancelled'> => {
      if (!current()) return 'cancelled';
      publish({ connection: 'resyncing' });
      const page = await transport.page(sessionId, reducer.cursor);
      if (!current()) return 'cancelled';
      const result = applyCatchUp(page);
      if (result !== 'gap') return result;
      const snapshot = await transport.snapshot(sessionId);
      if (!current()) return 'cancelled';
      return applyCatchUp(snapshot) === 'private' ? 'private' : 'ok';
    };

    const reconnectNow = async () => {
      if (!current()) return;
      try {
        const result = await resync();
        if (!current() || result === 'cancelled') return;
        if (result === 'private') return showPrivate();
        publish({ loadState: 'ready', connection: 'live', errorMessage: null });
        openStream();
      } catch {
        publish({ connection: 'disconnected' });
      }
    };

    const openStream = () => {
      if (!current() || replay) return;
      closeStream();
      const generation = streamGeneration;
      const ownsStream = () => current() && generation === streamGeneration;
      const opened = transport.openStream(sessionId, reducer.cursor, {
        onEvent: (event) => {
          if (!ownsStream()) return;
          const outcome = reducer.applyEvent(event);
          syncProjection();
          if (outcome === 'gap') {
            closeStream();
            void reconnectNow();
          }
        },
        onSnapshot: (snapshot) => {
          if (!ownsStream()) return;
          applyCatchUp({ kind: 'snapshot', snapshot });
        },
        onInvalidation: () => {
          if (ownsStream()) showPrivate();
        },
        onStreamError: (message) => {
          if (ownsStream()) publish({ errorMessage: message, connection: 'disconnected' });
        },
        onDisconnect: () => {
          if (!ownsStream()) return;
          closeStream();
          publish({ connection: 'disconnected' });
          if (reconnectTimer) clearTimeout(reconnectTimer);
          reconnectTimer = setTimeout(() => { void reconnectNow(); }, RECONNECT_DELAY_MS);
        },
      });
      // A transport can invalidate/disconnect synchronously while opening.
      if (ownsStream()) stream = opened;
      else opened.close();
    };
    reconnectRef.current = { owner, run: () => { void reconnectNow(); } };

    void (async () => {
      try {
        const snapshot = await transport.snapshot(sessionId);
        if (!current()) return;
        const applied = applyCatchUp(snapshot);
        if (applied === 'private') return showPrivate();
        if (applied === 'gap') {
          const result = await resync();
          if (!current() || result === 'cancelled') return;
          if (result === 'private') return showPrivate();
        }
        publish({ loadState: 'ready' });
        if (replay) {
          for (let guard = 0; guard < 100; guard += 1) {
            const page = await transport.page(sessionId, reducer.cursor);
            if (!current()) return;
            const result = applyCatchUp(page);
            if (result === 'private') return showPrivate();
            if (result === 'gap' || page.kind !== 'page' || !page.page.has_more) break;
          }
          publish({ connection: 'disconnected' });
          return;
        }
        publish({ connection: 'live' });
        openStream();
      } catch (error) {
        publish({
          loadState: 'error',
          errorMessage: error instanceof Error ? error.message : 'The session record could not be loaded.',
        });
      }
    })();
    return () => {
      active = false;
      closeStream();
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (reconnectRef.current?.owner === owner) reconnectRef.current = null;
    };
  }, [owner, replay, sessionId, transport]);

  if (state?.owner !== owner) {
    return { loadState: 'loading', connection: 'connecting', projection: null,
      errorMessage: null, reconnect };
  }
  return { loadState: state.loadState, connection: state.connection,
    projection: state.projection, errorMessage: state.errorMessage, reconnect };
}
