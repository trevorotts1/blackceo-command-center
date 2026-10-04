/**
 * useSSE Hook
 * Establishes and maintains Server-Sent Events connection for real-time updates
 *
 * ONE STREAM OWNER (HQ unit B21, SPEC S8.6):
 *   Every `EventSource` in the app is constructed by `acquireEventStream` below.
 *   A URL therefore has AT MOST ONE open socket no matter how many consumers
 *   want it (the board hook and the Headquarters state hook share the same
 *   `/api/events/stream` connection instead of opening one each). Consumers
 *   attach ref-counted listeners and release them on unmount; when the last
 *   listener releases, the socket closes and its reconnect timer is cleared, so
 *   listener and active-request counts return to baseline across repeated
 *   mount/unmount/reconnect cycles (SPEC S11: "no monotonically growing
 *   listener/request count after 20 toggles/reconnects").
 */

'use client';

import { useEffect, useRef } from 'react';
import { useMissionControl } from '@/lib/store';
import { debug } from '@/lib/debug';
import { boardStateDisagrees } from '@/lib/board/a41-row-fields';
import type { SSEEvent, Task } from '@/lib/types';

/* ================================================================== *
 * Shared, ref-counted stream registry — the single EventSource owner
 * ================================================================== */

export type SseListener = (event: SSEEvent) => void;

export interface SseStreamHandlers {
  /**
   * Fired on every successful open. `reopened` is false only for the first open
   * of this stream, so a consumer can tell a genuine re-open (deltas may have
   * been missed) from the first connect (its caller already loaded a snapshot).
   */
  onOpen?: (info: { reopened: boolean }) => void;
  /** Fired when the socket errors. The registry owns the retry, not the caller. */
  onError?: () => void;
}

interface SharedSseStream {
  url: string;
  source: EventSource | null;
  listeners: Set<SseListener>;
  handlers: Map<SseListener, SseStreamHandlers>;
  /** True once this stream has opened successfully at least once. */
  hasOpened: boolean;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
}

/** Same retry delay the board stream used before the registry existed. */
export const SSE_RECONNECT_DELAY_MS = 10_000;

const sharedStreams = new Map<string, SharedSseStream>();

function scheduleReconnect(stream: SharedSseStream): void {
  if (stream.reconnectTimer || stream.listeners.size === 0) return;
  stream.reconnectTimer = setTimeout(() => {
    stream.reconnectTimer = null;
    openStream(stream);
  }, SSE_RECONNECT_DELAY_MS);
}

function openStream(stream: SharedSseStream): void {
  if (typeof EventSource === 'undefined') return; // SSR / no transport: stay inert
  if (stream.source) return;

  const source = new EventSource(stream.url);
  stream.source = source;

  source.onopen = () => {
    const reopened = stream.hasOpened;
    stream.hasOpened = true;
    debug.sse(reopened ? 'Reconnected (shared stream)' : 'Connected (shared stream)');
    for (const handlers of Array.from(stream.handlers.values())) {
      try {
        handlers.onOpen?.({ reopened });
      } catch (error) {
        debug.sse('onOpen handler threw', error);
      }
    }
  };

  source.onmessage = (event) => {
    // Keep-alive comment frames start with ':' and carry no payload.
    if (typeof event.data === 'string' && event.data.startsWith(':')) return;

    let parsed: SSEEvent;
    try {
      parsed = JSON.parse(event.data) as SSEEvent;
    } catch (error) {
      console.error('[SSE] Error parsing event:', error);
      return;
    }

    for (const listener of Array.from(stream.listeners)) {
      try {
        listener(parsed);
      } catch (error) {
        // One consumer's failure must never starve the others on a shared socket.
        debug.sse('SSE listener threw', error);
      }
    }
  };

  source.onerror = (error) => {
    debug.sse('Connection error', error);
    source.close();
    if (stream.source === source) stream.source = null;

    for (const handlers of Array.from(stream.handlers.values())) {
      try {
        handlers.onError?.();
      } catch (handlerError) {
        debug.sse('onError handler threw', handlerError);
      }
    }

    scheduleReconnect(stream);
  };
}

/**
 * Attach a listener to the shared stream for `url`, opening it if it is the
 * first consumer. Returns the release function; the caller MUST return it from
 * its effect so the socket's ref count returns to baseline on unmount.
 */
