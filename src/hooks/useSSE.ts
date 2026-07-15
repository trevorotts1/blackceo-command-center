/**
 * useSSE Hook
 * Establishes and maintains Server-Sent Events connection for real-time updates
 */

'use client';

import { useEffect, useRef } from 'react';
import { useMissionControl } from '@/lib/store';
import { debug } from '@/lib/debug';
import type { SSEEvent, Task } from '@/lib/types';

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
  const eventSourceRef = useRef<EventSource | null>(null);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout>();
  // Use ref to track selectedTask ID without causing re-renders
  const selectedTaskIdRef = useRef<string | undefined>();
  // MSG-07: distinguishes the first connect (page already loaded a fresh
  // snapshot) from a genuine reconnect (deltas may have been missed while down).
  const hasConnectedRef = useRef(false);
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
  } = useMissionControl();

  // Update ref when selectedTask changes (outside the SSE effect)
  useEffect(() => {
    selectedTaskIdRef.current = selectedTask?.id;
  }, [selectedTask]);

  // Keep the onReconnect ref current without re-running the SSE effect.
  useEffect(() => {
    onReconnectRef.current = options?.onReconnect;
  }, [options?.onReconnect]);

  useEffect(() => {
    let isConnecting = false;

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
        const changed =
          fresh.length !== current.length ||
          fresh.some((t) => {
            const c = current.find((ct) => ct.id === t.id);
            return !c || c.status !== t.status;
          });
        if (changed) {
          debug.sse('Reconnect catch-up: board changed, reconciling store');
          useMissionControl.getState().setTasks(fresh);
        }
      } catch (error) {
        // Keep last-known state; the page's periodic poll remains the backstop.
        debug.sse('Reconnect catch-up refetch failed', error);
      }
    };

    const connect = () => {
      if (isConnecting || eventSourceRef.current?.readyState === EventSource.OPEN) {
        return;
      }

      isConnecting = true;
      debug.sse('Connecting to event stream...');

      const eventSource = new EventSource('/api/events/stream');
      eventSourceRef.current = eventSource;

      eventSource.onopen = () => {
        debug.sse('Connected');
        setIsFeedConnected(true);
        isConnecting = false;
        // Clear any pending reconnect
        if (reconnectTimeoutRef.current) {
          clearTimeout(reconnectTimeoutRef.current);
        }

        // MSG-07: catch up on any deltas missed while the stream was down. The
        // very first open needs no catch-up (the page's initial load already
        // fetched a fresh snapshot); only a genuine RE-open does. Prefer the
        // consumer-supplied scoped refetch, else the scope-safe global one.
        if (hasConnectedRef.current) {
          const onReconnect = onReconnectRef.current;
          if (onReconnect) {
            void onReconnect();
          } else {
            void catchUpBoardState();
          }
        }
        hasConnectedRef.current = true;
      };

      eventSource.onmessage = (event) => {
        try {
          // Skip keep-alive messages (they start with ":")
          if (event.data.startsWith(':')) {
            return;
          }

          const sseEvent: SSEEvent = JSON.parse(event.data);
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
                title: incomingTask.title
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

            case 'activity_logged':
              debug.sse('Activity logged', sseEvent.payload);
              // Activities are fetched when task detail is opened
              break;

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
        } catch (error) {
          console.error('[SSE] Error parsing event:', error);
        }
      };

      eventSource.onerror = (error) => {
        debug.sse('Connection error', error);
        isConnecting = false;

        // Close the connection
        eventSource.close();
        eventSourceRef.current = null;

        // Health check via fetch before showing offline (SSE can fail through Cloudflare even when API works)
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

        // Attempt reconnection after 10 seconds
        reconnectTimeoutRef.current = setTimeout(() => {
          debug.sse('Attempting to reconnect...');
          connect();
        }, 10000);
      };
    };

    // Initial connection
    connect();

    // Cleanup on unmount
    return () => {
      if (eventSourceRef.current) {
        debug.sse('Disconnecting...');
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
    };
  // selectedTask removed from deps to prevent re-connection loop
  // We use selectedTaskIdRef to check the current selected task ID without triggering re-renders
  }, [addTask, updateTask, removeTask, setIsFeedConnected, setSelectedTask]);
}
