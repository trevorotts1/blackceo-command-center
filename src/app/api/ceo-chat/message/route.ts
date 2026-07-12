/**
 * POST /api/ceo-chat/message (P5-01 (c) step 1)
 *
 * Persists the client's message to the ceo-chat transcript, forwards it to the
 * on-box agent through the OpenClaw gateway (the ONLY sanctioned door, spec (b)),
 * and streams the reply back as Server-Sent Events. The agent decides whether to
 * route the request to a department; when it does, it uses the standard ingest
 * front door carrying `requester_channel:'ceo-chat'` + this chat session id, so
 * the trust engine reports ack/progress/done back INTO this transcript (P5-01
 * step 2 — one trust engine, two channels). We pass that metadata to the agent.
 *
 * BETA degrade (spec (c) step 3): if the gateway is down we emit a `gateway_down`
 * SSE event and persist a system notice — the user's message is NEVER lost (it
 * was persisted BEFORE forwarding), and the UI shows "use Telegram meanwhile".
 *
 * Auth: a normal (non-webhook) same-origin /api route — the middleware's
 * same-origin passthrough serves the browser; an external caller still needs the
 * MC_API_TOKEN bearer.
 */
import { NextRequest } from 'next/server';
import { v4 as uuidv4 } from 'uuid';
import { insertCeoChatMessage } from '@/lib/ceo-chat/store';
import { isMyAiCeoBetaEnabled, CEO_CHAT_CHANNEL } from '@/lib/ceo-chat/config';
import { forwardToAgent, type ChatChunk } from '@/lib/ceo-chat/gateway';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/** Hard cap on a single chat message (defends the DB + the gateway forward). */
const MAX_MESSAGE_CHARS = 32_000;

function sse(event: string, data: unknown): Uint8Array {
  return new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

export async function POST(request: NextRequest) {
  if (!isMyAiCeoBetaEnabled()) {
    return new Response(JSON.stringify({ error: 'My AI CEO (BETA) is disabled on this box.' }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    });
  }

  let body: { sessionId?: unknown; message?: unknown };
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    });
  }

  const message = typeof body.message === 'string' ? body.message.trim() : '';
  if (!message) {
    return new Response(JSON.stringify({ error: 'message is required' }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    });
  }
  if (message.length > MAX_MESSAGE_CHARS) {
    return new Response(JSON.stringify({ error: `message exceeds ${MAX_MESSAGE_CHARS} characters` }), {
      status: 413,
      headers: { 'content-type': 'application/json' },
    });
  }

  const sessionId =
    typeof body.sessionId === 'string' && body.sessionId.trim() ? body.sessionId.trim() : uuidv4();

  // Persist the client's message FIRST — before any forward — so it can never be
  // lost even if the gateway is down or the stream aborts mid-flight.
  try {
    insertCeoChatMessage({ sessionId, role: 'user', content: message, kind: 'message' });
  } catch (err) {
    console.error('[/api/ceo-chat/message] persist failed:', err);
    return new Response(JSON.stringify({ error: 'Failed to persist message' }), {
      status: 500,
      headers: { 'content-type': 'application/json' },
    });
  }

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const safeEnqueue = (chunk: Uint8Array) => {
        try {
          controller.enqueue(chunk);
        } catch {
          /* client gone */
        }
      };

      // Tell the client which session this is (it may have been minted here) so
      // it can persist/reuse it across turns.
      safeEnqueue(sse('session', { sessionId }));

      let assistantText = '';
      let gatewayDown = false;

      try {
        for await (const chunk of forwardToAgent({
          sessionId,
          content: message,
          metadata: { requester_channel: CEO_CHAT_CHANNEL, requester_chat_id: sessionId },
        })) {
          const c = chunk as ChatChunk;
          if (c.type === 'token') {
            assistantText += c.text;
            safeEnqueue(sse('token', { text: c.text }));
          } else if (c.type === 'gateway_down') {
            gatewayDown = true;
            safeEnqueue(sse('gateway_down', { message: c.message }));
          } else if (c.type === 'error') {
            safeEnqueue(sse('error', { message: c.message }));
          } else if (c.type === 'done') {
            break;
          }
        }
      } catch (err) {
        safeEnqueue(sse('error', { message: err instanceof Error ? err.message : 'stream failed' }));
      }

      // Persist the outcome so a reconnect / history reload shows the same thread.
      try {
        if (assistantText.trim()) {
          insertCeoChatMessage({ sessionId, role: 'assistant', content: assistantText, kind: 'message' });
        } else if (gatewayDown) {
          insertCeoChatMessage({
            sessionId,
            role: 'system',
            content:
              'Your AI CEO is restarting and could not be reached. Your message is saved and Telegram still works — try again shortly.',
            kind: 'error',
          });
        }
      } catch (err) {
        console.warn('[/api/ceo-chat/message] outcome persist failed (non-fatal):', err);
      }

      safeEnqueue(sse('done', { sessionId }));
      try {
        controller.close();
      } catch {
        /* already closed */
      }
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
