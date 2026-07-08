/**
 * Server-Sent Events (SSE) endpoint for real-time updates
 * Clients connect to this endpoint and receive live event broadcasts
 */

import { NextRequest } from 'next/server';
import { registerClient, unregisterClient } from '@/lib/events';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const encoder = new TextEncoder();

  // Create a readable stream for SSE
  const stream = new ReadableStream({
    start(controller) {
      // Register this client
      registerClient(controller);

      // Send initial connection message
      const connectMsg = encoder.encode(`: connected\n\n`);
      controller.enqueue(connectMsg);

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
          unregisterClient(controller);
          try {
            controller.close();
          } catch {
            // Controller may already be closed
          }
        }
      }, 30000);

      // Handle client disconnect
      request.signal.addEventListener('abort', () => {
        clearInterval(keepAliveInterval);
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
