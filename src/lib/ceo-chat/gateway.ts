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
import type { OpenClawClientTarget, OpenClawNativeEvent } from '@/lib/openclaw/client';
import type { HqChatTransportCallback } from '@/lib/hq/types';
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

/* ==================================================================== *
 * SPEC S9 "Native wire adapter" — Headquarters native EventFrame path (B11)
 * ==================================================================== *
 *
 * Everything below is a SECOND, opt-in path. `gatewayTransport` above is the
 * legacy path and is untouched byte-for-byte by this section: legacy callers
 * keep their exact method/notification/`ChatChunk` behavior. HQ chat does NOT
 * use `POST /api/ceo-chat/message`; it uses this adapter, which consumes the
 * native wire shape the legacy path drops — `{type:'event', event:'chat',
 * payload:{...}}` in place of the `{method, params}` notification.
 *
 * Shape authority (verified by reading the installed gateway, not inferred):
 *   • Frame:    `dist/sessions-Bw59kgfQ.mjs:1944-1951` (`EventFrameSchema`:
 *               closed `{type:'event', event:<nonempty string>, payload?,
 *               seq?, stateVersion?, recipientProfileId?}`). SPEC S9 cites the
 *               same lines.
 *   • Chat payload: same file `:2357-2469` — `ChatEventBaseSchema`
 *               `{runId, sessionKey, agentId?, spawnedBy?, seq}` plus the
 *               `state` variants `status|delta|final|aborted|error`.
 *   • Producer: `dist/server-chat-Du3bvN_g.mjs:577-775` — `broadcastChatDelta`
 *               (:592-609) emits `deltaText`/`replace`/`message`,
 *               `emitChatTerminal` (:716-775) emits `final`/`aborted`/`error`
 *               and `yielded:true` only on `jobState==='done' && opts.yielded`.
 *   • Subscription: `dist/sessions-subscriptions-CcyLoxx0.mjs:69-199` —
 *               `sessions.messages.subscribe`/`.unsubscribe`, params
 *               `{key, agentId?, subscriptionId?(≤128)}`, closed object.
 */

/**
 * Per-turn accumulator ceiling (S9). The accumulator stops growing at this
 * many characters of VISIBLE assistant text and is marked truncated honestly;
 * it is never allowed to grow unbounded off a token/event queue.
 */
export const HQ_NATIVE_ACCUMULATOR_MAX_CHARS = 64_000;

/** Bounded wait for `sessions.messages.subscribe` before the attempt aborts. */
const HQ_SUBSCRIBE_TIMEOUT_MS = Number(process.env.HQ_CHAT_SUBSCRIBE_TIMEOUT_MS || 8_000);

/** HqChatTransportCallback kinds (P01's frozen S9 set) — re-stated as a local
 *  literal union so this module needs no runtime import from the contract. */
export type HqNativeCallbackKind = HqChatTransportCallback['kind'];

/**
 * Typed lifecycle callback (S9 + P01 gap G-16, which this unit closes for the
 * transport seam). Every callback is correlated to the session and turn it
 * belongs to; a callback whose gateway key is not this adapter's own unique
 * per-turn key is never emitted on it (the guard lives in ONE place — see
 * `emit`).
 */
export interface HqNativeLifecycleEvent {
  kind: HqNativeCallbackKind;
  sessionId: string;
  turnId: string;
  /** The unique per-turn gateway key `agent:<verifiedRuntimeId>:hq-<turnId>`. */
  gatewaySessionKey: string;
  /** Native `runId` — present only where a run is actually known. */
  runId: string | null;
  /** Machine-readable detail for non-success kinds (`no_visible_reply`, etc.). */
  reason?: string;
}

/**
 * Terminal outcome of one HQ turn. `replied` is the ONLY success state, and it
 * is reached only by a matching `final` with `yielded !== true` AND actual
 * nonempty visible assistant text. Everything else is honest about what was
 * (not) observed: a `final` with no visible text is `no_visible_reply`, a
 * partial reply that timed out is `timeout`, and an `error`/`aborted` frame is
 * never success even when partial text exists.
 */
