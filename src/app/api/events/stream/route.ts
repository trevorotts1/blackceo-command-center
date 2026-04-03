/**
 * Server-Sent Events (SSE) endpoint for real-time updates
 * Clients connect to this endpoint and receive live event broadcasts
 */

import { NextRequest } from 'next/server';
import { registerClient, unregisterClient } from '@/lib/events';

export const dynamic = 'force-dynamic';

const KEEP_ALIVE_INTERVAL_MS = 30000;

export async function GET(request: NextRequest) {
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      let closed = false;
      let keepAliveInterval: NodeJS.Timeout | null = null;

      const cleanup = () => {
        if (closed) return;
        closed = true;

        if (keepAliveInterval) {
          clearInterval(keepAliveInterval);
          keepAliveInterval = null;
        }

        unregisterClient(controller);

        try {
          controller.close();
        } catch {
          // Controller may already be closed
        }
      };

      registerClient(controller);

      try {
        controller.enqueue(encoder.encode(`: connected\n\n`));
      } catch (error) {
        console.error('[SSE] Failed to send initial connection event:', error);
        cleanup();
        return;
      }

      keepAliveInterval = setInterval(() => {
        if (closed) {
          cleanup();
          return;
        }

        try {
          controller.enqueue(encoder.encode(`: keep-alive\n\n`));
        } catch (error) {
          console.warn('[SSE] Keep-alive failed, closing client connection');
          cleanup();
        }
      }, KEEP_ALIVE_INTERVAL_MS);

      request.signal.addEventListener('abort', cleanup, { once: true });
    },
    cancel() {
      // The abort listener handles cleanup for normal client disconnects.
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
