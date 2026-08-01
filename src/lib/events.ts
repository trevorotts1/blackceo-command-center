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
 *
 *   BLIND SPOT — what warnIfClustered() CANNOT see (U066):
 *   The warning reads only THIS process's env. N independent PM2 *fork* apps
 *   sharing one working directory each see a single-instance env, so NONE of
 *   them warns — yet each holds its own `clients` Set, so a mutation served by
 *   one never reaches a browser connected to another. Same stale board as a
 *   cluster, with no warning at all. No env var distinguishes "I am the only
 *   Command Center process here" from "I am one of three"; deciding it needs
 *   evidence from OUTSIDE the process (a lock file, a registry, a port probe),
 *   and adding filesystem work at import scope to this module is the same
 *   mistake that broke the Next build once already (see the note below about
 *   node:cluster). So the detection lives at COMMIT time instead:
 *   scripts/pm2-single-instance-guard.mjs resolves every PM2 app in the repo at
 *   once and hard-fails two Command Center apps that share a DATABASE_PATH —
 *   which is the invariant, not `instances: 1`, that keeps these registries
 *   from disagreeing. Closing it at RUNTIME is deliberately NOT done here.
 */

import type { SSEEvent } from './types';

/**
 * MSG-05: warn once at process startup if this box appears to run more than one
 * worker, which the in-process SSE registry cannot support. Detection is via
 * PM2 env hints only (NOT the `node:cluster` module — importing it breaks the
 * Next webpack build because events.ts is bundled through the jobs scheduler):
 *   - `exec_mode === 'cluster_mode'` — PM2 cluster mode, catches every worker.
 *   - `NODE_APP_INSTANCE` not unset/'0' — a 2nd+ instance, definitively
 *     multi-worker. '0' is intentionally NOT flagged so the canonical single
 *     fork instance (which PM2 sets to '0') stays a silent no-op.
 */
export function warnIfClustered(env: NodeJS.ProcessEnv = process.env): void {
  const appInstance = env.NODE_APP_INSTANCE;
  const execMode = env.exec_mode || env.pm_exec_mode;
  const multiInstance =
    typeof appInstance === 'string' && appInstance !== '' && appInstance !== '0';

  if (execMode === 'cluster_mode' || multiInstance) {
    console.warn(
      '[SSE] WARNING: this process looks like a clustered / multi-worker runtime ' +
        `(exec_mode=${execMode ?? 'n/a'}, ` +
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
 * MR-10 — dual-write an event into the shared SQLite fan-out journal so
 * every SSE stream route (across ALL processes sharing the database) can
 * discover cross-process events during its poll loop. Best-effort only: a
 * journal-write failure MUST NOT interrupt the in-memory broadcast or throw
 * through to the mutation's caller. The in-memory path handles same-process
 * clients; the journal catches the rest on the next poll tick.
 */
function journalEvent(event: SSEEvent): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { getDb } = require('@/lib/db') as typeof import('@/lib/db');
    const db = getDb();
    db.prepare(
      `INSERT INTO sse_event_log (event_type, payload) VALUES (?, ?)`,
    ).run(event.type, JSON.stringify(event));
  } catch {
    // Journal write is best-effort — the in-memory broadcast already
    // covers same-process clients, and the polling backstop self-heals.
  }
}

/**
 * Broadcast an event to all connected SSE clients, AND journal it to the
 * shared SQLite fan-out bus so cross-process clients see it on their next
 * poll tick.
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

  // MR-10: dual-write to the shared SQLite journal so clients pinned to
  // OTHER processes discover this event during their poll loop.
  journalEvent(event);

  console.log(`[SSE] Broadcast ${event.type} to ${clients.size} client(s)`);
}

/**
 * Get the number of active SSE connections
 */
export function getActiveConnectionCount(): number {
  return clients.size;
}
