/**
 * Server-Sent Events (SSE) endpoint for real-time updates
 * Clients connect to this endpoint and receive live event broadcasts
 *
 * MULTI-PROCESS FAN-OUT (MR-10):
 *   The in-memory client registry in src/lib/events.ts only reaches clients
 *   connected to THIS Node process. For deployments where multiple Command
 *   Center processes share one database (N independent PM2 fork apps, or
 *   horizontally scaled boxes), this route ALSO polls the shared
 *   sse_event_log table every 500 ms for events written by OTHER processes.
 *
 *   Same-process events arrive via the push-based broadcast() → controller
 *   path and are delivered immediately (no polling overhead). Cross-process
 *   events arrive on the next poll tick at worst ~500 ms late — a deliberate
 *   trade-off that avoids a Redis dependency. The client cursor tracks the
 *   max event-id seen so each connection only receives events it has not
 *   yet consumed. The poll loop is a SINGLE setInterval shared by one
 *   connection; it stops when the client disconnects or the keep-alive fails.
 */

import { NextRequest, NextResponse } from 'next/server';
import {
  registerClient,
  unregisterClient,
  enqueueWithBackpressure,
  connectionMayReceive,
  SSE_PROCESS_ORIGIN,
} from '@/lib/events';
import {
  resolveStreamCompany,
  TenantAccessError,
} from '@/lib/social/company-context';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** MR-10: how often (ms) to poll the shared SQLite journal for cross-process events. */
const CROSS_PROCESS_POLL_MS = 500;

/** MR-10: max age (ms) of journal rows we consider. Rows older than this are only
 *  cleaned up periodically; the poll query already starts from the client cursor. */
const JOURNAL_MAX_AGE_MS = 5 * 60 * 1000;

/** MR-10: clean up expired journal rows every N poll ticks. */
const CLEANUP_EVERY_N_TICKS = 12; // every 6 s at 500 ms poll

interface JournalRow {
  id: number;
  origin: string;
  event_type: string;
  payload: string;
}

