/**
 * B21 — the stream owner under the REAL React hook (Q08: "Twenty
 * mount/unmount/reconnect cycles: listener/active request counts return to
 * baseline").
 *
 * Separate file from useHqState.test.ts because this one installs a jsdom
 * document + a fake EventSource as process globals; keeping it isolated means
 * the engine suite never inherits either.
 *
 * `useSSE` reaches the store, the shared registry and the board-catch-up
 * fetcher, so this drives the actual hook: mount it twenty times over three
 * shared consumers and prove the OPEN-socket count and listener count return to
 * baseline each cycle, the health probe runs on error, and no listener leaks.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

const g = globalThis as Record<string, unknown>;

interface FakeSource {
  url: string;
  closed: boolean;
  onopen: (() => void) | null;
  onmessage: ((e: { data: string }) => void) | null;
  onerror: ((e: unknown) => void) | null;
  readyState: number;
  close: () => void;
}

async function installBrowserShim() {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/hq' });
  g.window = dom.window;
  g.document = dom.window.document;
  g.navigator = dom.window.navigator;
  g.HTMLElement = dom.window.HTMLElement;
  g.localStorage = dom.window.localStorage;
  g.sessionStorage = dom.window.sessionStorage;
  g.IS_REACT_ACT_ENVIRONMENT = true;

  const sources: FakeSource[] = [];
  class FakeEventSource {
    static OPEN = 1;
    static instances = sources;
    onopen: (() => void) | null = null;
    onmessage: ((e: { data: string }) => void) | null = null;
    onerror: ((e: unknown) => void) | null = null;
    readyState = 1;
    closed = false;
    readonly url: string;
    constructor(url: string) {
      this.url = url;
      sources.push(this as unknown as FakeSource);
    }
    close() {
      this.closed = true;
      this.readyState = 2;
    }
    open() {
      this.readyState = 1;
      this.onopen?.();
    }
  }
  g.EventSource = FakeEventSource;
  return { sources, FakeEventSource };
}

function live(sources: FakeSource[]): FakeSource[] {
  return sources.filter((s) => !s.closed);
}

test('Q08: 20 mount/unmount cycles of the real useSSE hook return to baseline', async () => {
  const { sources } = await installBrowserShim();
  const { renderHook } = await import('@testing-library/react');
  const { useSSE, sseListenerCount, activeSseStreamCount } = await import('@/hooks/useSSE');

  const consumersPerCycle = 3;
  for (let cycle = 0; cycle < 20; cycle += 1) {
    const mounted = Array.from({ length: consumersPerCycle }, () => renderHook(() => useSSE()));

    assert.equal(live(sources).length, 1, `cycle ${cycle}: all consumers share exactly one OPEN socket`);
    assert.equal(sseListenerCount('/api/events/stream'), consumersPerCycle, `cycle ${cycle}: one listener per consumer`);

    mounted.forEach((m) => m.unmount());

    assert.equal(live(sources).length, 0, `cycle ${cycle}: unmounting the last consumer closes the socket`);
    assert.equal(sseListenerCount('/api/events/stream'), 0, `cycle ${cycle}: no listener leaks`);
    assert.equal(activeSseStreamCount(), 0, `cycle ${cycle}: the stream is deregistered`);
  }

  assert.equal(sources.length, 20, 'one socket per cycle — never one per consumer, never a growing pile');
});

test('Q08: a drop probes health, and the registry reconnect runs catch-up exactly once', async () => {
  const { sources } = await installBrowserShim();
  const { renderHook, act } = await import('@testing-library/react');
  const { useSSE } = await import('@/hooks/useSSE');
  const { SSE_RECONNECT_DELAY_MS } = await import('@/hooks/useSSE');

  const fetchCalls: string[] = [];
  const realFetch = g.fetch;
  g.fetch = ((input: unknown) => {
    fetchCalls.push(String(input));
    return Promise.resolve({ ok: true, json: async () => [] });
  }) as unknown as typeof fetch;

  // Capture the registry's reconnect timer instead of waiting the real 10s, so
  // the re-open below is the socket the browser would actually create.
  const realSetTimeout = g.setTimeout;
  const scheduled: Array<() => void> = [];
  g.setTimeout = ((fn: () => void, ms?: number) => {
    if (ms === SSE_RECONNECT_DELAY_MS) {
      scheduled.push(fn);
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }
    return (realSetTimeout as unknown as (f: () => void, m?: number) => unknown)(fn, ms);
  }) as typeof setTimeout;

  try {
    const mounted = renderHook(() => useSSE());
    const first = live(sources)[0];
    assert.ok(first, 'a socket opened on mount');

    // First open: no catch-up (the page already loaded a fresh snapshot).
    await act(async () => {
      first.open();
    });
    assert.equal(fetchCalls.length, 0, 'the first open triggers no refetch');

    // Drop: health probe, then a scheduled reconnect.
    await act(async () => {
      first.onerror?.(new Error('dropped'));
    });
    assert.ok(fetchCalls.includes('/api/workspaces'), 'a drop probes API health before claiming offline');
    assert.equal(live(sources).length, 0, 'the dropped socket is closed');
    assert.equal(scheduled.length, 1, 'exactly one reconnect was scheduled');

    // Run the reconnect: this creates the second socket, and ITS first open is
    // a genuine re-open for this stream — so catch-up must run.
    await act(async () => {
      scheduled[0]();
    });
    const second = live(sources)[0];
    assert.ok(second, 'the reconnect opened a fresh socket');
    assert.notEqual(second, first);
    await act(async () => {
      second.open();
    });

    assert.deepEqual(
      fetchCalls.filter((u) => u === '/api/tasks'),
      ['/api/tasks'],
      'the re-open runs the scope-safe board catch-up exactly once',
    );
    mounted.unmount();
  } finally {
    g.setTimeout = realSetTimeout;
    g.fetch = realFetch;
  }
});

test('Q08: a department-scoped consumer can supply its own catch-up and the global one stays unused', async () => {
  const { sources } = await installBrowserShim();
  const { renderHook, act } = await import('@testing-library/react');
  const { useSSE } = await import('@/hooks/useSSE');
  const { useMissionControl } = await import('@/lib/store');

  const fetchCalls: string[] = [];
  const realFetch = g.fetch;
  g.fetch = ((input: unknown) => {
    fetchCalls.push(String(input));
    return Promise.resolve({ ok: true, json: async () => [] });
  }) as unknown as typeof fetch;

  try {
    useMissionControl.getState().setSelectedDepartment('dept-scoped');
    let scopedRefetches = 0;
    const scoped = renderHook(() => useSSE({ onReconnect: () => { scopedRefetches += 1; } }));
    const socket = live(sources)[0];

    await act(async () => {
      socket.open();
    });
    await act(async () => {
      socket.open();
    });

    assert.equal(scopedRefetches, 1, 'the consumer-owned scoped refetch ran');
    assert.deepEqual(
      fetchCalls.filter((u) => u === '/api/tasks'),
      [],
      'the unscoped global catch-up never leaks cross-department cards',
    );
    scoped.unmount();
  } finally {
    useMissionControl.getState().setSelectedDepartment(null);
    g.fetch = realFetch;
  }
});
