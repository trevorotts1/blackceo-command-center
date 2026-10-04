/**
 * B26 — ActivityFeed Q10 acceptance: privacy, hostile markup and history.
 *
 * Scope is the unit's own acceptance (`swarm-plan.json` B26: "Q10
 * privacy/markup/history tests; no synthetic feed presented as real
 * integration") against the frozen P01 contract in `src/lib/hq/types.ts`.
 * Written for the repo's existing Node test runner, the same command shape
 * P01's own suite uses:
 *
 *   node --import tsx --import tests/setup/no-owner-telegram.ts \
 *     --import tests/setup/tmp-sandbox.ts --test \
 *     tests/unit/hq/B26/activity-feed.test.ts
 *
 * The component is driven ONLY through its props. There is no network stub for
 * the feed to hit, because the feed has no fetch path: `globalThis.fetch` is
 * asserted untouched, which is what "no synthetic feed presented as real
 * integration" means for a presentational unit — every rendered row traces to a
 * caller-supplied event, and nothing is invented when the caller supplies none.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
// `tests/**` sits outside tsconfig's `include`, so the repo's tsx transform
// emits classic JSX for this file (react-jsx applies only under `src/**`). The
// explicit React import is what keeps this suite runnable under the plain Node
// runner; it is a test-file requirement, not a component requirement.
import React from 'react';
import { JSDOM } from 'jsdom';
import type {
  HqActivityEvent,
  HqPublicDecisionPayload,
  HqPublicExchangePayload,
  HqPublicOwnerNotePayload,
  HqPublicTaskPayload,
} from '../../../../src/lib/hq/types';
import ActivityFeed, { hqCaptureCoverage } from '../../../../src/components/hq/ActivityFeed';

/* ------------------------------------------------------------------ *
 * DOM bootstrap — jsdom globals must exist before @testing-library/react
 * is imported, so the import is dynamic and happens inside `before`.
 * ------------------------------------------------------------------ */

type Rtl = typeof import('@testing-library/react');
let rtl: Rtl;

/**
 * Element factory — this file carries no JSX. `tests/**` is outside tsconfig's
 * `include`, so the repo's tsx transform emits classic JSX here (react-jsx
 * applies only under `src/**`). Building elements explicitly keeps the suite on
 * the lease's `.test.ts` convention (swarm-plan ownership_rules) and runnable
 * under the repo's Node test runner with no extra transform.
 */
type FeedProps = Parameters<typeof ActivityFeed>[0];
function feed(props: FeedProps = { events: [] }) {
  return React.createElement(ActivityFeed, props);
}

test.before(async () => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://hq.test/' });
  const g = globalThis as unknown as Record<string, unknown>;
  g.window = dom.window;
  g.document = dom.window.document;
  g.navigator = dom.window.navigator;
  g.HTMLElement = dom.window.HTMLElement;
  g.Node = dom.window.Node;
  g.Event = dom.window.Event;
  g.MouseEvent = dom.window.MouseEvent;
  g.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
  g.requestAnimationFrame = (cb: (t: number) => void) => dom.window.setTimeout(() => cb(Date.now()), 0);
  g.cancelAnimationFrame = (id: number) => dom.window.clearTimeout(id);
  g.IS_REACT_ACT_ENVIRONMENT = true;
  rtl = await import('@testing-library/react');
});

test.afterEach(() => {
  rtl.cleanup();
});

/* ------------------------------------------------------------------ *
 * Fixtures — frozen contract shapes only
 * ------------------------------------------------------------------ */

function event(over: Partial<HqActivityEvent> & Pick<HqActivityEvent, 'id' | 'kind' | 'phase' | 'payload'>): HqActivityEvent {
  return {
    seq: 1,
    taskId: null,
    actorLabel: null,
    recipientLabel: null,
    occurredAt: null,
    receivedAt: '2026-10-04T02:15:00.000Z',
    reference: 'ref:1',
    ...over,
  };
}

