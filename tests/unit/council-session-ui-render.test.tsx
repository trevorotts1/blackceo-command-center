/**
 * CWE-034 - live session, verdict, history, source, and outcome
 * screens: REAL render tests.
 *
 * Renders the actual CWE-034 components (react-dom via
 * @testing-library/react + jsdom, see vitest.component.config.ts)
 * against the labeled synthetic fixtures in
 * src/components/council/council-session-fixtures.ts (verification
 * level: contract_tested; fictional decision, brief, cards, and
 * verdict; not live product evidence).
 *
 * Acceptance covered (Directive Sections 18, 21, 24, 28; CWE-034
 * brief):
 * - Reducer-driven live updates over the real CWE-030 reducer: a
 *   card commit changes exactly one seat; a duplicate event changes
 *   nothing; a gap event triggers the resync state, not partial
 *   application.
 * - Reconnect catch-up: a disconnect shows the visible disconnected
 *   state with the last committed projection intact (never a falsely
 *   completed session); reconnect restores the live state.
 * - The private invalidation answer renders the private state and no
 *   room; a sample session carries the fictional sample badge.
 * - Verdict section order asserted in rendered output (Section
 *   21.2); dissent and conditions foregrounded (T103); score
 *   coverage as recorded; a null score reads "Not scored", never 0.
 * - Invalid verdict renders the explicit invalid state; no verdict
 *   renders the explicit not-ready state.
 * - Source drawer: recorded sources with locators and the
 *   bibliographic_only qualification; no verified quotation exists,
 *   and the drawer says so plainly (candidate text never shown).
 * - History rerun comparison renders both preserved verdicts and
 *   the changed-input diff (T024); search filters the list.
 * - Company-switch cache partition (T081): after setScope to a new
 *   company, no prior company's data renders, even from cache.
 * - Follow-up cannot mutate the parent (T104): the parent verdict
 *   region is byte-identical before and after, on both the
 *   FEATURE_NOT_READY path and the accepted path.
 * - Outcome form keeps predicted and actual in separate fields and
 *   preserves the prediction snapshot verbatim (T107).
 *
 * npx vitest run --config vitest.component.config.ts
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import {
  render,
  screen,
  cleanup,
  within,
  fireEvent,
  waitFor,
  act,
} from '@testing-library/react';

import { CouncilClientReducer } from '../../src/lib/council/events/reducer';
import { projectSession } from '../../src/lib/council/events/projection';
import type {
  CouncilCatchUp,
  CouncilResyncSnapshot,
  CouncilWireEvent,
} from '../../src/lib/council/events/types';

import { CouncilLiveSession } from '../../src/components/council/CouncilLiveSession';
import { CouncilVerdict } from '../../src/components/council/CouncilVerdict';
import { CouncilSourceDrawer } from '../../src/components/council/CouncilSourceDrawer';
import {
  CouncilHistory,
  CouncilRerunComparison,
} from '../../src/components/council/CouncilHistory';
import { CouncilFollowUp } from '../../src/components/council/CouncilFollowUp';
import { CouncilOutcomeForm } from '../../src/components/council/CouncilOutcomeForm';
import { fixtureMedallionSrcs } from '../../src/components/council/council-room-fixtures';
import {
  CouncilApiClient,
  FetchCouncilSessionTransport,
  CouncilApiClientError,
  type CouncilSessionTransport,
  type CouncilStreamHandlers,
} from '../../src/components/council/council-session-client';
import {
  CouncilScopeCache,
  buildSeatSources,
  diffBriefs,
} from '../../src/components/council/council-session-types';
import {
  FIXTURE_BRIEF,
  FIXTURE_CARDS,
  FIXTURE_CHILD_BRIEF,
  FIXTURE_CHILD_VERDICT,
  FIXTURE_EVENT_CARD_ALICHE,
  FIXTURE_EVENT_CARD_OPRAH_SEQ4,
  FIXTURE_EVENT_CARD_SINEK,
  FIXTURE_EVENT_CREATED,
  FIXTURE_EVENT_GAP,
  FIXTURE_HISTORY,
  FIXTURE_OPTION_LABELS,
  FIXTURE_SCOPE,
  FIXTURE_SESSION_ID,
  FIXTURE_VERDICT,
  FIXTURE_VERDICT_READ,
  FIXTURE_VERDICT_READ_INVALID,
  FIXTURE_VERDICT_READ_NOT_READY,
} from '../../src/components/council/council-session-fixtures';

const { small, large } = fixtureMedallionSrcs('/portraits');

beforeEach(() => {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
});

afterEach(() => {
  cleanup();
});

/* ── Transport and snapshot helpers ─────────────────────────────────── */

function snapshotOf(events: CouncilWireEvent[]): CouncilResyncSnapshot {
  const journal = events.map((e) => ({
    event_id: e.event_id,
    type: e.type,
    sequence: e.sequence,
    from_state: e.from_state,
    to_state: e.to_state,
    actor_subject: e.actor_subject,
    payload: e.payload,
    created_at: e.occurred_at,
  }));
  const projection = projectSession(FIXTURE_SCOPE, journal);
  if (!projection) throw new Error('fixture projection failed');
  return {
    kind: 'snapshot',
    session_id: FIXTURE_SESSION_ID,
    projection,
    last_sequence: events.reduce((max, e) => Math.max(max, e.sequence), 0),
  };
}

