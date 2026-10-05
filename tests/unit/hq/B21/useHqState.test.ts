/**
 * B21 — Q08 no-gap catch-up (SPEC S8 "Reconnect algorithm").
 *
 * Fixture network only (no live routes: the B21 card says "fixture network only
 * until A02"). Every race Q08 names is driven deterministically through an
 * injected fetcher + injected clock, against the real engine:
 *
 *   a. 300 events drain through a 200 limit with no silent cap;
 *   b. an event injected between catch-up pages appears exactly once and the
 *      `through` watermark stays frozen for the whole drain;
 *   c. legal global seq gaps are NOT treated as cursor expiry;
 *   d. an event arriving between a page drain and the next snapshot is fetched
 *      on the next catch-up, never skipped by the newer stateSeq;
 *   e. a stale retention cursor (`resetRequired`) and a server high-water
 *      decrease (restore) reset BOTH cursors and say "older activity unavailable";
 *   f. failed reads are labeled stale, never an empty success, and never advance
 *      the cursor past a page that was not applied;
 *   g. a foreign-company body is dropped (no client-A rows on B);
 *   h. `hq_changed` scope is proven or dropped;
 *   i. one stream owner: 20 mount/unmount cycles and shared consumers keep
 *      listener and OPEN-socket counts at baseline.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  acquireEventStream,
  activeSseStreamCount,
  sseListenerCount,
  SSE_RECONNECT_DELAY_MS,
} from '@/hooks/useSSE';
import {
  createHqCatchUp,
  hqActivityUrl,
  hqSnapshotUrl,
  HQ_PAGE_LIMIT,
  readHqHint,
} from '@/hooks/useHqState';
import type { HqActivityEvent, HqDepartment } from '@/lib/hq/types';
import type { SSEEvent } from '@/lib/types';

const COMPANY = 'co-b21';
const OTHER_COMPANY = 'co-other';
const CLOCK = () => '2026-10-04T00:00:00.000Z';

function activity(seq: number, id = `ev-${seq}`, kind: HqActivityEvent['kind'] = 'task'): HqActivityEvent {
  return {
    id,
    seq,
    kind,
    phase: kind === 'owner_note' ? 'recorded' : 'created',
    taskId: null,
    actorLabel: null,
    recipientLabel: null,
    occurredAt: null,
    receivedAt: '2026-10-04T00:00:00.000Z',
    reference: `ref-${seq}`,
    payload: kind === 'owner_note' ? { text: `note ${seq}` } : { status: null, previousStatus: null },
  } as HqActivityEvent;
}

const ROSTER: HqDepartment[] = [];

function snapshotBody(
  highSeq: number,
  prunedThroughSeq = 0,
  activities: HqActivityEvent[] = [],
  companyId = COMPANY,
) {
  return {
    schemaVersion: 1,
    generatedAt: '2026-10-04T00:00:00.000Z',
    companyId,
    roster: ROSTER,
    layout: { revision: 'rev-1', rooms: [] },
    captureHealth: null,
    taskLinks: null,
    activities,
    highSeq,
    prunedThroughSeq,
    layoutRevision: 'rev-1',
  };
}

function pageBody(
  events: HqActivityEvent[],
  nextAfter: number,
  through: number,
  hasMore: boolean,
  opts: { resetRequired?: boolean; prunedThroughSeq?: number; companyId?: string } = {},
) {
  return {
    schemaVersion: 1,
    generatedAt: '2026-10-04T00:00:00.000Z',
    companyId: opts.companyId ?? COMPANY,
    events,
    nextAfter,
    through,
    hasMore,
    resetRequired: opts.resetRequired ?? false,
    prunedThroughSeq: opts.prunedThroughSeq ?? 0,
  };
}

/** Deterministic in-memory fixture network: scripted snapshot + forward pages. */
class FixtureNetwork {
  requests: string[] = [];
  snapshotHighSeq = 0;
  snapshotPrunedThroughSeq = 0;
  snapshotActivities: HqActivityEvent[] = [];
  /** Rows keyed by seq; the server returns `feedCursor < seq <= through`, paged. */
  rows = new Map<number, HqActivityEvent>();
  pageSize = HQ_PAGE_LIMIT;
  failNextPage = false;
  snapshotFails = false;
  companyOverride: string | null = null;
  /** Overrides the generated page (race injection / forced reset). */
  pageOverride: ((after: number, through: number) => unknown) | null = null;
  /** Notified AFTER a page is decided — the "between pages" injection hook. */
  onPage?: (after: number, through: number) => void;