const taskPayload: HqPublicTaskPayload = { status: 'in_progress', previousStatus: 'backlog' };
const notePayload: HqPublicOwnerNotePayload = { text: 'Ship the Thursday batch.' };
const decisionPayload: HqPublicDecisionPayload = {
  intent: 'route_support',
  routeAction: 'assign_department',
  departmentSlug: 'marketing',
  confidenceBps: 7300,
  fallback: false,
  mode: 'applied',
  resolvedBy: 'jev',
};
const exchangePayload: HqPublicExchangePayload = { message: 'Please pick this up.', summary: 'Handoff requested' };

const ALL_SOURCES: HqActivityEvent[] = [
  event({ id: 'a1', seq: 11, kind: 'task', phase: 'status_changed', payload: taskPayload, actorLabel: 'Dana Ops', recipientLabel: 'Marketing', reference: 'transition:aud-11', occurredAt: '2026-10-04T02:14:00.000Z', taskId: 'task-7' }),
  event({ id: 'a2', seq: 12, kind: 'owner_note', phase: 'recorded', payload: notePayload, actorLabel: 'Owner', reference: 'activity:act-12', taskId: 'task-7' }),
  event({ id: 'a3', seq: 13, kind: 'decision', phase: 'applied', payload: decisionPayload, reference: 'decision:corr-13:applied' }),
  event({ id: 'a4', seq: 14, kind: 'exchange', phase: 'replied', payload: exchangePayload, actorLabel: 'Router', recipientLabel: 'Billing', reference: 'exchange:ex-14:replied' }),
];

/* ------------------------------------------------------------------ *
 * Every allowed source renders, with its truthful phase
 * ------------------------------------------------------------------ */

test('B26/all-sources: every allowed kind renders with source tag, reference and phase', () => {
  const { container } = rtl.render(feed({ events: ALL_SOURCES }));
  const rows = container.querySelectorAll('[data-testid="hq-activity-row"]');
  assert.equal(rows.length, 4, 'one row per supplied event, none dropped');

  const kinds = Array.from(rows, (row) => row.getAttribute('data-kind'));
  assert.deepEqual(kinds, ['task', 'owner_note', 'decision', 'exchange']);

  const text = container.textContent ?? '';
  assert.match(text, /Task/);
  assert.match(text, /Owner note/);
  assert.match(text, /Decision/);
  assert.match(text, /Exchange/);
  // Reference strings are the source tags.
  for (const e of ALL_SOURCES) assert.ok(text.includes(e.reference), `reference ${e.reference} rendered`);
  // Truthful phases (S5), including "acceptance is not completion".
  assert.match(text, /Status changed/);
  assert.match(text, /Recorded/);
  assert.match(text, /Applied/);
  assert.match(text, /Reply generated/);
  assert.ok(!/delivered/i.test(text), 'a generated reply is never labelled delivered');
  // Positive control for the task-link assertions: a bound event DOES render its
  // task id, so the `taskId: null` case below proves discrimination, not absence.
  assert.equal(rows[0].querySelector('[data-task-id]')?.getAttribute('data-task-id'), 'task-7');
  assert.equal(rows[2].querySelector('[data-task-id]'), null, 'a taskId-less event renders no task link');
});

test('B26/times: actor/recipient labels, occurred and received times are shown; absent times say so', () => {
  const { container } = rtl.render(feed({ events: ALL_SOURCES }));
  const rows = Array.from(container.querySelectorAll('[data-testid="hq-activity-row"]'));
  const first = rows[0];
  assert.match(first.textContent ?? '', /Dana Ops/);
  assert.match(first.textContent ?? '', /Marketing/);
  const stamps = first.querySelectorAll('time');
  assert.equal(stamps.length, 2, 'occurred + received');
  assert.ok(Array.from(stamps).some((t) => t.getAttribute('datetime') === '2026-10-04T02:14:00.000Z'));
  // a2/a3/a4 carry no occurredAt → stated, not invented.
  assert.match(rows[1].textContent ?? '', /Occurred: not recorded/);
});

/* ------------------------------------------------------------------ *
 * Hostile markup — escaped everywhere it can arrive (S5 safe content)
 * ------------------------------------------------------------------ */

