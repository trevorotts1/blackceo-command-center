/**
 * model-capability-inference.test.ts — MODEL-07 (fake-vision models).
 *
 * THE BUG THIS LOCKS DOWN
 * -----------------------
 * `vision` in the model registry means IMAGE UNDERSTANDING — the model accepts
 * an image as INPUT. Both connectors inferred it with a bare substring test that
 * ran BEFORE they checked what kind of endpoint the model actually was:
 *
 *   openai.ts   `lower.includes('gpt-4o')`  → tagged `gpt-4o-mini-tts` as vision
 *   google.ts   `lower.includes('gemini')`  → tagged `gemini-2.5-flash-image` as vision
 *
 * `gpt-4o-mini-tts` is a TEXT-TO-SPEECH model. `gemini-2.5-flash-image` is an
 * image GENERATOR. Neither can read an image. They were the only two "active
 * vision models" in the live registry on the operator's box — both fake. Had the
 * dispatcher auto-selected one for a `modality=vision` task, it would have handed
 * image-comprehension work to a speech synthesizer; only the model-sovereignty
 * gate refusing to guess prevented it.
 *
 * These tests drive the REAL public path (`fetchModels` → `normalizeModel` →
 * `inferCapabilities`) against a stubbed provider response, so they pin the
 * behaviour callers actually get — not a private helper.
 *
 * Run: node --import tsx --test tests/unit/model-capability-inference.test.ts
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchModels as openaiFetchModels } from '../../src/lib/model-providers/openai';
import { fetchModels as googleFetchModels } from '../../src/lib/model-providers/google';
import type { ProviderModel } from '../../src/lib/model-providers/types';

const realFetch = globalThis.fetch;

/** Stub the network with a fixed JSON body for the next fetchModels() call. */
function stubFetch(body: unknown): void {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch;
}

function restoreFetch(): void {
  globalThis.fetch = realFetch;
}

const capsOf = (models: ProviderModel[], id: string): string[] => {
  const m = models.find((x) => x.model_id.endsWith(id));
  assert.ok(m, `model ${id} missing from normalized output`);
  return (m.capabilities ?? []) as string[];
};

// ─── OpenAI ──────────────────────────────────────────────────────────────────
test('MODEL-07/openai: a TTS model is NOT vision-capable', async () => {
  stubFetch({
    data: [
      { id: 'gpt-4o-mini-tts' },
      { id: 'tts-1' },
      { id: 'gpt-4o' },
      { id: 'gpt-4o-transcribe' },
      { id: 'dall-e-3' },
      { id: 'text-embedding-3-small' },
    ],
  });
  try {
    const models = await openaiFetchModels('test-key');

    // THE HEADLINE: the speech synthesizer that was masquerading as a vision model.
    const tts = capsOf(models, 'gpt-4o-mini-tts');
    assert.ok(
      !tts.includes('vision'),
      `gpt-4o-mini-tts is a TEXT-TO-SPEECH model and must NOT be vision-capable (got: ${tts.join(', ')})`,
    );
    assert.deepEqual(tts, ['audio_generation'], 'a TTS endpoint generates audio and nothing else');

    assert.deepEqual(capsOf(models, 'tts-1'), ['audio_generation']);

    // An image GENERATOR is the opposite of vision (output, not input).
    const dalle = capsOf(models, 'dall-e-3');
    assert.ok(!dalle.includes('vision'), 'dall-e-3 GENERATES images, it cannot READ them');
    assert.deepEqual(dalle, ['image_generation']);

    // Speech-to-text is not vision either — and note its id also contains 'gpt-4o'.
    const transcribe = capsOf(models, 'gpt-4o-transcribe');
    assert.ok(!transcribe.includes('vision'), 'gpt-4o-transcribe is speech-to-text, not vision');
    assert.deepEqual(transcribe, ['audio_transcription']);

    assert.deepEqual(capsOf(models, 'text-embedding-3-small'), ['embeddings']);

    // NO OVER-CORRECTION: the REAL multimodal chat model keeps vision.
    const chat = capsOf(models, 'openai/gpt-4o');
    assert.ok(chat.includes('vision'), 'gpt-4o (the chat model) IS genuinely vision-capable');
    assert.ok(chat.includes('text'), 'gpt-4o still serves text');
  } finally {
    restoreFetch();
  }
});

// ─── Google ──────────────────────────────────────────────────────────────────
test('MODEL-07/google: an image GENERATOR is NOT vision-capable', async () => {
  stubFetch({
    models: [
      {
        name: 'models/gemini-2.5-flash-image',
        supportedGenerationMethods: ['predict'],
      },
      {
        name: 'models/gemini-2.5-flash-preview-tts',
        supportedGenerationMethods: ['generateContent'],
      },
      {
        name: 'models/gemini-2.5-pro',
        supportedGenerationMethods: ['generateContent', 'streamGenerateContent'],
      },
      {
        name: 'models/text-embedding-004',
        supportedGenerationMethods: ['embedContent'],
      },
    ],
  });
  try {
    const models = await googleFetchModels('test-key');

    // THE HEADLINE: the image generator that was masquerading as a vision model.
    const imageGen = capsOf(models, 'gemini-2.5-flash-image');
    assert.ok(
      !imageGen.includes('vision'),
      `gemini-2.5-flash-image GENERATES images and must NOT be vision-capable (got: ${imageGen.join(', ')})`,
    );
    assert.deepEqual(imageGen, ['image_generation']);

    // A TTS model whose id still contains 'gemini'.
    const tts = capsOf(models, 'gemini-2.5-flash-preview-tts');
    assert.ok(!tts.includes('vision'), 'a gemini TTS model is not vision-capable');
    assert.deepEqual(tts, ['audio_generation']);

    assert.deepEqual(capsOf(models, 'text-embedding-004'), ['embeddings']);

    // NO OVER-CORRECTION: the REAL multimodal chat model keeps vision.
    const chat = capsOf(models, 'gemini-2.5-pro');
    assert.ok(chat.includes('vision'), 'gemini-2.5-pro IS genuinely multimodal');
    assert.ok(chat.includes('text'), 'gemini-2.5-pro still serves text');
    assert.ok(chat.includes('reasoning'), 'the pro tier is a reasoning model');
  } finally {
    restoreFetch();
  }
});

// ─── The invariant, stated directly ──────────────────────────────────────────
test('MODEL-07: no media-IO endpoint from either provider is ever tagged vision', async () => {
  stubFetch({
    data: [
      { id: 'gpt-4o-mini-tts' },
      { id: 'gpt-4o-audio-preview' },
      { id: 'gpt-4o-realtime-preview' },
      { id: 'gpt-image-1' },
      { id: 'whisper-1' },
      { id: 'omni-moderation-latest' },
    ],
  });
  try {
    const models = await openaiFetchModels('test-key');
    for (const m of models) {
      assert.ok(
        !(m.capabilities ?? []).includes('vision'),
        `${m.model_id} is a media-IO / non-chat endpoint and must never be tagged vision ` +
          `(got: ${(m.capabilities ?? []).join(', ')})`,
      );
    }
  } finally {
    restoreFetch();
  }
});
