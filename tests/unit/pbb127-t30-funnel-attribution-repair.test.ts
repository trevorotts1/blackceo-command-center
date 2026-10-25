/**
 * PBB-127 / T-30 repair (c-t-30) — the three defects the independent QC named
 * against commit a858d6d443 (`qc-t-30` in the PBB-147 ledger journal), each
 * pinned by an assertion that FAILS on that commit and PASSES after the fix:
 *
 *   D1 attribution.ts:203-205 made `refs` and `touch_refs` mutually exclusive,
 *      so two observed touches were reported as `observed_keyword`, and with
 *      `refs: []` two touches reported "no attribution reference was observed".
 *   D2 `FunnelAttributionView` was dead code — imported by no route or page.
 *   D3 no producer emits the module's input contract; the one wired reader
 *      (`readJsonlDir('pixel-events')`) yields the Skill-38 protocol record
 *      shape, which carries no attribution reference and no outcome kind.
 *
 * The 24 original cases in `pbb127-t30-funnel-attribution.test.ts` are left
 * byte-identical by this repair: nothing proven there is weakened here, and
 * each clause below is proven in both directions where a direction exists.
 *
 * The symbols added by the repair (and the mounted page) are imported
 * dynamically and asserted to exist, so on the pre-repair commit this file
 * still RUNS and reports one failing case per defect instead of dying at
 * import — that is the before/after proof.
 *
 * No database, no real client workspace, no network. The route mount is
 * exercised against a throwaway workspace root (`OPENCLAW_COMPANY_ROOT`).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  buildFunnelAttribution,
  classifyAttribution,
  loadFunnelAttribution,
  observedRefs,
  type FunnelAttributionEvent,
} from '../../src/lib/funnel/attribution';
import { FunnelAttributionView } from '../../src/components/funnel/FunnelAttributionView';

/** Symbols the repair adds; optional here so the pre-repair run fails per case. */
interface RepairApi {
  mapPixelEventRecord?: (raw: unknown) => FunnelAttributionEvent;
  FUNNEL_INPUT_CONTRACT_FIELDS?: readonly string[];
  PRODUCER_LIMITATION_IDS?: readonly string[];
}

/**
 * Loaded per test (module cache keeps this free): on the pre-repair commit the
 * page import REJECTS, so the catch keeps the suite running and the case fails
 * on its own assertion instead of the file dying at load.
 */
async function repairApi(): Promise<RepairApi> {
  return (await import('../../src/lib/funnel/attribution')) as unknown as RepairApi;
}

async function mountPage(): Promise<((props: Record<string, never>) => unknown) | null> {
  const mod = (await import('../../src/app/conversational-ai/funnel/page').catch(() => null)) as {
    default?: (props: Record<string, never>) => unknown;
  } | null;
  return mod?.default ?? null;
}

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

function build(records: unknown[], available = true) {
  return buildFunnelAttribution(records, { available, source: 'fixture', now: NOW });
}

async function mapPixel(raw: unknown): Promise<FunnelAttributionEvent> {
  const api = await repairApi();
  assert.equal(typeof api.mapPixelEventRecord, 'function', 'mapPixelEventRecord must exist');
  return api.mapPixelEventRecord!(raw);
}

async function limitationIds(): Promise<readonly string[]> {
  const api = await repairApi();
  assert.ok(Array.isArray(api.PRODUCER_LIMITATION_IDS), 'PRODUCER_LIMITATION_IDS must exist');
  return api.PRODUCER_LIMITATION_IDS!;
}

// ─── D1: refs + touch_refs + keyword_ref are UNIONED, never exclusive ──────

test('D1: refs AND touch_refs are unioned — the second observed touch is never discarded', () => {
  assert.deepEqual(observedRefs(ev({ refs: ['A'], touch_refs: ['A', 'B'] })), ['A', 'B']);
  const s = build([ev({ refs: ['A'], touch_refs: ['A', 'B'] })]);
  assert.equal(s.attribution.multitouch, 1);
  assert.equal(s.attribution.observed_keyword, 0);
  assert.equal(s.attribution.unknown, 0);
});

