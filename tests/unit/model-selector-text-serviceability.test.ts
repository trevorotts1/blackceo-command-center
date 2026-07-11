/**
 * model-selector-text-serviceability.test.ts — FM-6c + NULL-model fallback (pure).
 *
 * FM-6c: a pure-TTS model (e.g. gpt-4o-mini-tts, capability=audio_generation only)
 * must NOT be selectable as the reasoning model for a text/presentations task —
 * that was the wrong-field model_id population the board surfaced.
 *
 * NULL-model fallback: a box with real models always resolves a sovereign default
 * for a text task, so dispatch is never blocked merely because an agent row has a
 * NULL model.
 *
 *   node --import tsx --test tests/unit/model-selector-text-serviceability.test.ts
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  selectTaskModel,
  resolveSovereignDefault,
  canServeTextTask,
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

const TTS = model('openai/gpt-4o-mini-tts', ['audio_generation'], 0.1); // cheapest
const REASONER = model('ollama/kimi-k2.6:cloud', ['text', 'reasoning', 'long_context'], 2);

test('canServeTextTask rejects a pure-TTS model and accepts a language model', () => {
  assert.equal(canServeTextTask(TTS), false);
  assert.equal(canServeTextTask(REASONER), true);
  // MODEL-06: an untyped registry entry (no capabilities) is NO LONGER assumed
  // text-capable — every real connector emits `text` for a language model, so an
  // empty capability set is a media-smuggle / untyped row that fails closed.
  assert.equal(canServeTextTask(model('legacy/model', [])), false);
  // Pure embeddings model also cannot serve a text task.
  assert.equal(canServeTextTask(model('test/embed', ['embeddings'])), false);
});

test('FM-6c: a text task never resolves to the pure-TTS model even when it is cheapest', () => {
  // Plain-prose wording with NO vision/audio/image keywords so the modality
  // classifier resolves `text` (the path where the TTS leak occurred).
  const sel = selectTaskModel({
    title: 'Write the quarterly business plan narrative',
    description: 'Draft the executive prose and section outline in plain text.',
    department: 'presentations',
    inventory: [TTS, REASONER],
  });
  assert.equal(sel.required_modality, 'text', 'precondition: classified as a text task');
  assert.notEqual(sel.model_id, 'openai/gpt-4o-mini-tts', 'TTS model must not be picked for a text task');
  assert.equal(sel.model_id, 'ollama/kimi-k2.6:cloud');
});

test('FM-6c: a box that ONLY has a TTS model yields no text candidate (owner input), never the TTS model', () => {
  const sel = selectTaskModel({
    title: 'Draft the executive summary',
    description: 'Plain text reasoning task.',
    department: 'presentations',
    inventory: [TTS],
  });
  assert.equal(sel.model_id, NEEDS_OWNER_INPUT);
  assert.equal(sel.needs_owner_input, true);
});

test('NULL-model fallback: a real text model resolves as the sovereign default for a text task', () => {
  const def = resolveSovereignDefault([TTS, REASONER], 'text');
  assert.equal(def, 'ollama/kimi-k2.6:cloud', 'sovereign default must skip the TTS model and pick the language model');
});
