/**
 * P5-01 FIX (session-scoped relay) + U62 (JM/U65, master E.2) Phase-B
 * addressing — gatewayTransport.forward() must session-filter the shared
 * gateway 'notification' relay, AND (U62) must address sessions via the
 * U61/S2-proven structured `key` RPC param, never the legacy {channel,peer}
 * shape this gateway version (2026.6.11) rejects outright
 * (`unexpected property 'channel'` — see
 * `~/Downloads/skill6-u61-spike-S2-agent-addressing-2026-07-16.md`).
 *
 * THE BUG THIS EXISTS TO PREVENT (original P5-01 fix)
 * -------------------------------
 * `getOpenClawClient()` caches ONE client instance per target (client.ts:832)
 * — every concurrent ceo-chat request against the same box (two tabs, two
 * chats) shares the '__self__' singleton and therefore its single
 * 'notification' event stream. Before that fix, `gatewayTransport.forward()`
 * registered an unfiltered 'notification' listener that relayed
 * `extractText()` from EVERY notification on that shared client, and closed
 * its own stream on ANY completion-shaped event, regardless of which gateway
 * session emitted it.
 *
 * WHAT U62 CHANGES HERE
 * ----------------------
 * `gatewayTransport.forward()` no longer calls the legacy
 * `client.createSession(channel, peer)` / `client.sendMessage(sessionId,
 * content)` methods (U61/S1-S2 proved this gateway version rejects their
 * params shapes outright: `sessions.create` rejects a bare `channel` field;
 * `sessions.send` rejects `content` and requires `message`). It now calls the
 * ALREADY-PUBLIC `client.call(method, params)` RPC method directly with the
 * proven `key` addressing (`agent:<agentId>:<peer>`) — so this suite's fake
 * now implements `call()` instead of the two legacy methods. `key` is what
 * PINS a (agent, cc-session) pair to the SAME gateway session across turns
 * (continuity) and is WHY switching agent for one cc-session yields a
 * DIFFERENT key (non-interleaved per-agent threads — U65 acceptance).
 *
 * This suite drives the REAL `gatewayTransport` (not the fake ChatTransport
 * seam covered by ceo-chat-gateway-forward.test.ts) against a fake
 * '@/lib/openclaw/client' that behaves exactly like the real shared
 * EventEmitter-based singleton: one instance, `sessions.create` mints a
 * distinct gateway session id per NEW key (and reuses it for a repeated
 * key), and 'notification' is a single shared event stream carrying frames
 * for every session in flight.
 *
 * Vitest (not the tsx --test glob): uses vi.doMock + dynamic import of an
 * '@/...'-aliased dep tree — mirrors tests/unit/provider-key-auth-store.test.ts.
 * Registered in vitest.config.ts `include`.
 */
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import type { ChatChunk } from '@/lib/ceo-chat/gateway';

/** Matches the subset of OpenClawClient that gatewayTransport.forward() calls
 *  as of U62: isConnected/connectWithAutoPair/call/on/off. `call()` mirrors
 *  the real gateway's RPC dispatch — `sessions.create` mints (or reuses) a
 *  session id keyed by the `key` param; `sessions.send` looks that id up and
 *  replays any queued notifications for it, exactly like the real gateway
 *  pushing 'notification' frames on the shared client. */
class FakeGatewayClient extends EventEmitter {
  private sessionCounter = 0;
  private keyToSessionId = new Map<string, string>();
  public callCalls: Array<{ method: string; params?: Record<string, unknown> }> = [];
  public sentMessages: { sessionId: string; content: string; key: string }[] = [];
  private waiters: { count: number; resolve: () => void }[] = [];

  isConnected(): boolean {
    return true;
  }

  async connectWithAutoPair(): Promise<void> {
    // Already connected — never exercised in this suite.
  }

  async call<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
    this.callCalls.push({ method, params });
    if (method === 'sessions.create') {
      const key = String(params?.key ?? '');
      let sessionId = this.keyToSessionId.get(key);
      if (!sessionId) {
        this.sessionCounter += 1;
        sessionId = `gw-sess-${this.sessionCounter}`;
        this.keyToSessionId.set(key, sessionId);
      }
      return { ok: true, key, sessionId } as T;
    }
    if (method === 'sessions.send') {
      const key = String(params?.key ?? '');
      const content = String(params?.message ?? '');
      const sessionId = this.keyToSessionId.get(key) ?? key;
      this.sentMessages.push({ sessionId, content, key });
      this.waiters = this.waiters.filter((w) => {
        if (this.sentMessages.length >= w.count) {
          w.resolve();
          return false;
        }
        return true;
      });
      return { ok: true, runId: `run-${this.sentMessages.length}`, status: 'started' } as T;
    }
    throw new Error(`FakeGatewayClient: unexpected call ${method}`);
  }

  /** Test hook: resolves once `count` forward() calls have reached
   *  sessions.send — i.e. their 'notification' listener is registered and
   *  the generator is parked awaiting its next queued chunk. */
  waitForSentCount(count: number): Promise<void> {
    if (this.sentMessages.length >= count) return Promise.resolve();
    return new Promise((resolve) => {
      this.waiters.push({ count, resolve });
    });
  }
}