export async function GET(request: NextRequest) {
  // W3QC-01 — resolve the connection's company scope BEFORE opening the
  // stream, using the same F01 company context every company-scoped route
  // uses. Operator sessions (self-kind / bearer) stay unscoped and keep full
  // visibility; client sessions are bound to their registered company. A
  // production caller with no verifiable identity gets a 403 and no stream.
  let connectionCompanyId: string | null = null;
  try {
    connectionCompanyId = await resolveStreamCompany(request);
  } catch (error) {
    if (error instanceof TenantAccessError) {
      return NextResponse.json({ error: 'Verified company identity required' }, { status: 403 });
    }
    throw error;
  }

  const encoder = new TextEncoder();

  // Create a readable stream for SSE
  const stream = new ReadableStream({
    start(controller) {
      // Register this client for same-process push delivery, bound to its
      // resolved company scope. broadcast() drops events whose company scope
      // does not match, so a Company A browser never receives Company B's
      // task bytes over the in-memory path.
      registerClient(controller, connectionCompanyId);

      // Send initial connection message
      const connectMsg = encoder.encode(`: connected\n\n`);
      controller.enqueue(connectMsg);

      // MR-10: cursor for cross-process journal polling. Tracks the highest
      // sse_event_log.id this connection has forwarded to the client.
      let lastJournalId = 0;
      let pollTickCount = 0;

      // MR-10: poll the shared SQLite journal for events written by OTHER
      // processes (the in-memory push path already delivers same-process
      // events, so the poll is ONLY for cross-process fan-out).
      //
      // We fetch every row past the cursor and advance the cursor past ALL of
      // them, but only ENQUEUE rows whose origin differs from this process.
      // Rows THIS process journaled were already pushed to this connection's
      // controller by broadcast(), so re-forwarding them would double-deliver
      // every event to same-process clients (all clients in a single-process
      // deploy). Advancing the cursor past own-origin rows (rather than
      // filtering them in SQL) is deliberate: otherwise, in a single-process
      // deploy where no cross-process rows ever arrive, the cursor would never
      // move and every poll would re-scan the whole journal.
      // Best-effort — a poll failure is logged and the loop keeps running.
      const pollJournal = () => {
        try {
          // Dynamic import so Next.js doesn't bundle better-sqlite3 into
          // the edge runtime build.
          // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
          const { getDb } = require('@/lib/db') as typeof import('@/lib/db');
          const db = getDb();
          const rows = db
            .prepare(
              `SELECT id, origin, event_type, payload
               FROM sse_event_log
               WHERE id > ?
               ORDER BY id ASC
               LIMIT 50`,
            )
            .all(lastJournalId) as JournalRow[];

          for (const row of rows) {
            // Always advance the cursor so own-origin rows are never re-scanned.
            lastJournalId = row.id;
            // Skip events this process already pushed on the in-memory path.
            if (row.origin === SSE_PROCESS_ORIGIN) continue;
            // W3QC-01 — the journaled payload carries the broadcast scope as
            // `companyId` (absent on legacy unscoped rows). Drop rows whose
            // company does not match this connection's BEFORE enqueueing, so a
            // Company A browser never receives Company B's task bytes over the
            // cross-process path either. The cursor still advances past dropped
            // rows — they are simply never delivered to THIS connection.
            let rowCompanyId: string | null = null;
            try {
              const parsed = JSON.parse(row.payload) as { companyId?: unknown };
              rowCompanyId =
                typeof parsed.companyId === 'string' && parsed.companyId ? parsed.companyId : null;
            } catch {
              rowCompanyId = null; // malformed row: treat as legacy unscoped
            }
            if (!connectionMayReceive(connectionCompanyId, rowCompanyId)) continue;
            const data = `data: ${row.payload}\n\n`;
            // MSG-08 (fix2): route through the SAME backpressure guard
            // broadcast() uses. The previous direct controller.enqueue() bypassed
            // it, so a slow/dead consumer made the poll buffer journal payloads
            // without bound. enqueueWithBackpressure coalesces (drops) the chunk
            // when the consumer is backed up and drops it outright after the
            // strike budget; a dropped delta self-heals on the client's next
            // reconnect via useSSE's catch-up refetch (MSG-07).
            enqueueWithBackpressure(controller, encoder.encode(data));
          }

          // Periodic cleanup: delete rows older than JOURNAL_MAX_AGE_MS.
          // Fires every CLEANUP_EVERY_N_TICKS ticks to amortize cost.
          pollTickCount++;
          if (pollTickCount % CLEANUP_EVERY_N_TICKS === 0) {
            try {
              // fix2: sargable predicate. The previous form wrapped the column
              // in julianday() (`julianday('now') - julianday(created_at) > …`),
              // which forces a full table scan on every cleanup. created_at is
              // stored by SQLite's datetime('now') as 'YYYY-MM-DD HH:MM:SS'
              // (UTC) and is indexed (idx_sse_event_log_created), so compare it
              // directly against a precomputed cutoff in the SAME format and the
              // index range-scan is used. String comparison is safe because the
              // fixed-width ISO-like format sorts chronologically.
              const cutoff = new Date(Date.now() - JOURNAL_MAX_AGE_MS)
                .toISOString()
                .slice(0, 19)
                .replace('T', ' ');
              db.prepare(
                `DELETE FROM sse_event_log WHERE created_at < ?`,
              ).run(cutoff);
            } catch {
              // Cleanup is best-effort — stale rows are harmless.
            }
          }
        } catch {
          // Poll failure is non-fatal — the same-process push path still
          // delivers events to clients on THIS process, and the poll retries
          // on the next tick.
        }
      };

      // Set up keep-alive ping every 30 seconds
      const keepAliveInterval = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(`: keep-alive\n\n`));
        } catch (error) {
          // MSG-04: the client is gone but the 'abort' listener has not fired
          // (or will not). Previously we only cleared the interval and left the
          // controller registered, so it leaked in the broadcast Set and every
          // subsequent broadcast() had to hit the dead controller before
          // pruning it. Tear the connection down fully here, mirroring the
          // abort handler below.
          clearInterval(keepAliveInterval);
          clearInterval(pollInterval);
          unregisterClient(controller);
          try {
            controller.close();
          } catch {
            // Controller may already be closed
          }
        }
      }, 30000);

      // MR-10: cross-process journal poll loop.
      const pollInterval = setInterval(pollJournal, CROSS_PROCESS_POLL_MS);

      // Handle client disconnect
      request.signal.addEventListener('abort', () => {
        clearInterval(keepAliveInterval);
        clearInterval(pollInterval);
        unregisterClient(controller);
        try {
          controller.close();
        } catch (error) {
          // Controller may already be closed
        }
      });
    },
  });

  // Return SSE response
  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no', // Disable nginx buffering
    },
  });
}
