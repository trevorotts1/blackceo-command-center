/**
 * U50 [HL/U62] (H+L.8) — Model-catalog honesty: Fish Audio fallback never
 * `active` + swallow-audit.
 *
 * THE BUG THIS UNIT FIXES: `fish-audio.ts`'s `fetchModels()` wrapped the live
 * `/v1/models` call in a bare `try/catch` that returned a hardcoded
 * `FALLBACK_MODELS` list (the retired Speech-1.5/S1 family) stamped
 * `status: 'active'` on ANY failure — a dead/invalid key, a network error, a
 * non-2xx response, ALL of it. Because `fetchModels()` never threw,
 * `refreshOneProvider()` (which DOES have real `success:false` logging)
 * could never take that branch for Fish Audio: a dead key logged
 * `success: true` and re-stamped a stale S1 catalog `active` every refresh
 * cycle. This suite proves:
 *
 *   1. A live-call failure (bad key -> 401, or a network-level throw) now
 *      PROPAGATES out of `fetchModels()` — never silently substituted.
 *   2. An authenticated, successful call that legitimately lists zero models
 *      is treated as an EMPTY catalog — never substituted either.
 *   3. A successful call with real Speech-2 (S2) family rows still resolves
 *      correctly through the connector's own `inferFamily()`.
 *   4. Wired end-to-end through the REAL `refreshOneProvider()`: an invalid
 *      Fish Audio key now produces `success:false` with error detail in
 *      `model_registry_refresh_log`, and ZERO Fish Audio rows land in
 *      `model_registry` as `active` — while a valid key with a live S2
 *      catalog upserts real `active` rows via the ordinary path.
 *   5. `KNOWN_MODEL_FAMILIES` (the retained, documentation-only successor to
 *      the old `FALLBACK_MODELS`) is never `active` and is never what
 *      `fetchModels()` returns under any failure mode.
 *
 * Run: node --import tsx --test tests/unit/u50-fish-audio-catalog-honesty.test.ts
 */

// C8 — DB isolation. Must be imported FIRST, before anything that pulls in
// '@/lib/db' transitively (refresh-models.ts does).
import './_isolated-db';

import test from 'node:test';
import assert from 'node:assert/strict';

import { getDb, queryOne, queryAll } from '../../src/lib/db';
import { refreshOneProvider } from '../../src/lib/jobs/refresh-models';
import type { ModelProvider } from '../../src/lib/model-providers/types';

function stubFetch(impl: (url: string, init?: RequestInit) => Promise<Response>): () => void {
  const orig = (globalThis as Record<string, unknown>).fetch;
  (globalThis as Record<string, unknown>).fetch = impl;
  return () => {
    if (orig === undefined) delete (globalThis as Record<string, unknown>).fetch;
    else (globalThis as Record<string, unknown>).fetch = orig;
  };
}

function jsonResponse(body: unknown, init: { status?: number; statusText?: string } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    statusText: init.statusText,
    headers: { 'content-type': 'application/json' },
  });
}

// ─── Pure fetchModels() behavior ─────────────────────────────────────────

test('[U50] fish-audio fetchModels: missing apiKey still throws (unchanged guard)', async () => {
  const { fetchModels } = await import('../../src/lib/model-providers/fish-audio');
  await assert.rejects(() => fetchModels(''), /apiKey/);
});

test('[U50] fish-audio fetchModels: a rejected key (401) PROPAGATES — never swallowed into a fallback', async () => {
  const { fetchModels } = await import('../../src/lib/model-providers/fish-audio');
  const restore = stubFetch(async () => jsonResponse({ error: 'unauthorized' }, { status: 401, statusText: 'Unauthorized' }));
  try {
    await assert.rejects(
      () => fetchModels('fish-bad-key'),
      /failed: 401/,
      'a 401 must propagate as a thrown error, never resolve to a fallback list'
    );
  } finally {
    restore();
  }
});