const HOSTILE = '<img src=x onerror=alert(1)><script>window.pwned=1</script>';

test('B26/markup: hostile markup in every text field stays inert text, never DOM', () => {
  const hostileEvent = event({
    id: 'h1',
    kind: 'exchange',
    phase: 'requested',
    payload: { message: HOSTILE, summary: HOSTILE },
    actorLabel: HOSTILE,
    recipientLabel: HOSTILE,
    reference: HOSTILE,
  });
  const { container } = rtl.render(feed({ events: [hostileEvent] }));

  assert.equal(container.querySelectorAll('img').length, 0, 'no img element created');
  assert.equal(container.querySelectorAll('script').length, 0, 'no script element created');
  assert.equal(container.querySelectorAll('a').length, 0, 'no auto-executed link created');
  assert.equal((globalThis as unknown as { pwned?: number }).pwned, undefined);

  // The bytes survive as visible text — escaped, not stripped without trace.
  assert.ok((container.textContent ?? '').includes(HOSTILE), 'hostile text is displayed, escaped');
  assert.ok(
    Array.from(container.querySelectorAll('*')).some((el) => (el.textContent ?? '') === HOSTILE),
    'hostile text lands in a text node',
  );
});

test('B26/markup: hostile markup in note, task, decision and tombstone fields stays inert', () => {
  const hostileNote = event({ id: 'h2', kind: 'owner_note', phase: 'recorded', payload: { text: HOSTILE } });
  const hostileTask = event({ id: 'h3', kind: 'task', phase: 'created', payload: { status: HOSTILE, previousStatus: null } });
  const hostileDecision = event({
    id: 'h4',
    kind: 'decision',
    phase: 'unavailable',
    payload: { ...decisionPayload, intent: HOSTILE, routeAction: null, mode: HOSTILE },
  });
  const { container } = rtl.render(feed({ events: [hostileNote, hostileTask, hostileDecision], tombstones: new Set(['h4']) }));
  assert.equal(container.querySelectorAll('img, script').length, 0);
  assert.equal(container.querySelectorAll('a').length, 0);
});

/* ------------------------------------------------------------------ *
 * Tombstones and unavailable decision detail (S6, S5)
 * ------------------------------------------------------------------ */

test('B26/tombstone: a tombstoned row retains no source text and says the source is gone', () => {
  const doomed = event({
    id: 't1',
    kind: 'exchange',
    phase: 'replied',
    payload: { message: 'secret customer detail', summary: 'private summary text' },
    actorLabel: 'Someone Removed',
    recipientLabel: 'Somewhere',
    reference: 'exchange:gone:replied',
  });
  const { container } = rtl.render(feed({ events: [...ALL_SOURCES, doomed], tombstones: new Set(['t1']) }));

  const rows = Array.from(container.querySelectorAll('[data-testid="hq-activity-row"]'));
  assert.equal(rows.length, 5, 'tombstone is a notice, not a dropped record');
  const tombRow = rows[4];
  assert.equal(tombRow.getAttribute('data-tombstone'), 'true');
  const text = tombRow.textContent ?? '';
  assert.match(text, /Source record no longer exists/);
  for (const leaked of ['secret customer detail', 'private summary text', 'Someone Removed', 'Somewhere', 'exchange:gone:replied']) {
    assert.ok(!text.includes(leaked), `tombstone withheld ${leaked}`);
  }
  // The untombstoned rows keep their own content.
  assert.ok((rows[3].textContent ?? '').includes('Handoff requested'));
});

