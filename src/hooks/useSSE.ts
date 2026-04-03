/**
 * useSSE Hook
 * Establishes and maintains Server-Sent Events connection for real-time updates
 * Includes exponential backoff, max retry limit, and proper cleanup
 */

'use client';

import { useEffect, useRef, useCallback } from 'react';
import { useMissionControl } from '@/lib/store';
import { debug } from '@/lib/debug';
import type { SSEEvent, Task } from '@/lib/types';

// Exponential backoff configuration
const INITIAL_RETRY_DELAY = 1000; // Start with 1 second
const MAX_RETRY_DELAY = 30000; // Cap at 30 seconds
const RETRY_MULTIPLIER = 2; // Double the delay each retry

export function useSSE() {
  const eventSourceRef = useRef<EventSource | null>(null);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const retryDelayRef = useRef<number>(INITIAL_RETRY_DELAY);
  const reconnectAttemptsRef = useRef<number>(0);
  const isMountedRef = useRef<boolean>(true);
  const isConnectingRef = useRef<boolean>(false);
  
  // Use ref to track selectedTask ID without causing re-renders
  const selectedTaskIdRef = useRef<string | undefined>();
  
  const {
    updateTask,
    addTask,
    setIsOnline,
    selectedTask,
    setSelectedTask,
  } = useMissionControl();

  // Update ref when selectedTask changes (outside the SSE effect)
  useEffect(() => {
    selectedTaskIdRef.current = selectedTask?.id;
  }, [selectedTask]);

  // Reset retry delay on successful connection
  const resetRetryDelay = useCallback(() => {
    retryDelayRef.current = INITIAL_RETRY_DELAY;
    reconnectAttemptsRef.current = 0;
  }, []);

  // Calculate next retry delay with exponential backoff
  const getNextRetryDelay = useCallback(() => {
    const delay = retryDelayRef.current;
    retryDelayRef.current = Math.min(
      delay * RETRY_MULTIPLIER,
      MAX_RETRY_DELAY
    );
    reconnectAttemptsRef.current += 1;
    return delay;
  }, []);

  // Clear any pending reconnection timeout
  const clearReconnectTimeout = useCallback(() => {
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }
  }, []);

  // Close and cleanup the EventSource
  const cleanupConnection = useCallback(() => {
    clearReconnectTimeout();
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
    isConnectingRef.current = false;
  }, [clearReconnectTimeout]);

  useEffect(() => {
    isMountedRef.current = true;

    const connect = () => {
      // Prevent multiple simultaneous connection attempts
      if (isConnectingRef.current) {
        debug.sse('Connection already in progress, skipping');
        return;
      }

      // Don't connect if already connected
      if (eventSourceRef.current?.readyState === EventSource.OPEN) {
        debug.sse('Already connected, skipping');
        return;
      }

      // Check if component is still mounted
      if (!isMountedRef.current) {
        debug.sse('Component unmounted, aborting connection');
        return;
      }

      isConnectingRef.current = true;
      debug.sse(`Connecting to event stream... (attempt ${reconnectAttemptsRef.current + 1})`);

      try {
        const eventSource = new EventSource('/api/events/stream');
        eventSourceRef.current = eventSource;

        eventSource.onopen = () => {
          // Check if still mounted before updating state
          if (!isMountedRef.current) {
            eventSource.close();
            return;
          }

          debug.sse('Connected successfully');
          setIsOnline(true);
          isConnectingRef.current = false;
          resetRetryDelay();
          clearReconnectTimeout();
        };

        eventSource.onmessage = (event) => {
          // Check if still mounted
          if (!isMountedRef.current) return;

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
          // Check if still mounted
          if (!isMountedRef.current) {
            cleanupConnection();
            return;
          }

          debug.sse('Connection error', error);
          isConnectingRef.current = false;

          // Close the connection
          eventSource.close();
          eventSourceRef.current = null;

          // Health check via fetch before showing offline (SSE can fail through Cloudflare even when API works)
          fetch('/api/workspaces', { method: 'GET', cache: 'no-store' })
            .then((res) => {
              if (!isMountedRef.current) return;
              
              if (res.ok) {
                debug.sse('SSE failed but API is healthy - staying online');
                setIsOnline(true);
              } else {
                setIsOnline(false);
              }
            })
            .catch(() => {
              if (!isMountedRef.current) return;
              debug.sse('Both SSE and health check failed - going offline');
              setIsOnline(false);
            });

          // Schedule reconnection with exponential backoff
          const delay = getNextRetryDelay();
          debug.sse(`Reconnecting in ${delay}ms...`);
          
          reconnectTimeoutRef.current = setTimeout(() => {
            if (isMountedRef.current) {
              connect();
            }
          }, delay);
        };
      } catch (error) {
        console.error('[SSE] Error creating EventSource:', error);
        isConnectingRef.current = false;
        
        // Schedule reconnection on error
        const delay = getNextRetryDelay();
        reconnectTimeoutRef.current = setTimeout(() => {
          if (isMountedRef.current) {
            connect();
          }
        }, delay);
      }
    };

    // Initial connection
    connect();

    // Cleanup on unmount
    return () => {
      debug.sse('Component unmounting, cleaning up SSE connection...');
      isMountedRef.current = false;
      cleanupConnection();
    };
  // selectedTask removed from deps to prevent re-connection loop
  // We use selectedTaskIdRef to check the current selected task ID without triggering re-renders
  }, [addTask, updateTask, setIsOnline, setSelectedTask, resetRetryDelay, getNextRetryDelay, clearReconnectTimeout, cleanupConnection]);

  // Return connection info for potential UI use
  return {
    isConnected: eventSourceRef.current?.readyState === EventSource.OPEN,
    reconnectAttempts: reconnectAttemptsRef.current,
  };
}