function pageOf(events: CouncilWireEvent[], hasMore = false): CouncilCatchUp {
  return {
    kind: 'page',
    page: {
      kind: 'events',
      session_id: FIXTURE_SESSION_ID,
      events,
      last_sequence: events.reduce((max, e) => Math.max(max, e.sequence), 0),
      has_more: hasMore,
    },
  };
}

class FakeTransport implements CouncilSessionTransport {
  handlers: CouncilStreamHandlers | null = null;
  pages: CouncilCatchUp[] = [];
  constructor(private readonly snapshotResult: CouncilCatchUp) {}
  snapshot(): Promise<CouncilCatchUp> {
    return Promise.resolve(this.snapshotResult);
  }
  page(): Promise<CouncilCatchUp> {
    return Promise.resolve(this.pages.shift() ?? pageOf([]));
  }
  openStream(
    _sessionId: string,
    _after: number,
    handlers: CouncilStreamHandlers,
  ): { close: () => void } {
    this.handlers = handlers;
    return { close: () => undefined };
  }
  emit(event: CouncilWireEvent) {
    this.handlers?.onEvent(event);
  }
  disconnect() {
    this.handlers?.onDisconnect();
  }
}

function seatStatus(seatId: string): string {
  const seat = screen.getByTestId(`council-seat-${seatId}`);
  return seat.querySelector('.council-seat-status')?.textContent ?? '';
}

function renderLive(transport: FakeTransport, replay = false) {
  return render(
    <CouncilLiveSession
      sessionId={FIXTURE_SESSION_ID}
      transport={transport}
      decisionTitle={FIXTURE_BRIEF.question}
      replay={replay}
      medallionSrcBySeat={small}
      medallionLargeSrcBySeat={large}
    />,
  );
}

const NOT_READY_ERROR = new CouncilApiClientError(
  'FEATURE_NOT_READY',
  'Council session follow-up is registered but its production service is not wired in the API foundation. Owning unit: CWE-050. No operation was performed.',
  501,
  'wait_for_owning_unit',
);

/* ── The reducer contract, directly ─────────────────────────────────── */

describe('CWE-030 reducer contract as the client binding', () => {
  it('applies a card commit to exactly one seat; a duplicate changes nothing; a gap applies nothing', () => {
    const reducer = new CouncilClientReducer(FIXTURE_SESSION_ID);
    reducer.applySnapshot(snapshotOf([FIXTURE_EVENT_CREATED]));
    expect(reducer.applyEvent(FIXTURE_EVENT_CARD_SINEK)).toBe('applied');
    const afterCard = reducer.currentProjection;
    expect(afterCard?.activity.completed_cards).toBe(1);
    expect(
      afterCard?.seats.find((s) => s.seat_id === 'simon-sinek')?.status,
    ).toBe('completed');
    expect(
      afterCard?.seats.filter((s) => s.status === 'completed'),
    ).toHaveLength(1);

    expect(reducer.applyEvent(FIXTURE_EVENT_CARD_SINEK)).toBe('duplicate');
    expect(reducer.currentProjection?.activity.completed_cards).toBe(1);

    expect(reducer.applyEvent(FIXTURE_EVENT_GAP)).toBe('gap');
    expect(reducer.needsResync).toBe(true);
    expect(reducer.currentProjection?.activity.completed_cards).toBe(1);
    expect(
      reducer.currentProjection?.seats.find((s) => s.seat_id === 'oprah-winfrey')?.status,
    ).toBe('queued');
  });
});

/* ── Live session screen ────────────────────────────────────────────── */

