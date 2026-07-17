/**
 * U62 (JM/U65, master E.2) — useCeoChatSession wiring proof.
 *
 * This is the "does anything actually call your code" check for the whole
 * U62 frontend slice: the pickers proven interactive in
 * u62-model-agent-picker-render.test.tsx and u62-thinking-selector-
 * render.test.tsx are inert unless something downstream actually consumes
 * their onUserChange/onChange callbacks and threads the resolved state into
 * the outgoing POST body + inserts the chip. This suite drives the REAL hook
 * (@testing-library/react renderHook) and proves:
 *   - thinkingLevel persists per session via sessionStorage across a remount
 *     for the SAME session id (BINARY acceptance: "thinking level persists
 *     per session (sessionStorage)").
 *   - a user-initiated model switch inserts EXACTLY ONE system chip (never
 *     zero, never more than one per switch).
 *   - a user-initiated agent switch inserts EXACTLY ONE system chip.
 *   - send() threads the resolved model/thinkingLevel/agentId into the POST
 *     body, and a `usage` SSE event during the stream updates
 *     exactUsageTokens (the value ContextMeter's `exactTokens` prop reads).
 *   - startFreshSession() resets exactUsageTokens back to null (a fresh
 *     thread has no usage yet — the meter must revert to estimate mode).
 *
 * jsdom + a real ReadableStream (Node 18+ global) backs the mocked
 * fetch Response body, so the hook's own `res.body.getReader()` /
 * TextDecoder loop is exercised for real, not stubbed away.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useCeoChatSession } from '../../src/components/ceo-chat/useCeoChatSession';
import type { ModelOption, AgentOption } from '../../src/components/ceo-chat/types';

function sseStreamResponse(events: { event: string; data: unknown }[]): Response {
  const body = events.map((e) => `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`).join('');
  const bytes = new TextEncoder().encode(body);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
  return new Response(stream, { status: 200 });
}

const MODEL: ModelOption = {
  model_id: 'ollama/deepseek-v4-flash:cloud',
  label: 'DeepSeek v4 Flash',
  provider: 'ollama',
  context_window: 64_000,
  capabilities: ['text', 'reasoning'],
};
const AGENT: AgentOption = { id: 'bug-fix-triager', name: 'Bug Fix Triager', avatar_emoji: '🐛', is_master: false, status: 'active' };

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useCeoChatSession — U62 wiring', () => {
  it('thinkingLevel persists per session via sessionStorage across a remount for the SAME session id', async () => {
    global.fetch = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.startsWith('/api/ceo-chat/status')) return new Response(JSON.stringify({ enabled: true, gateway: { up: true } }), { status: 200 });
      if (u.startsWith('/api/ceo-chat/history')) return new Response(JSON.stringify({ ok: true, messages: [], tasks: [] }), { status: 200 });
      throw new Error(`unstubbed fetch: ${u}`);
    }) as unknown as typeof fetch;

    const { result, unmount } = renderHook(() => useCeoChatSession());
    await waitFor(() => expect(result.current.sessionId).toBeTruthy());

    act(() => result.current.setThinkingLevel('Deep'));
    expect(result.current.thinkingLevel).toBe('Deep');

    const sid = result.current.sessionId;
    unmount();

    // A fresh mount reusing the SAME persisted localStorage session id must
    // recover the SAME thinking level from sessionStorage.
    const { result: result2 } = renderHook(() => useCeoChatSession());
    await waitFor(() => expect(result2.current.sessionId).toBe(sid));
    await waitFor(() => expect(result2.current.thinkingLevel).toBe('Deep'));
  });

  it('a user-initiated MODEL switch inserts EXACTLY ONE system chip', async () => {
    global.fetch = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.startsWith('/api/ceo-chat/status')) return new Response(JSON.stringify({ enabled: true, gateway: { up: true } }), { status: 200 });
      if (u.startsWith('/api/ceo-chat/history')) return new Response(JSON.stringify({ ok: true, messages: [], tasks: [] }), { status: 200 });
      throw new Error(`unstubbed fetch: ${u}`);
    }) as unknown as typeof fetch;

    const { result } = renderHook(() => useCeoChatSession());
    await waitFor(() => expect(result.current.sessionId).toBeTruthy());

    const before = result.current.messages.length;
    act(() => result.current.onModelResolved(MODEL)); // mount-time auto-resolve equivalent — must NOT chip
    expect(result.current.messages.length).toBe(before);

    act(() => result.current.onModelUserChange(MODEL)); // explicit user pick — must chip EXACTLY once
    expect(result.current.messages.length).toBe(before + 1);
    expect(result.current.messages[result.current.messages.length - 1].role).toBe('system');
    expect(result.current.messages[result.current.messages.length - 1].content).toContain(MODEL.label);
  });

  it('a user-initiated AGENT switch inserts EXACTLY ONE system chip', async () => {
    global.fetch = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.startsWith('/api/ceo-chat/status')) return new Response(JSON.stringify({ enabled: true, gateway: { up: true } }), { status: 200 });
      if (u.startsWith('/api/ceo-chat/history')) return new Response(JSON.stringify({ ok: true, messages: [], tasks: [] }), { status: 200 });
      throw new Error(`unstubbed fetch: ${u}`);
    }) as unknown as typeof fetch;

    const { result } = renderHook(() => useCeoChatSession());
    await waitFor(() => expect(result.current.sessionId).toBeTruthy());

    const before = result.current.messages.length;
    act(() => result.current.onAgentResolved(AGENT));
    expect(result.current.messages.length).toBe(before);

    act(() => result.current.onAgentUserChange(AGENT));
    expect(result.current.messages.length).toBe(before + 1);
    expect(result.current.messages[result.current.messages.length - 1].content).toContain(AGENT.name);
  });

  it('send() threads model/thinkingLevel/agentId into the POST body, and a `usage` SSE event updates exactUsageTokens', async () => {
    let capturedBody: Record<string, unknown> | null = null;
    global.fetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.startsWith('/api/ceo-chat/status')) return new Response(JSON.stringify({ enabled: true, gateway: { up: true } }), { status: 200 });
      if (u.startsWith('/api/ceo-chat/history')) return new Response(JSON.stringify({ ok: true, messages: [], tasks: [] }), { status: 200 });
      if (u.startsWith('/api/ceo-chat/message')) {
        capturedBody = JSON.parse(String(init?.body ?? '{}'));
        return sseStreamResponse([
          { event: 'session', data: { sessionId: capturedBody.sessionId } },
          { event: 'routed', data: { agentId: AGENT.id } },
          { event: 'token', data: { text: 'Revenue is up.' } },
          { event: 'usage', data: { usage: { input: 111, output: 22, total: 16054 } } },
          { event: 'done', data: {} },
        ]);
      }
      throw new Error(`unstubbed fetch: ${u}`);
    }) as unknown as typeof fetch;

    const { result } = renderHook(() => useCeoChatSession());
    await waitFor(() => expect(result.current.sessionId).toBeTruthy());

    act(() => result.current.onModelResolved(MODEL));
    act(() => result.current.onAgentResolved(AGENT));
    act(() => result.current.setThinkingLevel('Max'));
    act(() => result.current.setInput('how are we doing'));

    await act(async () => {
      await result.current.send();
    });

    expect(capturedBody).not.toBeNull();
    expect(capturedBody!.model).toBe(MODEL.model_id);
    expect(capturedBody!.agentId).toBe(AGENT.id);
    expect(capturedBody!.thinkingLevel).toBe('Max'); // the UI label — the route translates it server-side
    expect(result.current.exactUsageTokens).toBe(16054);
  });

  it('startFreshSession() resets exactUsageTokens back to null (the new thread has no usage yet)', async () => {
    global.fetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.startsWith('/api/ceo-chat/status')) return new Response(JSON.stringify({ enabled: true, gateway: { up: true } }), { status: 200 });
      if (u.startsWith('/api/ceo-chat/history')) return new Response(JSON.stringify({ ok: true, messages: [], tasks: [] }), { status: 200 });
      if (u.startsWith('/api/ceo-chat/message')) {
        return sseStreamResponse([
          { event: 'token', data: { text: 'hi' } },
          { event: 'usage', data: { usage: { input: 1, output: 1, total: 2 } } },
          { event: 'done', data: {} },
        ]);
      }
      throw new Error(`unstubbed fetch: ${String(url)}`);
    }) as unknown as typeof fetch;

    const { result } = renderHook(() => useCeoChatSession());
    await waitFor(() => expect(result.current.sessionId).toBeTruthy());
    act(() => result.current.setInput('hi'));
    await act(async () => {
      await result.current.send();
    });
    expect(result.current.exactUsageTokens).toBe(2);

    act(() => result.current.startFreshSession());
    expect(result.current.exactUsageTokens).toBeNull();
  });
});