  constructor(public highSeq: number) {
    this.snapshotHighSeq = highSeq;
  }

  seed(fromExclusive: number, toInclusive: number): void {
    for (let seq = fromExclusive + 1; seq <= toInclusive; seq += 1) this.rows.set(seq, activity(seq));
  }

  fetcher = async (url: string, signal: AbortSignal): Promise<unknown> => {
    if (signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    this.requests.push(url);

    if (url === hqSnapshotUrl()) {
      if (this.snapshotFails) throw new Error('snapshot down');
      return snapshotBody(
        this.snapshotHighSeq,
        this.snapshotPrunedThroughSeq,
        this.snapshotActivities,
        this.companyOverride ?? COMPANY,
      );
    }

    const parsed = new URL(url, 'http://fixture.invalid');
    const after = Number(parsed.searchParams.get('after'));
    const through = Number(parsed.searchParams.get('through'));

    if (this.failNextPage) {
      this.failNextPage = false;
      throw new Error('page down');
    }
    if (this.pageOverride) {
      const custom = this.pageOverride(after, through);
      this.onPage?.(after, through);
      return custom;
    }

    const scoped = Array.from(this.rows.values())
      .filter((e) => e.seq > after && e.seq <= through)
      .sort((a, b) => a.seq - b.seq);
    const page = scoped.slice(0, this.pageSize);
    const nextAfter = page.length > 0 ? page[page.length - 1].seq : after;
    const body = pageBody(page, nextAfter, through, scoped.length > page.length, {
      companyId: this.companyOverride ?? COMPANY,
      prunedThroughSeq: this.snapshotPrunedThroughSeq,
    });
    this.onPage?.(after, through);
    return body;
  };

  activityRequests(): URL[] {
    return this.requests.filter((u) => u.includes('/api/hq/activity')).map((u) => new URL(u, 'http://x'));
  }
}

/**
 * First visit (SPEC S8.2): the snapshot seeds the retained window and sets
 * `feedCursor = highSeq`. Callers that want to exercise a drain move the
 * server watermark forward afterwards.
 */
async function startEngine(net: FixtureNetwork, pageLimit = HQ_PAGE_LIMIT) {
  net.pageSize = pageLimit;
  const core = createHqCatchUp({ companyId: COMPANY, fetcher: net.fetcher, pageLimit, clock: CLOCK });
  await core.start();
  return core;
}

/** Let every queued microtask (a catch-up cycle) run to completion. */
async function settle(): Promise<void> {
  for (let i = 0; i < 12; i += 1) await new Promise((r) => setImmediate(r));
}

test('Q08: 300 events drain through a 200 limit with no silent cap', async () => {
  const net = new FixtureNetwork(0);
  const core = await startEngine(net, 200);
  assert.equal(core.getState().feedCursor, 0, 'first visit initializes the cursor to the snapshot highSeq');

  net.snapshotHighSeq = 300;
  net.seed(0, 300);
  core.hint(300);
  await settle();

  const state = core.getState();
  assert.equal(state.feed.length, 300, 'every retained row drained, none silently dropped');
  assert.equal(state.feedCursor, 300);
  assert.deepEqual(
    state.feed.map((e) => e.id),
    Array.from({ length: 300 }, (_, i) => `ev-${i + 1}`),
    'ascending, exactly once',
  );
  const pages = net.activityRequests();
  assert.equal(pages.length, 2, '300 events at limit 200 = exactly two pages');
  assert.equal(Number(pages[0].searchParams.get('after')), 0);
  assert.equal(Number(pages[1].searchParams.get('after')), 200);
  assert.deepEqual(
    pages.map((p) => Number(p.searchParams.get('through'))),
    [300, 300],
    'through freezes for the whole drain',
  );
  assert.equal(Number(pages[1].searchParams.get('limit')), 200);
});

test('Q08: an event injected between catch-up pages appears exactly once, watermark frozen', async () => {
  const net = new FixtureNetwork(0);
  const core = await startEngine(net, 200);

  net.snapshotHighSeq = 300;
  net.seed(0, 300);
  net.onPage = (after) => {
    if (after !== 0) return;
    // The race Q08 names: a new row lands while page 1 is in flight.
    net.rows.set(301, activity(301));
    net.snapshotHighSeq = 301;
  };

  core.hint(300);
  await settle();

  const state = core.getState();
  const ids = state.feed.map((e) => e.id);
  assert.equal(new Set(ids).size, ids.length, 'no duplicate rows');
  assert.equal(ids.length, 301, 'the injected row is caught by the repeat round');
  assert.ok(state.feed.some((e) => e.id === 'ev-301'));
  assert.equal(state.feedCursor, 301);

  const throughs = net.activityRequests().map((p) => Number(p.searchParams.get('through')));
  // Pages 1-2 belong to the frozen 300 watermark; the repeat round uses 301.
  assert.deepEqual(throughs.slice(0, 2), [300, 300], 'the watermark never widens mid-drain');
  assert.equal(throughs[throughs.length - 1], 301, 'the repeat round carries the new watermark');
});

test('Q08: a legal global seq gap is not treated as cursor expiry', async () => {
  const net = new FixtureNetwork(0);
  const core = await startEngine(net);

  net.rows.set(1, activity(1));
  net.rows.set(5, activity(5)); // 2-4 belong to another scope: legal gap
  net.snapshotHighSeq = 5;
  core.hint(5);
  await settle();

  const state = core.getState();
  assert.deepEqual(state.feed.map((e) => e.seq), [1, 5]);
  assert.equal(state.feedCursor, 5);
  assert.equal(state.feedStatus, 'ready');
  assert.equal(state.historyUnavailable, false, 'a gap alone never infers expiry');
});

test('Q08: an event arriving between drain and the next snapshot is never skipped by the newer stateSeq', async () => {
  const net = new FixtureNetwork(0);
  const core = await startEngine(net);

  net.snapshotHighSeq = 3;
  net.seed(0, 3);
  // Lands between the activity batch and the snapshot refresh of the same cycle,
  // and the refreshed snapshot ALREADY reports it.
  let injected = false;
  net.onPage = () => {
    if (injected) return;
    injected = true;
    // seq 4 is past the frozen through=3, so it is absent from the page that
    // just resolved; only the refreshed snapshot advertises it.
    net.rows.set(4, activity(4));
    net.snapshotHighSeq = 4;
  };
  core.hint(3);
  await settle();

  const state = core.getState();
  assert.ok(state.feed.some((e) => e.id === 'ev-4'), 'the row the newer stateSeq implies is still fetched');
  assert.equal(state.feedCursor, 4);
  assert.deepEqual(state.feed.map((e) => e.seq), [1, 2, 3, 4]);
});

test('Q08: stale retention cursor resets BOTH cursors and says older activity unavailable', async () => {
  const net = new FixtureNetwork(50);
  net.seed(0, 50);
  net.snapshotActivities = [activity(50)];
  const core = await startEngine(net);
  assert.equal(core.getState().feedCursor, 50);

  // Prune: the server reports the cursor as already pruned.
  net.snapshotHighSeq = 70;
  net.snapshotPrunedThroughSeq = 60;
  net.snapshotActivities = [activity(70)];
  net.pageOverride = () => pageBody([], 50, 70, false, { resetRequired: true, prunedThroughSeq: 60 });

  core.hint(70);
  await settle();

  const state = core.getState();
  assert.equal(state.historyUnavailable, true);
  assert.equal(state.feedCursor, 70, 'both cursors reset from the fresh snapshot');
  assert.equal(state.stateSeq, 70);
  assert.deepEqual(state.feed.map((e) => e.seq), [70], 'no misleading delta rows were appended');
  assert.equal(state.feedLabel, 'recent');
  assert.equal(state.prunedThroughSeq, 60);
});

test('Q08: a server high-water decrease after restore resets rather than resuming ahead', async () => {
  const net = new FixtureNetwork(40);
  net.seed(0, 40);
  net.snapshotActivities = [activity(40)];
  const core = await startEngine(net);
  assert.equal(core.getState().feedCursor, 40);

  // Database restored to an older dump: the high-water goes BACKWARDS.
  net.snapshotHighSeq = 12;
  net.snapshotActivities = [activity(12)];
  core.refreshAndCatchUp();
  await settle();

  const state = core.getState();
  assert.equal(state.historyUnavailable, true, 'restore is an explicit reset, never inferred');
  assert.equal(state.feedCursor, 12);
  assert.equal(state.stateSeq, 12);
  assert.equal(state.highSeq, 12);
  const resumedAhead = net
    .activityRequests()
    .some((p) => Number(p.searchParams.get('after')) > 12);
  assert.equal(resumedAhead, false, 'never resumes from a cursor newer than the server high-water');
});

test('Q08: a failed snapshot is labeled stale, never an empty success', async () => {
  const net = new FixtureNetwork(4);
  net.seed(0, 4);
  net.snapshotFails = true;
  const core = await startEngine(net);

  const state = core.getState();
  assert.equal(state.snapshotStatus, 'stale');
  assert.equal(state.feedStatus, 'stale');
  assert.equal(state.snapshotAt, null);
  assert.equal(state.feedCursorInitialized, false, 'no cursor is invented from a failed read');
  assert.deepEqual(state.feed, []);
});

test('Q08: a failed page fetch labels stale and does not advance the cursor past it', async () => {
  const net = new FixtureNetwork(0);
  const core = await startEngine(net);
  const before = core.getState().feedCursor;

  net.snapshotHighSeq = 6;
  net.seed(0, 6);
  net.failNextPage = true;
  core.hint(6);
  await settle();

  const state = core.getState();
  assert.equal(state.feedStatus, 'stale');
  assert.equal(state.feedCursor, before, 'the cursor advances only after a page is applied');
  assert.equal(state.snapshotStatus, 'ready', 'the snapshot itself still succeeded');
});

test('Q08: a foreign-company body is dropped, never rendered as this company', async () => {
  const net = new FixtureNetwork(2);
  net.seed(0, 2);
  net.companyOverride = OTHER_COMPANY;
  const core = await startEngine(net);

  const state = core.getState();
  assert.deepEqual(state.feed, [], 'client-B rows never land in client-A state');
  assert.equal(state.snapshotStatus, 'stale');
  assert.equal(state.feedCursorInitialized, false);
});

test('Q08: one stream owner — ref-counted registry returns to baseline over 20 cycles', () => {
  const g = globalThis as Record<string, unknown>;
  const previous = g.EventSource;
  class FakeEventSource {
    static OPEN = 1;
    static instances: FakeEventSource[] = [];
    static live(): FakeEventSource[] {
      return FakeEventSource.instances.filter((i) => !i.closed);
    }
    closed = false;
    onopen: (() => void) | null = null;
    onmessage: ((e: { data: string }) => void) | null = null;
    onerror: ((e: unknown) => void) | null = null;
    readyState = 1;
    close() {
      this.closed = true;
    }
    constructor(public url: string) {
      FakeEventSource.instances.push(this);
    }
  }
  g.EventSource = FakeEventSource;
  try {
    assert.equal(activeSseStreamCount(), 0);
    for (let cycle = 0; cycle < 20; cycle += 1) {
      const releases: Array<() => void> = [];
      for (let consumer = 0; consumer < 3; consumer += 1) {
        releases.push(acquireEventStream('/api/events/stream', () => {}));
      }
      assert.equal(FakeEventSource.live().length, 1, 'three consumers share exactly one OPEN socket');
      assert.equal(sseListenerCount('/api/events/stream'), 3);
      releases.forEach((release) => release());
      assert.equal(FakeEventSource.live().length, 0, 'the last release closes the socket');
    }
    assert.equal(sseListenerCount('/api/events/stream'), 0, 'listener count returns to baseline');
    assert.equal(activeSseStreamCount(), 0, 'no stream stays registered');
    assert.equal(FakeEventSource.live().length, 0, 'no socket is left open after 20 cycles');
  } finally {
    g.EventSource = previous;
  }
});

test('Q08: a released consumer stops receiving, and one throwing listener cannot starve another', () => {
  const g = globalThis as Record<string, unknown>;
  const previous = g.EventSource;
  class FakeEventSource {
    static instances: FakeEventSource[] = [];
    onopen: (() => void) | null = null;
    onmessage: ((e: { data: string }) => void) | null = null;
    onerror: ((e: unknown) => void) | null = null;
    close() {}
    constructor(public url: string) {
      FakeEventSource.instances.push(this);
    }
    emit(event: unknown) {
      this.onmessage?.({ data: JSON.stringify(event) });
    }
  }
  g.EventSource = FakeEventSource;
  const before = FakeEventSource.instances.length;
  try {
    const seen: string[] = [];
    const releaseA = acquireEventStream('/api/events/stream', () => {
      throw new Error('consumer A is broken');
    });
    const releaseB = acquireEventStream('/api/events/stream', (e) => seen.push(e.type));
    const socket = FakeEventSource.instances[before];
    assert.ok(socket, 'a socket was opened for the first consumer');
    socket.emit({ type: 'task_created', payload: { id: 't1' } });
    assert.deepEqual(seen, ['task_created'], 'B still received the frame after A threw');

    releaseB();
    socket.emit({ type: 'task_created', payload: { id: 't2' } });
    assert.deepEqual(seen, ['task_created'], 'a released listener receives nothing further');
    socket.emit({ type: 'task_created', payload: { id: 't3' } });
    assert.deepEqual(seen, ['task_created'], 'and stays released');
    releaseA();
    assert.equal(activeSseStreamCount(), 0);
  } finally {
    g.EventSource = previous;
  }
});

test('Q08: reconnect re-observes the open, labels the drop, and drives catch-up', async () => {
  const net = new FixtureNetwork(1);
  net.seed(0, 1);
  net.snapshotActivities = [activity(1)];
  const core = await startEngine(net);
  const requestsBefore = net.requests.length;

  // First open carries no catch-up duty (the caller already loaded a snapshot).
  core.onStreamOpen(false);
  await settle();
  assert.equal(core.getState().connection, 'live');
  assert.equal(net.requests.length, requestsBefore, 'first open triggers no refetch');

  // A genuine re-open: deltas may have been missed while the socket was down.
  net.snapshotHighSeq = 2;
  net.rows.set(2, activity(2));
  core.onStreamOpen(true);
  await settle();
  assert.ok(net.requests.length > requestsBefore, 'a re-open refetches');
  assert.ok(core.getState().feed.some((e) => e.id === 'ev-2'), 'missed deltas are drained');
  assert.equal(core.getState().feedCursor, 2);

  core.onStreamError();
  assert.equal(core.getState().connection, 'reconnecting', 'a drop labels reconnecting, never empty');
  assert.equal(core.getState().feedCursor, 2, 'the drop does not discard the drained feed');
});

test('Q08: hq_changed scope is proven or dropped (content-free, company-scoped)', () => {
  const good = { type: 'hq_changed', companyId: COMPANY, highSeq: 7 } as unknown as SSEEvent;
  assert.deepEqual(readHqHint(good), { companyId: COMPANY, highSeq: 7 });

  const nested = { type: 'hq_changed', payload: { companyId: COMPANY, highSeq: 9 } } as unknown as SSEEvent;
  assert.deepEqual(readHqHint(nested), { companyId: COMPANY, highSeq: 9 });

  // Scope not proved -> dropped, never guessed.
  assert.equal(readHqHint({ type: 'hq_changed', highSeq: 7 } as unknown as SSEEvent), null);
  assert.equal(readHqHint({ type: 'hq_changed', companyId: COMPANY } as unknown as SSEEvent), null);
  assert.equal(readHqHint({ type: 'hq_changed', companyId: COMPANY, highSeq: -1 } as unknown as SSEEvent), null);
  assert.equal(readHqHint({ type: 'hq_changed', companyId: COMPANY, highSeq: 1.5 } as unknown as SSEEvent), null);
  // A legacy board event is not an HQ hint.
  assert.equal(readHqHint({ type: 'task_created', payload: {} } as unknown as SSEEvent), null);
});

test('Q08: a stopped engine issues no further reads and clears its listeners', async () => {
  const net = new FixtureNetwork(5);
  net.seed(0, 5);
  net.snapshotActivities = [activity(5)];
  const core = await startEngine(net);
  assert.equal(core.getState().feedCursor, 5);

  let notifications = 0;
  core.subscribe(() => {
    notifications += 1;
  });
  core.stop();
  const requestsAfterStop = net.requests.length;
  const notificationsAfterStop = notifications;

  core.hint(99);
  await settle();
  assert.equal(net.requests.length, requestsAfterStop, 'a stopped engine issues no new reads');
  assert.equal(notifications, notificationsAfterStop, 'no listener is notified after stop');
});

test('B21 carry: transport constants are the documented ones', () => {
  assert.equal(SSE_RECONNECT_DELAY_MS, 10_000);
  assert.equal(HQ_PAGE_LIMIT, 200);
  assert.equal(hqActivityUrl(0, 100), '/api/hq/activity?after=0&through=100&limit=200');
  assert.equal(
    hqActivityUrl(0, 100, 50),
    '/api/hq/activity?after=0&through=100&limit=50',
    'the S8 limit stays overridable for a smaller page',
  );
  assert.equal(hqSnapshotUrl(), '/api/hq/snapshot');
});
