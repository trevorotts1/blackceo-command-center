/**
 * useHqState — Headquarters client snapshot + catch-up state (unit B21).
 *
 * Authority: SPEC.md rev 4 S8 "Reconnect algorithm". The invariant this file
 * owns is that `stateSeq` (snapshot freshness) and `feedCursor` (last drained
 * activity watermark) are SEPARATE facts, and that durable history is drained
 * from `feedCursor` regardless of how new the current-state snapshot is:
 *
 *   - the EventSource is attached FIRST (reused, never a second connection —
 *     `acquireEventStream` in src/hooks/useSSE.ts is the only EventSource owner);
 *   - an `hq_changed` hint sets a dirty flag and a maximum hinted highSeq, and
 *     is never rendered as content;
 *   - catch-up runs even with no hint, freezing `through` to the known high
 *     watermark, draining every page, advancing the cursor only after a page is
 *     applied, and treating global seq gaps as legal;
 *   - `resetRequired` (or a cursor newer than the server highSeq after a
 *     restore) resets BOTH cursors explicitly and says "Older activity
 *     unavailable" instead of inventing a delta;
 *   - a failed read labels the surface stale and keeps the last successful
 *     time — it never replaces the company with an empty one.
 *
 * The catch-up engine below is plain TypeScript with an injected fetcher so the
 * races Q08 names (event injected between snapshot and page, between pages, page
 * failure, restore) are tested deterministically against a fixture network —
 * no DOM, no server. `useHqState` is the React binding.
 */

'use client';

import { useEffect, useRef, useState } from 'react';
import { acquireEventStream, type SseListener } from '@/hooks/useSSE';
import type {
  HqActivityEvent,
  HqActivityPageResponse,
  HqChangedEvent,
  HqDepartment,
  HqLayout,
  HqSnapshotResponse,
} from '@/lib/hq/types';
import type { SSEEvent } from '@/lib/types';

/* ================================================================== *
 * Read transport
 * ================================================================== */

/**
 * Returns the parsed JSON body, or throws. Injected in tests so every race is
 * deterministic; the default talks to the S8 routes.
 */
export type HqFetcher = (url: string, signal: AbortSignal) => Promise<unknown>;

export class HqFetchError extends Error {
  constructor(public status: number, public body: unknown) {
    super(`HQ read failed: ${status}`);
    this.name = 'HqFetchError';
  }
}

export const hqHttpFetcher: HqFetcher = async (url, signal) => {
  const response = await fetch(url, {
    cache: 'no-store',
    signal,
    headers: { accept: 'application/json' },
  });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) throw new HqFetchError(response.status, body);
  return body;
};

/** SPEC S8 forward page: `after`/`through`/`limit` 1..200 (default 100). */
export const HQ_PAGE_LIMIT = 200;
/** Visible-page fallback refresh cadence (SPEC S8.6). */
export const HQ_VISIBLE_REFRESH_MS = 30_000;
/** Bounded drain guard: 100 pages x 200 events. Exceeding it marks stale, never silently truncates. */
export const HQ_MAX_PAGES_PER_CATCHUP = 100;
/**
 * Bounded repeat guard for one catch-up cycle. Live traffic whose watermark
 * keeps climbing cannot spin the loop forever; the cursor has already advanced,
 * so the next hint or fallback tick resumes from where this cycle stopped.
 */
export const HQ_MAX_CATCHUP_ROUNDS = 20;

export function hqSnapshotUrl(): string {
  return '/api/hq/snapshot';
}

export function hqActivityUrl(after: number, through: number, limit: number = HQ_PAGE_LIMIT): string {
  return `/api/hq/activity?after=${after}&through=${through}&limit=${limit}`;
}

/* ================================================================== *
 * State
 * ================================================================== */

export type HqConnection = 'connecting' | 'live' | 'reconnecting';
export type HqSnapshotStatus = 'idle' | 'loading' | 'ready' | 'stale';
export type HqFeedStatus = 'idle' | 'loading' | 'ready' | 'stale';
/** `recent` = "Recent activity" (latest retained window), never claimed as full history. */
export type HqFeedLabel = 'recent' | 'history';

