/**
 * P5-01 — My AI CEO gateway forwarder: the REAL gatewayTransport.
 *
 * ceo-chat-gateway-forward.test.ts proves forwardToAgent() against a trivial
 * pass-through FAKE ChatTransport — it never exercises `gatewayTransport`
 * itself. Everything gatewayTransport.forward() actually does is proven here:
 *   - the bounded queue that bridges the OpenClawClient EventEmitter into an
 *     async generator (push/resolveNext/close),
 *   - extractText()'s key-precedence order over an arbitrary notification
 *     payload (delta > text > content > chunk > token > message),
 *   - the completion-method regex that ends the stream,
 *   - the REPLY_TIMEOUT_MS fallback when the agent never signals completion,
 *   - the connect-failure `gateway_down` degrade path (both a thrown connect
 *     error and a connect that resolves without ending up connected),
 *   - U62 (JM/U65, master E.2): sessions.create/sessions.send are addressed
 *     via the U61/S2-proven structured `key` param (`agent:<agentId>:<peer>`)
 *     through the ALREADY-PUBLIC `client.call()` RPC method — never the
 *     legacy `createSession(channel,peer)`/`sendMessage(sessionId,content)`
 *     methods, which U61/S1-S2 proved this gateway version (2026.6.11)
 *     rejects outright (`unexpected property 'channel'`, `unexpected
 *     property 'content'`). The gateway session id used to FILTER
 *     notifications is extracted from `sessions.create`'s response
 *     (`sessionId` -> `key` -> the CC-side req.sessionId, in that order) —
 *     `sessionId` first because that is the field the live gateway actually
 *     returns (U61/S2 evidence), unlike the old `id`/`session_id` guesses.
 *   - U62: `model` (session-scoped) rides on `sessions.create`; `thinking`
 *     (per-message) rides on `sessions.send` — exactly the split U61/S1
 *     proved (`sessions.send` has no `model` field; `sessions.create` has no
 *     `thinking` field). Both are OPTIONAL-additive: omitting them reproduces
 *     the exact Phase-A wire shape.
 *   - U62: usage frames (U61/S3) are best-effort-extracted from a completion
 *     notification and re-surfaced as a `usage` ChatChunk BEFORE `done`; a
 *     `routed` chunk fires once the session is resolved, carrying the
 *     effective agent id (defaults to 'main' when none was requested).
 * A mutation to any of those lines should fail this suite.
 *
 * This drives the REAL `gatewayTransport` export against a fake
 * OpenClawClient — a plain EventEmitter implementing just the subset of the
 * client gatewayTransport calls (isConnected/connectWithAutoPair/call/on/off)
 * — so the mutation-sensitive behavior is proven without a live gateway.
 *
 * Vitest (not the tsx --test glob): '@/lib/openclaw/client' is mocked via
 * vi.doMock + a dynamic import of '@/lib/ceo-chat/gateway' per test (the
 * module reads REPLY_TIMEOUT_MS/CONNECT_TIMEOUT_MS from process.env at import
 * time, so each case needs a fresh module), matching the pattern already used
 * in provider-key-auth-store.test.ts. Registered in vitest.config.ts
 * `include` and excluded from the tsx --test glob in package.json
 * `test:unit`, same as its sibling ceo-chat-gateway-forward.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import type { ChatChunk, ForwardRequest } from '@/lib/ceo-chat/gateway';

/** A notification frame the fake client emits, mirroring the real gateway's
 *  `{ method, params }` 'notification' event shape. */
interface FakeNotification {
  method?: string;
  params?: unknown;
}

/**
 * Minimal fake of src/lib/openclaw/client.ts's OpenClawClient — just the
 * surface gatewayTransport.forward()/probe() touch as of U62: isConnected /
 * connectWithAutoPair / call / on / off. `call()` dispatches on the RPC
 * method name exactly like the real gateway: `sessions.create` returns
 * `sessionResult`; `sessions.send` records the call and replays any queued
 * notifications, injecting the resolved gateway session id into
 * object-shaped params (mirrors the real gateway stamping that id on every
 * frame it emits for the session) — AFTER forward() has already registered
 * its 'notification' listener (it does so before calling
 * sessions.create/sessions.send, exactly like the real transport), so they
 * land deterministically without relying on real timers.
 */
