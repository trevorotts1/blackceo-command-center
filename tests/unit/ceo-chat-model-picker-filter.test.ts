/**
 * U60 / JM-U63f — ModelPicker's sovereignty filter.
 *
 * BINARY acceptance item 7: "ModelPicker fixture containing an
 * Anthropic-prefixed registry row renders WITHOUT it (unit test on the filter
 * + component fixture)". `filterModels()` is the PURE function the component
 * calls before ever rendering a row — testing it directly proves the filter
 * without mounting React. Pure — no DB, no isolated-db import needed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { filterModels } from '../../src/components/ceo-chat/filterModels';
import type { ModelOption } from '../../src/components/ceo-chat/types';

function opt(model_id: string): ModelOption {
  return { model_id, label: model_id, provider: 'test', context_window: 128_000, capabilities: ['text'] };
}

test('a fixture containing Anthropic-prefixed rows renders WITHOUT any of them', () => {
  const fixture: ModelOption[] = [
    opt('ollama-cloud/llama3.3:70b'),
    opt('anthropic/claude-3-5-sonnet'),
    opt('anthropic.claude-3-5-sonnet-20241022-v2:0'),
    opt('openrouter/anthropic/claude-3-opus'),
    opt('claude-5'),
    opt('claude-fable-5'),
    opt('openrouter/deepseek/deepseek-chat'),
  ];

  const filtered = filterModels(fixture);
  const ids = filtered.map((m) => m.model_id);

  assert.deepEqual(ids, ['ollama-cloud/llama3.3:70b', 'openrouter/deepseek/deepseek-chat']);
  for (const id of ids) {
    assert.ok(!/anthropic|claude-/i.test(id), `${id} must never be an Anthropic-family route`);
  }
});

test('an all-clean fixture passes through unchanged', () => {
  const fixture: ModelOption[] = [opt('ollama-cloud/llama3.3:70b'), opt('openrouter/qwen/qwen-2.5-72b')];
  assert.deepEqual(filterModels(fixture), fixture);
});