describe('live session screen', () => {
  it('rejects malformed event envelopes without inventing a room or throwing a raw TypeError', async () => {
    const transport = new FakeTransport({
      kind: 'page',
      page: undefined,
    } as unknown as CouncilCatchUp);
    renderLive(transport);
    const error = await screen.findByTestId('council-live-error');
    expect(error.textContent).toContain('invalid event page');
    expect(screen.queryByTestId('council-room')).toBeNull();
  });

  it('renders seats only from committed events: queued is waiting, never thinking', async () => {
    const transport = new FakeTransport({
      kind: 'snapshot',
      snapshot: snapshotOf([FIXTURE_EVENT_CREATED]),
    });
    renderLive(transport);
    await screen.findByTestId('council-room');
    expect(seatStatus('simon-sinek')).toBe('Waiting in queue');
    expect(screen.getByTestId('council-live-activity').textContent).toContain(
      '0 of 9 perspectives committed',
    );
    expect(document.body.textContent?.toLowerCase()).not.toContain('thinking');
  });

  it('a card commit changes exactly one seat; a duplicate event changes nothing', async () => {
    const transport = new FakeTransport({
      kind: 'snapshot',
      snapshot: snapshotOf([FIXTURE_EVENT_CREATED]),
    });
    renderLive(transport);
    await screen.findByTestId('council-room');

    act(() => transport.emit(FIXTURE_EVENT_CARD_SINEK));
    await waitFor(() => expect(seatStatus('simon-sinek')).toBe('Completed'));
    expect(seatStatus('tiffany-aliche')).toBe('Waiting in queue');
    expect(screen.getByTestId('council-live-activity').textContent).toContain(
      '1 of 9 perspectives committed',
    );

    const roomBefore = screen.getByTestId('council-room').innerHTML;
    act(() => transport.emit(FIXTURE_EVENT_CARD_SINEK));
    expect(screen.getByTestId('council-room').innerHTML).toBe(roomBefore);
    expect(screen.getByTestId('council-live-activity').textContent).toContain(
      '1 of 9 perspectives committed',
    );
  });

  it('a gap event triggers the resync state, not partial application, then catch-up applies in order', async () => {
    const transport = new FakeTransport({
      kind: 'snapshot',
      snapshot: snapshotOf([FIXTURE_EVENT_CREATED, FIXTURE_EVENT_CARD_SINEK]),
    });
    transport.pages.push(
      pageOf([FIXTURE_EVENT_CARD_ALICHE, FIXTURE_EVENT_CARD_OPRAH_SEQ4]),
    );
    renderLive(transport);
    await screen.findByTestId('council-room');
    expect(seatStatus('simon-sinek')).toBe('Completed');

    act(() => transport.emit(FIXTURE_EVENT_GAP));
    // Synchronously after the gap: resyncing is shown and the gapped
    // event was NOT applied (Oprah is still queued, count still 1).
    expect(screen.getByTestId('council-live-resyncing')).toBeTruthy();
    expect(seatStatus('oprah-winfrey')).toBe('Waiting in queue');
    expect(screen.getByTestId('council-live-activity').textContent).toContain(
      '1 of 9 perspectives committed',
    );

    await waitFor(() => expect(seatStatus('oprah-winfrey')).toBe('Completed'));
    expect(seatStatus('tiffany-aliche')).toBe('Completed');
    expect(screen.getByTestId('council-live-activity').textContent).toContain(
      '3 of 9 perspectives committed',
    );
    expect(screen.queryByTestId('council-live-resyncing')).toBeNull();
  });

  it('disconnect shows the visible disconnected state; the session is not falsely completed; reconnect catches up', async () => {
    const transport = new FakeTransport({
      kind: 'snapshot',
      snapshot: snapshotOf([FIXTURE_EVENT_CREATED, FIXTURE_EVENT_CARD_SINEK]),
    });
    renderLive(transport);
    await screen.findByTestId('council-room');

    act(() => transport.disconnect());
    const banner = await screen.findByTestId('council-live-disconnected');
    expect(banner.textContent).toContain('Disconnected');
    expect(banner.textContent).toContain('not shown as complete');
    // The last committed state stays visible and honest.
    expect(seatStatus('simon-sinek')).toBe('Completed');
    expect(seatStatus('td-jakes')).toBe('Waiting in queue');

    fireEvent.click(screen.getByTestId('council-live-reconnect'));
    await waitFor(() =>
      expect(screen.queryByTestId('council-live-disconnected')).toBeNull(),
    );
    expect(seatStatus('simon-sinek')).toBe('Completed');
  });

  it('a private invalidation answer renders the private state and no room', async () => {
    const transport = new FakeTransport({
      kind: 'invalidation',
      signal: {
        kind: 'council.session.invalidated',
        session_id: FIXTURE_SESSION_ID,
        scope: FIXTURE_SCOPE,
        state_version: 3,
        last_sequence: 3,
        occurred_at: '2026-10-14T12:03:00.000Z',
      },
    });
    renderLive(transport);
    await screen.findByTestId('council-live-private');
    expect(screen.queryByTestId('council-room')).toBeNull();
    expect(document.body.textContent).not.toContain('Waiting in queue');
  });

  it('a sample session carries the persistent fictional sample badge', async () => {
    const sampleCreated: CouncilWireEvent = {
      ...FIXTURE_EVENT_CREATED,
      payload: { ...FIXTURE_EVENT_CREATED.payload, sample: true },
    };
    const transport = new FakeTransport({
      kind: 'snapshot',
      snapshot: snapshotOf([sampleCreated]),
    });
    renderLive(transport);
    await screen.findByTestId('council-room');
    expect(screen.getByTestId('council-shell-mode-badge').textContent).toBe(
      'Fictional sample',
    );
  });

  it('replay mode is persistently labeled and never opens the live stream', async () => {
    const transport = new FakeTransport({
      kind: 'snapshot',
      snapshot: snapshotOf([FIXTURE_EVENT_CREATED, FIXTURE_EVENT_CARD_SINEK]),
    });
    renderLive(transport, true);
    await screen.findByTestId('council-room');
    expect(screen.getByTestId('council-live-replay-note')).toBeTruthy();
    expect(screen.getByTestId('council-shell-mode-badge').textContent).toBe(
      'Recorded replay',
    );
    expect(transport.handlers).toBeNull();
  });
});

/* ── Verdict screen ─────────────────────────────────────────────────── */