export function acquireEventStream(
  url: string,
  listener: SseListener,
  handlers: SseStreamHandlers = {},
): () => void {
  let stream = sharedStreams.get(url);
  if (!stream) {
    stream = {
      url,
      source: null,
      listeners: new Set(),
      handlers: new Map(),
      hasOpened: false,
      reconnectTimer: null,
    };
    sharedStreams.set(url, stream);
  }

  stream.listeners.add(listener);
  stream.handlers.set(listener, handlers);

  if (stream.reconnectTimer) {
    clearTimeout(stream.reconnectTimer);
    stream.reconnectTimer = null;
  }
  if (!stream.source) openStream(stream);

  let released = false;
  return () => {
    if (released) return;
    released = true;

    const current = sharedStreams.get(url);
    if (!current) return;
    current.listeners.delete(listener);
    current.handlers.delete(listener);

    if (current.listeners.size === 0) {
      if (current.reconnectTimer) {
        clearTimeout(current.reconnectTimer);
        current.reconnectTimer = null;
      }
      current.source?.close();
      current.source = null;
      sharedStreams.delete(url);
    }
  };
}

/** Diagnostics + cleanup proof: how many distinct URLs currently hold a socket. */
export function activeSseStreamCount(): number {
  return sharedStreams.size;
}

/** Diagnostics + cleanup proof: attached listener count for one stream URL. */
export function sseListenerCount(url: string): number {
  return sharedStreams.get(url)?.listeners.size ?? 0;
}

interface UseSSEOptions {
  /**
   * MSG-07: invoked on every genuine SSE RE-open (not the first connect) so the
   * consumer can refetch board state that changed while the stream was down.
   * A department-scoped page should pass its own workspace_id-scoped refetch
   * here; when omitted, useSSE falls back to a scope-safe global refetch.
   */
  onReconnect?: () => void | Promise<void>;
}

