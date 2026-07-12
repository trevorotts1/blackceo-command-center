/**
 * P5-01 — My AI CEO gateway forwarder (transport seam).
 *
 * The route forwards a message through forwardToAgent(), which streams reply
 * chunks. The QC (e) break-it list includes "send while gateway is down (graceful
 * state, never lost silently)". We prove both paths with a FAKE transport (no
 * live gateway): a streaming reply is relayed, and a gateway-down transport
 * yields a single `gateway_down` chunk (never throws) so the route can degrade to
 * "use Telegram meanwhile".
 *
 * Fail-first: src/lib/ceo-chat/gateway.ts does not exist pre-P5-01.
 */
import { describe, it, expect } from 'vitest';
import { forwardToAgent, type ChatTransport, type ChatChunk } from '@/lib/ceo-chat/gateway';

async function collect(gen: AsyncGenerator<ChatChunk>): Promise<ChatChunk[]> {
  const out: ChatChunk[] = [];
  for await (const c of gen) out.push(c);
  return out;
}

describe('forwardToAgent', () => {
  it('relays a streamed reply (tokens then done)', async () => {
    let seenMeta: { requester_channel: string; requester_chat_id: string } | null = null;
    const fake: ChatTransport = {
      async probe() {
        return { up: true };
      },
      async *forward(req) {
        seenMeta = req.metadata;
        yield { type: 'token', text: 'Hello ' };
        yield { type: 'token', text: 'world' };
        yield { type: 'done' };
      },
    };

    const chunks = await collect(
      forwardToAgent(
        { sessionId: 's1', content: 'hi', metadata: { requester_channel: 'ceo-chat', requester_chat_id: 's1' } },
        fake,
      ),
    );

    const tokens = chunks.filter((c) => c.type === 'token').map((c) => (c as { text: string }).text);
    expect(tokens.join('')).toBe('Hello world');
    expect(chunks.some((c) => c.type === 'done')).toBe(true);
    // The agent is handed the ceo-chat channel + session id so any task it routes
    // reports back into THIS UI (P5-01 step 2).
    expect(seenMeta).toEqual({ requester_channel: 'ceo-chat', requester_chat_id: 's1' });
  });

  it('degrades gracefully when the gateway is down (yields gateway_down, never throws)', async () => {
    const downTransport: ChatTransport = {
      async probe() {
        return { up: false, detail: 'ECONNREFUSED' };
      },
      async *forward() {
        yield { type: 'gateway_down', message: 'The on-box agent gateway is not reachable right now.' };
      },
    };

    const chunks = await collect(
      forwardToAgent(
        { sessionId: 's2', content: 'hi', metadata: { requester_channel: 'ceo-chat', requester_chat_id: 's2' } },
        downTransport,
      ),
    );

    expect(chunks).toHaveLength(1);
    expect(chunks[0].type).toBe('gateway_down');
  });
});