test('B26/decision-detail: missing decision facts read as not recorded — never a zero confidence, never a false application', () => {
  const unavailable = event({
    id: 'd1',
    kind: 'decision',
    phase: 'unavailable',
    payload: { intent: null, routeAction: null, departmentSlug: null, confidenceBps: null, fallback: null, mode: 'legacy', resolvedBy: null },
  });
  const shadow = event({
    id: 'd2',
    kind: 'decision',
    phase: 'shadow',
    payload: { ...decisionPayload, confidenceBps: 0, mode: 'shadow' },
  });
  const { container } = rtl.render(feed({ events: [unavailable, shadow] }));
  const rows = Array.from(container.querySelectorAll('[data-testid="hq-activity-row"]'));

  const unavailableText = rows[0].textContent ?? '';
  assert.match(unavailableText, /Unavailable/);
  assert.match(unavailableText, /Selected intent not recorded/);
  assert.match(unavailableText, /Route not recorded/);
  assert.match(unavailableText, /Confidence not recorded/);
  assert.match(unavailableText, /legacy/, 'the recorded mode is shown verbatim');
  assert.ok(!unavailableText.includes('0%'), 'a missing confidence is null, never zero');

  const shadowText = rows[1].textContent ?? '';
  assert.match(shadowText, /Shadow — not applied/, 'shadow is explicitly non-applied');
  assert.match(shadowText, /Fallback: false/);
});

/* ------------------------------------------------------------------ *
 * Missed-capture / coverage state (S5 capture health, S8)
 * ------------------------------------------------------------------ */

test('B26/coverage: degraded capture is stated with its dropped count; ok is silent; unknown claims nothing', () => {
  const degraded = rtl.render(
    feed({ events: ALL_SOURCES, captureHealth: { state: 'degraded', droppedCount: 7, since: '2026-10-04T01:00:00.000Z' } }),
  );
  const banner = degraded.container.querySelector('[data-testid="hq-feed-coverage"]');
  assert.ok(banner, 'degraded capture is visible');
  assert.equal(banner?.getAttribute('data-coverage-state'), 'degraded');
  assert.match(banner?.textContent ?? '', /7 dropped/);
  assert.match(banner?.textContent ?? '', /2026-10-04T01:00:00.000Z/);
  rtl.cleanup();

  const healthy = rtl.render(feed({ events: ALL_SOURCES, captureHealth: { state: 'ok' } }));
  assert.equal(healthy.container.querySelector('[data-testid="hq-feed-coverage"]'), null, 'healthy capture adds no noise');
  rtl.cleanup();

  const unknown = rtl.render(feed({ events: ALL_SOURCES, captureHealth: { whatever: true } }));
  const unknownBanner = unknown.container.querySelector('[data-testid="hq-feed-coverage"]');
  assert.equal(unknownBanner?.getAttribute('data-coverage-state'), 'unknown');
  assert.match(unknownBanner?.textContent ?? '', /not in a recognized form/);
  assert.match(unknownBanner?.textContent ?? '', /not claimed/);
  rtl.cleanup();

  const absent = rtl.render(feed({ events: ALL_SOURCES }));
  assert.equal(absent.container.querySelector('[data-testid="hq-feed-coverage"]'), null, 'no claim when no health supplied');
});

test('B26/coverage-unit: hqCaptureCoverage reads tolerance facts and never invents a count', () => {
  assert.equal(hqCaptureCoverage(undefined), null);
  assert.equal(hqCaptureCoverage(null), null);
  assert.deepEqual(hqCaptureCoverage('degraded'), { state: 'degraded', droppedCount: null, since: null });
  assert.deepEqual(hqCaptureCoverage({ captureState: 'DEGRADED', dropped: 3 }), { state: 'degraded', droppedCount: 3, since: null });
  assert.deepEqual(hqCaptureCoverage({ state: 'offline' }), { state: 'unavailable', droppedCount: null, since: null });
  // Non-integer, negative and non-numeric counts are absent, never coerced.
  assert.equal(hqCaptureCoverage({ state: 'degraded', droppedCount: 2.5 }).droppedCount, null);
  assert.equal(hqCaptureCoverage({ state: 'degraded', droppedCount: -1 }).droppedCount, null);
  assert.equal(hqCaptureCoverage({ state: 'degraded', droppedCount: '4' }).droppedCount, null);
  assert.equal(hqCaptureCoverage({ state: 'healthy' }).state, 'ok');
  assert.equal(hqCaptureCoverage({ state: 'banana' }).state, 'unknown');
});

