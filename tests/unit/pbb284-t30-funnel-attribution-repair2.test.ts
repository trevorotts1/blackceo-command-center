/**
 * PBB-284 / T-30 repair 2 — the five defects the independent QC-5 verdict
 * (`qc5-t-30`) named against commit b8073dc71f, each pinned by assertions that
 * FAIL on that commit and PASS after this repair:
 *
 *   N1 observedRefs() walked `refs` / `touch_refs` only as arrays and
 *      `keyword_ref` only as a scalar, so every other shape's observed touch
 *      was silently dropped (`refs:'SUMMER'` -> no touch at all).
 *   N2 isTimestamp() accepted any Date.parse result, so observed_at "0" and
 *      "2026" were treated as proven observations.
 *   N3 mapPixelEventRecord kept a present-but-unusable observed_at and threw
 *      away a timestamp the source proved.
 *   N4 a present-but-blank (or non-string) kind was booked as nonOutcome
 *      instead of unclassified ("kind is present but outside the vocabulary").
 *   N5 nonOutcome was computed and then never surfaced in the row model.
 *
 * The 24 original cases and the 10 c-t-30 repair cases are left untouched:
 * nothing proven there is weakened here. Each defect is proven in both
 * directions where a direction exists — including the inverse that keeps a
 * genuinely absent value out of the promoted bucket.
 *
 * No database, no client workspace, no network.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  buildFunnelAttribution,
  buildFunnelAttributionRows,
  classifyAttribution,
  loadFunnelAttribution,
  mapPixelEventRecord,
  normalizeOutcomeKind,
  observedRefs,
  type FunnelAttributionEvent,
  type FunnelAttributionSnapshot,
} from '../../src/lib/funnel/attribution';
import { FunnelAttributionView } from '../../src/components/funnel/FunnelAttributionView';

const NOW = '2026-10-24T12:00:00.000Z';
const OBSERVED = 'ghl-adapter';
const AT = '2026-10-23T09:15:00.000Z';

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

function bucket(s: FunnelAttributionSnapshot, kind: 'gift' | 'contact' | 'booking' | 'sale') {
  return s.outcomes.find((o) => o.kind === kind)!;
}

// ─── N1: a touch is observed whatever shape carries it ─────────────────────

test('N1: a scalar refs carries its touch — never dropped into no_attribution_data', () => {
  assert.deepEqual(observedRefs({ refs: 'SUMMER' } as never), ['SUMMER']);
  const verdict = classifyAttribution({
    refs: 'SUMMER',
    attribution_source: OBSERVED,
    observed_at: AT,
  } as never);
  assert.equal(verdict.class, 'observed_keyword');
  assert.deepEqual(verdict.refs, ['SUMMER']);
  const s = build([ev({ refs: 'SUMMER' } as never)]);
  assert.equal(s.attribution.observed_keyword, 1);
  assert.equal(s.attribution.unknown, 0);
});

test('N1: a scalar touch_refs joins the union instead of vanishing', () => {
  assert.deepEqual(observedRefs({ refs: ['A'], touch_refs: 'B' } as never), ['A', 'B']);
  const s = build([ev({ refs: ['A'], touch_refs: 'B' } as never)]);
  assert.equal(s.attribution.multitouch, 1);
  assert.equal(s.attribution.observed_keyword, 0);
  assert.equal(s.attribution.unknown, 0);
});

test('N1: an array keyword_ref carries both touches — never an empty union', () => {
  assert.deepEqual(observedRefs({ keyword_ref: ['A', 'B'] } as never), ['A', 'B']);
  const s = build([ev({ refs: [], touch_refs: [], keyword_ref: ['A', 'B'] } as never)]);
  assert.equal(s.attribution.multitouch, 1);
  assert.equal(s.attribution.observed_keyword, 0);
});

test('N1 class: every reference field accepts both shapes and is unioned, not exclusive', () => {
  for (const field of ['refs', 'touch_refs', 'keyword_ref'] as const) {
    const scalar = { [field]: 'A', attribution_source: OBSERVED, observed_at: AT } as never;
    assert.deepEqual(observedRefs(scalar), ['A'], `${field} scalar must carry its touch`);
    assert.equal(classifyAttribution(scalar).class, 'observed_keyword', `${field} scalar`);

    const list = { [field]: ['A', 'B'], attribution_source: OBSERVED, observed_at: AT } as never;
    assert.deepEqual(observedRefs(list), ['A', 'B'], `${field} list must carry both touches`);
    assert.equal(classifyAttribution(list).class, 'multitouch', `${field} list`);
  }
  // all three together stay one deduped union
  assert.deepEqual(
    observedRefs({ refs: 'A', touch_refs: 'a', keyword_ref: ['B', 'A'] } as never),
    ['A', 'B'],
  );
});

test('N1 inverse: a non-conforming value still carries no touch (never invented)', () => {
  for (const junk of [{ a: 1 }, 42, true, [''], ['   ', null]]) {
    const record = { refs: junk, touch_refs: junk, keyword_ref: junk } as never;
    assert.deepEqual(observedRefs(record), [], `junk ${JSON.stringify(junk)} must carry no touch`);
  }
  const s = build([ev({ refs: { a: 1 }, touch_refs: 7, keyword_ref: ['  '] } as never)]);
  assert.equal(s.attribution.unknown, 1);
  assert.deepEqual(s.attribution.unknownReasons, [{ reason: 'no_attribution_data', count: 1 }]);
});

// ─── N2: a claim is not an observation — the timestamp leg is enforced ─────

test('N2: observed_at "0" is refused to unknown, never a proven observation', () => {
  const verdict = classifyAttribution(ev({ observed_at: '0' }));
  assert.equal(verdict.class, 'unknown');
  assert.equal(verdict.reason, 'observation_not_provenanced');
  const s = build([ev({ observed_at: '0' })]);
  assert.equal(s.attribution.observed_keyword, 0);
  assert.equal(s.attribution.unknown, 1);
});

test('N2: observed_at "2026" (bare year) is refused to unknown', () => {
  assert.equal(classifyAttribution(ev({ observed_at: '2026' })).class, 'unknown');
  assert.equal(build([ev({ observed_at: '2026' })]).attribution.observed_keyword, 0);
});

test('N2 class: no partial date or non-ISO string counts as an instant', () => {
  for (const junk of ['2026-05-30', '2026-05', '2026', '0', '5', '05/30/2026', 'May 30 2026', 'yesterday-ish', '   2026   ']) {
    assert.equal(
      classifyAttribution(ev({ observed_at: junk })).class,
      'unknown',
      `observed_at ${JSON.stringify(junk)} must not be a proven instant`,
    );
  }
});

test('N2 inverse: real instants — with or without milliseconds or offset — still prove the observation', () => {
  for (const at of [
    '2026-10-23T09:15:00.000Z',
    '2026-05-30T15:04:22Z',
    '2026-10-23T09:15:00Z',
    '2026-10-23T09:15:00',
    '2026-10-23T09:15:00.123+02:00',
    '2026-10-23T09:15:00-0400',
  ]) {
    assert.equal(classifyAttribution(ev({ observed_at: at })).class, 'observed_keyword', at);
    assert.equal(build([ev({ observed_at: at })]).attribution.observed_keyword, 1, at);
  }
  // a calendar-impossible stamp is still refused
  assert.equal(classifyAttribution(ev({ observed_at: '2026-13-45T99:99:99Z' })).class, 'unknown');
});

test('N2 class: the OUTCOME evidence leg uses the same standard, not a looser one', () => {
  for (const junk of ['0', '2026', '2026-05-30', 'yesterday-ish']) {
    const s = build([ev({ kind: 'booking', observed_at: junk })]);
    assert.equal(bucket(s, 'booking').count, 0, `observed_at ${junk} must not evidence an outcome`);
    assert.equal(bucket(s, 'booking').unknown, 1);
    assert.deepEqual(bucket(s, 'booking').unknownReasons, [
      { reason: 'outcome_not_evidenced', count: 1 },
    ]);
  }
  const good = build([ev({ kind: 'booking', observed_at: AT })]);
  assert.equal(bucket(good, 'booking').count, 1);
});

// ─── N3: a proven timestamp is never discarded for an unusable one ─────────

test('N3: mapPixelEventRecord falls back to a proven timestamp when observed_at is unusable', () => {
  const mapped = mapPixelEventRecord({
    observed_at: 'yesterday-ish',
    timestamp: '2026-05-30T15:04:22Z',
    agent_id: 'px',
  });
  assert.equal(mapped.observed_at, '2026-05-30T15:04:22Z');
  assert.equal(classifyAttribution(mapped).class, 'unknown'); // still no reference
  const withRef = mapPixelEventRecord({
    observed_at: 'yesterday-ish',
    timestamp: '2026-05-30T15:04:22Z',
    agent_id: 'px',
    refs: ['SUMMER'],
  });
  assert.equal(classifyAttribution(withRef).class, 'observed_keyword');
});

test('N3 class: junk observed_at of every shape falls back to the proven source timestamp', () => {
  for (const junk of ['0', '2026', 'yesterday-ish', '', '   ', 42, null, undefined, ['2026-05-30T15:04:22Z']]) {
    const mapped = mapPixelEventRecord({
      observed_at: junk,
      timestamp: '2026-05-30T15:04:22Z',
      agent_id: 'px',
      refs: ['SUMMER'],
    });
    assert.equal(
      mapped.observed_at,
      '2026-05-30T15:04:22Z',
      `observed_at ${JSON.stringify(junk)} must not win over the proven timestamp`,
    );
    assert.equal(classifyAttribution(mapped).class, 'observed_keyword', String(junk));
  }
});

test('N3 inverse: a proven observed_at is kept, and an unproven timestamp is never promoted', () => {
  const kept = mapPixelEventRecord({ observed_at: AT, timestamp: '2026-05-30T15:04:22Z' });
  assert.equal(kept.observed_at, AT);

  const noProof = mapPixelEventRecord({
    observed_at: 'yesterday-ish',
    timestamp: 'not-a-timestamp',
    agent_id: 'px',
    refs: ['SUMMER'],
  });
  assert.equal(noProof.observed_at, 'yesterday-ish');
  assert.equal(classifyAttribution(noProof).class, 'unknown');
  assert.equal(classifyAttribution(noProof).reason, 'observation_not_provenanced');

  const neverSeen = mapPixelEventRecord({ refs: ['SUMMER'], agent_id: 'px' });
  assert.equal(neverSeen.observed_at, undefined);
  assert.equal(classifyAttribution(neverSeen).class, 'unknown');
});

// ─── N4: a present-but-unusable kind is unclassified, not a non-outcome ────

test('N4: a blank-but-present kind is unclassified ("present but outside the vocabulary")', () => {
  for (const kind of ['   ', '', '\t\n']) {
    const s = build([ev({ kind })]);
    assert.equal(s.unclassified.count, 1, `kind ${JSON.stringify(kind)} must be unclassified`);
    assert.deepEqual(s.unclassified.reasons, [{ reason: 'outcome_kind_unrecognized', count: 1 }]);
    assert.equal(s.nonOutcome, 0);
  }
});

test('N4 class: any present-but-unusable kind is unclassified — strings, numbers, objects', () => {
  for (const kind of ['   ', '', 42, 0, true, {}, ['sale'], { kind: 'sale' }]) {
    const s = build([ev({ kind })]);
    assert.equal(s.unclassified.count, 1, `kind ${JSON.stringify(kind)} must be unclassified`);
    assert.equal(s.nonOutcome, 0, `kind ${JSON.stringify(kind)} must not be a non-outcome`);
    assert.equal(normalizeOutcomeKind(kind), null);
    for (const k of ['gift', 'contact', 'booking', 'sale'] as const) {
      assert.equal(bucket(s, k).count, 0);
      assert.equal(bucket(s, k).unknown, 0);
    }
  }
});

test('N4 inverse: an ABSENT kind is still a non-outcome, never unclassified', () => {
  for (const kind of [undefined, null]) {
    const s = build([ev({ kind })]);
    assert.equal(s.nonOutcome, 1, `kind ${JSON.stringify(kind)} must be non-outcome`);
    assert.equal(s.unclassified.count, 0);
  }
  const noKindField = build([{ refs: ['A'], attribution_source: OBSERVED, observed_at: AT }]);
  assert.equal(noKindField.nonOutcome, 1);
  assert.equal(noKindField.unclassified.count, 0);
  // a mapped kind still counts exactly once
  const sale = build([ev({ kind: 'sale' })]);
  assert.equal(bucket(sale, 'sale').count, 1);
  assert.equal(sale.nonOutcome, 0);
  assert.equal(sale.unclassified.count, 0);
});

// ─── N5: nothing computed is left invisible ────────────────────────────────

test('N5: a non-outcome record is surfaced in the footnote instead of vanishing', () => {
  const rows = buildFunnelAttributionRows(build([ev({ kind: undefined })]));
  assert.equal(rows.nonOutcome.count, 1);
  assert.match(String(rows.footnote), /1 record\(s\) carried no outcome kind/);
});

test('N5: the row model exposes nonOutcome and the view renders it', () => {
  const snapshot = loadFunnelAttribution({
    read: () => ({
      available: true,
      source: '/fixture/pixel-events',
      records: [{ timestamp: AT, event_type: 'scroll', agent_id: 'pixel-concierge' }],
    }),
    now: NOW,
  });
  assert.equal(snapshot.nonOutcome, 1);
  const rows = buildFunnelAttributionRows(snapshot);
  assert.equal(rows.nonOutcome.count, 1);
  assert.equal(rows.nonOutcome.status, 'OBSERVED');
  const html = renderToStaticMarkup(createElement(FunnelAttributionView, { snapshot }));
  assert.match(html, /no outcome kind/);
});

test('N5: every counter the snapshot computes is surfaced in the row model', () => {
  const snapshot = build([
    ev({ kind: 'gift' }),
    ev({ kind: 'mystery_event' }),
    ev({ kind: undefined }),
    null,
    ev({ kind: 'gift', attribution_source: undefined }),
  ]);
  assert.equal(snapshot.unclassified.count, 1);
  assert.equal(snapshot.nonOutcome, 1);
  assert.equal(snapshot.refused, 1);
  assert.equal(bucket(snapshot, 'gift').unknown, 1);
  const rows = buildFunnelAttributionRows(snapshot);
  const rendered = [
    rows.footnote ?? '',
    rows.nonOutcome.detail ?? '',
    ...rows.outcomes.map((r) => r.detail ?? ''),
  ].join(' ');
  assert.match(rendered, /not counted in gift\/contact\/booking\/sale/);
  assert.match(rendered, /no outcome kind/);
  assert.match(rendered, /refused as malformed/);
  assert.match(rendered, /no provenance source or observed timestamp/);
});

test('N5 inverse: zero non-outcomes adds no noise — the footnote stays clean', () => {
  const rows = buildFunnelAttributionRows(build([ev({ kind: 'gift' })]));
  assert.equal(rows.nonOutcome.count, 0);
  assert.equal(rows.footnote, null);
  const unknownRows = buildFunnelAttributionRows(build([], false));
  assert.equal(unknownRows.nonOutcome.count, null);
  assert.equal(unknownRows.nonOutcome.status, 'UNKNOWN');
  const html = renderToStaticMarkup(createElement(FunnelAttributionView, { snapshot: build([], false) }));
  assert.equal(html.includes('>0<'), false, 'an unobserved count must never render as 0');
});
