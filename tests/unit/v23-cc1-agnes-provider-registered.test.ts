/**
 * V23-CC1 — agnesProvider is registered in ALL_PROVIDERS (dead-import guard).
 *
 * THE BUG THIS LOCKS DOWN: `src/lib/model-providers/index.ts` imported
 * `agnesProvider` but never added it to `ALL_PROVIDERS`, so the weekly
 * `refreshModels()` pass (which defaults to `ALL_PROVIDERS`) never called
 * `agnesProvider.fetchModels` and no `agnes/*` row could ever reach
 * `model_registry` — dead code behind a live import. This suite proves:
 *
 *   1. `getProvider('agnes')` is defined and its `slug` is `'agnes'`
 *      (agnesProvider is registered in ALL_PROVIDERS);
 *   2. no duplicate slugs in `ALL_PROVIDERS`;
 *   3. the Anthropic gate still holds: when
 *      `process.env.ALLOW_ANTHROPIC_PROVIDER !== 'true'`, no entry has slug
 *      `'anthropic'` (this change must not weaken the sovereignty gate).
 *
 * No DB, no network: the barrel imports only type-only plus same-dir
 * connector modules (no '@/lib/db', no DATABASE_PATH), so no `_isolated-db`
 * import is needed. No fetch is stubbed because fetchModels is never called
 * here — only registry membership is asserted.
 *
 * Runs via the Node built-in test runner (`npm run test:unit`).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ALL_PROVIDERS,
  getProvider,
} from '../../src/lib/model-providers';

test('[V23-CC1] agnesProvider is registered: getProvider(\'agnes\') is defined with slug \'agnes\'', () => {
  const agnes = getProvider('agnes');
  assert.ok(agnes, 'agnesProvider must be in ALL_PROVIDERS — getProvider(\'agnes\') returned undefined');
  assert.equal(agnes.slug, 'agnes');
});

test('[V23-CC1] no duplicate slugs in ALL_PROVIDERS', () => {
  const slugs = ALL_PROVIDERS.map((p) => p.slug);
  const unique = new Set(slugs);
  assert.equal(unique.size, slugs.length, `duplicate slugs: ${slugs.filter((s, i) => slugs.indexOf(s) !== i).join(', ')}`);
});

test('[V23-CC1] Anthropic gate still holds: anthropic membership tracks ALLOW_ANTHROPIC_PROVIDER', () => {
  const slugs = ALL_PROVIDERS.map((p) => p.slug);
  if (process.env.ALLOW_ANTHROPIC_PROVIDER === 'true') {
    assert.ok(slugs.includes('anthropic'), 'operator opt-in: anthropic must be present when ALLOW_ANTHROPIC_PROVIDER=true');
  } else {
    assert.ok(!slugs.includes('anthropic'), 'anthropic must stay OUT of ALL_PROVIDERS when ALLOW_ANTHROPIC_PROVIDER is not true');
  }
});
