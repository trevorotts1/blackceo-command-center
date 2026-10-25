/**
 * PBB-355 / T-30 repair 3 — the three defects the independent PBB-324 verdict
 * (`T30-PBB-324-FAIL.md`) proved against fd347d38d45f, each pinned here by an
 * assertion that FAILS on that commit and PASSES after this repair:
 *
 *   D1 a calendar-impossible stamp (`2026-02-30`, non-leap `2026-02-29`,
 *      `2026-04-31`, hour 24) was accepted as PROVEN because the gate only
 *      tested `Date.parse`, which rolls the day forward to a moment that never
 *      existed. It also evidenced outcomes.
 *   D2 the accepted set was not a total order: an offset-less stamp was parsed
 *      in the HOST zone (same text, three different instants), and
 *      `mapPixelEventRecord` stored the raw text, so three spellings of one
 *      instant compared unequal and a stored-field sort inverted.
 *   D3 every reference string was accepted unvalidated — a URL, a path, a
 *      JSON blob, a script tag, `42`, a percent escape, a trailing slash and a
 *      zero-width spelling were all attributed as `observed_keyword` — and the
 *      contract had no tenant field, so a foreign-tenant reference could not
 *      be refused.
 *
 * Provenance: this file is part of a REBUILD from the preserved patch
 * `t30-fd347d38.patch`; the original branch `pb/PBB-284/t-30-repair` was
 * deleted from origin and its local object graph is broken. The bytes under
 * test are reconstructed on current `origin/main`, not continued from that
 * branch.
 *
 * No database, no client workspace, no network.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildFunnelAttribution,
  canonicalInstant,
  classifyAttribution,
  mapPixelEventRecord,
  observedRefs,
  type FunnelAttributionEvent,
  type FunnelAttributionSnapshot,
} from '../../src/lib/funnel/attribution';

const NOW = '2026-10-24T12:00:00.000Z';
const SOURCE = 'ghl-adapter';
const AT = '2026-10-23T09:15:00.000Z';

function ev(over: Partial<FunnelAttributionEvent> = {}): FunnelAttributionEvent {
  return { kind: 'contact', refs: ['SUMMER'], attribution_source: SOURCE, observed_at: AT, ...over };
}

function build(
  records: unknown[],
  extra: { available?: boolean; tenant?: string | null } = {},
): FunnelAttributionSnapshot {
  return buildFunnelAttribution(records, {
    available: extra.available ?? true,
    source: 'fixture',
    tenant: extra.tenant,
    now: NOW,
  });
}

function bucket(s: FunnelAttributionSnapshot, kind: 'gift' | 'contact' | 'booking' | 'sale') {
  return s.outcomes.find((o) => o.kind === kind)!;
}

// ─── D1: a calendar-impossible stamp names no instant ──────────────────────

test('D1: day-overflow, non-leap and hour-24 stamps are refused, never rolled forward', () => {
  const impossible = [
    '2026-02-30T00:00:00Z',
    '2026-02-29T00:00:00Z', // 2026 is not a leap year
    '2026-04-31T00:00:00Z',
    '2026-06-31T00:00:00Z',
    '2026-09-31T00:00:00Z',
    '2026-11-31T00:00:00Z',
    '2026-10-23T24:00:00Z',
    '2026-10-23T24:00:01Z',
    '2026-13-01T00:00:00Z',
    '2026-00-10T00:00:00Z',
    '2026-10-00T00:00:00Z',
    '2026-10-23T09:15:60Z',
    '2026-13-45T99:99:99Z',
  ];
  for (const at of impossible) {
    const verdict = classifyAttribution(ev({ observed_at: at }));
    assert.equal(verdict.class, 'unknown', `${at} must not be a proven observation`);
    assert.equal(verdict.reason, 'observation_not_provenanced', `${at} reason`);
  }
});

test('D1: a calendar-impossible stamp never evidences an outcome', () => {
  for (const at of ['2026-02-30T00:00:00Z', '2026-02-29T00:00:00Z', '2026-04-31T00:00:00Z']) {
    const s = build([ev({ kind: 'booking', observed_at: at })]);
    assert.equal(bucket(s, 'booking').count, 0, `${at} must not count a booking`);
    assert.equal(bucket(s, 'booking').unknown, 1, `${at} booking refusal`);
    assert.deepEqual(bucket(s, 'booking').unknownReasons, [
      { reason: 'outcome_not_evidenced', count: 1 },
    ]);
  }
});

test('D1 inverse: real calendar instants — including a real leap day — stay proven', () => {
  for (const at of [
    '2024-02-29T00:00:00Z',
    '2026-01-31T23:59:59Z',
    '2026-12-31T00:00:00Z',
    '2026-10-23T09:15:00Z',
    '2026-10-23T09:15:00.123+02:00',
    '2026-10-23T09:15:00-0400',
  ]) {
    assert.equal(classifyAttribution(ev({ observed_at: at })).class, 'observed_keyword', at);
    assert.equal(build([ev({ observed_at: at })]).attribution.observed_keyword, 1, at);
  }
});

test('D1: the offset itself must be a real zone offset', () => {
  for (const at of [
    '2026-10-23T09:15:00+15:00',
    '2026-10-23T09:15:00+14:01',
    '2026-10-23T09:15:00-15:00',
    '2026-10-23T09:15:00+02:60',
  ]) {
    assert.equal(classifyAttribution(ev({ observed_at: at })).class, 'unknown', at);
  }
  for (const at of ['2026-10-23T09:15:00+14:00', '2026-10-23T09:15:00-14:00']) {
    assert.equal(classifyAttribution(ev({ observed_at: at })).class, 'observed_keyword', at);
  }
});

// ─── D2: one instant, one stored spelling, one total order ─────────────────

test('D2: a stamp with no zone is refused — it names a different instant per host', () => {
  for (const at of ['2026-10-23T09:15:00', '2026-10-23T09:15']) {
    assert.equal(classifyAttribution(ev({ observed_at: at })).class, 'unknown', at);
    assert.equal(classifyAttribution(ev({ observed_at: at })).reason, 'observation_not_provenanced');
  }
});

test('D2: three spellings of one instant store ONE canonical string', () => {
  const spellings = [
    '2026-10-23T09:15:00Z',
    '2026-10-23T09:15:00.000Z',
    '2026-10-23T11:15:00+02:00',
    '2026-10-23T05:15:00-0400',
  ];
  for (const at of spellings) {
    assert.equal(
      mapPixelEventRecord({ observed_at: at }).observed_at,
      '2026-10-23T09:15:00.000Z',
      at,
    );
    assert.equal(canonicalInstant(at), '2026-10-23T09:15:00.000Z', at);
  }
});

test('D2: the stored field sorts in instant order — no string/instant inversion', () => {
  const accepted = [
    '2026-10-23T11:15:00+02:00',
    '2026-10-23T09:15:00Z',
    '2026-10-24T00:00:00Z',
    '2026-02-28T23:59:59Z',
  ];
  const stored = (at: string) => String(mapPixelEventRecord({ observed_at: at }).observed_at);
  const byInstant = [...accepted].sort((a, b) => Date.parse(stored(a)) - Date.parse(stored(b)));
  const byString = [...accepted].sort((a, b) => (stored(a) < stored(b) ? -1 : 1));
  assert.deepEqual(byString.map(stored), byInstant.map(stored));
});

test('D2: an unusable observed_at still falls back to a proven timestamp, canonically', () => {
  const mapped = mapPixelEventRecord({
    observed_at: '2026-02-30T00:00:00Z',
    timestamp: '2026-05-30T15:04:22Z',
    agent_id: 'px',
    refs: ['SUMMER'],
  });
  assert.equal(mapped.observed_at, '2026-05-30T15:04:22.000Z');
  assert.equal(classifyAttribution(mapped).class, 'observed_keyword');
});

// ─── D3: a reference is a validated identifier, and tenant-scoped ──────────

test('D3: URL, path, markup, JSON, number-as-string and broken escapes are not references', () => {
  for (const junk of [
    '42',
    '{"a":1}',
    'https://evil.example/?utm_term=SUMMER',
    '<script>alert(1)</script>',
    '/campaigns/summer',
    'SUMMER%',
    'http://m.me/client?ref=SUMMER',
  ]) {
    assert.deepEqual(observedRefs({ refs: [junk] }), [], junk);
    const verdict = classifyAttribution(ev({ refs: [junk] }));
    assert.equal(verdict.class, 'unknown', junk);
    assert.equal(verdict.reason, 'ref_not_an_identifier', junk);
    assert.equal(build([ev({ refs: [junk] })]).attribution.observed_keyword, 0, junk);
    assert.deepEqual(build([ev({ refs: [junk] })]).attribution.unknownReasons, [
      { reason: 'ref_not_an_identifier', count: 1 },
    ]);
  }
});

test('D3: percent escape, trailing slash and zero-width spelling are ONE keyword', () => {
  for (const raw of ['%53UMMER', 'SUMMER/', 'SU​MMER', 'SUMMER']) {
    assert.deepEqual(observedRefs({ refs: [raw] }), ['SUMMER'], raw);
    assert.equal(classifyAttribution(ev({ refs: [raw] })).class, 'observed_keyword', raw);
  }
  // three spellings of one keyword in one event are still one touch
  assert.deepEqual(observedRefs({ refs: ['%53UMMER', 'SUMMER/', 'SUMMER'] }), ['SUMMER']);
  assert.equal(
    classifyAttribution(ev({ refs: ['%53UMMER', 'SUMMER/'] })).class,
    'observed_keyword',
  );
});

test('D3: an invalid reference cannot inflate one valid keyword into multitouch', () => {
  const verdict = classifyAttribution(ev({ refs: ['SUMMER', 'https://evil.example/x'] }));
  assert.equal(verdict.class, 'observed_keyword');
  assert.deepEqual(verdict.refs, ['SUMMER']);
});

test('D3: a foreign-tenant reference is refused when a tenant is supplied', () => {
  const foreign = ev({ kind: 'sale', tenant_id: 'tenant-B' });
  const v = classifyAttribution(foreign, { tenant: 'tenant-A' });
  assert.equal(v.class, 'unknown');
  assert.equal(v.reason, 'ref_foreign_tenant');
  const s = build([foreign], { tenant: 'tenant-A' });
  assert.equal(s.attribution.observed_keyword, 0);
  assert.equal(bucket(s, 'sale').count, 0, 'a foreign-tenant sale must not count');
  assert.deepEqual(bucket(s, 'sale').unknownReasons, [{ reason: 'ref_foreign_tenant', count: 1 }]);
});

test('D3: with a tenant supplied, an event carrying no tenant is unproven, not attributed', () => {
  const noTenant = ev({ tenant_id: undefined });
  assert.equal(classifyAttribution(noTenant, { tenant: 'tenant-A' }).reason, 'tenant_not_provenanced');
  const s = build([noTenant], { tenant: 'tenant-A' });
  assert.equal(s.attribution.unknown, 1);
  assert.deepEqual(s.attribution.unknownReasons, [{ reason: 'tenant_not_provenanced', count: 1 }]);
});

test('D3 inverse: a matching tenant stays attributed', () => {
  const own = ev({ tenant_id: 'tenant-A' });
  assert.equal(classifyAttribution(own, { tenant: 'tenant-A' }).class, 'observed_keyword');
  const s = build([own], { tenant: 'tenant-A' });
  assert.equal(s.attribution.observed_keyword, 1);
  assert.equal(bucket(s, 'contact').count, 1);
});

test('D3: the tenant gap is named when no tenant is supplied, and retired when one is', () => {
  const untargeted = build([ev()]);
  assert.match(untargeted.limitations.join('\n'), /tenant_scope_unverified/);
  const targeted = build([ev({ tenant_id: 'tenant-A' })], { tenant: 'tenant-A' });
  assert.equal(targeted.limitations.join('\n').includes('tenant_scope_unverified'), false);
});

test('D3 inverse: a blank or non-string reference is still "no data", not junk', () => {
  for (const junk of ['', '   ', 42, true, { a: 1 }, null, undefined]) {
    assert.equal(classifyAttribution(ev({ refs: [junk] })).reason, 'no_attribution_data');
  }
  assert.deepEqual(observedRefs({ refs: ['   '] }), []);
});
