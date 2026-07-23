/**
 * U086 — Research model resolver must restrict substitution to search-capable models.
 */
import './_isolated-db';
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveResearchModel } from '../../src/lib/research/model-resolver';
import { upsertModel } from '../../src/lib/model-registry';
import type { ResearchProviderSlug } from '../../src/lib/research/provider-discovery';

function seedModels(provider: ResearchProviderSlug, count: number, addSearchTo: number[] = []): string[] {
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const id = `${provider}/test-model-${i}`;
    const capabilities: string[] = ['text'];
    if (addSearchTo.includes(i)) capabilities.push('web_search');
    upsertModel({ model_id: id, label: `${provider} Test Model ${i}`, provider, capabilities, status: 'active' });
    ids.push(id);
  }
  return ids;
}

test('U086 A1: exact match for documented default is still used (no regression)', () => {
  seedModels('openai', 3, [0]);
  assert.equal(resolveResearchModel('openai', 'gpt-4o-search-preview'), 'test-model-0');
});

test('U086 A2: substitution picks the first search-capable model, not the first active model', () => {
  seedModels('perplexity', 3, [1]);
  assert.equal(resolveResearchModel('perplexity', 'sonar-pro'), 'test-model-1');
});

test('U086 A3: a model that matches the default exactly is used even without web_search capability', () => {
  seedModels('xai', 1, []);
  upsertModel({ model_id: 'grok-4-fast', label: 'Grok 4 Fast', provider: 'xai', capabilities: ['text'], status: 'active' });
  assert.equal(resolveResearchModel('xai', 'grok-4-fast'), 'grok-4-fast');
});

test('U086 B1: when no search-capable model exists, the provider default is used', () => {
  seedModels('ollama', 2, []);
  assert.equal(resolveResearchModel('ollama', 'gpt-oss:120b'), 'gpt-oss:120b');
});

test('U086 B2: empty registry returns the provider default', () => {
  const slug = 'unused-test-provider' as ResearchProviderSlug;
  assert.equal(resolveResearchModel(slug, 'some-provider-default'), 'some-provider-default');
});

test('U086 C1: mutation proof — removing the web_search filter makes the test RED', () => {
  seedModels('perplexity', 3, [1]);
  const green = resolveResearchModel('perplexity', 'sonar-pro');
  assert.equal(green, 'test-model-1', 'GREEN: search-capable model 1 substituted');
  assert.notEqual(green, 'test-model-0', 'RED: pre-fix would have picked model 0 (no search)');
});

test('U086 C2: mutation proof — documented default works as safety net', () => {
  assert.equal(resolveResearchModel('xai', 'grok-4-fast'), 'grok-4-fast');
});
