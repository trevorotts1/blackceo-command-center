/**
 * tests/unit/health-client-reasons.test.ts  (U-06 / CC-004, CC-020, CC-022)
 *
 * The client badge is the one health surface a client gets. This proves the
 * exact plain-English copy, that advisory rows never produce a reason (they do
 * not move the badge either), and that no returned string can leak an
 * internal id, address or URL.
 *
 * Runs under the Node test runner: node --import tsx --test <this file>
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { clientLabel, clientReasons } from '../../src/lib/health-client-reasons';
import { parseReadiness } from '../../src/lib/health-readiness';
import { tierFor, type SystemStatus } from '../../src/lib/probes/types';
import type { HealthTier } from '../../src/lib/health-readiness';

const at = '2026-11-11T00:00:00.000Z';

type Row = {
  component: string;
  label: string;
  tier: 'critical' | 'auxiliary';
  status: SystemStatus;
  latencyMs: number | null;
  probedAt: string;
  detail?: Record<string, unknown>;
};

const row = (component: string, status: SystemStatus, detail?: Record<string, unknown>): Row => ({
  component,
  label: component,
  tier: tierFor(component),
  status,
  latencyMs: null,
  probedAt: at,
  detail,
});

/** Every row the browser is handed: the critical one, the counted ones, and advisory ones. */
const ROWS = ['database', 'openclaw_gateway', 'jobs', 'agents', 'disk', 'cloudflare_tunnel', 'memory', 'telegram'];

function statusPayload(override: Record<string, SystemStatus> = {}, overall: SystemStatus = 'live') {
  return {
    overall,
    probedAt: at,
    components: ROWS.map((id) => row(id, override[id] ?? 'live')),
    fromCache: false,
    cacheAgeMs: null,
  };
}

const okHealth = { status: 'ok', embeddings: { status: 'ok', degraded: false } };
const degradedHealth = { status: 'degraded', embeddings: { status: 'ok', degraded: false } };

/** The exact table from the spec: one row each, in this order. */
const TABLE: Array<{ id: string; title: string; body: string }> = [
  {
    id: 'database',
    title: "Your Command Center's records are not responding",
    body: 'Nothing has been lost. Try again in a few minutes.',
  },
  {
    id: 'openclaw_gateway',
    title: "Your AI team can't be reached right now",
    body: 'New tasks will wait safely and start on their own once the connection is back.',
  },
  {
    id: 'jobs',
    title: 'Some tasks have not moved for a while',
    body: 'Open the board and look at the "In Progress" column. A task may be waiting on an answer from you.',
  },
  {
    id: 'agents',
    title: 'One of your AI team members reported a problem',
    body: 'Tasks for that team member may be slower than usual.',
  },
  {
    id: 'disk',
    title: 'This computer is almost out of storage',
    body: 'Work may pause until space is freed.',
  },
];

test('U-06: clientLabel is the exact table wording for every tier', () => {
  const expected: Record<HealthTier, string> = {
    healthy: 'All systems working',
    degraded: 'Needs attention',
    unavailable: 'Offline',
    checking: 'Checking…',
    unknown: 'Status not available',
  };
  for (const tier of Object.keys(expected) as HealthTier[]) {
    assert.equal(clientLabel(tier), expected[tier]);
  }
});

for (const entry of TABLE) {
  test(`U-06: ${entry.id} not running produces its exact title and body`, () => {
    const { payload } = parseReadiness(statusPayload({ [entry.id]: 'offline' }), okHealth);
    assert.notEqual(payload, null);
    const reasons = clientReasons(payload, 'ok');
    const found = reasons.find((r) => r.title === entry.title);
    assert.ok(found, `missing reason "${entry.title}" in ${JSON.stringify(reasons)}`);
    assert.equal(found.body, entry.body);
  });
}

test('U-06: health status "degraded" produces "An update is finishing"', () => {
  const { payload } = parseReadiness(statusPayload(), degradedHealth);
  assert.notEqual(payload, null);
  const reasons = clientReasons(payload, 'degraded');
  assert.ok(
    reasons.some(
      (r) => r.title === 'An update is finishing' && r.body === 'This usually clears within a few minutes.'
    ),
    JSON.stringify(reasons)
  );
});

test('U-06: one reason per bad counted row, in table order', () => {
  const { payload } = parseReadiness(
    statusPayload({ openclaw_gateway: 'offline', jobs: 'degraded', agents: 'unknown' }),
    okHealth
  );
  const titles = clientReasons(payload, 'ok').map((r) => r.title);
  assert.deepEqual(titles, [
    "Your AI team can't be reached right now",
    'Some tasks have not moved for a while',
    'One of your AI team members reported a problem',
  ]);
});

test('U-06: advisory-only failures stay healthy and say nothing', () => {
  const { tier, payload } = parseReadiness(
    statusPayload({ cloudflare_tunnel: 'offline', telegram: 'degraded', memory: 'unknown' }),
    okHealth
  );
  assert.equal(tier, 'healthy');
  assert.deepEqual(clientReasons(payload, 'ok'), []);
});

test('U-06: a clean box says nothing', () => {
  const { tier, payload } = parseReadiness(statusPayload(), okHealth);
  assert.equal(tier, 'healthy');
  assert.deepEqual(clientReasons(payload, 'ok'), []);
});

test('U-06: degraded with nothing specific to point at gets the soft line', () => {
  const { tier, payload } = parseReadiness(statusPayload({}, 'degraded'), okHealth);
  assert.equal(tier, 'degraded');
  const reasons = clientReasons(payload, 'ok');
  assert.equal(reasons.length, 1);
  assert.equal(reasons[0].title, "We're double-checking a few things");
  assert.equal(
    reasons[0].body,
    'Everything you need is working. If this is still showing in an hour, let your support contact know.'
  );
});

test('U-06: no reason ever contains an internal id, address or URL', () => {
  const banned = ['openclaw', 'cloudflare', '/', 'http', '_'];
  const samples = [
    ...TABLE.map((entry) => parseReadiness(statusPayload({ [entry.id]: 'offline' }), okHealth).payload),
    parseReadiness(statusPayload({ jobs: 'degraded', disk: 'unknown' }), okHealth).payload,
    parseReadiness(statusPayload({}, 'degraded'), okHealth).payload,
    parseReadiness(statusPayload(), degradedHealth).payload,
  ];
  const texts: string[] = [];
  for (const payload of samples) {
    for (const reason of clientReasons(payload, payload?.overall === 'degraded' ? 'degraded' : 'ok')) {
      texts.push(reason.title, reason.body);
    }
  }
  texts.push(
    ...(['healthy', 'degraded', 'unavailable', 'checking', 'unknown'] as HealthTier[]).map(clientLabel)
  );
  assert.ok(texts.length > 10, 'sanity: expected many strings to check');
  for (const text of texts) {
    for (const word of banned) {
      assert.equal(
        text.toLowerCase().includes(word),
        false,
        `"${text}" must not contain "${word}"`
      );
    }
  }
});

test('U-06: an empty or missing payload never throws and never invents a reason', () => {
  assert.deepEqual(clientReasons(null, null), []);
  assert.deepEqual(clientReasons(null, 'ok'), []);
});