function renderVerdict(overrides: Partial<Parameters<typeof CouncilVerdict>[0]> = {}) {
  return render(
    <CouncilVerdict
      verdictRead={FIXTURE_VERDICT_READ}
      optionLabels={FIXTURE_OPTION_LABELS}
      cards={FIXTURE_CARDS}
      brief={FIXTURE_BRIEF}
      mode="live"
      sessionId={FIXTURE_SESSION_ID}
      createExport={() => Promise.reject(NOT_READY_ERROR)}
      onOpenSources={() => undefined}
      {...overrides}
    />,
  );
}

describe('verdict screen', () => {
  it('renders the seven sections in the fixed Section 21 order', () => {
    renderVerdict();
    const wanted = [
      'verdict-recommendation',
      'verdict-conditions',
      'verdict-reasons',
      'verdict-concern',
      'verdict-actions',
      'verdict-scorecard',
      'verdict-detail',
    ];
    const rendered = Array.from(
      document.querySelectorAll('[data-testid]'),
    )
      .map((el) => el.getAttribute('data-testid'))
      .filter((id): id is string => id !== null && wanted.includes(id));
    expect(rendered).toEqual(wanted);
  });

  it('foregrounds ONE recommendation with its conditions and strongest dissent (T103)', () => {
    renderVerdict();
    const recommendation = screen.getByTestId('verdict-recommendation');
    expect(recommendation.textContent).toContain('Go, with conditions');
    expect(recommendation.textContent).toContain(
      'B. Pilot the revised offer with new clients',
    );
    expect(
      screen.getByTestId('verdict-conditions').textContent,
    ).toContain('Confirm the cash reserve covers the full pilot cost');
    expect(
      screen.getByTestId('verdict-strongest-dissent').textContent,
    ).toContain('Delivery capacity is unproven at twice the volume');
    // Support figures are counts, labeled as counts.
    expect(
      screen.getByTestId('verdict-resolution-support').textContent,
    ).toContain('counts, not a probability');
  });

  it('scorecard renders coverage and scores exactly as recorded; a null score is Not scored, never 0', () => {
    renderVerdict();
    const launch = screen.getByTestId('scorecard-row-opt-launch');
    expect(launch.textContent).toContain('6.6');
    expect(launch.textContent).toContain('86%');
    expect(launch.textContent).toContain('145 of 22');
    const pilot = screen.getByTestId('scorecard-row-opt-pilot');
    expect(pilot.textContent).toContain('(recommended)');

    cleanup();
    const unscored = {
      ...FIXTURE_VERDICT_READ,
      verdict: {
        ...FIXTURE_VERDICT,
        option_scores: FIXTURE_VERDICT.option_scores.map((s) =>
          s.option_id === 'opt-stay'
            ? { ...s, score: null, display_score: null, weighted_sum: 0, coverage: 0 }
            : s,
        ),
      },
    };
    renderVerdict({ verdictRead: unscored });
    const stay = screen.getByTestId('scorecard-row-opt-stay');
    expect(stay.textContent).toContain('Not scored');
    expect(stay.textContent).not.toContain('0.0');
  });

  it('an invalid verdict renders the explicit invalid state, never a polished fake', () => {
    renderVerdict({ verdictRead: FIXTURE_VERDICT_READ_INVALID });
    const invalid = screen.getByTestId('council-verdict-invalid');
    expect(invalid.textContent).toContain('failed validation');
    expect(invalid.textContent).toContain('"invalid"');
    expect(screen.queryByTestId('verdict-recommendation')).toBeNull();
    expect(screen.queryByTestId('verdict-scorecard')).toBeNull();
  });

  it('no committed verdict renders the explicit not-ready state', () => {
    renderVerdict({ verdictRead: FIXTURE_VERDICT_READ_NOT_READY });
    expect(screen.getByTestId('council-verdict-not-ready')).toBeTruthy();
    expect(screen.queryByTestId('verdict-recommendation')).toBeNull();
  });

  it('exports initiated from a replay are labeled as replay exports (T101)', async () => {
    const createExport = vi.fn(() => Promise.reject(NOT_READY_ERROR));
    renderVerdict({ mode: 'replay', createExport });
    expect(screen.getByTestId('council-export-replay-note')).toBeTruthy();
    fireEvent.click(screen.getByTestId('council-export-markdown'));
    await waitFor(() =>
      expect(createExport).toHaveBeenCalledWith(
        expect.objectContaining({ replay: true, format: 'markdown' }),
        expect.any(String),
      ),
    );
    await screen.findByTestId('council-export-markdown-state');
    expect(
      screen.getByTestId('council-export-markdown-state').textContent,
    ).toContain('Not available yet');
  });
});

/* ── Source drawer ──────────────────────────────────────────────────── */

