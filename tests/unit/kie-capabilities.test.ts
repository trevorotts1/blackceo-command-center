/**
 * Regression test for the Kie.ai connector capability tags (Fix #3, v4.1.6).
 *
 * The original bug: kie.ts tagged Veo / Runway / Kling video models as
 * `streaming` and Suno audio models as `audio_input`. Those tags do not match
 * the Studio `CAPABILITY_FOR_KIND` map, so KIE models never appeared under the
 * Video / Audio tabs no matter the keys. They must be `video_generation` and
 * `audio_generation` respectively.
 *
 * This drives the connector's OFFLINE curated fallback (we stub `fetch` to fail
 * so `fetchModels` falls through to CURATED_MODELS) and asserts the tags.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { fetchModels } from '../../src/lib/model-providers/kie';

/** Force the offline curated fallback by making the /models fetch fail. */
async function withFailingFetch<T>(fn: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error('network disabled for offline test');
  }) as typeof fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

test('KIE offline catalog tags video families video_generation, audio families audio_generation', async () => {
  const models = await withFailingFetch(() => fetchModels('kie-fake-key'));
  assert.ok(models.length > 0, 'curated fallback must return models');

  const allCaps = new Set(models.flatMap((m) => m.capabilities));

  // The two correct media tags must be present...
  assert.ok(allCaps.has('video_generation'), 'KIE must emit at least one video_generation model (Veo/Runway)');
  assert.ok(allCaps.has('audio_generation'), 'KIE must emit at least one audio_generation model (Suno)');

  // ...and the two buggy tags must be entirely gone.
  assert.ok(!allCaps.has('streaming' as never), 'KIE must NOT tag video models as streaming');
  assert.ok(!allCaps.has('audio_input' as never), 'KIE must NOT tag audio models as audio_input');

  // Spot-check specific families resolve to the right capability.
  const veo = models.find((m) => m.model_id.includes('veo'));
  assert.ok(veo, 'curated catalog must include a Veo model');
  assert.ok(veo!.capabilities.includes('video_generation'), 'Veo must be video_generation');

  const runway = models.find((m) => m.model_id.includes('runway'));
  assert.ok(runway, 'curated catalog must include a Runway model');
  assert.ok(runway!.capabilities.includes('video_generation'), 'Runway must be video_generation');

  const suno = models.find((m) => m.model_id.includes('suno'));
  assert.ok(suno, 'curated catalog must include a Suno model');
  assert.ok(suno!.capabilities.includes('audio_generation'), 'Suno must be audio_generation');
});