export interface HqCatchUpState {
  companyId: string | null;
  /** Snapshot freshness watermark. */
  stateSeq: number | null;
  /** Last drained activity watermark. */
  feedCursor: number;
  feedCursorInitialized: boolean;
  /** Highest watermark the server has told us about. */
  highSeq: number;
  prunedThroughSeq: number;
  layoutRevision: string | null;
  roster: HqDepartment[];
  layout: HqLayout | null;
  captureHealth: unknown;
  taskLinks: unknown;
  feed: HqActivityEvent[];
  feedLabel: HqFeedLabel;
  feedStatus: HqFeedStatus;
  /** Set by a retention reset or a restore: "Older activity unavailable". */
  historyUnavailable: boolean;
  connection: HqConnection;
  snapshotStatus: HqSnapshotStatus;
  /** Last SUCCESSFUL snapshot time; a stale surface keeps showing this. */
  snapshotAt: string | null;
}

function initialState(companyId: string | null): HqCatchUpState {
  return {
    companyId,
    stateSeq: null,
    feedCursor: 0,
    feedCursorInitialized: false,
    highSeq: 0,
    prunedThroughSeq: 0,
    layoutRevision: null,
    roster: [],
    layout: null,
    captureHealth: null,
    taskLinks: null,
    feed: [],
    feedLabel: 'recent',
    feedStatus: 'idle',
    historyUnavailable: false,
    connection: 'connecting',
    snapshotStatus: 'idle',
    snapshotAt: null,
  };
}

/* ================================================================== *
 * Runtime shape guards (bodies are data; never trusted blindly)
 * ================================================================== */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isSafeCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isSnapshotBody(body: unknown): body is HqSnapshotResponse {
  if (!isRecord(body)) return false;
  return (
    body.schemaVersion === 1 &&
    typeof body.companyId === 'string' &&
    isSafeCount(body.highSeq) &&
    isSafeCount(body.prunedThroughSeq) &&
    Array.isArray(body.roster) &&
    Array.isArray(body.activities)
  );
}

function isPageBody(body: unknown): body is HqActivityPageResponse {
  if (!isRecord(body)) return false;
  return (
    body.schemaVersion === 1 &&
    typeof body.companyId === 'string' &&
    Array.isArray(body.events) &&
    isSafeCount(body.nextAfter) &&
    isSafeCount(body.through) &&
    typeof body.hasMore === 'boolean' &&
    typeof body.resetRequired === 'boolean'
  );
}

/**
 * SPEC S7: `hq_changed` is content-free and company-scoped; if scope cannot be
 * proved, DROP it. B22 owns the wire shape in src/lib/events.ts — until that
 * lands, the frozen HqChangedEvent permits the fields flat on the frame, so
 * both the flat and payload-nested spellings are accepted, and anything
 * unproven is dropped rather than guessed.
 */
export function readHqHint(event: SSEEvent): { companyId: string; highSeq: number } | null {
  const frame = event as unknown as Partial<HqChangedEvent> & { payload?: unknown };
  if (frame.type !== 'hq_changed') return null;

  const payload = isRecord(frame.payload) ? frame.payload : null;
  const companyId =
    typeof frame.companyId === 'string' ? frame.companyId
      : payload && typeof payload.companyId === 'string' ? payload.companyId
        : null;
  const highSeqRaw = isSafeCount(frame.highSeq) ? frame.highSeq : payload?.highSeq;

  if (companyId === null || !isSafeCount(highSeqRaw)) return null;
  return { companyId, highSeq: highSeqRaw };
}

/* ================================================================== *
 * Feed merge — dedupe by event id, ordered by seq (ascending)
 * ================================================================== */

export function mergeHqFeed(
  existing: readonly HqActivityEvent[],
  incoming: readonly HqActivityEvent[],
): HqActivityEvent[] {
  const byId = new Map<string, HqActivityEvent>();
  for (const event of existing) byId.set(event.id, event);
  for (const event of incoming) byId.set(event.id, event);
  return Array.from(byId.values()).sort((a, b) => a.seq - b.seq);
}

/* ================================================================== *
 * Catch-up engine
 * ================================================================== */

export interface HqCatchUpDeps {
  companyId: string;
  fetcher?: HqFetcher;
  pageLimit?: number;
  /** Injectable clock for deterministic receipts/tests. */
  clock?: () => string;
}

export interface HqCatchUp {
  getState(): HqCatchUpState;
  subscribe(listener: (state: HqCatchUpState) => void): () => void;
  /** Snapshot + immediate catch-up. Attach the stream BEFORE calling (SPEC S8.1). */
  start(): Promise<void>;
  /** Visible-page fallback: snapshot refresh + catch-up (SPEC S8.6). */
  refreshAndCatchUp(): Promise<void>;
  onStreamOpen(reopened: boolean): void;
  onStreamError(): void;
  /** A content-free invalidation: dirty flag + maximum hinted highSeq. */
  hint(highSeq: number): void;
  /** Abort in-flight reads and detach. Idempotent. */
  stop(): void;
}