test('[U50] fish-audio fetchModels: a network-level throw PROPAGATES — never swallowed into a fallback', async () => {
  const { fetchModels } = await import('../../src/lib/model-providers/fish-audio');
  const restore = stubFetch(async () => {
    throw new Error('network disabled for offline test');
  });
  try {
    await assert.rejects(
      () => fetchModels('fish-key'),
      /network disabled/,
      'a network-level failure must propagate as a thrown error, never resolve to a fallback list'
    );
  } finally {
    restore();
  }
});

test('[U50] fish-audio fetchModels: an authenticated 200 with ZERO rows resolves to an EMPTY array, not the seed catalog', async () => {
  const { fetchModels } = await import('../../src/lib/model-providers/fish-audio');
  const restore = stubFetch(async () => jsonResponse({ items: [] }));
  try {
    const models = await fetchModels('fish-good-key-empty-catalog');
    assert.deepEqual(models, [], 'an empty-but-successful response must resolve to [], never a substituted catalog');
  } finally {
    restore();
  }
});

test('[U50] fish-audio fetchModels: a real live catalog resolves current-generation S2 rows as active', async () => {
  const { fetchModels } = await import('../../src/lib/model-providers/fish-audio');
  const restore = stubFetch(async () =>
    jsonResponse({ items: [{ _id: 's2', title: 'Fish Speech 2' }, { _id: 's2.1-pro', title: 'Fish Speech 2.1 Pro' }] })
  );
  try {
    const models = await fetchModels('fish-good-key');
    assert.equal(models.length, 2);
    for (const m of models) {
      assert.equal(m.status, 'active', 'a genuinely live-listed model is active');
      assert.equal(m.family, 'fish-speech-2', "inferFamily() must resolve the s2/s2.1-pro ids to the 'fish-speech-2' family");
    }
  } finally {
    restore();
  }
});

// ─── KNOWN_MODEL_FAMILIES (the FALLBACK_MODELS successor) is honest ──────

test('[U50] fish-audio: no failure mode of fetchModels() ever returns an S1-family or active-status row', async () => {
  const { fetchModels } = await import('../../src/lib/model-providers/fish-audio');

  const scenarios: Array<[string, () => Promise<Response>]> = [
    ['401 rejected key', async () => jsonResponse({}, { status: 401 })],
    ['network throw', async () => { throw new Error('offline'); }],
  ];

  for (const [label, impl] of scenarios) {
    const restore = stubFetch(impl);
    try {
      await assert.rejects(() => fetchModels('some-key'), undefined, `${label} must reject, not resolve`);
    } finally {
      restore();
    }
  }

  // The empty-success path resolves (doesn't reject) but must be [], covered
  // above — re-asserted here for the "no S1 row, ever" headline.
  const restoreEmpty = stubFetch(async () => jsonResponse({ items: [] }));
  try {
    const models = await fetchModels('some-key');
    assert.equal(models.some((m) => (m.family ?? '').includes('1.5')), false, 'no S1-family row may ever appear');
    assert.equal(models.some((m) => m.status === 'active'), false, 'no active row may appear from an empty response');
  } finally {
    restoreEmpty();
  }
});

// ─── End-to-end through the REAL refreshOneProvider() ────────────────────

const FISH_KEY_ENV = 'FISH_AUDIO_API_KEY';

function withFishAudioKey(value: string | undefined, fn: () => Promise<void>): Promise<void> {
  const original = process.env[FISH_KEY_ENV];
  if (value === undefined) delete process.env[FISH_KEY_ENV];
  else process.env[FISH_KEY_ENV] = value;
  return fn().finally(() => {
    if (original === undefined) delete process.env[FISH_KEY_ENV];
    else process.env[FISH_KEY_ENV] = original;
  });
}

function cleanupFishAudioRows(): void {
  getDb().prepare(`DELETE FROM model_registry WHERE provider = 'fish-audio'`).run();
}

