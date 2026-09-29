/**
 * Overflow only onto a model this box can actually place a run on.
 *
 * Live (2026-09-28): the scorer overflowed to an agent's declared fallback
 * openrouter/moonshotai/kimi-k2.6 on a box where openrouter was neither
 * configured nor in modelPolicy.allow; the gateway refused the placement and
 * the intake sweep re-picked it every 2 minutes, forever.
 */
import './_isolated-db';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  __resetPlacementCooldownsForTests,
  coolRefusedPlacement,
  placementBlocker,
  scoreRoute,
} from '@/lib/capacity/route-scorer';
import type { ProviderLedgerEntry } from '@/lib/capacity/resource-ledger';
import type { Agent } from '@/lib/types';

const AGENT = { id: 'placeable-agent', name: 'Placeable Agent', role: 'specialist' } as unknown as Agent;
const KIMI = 'openrouter/moonshotai/kimi-k2.6';
const PRIMARY = 'ollama/deepseek-v4.1-flash:cloud';

function entry(provider: string, over: Partial<ProviderLedgerEntry> = {}): ProviderLedgerEntry {
  return { provider, slotsFree: 5, slotsLimit: 5, effectiveLimit: 5, coolingUntil: null, balance: null,
    balanceCurrency: null, balanceAsOf: null, pricePerMTokIn: null, pricePerMTokOut: null, lastProbeError: null, ...over };
}

test('a fallback outside modelPolicy.allow is not placeable', () => {
  const cfg = { agents: { defaults: { modelPolicy: { allow: [PRIMARY] } } }, models: { providers: { openrouter: {} } } };
  assert.equal(placementBlocker(KIMI, cfg), 'not in modelPolicy.allow');
  assert.equal(placementBlocker(PRIMARY, cfg), null);
});

test('a fallback whose provider is not configured on the box is not placeable', () => {
  // A box with no openrouter key anywhere: not in env, not in ~/.openclaw/.env.
  const prior = { key: process.env.OPENROUTER_API_KEY, home: process.env.HOME };
  delete process.env.OPENROUTER_API_KEY;
  process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'placeable-home-'));
  try {
    assert.equal(placementBlocker(KIMI, { models: { providers: {} } }), 'provider not configured on this box');
    assert.equal(placementBlocker(KIMI, { models: { providers: { openrouter: {} } } }), null);
    assert.equal(placementBlocker(KIMI, null), null, 'an unreadable config blocks nothing');
  } finally {
    if (prior.key !== undefined) process.env.OPENROUTER_API_KEY = prior.key;
    process.env.HOME = prior.home;
  }
});

test('a refused placement cools that model down for 30 minutes', () => {
  __resetPlacementCooldownsForTests();
  const cfg = { models: { providers: { openrouter: {} } } };
  const t0 = Date.parse('2026-09-28T20:00:00Z');
  coolRefusedPlacement(KIMI, t0);
  assert.equal(placementBlocker(KIMI, cfg, t0 + 60_000), 'refused by the gateway recently');
  assert.equal(placementBlocker(KIMI, cfg, t0 + 31 * 60_000), null);
  __resetPlacementCooldownsForTests();
});

test('scoreRoute never offers an unplaceable fallback as the overflow target', () => {
  const base = {
    agent: AGENT,
    candidateModels: [PRIMARY, KIMI],
    ledger: [entry('ollama', { slotsFree: 0 }), entry('openrouter')],
    latency: {},
  };
  assert.equal(scoreRoute({ ...base, placeable: () => true }).overflowTo?.modelId, KIMI);
  assert.equal(scoreRoute({ ...base, placeable: (m) => m !== KIMI }).overflowTo, null,
    'the card queues on its primary instead of looping on a refused placement');
});
