/**
 * U62 (JM/U65, master E.2) — POST /api/ceo-chat/message Phase-B passthrough.
 *
 * BINARY acceptance: "thread optional model, thinkingLevel, agentId through
 * POST /api/ceo-chat/message body -> extended ForwardRequest"; "in exact-usage
 * mode the meter never renders ≈ and the estimate->exact switchover happens
 * on the first usage frame"; SSE vocabulary extended (usage, routed), never a
 * new stream protocol.
 *
 * This suite proves the ROUTE'S OWN job: parsing + validating the three new
 * optional body fields, threading them into forwardToAgent()'s ForwardRequest
 * (mocked — gateway.ts's own transport correctness is proven separately in
 * ceo-chat-gateway-transport.test.ts), re-emitting `usage`/`routed` as new SSE
 * events, and persisting real usage onto the assistant's DB row so history can
 * echo it after a reload (migration 110).
 *
 * Two defense-in-depth guards proven here at the API boundary (never trust
 * the client alone):
 *   - thinkingLevel: the UI label ('Quick'..'Max') is translated server-side
 *     via toGatewayThinkingLevel(); a bogus value OR the literal broken
 *     strings "max"/"minimal" sent directly are silently dropped (message
 *     still sends — a soft enhancement failing must never break the whole
 *     chat turn) — NEVER threaded through to the gateway.
 *   - model: the sovereignty filter (isForbidden(), src/lib/model-selector.ts)
 *     is re-checked server-side — an Anthropic-prefixed model is REJECTED
 *     (400), never silently substituted or silently dropped, because letting
 *     a forbidden model quietly through would violate a hard, existing
 *     invariant (M.4 non-goals: "the sovereignty filter is a hard gate in
 *     every model list this section ships").
 *
 * Isolated temp DB (mirrors ceo-chat-task-endpoint.test.ts); forwardToAgent is
 * replaced via vi.doMock so no live gateway is touched — vitest-only
 * (registered in vitest.config.ts, same reason as its ceo-chat-gateway-*
 * siblings).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NextRequest } from 'next/server';
import type { ChatChunk, ForwardRequest } from '@/lib/ceo-chat/gateway';

const TMP_DB = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'bc-ceo-chat-msg-')),
  'mission-control.test.db',
);
process.env.DATABASE_PATH = TMP_DB;
delete process.env.MY_AI_CEO_BETA;

let capturedRequests: ForwardRequest[] = [];
let canned: ChatChunk[] = [{ type: 'token', text: 'Hello.' }, { type: 'done' }];

vi.doMock('@/lib/ceo-chat/gateway', async () => {
  const actual = await vi.importActual<typeof import('@/lib/ceo-chat/gateway')>('@/lib/ceo-chat/gateway');
  return {
    ...actual,
    async *forwardToAgent(req: ForwardRequest) {
      capturedRequests.push(req);
      for (const chunk of canned) yield chunk;
    },
  };
});

type DbModule = typeof import('@/lib/db');
type StoreModule = typeof import('@/lib/ceo-chat/store');
type RouteModule = typeof import('@/app/api/ceo-chat/message/route');

let getDb: DbModule['getDb'];
let queryAll: DbModule['queryAll'];
let getCeoChatHistory: StoreModule['getCeoChatHistory'];
let POST: RouteModule['POST'];

beforeAll(async () => {
  const db = await import('@/lib/db');
  getDb = db.getDb;
  queryAll = db.queryAll;
  getDb();

  const store = await import('@/lib/ceo-chat/store');
  getCeoChatHistory = store.getCeoChatHistory;

  const route = await import('@/app/api/ceo-chat/message/route');
  POST = route.POST;
});

afterAll(() => {
  try {
    fs.rmSync(path.dirname(TMP_DB), { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

beforeEach(() => {
  capturedRequests = [];
  canned = [{ type: 'token', text: 'Hello.' }, { type: 'done' }];
});

async function post(body: Record<string, unknown>): Promise<{ status: number; text: string }> {
  const req = new NextRequest('http://localhost/api/ceo-chat/message', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const res = (await POST(req)) as unknown as Response;
  const text = await res.text();
  return { status: res.status, text };
}

function sseEvents(text: string): { event: string; data: Record<string, unknown> }[] {
  return text
    .split('\n\n')
    .filter((chunk) => chunk.trim())
    .map((chunk) => {
      const lines = chunk.split('\n');
      const event = lines.find((l) => l.startsWith('event: '))?.slice(7).trim() ?? 'message';
      const dataLine = lines.find((l) => l.startsWith('data: '));
      const data = dataLine ? JSON.parse(dataLine.slice(6)) : {};
      return { event, data };
    });
}

describe('POST /api/ceo-chat/message — U62 Phase-B passthrough', () => {
  it('threads model/thinkingLevel(UI label)/agentId into ForwardRequest, translated to the proven gateway value', async () => {
    const { status } = await post({
      sessionId: 'sess-passthrough-1',
      message: 'hi',
      model: 'ollama/deepseek-v4-flash:cloud',
      thinkingLevel: 'Max',
      agentId: 'bug-fix-triager',
    });
    expect(status).toBe(200);
    expect(capturedRequests).toHaveLength(1);
    expect(capturedRequests[0].model).toBe('ollama/deepseek-v4-flash:cloud');
    expect(capturedRequests[0].agentId).toBe('bug-fix-triager');
    // "Max" -> the PROVEN gateway value 'high' — never the literal "max".
    expect(capturedRequests[0].thinkingLevel).toBe('high');
  });

  it('omitting all three passthrough fields reproduces Phase-A behavior (all undefined)', async () => {
    await post({ sessionId: 'sess-passthrough-2', message: 'hi' });
    expect(capturedRequests[0].model).toBeUndefined();
    expect(capturedRequests[0].thinkingLevel).toBeUndefined();
    expect(capturedRequests[0].agentId).toBeUndefined();
  });

  it('a raw gateway-value thinkingLevel ("high") is accepted directly, not just a UI label', async () => {
    await post({ sessionId: 'sess-passthrough-3', message: 'hi', thinkingLevel: 'high' });
    expect(capturedRequests[0].thinkingLevel).toBe('high');
  });

  it('the literal broken string "max" sent directly is DROPPED, never threaded to the transport — message still sends', async () => {
    const { status } = await post({ sessionId: 'sess-passthrough-4', message: 'hi', thinkingLevel: 'max' });
    expect(status).toBe(200);
    expect(capturedRequests[0].thinkingLevel).toBeUndefined();
  });

  it('"minimal" (hard gateway rejection) sent directly is DROPPED, never threaded to the transport', async () => {
    const { status } = await post({ sessionId: 'sess-passthrough-5', message: 'hi', thinkingLevel: 'minimal' });
    expect(status).toBe(200);
    expect(capturedRequests[0].thinkingLevel).toBeUndefined();
  });

  it('a garbage thinkingLevel is DROPPED (soft-fails open — never breaks the message send)', async () => {
    const { status } = await post({ sessionId: 'sess-passthrough-6', message: 'hi', thinkingLevel: 'ultra-bogus' });
    expect(status).toBe(200);
    expect(capturedRequests[0].thinkingLevel).toBeUndefined();
  });

  it('an Anthropic-prefixed model is REJECTED (400) server-side — sovereignty filter is a hard gate, never silently dropped or substituted', async () => {
    const { status, text } = await post({
      sessionId: 'sess-passthrough-7',
      message: 'hi',
      model: 'anthropic/claude-3-5-sonnet',
    });
    expect(status).toBe(400);
    expect(capturedRequests).toHaveLength(0); // forwardToAgent must never be reached
    expect(JSON.parse(text).error).toMatch(/forbidden|sovereignty|anthropic/i);
  });

  it('re-emits `routed` and `usage` chunks as new SSE events, in addition to token/done', async () => {
    canned = [
      { type: 'routed', agentId: 'bug-fix-triager' },
      { type: 'token', text: 'Revenue is up.' },
      { type: 'usage', usage: { input: 16026, output: 28, total: 16054 } },
      { type: 'done' },
    ];
    const { text } = await post({ sessionId: 'sess-sse-1', message: 'how are we doing', agentId: 'bug-fix-triager' });

    const events = sseEvents(text);
    const routedEvt = events.find((e) => e.event === 'routed');
    const usageEvt = events.find((e) => e.event === 'usage');
    expect(routedEvt?.data).toEqual({ agentId: 'bug-fix-triager' });
    expect(usageEvt?.data).toEqual({ usage: { input: 16026, output: 28, total: 16054 } });
  });

  it('persists the captured usage onto the assistant DB row (history reload continuity, migration 110)', async () => {
    canned = [
      { type: 'token', text: 'Revenue is up.' },
      { type: 'usage', usage: { input: 111, output: 22, total: 133 } },
      { type: 'done' },
    ];
    await post({ sessionId: 'sess-usage-persist-1', message: 'how are we doing' });

    const history = getCeoChatHistory('sess-usage-persist-1');
    const assistantRow = history.find((m) => m.role === 'assistant');
    expect(assistantRow?.usage_input).toBe(111);
    expect(assistantRow?.usage_output).toBe(22);
    expect(assistantRow?.usage_total).toBe(133);
  });

  it('a turn with no usage frame persists NULL usage (never fabricates a value)', async () => {
    canned = [{ type: 'token', text: 'no usage this turn' }, { type: 'done' }];
    await post({ sessionId: 'sess-no-usage-1', message: 'hi' });

    const history = getCeoChatHistory('sess-no-usage-1');
    const assistantRow = history.find((m) => m.role === 'assistant');
    expect(assistantRow?.usage_input).toBeNull();
    expect(assistantRow?.usage_total).toBeNull();
  });

  it('a non-string / non-object agentId or model is ignored, not passed through as garbage', async () => {
    await post({ sessionId: 'sess-passthrough-8', message: 'hi', model: 42, agentId: { nope: true } });
    expect(capturedRequests[0].model).toBeUndefined();
    expect(capturedRequests[0].agentId).toBeUndefined();
  });
});