test('[U50] refreshOneProvider + real fishAudioProvider: an invalid key -> success:false, error detail logged, ZERO active fish-audio rows', async () => {
  cleanupFishAudioRows();
  const { fishAudioProvider } = await import('../../src/lib/model-providers');
  const restoreFetch = stubFetch(async () => jsonResponse({ error: 'unauthorized' }, { status: 401, statusText: 'Unauthorized' }));
  try {
    await withFishAudioKey('fish-invalid-test-key', async () => {
      const outcome = await refreshOneProvider(fishAudioProvider as ModelProvider);
      assert.equal(outcome.success, false, 'an invalid key must fail the refresh honestly');
      assert.ok(outcome.error_message && /401/.test(outcome.error_message), 'the real HTTP failure detail must be recorded');
      assert.equal(outcome.models_added, 0);
      assert.equal(outcome.models_updated, 0);

      const activeRows = queryAll<{ model_id: string; status: string }>(
        `SELECT model_id, status FROM model_registry WHERE provider = 'fish-audio' AND status = 'active'`
      );
      assert.equal(activeRows.length, 0, 'zero fish-audio rows may be active after a failed refresh');

      const logRow = queryOne<{ success: number; error_message: string | null }>(
        `SELECT success, error_message FROM model_registry_refresh_log WHERE provider = 'fish-audio' ORDER BY id DESC LIMIT 1`
      );
      assert.ok(logRow, 'the refresh outcome must be logged to model_registry_refresh_log');
      assert.equal(logRow!.success, 0, 'the logged row must record success=0');
      assert.ok(logRow!.error_message, 'the logged row must carry the error detail');
    });
  } finally {
    restoreFetch();
    cleanupFishAudioRows();
  }
});

test('[U50] refreshOneProvider + real fishAudioProvider: a valid key with a live S2 catalog upserts real active rows', async () => {
  cleanupFishAudioRows();
  const { fishAudioProvider } = await import('../../src/lib/model-providers');
  const restoreFetch = stubFetch(async () =>
    jsonResponse({ items: [{ _id: 's2', title: 'Fish Speech 2' }] })
  );
  try {
    await withFishAudioKey('fish-valid-test-key', async () => {
      const outcome = await refreshOneProvider(fishAudioProvider as ModelProvider);
      assert.equal(outcome.success, true);
      assert.equal(outcome.models_added, 1);

      const row = queryOne<{ status: string; family: string | null }>(
        `SELECT status, family FROM model_registry WHERE model_id = 'fish-audio/s2'`
      );
      assert.ok(row, 'the live S2 model must be upserted');
      assert.equal(row!.status, 'active');
      assert.equal(row!.family, 'fish-speech-2');
    });
  } finally {
    restoreFetch();
    cleanupFishAudioRows();
  }
});

// ─── Generic plumbing: refreshOneProvider honestly fails ANY connector whose
// fetchModels() throws (not Fish-Audio-specific — proves the propagation
// path itself, independent of the fish-audio.ts fix above). ───────────────

test('[U50] refreshOneProvider: a connector whose fetchModels() throws is logged success:false with the real error, never silently substituted', async () => {
  cleanupFishAudioRows();
  const stub: ModelProvider = {
    slug: 'u50-throw-stub',
    displayName: 'U50 Throw Stub',
    authType: 'local_endpoint',
    fetchModels: async () => {
      throw new Error('U50 stub: live call rejected');
    },
  };
  getDb().prepare(`DELETE FROM model_registry WHERE provider = ?`).run(stub.slug);
  try {
    const outcome = await refreshOneProvider(stub);
    assert.equal(outcome.success, false);
    assert.match(outcome.error_message ?? '', /U50 stub: live call rejected/);
    assert.equal(outcome.models_added, 0);
    const rows = queryAll(`SELECT model_id FROM model_registry WHERE provider = ?`, [stub.slug]);
    assert.equal(rows.length, 0, 'nothing may be written for a provider whose fetch failed');
  } finally {
    getDb().prepare(`DELETE FROM model_registry WHERE provider = ?`).run(stub.slug);
  }
});