export function createHqCatchUp(deps: HqCatchUpDeps): HqCatchUp {
  const fetcher = deps.fetcher ?? hqHttpFetcher;
  const pageLimit = deps.pageLimit ?? HQ_PAGE_LIMIT;
  const clock = deps.clock ?? (() => new Date().toISOString());

  const state: HqCatchUpState = initialState(deps.companyId);
  const listeners = new Set<(state: HqCatchUpState) => void>();
  let flight: Promise<void> | null = null;
  // One controller for the engine's lifetime: `stop()` aborts every read that
  // is still in the air, so a company switch cannot land foreign bytes.
  const controller = new AbortController();
  let stopped = false;
  let dirtyVersion = 0;
  let maxHintedSeq = 0;
  let repeatRequested = false;

  const emit = () => {
    const snapshot = { ...state, feed: state.feed.slice() };
    for (const listener of Array.from(listeners)) {
      try {
        listener(snapshot);
      } catch {
        /* a listener must never break the engine */
      }
    }
  };

  const signal = () => controller.signal;

  /** Drop a response that is not provably this company's scope (Q08: no A rows on B). */
  const scopeMatches = (bodyCompanyId: string) => bodyCompanyId === state.companyId;

  async function requestPage(after: number, through: number): Promise<HqActivityPageResponse> {
    const body = await fetcher(hqActivityUrl(after, through, pageLimit), signal() as AbortSignal);
    if (!isPageBody(body) || !scopeMatches(body.companyId)) {
      throw new HqFetchError(200, body);
    }
    return body;
  }

  async function requestSnapshot(): Promise<HqSnapshotResponse> {
    const body = await fetcher(hqSnapshotUrl(), signal() as AbortSignal);
    if (!isSnapshotBody(body) || !scopeMatches(body.companyId)) {
      throw new HqFetchError(200, body);
    }
    return body;
  }

  /**
   * SPEC S8.2/S8.5. First visit or an explicit reset initializes the retained
   * window and BOTH cursors; an ordinary refresh preserves feedCursor, merges
   * the snapshot's rows by id, and never jumps the cursor forward just because
   * current state is newer.
   */
  function applySnapshot(snapshot: HqSnapshotResponse, initializeFeed: boolean): void {
    const isFirst = !state.feedCursorInitialized;
    // Server high-water moved backwards = database restored under us.
    const restored = state.feedCursorInitialized && state.feedCursor > snapshot.highSeq;

    if (initializeFeed || isFirst || restored) {
      state.feed = mergeHqFeed([], snapshot.activities);
      state.feedCursor = snapshot.highSeq;
      state.feedCursorInitialized = true;
      state.feedLabel = 'recent';
      if (restored) state.historyUnavailable = true;
    } else {
      state.feed = mergeHqFeed(state.feed, snapshot.activities);
    }

    state.stateSeq = snapshot.highSeq;
    // A restore means the server's high-water went BACKWARDS; accepting the
    // decrease is the whole point, so the snapshot is authoritative there.
    state.highSeq = restored ? snapshot.highSeq : Math.max(state.highSeq, snapshot.highSeq);
    state.prunedThroughSeq = snapshot.prunedThroughSeq;
    state.roster = snapshot.roster;
    state.layout = snapshot.layout;
    state.layoutRevision = snapshot.layoutRevision;
    state.captureHealth = snapshot.captureHealth;
    state.taskLinks = snapshot.taskLinks;
    // A snapshot proves CURRENT STATE, never that history is complete: the feed
    // is only 'ready' when this call seeded the window or a drain applied pages.
    if (initializeFeed || isFirst || restored) state.feedStatus = 'ready';
    state.snapshotStatus = 'ready';
    state.snapshotAt = clock();
    emit();
  }

  /**
   * SPEC S8.5: retention reset / restore recovery. Fetch a fresh snapshot,
   * reset BOTH cursors, say "Older activity unavailable", and never emit a
   * misleading delta.
   */
  async function resetFromSnapshot(): Promise<void> {
    try {
      const snapshot = await requestSnapshot();
      state.feedCursorInitialized = true;
      state.feedCursor = snapshot.highSeq;
      state.feed = mergeHqFeed([], snapshot.activities);
      state.feedLabel = 'recent';
      state.stateSeq = snapshot.highSeq;
      state.highSeq = Math.max(snapshot.highSeq, 0);
      state.prunedThroughSeq = snapshot.prunedThroughSeq;
      state.roster = snapshot.roster;
      state.layout = snapshot.layout;
      state.layoutRevision = snapshot.layoutRevision;
      state.captureHealth = snapshot.captureHealth;
      state.taskLinks = snapshot.taskLinks;
      state.feedStatus = 'ready';
      state.snapshotStatus = 'ready';
      state.snapshotAt = clock();
      state.historyUnavailable = true;
      maxHintedSeq = Math.max(maxHintedSeq, snapshot.highSeq);
    } catch (error) {
      if (isAbort(error)) return;
      // Cannot prove the reset: keep the last truthful state, labeled stale.
      state.feedStatus = 'stale';
      state.snapshotStatus = state.snapshotAt ? 'stale' : 'idle';
    } finally {
      emit();
    }
  }

  async function refreshSnapshot(initializeFeed: boolean): Promise<void> {
    try {
      const snapshot = await requestSnapshot();
      applySnapshot(snapshot, initializeFeed);
    } catch (error) {
      if (isAbort(error)) return;
      // A stale or failed snapshot keeps the last successful state and stays
      // LABELED: never replaced with an empty company, and a first-load failure
      // is 'stale', never an empty success (SPEC S8.7, Q08).
      state.snapshotStatus = 'stale';
      // Only a feed that never received anything is stale as a feed; a drained
      // feed stays `ready` and the stale label lands on the snapshot alone.
      if (!state.feedCursorInitialized) state.feedStatus = 'stale';
      emit();
    }
  }

  async function drain(): Promise<void> {
    let pages = 0;
    let reset = false;

    if (state.feedCursorInitialized === false) {
      state.feedStatus = 'loading';
      emit();
    }

    for (;;) {
      const through = Math.max(state.highSeq, maxHintedSeq);
      if (state.feedCursor >= through) break;
      if (pages >= HQ_MAX_PAGES_PER_CATCHUP) {
        // Bounded guard, not a silent cap: refuse to spin and label the surface.
        state.feedStatus = 'stale';
        emit();
        return;
      }
      pages += 1;
      maxHintedSeq = 0;

      let page: HqActivityPageResponse;
      try {
        page = await requestPage(state.feedCursor, through);
      } catch (error) {
        if (isAbort(error)) return;
        // Cursor does not advance past a page that was never applied.
        state.feedStatus = 'stale';
        emit();
        return;
      }

      if (page.resetRequired || state.feedCursor < state.prunedThroughSeq) {
        reset = true;
        break;
      }

      // Apply, THEN advance — a page is only "fed" once its rows are shown.
      state.feed = mergeHqFeed(state.feed, page.events);
      state.feedCursor = page.nextAfter;
      state.highSeq = Math.max(state.highSeq, page.through);
      state.prunedThroughSeq = Math.max(state.prunedThroughSeq, page.prunedThroughSeq);
      state.feedStatus = 'ready';
      emit();

      // `nextAfter === through` on the final page even with no scoped rows.
      if (!page.hasMore || state.feedCursor >= through) break;
    }

    if (reset) {
      await resetFromSnapshot();
      return;
    }
    // Refresh current state after the batch WITHOUT touching feedCursor.
    await refreshSnapshot(false);
  }

  /**
   * SPEC S8.3/S8.4: drain to the known watermark, refresh current state, and
   * REPEAT while either a hint arrived during the drain or the refreshed
   * snapshot shows the server high-water moved past the cursor. That last
   * condition is what makes the reconnect path work at all: the client only
   * learns the new high-water from a snapshot, so a snapshot that reveals more
   * history must feed another drain rather than ending the cycle one row short.
   */
  async function run(): Promise<void> {
    if (stopped) return;
    if (!state.feedCursorInitialized) {
      await refreshSnapshot(true);
    }
    for (let round = 0; round < HQ_MAX_CATCHUP_ROUNDS; round += 1) {
      const dirtyAtStart = dirtyVersion;
      repeatRequested = false;
      await drain();
      if (stopped) return;

      const stillDirty = repeatRequested || dirtyVersion !== dirtyAtStart;
      // The snapshot refresh inside drain is the only place the client learns
      // the server moved on; a watermark beyond the cursor ends the cycle only
      // once that history has actually been drained.
      const movedAhead = state.highSeq > state.feedCursor;
      if (!stillDirty && !movedAhead) return;
      // Bounded, never a silent cap and never a spin: live traffic whose
      // watermark keeps climbing ends the cycle at the bound and the next
      // hint / fallback tick resumes from the already-advanced cursor.
    }
  }

  function isAbort(error: unknown): boolean {
    return stopped || controller.signal.aborted || (error instanceof Error && error.name === 'AbortError');
  }

  return {
    getState: () => ({ ...state, feed: state.feed.slice() }),

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    async start() {
      if (flight) return flight;
      if (stopped) return;
      state.snapshotStatus = 'loading';
      emit();
      flight = run().finally(() => {
        flight = null;
      });
      return flight;
    },

    async refreshAndCatchUp() {
      if (stopped) return;
      if (flight) {
        // One in-flight catch-up per scope: mark for repeat instead of stacking.
        repeatRequested = true;
        return flight;
      }
      flight = run().finally(() => {
        flight = null;
      });
      return flight;
    },

    onStreamOpen(reopened) {
      state.connection = 'live';
      emit();
      if (reopened) {
        // Deltas may have been missed while the socket was down: dirty + catch-up.
        dirtyVersion += 1;
        repeatRequested = true;
        void this.refreshAndCatchUp();
      }
    },

    onStreamError() {
      state.connection = 'reconnecting';
      emit();
    },

    hint(highSeq) {
      if (!isSafeCount(highSeq)) return;
      maxHintedSeq = Math.max(maxHintedSeq, highSeq);
      dirtyVersion += 1;
      repeatRequested = true;
      if (!flight) void this.refreshAndCatchUp();
    },

    stop() {
      stopped = true;
      controller.abort();
      listeners.clear();
    },
  };
}

