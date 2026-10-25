/**
 * PBB-127 / T-30 — truthful funnel attribution and outcome evidence.
 *
 * Pins C-30 / R-20 / R-31 exactly as the acceptance states it:
 *   "Observed keyword/unknown/multitouch separated; counts gift/contact/
 *    booking/sale independently."
 *
 * Every clause is proven in BOTH directions where the clause has one: an
 * evidenced observation is counted, and the same shape without evidence is
 * refused as UNKNOWN. Nothing here touches a database, a client workspace or
 * the network — the loader is exercised through an injected reader and the
 * view through `react-dom/server`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  ATTRIBUTION_CLASSES,
  OUTCOME_KINDS,
  REASON_TEXT,
  buildFunnelAttribution,
  buildFunnelAttributionRows,
  classifyAttribution,
  loadFunnelAttribution,
  normalizeOutcomeKind,
  observedRefs,
  type FunnelAttributionEvent,
  type FunnelAttributionSnapshot,
} from '../../src/lib/funnel/attribution';
import { FunnelAttributionView } from '../../src/components/funnel/FunnelAttributionView';

const NOW = '2026-10-24T12:00:00.000Z';

const OBSERVED = 'ghl-adapter';
const AT = '2026-10-23T09:15:00.000Z';

/** An event with real adapter evidence unless the caller removes it. */
function ev(over: Partial<FunnelAttributionEvent> = {}): FunnelAttributionEvent {
  return {
    kind: 'contact',
    refs: ['SUMMER'],
    attribution_source: OBSERVED,
    observed_at: AT,
    ...over,
  };
}

function build(records: unknown[], available = true): FunnelAttributionSnapshot {
  return buildFunnelAttribution(records, { available, source: 'fixture', now: NOW });
}

function count(snapshot: FunnelAttributionSnapshot, kind: (typeof OUTCOME_KINDS)[number]): number | null {
  return snapshot.outcomes.find((o) => o.kind === kind)!.count;
}

function outcome(snapshot: FunnelAttributionSnapshot, kind: (typeof OUTCOME_KINDS)[number]) {
  return snapshot.outcomes.find((o) => o.kind === kind)!;
}

// ─── Clause 1: observed keyword / multitouch / unknown are SEPARATED ───────

test('observed keyword: one distinct, evidenced reference counts as observed_keyword only', () => {
  const s = build([ev()]);
  assert.equal(s.attribution.observed_keyword, 1);
  assert.equal(s.attribution.multitouch, 0);
  assert.equal(s.attribution.unknown, 0);
  assert.deepEqual(s.attribution.unknownReasons, []);
});

test('multitouch: two distinct references are multitouch and are NOT collapsed into observed_keyword', () => {
  const s = build([ev({ refs: ['SUMMER', 'REEL-OCT'] })]);
  assert.equal(s.attribution.observed_keyword, 0);
  assert.equal(s.attribution.multitouch, 1);
  assert.equal(s.attribution.unknown, 0);
});

test('multitouch: duplicates (case-insensitive) are ONE touch, so the event stays observed_keyword', () => {
  assert.deepEqual(observedRefs({ refs: ['summer', 'SUMMER', ' Summer '] }), ['summer']);
  const s = build([ev({ refs: ['summer', 'SUMMER'] })]);
  assert.equal(s.attribution.observed_keyword, 1);
  assert.equal(s.attribution.multitouch, 0);
});

test('unknown: a reference with no provenance source is refused, never promoted to observed_keyword', () => {
  const s = build([ev({ attribution_source: undefined })]);
  assert.equal(s.attribution.observed_keyword, 0);
  assert.equal(s.attribution.multitouch, 0);
  assert.equal(s.attribution.unknown, 1);
  assert.deepEqual(s.attribution.unknownReasons, [
    { reason: 'observation_not_provenanced', count: 1 },
  ]);
});

