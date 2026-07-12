/**
 * P5-01 — My AI CEO gateway forwarder: the REAL gatewayTransport.
 *
 * ceo-chat-gateway-forward.test.ts proves forwardToAgent() against a trivial
 * pass-through FAKE ChatTransport — it never exercises `gatewayTransport`
 * itself. Everything gatewayTransport.forward() actually does was untested:
 *   - the bounded queue that bridges the OpenClawClient EventEmitter into an
 *     async generator (push/resolveNext/close),
 *   - extractText()'s key-precedence order over an arbitrary notification
 *     payload (delta > text > content > chunk > token > message),
 *   - the completion-method regex that ends the stream,
 *   - the REPLY_TIMEOUT_MS fallback when the agent never signals completion,
 *   - createSession()'s response id extraction (`id` -> `session_id` -> the
 *     CC-side req.sessionId), and
 *   - the connect-failure `gateway_down` degrade path (both a thrown connect
 *     error and a connect that resolves without ending up connected).
 * A mutation to any of those lines passed the whole suite before this file.
 *
 * This drives the REAL `gatewayTransport` export against a fake
 * OpenClawClient — a plain EventEmitter implementing just the subset of the
 * client gatewayTransport calls (isConnected/connectWithAutoPair/
 * createSession/sendMessage/on/off) — so the mutation-sensitive behavior is
 * proven without a live gateway.
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
 * surface gatewayTransport.forward()/probe() touch. Notifications queued in
 * `notificationsOnSend` are emitted synchronously from inside sendMessage(),
 * AFTER forward() has already registered its 'notification' listener (it
 * does so before calling createSession/sendMessage, exactly like the real
 * transport) — so they land deterministically without relying on real timers.
 */
class FakeOpenClawClient extends EventEmitter {
  connectedState: boolean;
  connectError: Error | null = null;
  connectResultConnected: boolean;
  sessionResult: unknown = { id: 'gw-sess-1' };
  sendMessageCalls: Array<{ sessionId: string; content: string }> = [];
  createSessionCalls: Array<{ channel: string; peer?: string }> = [];
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

  async createSession(channel: string, peer?: string): Promise<unknown> {
    this.createSessionCalls.push({ channel, peer });
    return this.sessionResult;
  }

