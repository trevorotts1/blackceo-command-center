/**
 * tests/unit/u46-health-tier-aggregation.test.ts
 *
 * U46 — Criticality-tiered health aggregation ("make 'down' mean down").
 *
 * Exercises the pure aggregation function shared by BOTH system-status.ts
 * call sites (the fresh-probe path `runAllProbes` and the cached-read path
 * `readCachedStatus`) so this suite needs no DB, no network, and no probe
 * mocking — it tests the exact logic those two call sites delegate to.
 *
 * Runs via the Node built-in test runner under tsx (`npm run test:unit`).
 *
 * Binary acceptance covered (spec H+L.1.2 / U46):
 *   (a) exactly one auxiliary probe forced offline -> overall === 'degraded'
 *   (b) openclaw_gateway forced offline -> overall === 'offline'
 *   (c) tierFor() classifies database + openclaw_gateway as 'critical' and
 *       every other known component id as 'auxiliary' (the field system-
 *       status.ts stamps onto every row of the real payload)
 *   (d) identical inputs given to computeOverallTiered() (the function both
 *       call sites invoke) always produce an identical overall — so the
 *       fresh and cached paths cannot diverge for the same underlying data
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CRITICAL_COMPONENTS,
  computeOverallTiered,
  tierFor,
  type SystemStatus,
  type TieredStatusInput,
} from '../../src/lib/probes/types';

/** A fully-live 12-component baseline mirroring the real probe roster. */
function baseline(): TieredStatusInput[] {
  const auxiliaryIds = [
    'telegram',
    'memory',
    'jobs',
    'disk',
    'agents',
    'cli',
    'cloudflare_tunnel',
    'cloudflare_access',
    'unauthorized_401',
    'provider_anthropic',
  ];
  return [
    { component: 'database', tier: 'critical', status: 'live' },
    { component: 'openclaw_gateway', tier: 'critical', status: 'live' },
    ...auxiliaryIds.map((component) => ({
      component,
      tier: 'auxiliary' as const,
      status: 'live' as SystemStatus,
    })),
  ];
}

function withStatus(
  components: TieredStatusInput[],
  component: string,
  status: SystemStatus
): TieredStatusInput[] {
  return components.map((c) => (c.component === component ? { ...c, status } : c));
}

// ── tierFor / CRITICAL_COMPONENTS ───────────────────────────────────────────

test('tierFor classifies database and openclaw_gateway as critical', () => {
  assert.equal(tierFor('database'), 'critical');
  assert.equal(tierFor('openclaw_gateway'), 'critical');
});

test('tierFor classifies every other known component as auxiliary', () => {
  const auxiliaryIds = [
    'telegram',
    'memory',
    'jobs',
    'disk',
    'agents',
    'cli',
    'cloudflare_tunnel',
    'cloudflare_access',
    'unauthorized_401',
    'provider_openrouter',
    'provider_anthropic',
    'provider_ollama_cloud',
  ];
  for (const id of auxiliaryIds) {
    assert.equal(tierFor(id), 'auxiliary', `expected ${id} to be auxiliary`);
  }
});

test('CRITICAL_COMPONENTS is exactly database + openclaw_gateway', () => {
  assert.deepEqual([...CRITICAL_COMPONENTS].sort(), ['database', 'openclaw_gateway']);
});

// ── (a) one auxiliary probe offline -> degraded ─────────────────────────────

test('(a) exactly one auxiliary probe (disk) offline yields overall === degraded', () => {
  const components = withStatus(baseline(), 'disk', 'offline');
  assert.equal(computeOverallTiered(components), 'degraded');
});

test('(a) an auxiliary probe degraded (not offline) also yields overall === degraded', () => {
  const components = withStatus(baseline(), 'telegram', 'degraded');
  assert.equal(computeOverallTiered(components), 'degraded');
});

test('(a) an auxiliary probe unknown also yields overall === degraded', () => {
  const components = withStatus(baseline(), 'jobs', 'unknown');
  assert.equal(computeOverallTiered(components), 'degraded');
});

// ── (b) critical probe (openclaw_gateway) offline -> offline ───────────────

test('(b) openclaw_gateway forced offline yields overall === offline', () => {
  const components = withStatus(baseline(), 'openclaw_gateway', 'offline');
  assert.equal(computeOverallTiered(components), 'offline');
});

test('(b) database forced offline yields overall === offline', () => {
  const components = withStatus(baseline(), 'database', 'offline');
  assert.equal(computeOverallTiered(components), 'offline');
});

test('a critical outage is never masked by an otherwise-live auxiliary fleet', () => {
  // All 10 auxiliary rows stay live; only the critical gateway is down.
  const components = withStatus(baseline(), 'openclaw_gateway', 'offline');
  const auxStatuses = components.filter((c) => c.tier === 'auxiliary').map((c) => c.status);
  assert.ok(auxStatuses.every((s) => s === 'live'), 'test setup sanity: aux all live');
  assert.equal(computeOverallTiered(components), 'offline');
});

test('a critical component that is degraded (not offline) still surfaces as degraded, never a silent live', () => {
  const components = withStatus(baseline(), 'database', 'degraded');
  assert.equal(computeOverallTiered(components), 'degraded');
});

// ── all-healthy baseline -> live ────────────────────────────────────────────

test('an all-live fleet yields overall === live', () => {
  assert.equal(computeOverallTiered(baseline()), 'live');
});

// ── (d) identical inputs -> identical overall (fresh vs cached path parity) ─

test('(d) computeOverallTiered is deterministic: identical inputs always produce an identical overall', () => {
  const scenarios: TieredStatusInput[][] = [
    baseline(),
    withStatus(baseline(), 'disk', 'offline'),
    withStatus(baseline(), 'openclaw_gateway', 'offline'),
    withStatus(withStatus(baseline(), 'database', 'degraded'), 'cli', 'unknown'),
  ];
  for (const scenario of scenarios) {
    // Simulate the fresh path and the cached path each calling the SAME
    // shared function independently (as system-status.ts's two call sites
    // do) on the same underlying component/tier/status triples.
    const freshPathOverall = computeOverallTiered(scenario.map((c) => ({ ...c })));
    const cachedPathOverall = computeOverallTiered(scenario.map((c) => ({ ...c })));
    assert.equal(freshPathOverall, cachedPathOverall);
  }
});