test('unknown: a reference with an unparseable observed_at is refused', () => {
  const s = build([ev({ observed_at: 'yesterday-ish' })]);
  const verdict = classifyAttribution(ev({ observed_at: 'yesterday-ish' }));
  assert.equal(verdict.class, 'unknown');
  assert.equal(verdict.reason, 'observation_not_provenanced');
  assert.equal(s.attribution.unknown, 1);
  assert.equal(s.attribution.observed_keyword, 0);
});

test('unknown: a keyword printed in the message body is NOT attribution (D-05)', () => {
  const record = {
    kind: 'contact',
    message: 'I saw your SUMMER post and clicked',
    body: 'ref SUMMER',
    text: 'SUMMER',
    attribution_source: OBSERVED,
    observed_at: AT,
  };
  const verdict = classifyAttribution(record);
  assert.equal(verdict.class, 'unknown');
  assert.equal(verdict.reason, 'no_attribution_data');
  const s = build([record]);
  assert.equal(s.attribution.observed_keyword, 0);
  assert.equal(s.attribution.multitouch, 0);
  assert.equal(s.attribution.unknown, 1);
});

test('unknown: blank / non-string reference values carry no touch', () => {
  assert.deepEqual(observedRefs({ refs: ['   ', '', 42, null, undefined] }), []);
  const s = build([{ kind: 'contact', refs: ['  '], attribution_source: OBSERVED, observed_at: AT }]);
  assert.equal(s.attribution.observed_keyword, 0);
  assert.equal(s.attribution.unknown, 1);
  assert.deepEqual(s.attribution.unknownReasons, [{ reason: 'no_attribution_data', count: 1 }]);
});

test('attribution classes partition every event: keyword + multitouch + unknown = record count', () => {
  const records = [
    ev({ refs: ['A'] }),
    ev({ refs: ['A', 'B'] }),
    ev({ refs: [] }),
    ev({ refs: ['A'], attribution_source: undefined }),
    ev({ refs: [] }),
  ];
  const s = build(records);
  assert.equal(
    (s.attribution.observed_keyword ?? -1) +
      (s.attribution.multitouch ?? -1) +
      (s.attribution.unknown ?? -1),
    records.length,
  );
});

// ─── Clause 2: gift / contact / booking / sale counted INDEPENDENTLY ───────

test('outcomes: each kind keeps its own exact count', () => {
  const s = build([
    ev({ kind: 'gift' }),
    ev({ kind: 'gift_claimed' }),
    ev({ kind: 'contact' }),
    ev({ kind: 'contact', refs: ['A', 'B'] }),
    ev({ kind: 'contact', refs: [] }),
    ev({ kind: 'booking' }),
    ev({ kind: 'booking_confirmed' }),
    ev({ kind: 'sale' }),
  ]);
  assert.equal(count(s, 'gift'), 2);
  assert.equal(count(s, 'contact'), 3);
  assert.equal(count(s, 'booking'), 2);
  assert.equal(count(s, 'sale'), 1);
  assert.deepEqual(
    s.outcomes.map((o) => o.kind),
    [...OUTCOME_KINDS],
  );
});

test('outcomes: a sale does NOT increment gift/contact/booking (no implied progression)', () => {
  const s = build([ev({ kind: 'sale' })]);
  assert.equal(count(s, 'sale'), 1);
  assert.equal(count(s, 'gift'), 0);
  assert.equal(count(s, 'contact'), 0);
  assert.equal(count(s, 'booking'), 0);
});

test('outcomes: the snapshot exposes no total, rate, funnel or conversion arithmetic', () => {
  const s = build([ev({ kind: 'sale' }), ev({ kind: 'gift' })]);
  const keys = Object.keys(s);
  for (const forbidden of ['total', 'rate', 'funnel', 'conversion', 'stages', 'progression']) {
    assert.equal(keys.includes(forbidden), false, `snapshot must not expose "${forbidden}"`);
  }
  for (const bucket of s.outcomes) {
    assert.deepEqual(
      Object.keys(bucket).sort(),
      ['count', 'kind', 'reason', 'status', 'unknown', 'unknownReasons'],
    );
  }
});