describe('source drawer', () => {
  it('shows recorded sources with locators, the Section 7 label, and bibliographic_only qualification', () => {
    const sources = buildSeatSources(
      'simon-sinek',
      FIXTURE_CARDS,
      FIXTURE_BRIEF,
      'bibliographic_only',
    );
    render(<CouncilSourceDrawer sources={sources} onClose={() => undefined} />);
    const drawer = screen.getByTestId('council-source-drawer-simon-sinek');
    expect(drawer.textContent).toContain(
      'AI perspective inspired by the published work of Simon Sinek. Not the individual and not an endorsement.',
    );
    expect(
      screen.getByTestId('council-source-qualification').textContent,
    ).toContain('Bibliographic only');
    expect(screen.getByTestId('council-source-ev-sinek-book').textContent).toContain(
      'Publisher bibliography record for Start with Why',
    );
    expect(screen.getByTestId('council-source-ev-budget').textContent).toContain(
      'Client budget workbook, reserves tab',
    );
  });

  it('no-quotation honesty: with no verified quotation record, the drawer says so and shows no quote text', () => {
    const sources = buildSeatSources(
      'simon-sinek',
      FIXTURE_CARDS,
      FIXTURE_BRIEF,
      'bibliographic_only',
    );
    // The fixture card carries one candidate quotation; it must never
    // be displayed as a quotation.
    expect(sources.verifiedQuotes).toHaveLength(0);
    expect(sources.unverifiedQuoteCount).toBe(1);
    render(<CouncilSourceDrawer sources={sources} onClose={() => undefined} />);
    const noQuotes = screen.getByTestId('council-source-no-quotes');
    expect(noQuotes.textContent).toContain(
      'No verified quotations are recorded for this seat',
    );
    expect(document.body.textContent).not.toContain(
      'People do not buy what you do',
    );
  });
});

/* ── History and rerun comparison ───────────────────────────────────── */

describe('history and rerun comparison', () => {
  it('search filters the recorded sessions; the empty state is explicit', () => {
    const { rerender } = render(
      <CouncilHistory sessions={FIXTURE_HISTORY} loadState="ready" />,
    );
    expect(screen.getByTestId(`history-row-${FIXTURE_SESSION_ID}`)).toBeTruthy();
    fireEvent.change(screen.getByTestId('council-history-search'), {
      target: { value: 'rerun' },
    });
    expect(screen.queryByTestId(`history-row-${FIXTURE_SESSION_ID}`)).toBeNull();
    expect(
      screen.getByTestId('history-row-sess-cwe034-fixture-rerun'),
    ).toBeTruthy();

    rerender(<CouncilHistory sessions={[]} loadState="ready" />);
    expect(screen.getByTestId('council-history-empty')).toBeTruthy();
  });

  it('rerun comparison renders both preserved verdicts and the changed-input diff (T024)', () => {
    const diff = diffBriefs(FIXTURE_BRIEF, FIXTURE_CHILD_BRIEF);
    render(
      <CouncilRerunComparison
        parentTitle={FIXTURE_BRIEF.question}
        childTitle={FIXTURE_CHILD_BRIEF.question}
        parentVerdict={{
          label: FIXTURE_VERDICT.label,
          recommendedOptionLabel: 'B. Pilot the revised offer with new clients',
          verdictRevision: 1,
        }}
        childVerdict={{
          label: FIXTURE_CHILD_VERDICT.label,
          recommendedOptionLabel: 'B. Pilot the revised offer with new clients',
          verdictRevision: 1,
        }}
        diff={diff}
      />,
    );
    const parent = screen.getByTestId('rerun-parent-verdict');
    const child = screen.getByTestId('rerun-child-verdict');
    expect(parent.textContent).toContain('GO_WITH_CONDITIONS');
    expect(child.textContent).toContain('GO');
    const diffList = screen.getByTestId('rerun-diff');
    expect(diffList.textContent).toContain(
      'before: The cash reserve covers two months of operating costs.',
    );
    expect(diffList.textContent).toContain(
      'after: The cash reserve covers three months of operating costs.',
    );
    expect(diffList.textContent).toContain('A waitlist of 40 prospective clients');
    expect(document.body.textContent).toContain(
      'never edits the original decision',
    );
  });

  it('company-switch cache partition: after setScope, no prior company data renders (T081)', () => {
    const companyA = [
      {
        session_id: 'sess-company-a-secret',
        mode: 'full',
        visibility: 'company',
        state: 'COMPLETED',
        state_version: 3,
        brief_revision: 1,
        archived: false,
        owner_subject: null,
        created_at: '2026-10-14T10:00:00.000Z',
        updated_at: '2026-10-14T11:00:00.000Z',
      },
    ];
    const cache = new CouncilScopeCache();
    cache.setScope('tenant-1|company-a|principal-1');
    cache.set('sessions', companyA);

    const { rerender } = render(
      <CouncilHistory
        sessions={cache.get<(typeof companyA)>('sessions') ?? []}
        loadState="ready"
      />,
    );
    expect(screen.getByTestId('history-row-sess-company-a-secret')).toBeTruthy();

    cache.setScope('tenant-1|company-b|principal-1');
    expect(cache.get('sessions')).toBeUndefined();
    rerender(
      <CouncilHistory
        sessions={cache.get<(typeof companyA)>('sessions') ?? []}
        loadState="ready"
      />,
    );
    expect(screen.queryByTestId('history-row-sess-company-a-secret')).toBeNull();
    expect(document.body.textContent).not.toContain('sess-company-a-secret');
    expect(screen.getByTestId('council-history-empty')).toBeTruthy();
  });
});

/* ── Follow-up and outcomes ─────────────────────────────────────────── */

