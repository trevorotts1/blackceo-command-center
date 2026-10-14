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

import { useCallback, useEffect, useRef, useState } from 'react';
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

export function useCouncilLiveSession(
  sessionId: string,
  transport: CouncilSessionTransport,
  options: { replay?: boolean } = {},
): CouncilLiveSession {
  const replay = options.replay ?? false;
  const reducerRef = useRef<CouncilClientReducer | null>(null);
  const reducerSessionRef = useRef<string | null>(null);
  if (reducerRef.current === null || reducerSessionRef.current !== sessionId) {
    reducerRef.current = new CouncilClientReducer(sessionId);
    reducerSessionRef.current = sessionId;
  }
  const streamRef = useRef<{ close: () => void } | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const disposedRef = useRef(false);

  const [loadState, setLoadState] = useState<CouncilLoadState>('loading');
  const [connection, setConnection] = useState<CouncilConnectionState>('connecting');
  const [projection, setProjection] = useState<CouncilSessionProjection | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const syncProjection = useCallback(() => {
    const reducer = reducerRef.current;
    setProjection(reducer ? reducer.currentProjection : null);
  }, []);

  const closeStream = useCallback(() => {
    streamRef.current?.close();
    streamRef.current = null;
  }, []);

  const applyCatchUp = useCallback(
    (result: CouncilCatchUp): 'ok' | 'private' | 'gap' => {
      const reducer = reducerRef.current;
      if (!reducer) return 'ok';
      if (result.kind === 'invalidation') return 'private';
      if (result.kind === 'snapshot') {
        reducer.applySnapshot(result.snapshot);
        syncProjection();
        return 'ok';
      }
      const outcomes = reducer.applyPage(result.page.events);
      syncProjection();
      return outcomes.includes('gap') ? 'gap' : 'ok';
    },
    [syncProjection],
  );

  const resync = useCallback(async (): Promise<'ok' | 'private'> => {
    const reducer = reducerRef.current;
    if (!reducer) return 'ok';
    setConnection('resyncing');
    const page = await transport.page(sessionId, reducer.cursor);
    const pageResult = applyCatchUp(page);
    if (pageResult !== 'gap') return pageResult;
    const snapshot = await transport.snapshot(sessionId);
    const snapshotResult = applyCatchUp(snapshot);
    // A wholesale snapshot is authoritative: it cannot leave a gap.
    return snapshotResult === 'gap' ? 'ok' : snapshotResult;
  }, [applyCatchUp, sessionId, transport]);

  const openStream = useCallback(() => {
    const reducer = reducerRef.current;
    if (!reducer || replay) return;
    closeStream();
    streamRef.current = transport.openStream(sessionId, reducer.cursor, {
      onEvent: (event) => {
        const outcome = reducer.applyEvent(event);
        syncProjection();
        if (outcome === 'gap') {
          closeStream();
          void resync()
            .then((result) => {
              if (disposedRef.current) return;
              if (result === 'private') {
                setLoadState('private');
                return;
              }
              setConnection('live');
              openStream();
            })
            .catch(() => {
              if (!disposedRef.current) setConnection('disconnected');
            });
        }
      },
      onSnapshot: (snapshot) => {
        reducer.applySnapshot(snapshot);
        syncProjection();
      },
      onInvalidation: () => {
        closeStream();
        setLoadState('private');
      },
      onStreamError: (message) => {
        setErrorMessage(message);
        setConnection('disconnected');
      },
      onDisconnect: () => {
        if (disposedRef.current) return;
        setConnection('disconnected');
        if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = setTimeout(() => {
          void reconnectRef.current();
        }, RECONNECT_DELAY_MS);
      },
    });
  }, [closeStream, replay, resync, sessionId, syncProjection, transport]);

  const reconnect = useCallback(async () => {
    if (disposedRef.current) return;
    try {
      const result = await resync();
      if (disposedRef.current) return;
      if (result === 'private') {
        setLoadState('private');
        return;
      }
      setLoadState('ready');
      setConnection('live');
      setErrorMessage(null);
      openStream();
    } catch {
      if (!disposedRef.current) setConnection('disconnected');
    }
  }, [openStream, resync]);

  const reconnectRef = useRef(reconnect);
  reconnectRef.current = reconnect;

  useEffect(() => {
    disposedRef.current = false;
    let cancelled = false;
    (async () => {
      try {
        const snapshot = await transport.snapshot(sessionId);
        if (cancelled || disposedRef.current) return;
        const applied = applyCatchUp(snapshot);
        if (applied === 'private') {
          setLoadState('private');
          return;
        }
        if (applied === 'gap') {
          const result = await resync();
          if (cancelled || disposedRef.current) return;
          if (result === 'private') {
            setLoadState('private');
            return;
          }
        }
        setLoadState('ready');
        if (replay) {
          // Replay reads the committed record only; drain remaining
          // pages in order, then stop. No live stream is opened.
          const reducer = reducerRef.current;
          if (reducer) {
            for (let guard = 0; guard < 100; guard += 1) {
              const page = await transport.page(sessionId, reducer.cursor);
              if (cancelled || disposedRef.current) return;
              const result = applyCatchUp(page);
              if (result === 'private') {
                setLoadState('private');
                return;
              }
              if (result === 'gap') break;
              if (page.kind !== 'page' || !page.page.has_more) break;
            }
          }
          setConnection('disconnected');
          return;
        }
        setConnection('live');
        openStream();
      } catch (error) {
        if (cancelled || disposedRef.current) return;
        setLoadState('error');
        setErrorMessage(
          error instanceof Error
            ? error.message
            : 'The session record could not be loaded.',
        );
      }
    })();
    return () => {
      cancelled = true;
      disposedRef.current = true;
      closeStream();
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
    };
  }, [applyCatchUp, closeStream, openStream, replay, resync, sessionId, transport]);

  return { loadState, connection, projection, errorMessage, reconnect };
}