test('D1: with refs: [] the observed touch_refs are still observed — never "no attribution data"', () => {
  assert.deepEqual(observedRefs({ refs: [], touch_refs: ['A', 'B'] }), ['A', 'B']);
  const s = build([ev({ refs: [], touch_refs: ['A', 'B'] })]);
  assert.equal(s.attribution.multitouch, 1);
  assert.equal(s.attribution.observed_keyword, 0);
  assert.equal(s.attribution.unknown, 0);
  assert.deepEqual(s.attribution.unknownReasons, []);
});

test('D1: keyword_ref joins the union; dedupe stays case-insensitive across all three fields', () => {
  assert.deepEqual(observedRefs({ refs: ['A'], touch_refs: ['B', 'a'], keyword_ref: 'C' }), [
    'A',
    'B',
    'C',
  ]);
  const s = build([ev({ refs: ['A'], touch_refs: ['B'], keyword_ref: 'C' })]);
  assert.equal(s.attribution.multitouch, 1);
  assert.equal(s.attribution.observed_keyword, 0);
});

test('D1 inverse: ONE distinct touch is still observed_keyword whatever field carried it', () => {
  for (const record of [
    ev({ refs: ['A'], touch_refs: undefined, keyword_ref: undefined }),
    ev({ refs: undefined, touch_refs: ['A'], keyword_ref: undefined }),
    ev({ refs: undefined, touch_refs: undefined, keyword_ref: 'A' }),
    ev({ refs: ['A'], touch_refs: ['A'], keyword_ref: 'A' }),
  ]) {
    assert.deepEqual(observedRefs(record), ['A']);
    assert.equal(classifyAttribution(record).class, 'observed_keyword');
    assert.equal(build([record]).attribution.observed_keyword, 1);
    assert.equal(build([record]).attribution.multitouch, 0);
  }
});

test('D1 inverse: no reference at all is still unknown/no_attribution_data, never multitouch', () => {
  const s = build([ev({ refs: [], touch_refs: [], keyword_ref: undefined })]);
  assert.equal(s.attribution.unknown, 1);
  assert.equal(s.attribution.multitouch, 0);
  assert.deepEqual(s.attribution.unknownReasons, [{ reason: 'no_attribution_data', count: 1 }]);
});

// ─── D2: the view is mounted on a real route and renders at runtime ────────