/* ================================================================== *
 * React binding
 * ================================================================== */

export interface UseHqStateOptions {
  /** Null = no company bound yet; the hook stays idle and holds no bytes. */
  companyId: string | null;
  fetcher?: HqFetcher;
  /** Visible-page fallback cadence (SPEC S8.6: every 30 seconds). */
  visibleRefreshMs?: number;
}

export interface UseHqStateResult extends HqCatchUpState {
  /** Manual catch-up (also driven by the visible-page fallback). */
  refresh: () => void;
}

export function useHqState(options: UseHqStateOptions): UseHqStateResult {
  const { companyId, fetcher, visibleRefreshMs = HQ_VISIBLE_REFRESH_MS } = options;

  const [state, setState] = useState<HqCatchUpState>(() => initialState(companyId));
  const coreRef = useRef<HqCatchUp | null>(null);

  useEffect(() => {
    if (!companyId) {
      // Changing/unbinding company clears both cursors and the feed BEFORE any
      // new bytes are fetched.
      coreRef.current?.stop();
      coreRef.current = null;
      setState(initialState(null));
      return;
    }

    const core = createHqCatchUp({ companyId, fetcher });
    coreRef.current = core;
    setState(core.getState());

    // 1) Stream first (reused, ref-counted — never a second connection).
    const listener: SseListener = (event) => {
      const hint = readHqHint(event);
      if (!hint || hint.companyId !== companyId) return; // unproven scope: DROP
      core.hint(hint.highSeq);
    };
    const release = acquireEventStream('/api/events/stream', listener, {
      onOpen: ({ reopened }) => core.onStreamOpen(reopened),
      onError: () => core.onStreamError(),
    });

    // 2) Then snapshot + immediate catch-up.
    const unsubscribe = core.subscribe(setState);
    void core.start();

    return () => {
      unsubscribe();
      release();
      core.stop();
      if (coreRef.current === core) coreRef.current = null;
    };
  }, [companyId, fetcher]);

  // Visible-page fallback: refresh on a 30s cadence and on visibility regain.
  useEffect(() => {
    if (!companyId) return;
    const refreshIfVisible = () => {
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
      coreRef.current?.refreshAndCatchUp();
    };
    const timer = setInterval(refreshIfVisible, visibleRefreshMs);
    const onVisibility = () => {
      if (document.visibilityState === 'visible') refreshIfVisible();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [companyId, visibleRefreshMs]);

  return {
    ...state,
    refresh: () => {
      void coreRef.current?.refreshAndCatchUp();
    },
  };
}