let fakeClient: FakeGatewayClient;

async function loadGatewayModule() {
  vi.doMock('@/lib/openclaw/client', () => ({
    getOpenClawClient: () => fakeClient,
  }));
  return await import('@/lib/ceo-chat/gateway');
}

async function collect(gen: AsyncGenerator<ChatChunk>): Promise<ChatChunk[]> {
  const out: ChatChunk[] = [];
  for await (const c of gen) out.push(c);
  return out;
}

function tick(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

describe('gatewayTransport.forward() — session-scoped notification relay', () => {
  beforeEach(() => {
    vi.resetModules();
    fakeClient = new FakeGatewayClient();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.CEO_CHAT_REPLY_TIMEOUT_MS;
  });

  test('two concurrent chats on the shared client each receive ONLY their own tokens and completion (fails pre-fix)', async () => {
    const { gatewayTransport } = await loadGatewayModule();

    const reqA = {
      sessionId: 'cc-session-A',
      content: 'hi from A',
      metadata: { requester_channel: 'ceo-chat', requester_chat_id: 'cc-session-A' },
    };
    const reqB = {
      sessionId: 'cc-session-B',
      content: 'hi from B',
      metadata: { requester_channel: 'ceo-chat', requester_chat_id: 'cc-session-B' },
    };

    // Start genA and drive it up to its own sendMessage() before starting
    // genB — this only serializes each generator's STARTUP (avoiding a
    // dynamic-import race in the test harness's module mocker when two
    // `await import('@/lib/openclaw/client')` calls land on the exact same
    // tick); both 'notification' listeners end up registered concurrently on
    // the ONE shared fakeClient regardless, which is what the fix must handle.
    const genA = gatewayTransport.forward(reqA);
    const collectedA = collect(genA);
    await fakeClient.waitForSentCount(1);

    const genB = gatewayTransport.forward(reqB);
    const collectedB = collect(genB);
    await fakeClient.waitForSentCount(2);

    const gwA = fakeClient.sentMessages.find((m) => m.content === 'hi from A')?.sessionId;
    const gwB = fakeClient.sentMessages.find((m) => m.content === 'hi from B')?.sessionId;
    expect(gwA).toBeTruthy();
    expect(gwB).toBeTruthy();
    expect(gwA).not.toBe(gwB); // distinct cc-session peers -> distinct keys -> distinct gateway ids

    // B's token, then B's OWN completion event — fires on the shared stream.
    fakeClient.emit('notification', { method: 'chat.token', params: { session_id: gwB, text: 'B1' } });
    fakeClient.emit('notification', { method: 'chat.complete', params: { session_id: gwB } });

    // Let the event loop actually resume/drain both generators before A's
    // own reply arrives. Pre-fix, session A's unfiltered listener treats B's
    // "chat.complete" as ITS OWN close signal here — closing (and
    // unregistering) A's stream before A ever sees its own token, so A's
    // real reply below is silently lost.
    await tick();
    await tick();

    // A's token, then A's OWN completion event.
    fakeClient.emit('notification', { method: 'chat.token', params: { session_id: gwA, text: 'A1' } });
    fakeClient.emit('notification', { method: 'chat.complete', params: { session_id: gwA } });

    const chunksA = await collectedA;
    const chunksB = await collectedB;

    const textA = chunksA.filter((c) => c.type === 'token').map((c) => (c as { text: string }).text).join('');
    const textB = chunksB.filter((c) => c.type === 'token').map((c) => (c as { text: string }).text).join('');

    // Each stream carries EXACTLY its own reply — no cross-contamination,
    // and A's own token was not lost to a premature foreign close.
    expect(textA).toBe('A1');
    expect(textB).toBe('B1');
    expect(chunksA.some((c) => c.type === 'done')).toBe(true);
    expect(chunksB.some((c) => c.type === 'done')).toBe(true);
  });

  test('a notification with no extractable session id is dropped, not relayed to either stream', async () => {
    const { gatewayTransport } = await loadGatewayModule();

    const reqA = {
      sessionId: 'cc-session-A2',
      content: 'hi again',
      metadata: { requester_channel: 'ceo-chat', requester_chat_id: 'cc-session-A2' },
    };

    const genA = gatewayTransport.forward(reqA);
    const collectedA = collect(genA);

    // Wait for the single sessions.send call to land.
    await new Promise<void>((resolve) => {
      const check = () => (fakeClient.sentMessages.length >= 1 ? resolve() : setTimeout(check, 0));
      check();
    });

    // An ambiguous frame — no session_id/sessionId/session/id anywhere.
    fakeClient.emit('notification', { method: 'chat.token', params: { text: 'unscoped' } });
    // A genuine completion for A's own session ends the stream cleanly.
    const gwA = fakeClient.sentMessages[0].sessionId;
    fakeClient.emit('notification', { method: 'chat.complete', params: { session_id: gwA } });

    const chunksA = await collectedA;
    const textA = chunksA.filter((c) => c.type === 'token').map((c) => (c as { text: string }).text).join('');

    expect(textA).toBe(''); // the unscoped frame was dropped, not relayed
    expect(chunksA.some((c) => c.type === 'done')).toBe(true);
  });

  test('U62: sessions.create is addressed with the proven `key` shape, never the legacy {channel,peer}', async () => {
    // This fake's sessions.send does not auto-emit a completion (the two
    // tests above rely on manually-timed emits to prove interleaving) — give
    // forward() a short REPLY_TIMEOUT_MS so it ends via the fallback timer
    // instead of hanging on the 120s production default.
    process.env.CEO_CHAT_REPLY_TIMEOUT_MS = '30';
    const { gatewayTransport } = await loadGatewayModule();
    fakeClient.callCalls = [];
    await collect(
      gatewayTransport.forward({
        sessionId: 'cc-session-key-shape',
        content: 'probe',
        metadata: { requester_channel: 'ceo-chat', requester_chat_id: 'cc-session-key-shape' },
      }),
    );

    const createCall = fakeClient.callCalls.find((c) => c.method === 'sessions.create');
    expect(createCall).toBeTruthy();
    expect(createCall!.params).not.toHaveProperty('channel');
    expect(createCall!.params).not.toHaveProperty('peer');
    expect(typeof createCall!.params?.key).toBe('string');
    expect(createCall!.params?.key).toMatch(/^agent:main:cc-session-key-shape$/);

    const sendCall = fakeClient.callCalls.find((c) => c.method === 'sessions.send');
    expect(sendCall).toBeTruthy();
    expect(sendCall!.params).not.toHaveProperty('content');
    expect(sendCall!.params).not.toHaveProperty('session_id');
    expect(sendCall!.params?.message).toBe('probe');
    expect(sendCall!.params?.key).toBe(createCall!.params?.key);
  });

  test('U62: switching agentId for the SAME cc-session yields a DIFFERENT key — non-interleaved per-agent threads', async () => {
    process.env.CEO_CHAT_REPLY_TIMEOUT_MS = '30';
    const { gatewayTransport } = await loadGatewayModule();

    const base = {
      sessionId: 'cc-session-multi-agent',
      metadata: { requester_channel: 'ceo-chat', requester_chat_id: 'cc-session-multi-agent' },
    };

    await collect(gatewayTransport.forward({ ...base, content: 'to agent A', agentId: 'agent-a' }));
    await collect(gatewayTransport.forward({ ...base, content: 'to agent B', agentId: 'agent-b' }));
    // A second turn to the SAME agent reuses the SAME key (continuity).
    await collect(gatewayTransport.forward({ ...base, content: 'to agent A again', agentId: 'agent-a' }));

    const sends = fakeClient.callCalls.filter((c) => c.method === 'sessions.send');
    const keyFor = (content: string) => sends.find((s) => s.params?.message === content)?.params?.key;

    expect(keyFor('to agent A')).toBe('agent:agent-a:cc-session-multi-agent');
    expect(keyFor('to agent B')).toBe('agent:agent-b:cc-session-multi-agent');
    expect(keyFor('to agent A again')).toBe(keyFor('to agent A')); // same (agent, session) -> same key -> continuity
    expect(keyFor('to agent B')).not.toBe(keyFor('to agent A')); // different agent -> different key -> non-interleaved
  });
});
