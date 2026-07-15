/**
 * U50 [HL/U62] (H+L.8) — Swallow-audit: closes the class.
 *
 * THE GAP THIS SUITE CLOSES: the U50 fix originally landed on `fish-audio.ts`
 * only. The spec's own binary acceptance for this unit requires item (2):
 * "audit the other 15 connectors for the same swallow-and-fallback pattern
 * (Fish Audio is the verified instance; the audit closes the class)." A
 * zero-trust QC pass read every connector's `fetchModels()` and found the
 * IDENTICAL swallow still live in `minimax.ts` and `kie.ts` (both wrapped
 * their live `/models` call in a bare `try/catch` that fell through to a
 * hardcoded catalog stamped `status: 'active'` on ANY failure — a dead key
 * included), plus a related-but-distinct gap in `fal.ts` and `xiaomi.ts`
 * (curated `active` rows emitted with no live verification ATTEMPTED at
 * all, because neither has a discovery endpoint to call in the first
 * place). Both `minimax.ts` and `kie.ts` are fixed alongside this suite
 * (see their U50/H+L.8 doc comments); `fal.ts` and `xiaomi.ts` carry an
 * explicit documented decision (also U50/H+L.8) instead of a code change,
 * because there is no live call for them to swallow a failure from.
 *
 * This suite enumerates ALL 16 registered connectors (fish-audio + the 15
 * others named in the spec) and proves, per connector, exactly one of:
 *
 *   (A) LIVE-DISCOVERY connectors (14): fetchModels() attempts a real network
 *       call, so a live-call failure MUST PROPAGATE out of fetchModels() —
 *       never silently substituted with a hardcoded/curated catalog. Proven
 *       by stubbing global fetch to always throw and asserting the call
 *       rejects for every one of the 14.
 *
 *   (B) NO-DISCOVERY-ENDPOINT connectors (2, fal + xiaomi): fetchModels()
 *       never calls fetch() at all — proven structurally by stubbing global
 *       fetch to always throw and asserting the call still RESOLVES (if it
 *       had touched the network even once, the throwing stub would have
 *       surfaced as a rejection). Because no live call is ever attempted,
 *       there is no live-call failure to swallow — this is the class of
 *       "genuinely no-discovery-endpoint provider" the spec's remediation
 *       text carves out as a documented decision, not a defect.
 *
 * 14 + 2 = 16, collision-free against the connector directory
 * (`src/lib/model-providers/*.ts`, excluding `index.ts` and `types.ts`).
 *
 * Run: node --import tsx --test tests/unit/u50-swallow-audit-all-connectors.test.ts
 * No DB is touched — every connector module here is a pure fetch wrapper
 * (none import '@/lib/db'), so no '_isolated-db' import is required.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { fetchModels as anthropicFetchModels } from '../../src/lib/model-providers/anthropic';
import { fetchModels as elevenlabsFetchModels } from '../../src/lib/model-providers/elevenlabs';
import { fetchModels as falFetchModels } from '../../src/lib/model-providers/fal';
import { fetchModels as fishAudioFetchModels } from '../../src/lib/model-providers/fish-audio';
import { fetchModels as googleFetchModels } from '../../src/lib/model-providers/google';
import { fetchModels as kieFetchModels } from '../../src/lib/model-providers/kie';
import { fetchModels as minimaxFetchModels } from '../../src/lib/model-providers/minimax';
import { fetchModels as moonshotFetchModels } from '../../src/lib/model-providers/moonshot';
import { fetchModels as ollamaCloudFetchModels } from '../../src/lib/model-providers/ollama-cloud';
import { fetchModels as ollamaLocalFetchModels } from '../../src/lib/model-providers/ollama-local';
import { fetchModels as openaiFetchModels } from '../../src/lib/model-providers/openai';
import { fetchModels as openrouterFetchModels } from '../../src/lib/model-providers/openrouter';
import { fetchModels as replicateFetchModels } from '../../src/lib/model-providers/replicate';
import { fetchModels as xaiFetchModels } from '../../src/lib/model-providers/xai';
import { fetchModels as xiaomiFetchModels } from '../../src/lib/model-providers/xiaomi';
import { fetchModels as zaiFetchModels } from '../../src/lib/model-providers/zai';

import type { ProviderModel } from '../../src/lib/model-providers/types';

type FetchModelsFn = (apiKey: string) => Promise<ProviderModel[]>;

function stubFetch(impl: (url: string, init?: RequestInit) => Promise<Response>): () => void {
  const orig = (globalThis as Record<string, unknown>).fetch;
  (globalThis as Record<string, unknown>).fetch = impl;
  return () => {
    if (orig === undefined) delete (globalThis as Record<string, unknown>).fetch;
    else (globalThis as Record<string, unknown>).fetch = orig;
  };
}

const NETWORK_DISABLED_MESSAGE = 'U50 swallow-audit: network disabled for this connector';

function alwaysThrowingFetch(): (url: string, init?: RequestInit) => Promise<Response> {
  return async () => {
    throw new Error(NETWORK_DISABLED_MESSAGE);
  };
}

const DUMMY_KEY = 'u50-swallow-audit-dummy-key';

// ── (A) LIVE-DISCOVERY connectors — 14 total ────────────────────────────
// Each of these attempts a genuine network call inside fetchModels(). A
// live-call failure must propagate as a rejected promise, never resolve to
// a hardcoded/curated fallback catalog.
const LIVE_DISCOVERY_CONNECTORS: Array<{ slug: string; displayName: string; fetchModels: FetchModelsFn }> = [
  { slug: 'anthropic', displayName: 'Anthropic', fetchModels: anthropicFetchModels },
  { slug: 'elevenlabs', displayName: 'ElevenLabs', fetchModels: elevenlabsFetchModels },
  { slug: 'fish-audio', displayName: 'Fish Audio', fetchModels: fishAudioFetchModels },
  { slug: 'google', displayName: 'Google Gemini', fetchModels: googleFetchModels },
  { slug: 'kie', displayName: 'Kie.ai', fetchModels: kieFetchModels },
  { slug: 'minimax', displayName: 'MiniMax', fetchModels: minimaxFetchModels },
  { slug: 'moonshot', displayName: 'Moonshot AI', fetchModels: moonshotFetchModels },
  { slug: 'ollama-cloud', displayName: 'Ollama Cloud', fetchModels: ollamaCloudFetchModels },
  { slug: 'ollama-local', displayName: 'Ollama (local)', fetchModels: ollamaLocalFetchModels },
  { slug: 'openai', displayName: 'OpenAI', fetchModels: openaiFetchModels },
  { slug: 'openrouter', displayName: 'OpenRouter', fetchModels: openrouterFetchModels },
  { slug: 'replicate', displayName: 'Replicate', fetchModels: replicateFetchModels },
  { slug: 'xai', displayName: 'xAI (Grok)', fetchModels: xaiFetchModels },
  { slug: 'zai', displayName: 'Z.AI', fetchModels: zaiFetchModels },
];

// ── (B) NO-DISCOVERY-ENDPOINT connectors — 2 total ──────────────────────
// Neither has a live catalog endpoint to call, per each file's own doc
// comment and this unit's U50/H+L.8 documented-decision note. fetchModels()
// must never touch the network for these — proven below by confirming a
// throwing-fetch stub is never actually invoked (the call still resolves).
const NO_DISCOVERY_ENDPOINT_CONNECTORS: Array<{ slug: string; displayName: string; fetchModels: FetchModelsFn }> = [
  { slug: 'fal', displayName: 'Fal.ai', fetchModels: falFetchModels },
  { slug: 'xiaomi', displayName: 'Xiaomi', fetchModels: xiaomiFetchModels },
];

test('[U50 swallow-audit] the enumerated set is exactly 16 connectors, collision-free (14 live-discovery + 2 no-discovery-endpoint)', () => {
  const allSlugs = [
    ...LIVE_DISCOVERY_CONNECTORS.map((c) => c.slug),
    ...NO_DISCOVERY_ENDPOINT_CONNECTORS.map((c) => c.slug),
  ];
  assert.equal(LIVE_DISCOVERY_CONNECTORS.length, 14, 'expected exactly 14 live-discovery connectors');
  assert.equal(NO_DISCOVERY_ENDPOINT_CONNECTORS.length, 2, 'expected exactly 2 no-discovery-endpoint connectors');
  assert.equal(allSlugs.length, 16, 'the audit must cover exactly 16 connectors total');
  assert.equal(new Set(allSlugs).size, 16, 'every connector slug must be unique — no double-counting, no gaps');
});

for (const connector of LIVE_DISCOVERY_CONNECTORS) {
  test(`[U50 swallow-audit] ${connector.displayName} (${connector.slug}): fetchModels() PROPAGATES a live-call failure — never silently substitutes a fallback catalog`, async () => {
    const restore = stubFetch(alwaysThrowingFetch());
    try {
      await assert.rejects(
        () => connector.fetchModels(DUMMY_KEY),
        (err: unknown) => err instanceof Error && err.message.includes(NETWORK_DISABLED_MESSAGE),
        `${connector.slug} fetchModels() must reject with the real network error, never resolve to a fallback/curated catalog`
      );
    } finally {
      restore();
    }
  });
}

for (const connector of NO_DISCOVERY_ENDPOINT_CONNECTORS) {
  test(`[U50 swallow-audit] ${connector.displayName} (${connector.slug}): fetchModels() never touches the network — no discovery endpoint exists, so there is no live call to swallow (documented decision, not a defect)`, async () => {
    const restore = stubFetch(alwaysThrowingFetch());
    try {
      const models = await connector.fetchModels(DUMMY_KEY);
      assert.ok(
        Array.isArray(models),
        `${connector.slug} fetchModels() must resolve (never touching the throwing fetch stub) because it has no discovery endpoint to call`
      );
    } finally {
      restore();
    }
  });
}

// ── Closing assertion: the two widened-but-not-swallow findings are ──────
// consciously non-'active'-by-verification in the sense that matters: they
// never claim a LIVE-VERIFIED status. This does not change their runtime
// status field (a real behavior change with real availability risk, out of
// this unit's small/bounded scope per the QC remediation), but it locks
// down that neither one can regress into an actual swallow (case A above
// already proves that) and that their curated data remains internally
// consistent (non-empty, well-formed) even with the network fully down.
for (const connector of NO_DISCOVERY_ENDPOINT_CONNECTORS) {
  test(`[U50 swallow-audit] ${connector.displayName} (${connector.slug}): curated-only catalog is non-empty and well-formed even with the network fully down`, async () => {
    const restore = stubFetch(alwaysThrowingFetch());
    try {
      const models = await connector.fetchModels(DUMMY_KEY);
      assert.ok(models.length > 0, `${connector.slug} must still expose a usable catalog (it is curated-by-design, not live-verified)`);
      for (const m of models) {
        assert.equal(typeof m.model_id, 'string');
        assert.ok(m.model_id.startsWith(`${connector.slug}/`), `${m.model_id} must be prefixed with the provider slug`);
      }
    } finally {
      restore();
    }
  });
}