test('outcomes: an unrecognised kind is unclassified, never folded into one of the four', () => {
  const s = build([ev({ kind: 'newsletter_signup' })]);
  assert.equal(s.unclassified.count, 1);
  assert.deepEqual(s.unclassified.reasons, [{ reason: 'outcome_kind_unrecognized', count: 1 }]);
  for (const kind of OUTCOME_KINDS) assert.equal(count(s, kind), 0);
  assert.equal(normalizeOutcomeKind('newsletter_signup'), null);
});

test('outcomes: a mapped kind without evidence is unknown for THAT kind, never a count', () => {
  const s = build([ev({ kind: 'booking', observed_at: undefined })]);
  const booking = outcome(s, 'booking');
  assert.equal(booking.count, 0);
  assert.equal(booking.unknown, 1);
  assert.deepEqual(booking.unknownReasons, [{ reason: 'outcome_not_evidenced', count: 1 }]);
  // The refusal stays inside the booking bucket; nothing leaks to the others.
  assert.equal(count(s, 'gift'), 0);
  assert.equal(count(s, 'contact'), 0);
  assert.equal(count(s, 'sale'), 0);
});

test('outcomes: a record with no outcome kind is a non-outcome event, not an unclassified refusal', () => {
  const s = build([{ refs: ['A'], attribution_source: OBSERVED, observed_at: AT }]);
  assert.equal(s.nonOutcome, 1);
  assert.equal(s.unclassified.count, 0);
  assert.equal(s.refused, 0);
  assert.equal(s.attribution.observed_keyword, 1);
});

test('outcomes: mixed refusals are reported with their own reasons and never counted', () => {
  const s = build([
    ev({ kind: 'gift' }),
    ev({ kind: 'gift', attribution_source: undefined }),
    ev({ kind: 'unknown_kind' }),
  ]);
  assert.equal(count(s, 'gift'), 1);
  assert.equal(outcome(s, 'gift').unknown, 1);
  assert.equal(s.unclassified.count, 1);
  assert.equal(s.refused, 0);
});

// ─── Unknown / refusal states ──────────────────────────────────────────────

test('UNKNOWN: an absent source reports status UNKNOWN with null counts, never zeros', () => {
  const s = build([], false);
  assert.equal(s.available, false);
  assert.equal(s.status, 'UNKNOWN');
  assert.equal(s.reason, 'source_absent');
  assert.equal(s.attribution.observed_keyword, null);
  assert.equal(s.attribution.multitouch, null);
  assert.equal(s.attribution.unknown, null);
  assert.equal(s.unclassified.count, null);
  assert.equal(s.nonOutcome, null);
  assert.equal(s.refused, null);
  for (const bucket of s.outcomes) {
    assert.equal(bucket.status, 'UNKNOWN');
    assert.equal(bucket.count, null);
    assert.equal(bucket.reason, 'source_absent');
    assert.equal(bucket.unknown, null);
  }
});

test('UNKNOWN: loader with an absent reader is UNKNOWN, not an empty success', () => {
  const s = loadFunnelAttribution({
    read: () => ({ available: false, source: null, records: [] }),
    now: NOW,
  });
  assert.equal(s.status, 'UNKNOWN');
  assert.equal(s.reason, 'source_absent');
  for (const bucket of s.outcomes) assert.equal(bucket.count, null);
});

test('OBSERVED: a present but EMPTY source is a legitimate zero, distinct from UNKNOWN', () => {
  const s = loadFunnelAttribution({
    read: () => ({ available: true, source: '/fixture/pixel-events', records: [] }),
    now: NOW,
  });
  assert.equal(s.status, 'OBSERVED');
  assert.equal(s.reason, null);
  assert.equal(s.attribution.observed_keyword, 0);
  assert.equal(s.attribution.multitouch, 0);
  assert.equal(s.attribution.unknown, 0);
  for (const bucket of s.outcomes) {
    assert.equal(bucket.status, 'OBSERVED');
    assert.equal(bucket.count, 0);
  }
});

