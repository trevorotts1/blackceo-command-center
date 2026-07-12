/**
 * P5-01 FIX — gatewayTransport.forward() must session-filter the shared
 * gateway 'notification' relay.
 *
 * THE BUG THIS EXISTS TO PREVENT
 * -------------------------------
 * `getOpenClawClient()` caches ONE client instance per target (client.ts:832)
 * — every concurrent ceo-chat request against the same box (two tabs, two
 * chats) shares the '__self__' singleton and therefore its single
 * 'notification' event stream. Before this fix, `gatewayTransport.forward()`
 * registered an unfiltered 'notification' listener that relayed
 * `extractText()` from EVERY notification on that shared client, and closed
 * its own stream on ANY completion-shaped event (`/complete|done|idle
 * |finished|end/`), regardless of which gateway session emitted it. Two
 * concurrent chats therefore (a) interleaved each other's tokens and (b) a
 * foreign chat's completion event could close the wrong stream before it
 * ever received its own reply.
 *
 * This suite drives the REAL `gatewayTransport` (not the fake ChatTransport
 * seam covered by ceo-chat-gateway-forward.test.ts) against a fake
 * '@/lib/openclaw/client' that behaves exactly like the real shared
 * EventEmitter-based singleton: one instance, `sessions.create` mints a
 * distinct gateway session id per call, and 'notification' is a single
 * shared event stream carrying frames for BOTH sessions.
 *
 * Vitest (not the tsx --test glob): uses vi.doMock + dynamic import of an
 * '@/...'-aliased dep tree — mirrors tests/unit/provider-key-auth-store.test.ts.
 * Registered in vitest.config.ts `include`.
 */
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import type { ChatChunk } from '@/lib/ceo-chat/gateway';

/** Matches the subset of OpenClawClient that gatewayTransport.forward() calls. */
class FakeGatewayClient extends EventEmitter {
  private sessionCounter = 0;
  public sentMessages: { sessionId: string; content: string }[] = [];
  private waiters: { count: number; resolve: () => void }[] = [];

  isConnected(): boolean {
    return true;
  }

  async connectWithAutoPair(): Promise<void> {
    // Already connected — never exercised in this suite.
  }

  /** Mirrors OpenClawClient.createSession: mints a NEW gateway session id
   *  per call, even though every call shares this ONE client instance. */
  async createSession(channel: string, peer?: string): Promise<{ id: string; channel: string; peer?: string; status: string }> {
    this.sessionCounter += 1;
    return { id: `gw-sess-${this.sessionCounter}`, channel, peer, status: 'active' };
  }

  async sendMessage(sessionId: string, content: string): Promise<void> {
    this.sentMessages.push({ sessionId, content });
    this.waiters = this.waiters.filter((w) => {
      if (this.sentMessages.length >= w.count) {
        w.resolve();
        return false;
      }
      return true;
    });
  }

  /** Test hook: resolves once `count` forward() calls have reached
   *  sendMessage() — i.e. their 'notification' listener is registered and
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
    expect(gwA).not.toBe(gwB); // sessions.create minted two DISTINCT gateway ids

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

    // Wait for the single sendMessage call to land.
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
});