test('D2: the funnel attribution view is mounted on a real page and renders from the wired reader', async () => {
  const page = await mountPage();
  assert.ok(page, 'src/app/conversational-ai/funnel/page.tsx must exist and export a page');

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-t30-mount-'));
  fs.mkdirSync(path.join(root, 'pixel-events'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'pixel-events', '2026-05-30.jsonl'),
    `${JSON.stringify({
      timestamp: '2026-05-30T15:04:22Z',
      event_type: 'scroll',
      site_id: 'site-1',
      agent_id: 'pixel-concierge',
      visitor_id: 'a1b2c3d4e5f6',
      path: '/pricing',
      data: { depth_pct: 80 },
    })}\n`,
    'utf8',
  );

  const prevRoot = process.env.OPENCLAW_COMPANY_ROOT;
  process.env.OPENCLAW_COMPANY_ROOT = root;
  try {
    const html = renderToStaticMarkup(createElement(page!));
    assert.match(html, /Funnel attribution/);
    assert.match(html, /Observed keyword/);
    assert.match(html, /Multitouch/);
    assert.match(html, /Sales/);
    // The runtime page reads the SAME source the module documents, so a live
    // pixel record is really classified — and it carries no attribution ref,
    // so the page must show the named limitation instead of a success.
    assert.match(html, new RegExp((await limitationIds())[0]));
  } finally {
    if (prevRoot === undefined) delete process.env.OPENCLAW_COMPANY_ROOT;
    else process.env.OPENCLAW_COMPANY_ROOT = prevRoot;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ─── D3: no producer emits the contract — mapped honestly, gap named ──────

test('D3: the input contract fields are named in the module, machine-checkable', async () => {
  const api = await repairApi();
  assert.ok(
    Array.isArray(api.FUNNEL_INPUT_CONTRACT_FIELDS),
    'FUNNEL_INPUT_CONTRACT_FIELDS must exist',
  );
  for (const field of [
    'kind',
    'refs',
    'keyword_ref',
    'touch_refs',
    'attribution_source',
    'observed_at',
  ]) {
    assert.equal(
      (api.FUNNEL_INPUT_CONTRACT_FIELDS as readonly string[]).includes(field),
      true,
      `contract must name ${field}`,
    );
  }
});

test('D3: a pixel-events record maps ONLY what it proves — no ref and no outcome kind is invented', async () => {
  const mapped = await mapPixel({
    timestamp: '2026-05-30T15:04:22Z',
    event_type: 'click',
    site_id: 'site-1',
    agent_id: 'pixel-concierge',
    visitor_id: 'a1b2c3d4e5f6',
    fingerprint: 'k9x2',
    path: '/pricing',
    referrer: 'https://m.me/client?ref=SUMMER',
    seconds_on_page: 185,
    total_visits: 2,
    first_visit_date: '2026-05-28T10:11:00Z',
    data: { text: 'SUMMER', href: 'https://m.me/client', intent_hint: 'buy' },
  });

  // what the source proves:
  assert.equal(mapped.observed_at, '2026-05-30T15:04:22.000Z'); // Repair 3 (D2): canonical UTC
  assert.equal(mapped.attribution_source, 'pixel-concierge');
  // what it cannot prove — never invented:
  assert.equal(mapped.refs, undefined);
  assert.equal(mapped.keyword_ref, undefined);
  assert.equal(mapped.touch_refs, undefined);
  assert.equal(mapped.kind, undefined);
  assert.deepEqual(observedRefs(mapped), []);
  assert.equal(classifyAttribution(mapped).class, 'unknown');
  assert.equal(classifyAttribution(mapped).reason, 'no_attribution_data');
});

test('D3: pixel-shaped records count no outcome and the gap is named in the snapshot AND the view', async () => {
  const s = loadFunnelAttribution({
    read: () => ({
      available: true,
      source: '/fixture/pixel-events',
      records: [
        {
          timestamp: AT,
          event_type: 'scroll',
          agent_id: 'pixel-concierge',
          site_id: 'site-1',
          data: { depth_pct: 80 },
        },
        {
          timestamp: AT,
          event_type: 'click',
          agent_id: 'pixel-concierge',
          site_id: 'site-1',
          data: { text: 'SUMMER' },
        },
      ],
    }),
    now: NOW,
  });

  for (const kind of ['gift', 'contact', 'booking', 'sale'] as const) {
    assert.equal(s.outcomes.find((o) => o.kind === kind)!.count, 0);
  }
  assert.equal(s.nonOutcome, 2);
  assert.equal(s.attribution.unknown, 2);
  assert.equal(s.attribution.observed_keyword, 0);
  assert.equal(s.attribution.multitouch, 0);

  const ids = await limitationIds();
  const named = s.limitations.join('\n');
  assert.match(named, new RegExp(ids[0]));
  assert.match(named, /pixel-events/);
  assert.match(named, /attribution reference/);
  assert.match(named, /outcome kind/);

  const html = renderToStaticMarkup(createElement(FunnelAttributionView, { snapshot: s }));
  assert.match(html, new RegExp(ids[0]));
});

test('D3 inverse: a record that DOES carry the contract still counts, mapped or not', async () => {
  const record = ev({ kind: 'sale', refs: ['A'] });
  const mapped = await mapPixel(record);
  assert.deepEqual(observedRefs(mapped), ['A']);
  assert.equal(mapped.attribution_source, OBSERVED);
  const s = loadFunnelAttribution({
    read: () => ({ available: true, source: '/fixture/pixel-events', records: [mapped] }),
    now: NOW,
  });
  assert.equal(s.outcomes.find((o) => o.kind === 'sale')!.count, 1);
  assert.equal(s.attribution.observed_keyword, 1);
  assert.equal(s.nonOutcome, 0);
});