export interface HqNativeTurnResult {
  /**
   * `replied` — the ONLY success: matching `final`, `yielded !== true`, real
   * visible text. All others are honest non-successes:
   *  • `no_visible_reply` — final with no visible assistant text (incl. yielded)
   *  • `aborted` / `error` — terminal non-success even with partial text
   *  • `timeout` — explicit deadline; never a completion
   *  • `subscribe_failed` — positively unsent (subscription refused)
   *  • `failed_before_send` — positively unsent (connect/probe failure)
   *  • `send_uncertain` — post-send exception; delivery UNKNOWN, never success
   */
  outcome: string;
  /** Accumulated visible assistant text (cumulative authority when it existed). */
  text: string;
  /** True while the text is a non-authoritative partial and on any truncation. */
  partial: boolean;
  /** The run this turn actually belonged to, once observed. */
  runId: string | null;
  /** True when the accumulator hit `HQ_NATIVE_ACCUMULATOR_MAX_CHARS`. */
  truncated: boolean;
  /** True when a frame on this turn's key carried a DIFFERENT run id after the
   *  first was recorded — the "ignored/flagged" half of S9's run-matching rule. */
  foreignRunIgnored: boolean;
}

/** One HQ turn: the request plus its own unique identity. */
export interface HqNativeTurnRequest {
  /** Authorized HQ chat session id (server-owned; never the gateway key). */
  sessionId: string;
  /** Opaque per-turn id. Caller-supplied and server-minted; see the note on
   *  `agentId`/`runtimeId` for what the server must NOT accept from a client. */
  turnId: string;
  /** Verified runtime id of the bound head (server-resolved roster binding). */
  runtimeId: string;
  /** Trimmed message text. Caller (route) enforces the 32,000-char cap and
   *  rejects oversize with 413; this adapter adds no second policy. */
  message: string;
  /** Optional thinking level, passed through to `sessions.send` untouched. */
  thinkingLevel?: GatewayThinkingLevel;
}

/** Injectable seam so the adapter is provable without a live gateway. */
export interface HqNativeTransportClient {
  isConnected(): boolean;
  connectWithAutoPair(): Promise<unknown>;
  call<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
  on(event: 'native-event', listener: (ev: OpenClawNativeEvent) => void): unknown;
  off(event: 'native-event', listener: (ev: OpenClawNativeEvent) => void): unknown;
  /** B11: opt this instance into `'native-event'` emission. */
  enableNativeEvents?(enabled?: boolean): void;
}

export interface HqNativeTurnOptions {
  client: HqNativeTransportClient;
  /** Lifecycle callbacks, typed and correlated. */
  onLifecycle?: (event: HqNativeLifecycleEvent) => void;
  /** Called at most once per second while nonterminal with the partial text. */
  onPartial?: (text: string, meta: { runId: string | null; partial: true }) => void;
  /** Overall reply deadline (defaults to the legacy REPLY_TIMEOUT_MS). */
  timeoutMs?: number;
  /** Injectable clock for tests; defaults to `Date.now`. */
  now?: () => number;
}

/** The unique per-turn gateway key. S9: `agent:<verifiedRuntimeId>:hq-<opaqueTurnId>`. */
export function buildHqTurnGatewayKey(runtimeId: string, turnId: string): string {
  return `agent:${runtimeId}:hq-${turnId}`;
}

/** The `subscriptionId` S9 fixes: `'hq-' + turnId` (installed cap 128 chars). */
export function buildHqSubscriptionId(turnId: string): string {
  return `hq-${turnId}`;
}

/**
 * Visible assistant text from a native chat `message`, or null.
 *
 * S9: only `type:'text'` blocks are visible; a thinking/tool/attachment body is
 * never rendered. An assistant message whose only blocks are non-text yields
 * null — i.e. "no visible text", NOT empty-but-successful.
 */
