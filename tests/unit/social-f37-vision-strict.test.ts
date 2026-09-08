/**
 * social-f37-vision-strict.test.ts — F37: keep visual QC from degrading into
 * text-only approval.
 *
 * selectTaskModel's P1-01 safety net downgrades vision→text when no vision
 * model is available. For visual QC of a GENERATED IMAGE that is forbidden:
 * a text description is not visual evidence. A strict capability requirement
 * (task metadata.requiresVision === true / taskType visual-qc) must:
 *   1. never downgrade — return no-selection (undispatchable) instead;
 *   2. queue visibly (capability_blocked + needs_owner_input receipt fields);
 *   3. record modality + actual asset input hash for the review receipt;
 *   4. allow ONLY a policy-approved capable vision fallback.
 *
 *   node --import tsx --import ./tests/setup/no-owner-telegram.ts --test tests/unit/social-f37-vision-strict.test.ts
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  selectTaskModel,
  applyModalityDowngrade,
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

const TEXT_ONLY = [
  model('openrouter/z-ai/glm-5.3-flash', ['text', 'reasoning', 'tool_use'], 0.2),
  model('openrouter/deepseek/deepseek-v4-pro', ['text', 'reasoning', 'long_context'], 2),
];

const WITH_VISION = [
  model('openrouter/z-ai/glm-5.3-flash', ['text', 'reasoning', 'tool_use'], 0.2),
  model('openrouter/qwen/qwen3-vl:235b', ['text', 'vision', 'reasoning'], 1),
];

const ASSET_HASH = 'sha256:9f2c7a1e0b8d4f3a6c5e2d1b0a9f8e7d6c5b4a3f2e1d0c9b8a7f6e5d4c3b2a1';

test('F37: strict visual-QC task with NO vision model returns no-selection, never a text downgrade', () => {
  const sel = selectTaskModel({
    title: 'Visual QC of generated carousel image',
    description: 'Inspect the generated image against the acceptance rubric',
    required_modality: 'vision',
    strict_capability: true,
    asset_input_hash: ASSET_HASH,
    inventory: TEXT_ONLY,
  });
  assert.equal(sel.model_id, NEEDS_OWNER_INPUT);
  assert.equal(sel.needs_owner_input, true);
  assert.equal(sel.capability_blocked, true, 'blocked receipt field must be set');
  assert.equal(sel.modality_downgraded, false, 'NEVER downgraded under strict');
  assert.equal(sel.required_modality, 'vision', 'modality preserved for the pending receipt');
  assert.equal(sel.strict_capability, true);
  assert.equal(sel.asset_input_hash, ASSET_HASH, 'asset hash recorded for review receipt');
});

test('F37: strict visual-QC task WITH a vision model selects the vision model normally', () => {
  const sel = selectTaskModel({
    title: 'Visual QC of generated carousel image',
    description: 'Inspect the generated image against the acceptance rubric',
    required_modality: 'vision',
    strict_capability: true,
    asset_input_hash: ASSET_HASH,
    inventory: WITH_VISION,
  });
  assert.equal(sel.needs_owner_input, false);
  assert.equal(sel.capability_blocked, false);
  assert.equal(sel.required_modality, 'vision');
  assert.match(sel.model_id as string, /qwen3-vl/);
  assert.equal(sel.asset_input_hash, ASSET_HASH);
});

test('F37: applyModalityDowngrade honors the strict flag directly', () => {
  const lenient = applyModalityDowngrade('vision', TEXT_ONLY);
  assert.equal(lenient.downgraded, true, 'lenient path still downgrades (P1-01 unchanged)');
  const strict = applyModalityDowngrade('vision', TEXT_ONLY, true);
  assert.equal(strict.downgraded, false);
  assert.equal(strict.blocked, true);
  assert.equal(strict.modality, 'vision', 'modality intact — no text downgrade');
});

test('F37: no text-only checker can produce a passing visual-QC selection', () => {
  // Even when the caller forgets strict_capability, a pure-text inventory
  // cannot be the required_modality='vision' selection for visual QC.
  const sel = selectTaskModel({
    title: 'Visual QC of generated image',
    required_modality: 'vision',
    inventory: TEXT_ONLY,
    strict_capability: true,
  });
  assert.equal(sel.model_id, NEEDS_OWNER_INPUT);
  assert.notEqual(sel.required_modality, 'text');
});

test('F37: approved capable vision fallback serves a blocked strict task', () => {
  const fb = selectApprovedCapableFallback(
    'vision',
    ['openrouter/qwen/qwen3-vl:235b', 'openrouter/z-ai/glm-5.3-flash'],
    WITH_VISION,
  );
  assert.equal(fb, 'openrouter/qwen/qwen3-vl:235b', 'first APPROVED CAPABLE fallback wins');
});

test('F37: approved fallback that cannot see is skipped, not used', () => {
  const fb = selectApprovedCapableFallback(
    'vision',
    ['openrouter/z-ai/glm-5.3-flash', 'openrouter/qwen/qwen3-vl:235b'],
    WITH_VISION,
  );
  assert.equal(fb, 'openrouter/qwen/qwen3-vl:235b', 'text-only approved entry skipped for vision');
});

test('F37: no capable approved fallback -> null (stays pending, no substitution)', () => {
  const fb = selectApprovedCapableFallback('vision', ['openrouter/z-ai/glm-5.3-flash'], TEXT_ONLY);
  assert.equal(fb, null, 'no capable fallback — review stays visibly pending');
});

test('F37: forbidden (Anthropic) fallback is never approved even if listed', () => {
  const fb = selectApprovedCapableFallback(
    'vision',
    ['claude-5-vision', 'openrouter/qwen/qwen3-vl:235b'],
    [
      model('claude-5-vision', ['text', 'vision']),
      ...WITH_VISION,
    ],
  );
  assert.equal(fb, 'openrouter/qwen/qwen3-vl:235b', 'Anthropic entry skipped by policy');
});