class FakeOpenClawClient extends EventEmitter {
  connectedState: boolean;
  connectError: Error | null = null;
  connectResultConnected: boolean;
  /** What the fake's `sessions.create` call returns — real gateway shape is
   *  `{ ok, key, sessionId, entry }` (U61/S2 evidence). */
  sessionResult: unknown = { key: 'agent:main:gw-sess-1', sessionId: 'gw-sess-1' };
  callCalls: Array<{ method: string; params?: Record<string, unknown> }> = [];
  connectWithAutoPairCalls = 0;
  notificationsOnSend: FakeNotification[] = [];

  constructor(opts: { connected?: boolean; connectResultConnected?: boolean } = {}) {
    super();
    this.connectedState = opts.connected ?? false;
    this.connectResultConnected = opts.connectResultConnected ?? true;
  }

  isConnected(): boolean {
    return this.connectedState;
  }

  async connectWithAutoPair(): Promise<void> {
    this.connectWithAutoPairCalls++;
    if (this.connectError) throw this.connectError;
    this.connectedState = this.connectResultConnected;
  }

  async call<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
    this.callCalls.push({ method, params });
    if (method === 'sessions.create') {
      return this.sessionResult as T;
    }
    if (method === 'sessions.send') {
      const resolvedSessionId =
        (this.sessionResult as { sessionId?: string; key?: string })?.sessionId ??
        (this.sessionResult as { key?: string })?.key ??
        String(params?.key ?? '');
      for (const n of this.notificationsOnSend) {
        const notifParams =
          n.params && typeof n.params === 'object' && !Array.isArray(n.params)
            ? { session_id: resolvedSessionId, ...(n.params as Record<string, unknown>) }
            : n.params;
        this.emit('notification', { method: n.method, params: notifParams });
      }
      return { ok: true, runId: 'fake-run', status: 'started' } as T;
    }
    throw new Error(`FakeOpenClawClient: unexpected call ${method}`);
  }

  get sendMessageCalls() {
    return this.callCalls
      .filter((c) => c.method === 'sessions.send')
      .map((c) => ({ key: String(c.params?.key ?? ''), message: String(c.params?.message ?? '') }));
  }

  get createSessionCalls() {
    return this.callCalls.filter((c) => c.method === 'sessions.create').map((c) => c.params);
  }
}

let fakeClient: FakeOpenClawClient;

/** Load the module under test with '@/lib/openclaw/client' replaced by a fake
 *  whose getOpenClawClient() always returns the current `fakeClient`. */
async function loadGateway() {
  vi.doMock('@/lib/openclaw/client', () => ({
    getOpenClawClient: () => fakeClient,
  }));
  return import('@/lib/ceo-chat/gateway');
}

async function collect(gen: AsyncGenerator<ChatChunk>): Promise<ChatChunk[]> {
  const out: ChatChunk[] = [];
  for await (const c of gen) out.push(c);
  return out;
}

const REQ: ForwardRequest = {
  sessionId: 'ceo-chat-session-1',
  content: 'hello agent',
  metadata: { requester_channel: 'ceo-chat', requester_chat_id: 'ceo-chat-session-1' },
};

