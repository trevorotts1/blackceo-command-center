/**
 * useSSE Hook
 * Establishes and maintains Server-Sent Events connection for real-time updates
 */

'use client';

import { useCallback, useEffect, useRef } from 'react';
import { useMissionControl } from '@/lib/store';
import { debug } from '@/lib/debug';
import type { SSEEvent, Task } from '@/lib/types';

const INITIAL_RETRY_DELAY_MS = 1000;
const MAX_RETRY_DELAY_MS = 30000;

export function useSSE() {
  const eventSourceRef = useRef<EventSource | null>(null);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const selectedTaskIdRef = useRef<string | undefined>();
  const isMountedRef = useRef(false);
  const isConnectingRef = useRef(false);
  const retryDelayRef = useRef(INITIAL_RETRY_DELAY_MS);

  const {
    updateTask,
    addTask,
    setIsOnline,
    selectedTask,
    setSelectedTask,
  } = useMissionControl();

  useEffect(() => {
    selectedTaskIdRef.current = selectedTask?.id;
  }, [selectedTask]);

  const clearReconnectTimeout = useCallback(() => {
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }
  }, []);

  const cleanupConnection = useCallback(() => {
    clearReconnectTimeout();

    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }

    isConnectingRef.current = false;
  }, [clearReconnectTimeout]);

  const scheduleReconnect = useCallback((connect: () => void) => {
    if (!isMountedRef.current || reconnectTimeoutRef.current) {
      return;
    }

    const delay = retryDelayRef.current;
    retryDelayRef.current = Math.min(retryDelayRef.current * 2, MAX_RETRY_DELAY_MS);

    debug.sse(`Attempting reconnect in ${delay}ms`);

    reconnectTimeoutRef.current = setTimeout(() => {
      reconnectTimeoutRef.current = null;

      if (!isMountedRef.current) {
        return;
      }

      connect();
    }, delay);
  }, []);

  useEffect(() => {
    isMountedRef.current = true;

    const connect = () => {
      if (!isMountedRef.current) return;

      if (isConnectingRef.current) {
        debug.sse('Connection already in progress');
        return;
      }

      const readyState = eventSourceRef.current?.readyState;
      if (readyState === EventSource.OPEN || readyState === EventSource.CONNECTING) {
        return;
      }

      clearReconnectTimeout();
      isConnectingRef.current = true;
      debug.sse('Connecting to event stream...');

      const eventSource = new EventSource('/api/events/stream');
      eventSourceRef.current = eventSource;

      eventSource.onopen = () => {
        if (!isMountedRef.current) {
          eventSource.close();
          return;
        }

        debug.sse('Connected');
        setIsOnline(true);
        isConnectingRef.current = false;
        retryDelayRef.current = INITIAL_RETRY_DELAY_MS;
        clearReconnectTimeout();
      };

      eventSource.onmessage = (event) => {
        if (!isMountedRef.current) return;

        try {
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

            case 'task_updated': {
              const incomingTask = sseEvent.payload as Task;
              debug.sse('Task update received', {
                id: incomingTask.id,
                status: incomingTask.status,
                title: incomingTask.title,
              });
              updateTask(incomingTask);

              if (selectedTaskIdRef.current === incomingTask.id) {
                debug.sse('Also updating selectedTask for modal');
                setSelectedTask(incomingTask);
              }
              break;
            }

            case 'activity_logged':
              debug.sse('Activity logged', sseEvent.payload);
              break;

            case 'deliverable_added':
              debug.sse('Deliverable added', sseEvent.payload);
              break;

            case 'agent_spawned':
              debug.sse('Agent spawned', sseEvent.payload);
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
        isConnectingRef.current = false;

        eventSource.close();
        if (eventSourceRef.current === eventSource) {
          eventSourceRef.current = null;
        }

        fetch('/api/workspaces', { method: 'GET', cache: 'no-store' })
          .then((res) => {
            if (!isMountedRef.current) return;

            if (res.ok) {
              debug.sse('SSE failed but API is healthy - keeping online indicator on');
              setIsOnline(true);
            } else {
              setIsOnline(false);
            }
          })
          .catch(() => {
            if (!isMountedRef.current) return;

            debug.sse('Both SSE and health check failed - going offline');
            setIsOnline(false);
          })
          .finally(() => {
            scheduleReconnect(connect);
          });
      };
    };

    connect();

    return () => {
      isMountedRef.current = false;
      debug.sse('Disconnecting...');
      cleanupConnection();
    };
  }, [addTask, clearReconnectTimeout, cleanupConnection, scheduleReconnect, setIsOnline, setSelectedTask, updateTask]);
}