describe('follow-up (T104) and outcome entry (T107)', () => {
  function renderVerdictAndFollowUp(
    postFollowUp: Parameters<typeof CouncilFollowUp>[0]['postFollowUp'],
  ) {
    return render(
      <div>
        <div data-testid="parent-verdict-wrap">
          <CouncilVerdict
            verdictRead={FIXTURE_VERDICT_READ}
            optionLabels={FIXTURE_OPTION_LABELS}
            cards={FIXTURE_CARDS}
            brief={FIXTURE_BRIEF}
            mode="live"
            sessionId={FIXTURE_SESSION_ID}
          />
        </div>
        <CouncilFollowUp
          sessionId={FIXTURE_SESSION_ID}
          postFollowUp={postFollowUp}
          makeIdempotencyKey={() => 'test-key-follow-up'}
        />
      </div>,
    );
  }

  it('FEATURE_NOT_READY renders the typed state and the parent verdict region is byte-identical', async () => {
    renderVerdictAndFollowUp(() => Promise.reject(NOT_READY_ERROR));
    const before = screen.getByTestId('parent-verdict-wrap').innerHTML;
    fireEvent.change(screen.getByTestId('follow-up-question'), {
      target: { value: 'What would change your mind about capacity?' },
    });
    fireEvent.click(screen.getByTestId('follow-up-submit'));
    const notReady = await screen.findByTestId('follow-up-not-ready');
    expect(notReady.textContent).toContain('CWE-050');
    expect(screen.queryByTestId('follow-up-created')).toBeNull();
    expect(screen.getByTestId('parent-verdict-wrap').innerHTML).toBe(before);
  });

  it('an accepted follow-up creates a linked consult note and still cannot rewrite the parent', async () => {
    const postFollowUp = vi.fn(() =>
      Promise.resolve({ consult_session_id: 'sess-consult-fixture-1' }),
    );
    renderVerdictAndFollowUp(postFollowUp);
    const before = screen.getByTestId('parent-verdict-wrap').innerHTML;
    fireEvent.change(screen.getByTestId('follow-up-seat'), {
      target: { value: 'tiffany-aliche' },
    });
    fireEvent.change(screen.getByTestId('follow-up-question'), {
      target: { value: 'Does the reserve still hold at twice the volume?' },
    });
    fireEvent.click(screen.getByTestId('follow-up-submit'));
    const created = await screen.findByTestId('follow-up-created');
    expect(created.textContent).toContain('sess-consult-fixture-1');
    expect(postFollowUp).toHaveBeenCalledWith(
      FIXTURE_SESSION_ID,
      { seat_id: 'tiffany-aliche', question: 'Does the reserve still hold at twice the volume?' },
      'test-key-follow-up',
    );
    expect(screen.getByTestId('parent-verdict-wrap').innerHTML).toBe(before);
  });

  it('outcome form keeps predicted and actual in separate fields and preserves the snapshot', async () => {
    const postOutcome = vi.fn(() => Promise.reject(NOT_READY_ERROR));
    render(
      <CouncilOutcomeForm
        sessionId={FIXTURE_SESSION_ID}
        prediction={{
          recommendationText: 'GO_WITH_CONDITIONS: B. Pilot the revised offer with new clients',
          verdictRevision: 1,
          verdictContentSha256: FIXTURE_VERDICT.content_sha256,
          briefSha256: FIXTURE_VERDICT.brief_sha256,
        }}
        postOutcome={postOutcome}
        makeIdempotencyKey={() => 'test-key-outcome'}
      />,
    );
    const predicted = screen.getByTestId('outcome-predicted');
    const predictedBefore = predicted.innerHTML;
    expect(predicted.textContent).toContain('GO_WITH_CONDITIONS');
    expect(predicted.textContent).toContain(FIXTURE_VERDICT.content_sha256);

    const actual = screen.getByTestId('outcome-actual');
    fireEvent.change(within(actual).getByTestId('outcome-observed'), {
      target: { value: 'The pilot filled in nine days and stayed within the reserve.' },
    });
    fireEvent.change(within(actual).getByTestId('outcome-observed-at'), {
      target: { value: '2026-11-01' },
    });
    // Typing the actual outcome never touches the prediction region.
    expect(screen.getByTestId('outcome-predicted').innerHTML).toBe(predictedBefore);
    expect(predicted.textContent).not.toContain('filled in nine days');

    fireEvent.click(screen.getByTestId('outcome-submit'));
    const notReady = await screen.findByTestId('outcome-not-ready');
    expect(notReady.textContent).toContain('CWE-050');
    expect(postOutcome).toHaveBeenCalledWith(
      FIXTURE_SESSION_ID,
      expect.objectContaining({
        observed_outcome: 'The pilot filled in nine days and stayed within the reserve.',
        verdict_content_sha256: FIXTURE_VERDICT.content_sha256,
      }),
      'test-key-outcome',
    );
    expect(screen.getByTestId('outcome-predicted').innerHTML).toBe(predictedBefore);
  });

  it('with no validated verdict, outcome entry refuses rather than inventing a prediction', () => {
    render(
      <CouncilOutcomeForm
        sessionId={FIXTURE_SESSION_ID}
        prediction={null}
        postOutcome={() => Promise.resolve({})}
      />,
    );
    expect(screen.getByTestId('outcome-no-prediction')).toBeTruthy();
    expect(screen.queryByTestId('outcome-observed')).toBeNull();
  });
});