export function useSSE(options?: UseSSEOptions) {
  // Use ref to track selectedTask ID without causing re-renders
  const selectedTaskIdRef = useRef<string | undefined>(undefined);
  // Keep the latest onReconnect callback in a ref so the SSE effect stays
  // mount-stable (mirrors the selectedTaskIdRef pattern) instead of tearing the
  // stream down whenever the consumer passes a new inline callback.
  const onReconnectRef = useRef<UseSSEOptions['onReconnect']>(options?.onReconnect);
  const {
    updateTask,
    addTask,
    removeTask,
    setIsFeedConnected,
    selectedTask,
    setSelectedTask,
    incrementActivityPulse,
  } = useMissionControl();
  // PRES-021 — read live (getState) inside the event handler so the effect's
  // dep array stays mount-stable; subscribing would tear the stream down on
  // every activity event.

  // Update ref when selectedTask changes (outside the SSE effect)
  useEffect(() => {
    selectedTaskIdRef.current = selectedTask?.id;
  }, [selectedTask]);

  // Keep the onReconnect ref current without re-running the SSE effect.
  useEffect(() => {
    onReconnectRef.current = options?.onReconnect;
  }, [options?.onReconnect]);

  useEffect(() => {
    // MSG-07: on reconnect, reconcile the whole board so the UI can't sit stale
    // (waiting up to the 60s fallback poll) on deltas that fired while the
    // stream was down. Only the UNSCOPED board can be blanket-refetched here: a
    // department-scoped page fetches /api/tasks?workspace_id=…, so replacing its
    // list with ALL tasks would leak cross-department cards. Scoped pages should
    // pass an onReconnect callback with their scoped refetch instead.
    const catchUpBoardState = async () => {
      try {
        if (useMissionControl.getState().selectedDepartment !== null) return;
        const res = await fetch('/api/tasks', { cache: 'no-store' });
        if (!res.ok) return;
        const fresh: Task[] = await res.json();
        const current = useMissionControl.getState().tasks;
        // A41 — the changed-check lives in src/lib/board/a41-row-fields.ts and
        // is shared with the department-scoped catch-up in
        // src/app/workspace/[slug]/page.tsx. It reconciles on ANY A41 field
        // difference (provider provenance, mismatch, hold, plan, scope,
        // preparation/execution state), not only on status/updated_at: a
        // mismatch or hold that lands without a tasks write previously sat on
        // screen as stale truth until the 60s fallback poll.
        const changed = boardStateDisagrees(fresh, current);
        if (changed) {
          debug.sse('Reconnect catch-up: board changed, reconciling store');
          useMissionControl.getState().setTasks(fresh);
        }
      } catch (error) {
        // Keep last-known state; the page's periodic poll remains the backstop.
        debug.sse('Reconnect catch-up refetch failed', error);
      }
    };

    const handleEvent = (sseEvent: SSEEvent) => {
      debug.sse(`Received event: ${sseEvent.type}`, sseEvent.payload);

      switch (sseEvent.type) {
        case 'task_created':
          debug.sse('Adding new task to store', { id: (sseEvent.payload as Task).id });
          addTask(sseEvent.payload as Task);
          break;

        case 'task_updated':
          const incomingTask = sseEvent.payload as Task;
          debug.sse('Task update received', {
            id: incomingTask.id,
            status: incomingTask.status,
            title: incomingTask.title,
          });
          updateTask(incomingTask);

          // Update selected task if viewing this task (for modal)
          // Use ref to avoid dependency on selectedTask
          if (selectedTaskIdRef.current === incomingTask.id) {
            debug.sse('Also updating selectedTask for modal');
            setSelectedTask(incomingTask);
          }
          break;

        case 'task_deleted':
          // Broadcast by DELETE /api/tasks/[id] as { id }. Without this case
          // a deletion made elsewhere never disappeared from an open board
          // until the next full page load/refetch.
          debug.sse('Task deleted', sseEvent.payload);
          removeTask((sseEvent.payload as { id: string }).id);
          break;

        case 'activity_logged': {
          debug.sse('Activity logged', sseEvent.payload);
          // U060 — store the pulse so mounted PhaseStepper components
          // can react without a second real-time channel.
          incrementActivityPulse();
          // PRES-021 — stamp the task/run scope of this event so parent
          // cards and steppers refresh ONLY the affected card (debounced,
          // coalesced) instead of every mounted instance fetching per
          // event. Never throws: a malformed payload still pulses.
          try {
            const p = sseEvent.payload as {
              task_id?: unknown;
              metadata?: unknown;
            };
            const taskId = typeof p?.task_id === 'string' ? p.task_id : null;
            let runId: string | null = null;
            let attemptId: string | null = null;
            const md = p?.metadata;
            let obj: unknown = md;
            if (typeof md === 'string') {
              try { obj = JSON.parse(md); } catch { obj = null; }
            }
            if (typeof obj === 'object' && obj !== null) {
              const rec = obj as Record<string, unknown>;
              if (typeof rec.run_id === 'string' && rec.run_id.length > 0) runId = rec.run_id;
              const att = rec.attempt_id;
              if (typeof att === 'string' && att.length > 0) attemptId = att;
              else if (typeof att === 'number' && Number.isFinite(att)) attemptId = String(att);
            }
            useMissionControl.getState().noteActivityScope({ taskId, runId, attemptId });
          } catch {
            /* malformed payload: pulse already recorded, scope stays stale */
          }
          break;
        }

        case 'deliverable_added':
          debug.sse('Deliverable added', sseEvent.payload);
          // Deliverables are fetched when task detail is opened
          break;

        case 'agent_spawned':
          debug.sse('Agent spawned', sseEvent.payload);
          // Will trigger re-fetch of sub-agent count
          break;

        case 'agent_completed':
          debug.sse('Agent completed', sseEvent.payload);
          break;

        default:
          debug.sse('Unknown event type', sseEvent);
      }
    };

    // The registry owns connect, retry and close. This hook only attaches a
    // listener and returns the release — so both the board page and the HQ
    // surface share one socket instead of racing two.
    return acquireEventStream('/api/events/stream', handleEvent, {
      onOpen: ({ reopened }) => {
        setIsFeedConnected(true);

        // MSG-07: catch up on any deltas missed while the stream was down. The
        // very first open needs no catch-up (the page's initial load already
        // fetched a fresh snapshot); only a genuine RE-open does. Prefer the
        // consumer-supplied scoped refetch, else the scope-safe global one.
        if (!reopened) return;
        const onReconnect = onReconnectRef.current;
        if (onReconnect) {
          void onReconnect();
        } else {
          void catchUpBoardState();
        }
      },
      onError: () => {
        // Health check via fetch before showing offline (SSE can fail through
        // Cloudflare even when API works).
        fetch('/api/workspaces', { method: 'GET', cache: 'no-store' })
          .then((res) => {
            if (res.ok) {
              debug.sse('SSE failed but API is healthy - staying online');
              setIsFeedConnected(true);
            } else {
              setIsFeedConnected(false);
            }
          })
          .catch(() => {
            debug.sse('Both SSE and health check failed - going offline');
            setIsFeedConnected(false);
          });
      },
    });
  // selectedTask removed from deps to prevent re-connection loop
  // We use selectedTaskIdRef to check the current selected task ID without triggering re-renders
  }, [addTask, updateTask, removeTask, setIsFeedConnected, setSelectedTask]);
}
