/**
 * Regression test for the Kie.ai connector capability tags (Fix #3, v4.1.6).
 *
 * The original bug: kie.ts tagged Veo / Runway / Kling video models as
 * `streaming` and Suno audio models as `audio_input`. Those tags do not match
 * the Studio `CAPABILITY_FOR_KIND` map, so KIE models never appeared under the
 * Video / Audio tabs no matter the keys. They must be `video_generation` and
 * `audio_generation` respectively.
 *
 * U50/H+L.8 update: this used to drive the connector's offline curated
 * fallback (stub `fetch` to fail so `fetchModels` fell through to
 * CURATED_MODELS) to exercise `inferCapabilities()`. That fallback-on-failure
 * path was the exact swallow U50 closes (a dead key silently re-stamping a
 * hardcoded catalog `active` — see u50-swallow-audit-all-connectors.test.ts),
 * so `fetchModels()` no longer falls through to CURATED_MODELS on a failed
 * live call at all. This test now drives the SAME `inferCapabilities()` logic
 * through a mocked SUCCESSFUL live `/models` response — the only path
 * `fetchModels()` takes post-fix — so the video/audio tag regression stays
 * covered against real (live-shaped) data instead of the retired fallback.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { fetchModels } from '../../src/lib/model-providers/kie';

/** Return a live-shaped /models response with no `capabilities` field on any
 * row, forcing normalizeRow() through inferCapabilities(id) — the same
 * inference path the retired curated fallback used to exercise. */
async function withLiveModelsResponse<T>(rows: Array<{ id: string }>, fn: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ data: rows }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

test('KIE live catalog tags video families video_generation, audio families audio_generation', async () => {
  const models = await withLiveModelsResponse(
    [{ id: 'veo-3' }, { id: 'veo-3-fast' }, { id: 'runway-gen3' }, { id: 'suno-v4' }, { id: 'flux-1.1-pro' }],
    () => fetchModels('kie-fake-key')
  );
  assert.ok(models.length > 0, 'the live response must resolve to a non-empty catalog');

  const allCaps = new Set(models.flatMap((m) => m.capabilities));

  // The two correct media tags must be present...
  assert.ok(allCaps.has('video_generation'), 'KIE must emit at least one video_generation model (Veo/Runway)');
  assert.ok(allCaps.has('audio_generation'), 'KIE must emit at least one audio_generation model (Suno)');

  // ...and the two buggy tags must be entirely gone.
  assert.ok(!allCaps.has('streaming' as never), 'KIE must NOT tag video models as streaming');
  assert.ok(!allCaps.has('audio_input' as never), 'KIE must NOT tag audio models as audio_input');

  // Spot-check specific families resolve to the right capability.
  const veo = models.find((m) => m.model_id.includes('veo'));
  assert.ok(veo, 'live catalog must include a Veo model');
  assert.ok(veo!.capabilities.includes('video_generation'), 'Veo must be video_generation');

  const runway = models.find((m) => m.model_id.includes('runway'));
  assert.ok(runway, 'live catalog must include a Runway model');
  assert.ok(runway!.capabilities.includes('video_generation'), 'Runway must be video_generation');

  const suno = models.find((m) => m.model_id.includes('suno'));
  assert.ok(suno, 'live catalog must include a Suno model');
  assert.ok(suno!.capabilities.includes('audio_generation'), 'Suno must be audio_generation');
});

test('[U50] KIE fetchModels: a live-call failure PROPAGATES — never falls through to CURATED_MODELS', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, statusText: 'Unauthorized' })) as typeof fetch;
  try {
    await assert.rejects(
      () => fetchModels('kie-bad-key'),
      /failed: 401/,
      'a 401 must propagate as a thrown error, never resolve to the curated fallback'
    );
  } finally {
    globalThis.fetch = original;
  }
});