describe('independent QC: route changes with memoized transport', () => {
  it('accepts a valid second-session snapshot after the sessionId prop changes', async () => {
    const original = snapshotOf([FIXTURE_EVENT_CREATED]);
    const transport: CouncilSessionTransport = {
      snapshot: async (id) => ({kind: 'snapshot', snapshot: {
        ...original, session_id: id,
        projection: {...original.projection, session_id: id,
          scope: {...original.projection.scope, session_id: id}},
      }}),
      page: async () => pageOf([]),
      openStream: () => ({close: () => undefined}),
    };
    const props = {transport, decisionTitle: FIXTURE_BRIEF.question,
      medallionSrcBySeat: small, medallionLargeSrcBySeat: large};
    const view = render(<CouncilLiveSession {...props} sessionId={FIXTURE_SESSION_ID} />);
    await screen.findByTestId('council-room');
    view.rerender(<CouncilLiveSession {...props} sessionId="second-authorized-session" />);
    await act(async () => { await Promise.resolve(); });
    expect(screen.queryByTestId('council-live-error')).toBeNull();
    expect(screen.getByTestId('council-room')).toBeTruthy();
  });
});


describe('independent QC: production snapshot envelope', () => {
  it('renders the direct snapshot envelope returned by GET events?snapshot=1', async () => {
    const snapshot = snapshotOf([FIXTURE_EVENT_CREATED]);
    const client = new CouncilApiClient({ fetchFn: async () => new Response(
      JSON.stringify({ok: true, data: snapshot, request_id: 'qc-read'}),
      {status: 200, headers: {'Content-Type': 'application/json'}},
    )});
    render(<CouncilLiveSession sessionId={FIXTURE_SESSION_ID}
      transport={new FetchCouncilSessionTransport(client)}
      decisionTitle={FIXTURE_BRIEF.question} medallionSrcBySeat={small} />);
    await act(async () => { await Promise.resolve(); });
    expect(screen.queryByTestId('council-live-error')).toBeNull();
    expect(screen.getByTestId('council-room')).toBeTruthy();
  });
});


