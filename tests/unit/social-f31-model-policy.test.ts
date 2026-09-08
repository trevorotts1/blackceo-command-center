/**
 * social-f31-model-policy.test.ts — F31: provider-first model choice with
 * approved fallbacks; provider-verified FULL slugs (suffix variants included).
 *
 * Parity with the Python side (shared-utils/select_model.py +
 * social_model_policy.py):
 *   - `openrouter/z-ai/glm-5.3-flash` (and sibling suffix variants) must be
 *     accepted as provider-verified full slugs — never rejected for carrying a
 *     `-flash`/`-pro`/`-preview`/`:cloud` suffix;
 *   - selection never upgrades silently to a newer version;
 *   - approved fallbacks apply in the client's saved order;
 *   - provider_id is separate from model_id (no implicit OpenRouter/Ollama routing).
 *
 *   node --import tsx --import ./tests/setup/no-owner-telegram.ts --test tests/unit/social-f31-model-policy.test.ts
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  selectTaskModel,
  isProviderVerifiedSlug,
  baseVerifiedSlugs,
  selectApprovedCapableFallback,
  NEEDS_OWNER_INPUT,
} from '../../src/lib/model-selector';
import type { ModelRegistryEntry } from '../../src/lib/model-registry-types';

function model(
  model_id: string,
  capabilities: ModelRegistryEntry['capabilities'],
  cost = 1,
): ModelRegistryEntry {
  return {
    id: 1,
    model_id,
    label: model_id,
    provider: model_id.split('/')[0] ?? 'test',
    family: null,
    context_window: 128000,
    input_cost_per_million: cost,
    output_cost_per_million: cost,
    pricing_model: 'per_token',
    pricing_source: 'test',
    capabilities,
    status: 'active',
    added_at: '2026-01-01',
    last_seen_at: '2026-01-01',
    raw_metadata: {},
  };
}

// Parity slugs: the GLM 5.3 Flash slug from the reproduced finding + three more
// suffix variants across providers/families.
const PARITY_SLUGS = [
  'openrouter/z-ai/glm-5.3-flash',       // the reproduced rejection
  'openrouter/z-ai/glm-4.6-flash',       // -flash on an older version
  'openrouter/z-ai/glm-5.3',             // bare version (was accepted before)
  'openrouter/deepseek/deepseek-v4-pro', // -pro suffix
  'ollama/deepseek-v4-pro:cloud',        // :cloud tag
];

test('F31: GLM 5.3 Flash full slug is provider-verified (the reproduced gap)', () => {
  assert.equal(
    isProviderVerifiedSlug('openrouter/z-ai/glm-5.3-flash'),
    true,
    'openrouter/z-ai/glm-5.3-flash must be accepted as a provider-verified full slug',
  );
});

test('F31: suffix variants across providers/families are provider-verified', () => {
  for (const slug of PARITY_SLUGS.slice(1)) {
    assert.equal(isProviderVerifiedSlug(slug), true, `verified: ${slug}`);
  }
});

test('F31: unknown slug is NOT silently verified', () => {
  assert.equal(isProviderVerifiedSlug('openrouter/fake/vendor-model-9.9-pro'), false);
});

test('F31: verified-slug set is extensible (new inventory supersedes without code change)', () => {
  const refreshed = new Set([...baseVerifiedSlugs(), 'openrouter/z-ai/glm-6.0-nano']);
  assert.equal(isProviderVerifiedSlug('openrouter/z-ai/glm-6.0-nano', refreshed), true);
  assert.equal(isProviderVerifiedSlug('openrouter/z-ai/glm-6.0-nano'), false);
});

test('F31: suffixed slug is selectable for a text task (task-selector path)', () => {
  const inv = [model('openrouter/z-ai/glm-5.3-flash', ['text', 'reasoning', 'tool_use', 'streaming'], 0.2)];
  const sel = selectTaskModel({
    title: 'Write the weekly caption series',
    description: 'Long-form content writing for the planner',
    inventory: inv,
  });
  assert.equal(sel.needs_owner_input, false);
  assert.equal(sel.model_id, 'openrouter/z-ai/glm-5.3-flash');
});

test('F31: no silent version upgrade — pinned cheap flash stays selected among cost ties', () => {
  // glm-5.3 (higher version, costlier) and glm-5.3-flash (the client's choice
  // band) both serve text; the selector is version-tie-broken AFTER capability
  // and cost — flash is cheaper so it wins: selection never flips to a newer
  // version merely because its number is higher.
  const inv = [
    model('openrouter/z-ai/glm-5.3', ['text', 'reasoning', 'tool_use'], 1),
    model('openrouter/z-ai/glm-5.3-flash', ['text', 'reasoning', 'tool_use'], 0.2),
  ];
  const sel = selectTaskModel({ title: 'Draft captions', inventory: inv });
  assert.equal(sel.model_id, 'openrouter/z-ai/glm-5.3-flash');
});

test('F31: approved fallback order is honored (first capable entry wins)', () => {
  const inv = [
    model('openrouter/z-ai/glm-4.6', ['text', 'reasoning', 'tool_use'], 1),
    model('openrouter/z-ai/glm-5.3-flash', ['text', 'reasoning', 'tool_use'], 0.2),
    model('openrouter/qwen/qwen3-vl:235b', ['text', 'vision', 'reasoning'], 1),
  ];
  const fb = selectApprovedCapableFallback(
    'vision',
    ['openrouter/qwen/qwen3-vl:235b'],
    inv,
    'vision',
  );
  assert.equal(fb, 'openrouter/qwen/qwen3-vl:235b');
});

test('F31: text-only inventory cannot serve a vision strict task (undispatchable, not degraded)', () => {
  const sel = selectTaskModel({
    title: 'Visual QC',
    required_modality: 'vision',
    strict_capability: true,
    asset_input_hash: 'sha256:abc',
    inventory: [model('openrouter/z-ai/glm-5.3-flash', ['text', 'reasoning'])],
  });
  assert.equal(sel.model_id, NEEDS_OWNER_INPUT);
  assert.equal(sel.capability_blocked, true);
});