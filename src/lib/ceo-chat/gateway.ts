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
 *
 * Session-scoped relay: `getOpenClawClient()` caches ONE client instance per
 * target (client.ts), so every concurrent ceo-chat request against the same
 * box (two tabs, two chats) shares the '__self__' singleton and its single
 * 'notification' event stream. `forward()` therefore filters every incoming
 * notification against ITS OWN gatewaySessionId (see `extractSessionId()`)
 * before relaying a token or closing the stream — an unmatched/unattributable
 * frame is dropped, never relayed. Without this, two concurrent chats would
 * interleave each other's tokens and a foreign completion event could close
 * the wrong stream.
 *
 * U62 (JM/U65, master E.2) -- Phase B: model / thinking-level / agent-switch
 * passthrough + exact usage metering, HARD-gated per the U61 gateway spikes
 * (~/Downloads/skill6-u61-spike-S1/S2/S3-*-2026-07-16.md), all three PASS:
 *   - S1: the accepted-AND-LANDING reasoning-effort set for the default model
 *     is EXACTLY {off, low, medium, high} (see ./thinking-level.ts) --
 *     'minimal' hard-rejects; 'max' validates but silently downgrades to
 *     'high' (a trap this file never reproduces: req.thinkingLevel is typed
 *     to the proven set only, and the caller -- the API route -- maps the
 *     UI's "Max" label to 'high' before this module ever sees it).
 *   - S2: the sanctioned addressing mechanism is a structured sessions.create
 *     `key` param, `agent:<agentId>:<peer>` -- NOT a bare {channel,peer}
 *     pair. client.createSession(channel, peer) / client.sendMessage(id,
 *     content) send exactly the shapes this gateway version (2026.6.11)
 *     REJECTS OUTRIGHT (unexpected property 'channel', unexpected property
 *     'content') -- proven live, not inferred. This file therefore calls the
 *     OpenClawClient's already-public call(method, params) RPC method
 *     directly with the proven shapes, rather than fixing (or replacing)
 *     those two legacy methods -- which FIVE OTHER, unrelated routes still
 *     call today (/api/openclaw/sessions*, /api/interview/turn,
 *     /api/operator/bridge/send, operator/goals.ts). Changing their shared
 *     behavior is out of this unit's scope and not something one "My AI CEO"
 *     chat unit should decide for five unrelated live surfaces -- this fix is
 *     scoped to ceo-chat's own transport only.
 *   - S3: the gateway attaches a structured usage object to a completed
 *     turn; this file best-effort-extracts it from the 'notification' stream
 *     (see extractUsage() -- INFERRED field names, not a literal WS-frame
 *     byte capture per U61/S3's own honesty note) and re-surfaces it as a new
 *     `usage` ChatChunk before `done`, never fabricating a value when none is
 *     recognizable.
 * All three passthrough fields on ForwardRequest (model, thinkingLevel,
 * agentId) are OPTIONAL -- omitting them reproduces the exact Phase-A wire
 * shape ({key: 'agent:main:<peer>'} / {key, message}), so this is a pure
 * extension of the seam, never a replacement.
 */
import type { OpenClawClientTarget } from '@/lib/openclaw/client';
import type { GatewayThinkingLevel } from './thinking-level';

/** One streamed piece of an agent reply. U62 extends the vocabulary with
 *  `usage` (S3 — exact per-turn token/cost accounting) and `routed` (S2 —
 *  confirms which agent the session actually addressed) — both additive;
 *  every Phase-A consumer that only switches on `token`/`done`/
 *  `gateway_down`/`error` is unaffected. */
export type ChatChunk =
  | { type: 'token'; text: string }
  | { type: 'done'; text?: string }
  | { type: 'gateway_down'; message: string }
  | { type: 'error'; message: string }
  | { type: 'usage'; usage: { input: number; output: number; total: number } }
  | { type: 'routed'; agentId: string };

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
  /**
   * U62 (JM/U65) Phase-B passthrough — all optional, all additive. Omitting
   * every field reproduces the exact Phase-A wire shape byte-for-byte (see
   * the "optional-additive" tests in ceo-chat-gateway-transport.test.ts).
   */
  /** Session-scoped model override (U61/S2: rides on `sessions.create`
   *  only — `sessions.send` has no `model` field on this gateway version). */
  model?: string;
  /** Per-message reasoning-effort override (U61/S1: rides on
   *  `sessions.send` only). MUST already be one of the four proven gateway
   *  values (`off|low|medium|high`) — never the UI label, never the literal
   *  broken string `"max"`. The API route owns that translation
   *  (`toGatewayThinkingLevel()` in ./thinking-level.ts) before this field is
   *  ever populated. */
  thinkingLevel?: GatewayThinkingLevel;
  /** Target agent id (U61/S2: threads into the `sessions.create` `key`,
   *  `agent:<agentId>:<peer>`). Defaults to the gateway's own default agent
   *  name (`'main'`) when omitted — preserves Phase-A's single-agent,
   *  '__self__'-loopback behavior. */
  agentId?: string;
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
 * Best-effort gateway-session-id extraction from an arbitrary notification
 * payload, so `forward()` can tell whether a 'notification' frame belongs to
 * ITS OWN gateway session before relaying it. `getOpenClawClient()` caches
 * ONE client instance per target — every concurrent ceo-chat request against
 * the same box shares the '__self__' singleton (client.ts) and therefore
 * shares its single 'notification' event stream. Mirrors the RPC param name
 * (`session_id`) the client itself already uses for `sessions.send` /
 * `sessions.history`; the extra keys are defensive about payload-shape drift,
 * same as `extractText()` above.
 */
function extractSessionId(payload: unknown): string | null {
  if (payload == null || typeof payload !== 'object') return null;
  const p = payload as Record<string, unknown>;
  for (const key of ['session_id', 'sessionId', 'session', 'id']) {
    const v = p[key];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return null;
}

/**
 * U62 (JM/U65) / U61-S2-proven addressing: a structured `key` of the form
 * `agent:<agentId>:<peer>` — NOT a bare `{channel,peer}` pair (this gateway
 * version rejects that outright: "unexpected property 'channel'"). `agentId`
 * defaults to `'main'` (the gateway's own default-agent name, confirmed by
 * S2's empty-params round trip) so an unset agent preserves Phase-A's
 * existing single-agent behavior. `peer` is the CC-side chat session id, so
 * the SAME (agent, session) pair always resolves to the SAME gateway session
 * (multi-turn continuity via idempotent `sessions.create`), while switching
 * agent for one CC session yields a DIFFERENT key — a genuinely separate,
 * non-interleaved gateway-side thread (spec M.3/U65 acceptance).
 */
function buildSessionKey(agentId: string | undefined, peer: string): string {
  const agent = agentId && agentId.trim() ? agentId.trim() : 'main';
  return `agent:${agent}:${peer}`;
}

/**
 * Best-effort usage extraction from a notification payload. INFERRED, not a
 * literal WS-frame byte-for-byte proof (U61/S3 observed usage on the
 * session's persisted trajectory record and the CLI's synchronous JSON
 * response — two DIFFERENT read paths than the raw 'notification' event this
 * relay actually consumes; the live WS field name was not hand-captured).
 * Checks the trajectory-file field name (`usage`) and the CLI response's
 * alternate name (`lastCallUsage`), both at the payload root or nested under
 * a `message` wrapper (the trajectory record's own shape) — mirroring
 * extractText()'s defensive multi-key philosophy. Returns null (never a
 * fabricated zero) when nothing recognizable is present, so the meter simply
 * stays in estimate mode for that turn rather than lying about precision.
 */
function extractUsage(payload: unknown): { input: number; output: number; total: number } | null {
  if (payload == null || typeof payload !== 'object') return null;
  const p = payload as Record<string, unknown>;
  const nestedMessage =
    p.message && typeof p.message === 'object' ? (p.message as Record<string, unknown>) : null;
  const candidates: unknown[] = [p.usage, p.lastCallUsage, nestedMessage?.usage];
  for (const c of candidates) {
    if (c && typeof c === 'object') {
      const u = c as Record<string, unknown>;
      const input = Number(u.input);
      const output = Number(u.output);
      const total = Number(u.total ?? u.totalTokens);
      if (Number.isFinite(input) && Number.isFinite(output) && Number.isFinite(total)) {
        return { input, output, total };
      }
    }
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

    // The 'notification' listener is registered further down, once the
    // gateway session id for THIS forward() call is known, so it can be
    // declared here and detached in `finally` regardless of where the try
    // block exits.
    let onNotification: ((msg: { method?: string; params?: unknown }) => void) | null = null;

    const timer = setTimeout(() => {
      push({ type: 'done' });
      close();
    }, REPLY_TIMEOUT_MS);

    try {
      // U62/U61-S2: address the session with the proven structured `key`
      // (`agent:<agentId>:<peer>`), never the legacy {channel,peer} shape
      // this gateway version rejects outright. The peer is the CC-side chat
      // session id, so the agent's own ingest can still stamp
      // requester_channel/requester_chat_id from the session context (P5-01
      // step 2); the metadata is also embedded in the forwarded content
      // envelope as a belt-and-suspenders for agents that read it from the
      // message rather than the session. `sessions.create` is idempotent per
      // key (round-trip-proven), so repeat turns to the SAME (agent,
      // session) reuse the SAME gateway session — multi-turn continuity.
      const key = buildSessionKey(req.agentId, req.metadata.requester_chat_id);
      const resolvedAgentId = req.agentId && req.agentId.trim() ? req.agentId.trim() : 'main';
      const session = await client.call<{ key?: string; sessionId?: string }>('sessions.create', {
        key,
        ...(req.model ? { model: req.model } : {}),
      });
      // Filtering id: prefer the gateway's own returned `sessionId` (the
      // field the live gateway actually returns — U61/S2 evidence), then the
      // echoed `key` (S2: sessions.create always echoes the `key` it was
      // sent), then — only if the response carried neither — the locally
      // built `key` itself as the final defensive fallback: we KNOW we sent
      // it, unlike req.sessionId, which is a CC-internal id the gateway has
      // no reason to ever echo back on a notification frame.
      const gatewaySessionId = session?.sessionId || session?.key || key;

      yield { type: 'routed', agentId: resolvedAgentId };

      // The gateway emits 'notification' frames on the SHARED client for every
      // session in flight (concurrent chats/tabs interleave on the same
      // '__self__' singleton — client.ts:832), so relay only frames that carry
      // THIS forward() call's own gatewaySessionId, and only end the stream on
      // a completion/idle signal for THIS session. A frame we cannot attribute
      // to a session is, by definition, not provably ours — drop it rather
      // than risk relaying (or closing on) a foreign chat's event.
      onNotification = (msg: { method?: string; params?: unknown }) => {
        const notifSessionId = extractSessionId(msg.params);
        if (notifSessionId !== gatewaySessionId) return;
        const method = String(msg.method || '');
        const text = extractText(msg.params);
        if (text) push({ type: 'token', text });
        const isCompletion = /complete|done|idle|finished|end/i.test(method);
        if (isCompletion) {
          // U62/U61-S3: best-effort usage capture, surfaced BEFORE `done` so
          // the meter can drop its estimate `≈` the instant the turn closes.
          const usage = extractUsage(msg.params);
          if (usage) push({ type: 'usage', usage });
          push({ type: 'done' });
          close();
        }
      };
      client.on('notification', onNotification);

      // U62/U61-S1: `message` (not `content`) is the required field;
      // `thinking` is a proven per-message param — model is NOT valid here
      // (it rides on sessions.create above only).
      await client.call('sessions.send', {
        key,
        message: req.content,
        ...(req.thinkingLevel ? { thinking: req.thinkingLevel } : {}),
      });

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
      if (onNotification) client.off('notification', onNotification);
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