describe('production snapshot privacy and malformed response boundary', () => {
  function transportFor(data: unknown) {
    const fetchFn = vi.fn(async (_input: string, _init?: RequestInit) => new Response(JSON.stringify({
      ok: true, data, request_id: 'qc-snapshot-boundary',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    const transport = new FetchCouncilSessionTransport(new CouncilApiClient({ fetchFn }));
    const openStream = vi.spyOn(transport, 'openStream');
    return { transport, fetchFn, openStream };
  }

  function renderTransport(transport: CouncilSessionTransport) {
    render(<CouncilLiveSession sessionId={FIXTURE_SESSION_ID} transport={transport}
      decisionTitle={FIXTURE_BRIEF.question} medallionSrcBySeat={small} />);
  }

  it('renders direct support-only invalidation as private without opening a stream or reading more data', async () => {
    const signal = {
      kind: 'council.session.invalidated', session_id: FIXTURE_SESSION_ID,
      scope: FIXTURE_SCOPE, state_version: 3, last_sequence: 2,
      occurred_at: '2026-10-14T12:00:00Z',
    };
    const { transport, fetchFn, openStream } = transportFor(signal);
    renderTransport(transport);
    await screen.findByTestId('council-live-private');
    expect(screen.queryByTestId('council-room')).toBeNull();
    expect(screen.queryByTestId('council-live-error')).toBeNull();
    expect(openStream).not.toHaveBeenCalled();
    expect(fetchFn).toHaveBeenCalledOnce();
    expect(fetchFn.mock.calls[0]?.[0]).toContain('/events?snapshot=1');
  });

  const valid = snapshotOf([FIXTURE_EVENT_CREATED]);
  it.each([
    ['null response', null],
    ['unknown kind', { kind: 'unexpected', session_id: FIXTURE_SESSION_ID }],
    ['foreign snapshot', { ...valid, session_id: 'foreign-session' }],
    ['foreign projection', { ...valid, projection: { ...valid.projection, session_id: 'foreign-session' } }],
    ['missing projection', { ...valid, projection: undefined }],
    ['malformed seats', { ...valid, projection: { ...valid.projection, seats: null } }],
    ['obsolete nested snapshot wrapper', { kind: 'snapshot', snapshot: valid }],
    ['foreign invalidation', { kind: 'council.session.invalidated', session_id: 'foreign-session' }],
  ])('fails closed for %s', async (_label, data) => {
    const { transport, fetchFn, openStream } = transportFor(data);
    renderTransport(transport);
    const error = await screen.findByTestId('council-live-error');
    expect(error.textContent).toContain('invalid session snapshot');
    expect(screen.queryByTestId('council-room')).toBeNull();
    expect(screen.queryByTestId('council-live-private')).toBeNull();
    expect(openStream).not.toHaveBeenCalled();
    expect(fetchFn).toHaveBeenCalledOnce();
  });
});


describe('session ownership during delayed reads and stale callbacks', () => {
  function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => { resolve = done; });
    return { promise, resolve };
  }
  function scopedSnapshot(id: string, completed = false): CouncilCatchUp {
    const snapshot = snapshotOf(completed
      ? [FIXTURE_EVENT_CREATED, FIXTURE_EVENT_CARD_SINEK] : [FIXTURE_EVENT_CREATED]);
    return { kind: 'snapshot', snapshot: {
      ...snapshot, session_id: id,
      projection: { ...snapshot.projection, session_id: id,
        scope: { ...snapshot.projection.scope, session_id: id } },
    } };
  }
  function invalidation(id: string): CouncilCatchUp {
    return { kind: 'invalidation', signal: {
      kind: 'council.session.invalidated', session_id: id,
      scope: { ...FIXTURE_SCOPE, session_id: id }, state_version: 3,
      last_sequence: 2, occurred_at: '2026-10-14T12:00:00Z',
    } };
  }
  function element(id: string, transport: CouncilSessionTransport) {
    return <CouncilLiveSession sessionId={id} transport={transport}
      decisionTitle={FIXTURE_BRIEF.question} medallionSrcBySeat={small} />;
  }

  it('hides prior private content synchronously during the second read and ignores closed-stream callbacks', async () => {
    const next = deferred<CouncilCatchUp>();
    let oldHandlers!: CouncilStreamHandlers;
    const closed = vi.fn();
    const transport: CouncilSessionTransport = {
      snapshot: (id) => id === FIXTURE_SESSION_ID
        ? Promise.resolve(scopedSnapshot(id, true)) : next.promise,
      page: async () => pageOf([]),
      openStream: (_id, _cursor, handlers) => { oldHandlers = handlers; return { close: closed }; },
    };
    const view = render(element(FIXTURE_SESSION_ID, transport));
    await screen.findByTestId('council-room');
    expect(seatStatus('simon-sinek')).toBe('Completed');
    view.rerender(element('private-second-session', transport));
    expect(screen.queryByTestId('council-room')).toBeNull();
    expect(screen.getByTestId('council-live-loading')).toBeTruthy();
    expect(closed).toHaveBeenCalledOnce();
    await act(async () => {
      oldHandlers.onSnapshot(snapshotOf([FIXTURE_EVENT_CREATED, FIXTURE_EVENT_CARD_SINEK]));
      oldHandlers.onEvent(FIXTURE_EVENT_CARD_ALICHE);
      oldHandlers.onInvalidation();
      oldHandlers.onStreamError('private old-session error');
      oldHandlers.onDisconnect();
    });
    expect(screen.getByTestId('council-live-loading')).toBeTruthy();
    expect(screen.queryByTestId('council-room')).toBeNull();
    await act(async () => { next.resolve(invalidation('private-second-session')); });
    expect(screen.getByTestId('council-live-private')).toBeTruthy();
    expect(screen.queryByTestId('council-room')).toBeNull();
  });

  it('ignores an old resync promise after the next session has loaded', async () => {
    const pendingPage = deferred<CouncilCatchUp>();
    const handlersById = new Map<string, CouncilStreamHandlers>();
    const page = vi.fn(() => pendingPage.promise);
    const transport: CouncilSessionTransport = {
      snapshot: async (id) => scopedSnapshot(id, id === FIXTURE_SESSION_ID),
      page,
      openStream: (id, _cursor, handlers) => {
        handlersById.set(id, handlers); return { close: () => undefined };
      },
    };
    const view = render(element(FIXTURE_SESSION_ID, transport));
    await screen.findByTestId('council-room');
    await act(async () => { handlersById.get(FIXTURE_SESSION_ID)!.onEvent(FIXTURE_EVENT_GAP); });
    expect(page).toHaveBeenCalledOnce();
    view.rerender(element('authorized-second-session', transport));
    expect(screen.queryByTestId('council-room')).toBeNull();
    await screen.findByTestId('council-room');
    expect(seatStatus('simon-sinek')).toBe('Waiting in queue');
    await act(async () => { pendingPage.resolve(invalidation(FIXTURE_SESSION_ID)); });
    expect(screen.queryByTestId('council-live-private')).toBeNull();
    expect(screen.getByTestId('council-room')).toBeTruthy();
    expect(seatStatus('simon-sinek')).toBe('Waiting in queue');
  });

  it('ignores an old initial snapshot that resolves after the next session', async () => {
    const first = deferred<CouncilCatchUp>();
    const transport: CouncilSessionTransport = {
      snapshot: (id) => id === FIXTURE_SESSION_ID
        ? first.promise : Promise.resolve(scopedSnapshot(id)),
      page: async () => pageOf([]),
      openStream: () => ({ close: () => undefined }),
    };
    const view = render(element(FIXTURE_SESSION_ID, transport));
    view.rerender(element('authorized-second-session', transport));
    await screen.findByTestId('council-room');
    await act(async () => { first.resolve(scopedSnapshot(FIXTURE_SESSION_ID, true)); });
    expect(screen.getByTestId('council-room')).toBeTruthy();
    expect(seatStatus('simon-sinek')).toBe('Waiting in queue');
  });
});
