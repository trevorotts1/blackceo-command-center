/**
 * Server-Sent Events (SSE) broadcaster for real-time updates
 * Manages client connections and broadcasts events to all listeners
 */

import type { SSEEvent } from './types';

// Store active SSE client connections
const clients = new Set<ReadableStreamDefaultController>();

// MSG-08: a consumer whose stream queue is persistently full (a slow client,
// or a dead TCP socket that has not yet surfaced an enqueue error) must not
// make the server buffer event data without bound. We track consecutive
// backpressure "strikes" per controller; after MAX_BACKPRESSURE_STRIKES in a
// row the consumer is dropped. A WeakMap keys off the controller so entries GC
// automatically once a controller is gone.
const MAX_BACKPRESSURE_STRIKES = 5;
const backpressureStrikes = new WeakMap<ReadableStreamDefaultController, number>();

/**
 * Register a new SSE client connection
 */
export function registerClient(controller: ReadableStreamDefaultController): void {
  clients.add(controller);
}

/**
 * Unregister an SSE client connection
 */
export function unregisterClient(controller: ReadableStreamDefaultController): void {
  clients.delete(controller);
  backpressureStrikes.delete(controller);
}

/**
 * Remove a client from the registry and close its stream. Used when a
 * controller is broken or persistently backed up; closing ends the response so
 * the browser's EventSource fires `onerror` and reconnects — at which point
 * useSSE's onopen catch-up (MSG-07) reconciles any missed deltas.
 */
function dropClient(controller: ReadableStreamDefaultController): void {
  clients.delete(controller);
  backpressureStrikes.delete(controller);
  try {
    controller.close();
  } catch {
    // Controller may already be closed/errored — nothing to do.
  }
}

/**
 * Broadcast an event to all connected SSE clients
 */
export function broadcast(event: SSEEvent): void {
  const encoder = new TextEncoder();
  const data = `data: ${JSON.stringify(event)}\n\n`;
  const encoded = encoder.encode(data);

  // Send to all connected clients
  const clientsArray = Array.from(clients);
  for (const client of clientsArray) {
    // MSG-08: honour stream backpressure before enqueuing. `desiredSize` is the
    // consumer's remaining high-water-mark budget: `null` once the stream is
    // errored/closed, and `<= 0` when the consumer is not draining. Blindly
    // enqueuing in either case grows an unbounded in-memory buffer.
    const desired = client.desiredSize;

    if (desired === null) {
      // Stream is already broken — prune immediately.
      dropClient(client);
      continue;
    }

    if (desired <= 0) {
      // Backed up this round: coalesce (skip this delta for this consumer) and
      // count a strike. A missed delta self-heals on the client's next
      // reconnect via useSSE's catch-up refetch (MSG-07). A consumer that stays
      // backed up past the strike budget is dropped so it reconnects fresh.
      const strikes = (backpressureStrikes.get(client) ?? 0) + 1;
      if (strikes >= MAX_BACKPRESSURE_STRIKES) {
        console.error(
          `[SSE] Dropping persistently backed-up client after ${strikes} backpressure strikes`
        );
        dropClient(client);
      } else {
        backpressureStrikes.set(client, strikes);
      }
      continue;
    }

    try {
      client.enqueue(encoded);
      // Healthy again — reset the strike counter.
      backpressureStrikes.delete(client);
    } catch (error) {
      // Client disconnected, remove it
      console.error('Failed to send SSE event to client:', error);
      dropClient(client);
    }
  }

  console.log(`[SSE] Broadcast ${event.type} to ${clients.size} client(s)`);
}

/**
 * Get the number of active SSE connections
 */
export function getActiveConnectionCount(): number {
  return clients.size;
}
