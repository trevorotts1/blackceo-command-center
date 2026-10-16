import test from 'node:test';
import assert from 'node:assert/strict';
import { isNotApplicable } from '../../src/lib/probes/types';
import { parseReadiness } from '../../src/lib/health-readiness';

const at = '2026-10-07T00:00:00.000Z';
const row = (component: string, tier: string, status: string, detail?: object) =>
  ({ component, label: component, tier, status, latencyMs: null, probedAt: at, detail });

test('unconfigured, empty-memory and provider unknowns are not applicable; real faults are', () => {
  assert.equal(isNotApplicable(row('provider_openai', 'auxiliary', 'unknown') as never), true);
  assert.equal(isNotApplicable(row('telegram', 'auxiliary', 'unknown', { configured: false }) as never), true);
  assert.equal(isNotApplicable(row('memory', 'auxiliary', 'unknown', { entries: 0 }) as never), true);
  assert.equal(isNotApplicable(row('cli', 'auxiliary', 'unknown', { registered: 0 }) as never), false);
  assert.equal(isNotApplicable(row('telegram', 'auxiliary', 'degraded', { configured: false }) as never), false);
});

test('client readiness: only not-applicable unknowns => healthy; a real unknown still degrades', () => {
  const health = { status: 'ok', embeddings: { status: 'ok', degraded: false } };
  const base = [
    row('database', 'critical', 'live'),
    row('openclaw_gateway', 'auxiliary', 'live'),
    row('provider_openai', 'auxiliary', 'unknown', { configured: false }),
    row('telegram', 'auxiliary', 'unknown', { configured: false }),
    row('memory', 'auxiliary', 'unknown', { entries: 0 }),
  ];
  const status = (components: object[]) => ({ overall: 'live', probedAt: at, components });
  assert.equal(parseReadiness(status(base), health).tier, 'healthy');
  assert.equal(parseReadiness(status([...base, row('cli', 'auxiliary', 'unknown')]), health).tier, 'degraded');
});