/* ------------------------------------------------------------------ *
 * History and pagination — nothing silently dropped (S8)
 * ------------------------------------------------------------------ */

test('B26/pagination: older-history control calls back once, and the loading/error states are distinct', () => {
  let calls = 0;
  const first = rtl.render(feed({ events: ALL_SOURCES, older: { hasMore: true, onLoad: () => { calls += 1; } } }));
  const button = first.container.querySelector('[data-testid="hq-feed-older"]') as HTMLButtonElement | null;
  assert.ok(button, 'older control rendered when more history exists');
  assert.equal(button?.textContent, 'Load older activity');
  rtl.fireEvent.click(button as HTMLButtonElement);
  assert.equal(calls, 1);
  rtl.cleanup();

  const loading = rtl.render(feed({ events: ALL_SOURCES, older: { hasMore: true, loading: true, onLoad: () => { calls += 1; } } }));
  const loadingButton = loading.container.querySelector('[data-testid="hq-feed-older"]') as HTMLButtonElement;
  assert.equal(loadingButton.disabled, true);
  rtl.fireEvent.click(loadingButton);
  assert.equal(calls, 1, 'a loading control cannot double-fire');
  rtl.cleanup();

  const failed = rtl.render(feed({ events: ALL_SOURCES, older: { hasMore: true, error: 'page 3 failed', onLoad: () => { calls += 1; } } }));
  assert.match(failed.container.querySelector('[data-testid="hq-feed-older-error"]')?.textContent ?? '', /page 3 failed/);
  rtl.cleanup();

  const exhausted = rtl.render(feed({ events: ALL_SOURCES, older: { hasMore: false } }));
  assert.equal(exhausted.container.querySelector('[data-testid="hq-feed-older"]'), null);
  assert.match(exhausted.container.querySelector('[data-testid="hq-feed-history-start"]')?.textContent ?? '', /Start of retained history/);
});

test('B26/history: pruned history is announced and the feed offers no misleading delta', () => {
  const { container } = rtl.render(feed({ events: ALL_SOURCES, resetRequired: true, older: { hasMore: true, onLoad: () => {} }, recentOnly: true }));
  const notice = container.querySelector('[data-testid="hq-feed-history-reset"]');
  assert.ok(notice, 'pruned history is stated');
  assert.match(notice?.textContent ?? '', /Older activity unavailable/);
  assert.equal(container.querySelector('[data-testid="hq-feed-older"]'), null, 'no paging past pruned history');
  assert.match(container.textContent ?? '', /Recent activity/);
  assert.match(container.textContent ?? '', /not full history/);
});

test('B26/no-silent-drop: every event given is rendered, and the header counts match', () => {
  const many = Array.from({ length: 25 }, (_, i) =>
    event({ id: `n${i}`, seq: 100 + i, kind: 'task', phase: 'created', payload: { status: 'backlog', previousStatus: null }, reference: `activity:e${i}` }),
  );
  const { container } = rtl.render(feed({ events: many }));
  assert.equal(container.querySelectorAll('[data-testid="hq-activity-row"]').length, 25);
  assert.match(container.textContent ?? '', /25 events shown/);

  const single = rtl.render(feed({ events: [ALL_SOURCES[0]] }));
  assert.match(single.container.textContent ?? '', /1 event shown/);
});

/* ------------------------------------------------------------------ *
 * Privacy — the feed renders contract fields only, nothing else
 * ------------------------------------------------------------------ */