test('refusal: malformed records are counted and never throw', () => {
  const s = build([null, 'a string', 42, [], ev()]);
  assert.equal(s.refused, 4);
  assert.equal(s.attribution.observed_keyword, 1);
  assert.equal(count(s, 'contact'), 1);
});

test('refusal: reader-skipped (unparseable) source lines are folded into refused', () => {
  const s = loadFunnelAttribution({
    read: () => ({ available: true, source: '/fixture/pixel-events', records: [ev()], skipped: 3 }),
    now: NOW,
  });
  assert.equal(s.refused, 3);
  assert.equal(count(s, 'contact'), 1);
});

// ─── View: UNKNOWN cannot render as success or as zero ─────────────────────

test('view rows: an UNKNOWN snapshot yields null counts plus the reason, never 0', () => {
  const rows = buildFunnelAttributionRows(build([], false));
  assert.match(String(rows.banner), /UNKNOWN/);
  assert.match(String(rows.banner), /source unavailable/);
  assert.deepEqual(
    rows.attribution.map((r) => r.id),
    [...ATTRIBUTION_CLASSES],
  );
  assert.deepEqual(
    rows.outcomes.map((r) => r.id),
    [...OUTCOME_KINDS],
  );
  for (const row of [...rows.attribution, ...rows.outcomes]) {
    assert.equal(row.status, 'UNKNOWN');
    assert.equal(row.count, null);
    assert.equal(row.detail, REASON_TEXT.source_absent);
  }
});

test('view: an UNKNOWN snapshot renders the word UNKNOWN and no zero count', () => {
  const html = renderToStaticMarkup(
    createElement(FunnelAttributionView, { snapshot: build([], false) }),
  );
  assert.match(html, /Funnel attribution UNKNOWN/);
  assert.match(html, /source unavailable/);
  assert.equal(html.includes('>0<'), false, 'an unobserved count must never render as 0');
  assert.equal(html.includes('Observed keyword'), true);
  assert.equal(html.includes('Multitouch'), true);
  assert.equal(html.includes('Gifts'), true);
  assert.equal(html.includes('Contacts'), true);
  assert.equal(html.includes('Bookings'), true);
  assert.equal(html.includes('Sales'), true);
});

test('view: an OBSERVED snapshot renders the separated classes and four independent counts', () => {
  const snapshot = build([
    ev({ kind: 'gift', refs: ['A'] }),
    ev({ kind: 'contact', refs: ['A', 'B'] }),
    ev({ kind: 'contact', refs: [] }),
    ev({ kind: 'booking', refs: ['A'] }),
    ev({ kind: 'sale', refs: ['A'] }),
  ]);
  const rows = buildFunnelAttributionRows(snapshot);
  assert.equal(rows.banner, null);
  assert.deepEqual(
    rows.attribution.map((r) => [r.id, r.count]),
    [
      ['observed_keyword', 3],
      ['multitouch', 1],
      ['unknown', 1],
    ],
  );
  assert.deepEqual(
    rows.outcomes.map((r) => [r.id, r.count]),
    [
      ['gift', 1],
      ['contact', 2],
      ['booking', 1],
      ['sale', 1],
    ],
  );
  const html = renderToStaticMarkup(createElement(FunnelAttributionView, { snapshot }));
  assert.match(html, /Observed keyword/);
  assert.match(html, /Multitouch/);
  assert.match(html, /Unknown attribution/);
  assert.match(html, /no attribution reference was observed/);
  assert.match(html, /counted independently/);
});

test('view: refused / unclassified records are surfaced in the footnote, not hidden', () => {
  const rows = buildFunnelAttributionRows(
    build([ev({ kind: 'gift' }), ev({ kind: 'mystery_event' }), null]),
  );
  assert.match(String(rows.footnote), /1 event\(s\) not counted in gift\/contact\/booking\/sale/);
  assert.match(String(rows.footnote), /1 record\(s\) refused as malformed/);
});