export function hqVisibleTextFromNativeMessage(message: unknown): string | null {
  if (message == null || typeof message !== 'object') return null;
  const m = message as Record<string, unknown>;
  if (m.role !== 'assistant') return null;
  const content = m.content;
  if (!Array.isArray(content)) return null;
  let text = '';
  for (const block of content) {
    if (block == null || typeof block !== 'object') continue;
    const b = block as Record<string, unknown>;
    if (b.type !== 'text') continue;
    if (typeof b.text === 'string') text += b.text;
  }
  return text.length > 0 ? text : null;
}

/** Validated native chat payload, or null when the frame is not a usable chat event. */
interface HqNativeChatPayload {
  runId: string;
  sessionKey: string;
  agentId: string | null;
  seq: number;
  state: string;
  deltaText: string | null;
  replace: boolean;
  message: unknown;
  yielded: boolean;
}

function readHqNativeChatPayload(payload: unknown): HqNativeChatPayload | null {
  if (payload == null || typeof payload !== 'object') return null;
  const p = payload as Record<string, unknown>;
  const runId = p.runId;
  const sessionKey = p.sessionKey;
  const state = p.state;
  const seq = p.seq;
  if (typeof runId !== 'string' || runId.length === 0) return null;
  if (typeof sessionKey !== 'string' || sessionKey.length === 0) return null;
  if (typeof state !== 'string' || state.length === 0) return null;
  if (typeof seq !== 'number' || !Number.isInteger(seq) || seq < 0) return null;
  return {
    runId,
    sessionKey,
    agentId: typeof p.agentId === 'string' && p.agentId.length > 0 ? p.agentId : null,
    seq,
    state,
    deltaText: typeof p.deltaText === 'string' ? p.deltaText : null,
    replace: p.replace === true,
    message: p.message,
    yielded: p.yielded === true,
  };
}

/**
 * Run one HQ turn over the native EventFrame path. S9-native semantics, in
 * order, all of which are mutation-visible in this module:
 *
 *  1. Subscribe FIRST (`sessions.messages.subscribe`, with this turn's unique
 *     key + `subscriptionId`) and only THEN send. A refused subscription is
 *     POSITIVELY UNSENT: the attempt aborts with `subscribe_failed` and
 *     `failed_before_send` — no message is ever sent.
 *  2. `send_accepted` fires only after the send response acknowledges, never on
 *     session creation or subscription.
 *  3. Frames are matched on the exact per-turn `sessionKey` and (when the frame
 *     carries one) the bound `agentId`. The first observed `runId` is recorded
 *     as this turn's run; a different run id on the same key is ignored once
 *     and flagged — never relabeled onto this turn. That is what makes a
 *     late-arriving turn-A frame unable to touch turn-B's state even though
 *     both may share a run id.
 *  4. `(runId,seq)` dedup drops replayed and stale sequence numbers.
 *  5. `delta`: a validated assistant cumulative `message` REPLACES the
 *     accumulator (authoritative); else `replace:true` replaces with
 *     `deltaText`; else `deltaText` is appended ONCE. A cumulative message and
 *     a `deltaText` are never concatenated together.
 *  6. `final` marks `replied` only with matching run/session,
 *     `yielded !== true`, and actual nonempty visible text. Otherwise:
 *     `no_visible_reply` (final, no text), `aborted`, or `error`.
 *
 * The returned promise resolves exactly once. Every listener this call
 * registered is detached in `finally`, and the gateway subscription is released
 * with a matching `sessions.messages.unsubscribe` — which releases only THIS
 * turn's subscription and never aborts unrelated agent work.
 */
