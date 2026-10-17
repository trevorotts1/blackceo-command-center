/**
 * The council session event stream (CWE-030, directive Sections
 * 18.1-18.4).
 *
 * One stream serves one authorized session subscription. It opens
 * with the reconnect catch-up (an exact gapless page, or a snapshot
 * when the cursor is unusable), then follows the durable journal:
 * a short poll reads newly committed events for THIS session under
 * the subscription's authorized envelope and forwards them in
 * sequence. The journal is the shared durable record, so a stream
 * served by any process sees the same committed history; there is
 * no in-memory broadcast state to disagree with it, and no council
 * byte ever travels the host's company-keyed, five-minute-journal
 * SSE path.
 *
 * Truthful activity only: frames are committed journal events, the
 * resync snapshot, the private-session invalidation signal, and SSE
 * comment heartbeats. The stream never emits a "thinking" frame, a
 * typing indicator, or a progress guess (Section 18.4, T070).
 */

import { CouncilEventDelivery, type CouncilEventAccess } from './delivery';
import type {
  CouncilInvalidationSignal,
  CouncilResyncSnapshot,
  CouncilWireEvent,
} from './types';

const encoder = new TextEncoder();

export function formatEventFrame(event: CouncilWireEvent): string {
  return `id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

export function formatSnapshotFrame(snapshot: CouncilResyncSnapshot): string {
  return `event: council.snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`;
}

export function formatSignalFrame(signal: CouncilInvalidationSignal): string {
  return `event: council.session.invalidated\ndata: ${JSON.stringify(signal)}\n\n`;
}

export interface CouncilStreamOptions {
  /** Journal poll interval for newly committed events. */
  pollMs?: number;
  /** SSE comment heartbeat interval. */
  heartbeatMs?: number;
}

/**
 * Create the live stream for one authorized session access. The
 * caller (the route) has already resolved the principal and the
 * CWE-007 session read decision; this function serves exactly that
 * access and nothing wider. Pass the request's AbortSignal so a
 * disconnect tears the poll down immediately.
 */
export function createCouncilEventStream(
  deps: {
    delivery: CouncilEventDelivery;
    access: CouncilEventAccess;
    afterSequence: number;
    signal?: AbortSignal;
  },
  options: CouncilStreamOptions = {},
): ReadableStream<Uint8Array> {
  const pollMs = options.pollMs ?? 500;
  const heartbeatMs = options.heartbeatMs ?? 25_000;
  const { delivery, access } = deps;
  let lastSentSequence = Math.max(0, Math.floor(deps.afterSequence));
  let lastSignalVersion = -1;
  let lastSignalSequence = -1;
  let closed = false;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let controllerRef: ReadableStreamDefaultController<Uint8Array> | null = null;

  const cleanup = () => {
    if (pollTimer) clearInterval(pollTimer);
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    pollTimer = null;
    heartbeatTimer = null;
  };

  const send = (text: string): boolean => {
    if (closed || !controllerRef) return false;
    try {
      controllerRef.enqueue(encoder.encode(text));
      return true;
    } catch {
      closed = true;
      cleanup();
      return false;
    }
  };

  const poll = () => {
    if (closed) return;
    try {
      const result = delivery.page(access, lastSentSequence);
      if (result.kind === 'events') {
        for (const event of result.events) {
          if (!send(formatEventFrame(event))) return;
          lastSentSequence = event.sequence;
        }
      } else {
        const { signal } = result;
        if (
          signal.state_version !== lastSignalVersion ||
          signal.last_sequence !== lastSignalSequence
        ) {
          lastSignalVersion = signal.state_version;
          lastSignalSequence = signal.last_sequence;
          send(formatSignalFrame(signal));
        }
      }
    } catch {
      // A poll failure is non-fatal: the journal is durable and the
      // next tick retries from the same cursor. The stream never
      // fabricates a frame to cover a read failure.
    }
  };

  return new ReadableStream<Uint8Array>({
    start(controller) {
      controllerRef = controller;
      send(': council-events connected\n\n');
      try {
        const catchUp = delivery.catchUp(access, lastSentSequence);
        if (catchUp.kind === 'page') {
          for (const event of catchUp.page.events) {
            if (!send(formatEventFrame(event))) break;
            lastSentSequence = event.sequence;
          }
        } else if (catchUp.kind === 'snapshot') {
          send(formatSnapshotFrame(catchUp.snapshot));
          lastSentSequence = catchUp.snapshot.last_sequence;
        } else {
          lastSignalVersion = catchUp.signal.state_version;
          lastSignalSequence = catchUp.signal.last_sequence;
          send(formatSignalFrame(catchUp.signal));
        }
      } catch {
        send(
          `event: council.stream_error\ndata: ${JSON.stringify({
            code: 'EVENT_STREAM_UNAVAILABLE',
            message: 'The committed event history could not be read. Reconnect to retry from your cursor.',
          })}\n\n`,
        );
      }
      pollTimer = setInterval(poll, pollMs);
      heartbeatTimer = setInterval(() => {
        if (!send(': keep-alive\n\n')) cleanup();
      }, heartbeatMs);
      if (deps.signal) {
        if (deps.signal.aborted) {
          cleanup();
          closed = true;
          try {
            controller.close();
          } catch {
            // Already closed.
          }
        } else {
          deps.signal.addEventListener(
            'abort',
            () => {
              cleanup();
              closed = true;
              try {
                controller.close();
              } catch {
                // Already closed.
              }
            },
            { once: true },
          );
        }
      }
    },
    cancel() {
      closed = true;
      cleanup();
    },
  });
}
