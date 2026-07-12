/**
 * modality-classifier.test.ts — P1-01 conservative, fail-to-text modality classifier.
 *
 * The phantom-worker incident (2026-07-11 ~11:31) proximate trigger: the word
 * "screenshot" in a task's text matched the old VISION_SIGNALS substring list and
 * flipped the task to `vision`, demanding a vision-capable model. On a box with no
 * active vision model the sovereignty gate then refused to dispatch and the task
 * stalled. The classifier is now conservative: a bare noun NEVER flips modality;
 * a non-`text` modality is returned ONLY on (i) an actual attachment, (ii) an
 * explicit generation verb phrase, or (iii) an explicitly declared modality.
 *
 * FAIL-FIRST PROOF (rubric / Section 2.1 item 3): case (a) — the incident title —
 * asserts `text`. Against the PRE-FIX file (origin/main v5.16.2, where
 * VISION_SIGNALS still contained 'screenshot'), detectModality() returned
 * 'vision' for this exact input, so this assertion FAILS on the pre-fix tree and
 * PASSES on the fixed tree. Reproduced during the P1-01 build (see LEDGER).
 *
 *   node --import tsx --test tests/unit/modality-classifier.test.ts
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  detectModality,
  selectTaskModel,
  applyModalityDowngrade,
  inventoryServesModality,
  type TaskModality,
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

const TEXT_MODEL = model('ollama-cloud/llama3.3:70b', ['text', 'reasoning'], 2);
const VISION_MODEL = model('ollama-cloud/llava:34b', ['text', 'vision'], 2);

// ── (a) THE INCIDENT: a "…screenshot…" balance-check task classifies as text ──
test('(a) the incident title/description ("…screenshot…") classifies as text, not vision', () => {
  // The exact shape of the 2026-07-11 ~11:31 request that stalled: a routine
  // account-balance check that merely mentions taking a screenshot.
  const modality = detectModality(
    'Check the Convert and Flow balance',
    'Log into Convert and Flow, check the current account balance, and take a screenshot of the billing page for the records.',
  );
  assert.equal(modality, 'text', 'a balance-check that mentions "screenshot" must classify as text');
});

// ── (b) an explicit generation VERB PHRASE classifies image_generation ────────
test('(b) "generate image of a red car" classifies as image_generation', () => {
  assert.equal(
    detectModality('Marketing asset', 'Generate image of a red car for the hero banner.'),
    'image_generation',
  );
  // A bare "image" noun with no generation verb must NOT flip to image_generation
  // (nor to vision) — it stays text.
  assert.equal(detectModality('Update the image alt text on the about page'), 'text');
});

// ── (c) an ACTUAL attached image classifies vision ────────────────────────────
test('(c) an attached-image task classifies as vision', () => {
  assert.equal(
    detectModality('Review the deliverable', 'Look over the attached file and confirm the layout.', {
      attachments: [{ kind: 'image', mime: 'image/png' }],
    }),
    'vision',
  );
  // Same text with NO attachment stays text (the wording alone never flips).
  assert.equal(
    detectModality('Review the deliverable', 'Look over the attached file and confirm the layout.'),
    'text',
  );
  // An explicitly declared modality (condition iii) also produces vision.
  assert.equal(
    detectModality('QC pass', 'Confirm the brand colors.', { declaredModality: 'vision' }),
    'vision',
  );
});

// ── (d) vision task on a box with ZERO active vision models → text + downgrade ─
test('(d) a vision-classified task on a box with no active vision model downgrades to text', () => {
  // Selector path: an attachment-derived vision task, but the inventory has only a
  // text model. Dispatch must proceed as text (a text model attempts it) and the
  // downgrade must be flagged so the dispatcher can log a modality_downgraded event.
  const sel = selectTaskModel({
    title: 'Look at this diagram',
    description: 'Describe what the attached architecture diagram shows.',
    department: 'operations',
    required_modality: 'vision', // pre-classified vision (as the resolver passes it)
    inventory: [TEXT_MODEL], // NO vision model active
  });
  assert.equal(sel.modality_downgraded, true, 'the vision→text downgrade must be flagged');
  assert.equal(sel.required_modality, 'text', 'effective modality must be text after downgrade');
  assert.equal(sel.needs_owner_input, false, 'dispatch must proceed, not ask the owner');
  assert.equal(sel.model_id, 'ollama-cloud/llama3.3:70b', 'a text model must be selected');

  // Pure helper: the downgrade decision itself.
  const dg = applyModalityDowngrade('vision', [TEXT_MODEL]);
  assert.deepEqual(dg, { modality: 'text', downgraded: true });

  // When a vision model IS active, NO downgrade — vision stays vision.
  const noDg = applyModalityDowngrade('vision', [TEXT_MODEL, VISION_MODEL]);
  assert.deepEqual(noDg, { modality: 'vision', downgraded: false });
  const selVision = selectTaskModel({
    title: 'Look at this diagram',
    description: 'Describe the attached diagram.',
    department: 'operations',
    required_modality: 'vision',
    inventory: [TEXT_MODEL, VISION_MODEL],
  });
  assert.equal(selVision.modality_downgraded, false);
  assert.equal(selVision.required_modality, 'vision');
  assert.equal(selVision.model_id, 'ollama-cloud/llava:34b');
});

// ── (d-cont) generation modalities are NOT downgraded — they ask the owner ─────
test('(d-cont) a generation modality with no capable model is NOT downgraded (owner input)', () => {
  // image_generation cannot be faked by a text model — it must stay and ask the owner.
  const dg = applyModalityDowngrade('image_generation', [TEXT_MODEL]);
  assert.deepEqual(dg, { modality: 'image_generation', downgraded: false });
  const sel = selectTaskModel({
    title: 'Hero banner',
    description: 'Generate image of a mountain sunrise.',
    department: 'marketing',
    inventory: [TEXT_MODEL], // no image_generation model
  });
  assert.equal(sel.required_modality, 'image_generation');
  assert.equal(sel.modality_downgraded, false);
  assert.equal(sel.needs_owner_input, true, 'a generation task with no capable model asks the owner');
});

// ── Break-it: every removed noun, solo / mixed-case / in a URL, stays text ─────
test('break-it: removed vision/video nouns never flip modality on their own', () => {
  const removedNouns = [
    'screenshot', 'image', 'photo', 'visual', 'ocr', 'slide', 'diagram', 'chart',
    'graphic', 'picture', 'thumbnail', 'mockup', 'inspect', 'video', 'clip',
    'motion', 'storyboard', 'reel', 'animation', 'look at',
  ];
  for (const noun of removedNouns) {
    assert.equal(detectModality(noun), 'text', `solo "${noun}" must be text`);
    assert.equal(detectModality(noun.toUpperCase()), 'text', `"${noun.toUpperCase()}" must be text`);
    assert.equal(
      detectModality(`See https://example.com/${noun}/report and confirm the numbers`),
      'text',
      `"${noun}" embedded in a URL must be text`,
    );
    assert.equal(
      detectModality(`Please ${noun} the quarterly summary and reply`),
      'text',
      `"${noun}" in a sentence must be text`,
    );
  }
});

// ── inventoryServesModality sanity ────────────────────────────────────────────
test('inventoryServesModality reports capability presence correctly', () => {
  assert.equal(inventoryServesModality('text', [TEXT_MODEL]), true);
  assert.equal(inventoryServesModality('vision', [TEXT_MODEL]), false);
  assert.equal(inventoryServesModality('vision', [VISION_MODEL]), true);
  assert.equal(inventoryServesModality('vision', []), false);
});

// ── Audio generation / transcription verb phrases still classify ──────────────
test('audio generation and transcription verb phrases still classify (not passive nouns)', () => {
  const cases: Array<[string, TaskModality]> = [
    ['Generate audio narration for the intro', 'audio_generation'],
    ['Text to speech for the welcome message', 'audio_generation'],
    ['Transcribe the sales call recording', 'audio_transcription'],
    ['Speech to text of the attached meeting', 'audio_transcription'],
    ['Create video from the product shots', 'video_generation'],
  ];
  for (const [text, expected] of cases) {
    assert.equal(detectModality(text), expected, `"${text}" → ${expected}`);
  }
});
