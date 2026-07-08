/**
 * Server-Sent Events (SSE) broadcaster for real-time updates
 * Manages client connections and broadcasts events to all listeners
 *
 * SINGLE-PROCESS CONSTRAINT (MSG-05):
 *   The client registry below is an in-process `Set`. It lives in the memory of
 *   ONE Node process, so broadcast() can only reach clients whose SSE
 *   connection landed on THIS process. That is correct for the canonical
 *   deployment (ecosystem.config.cjs: `instances: 1, exec_mode: 'fork'`).
 *
 *   Under a PM2 CLUSTER (`exec_mode: 'cluster_mode'`, or `instances > 1`) each
 *   worker has its own Set. A task update mutated on worker A calls broadcast()
 *   on worker A only, so every client pinned to worker B silently never
 *   receives that delta — the board goes stale with no error. Scaling this box
 *   out therefore requires a shared fan-out bus (e.g. Redis pub/sub) instead of
 *   this in-memory Set. `warnIfClustered()` below logs a loud startup warning if
 *   it detects a multi-worker runtime so the misconfiguration is visible rather
 *   than silent. Keep the constraint documented HERE (not only in the PM2
 *   template) so it survives independent of the deploy config.
 */

import cluster from 'node:cluster';

import type { SSEEvent } from './types';

/**
 * MSG-05: warn once at process startup if this box appears to run more than one
 * worker, which the in-process SSE registry cannot support. `cluster.isWorker`
 * is the definitive signal for PM2 cluster_mode (which forks via Node's cluster
 * module); the env hints cover other multi-instance managers. Latent no-op on
 * the canonical single fork instance.
 */
function warnIfClustered(): void {
  const appInstance = process.env.NODE_APP_INSTANCE;
  const execMode = process.env.exec_mode || process.env.pm_exec_mode;
  const isWorker = cluster.isWorker === true;
  const multiInstance =
    typeof appInstance === 'string' && appInstance !== '' && appInstance !== '0';

  if (isWorker || execMode === 'cluster_mode' || multiInstance) {
    console.warn(
      '[SSE] WARNING: this process looks like a clustered / multi-worker runtime ' +
        `(cluster.isWorker=${isWorker}, exec_mode=${execMode ?? 'n/a'}, ` +
        `NODE_APP_INSTANCE=${appInstance ?? 'n/a'}). The SSE client registry is an ` +
        'in-process Set and is NOT shared across workers: broadcasts only reach ' +
        'clients connected to the emitting worker, so real-time board updates will ' +
        'be dropped for clients on other workers. Run the Command Center as a SINGLE ' +
        "instance (ecosystem.config.cjs: instances: 1, exec_mode: 'fork') or move SSE " +
        'fan-out to a shared bus (e.g. Redis pub/sub) before scaling out.'
    );
  }
}

warnIfClustered();

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
