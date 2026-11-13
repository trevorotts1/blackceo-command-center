/**
 * tests/unit/health-badge-truth.test.ts  (copy verbatim in build unit U-01)
 *
 * Proves the header badge is "Healthy" when the box is healthy and "Degraded"
 * only when something a client depends on is actually wrong.
 * Runs under the Node test runner: node --import tsx --test <this file>
 *
 * The advisory ids are written out here on purpose. A test that built its list
 * from ADVISORY_COMPONENTS would keep passing when a row was dropped from that
 * list, which is exactly the regression this file exists to catch.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ADVISORY_COMPONENTS,
  computeOverallTiered,
  countsTowardOverall,
  isAdvisory,
  tierFor,
  type SystemStatus,
} from '../../src/lib/probes/types';
import { parseReadiness } from '../../src/lib/health-readiness';

const at = '2026-11-11T00:00:00.000Z';
type Row = { component: string; label: string; tier: string; status: SystemStatus; latencyMs: null; probedAt: string; detail?: Record<string, unknown> };
const row = (component: string, status: SystemStatus, detail?: Record<string, unknown>): Row =>
  ({ component, label: component, tier: tierFor(component), status, latencyMs: null, probedAt: at, detail });

const COUNTED = ['openclaw_gateway', 'jobs', 'agents', 'disk'];
const EXPECTED_ADVISORY = [
  'cli', 'cloudflare_tunnel', 'cloudflare_access', 'memory', 'telegram', 'unauthorized_401', 'embedding_readiness',
];
/** Advisory rows the server sends (embedding_readiness is added by the browser), plus two provider rows. */
const ADVISORY = [...EXPECTED_ADVISORY.filter((c) => c !== 'embedding_readiness'), 'provider_openai', 'provider_google'];
const okHealth = { status: 'ok', embeddings: { status: 'ok', degraded: false } };

/** A full, clean box. `override` replaces the status of named rows. */
function box(override: Record<string, SystemStatus> = {}, detail: Record<string, Record<string, unknown>> = {}): Row[] {
  return ['database', ...COUNTED, ...ADVISORY].map((id) => row(id, override[id] ?? 'live', detail[id]));
}

/** The server's verdict and the browser's verdict for the same rows. */
function verdicts(rows: Row[], health: unknown = okHealth) {
  const server = computeOverallTiered(rows.filter(countsTowardOverall) as never);
  const browser = parseReadiness({ overall: server, probedAt: at, components: rows }, health).tier;
  return { server, browser };
}

test('the advisory list is exactly the written policy', () => {
  assert.deepEqual([...ADVISORY_COMPONENTS].sort(), [...EXPECTED_ADVISORY].sort());
  for (const id of COUNTED) assert.equal(isAdvisory(id), false, `${id} must count toward the badge`);
  assert.equal(isAdvisory('database'), false);
});

test('a clean box is Healthy', () => {
  assert.deepEqual(verdicts(box()), { server: 'live', browser: 'healthy' });
});

test('every advisory row broken at once: still Healthy', () => {
  const broken = Object.fromEntries(ADVISORY.map((id) => [id, 'offline' as SystemStatus]));
  assert.deepEqual(verdicts(box(broken)), { server: 'live', browser: 'healthy' });
  for (const id of ADVISORY) assert.equal(isAdvisory(id), true, `${id} must be advisory`);
});

test('the empty tool registry (the original always-Degraded cause) is Healthy', () => {
  // Shape after U-01 Edit 4 (the probe now says configured: false).
  const marked = box({ cli: 'unknown' }, { cli: { configured: false, registered: 0 } });
  assert.deepEqual(verdicts(marked), { server: 'live', browser: 'healthy' });
  // Shape the probe sends today (no configured flag): healthy because the row is advisory.
  const today = box({ cli: 'unknown' }, { cli: { registered: 0 } });
  assert.deepEqual(verdicts(today), { server: 'live', browser: 'healthy' });
});

for (const id of ADVISORY) {
  for (const bad of ['degraded', 'offline', 'unknown'] as SystemStatus[]) {
    test(`advisory ${id} ${bad} alone: still Healthy`, () => {
      assert.deepEqual(verdicts(box({ [id]: bad })), { server: 'live', browser: 'healthy' });
    });
  }
}

test('a tunnel the container cannot see is Healthy', () => {
  const rows = box({ cloudflare_tunnel: 'unknown' }, { cloudflare_tunnel: { configured: false } });
  assert.equal(verdicts(rows).browser, 'healthy');
});

test('search-index trouble alone does not change the badge', () => {
  const health = { status: 'ok', embeddings: { status: 'degraded', degraded: true } };
  assert.equal(verdicts(box(), health).browser, 'healthy');
});

for (const id of COUNTED) {
  for (const bad of ['degraded', 'offline', 'unknown'] as SystemStatus[]) {
    test(`${id} ${bad}: Degraded on server and in browser`, () => {
      assert.equal(isAdvisory(id), false);
      assert.deepEqual(verdicts(box({ [id]: bad })), { server: 'degraded', browser: 'degraded' });
    });
  }
  for (const fine of ['working', 'busy'] as SystemStatus[]) {
    test(`${id} ${fine}: still Healthy`, () => {
      assert.equal(verdicts(box({ [id]: fine })).browser, 'healthy');
    });
  }
}

test('database offline: Unavailable', () => {
  assert.deepEqual(verdicts(box({ database: 'offline' })), { server: 'offline', browser: 'unavailable' });
});

test('database degraded: Degraded', () => {
  assert.equal(verdicts(box({ database: 'degraded' })).browser, 'degraded');
});

test('updates still being applied: Degraded; failed start: Unavailable', () => {
  assert.equal(verdicts(box(), { status: 'degraded', embeddings: { status: 'ok', degraded: false } }).browser, 'degraded');
  assert.equal(verdicts(box(), { status: 'error', embeddings: { status: 'degraded', degraded: true } }).browser, 'unavailable');
});

test('a missing required row can never certify health', () => {
  const rows = box().filter((r) => r.component !== 'openclaw_gateway');
  assert.equal(parseReadiness({ overall: 'live', probedAt: at, components: rows }, okHealth).tier, 'unknown');
});
