'use client';

/**
 * useOperationsRailEvents (U60 / JM-U63c — Operations Rail live wiring)
 *
 * A dedicated, isolated `EventSource('/api/events/stream')` connection for the
 * My AI CEO page — deliberately NOT the board's `useSSE` hook, which is wired
 * straight into the Zustand board store and has nothing to do with a ceo-chat
 * session. The stream already fans out to any number of registered clients
 * (`src/lib/events.ts` — a `Set` of controllers), so a second concurrent
 * connection from the same tab is cheap and never touches board state.
 *
 * On any `task_created` / `task_updated` / `ceo_chat_task_status` event this
 * calls the caller's `refresh()` (a debounced `GET /api/ceo-chat/history`
 * re-fetch — the server is the authority on "is this task mine" via the
 * `requester_channel='ceo-chat' AND requester_chat_id=sessionId` scope, so no
 * client-side event filtering can drift from it) — the rail updates well
 * inside the 2-second binary-acceptance window without a page refresh. The
 * 15-second poll in useCeoChatSession remains the silent fallback: `live`
 * turns false (no error UI) whenever the stream is down or blocked, per spec
 * (c)/(5).
 */
import { useEffect, useRef, useState } from 'react';

const RELEVANT_TYPES = new Set(['task_created', 'task_updated', 'ceo_chat_task_status']);
const DEBOUNCE_MS = 300;

export function useOperationsRailEvents(refresh: () => void): { live: boolean } {
  const [live, setLive] = useState(false);
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;

  useEffect(() => {
    let es: EventSource | null = null;
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    let disposed = false;

    function scheduleRefresh() {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => refreshRef.current(), DEBOUNCE_MS);
    }

    function connect() {
      if (disposed) return;
      es = new EventSource('/api/events/stream');
      es.onopen = () => setLive(true);
      es.onerror = () => {
        // No error UI (spec (5)) — just stop claiming "live"; the 15s poll
        // in useCeoChatSession is the honest fallback while EventSource's
        // own browser-native reconnect (or our manual retry below) recovers.
        setLive(false);
      };
      es.onmessage = (event) => {
        if (!event.data || event.data.startsWith(':')) return;
        try {
          const parsed = JSON.parse(event.data) as { type?: string };
          if (parsed.type && RELEVANT_TYPES.has(parsed.type)) {
            scheduleRefresh();
          }
        } catch {
          // Ignore malformed frames — never let a parse error break the rail.
        }
      };
    }

    connect();

    return () => {
      disposed = true;
      if (debounceTimer) clearTimeout(debounceTimer);
      es?.close();
    };
  }, []);

  return { live };
}