export async function runHqNativeTurn(
  req: HqNativeTurnRequest,
  options: HqNativeTurnOptions,
): Promise<HqNativeTurnResult> {
  const { client } = options;
  const now = options.now ?? (() => Date.now());
  const timeoutMs = options.timeoutMs ?? REPLY_TIMEOUT_MS;
  const gatewaySessionKey = buildHqTurnGatewayKey(req.runtimeId, req.turnId);
  const subscriptionId = buildHqSubscriptionId(req.turnId);

  let accumulator = '';
  let truncated = false;
  let partial = false;
  let observedRunId: string | null = null;
  let foreignRunIgnored = false;
  const seenSeq = new Set<string>();
  let lastPersistAt = 0;
  let settled = false;

  const emit = (kind: HqNativeCallbackKind, reason?: string) => {
    // The correlation guard, in ONE place: a callback can only ever carry THIS
    // turn's key. There is no path by which a foreign key reaches the caller.
    options.onLifecycle?.({
      kind,
      sessionId: req.sessionId,
      turnId: req.turnId,
      gatewaySessionKey,
      runId: observedRunId,
      ...(reason ? { reason } : {}),
    });
  };

  const persist = (authoritative: boolean) => {
    if (!options.onPartial) return;
    const at = now();
    if (!authoritative && at - lastPersistAt < 1_000) return; // ≤ once per second
    lastPersistAt = at;
    options.onPartial(accumulator, { runId: observedRunId, partial: true });
  };

  const append = (chunk: string) => {
    if (chunk.length === 0) return;
    if (accumulator.length >= HQ_NATIVE_ACCUMULATOR_MAX_CHARS) {
      truncated = true;
      return;
    }
    const room = HQ_NATIVE_ACCUMULATOR_MAX_CHARS - accumulator.length;
    if (chunk.length > room) truncated = true;
    accumulator += chunk.slice(0, room);
    partial = true;
  };

  const replaceAll = (text: string) => {
    accumulator = text.slice(0, HQ_NATIVE_ACCUMULATOR_MAX_CHARS);
    truncated = text.length > HQ_NATIVE_ACCUMULATOR_MAX_CHARS;
    partial = true;
  };

  return await new Promise<HqNativeTurnResult>((resolve) => {
    const finish = (result: Omit<HqNativeTurnResult, 'text' | 'partial' | 'runId' | 'truncated' | 'foreignRunIgnored'>) => {
      if (settled) return;
      settled = true;
      resolve({
        ...result,
        text: accumulator,
        partial,
        runId: observedRunId,
        truncated,
        foreignRunIgnored,
      });
      // Cleanup runs on EVERY settle, terminal or not — the listener detaches
      // and this turn's gateway subscription is released exactly once.
      void cleanup();
    };

    const onEvent = (ev: OpenClawNativeEvent) => {
      if (settled) return;
      if (ev.event !== 'chat') return; // S9: HQ consumes event='chat' only.
      const p = readHqNativeChatPayload(ev.payload);
      if (!p) return;
      // Exact per-turn session key match — the whole reason the key is unique.
      if (p.sessionKey !== gatewaySessionKey) return;
      // Optional agentId, when present, must match the bound target.
      if (p.agentId !== null && p.agentId !== req.runtimeId) return;
      // First observed runId is recorded; a DIFFERENT one on this key is
      // ignored/flagged, never relabeled onto this turn.
      if (observedRunId === null) {
        observedRunId = p.runId;
      } else if (observedRunId !== p.runId) {
        // A foreign run is not a completion of anything this turn can observe:
        // flag it and drop the frame. No `completion_observed` is emitted —
        // that kind is reserved for this turn's own terminal evidence.
        foreignRunIgnored = true;
        return;
      }
      // Dedup by (runId,seq); stale sequences are dropped.
      const seqKey = `${p.runId}:${p.seq}`;
      if (seenSeq.has(seqKey)) return;
      seenSeq.add(seqKey);

      if (p.state === 'status') return; // progress only, never completion

      if (p.state === 'delta') {
        const cumulative = hqVisibleTextFromNativeMessage(p.message);
        if (cumulative !== null) {
          // Authoritative cumulative visible text — REPLACE, and never
          // concatenate it with deltaText.
          replaceAll(cumulative);
        } else if (p.replace) {
          replaceAll(p.deltaText ?? '');
        } else if (p.deltaText) {
          append(p.deltaText);
        }
        persist(false);
        return;
      }

      if (p.state === 'final') {
        const finalText = hqVisibleTextFromNativeMessage(p.message);
        if (p.yielded) {
          // `yielded!==true` is required for completion, so a yielded final is
          // NOT completion evidence — no `completion_observed` is emitted for
          // it. The turn settles as `no_visible_reply` and its buffered text
          // stays labeled partial.
          finish({ outcome: 'no_visible_reply' });
          return;
        }
        if (finalText === null || finalText.length === 0) {
          // Final with no visible text: never fabricated success, and not a
          // completion observation.
          finish({ outcome: 'no_visible_reply' });
          return;
        }
        replaceAll(finalText);
        partial = false;
        // The ONLY path that reports completion.
        finish({ outcome: 'replied' });
        emit('completion_observed');
        return;
      }

      if (p.state === 'aborted') {
        // Non-success even when a partial message exists. `aborted` is not a
        // completion observation, and the turn deadline is still armed.
        persist(true);
        finish({ outcome: 'aborted' });
        return;
      }

      if (p.state === 'error') {
        persist(true);
        finish({ outcome: 'error' });
      }
    };

    const timer = setTimeout(() => {
      // Explicit timeout — never a completion. Partial text stays partial.
      finish({ outcome: 'timeout' });
      emit('timeout', 'no_terminal_frame');
    }, timeoutMs);

    /** Idempotent: `finish()` is the single caller, and exactly one unsubscribe
     *  is issued per attempt (S9: cleanup after terminal/timeout, once). It is
     *  unconditional on purpose — when the subscribe call timed out or errored
     *  we cannot know whether the gateway registered the subscription, and the
     *  gateway's own unsubscribe handler is idempotent, so releasing a
     *  subscription that was never created is free while leaking one is not. */
    let cleanedUp = false;
    const cleanup = async () => {
      if (cleanedUp) return;
      cleanedUp = true;
      clearTimeout(timer);
      client.off('native-event', onEvent);
      try {
        await client.call('sessions.messages.unsubscribe', {
          key: gatewaySessionKey,
          agentId: req.runtimeId,
          subscriptionId,
        });
      } catch {
        // Unsubscribe is best-effort cleanup: it releases only this turn's
        // subscription and must never turn a good turn into a failure, nor
        // abort unrelated agent work.
      }
    };

    void (async () => {
      try {
        if (!client.isConnected()) {
          await withTimeout(client.connectWithAutoPair(), CONNECT_TIMEOUT_MS);
        }
        // Opt the shared instance into native emission WITHOUT changing any
        // legacy caller's surface (the flag is per-instance and off by default).
        client.enableNativeEvents?.(true);

        // 1. SUBSCRIBE BEFORE SEND. A refusal here is positively unsent.
        const sub = await withTimeout(
          client.call<{ subscribed?: boolean }>('sessions.messages.subscribe', {
            key: gatewaySessionKey,
            agentId: req.runtimeId,
            subscriptionId,
          }),
          HQ_SUBSCRIBE_TIMEOUT_MS,
        ).catch(() => null);
        if (!sub || sub.subscribed === false) {
          // Positively unsent — no send is ever issued.
          emit('failed_before_send', 'subscribe_failed');
          finish({ outcome: 'subscribe_failed' });
          return;
        }

        client.on('native-event', onEvent);

        // 2. Send. `send_accepted` only after the response acknowledges.
        try {
          await client.call('sessions.send', {
            key: gatewaySessionKey,
            message: req.message,
            ...(req.thinkingLevel ? { thinking: req.thinkingLevel } : {}),
          });
        } catch (error) {
          // The send CALL was issued; a network exception after that point is
          // UNCERTAIN, not a proven non-send. `send_uncertain` — never
          // `failed_before_send`, never `replied`.
          finish({ outcome: 'send_uncertain' });
          emit('timeout', error instanceof Error ? error.message : 'send_threw');
          return;
        }
        // `send_accepted` fires only now: the send response acknowledged.
        emit('send_accepted');
      } catch (error) {
        // Connect/session-setup failure — nothing was sent yet.
        finish({ outcome: 'failed_before_send' });
        emit('failed_before_send', error instanceof Error ? error.message : 'connect_failed');
      }
    })();
  });
}

/** Is the on-box gateway currently reachable? (Drives the UI degrade banner.) */
export async function gatewayStatus(
  transport: ChatTransport = gatewayTransport,
): Promise<{ up: boolean; detail?: string }> {
  return transport.probe();
}
