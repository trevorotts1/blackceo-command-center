/**
 * POST /api/system/bootstrap
 *
 * Re-runs the platform-appropriate bootstrap script and streams its output
 * back to the caller as Server-Sent Events (SSE).
 *
 * Platform selection (via `detectPlatform()` in `@/lib/platform`):
 *   - `mac-mini`   -> `scripts/install/mac-mini-bootstrap.sh`
 *   - `vps-docker` -> `scripts/install/vps-docker-bootstrap.sh`
 *
 * SSE event types:
 *   - `stdout`   one event per stdout line
 *   - `stderr`   one event per stderr line
 *   - `error`    last stderr line, fired only on non-zero exit
 *   - `complete` final event, JSON `{ exitCode, durationMs }`
 *
 * Auth: requires the same MC_API_TOKEN bearer the middleware enforces.
 * The middleware already gates `/api/*` for non-same-origin callers, but
 * same-origin browser requests bypass the bearer check (Cloudflare Access
 * fronts them). To make this endpoint uniformly token-gated even from the
 * operator's browser, we re-validate the Authorization header here. The
 * drawer UI obtains the token from a meta tag or env var before posting.
 *
 * Notes:
 *   - The bootstrap script may run 5-15 minutes. There is no server-side
 *     timeout, the SSE connection stays open until the child process exits.
 *   - If the client disconnects mid-stream we keep the child process running
 *     (documented in the drawer UI). It will finish in the background.
 */

import { NextRequest } from 'next/server';
import { spawn } from 'child_process';
import path from 'path';
import { detectPlatform, type Platform } from '@/lib/platform';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const SCRIPT_BY_PLATFORM: Record<Platform, string> = {
  'mac-mini': 'scripts/install/mac-mini-bootstrap.sh',
  'vps-docker': 'scripts/install/vps-docker-bootstrap.sh',
};

function sseEvent(event: string, data: string): string {
  // Each `data:` line is terminated by `\n`. We split data on `\n` so multi
  // line strings remain valid SSE. The block terminator is `\n\n`.
  const lines = data.split('\n').map((l) => `data: ${l}`).join('\n');
  return `event: ${event}\n${lines}\n\n`;
}

function unauthorized(message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status: 401,
    headers: { 'Content-Type': 'application/json' },
  });
}

function badRequest(message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status: 400,
    headers: { 'Content-Type': 'application/json' },
  });
}

export async function POST(req: NextRequest): Promise<Response> {
  const expectedToken = process.env.MC_API_TOKEN;

  // Enforce bearer auth at the route level. If the token is not configured
  // server-side (local dev), we mirror the middleware behavior and allow the
  // request through, but log a warning so it is visible.
  if (expectedToken) {
    const authHeader = req.headers.get('authorization') || '';
    if (!authHeader.startsWith('Bearer ')) {
      return unauthorized('Unauthorized');
    }
    const token = authHeader.substring(7);
    if (token !== expectedToken) {
      return unauthorized('Unauthorized');
    }
  } else {
    console.warn('[/api/system/bootstrap] MC_API_TOKEN not set, bearer auth disabled (local dev mode)');
  }

  let platform: Platform;
  try {
    platform = detectPlatform();
  } catch (err) {
    return badRequest(
      `Platform detection failed: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  const scriptRelative = SCRIPT_BY_PLATFORM[platform];
  if (!scriptRelative) {
    return badRequest(
      `Unsupported platform "${platform}". Expected one of: mac-mini, vps-docker.`
    );
  }

  const scriptPath = path.resolve(process.cwd(), scriptRelative);
  const startedAt = Date.now();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      let lastStderrLine = '';
      let stdoutBuffer = '';
      let stderrBuffer = '';
      let closed = false;

      const safeEnqueue = (chunk: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          closed = true;
        }
      };

      const safeClose = () => {
        if (closed) return;
        closed = true;
        try {
          controller.close();
        } catch {
          // already closed
        }
      };

      // Initial handshake event so the client knows the stream is alive.
      safeEnqueue(
        sseEvent(
          'stdout',
          `[bootstrap] platform=${platform} script=${scriptRelative}`
        )
      );

      const child = spawn('bash', [scriptPath], {
        cwd: process.cwd(),
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      const flushLines = (
        buffer: string,
        eventName: 'stdout' | 'stderr',
        onLine?: (line: string) => void
      ): string => {
        const parts = buffer.split('\n');
        const tail = parts.pop() ?? '';
        for (const line of parts) {
          if (onLine) onLine(line);
          safeEnqueue(sseEvent(eventName, line));
        }
        return tail;
      };

      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (data: string) => {
        stdoutBuffer += data;
        stdoutBuffer = flushLines(stdoutBuffer, 'stdout');
      });

      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (data: string) => {
        stderrBuffer += data;
        stderrBuffer = flushLines(stderrBuffer, 'stderr', (line) => {
          if (line.trim().length > 0) lastStderrLine = line;
        });
      });

      child.on('error', (err) => {
        safeEnqueue(sseEvent('stderr', `[spawn error] ${err.message}`));
        lastStderrLine = err.message;
      });

      child.on('close', (code) => {
        // Flush any trailing data without a newline.
        if (stdoutBuffer.length > 0) {
          safeEnqueue(sseEvent('stdout', stdoutBuffer));
          stdoutBuffer = '';
        }
        if (stderrBuffer.length > 0) {
          safeEnqueue(sseEvent('stderr', stderrBuffer));
          if (stderrBuffer.trim().length > 0) lastStderrLine = stderrBuffer;
          stderrBuffer = '';
        }

        const exitCode = typeof code === 'number' ? code : -1;
        const durationMs = Date.now() - startedAt;

        if (exitCode !== 0) {
          safeEnqueue(
            sseEvent(
              'error',
              lastStderrLine || `Bootstrap exited with code ${exitCode}`
            )
          );
        }

        safeEnqueue(
          sseEvent(
            'complete',
            JSON.stringify({ exitCode, durationMs })
          )
        );
        safeClose();
      });

      // If the client aborts, log it but let the child finish. The stream
      // controller will already be torn down; safeEnqueue becomes a no-op.
      req.signal?.addEventListener('abort', () => {
        closed = true;
        console.warn(
          '[/api/system/bootstrap] client disconnected, bootstrap continues in background'
        );
      });
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