  async sendMessage(sessionId: string, content: string): Promise<void> {
    this.sendMessageCalls.push({ sessionId, content });
    for (const n of this.notificationsOnSend) {
      // P5-01 session-isolation fix (gateway.ts extractSessionId): forward()
      // now relays only notifications whose params carry ITS OWN resolved
      // gateway session id, dropping unattributable frames. The REAL gateway
      // stamps that id on every frame it emits for the session, so mirror
      // that here — inject the resolved `sessionId` into each object-shaped
      // params (a test may still pin its own session_id; the spread lets the
      // test's value win). Non-object params (bare string / number / null)
      // cannot carry an id and are therefore dropped by the filter, which the
      // bare-string case below asserts explicitly.
      const params =
        n.params && typeof n.params === 'object' && !Array.isArray(n.params)
          ? { session_id: sessionId, ...(n.params as Record<string, unknown>) }
          : n.params;
      this.emit('notification', { method: n.method, params });
    }
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
    expect(chunks).toEqual([{ type: 'token', text: 'partial' }, { type: 'done' }]);
  });

  it('extractText(): delta wins over every other known key', async () => {
    fakeClient = new FakeOpenClawClient({ connected: true });
    fakeClient.notificationsOnSend = [
      { method: 'agent.token', params: { delta: 'D', text: 'T', content: 'C', chunk: 'K', token: 'K2', message: 'M' } },
      { method: 'agent.done', params: {} },
    ];
    const { gatewayTransport } = await loadGateway();
    const chunks = await collect(gatewayTransport.forward(REQ));
    expect(chunks[0]).toEqual({ type: 'token', text: 'D' });
  });

  it('extractText(): text wins when delta is absent', async () => {
    fakeClient = new FakeOpenClawClient({ connected: true });
    fakeClient.notificationsOnSend = [
      { method: 'agent.token', params: { text: 'T', content: 'C', chunk: 'K', token: 'K2', message: 'M' } },
      { method: 'agent.done', params: {} },
    ];
    const { gatewayTransport } = await loadGateway();
    const chunks = await collect(gatewayTransport.forward(REQ));
    expect(chunks[0]).toEqual({ type: 'token', text: 'T' });
  });

  it('extractText(): content wins when delta/text are absent', async () => {
    fakeClient = new FakeOpenClawClient({ connected: true });
    fakeClient.notificationsOnSend = [
      { method: 'agent.token', params: { content: 'C', chunk: 'K', token: 'K2', message: 'M' } },
      { method: 'agent.done', params: {} },
    ];
    const { gatewayTransport } = await loadGateway();
    const chunks = await collect(gatewayTransport.forward(REQ));
    expect(chunks[0]).toEqual({ type: 'token', text: 'C' });
  });

  it('extractText(): chunk wins when delta/text/content are absent', async () => {
    fakeClient = new FakeOpenClawClient({ connected: true });
    fakeClient.notificationsOnSend = [
      { method: 'agent.token', params: { chunk: 'K', token: 'K2', message: 'M' } },
      { method: 'agent.done', params: {} },
    ];
    const { gatewayTransport } = await loadGateway();
    const chunks = await collect(gatewayTransport.forward(REQ));
    expect(chunks[0]).toEqual({ type: 'token', text: 'K' });
  });

  it('extractText(): token wins when only token/message remain', async () => {
    fakeClient = new FakeOpenClawClient({ connected: true });
    fakeClient.notificationsOnSend = [
      { method: 'agent.token', params: { token: 'K2', message: 'M' } },
      { method: 'agent.done', params: {} },
    ];
    const { gatewayTransport } = await loadGateway();
    const chunks = await collect(gatewayTransport.forward(REQ));
    expect(chunks[0]).toEqual({ type: 'token', text: 'K2' });
  });

  it('extractText(): message is the last resort', async () => {
    fakeClient = new FakeOpenClawClient({ connected: true });
    fakeClient.notificationsOnSend = [
      { method: 'agent.token', params: { message: 'M' } },
      { method: 'agent.done', params: {} },
    ];
    const { gatewayTransport } = await loadGateway();
    const chunks = await collect(gatewayTransport.forward(REQ));
    expect(chunks[0]).toEqual({ type: 'token', text: 'M' });
  });

  it('extractText(): a bare-string (session-less) payload is dropped by the session-isolation filter', async () => {
    // extractText() itself still handles a bare-string payload (unit-covered
    // by its precedence cases above via the injected session id), but at the
    // forward() boundary a bare-string frame carries NO gateway session id, so
    // the P5-01 session-isolation fix (extractSessionId → drop unattributable)
    // supersedes the old "relay a raw string as-is" path: the frame is dropped,
    // and only the session-scoped completion ends the stream.
    fakeClient = new FakeOpenClawClient({ connected: true });
    fakeClient.notificationsOnSend = [
      { method: 'agent.token', params: 'raw-string-payload' },
      { method: 'agent.done', params: {} },
    ];
    const { gatewayTransport } = await loadGateway();
    const chunks = await collect(gatewayTransport.forward(REQ));
    expect(chunks).toEqual([{ type: 'done' }]);
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

    expect(chunks).toEqual([{ type: 'done' }]);
  });

  it("extracts the gateway session id from createSession()'s `id` field and uses it for sendMessage", async () => {
    fakeClient = new FakeOpenClawClient({ connected: true });
    fakeClient.sessionResult = { id: 'gw-id-123', session_id: 'should-be-ignored' };
    fakeClient.notificationsOnSend = [{ method: 'done', params: {} }];
    const { gatewayTransport } = await loadGateway();

    await collect(gatewayTransport.forward(REQ));

    expect(fakeClient.sendMessageCalls).toEqual([{ sessionId: 'gw-id-123', content: REQ.content }]);
    expect(fakeClient.createSessionCalls).toEqual([
      { channel: REQ.metadata.requester_channel, peer: REQ.metadata.requester_chat_id },
    ]);
  });

  it('falls back to `session_id` when `id` is absent from the createSession() response', async () => {
    fakeClient = new FakeOpenClawClient({ connected: true });
    fakeClient.sessionResult = { session_id: 'gw-id-456' };
    fakeClient.notificationsOnSend = [{ method: 'done', params: {} }];
    const { gatewayTransport } = await loadGateway();

    await collect(gatewayTransport.forward(REQ));

    expect(fakeClient.sendMessageCalls).toEqual([{ sessionId: 'gw-id-456', content: REQ.content }]);
  });

  it('falls back to the CC-side req.sessionId when the gateway session carries neither `id` nor `session_id`', async () => {
    fakeClient = new FakeOpenClawClient({ connected: true });
    fakeClient.sessionResult = {};
    fakeClient.notificationsOnSend = [{ method: 'done', params: {} }];
    const { gatewayTransport } = await loadGateway();

    await collect(gatewayTransport.forward(REQ));

    expect(fakeClient.sendMessageCalls).toEqual([{ sessionId: REQ.sessionId, content: REQ.content }]);
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

    expect(chunks).toEqual([{ type: 'token', text: 'still going' }, { type: 'done' }]);
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
