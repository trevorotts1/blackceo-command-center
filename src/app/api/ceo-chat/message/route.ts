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
import { isForbidden } from '@/lib/model-selector';
import {
  toGatewayThinkingLevel,
  isValidGatewayThinkingLevel,
  isOllamaReasoningFamily,
  type GatewayThinkingLevel,
} from '@/lib/ceo-chat/thinking-level';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/** Hard cap on a single chat message (defends the DB + the gateway forward). */
const MAX_MESSAGE_CHARS = 32_000;

function sse(event: string, data: unknown): Uint8Array {
  return new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/**
 * U62 (JM/U65, master E.2) — resolve an incoming `thinkingLevel` body field to
 * one of the U61/S1-proven gateway values, or `undefined` if it cannot be
 * trusted. Accepts EITHER a ThinkingSelector UI label ("Quick".."Max",
 * translated via toGatewayThinkingLevel()) OR an already-valid gateway value
 * sent directly ("off"|"low"|"medium"|"high"). This is a SOFT enhancement —
 * an unrecognized value (including the literal broken strings "max"/
 * "minimal") is silently dropped rather than failing the whole request, but
 * it is NEVER threaded through to the transport unresolved. Defense in depth:
 * even if a compromised/buggy client sends the raw string "max" directly
 * (bypassing the UI's own label mapping), this function still refuses it.
 *
 * Ollama-scoping (added after U61 closed, root-caused independently): the
 * {off,low,medium,high} ceiling was verified SPECIFICALLY for Ollama
 * reasoning models (see thinking-level.ts's isOllamaReasoningFamily() doc for
 * the root-cause citation). ThinkingSelector already disables client-side for
 * any other model, but a client is never trusted alone — `resolvedModel` MUST
 * be a known Ollama-family model id or this function drops the override
 * regardless of how well-formed the value itself is, so a bypass of the UI
 * cannot smuggle an unverified reasoning-effort override to a model it was
 * never proven safe for. `resolvedModel` is `undefined` whenever the request
 * did not name a model at all — the route cannot verify Ollama-family without
 * one, so it never assumes; it just drops the override.
 */
function resolveThinkingLevel(raw: unknown, resolvedModel: string | undefined): GatewayThinkingLevel | undefined {
  if (typeof raw !== 'string' || !raw.trim()) return undefined;
  if (!resolvedModel || !isOllamaReasoningFamily(resolvedModel)) return undefined;
  const fromLabel = toGatewayThinkingLevel(raw);
  if (fromLabel) return fromLabel;
  if (isValidGatewayThinkingLevel(raw)) return raw;
  return undefined;
}

export async function POST(request: NextRequest) {
  if (!isMyAiCeoBetaEnabled()) {
    return new Response(JSON.stringify({ error: 'My AI CEO (BETA) is disabled on this box.' }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    });
  }

  let body: { sessionId?: unknown; message?: unknown; model?: unknown; thinkingLevel?: unknown; agentId?: unknown };
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

  // U62 (JM/U65) Phase-B passthrough — all three optional.
  const model = typeof body.model === 'string' && body.model.trim() ? body.model.trim() : undefined;
  // Sovereignty filter (M.4 non-goals: "a hard gate in every model list this
  // section ships"). ModelPicker already never lists a forbidden model, but
  // this is the API boundary — never trust the client alone. A forbidden
  // model is REJECTED loudly (400), never silently dropped or substituted,
  // because silently proceeding would violate a hard existing invariant.
  if (model && isForbidden(model)) {
    return new Response(
      JSON.stringify({ error: `model "${model}" is forbidden — the sovereignty filter never permits an Anthropic-family route` }),
      { status: 400, headers: { 'content-type': 'application/json' } },
    );
  }
  const thinkingLevel = resolveThinkingLevel(body.thinkingLevel, model);
  const agentId = typeof body.agentId === 'string' && body.agentId.trim() ? body.agentId.trim() : undefined;

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
      // U62 (JM/U65) — the last real usage frame captured this turn (S3),
      // persisted onto the assistant row below so history can echo it after
      // a reload (migration 110). Stays null when no usage frame arrives —
      // the meter is never told a fabricated number.
      let capturedUsage: { input: number; output: number; total: number } | null = null;

      try {
        for await (const chunk of forwardToAgent({
          sessionId,
          content: message,
          metadata: { requester_channel: CEO_CHAT_CHANNEL, requester_chat_id: sessionId },
          ...(model ? { model } : {}),
          ...(thinkingLevel ? { thinkingLevel } : {}),
          ...(agentId ? { agentId } : {}),
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
          } else if (c.type === 'usage') {
            capturedUsage = c.usage;
            safeEnqueue(sse('usage', { usage: c.usage }));
          } else if (c.type === 'routed') {
            safeEnqueue(sse('routed', { agentId: c.agentId }));
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
          insertCeoChatMessage({
            sessionId,
            role: 'assistant',
            content: assistantText,
            kind: 'message',
            usageInput: capturedUsage?.input ?? null,
            usageOutput: capturedUsage?.output ?? null,
            usageTotal: capturedUsage?.total ?? null,
          });
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