test('B26/privacy: private runtime fields riding on the event object never reach the DOM', () => {
  const leaked = {
    ...event({ id: 'p1', kind: 'exchange', phase: 'replied', payload: exchangePayload, actorLabel: 'Head', recipientLabel: 'Owner' }),
    // Fields the public projector must have stripped (S5/S6/S9) — the feed must
    // not render them even when a caller forwards an unprojected row.
    message: 'PRIVATE-TRANSCRIPT',
    reply: 'PRIVATE-REPLY-TEXT',
    ownerSubject: 'PRIVATE-OWNER-SUBJECT',
    gatewaySessionKey: 'agent:PRIVATE-RUNTIME: hq-turn',
    runtimeAgentId: 'PRIVATE-RUNTIME-ID',
    installationId: 'PRIVATE-INSTALLATION',
    secretToken: 'PRIVATE-TOKEN',
  };
  const { container } = rtl.render(feed({ events: [leaked] }));
  const html = container.innerHTML;
  for (const secret of [
    'PRIVATE-TRANSCRIPT',
    'PRIVATE-REPLY-TEXT',
    'PRIVATE-OWNER-SUBJECT',
    'agent:PRIVATE-RUNTIME',
    'PRIVATE-RUNTIME-ID',
    'PRIVATE-INSTALLATION',
    'PRIVATE-TOKEN',
  ]) {
    assert.ok(!html.includes(secret), `private value withheld: ${secret}`);
  }
  // The public projection of the same row is still shown.
  assert.match(container.textContent ?? '', /Handoff requested/);
});

test('B26/privacy: an unbound exchange (taskId null) renders as coverage, never as a task link', () => {
  const unbound = event({ id: 'u1', kind: 'exchange', phase: 'uncertain', payload: { message: null, summary: 'Unbound exchange' }, taskId: null, reference: 'exchange:unbound:uncertain' });
  const { container } = rtl.render(feed({ events: [unbound] }));
  const text = container.textContent ?? '';
  assert.match(text, /Delivery uncertain/);
  assert.match(text, /Unbound exchange/);
  assert.equal(container.querySelectorAll('[data-task-id]').length, 0, 'no task element for a taskId:null exchange');
  assert.ok(!/task\s+[A-Za-z0-9-]/.test(text), `no task identifier rendered: ${text}`);
});

/* ------------------------------------------------------------------ *
 * No synthetic feed presented as real integration
 * ------------------------------------------------------------------ */

test('B26/no-synthetic-feed: with no events supplied the feed invents nothing and never fetches', async () => {
  const originalFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = (async () => {
    fetches += 1;
    throw new Error('the feed must not fetch');
  }) as typeof globalThis.fetch;
  try {
    const empty = rtl.render(feed({ events: [] }));
    assert.equal(empty.container.querySelectorAll('[data-testid="hq-activity-row"]').length, 0);
    assert.match(empty.container.querySelector('[data-testid="hq-feed-empty"]')?.textContent ?? '', /No activity yet/);
    assert.match(empty.container.textContent ?? '', /No events/);
    rtl.cleanup();

    const pending = rtl.render(feed({ events: [], pending: true }));
    assert.match(pending.container.querySelector('[data-testid="hq-feed-pending"]')?.textContent ?? '', /Loading activity/);
    assert.equal(pending.container.querySelector('[data-testid="hq-feed-empty"]'), null, 'loading is not an empty company');
    rtl.cleanup();

    const failed = rtl.render(feed({ events: [], error: 'Activity failed to load. Retrying.' }));
    assert.match(failed.container.querySelector('[data-testid="hq-feed-error"]')?.textContent ?? '', /Activity failed to load/);
    assert.equal(failed.container.querySelector('[data-testid="hq-feed-empty"]'), null, 'a failed load is not an empty company');
    rtl.cleanup();

    assert.equal(fetches, 0, 'the feed never fetches — it renders exactly what it was handed');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('B26/no-synthetic-feed: rows are data-tagged by their own event, and an unrecognized kind/phase is shown as unrecognized', () => {
  const odd = event({ id: 'o1', kind: 'task', phase: 'status_changed', payload: taskPayload, reference: 'transition:aud-odd' });
  const { container } = rtl.render(feed({ events: [odd] }));
  const row = container.querySelector('[data-testid="hq-activity-row"]');
  assert.equal(row?.getAttribute('data-kind'), 'task');
  assert.equal(row?.getAttribute('data-phase'), 'status_changed');
  assert.ok((container.textContent ?? '').includes('transition:aud-odd'), 'the source reference is the real one supplied');
});
