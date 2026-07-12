/**
 * "My AI CEO" → OpenClaw gateway forwarder (P5-01 (c) step 1).
 *
 * The client's agent is reachable ON-BOX through the OpenClaw gateway
 * (ws://127.0.0.1:18789) — the ONLY sanctioned door to the agent (never bypass
 * the gateway; the standing Telegram doctrine applies equally here, spec (b)).
 * The CC and the gateway are colocated on every box, so this forwards a ceo-chat
 * message to the box's own main-agent session over that gateway and relays the
 * streamed reply.
 *
 * Design: a `ChatTransport` seam sits between the route and the live gateway.
 *   • The DEFAULT transport (`gatewayTransport`) drives the real OpenClaw client
 *     (src/lib/openclaw/client.ts) — connect-with-auto-pair, one session per chat,
 *     forward, relay reply events.
 *   • Tests inject a fake transport, so the streaming/down/degrade behavior is
 *     proven without a live gateway.
 *
 * BETA degrade (spec (b)/(c) step 3): when the gateway is down the forwarder does
 * NOT throw into the route — it yields a single `gateway_down` chunk so the UI can
 * render "Your AI CEO is restarting — Telegram still works" and the message is
 * never lost silently (it was already persisted by the route before forwarding).
 */
import type { OpenClawClientTarget } from '@/lib/openclaw/client';

/** One streamed piece of an agent reply. */
export type ChatChunk =
  | { type: 'token'; text: string }
  | { type: 'done'; text?: string }
  | { type: 'gateway_down'; message: string }
  | { type: 'error'; message: string };

export interface ForwardMetadata {
  /**
   * The originating channel + chat id the agent must stamp on any task it routes
   * from this request, so the trust engine reports back INTO this UI (P5-01 step
   * 2). Always `{ requester_channel: 'ceo-chat', requester_chat_id: <sessionId> }`.
   */
  requester_channel: string;
  requester_chat_id: string;
}

export interface ForwardRequest {
  sessionId: string;
  content: string;
  metadata: ForwardMetadata;
}

/**
 * The seam. A transport turns one forward request into a stream of reply chunks.
 * The default implementation talks to the on-box gateway; tests supply a fake.
 */
export interface ChatTransport {
  /** True when the on-box gateway is reachable and this device is paired. */
  probe(): Promise<{ up: boolean; detail?: string }>;
  /** Forward the message and yield the agent's reply as it streams. */
  forward(req: ForwardRequest): AsyncGenerator<ChatChunk>;
}

/** How long to wait for the whole agent reply before ending the stream. */
const REPLY_TIMEOUT_MS = Number(process.env.CEO_CHAT_REPLY_TIMEOUT_MS || 120_000);
/** How long to wait for the initial gateway connect before calling it "down". */
const CONNECT_TIMEOUT_MS = Number(process.env.CEO_CHAT_CONNECT_TIMEOUT_MS || 8_000);

/** The self/loopback gateway target — the box's own agent. */
function selfTarget(): OpenClawClientTarget {
  return { id: '__self__', url: process.env.OPENCLAW_GATEWAY_URL || 'ws://127.0.0.1:18789' };
}