describe('gatewayTransport.forward — the REAL transport, driven by a fake OpenClawClient', () => {
  beforeEach(() => {
    vi.resetModules();
    delete process.env.CEO_CHAT_REPLY_TIMEOUT_MS;
    delete process.env.CEO_CHAT_CONNECT_TIMEOUT_MS;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.CEO_CHAT_REPLY_TIMEOUT_MS;
    delete process.env.CEO_CHAT_CONNECT_TIMEOUT_MS;
  });

  it('bridges notification events through the bounded queue and closes on a completion-style method (queue bridge)', async () => {
    fakeClient = new FakeOpenClawClient({ connected: true });
    fakeClient.notificationsOnSend = [
      { method: 'agent.token', params: { delta: 'Hello ' } },
      { method: 'agent.token', params: { delta: 'world' } },
      { method: 'agent.turn.complete', params: {} },
    ];
    const { gatewayTransport } = await loadGateway();

    const chunks = await collect(gatewayTransport.forward(REQ));

    expect(chunks).toEqual([
      { type: 'routed', agentId: 'main' },
      { type: 'token', text: 'Hello ' },
      { type: 'token', text: 'world' },
      { type: 'done' },
    ]);
    // Already connected — the connect path must not fire.
    expect(fakeClient.connectWithAutoPairCalls).toBe(0);
    // The 'notification' listener registered for the bridge must be torn down.
    expect(fakeClient.listenerCount('notification')).toBe(0);
  });

  it('does not end the stream on a non-completion method name, only on one that actually matches the regex', async () => {
    fakeClient = new FakeOpenClawClient({ connected: true });
    fakeClient.notificationsOnSend = [
      { method: 'agent.progress', params: { delta: 'partial' } }, // must NOT match
      { method: 'agent.reply.finished', params: {} }, // must match ("finished")
    ];
    const { gatewayTransport } = await loadGateway();

    const chunks = await collect(gatewayTransport.forward(REQ));

    // A false-positive match on "progress" would truncate the token; a
    // false-negative on "finished" would hang past REPLY_TIMEOUT_MS.
    expect(chunks).toEqual([{ type: 'routed', agentId: 'main' }, { type: 'token', text: 'partial' }, { type: 'done' }]);
  });

  it('extractText(): delta wins over every other known key', async () => {
    fakeClient = new FakeOpenClawClient({ connected: true });
    fakeClient.notificationsOnSend = [
      { method: 'agent.token', params: { delta: 'D', text: 'T', content: 'C', chunk: 'K', token: 'K2', message: 'M' } },
      { method: 'agent.done', params: {} },
    ];
    const { gatewayTransport } = await loadGateway();
    const chunks = await collect(gatewayTransport.forward(REQ));
    expect(chunks.find((c) => c.type === 'token')).toEqual({ type: 'token', text: 'D' });
  });

  it('extractText(): text wins when delta is absent', async () => {
    fakeClient = new FakeOpenClawClient({ connected: true });
    fakeClient.notificationsOnSend = [
      { method: 'agent.token', params: { text: 'T', content: 'C', chunk: 'K', token: 'K2', message: 'M' } },
      { method: 'agent.done', params: {} },
    ];
    const { gatewayTransport } = await loadGateway();
    const chunks = await collect(gatewayTransport.forward(REQ));
    expect(chunks.find((c) => c.type === 'token')).toEqual({ type: 'token', text: 'T' });
  });

  it('extractText(): content wins when delta/text are absent', async () => {
    fakeClient = new FakeOpenClawClient({ connected: true });
    fakeClient.notificationsOnSend = [
      { method: 'agent.token', params: { content: 'C', chunk: 'K', token: 'K2', message: 'M' } },
      { method: 'agent.done', params: {} },
    ];
    const { gatewayTransport } = await loadGateway();
    const chunks = await collect(gatewayTransport.forward(REQ));
    expect(chunks.find((c) => c.type === 'token')).toEqual({ type: 'token', text: 'C' });
  });

  it('extractText(): chunk wins when delta/text/content are absent', async () => {
    fakeClient = new FakeOpenClawClient({ connected: true });
    fakeClient.notificationsOnSend = [
      { method: 'agent.token', params: { chunk: 'K', token: 'K2', message: 'M' } },
      { method: 'agent.done', params: {} },
    ];
    const { gatewayTransport } = await loadGateway();
    const chunks = await collect(gatewayTransport.forward(REQ));
    expect(chunks.find((c) => c.type === 'token')).toEqual({ type: 'token', text: 'K' });
  });

  it('extractText(): token wins when only token/message remain', async () => {
    fakeClient = new FakeOpenClawClient({ connected: true });
    fakeClient.notificationsOnSend = [
      { method: 'agent.token', params: { token: 'K2', message: 'M' } },
      { method: 'agent.done', params: {} },
    ];
    const { gatewayTransport } = await loadGateway();
    const chunks = await collect(gatewayTransport.forward(REQ));
    expect(chunks.find((c) => c.type === 'token')).toEqual({ type: 'token', text: 'K2' });
  });

  it('extractText(): message is the last resort', async () => {
    fakeClient = new FakeOpenClawClient({ connected: true });
    fakeClient.notificationsOnSend = [
      { method: 'agent.token', params: { message: 'M' } },
      { method: 'agent.done', params: {} },
    ];
    const { gatewayTransport } = await loadGateway();
    const chunks = await collect(gatewayTransport.forward(REQ));
    expect(chunks.find((c) => c.type === 'token')).toEqual({ type: 'token', text: 'M' });
  });

  it('extractText(): a bare-string (session-less) payload is dropped by the session-isolation filter', async () => {
    fakeClient = new FakeOpenClawClient({ connected: true });
    fakeClient.notificationsOnSend = [
      { method: 'agent.token', params: 'raw-string-payload' },
      { method: 'agent.done', params: {} },
    ];
    const { gatewayTransport } = await loadGateway();
    const chunks = await collect(gatewayTransport.forward(REQ));
    expect(chunks).toEqual([{ type: 'routed', agentId: 'main' }, { type: 'done' }]);
  });

  it('extractText(): no token for a payload with none of the known keys, a non-object payload, or a null payload', async () => {
    fakeClient = new FakeOpenClawClient({ connected: true });
    fakeClient.notificationsOnSend = [
      { method: 'agent.token', params: { unrelated: 'nope' } },
      { method: 'agent.token', params: 42 },
      { method: 'agent.token', params: null },
      { method: 'agent.done', params: {} },
    ];
    const { gatewayTransport } = await loadGateway();

    const chunks = await collect(gatewayTransport.forward(REQ));

    expect(chunks).toEqual([{ type: 'routed', agentId: 'main' }, { type: 'done' }]);
  });

  it("U62: addresses sessions.create with the proven `key` shape (agent:main:<peer> when no agentId given), never {channel,peer}", async () => {
    fakeClient = new FakeOpenClawClient({ connected: true });
    fakeClient.notificationsOnSend = [{ method: 'done', params: {} }];
    const { gatewayTransport } = await loadGateway();

    await collect(gatewayTransport.forward(REQ));

    expect(fakeClient.sendMessageCalls).toEqual([{ key: 'agent:main:ceo-chat-session-1', message: REQ.content }]);
    expect(fakeClient.createSessionCalls).toEqual([{ key: 'agent:main:ceo-chat-session-1' }]);
  });

  it('U62: an explicit agentId builds the key as agent:<agentId>:<peer> and is echoed on the routed chunk', async () => {
    fakeClient = new FakeOpenClawClient({ connected: true });
    fakeClient.notificationsOnSend = [{ method: 'done', params: {} }];
    const { gatewayTransport } = await loadGateway();

    const chunks = await collect(gatewayTransport.forward({ ...REQ, agentId: 'bug-fix-triager' }));

    expect(chunks[0]).toEqual({ type: 'routed', agentId: 'bug-fix-triager' });
    expect(fakeClient.createSessionCalls).toEqual([{ key: 'agent:bug-fix-triager:ceo-chat-session-1' }]);
  });

  it('U62: an explicit model rides on sessions.create only — never on sessions.send', async () => {
    fakeClient = new FakeOpenClawClient({ connected: true });
    fakeClient.notificationsOnSend = [{ method: 'done', params: {} }];
    const { gatewayTransport } = await loadGateway();

    await collect(gatewayTransport.forward({ ...REQ, model: 'ollama/deepseek-v4-flash:cloud' }));

    const createCall = fakeClient.callCalls.find((c) => c.method === 'sessions.create');
    const sendCall = fakeClient.callCalls.find((c) => c.method === 'sessions.send');
    expect(createCall?.params?.model).toBe('ollama/deepseek-v4-flash:cloud');
    expect(sendCall?.params).not.toHaveProperty('model');
  });

  it('U62: an explicit thinkingLevel rides on sessions.send only — never on sessions.create — and is NEVER the literal "max"', async () => {
    fakeClient = new FakeOpenClawClient({ connected: true });
    fakeClient.notificationsOnSend = [{ method: 'done', params: {} }];
    const { gatewayTransport } = await loadGateway();

    await collect(gatewayTransport.forward({ ...REQ, thinkingLevel: 'high' }));

    const createCall = fakeClient.callCalls.find((c) => c.method === 'sessions.create');
    const sendCall = fakeClient.callCalls.find((c) => c.method === 'sessions.send');
    expect(createCall?.params).not.toHaveProperty('thinking');
    expect(sendCall?.params?.thinking).toBe('high');
    expect(sendCall?.params?.thinking).not.toBe('max');
  });

  it('U62: omitting model/thinkingLevel/agentId reproduces the exact Phase-A wire shape (optional-additive)', async () => {
    fakeClient = new FakeOpenClawClient({ connected: true });
    fakeClient.notificationsOnSend = [{ method: 'done', params: {} }];
    const { gatewayTransport } = await loadGateway();

    await collect(gatewayTransport.forward(REQ));

    const createCall = fakeClient.callCalls.find((c) => c.method === 'sessions.create');
    const sendCall = fakeClient.callCalls.find((c) => c.method === 'sessions.send');
    expect(createCall?.params).toEqual({ key: 'agent:main:ceo-chat-session-1' });
    expect(sendCall?.params).toEqual({ key: 'agent:main:ceo-chat-session-1', message: REQ.content });
  });

  it('U62: a usage-bearing completion notification is re-surfaced as a `usage` chunk before `done`', async () => {
    fakeClient = new FakeOpenClawClient({ connected: true });
    fakeClient.notificationsOnSend = [
      {
        method: 'agent.turn.complete',
        params: { usage: { input: 16026, output: 28, total: 16054 } },
      },
    ];
    const { gatewayTransport } = await loadGateway();

    const chunks = await collect(gatewayTransport.forward(REQ));

    const usageIdx = chunks.findIndex((c) => c.type === 'usage');
    const doneIdx = chunks.findIndex((c) => c.type === 'done');
    expect(usageIdx).toBeGreaterThanOrEqual(0);
    expect(usageIdx).toBeLessThan(doneIdx);
    expect(chunks[usageIdx]).toEqual({ type: 'usage', usage: { input: 16026, output: 28, total: 16054 } });
  });

  it('U62: no usage chunk is emitted when the completion notification carries no recognizable usage object (never fabricates one)', async () => {
    fakeClient = new FakeOpenClawClient({ connected: true });
    fakeClient.notificationsOnSend = [{ method: 'agent.turn.complete', params: {} }];
    const { gatewayTransport } = await loadGateway();

    const chunks = await collect(gatewayTransport.forward(REQ));

    expect(chunks.some((c) => c.type === 'usage')).toBe(false);
  });

  it("extracts the gateway session id from sessions.create's `sessionId` field and uses the built `key` for sessions.send", async () => {
    fakeClient = new FakeOpenClawClient({ connected: true });
    fakeClient.sessionResult = { key: 'agent:main:ceo-chat-session-1', sessionId: 'gw-id-123' };
    fakeClient.notificationsOnSend = [{ method: 'done', params: {} }];
    const { gatewayTransport } = await loadGateway();

    const chunks = await collect(gatewayTransport.forward(REQ));

    // sessions.send always addresses by the CONSTANT `key`, never the resolved sessionId.
    expect(fakeClient.sendMessageCalls).toEqual([{ key: 'agent:main:ceo-chat-session-1', message: REQ.content }]);
    // But notification filtering used `sessionId` ('gw-id-123', stamped by the fake's call()
    // dispatcher onto every replayed notification) — proven by the token actually landing.
    expect(chunks.some((c) => c.type === 'done')).toBe(true);
  });

  it('falls back to `key` when `sessionId` is absent from the sessions.create response', async () => {
    fakeClient = new FakeOpenClawClient({ connected: true });
    fakeClient.sessionResult = { key: 'agent:main:ceo-chat-session-1' };
    fakeClient.notificationsOnSend = [{ method: 'done', params: {} }];
    const { gatewayTransport } = await loadGateway();

    const chunks = await collect(gatewayTransport.forward(REQ));

    expect(chunks.some((c) => c.type === 'done')).toBe(true);
  });

  it('falls back to the locally-built `key` when the sessions.create response carries neither `sessionId` nor `key` (never req.sessionId — the gateway has no reason to ever echo a CC-internal id)', async () => {
    fakeClient = new FakeOpenClawClient({ connected: true });
    fakeClient.sessionResult = {};
    fakeClient.notificationsOnSend = [{ method: 'done', params: {} }];
    const { gatewayTransport } = await loadGateway();

    const chunks = await collect(gatewayTransport.forward(REQ));

    expect(chunks.some((c) => c.type === 'done')).toBe(true);
  });

  it('ends the stream on REPLY_TIMEOUT_MS when the agent never signals completion (fallback, not a hang)', async () => {
    process.env.CEO_CHAT_REPLY_TIMEOUT_MS = '30';
    fakeClient = new FakeOpenClawClient({ connected: true });
    // No completion-matching method — the ONLY way this stream ends is the
    // REPLY_TIMEOUT_MS setTimeout fallback.
    fakeClient.notificationsOnSend = [{ method: 'agent.progress', params: { delta: 'still going' } }];
    const { gatewayTransport } = await loadGateway();

    const startedMs = Date.now();
    const chunks = await collect(gatewayTransport.forward(REQ));
    const elapsedMs = Date.now() - startedMs;

    expect(chunks).toEqual([{ type: 'routed', agentId: 'main' }, { type: 'token', text: 'still going' }, { type: 'done' }]);
    // Bounded below by the configured timeout (with slack for scheduler
    // jitter), and nowhere near the 120s production default — proves the env
    // override was actually read, not just that the stream eventually ends.
    expect(elapsedMs).toBeGreaterThanOrEqual(25);
    expect(elapsedMs).toBeLessThan(5000);
  });

  it('yields a single gateway_down chunk (never throws) when connectWithAutoPair() rejects', async () => {
    fakeClient = new FakeOpenClawClient({ connected: false });
    fakeClient.connectError = new Error('ECONNREFUSED 127.0.0.1:18789');
    const { gatewayTransport } = await loadGateway();

    const chunks = await collect(gatewayTransport.forward(REQ));

    expect(chunks).toEqual([{ type: 'gateway_down', message: 'ECONNREFUSED 127.0.0.1:18789' }]);
    expect(fakeClient.createSessionCalls).toEqual([]); // never reached the send path
    expect(fakeClient.sendMessageCalls).toEqual([]);
  });

  it('yields a single gateway_down chunk when connectWithAutoPair() resolves but the client is still not connected', async () => {
    fakeClient = new FakeOpenClawClient({ connected: false, connectResultConnected: false });
    const { gatewayTransport } = await loadGateway();

    const chunks = await collect(gatewayTransport.forward(REQ));

    expect(chunks).toEqual([
      { type: 'gateway_down', message: 'The on-box agent gateway is not reachable right now.' },
    ]);
    expect(fakeClient.connectWithAutoPairCalls).toBe(1);
    expect(fakeClient.createSessionCalls).toEqual([]);
  });
});
