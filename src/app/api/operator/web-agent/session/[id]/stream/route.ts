/**
 * GET /api/operator/web-agent/session/[id]/stream
 *
 * Server-Sent Events stream for a single Web Agent session. Emits the live
 * action log, screenshots, status changes, and the final result.
 *
 * Track B9 (SCOPE-ADDITION Section 7).
 *
 * Event types (each frame `event: <type>\ndata: <json>`):
 *   screenshot  { png_base64 }
 *   action      { description, action }
 *   log         ActionLogEntry
 *   status      { status, ... }
 *   result      { markdown, vault_path }
 *   error       { message }
 *   done        { status, ended_at? }
 *
 * The stream first replays the in-memory ring buffer for the session so the
 * client never starts blank if it opened the URL a moment after the run was
 * dispatched. After `done` arrives the route closes the connection.
 */

import { NextRequest } from 'next/server';
import { getSession } from '@/lib/web-agent/runner';
import { getStreamBus, type WebAgentEvent } from '@/lib/web-agent/screenshot-stream';

export const dynamic = 'force-dynamic';
// Streaming responses must run on the Node runtime (Playwright + better-sqlite3
// dependencies are not Edge-compatible anyway, but be explicit).
export const runtime = 'nodejs';

interface RouteContext {
  params: Promise<{ id: string }> | { id: string };
}

export async function GET(req: NextRequest, context: RouteContext) {
  const resolved =
    typeof (context.params as Promise<{ id: string }>).then === 'function'
      ? await (context.params as Promise<{ id: string }>)
      : (context.params as { id: string });
  const sessionId = resolved.id;
  const session = getSession(sessionId);
  if (!session) {
    return new Response('session not found', { status: 404 });
  }

  const encoder = new TextEncoder();
  const bus = getStreamBus();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      // Heartbeat keeps the connection open through corporate proxies that
      // close idle SSE sockets after ~30s.
      const heartbeat = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`: heartbeat ${Date.now()}\n\n`));
        } catch {
          cleanup();
        }
      }, 15_000);

      function emit(evt: WebAgentEvent): void {
        if (closed) return;
        const frame =
          `event: ${evt.type}\n` +
          `data: ${JSON.stringify({ ts: evt.ts, ...((evt.payload as object) || {}) })}\n\n`;
        try {
          controller.enqueue(encoder.encode(frame));
        } catch {
          cleanup();
          return;
        }
        if (evt.type === 'done') {
          // Allow the client a moment to flush before tearing the socket down.
          setTimeout(cleanup, 100);
        }
      }

      const unsubscribe = bus.subscribe(sessionId, emit);

      function cleanup(): void {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        unsubscribe();
        try {
          controller.close();
        } catch {
          // ignore
        }
      }

      req.signal.addEventListener('abort', cleanup);

      // If the session has already terminated by the time the client
      // subscribes, the ring replay above will have delivered the `done`
      // event; the timeout inside emit() already schedules cleanup.
    },
  });

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      // Hint to Nginx (and the Cloudflare tunnel) not to buffer.
      'x-accel-buffering': 'no',
    },
  });
}