/** Best-effort text extraction from an arbitrary gateway notification payload. */
function extractText(payload: unknown): string | null {
  if (payload == null) return null;
  if (typeof payload === 'string') return payload;
  if (typeof payload !== 'object') return null;
  const p = payload as Record<string, unknown>;
  for (const key of ['delta', 'text', 'content', 'chunk', 'token', 'message']) {
    const v = p[key];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return null;
}

/**
 * The default, live transport. Kept isolated so a test can bypass it entirely.
 * Never imports the client at module top-level side-effect scope beyond the type
 * — the real socket work happens inside probe()/forward().
 */
export const gatewayTransport: ChatTransport = {
  async probe() {
    try {
      const { getOpenClawClient } = await import('@/lib/openclaw/client');
      const client = getOpenClawClient(selfTarget());
      if (client.isConnected()) return { up: true };
      await withTimeout(client.connectWithAutoPair(), CONNECT_TIMEOUT_MS);
      return { up: client.isConnected() };
    } catch (err) {
      return { up: false, detail: err instanceof Error ? err.message : String(err) };
    }
  },

  async *forward(req: ForwardRequest): AsyncGenerator<ChatChunk> {
    let client: import('@/lib/openclaw/client').OpenClawClient;
    try {
      const { getOpenClawClient } = await import('@/lib/openclaw/client');
      client = getOpenClawClient(selfTarget());
      if (!client.isConnected()) {
        await withTimeout(client.connectWithAutoPair(), CONNECT_TIMEOUT_MS);
      }
      if (!client.isConnected()) {
        yield { type: 'gateway_down', message: 'The on-box agent gateway is not reachable right now.' };
        return;
      }
    } catch (err) {
      yield {
        type: 'gateway_down',
        message: err instanceof Error ? err.message : 'The on-box agent gateway is not reachable right now.',
      };
      return;
    }

    // A bounded queue bridges the client's EventEmitter callbacks to this async
    // generator. Reply notifications for THIS chat session push chunks; a
    // completion event or the timeout closes the stream.
    const queue: ChatChunk[] = [];
    let resolveNext: (() => void) | null = null;
    let closed = false;

    const push = (chunk: ChatChunk) => {
      queue.push(chunk);
      resolveNext?.();
      resolveNext = null;
    };
    const close = () => {
      closed = true;
      resolveNext?.();
      resolveNext = null;
    };

    // The gateway emits 'notification' frames; we relay the ones that carry text
    // and end on a completion/idle signal. Defensive about the exact shape.
    const onNotification = (msg: { method?: string; params?: unknown }) => {
      const method = String(msg.method || '');
      const text = extractText(msg.params);
      if (text) push({ type: 'token', text });
      if (/complete|done|idle|finished|end/i.test(method)) {
        push({ type: 'done' });
        close();
      }
    };
    client.on('notification', onNotification);

    const timer = setTimeout(() => {
      push({ type: 'done' });
      close();
    }, REPLY_TIMEOUT_MS);

    try {
      // One gateway session per chat, tagged with the ceo-chat channel + the chat
      // session id as peer, so the agent's own ingest can stamp requester_channel
      // / requester_chat_id from the session context (P5-01 step 2). The metadata
      // is also embedded in the forwarded content envelope as a belt-and-suspenders
      // for agents that read it from the message rather than the session.
      const session = await client.createSession(req.metadata.requester_channel, req.metadata.requester_chat_id);
      const gatewaySessionId =
        (session as { id?: string; session_id?: string })?.id ||
        (session as { session_id?: string })?.session_id ||
        req.sessionId;
      await client.sendMessage(gatewaySessionId, req.content);

      // Drain the bridge until closed or timed out.
      while (!closed || queue.length > 0) {
        if (queue.length === 0) {
          await new Promise<void>((r) => {
            resolveNext = r;
          });
          continue;
        }
        yield queue.shift() as ChatChunk;
      }
    } catch (err) {
      yield { type: 'error', message: err instanceof Error ? err.message : 'Failed to reach the agent.' };
    } finally {
      clearTimeout(timer);
      client.off('notification', onNotification);
    }
  },
};

/** Reject a promise if it does not settle within `ms`. */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`gateway timeout after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

/**
 * Forward a ceo-chat message to the on-box agent and stream the reply. The
 * transport defaults to the live gateway but is injectable for tests.
 */
export async function* forwardToAgent(
  req: ForwardRequest,
  transport: ChatTransport = gatewayTransport,
): AsyncGenerator<ChatChunk> {
  yield* transport.forward(req);
}

/** Is the on-box gateway currently reachable? (Drives the UI degrade banner.) */
export async function gatewayStatus(
  transport: ChatTransport = gatewayTransport,
): Promise<{ up: boolean; detail?: string }> {
  return transport.probe();
}
