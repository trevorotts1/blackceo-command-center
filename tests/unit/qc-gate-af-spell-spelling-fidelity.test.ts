/**
 * Unit-prove the AF-SPELL spelling / acronym copy-fidelity gate (v4.47.0)
 * against the REAL exported code in src/lib/qc-scorer.ts (no reimplementation).
 *
 * AF-SPELL closes the misspelled-acronym gap: a rendered deck slide showed `ZCH`
 * where the spec copy said `ZHC` — yet QC passed it because AF-LANG only checks
 * legibility/script (ZCH is perfectly legible English) and AF-NUM only gates
 * money. There was no gate asserting the rendered WORDS match the spec words.
 *
 * The pass/fail decision is made by the pure, deterministic helper
 * compareSpellingFidelity(renderText, specText) (the live vision call only OCRs
 * the rendered text), so the gate is fully unit-provable without a key:
 *
 *   (a) tokenizeForSpelling normalises case + typographic emphasis + punctuation
 *       and drops money/number tokens (AF-NUM owns those).
 *   (b) MISSPELLED-ACRONYM input (render shows ZCH, spec says ZHC) ⇒ FAIL with
 *       the garbled token named.
 *   (c) CLEAN input (every render word present in the spec / a known acronym /
 *       a common word) ⇒ PASS (no false positive on real acronyms or brands).
 *   (d) deriveAcceptanceCriteria emits a spelling_fidelity criterion carrying the
 *       spec copy for image/deck tasks.
 *
 * Run: npm run test:vitest  (or: node --import tsx --test)
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  tokenizeForSpelling,
  compareSpellingFidelity,
  deriveAcceptanceCriteria,
  AF_SPELL_KNOWN_ACRONYMS,
} from '../../src/lib/qc-scorer';

// ─────────────────────────────────────────────────────────────────────────────
// (a) Tokenisation + normalisation
// ─────────────────────────────────────────────────────────────────────────────

test('AF-SPELL (a) tokenizeForSpelling normalises case/emphasis/punctuation and drops numbers', () => {
  // emphasis + trailing punctuation stripped; acronym preserved
  assert.deepEqual(tokenizeForSpelling('**ZHC.**'), ['zhc']);
  assert.deepEqual(tokenizeForSpelling('(ROI)'), ['roi']);
  // money / pure numbers are dropped (AF-NUM owns numeric fidelity)
  assert.deepEqual(tokenizeForSpelling('Plan $5,000 today'), ['plan', 'today']);
  // case-insensitive
  assert.deepEqual(tokenizeForSpelling('Workforce'), ['workforce']);
  console.log('  [AF-SPELL a] tokeniser OK');
});

// ─────────────────────────────────────────────────────────────────────────────
// (b) Misspelled acronym failure mode ⇒ FAIL
// ─────────────────────────────────────────────────────────────────────────────

test('AF-SPELL (b) render shows ZCH but spec says ZHC ⇒ FAIL', () => {
  // What the slide actually rendered (KIE garbled the acronym):
  const render = 'Welcome to ZCH the Zero Human Workforce';
  // What the spec copy actually says:
  const spec = 'Welcome to ZHC the Zero Human Workforce';

  const res = compareSpellingFidelity(render, spec);
  assert.equal(res.pass, false, 'mangled acronym ZCH must FAIL AF-SPELL');
  // The garbled token is flagged; ZHC (in spec) and brand words are not.
  assert.deepEqual(res.misspelled, ['zch']);
  assert.match(res.explanation, /"zch"/);
  assert.match(res.explanation, /do not match the spec/);
  console.log('  [AF-SPELL b] misspelled-acronym FAIL: misspelled=%s', res.misspelled.join(','));
});

test('AF-SPELL (b2) garbled brand word (Workfroce vs Workforce) ⇒ FAIL', () => {
  const res = compareSpellingFidelity('Zero Human Workfroce', 'Zero Human Workforce');
  assert.equal(res.pass, false);
  assert.deepEqual(res.misspelled, ['workfroce']);
  console.log('  [AF-SPELL b2] garbled brand-word FAIL');
});

// ─────────────────────────────────────────────────────────────────────────────
// (c) Clean input ⇒ PASS (no false positive on real acronyms / spec brand words)
// ─────────────────────────────────────────────────────────────────────────────

test('AF-SPELL (c) CLEAN: render words all in spec / known acronyms ⇒ PASS', () => {
  const render = 'ZHC powers your CEO-grade Zero Human Workforce with AI and ROI';
  const spec = 'ZHC powers your CEO-grade Zero Human Workforce.';
  const res = compareSpellingFidelity(render, spec);
  assert.equal(res.pass, true, `legitimate spec words + known acronyms must PASS AF-SPELL: ${res.explanation}`);
  assert.equal(res.misspelled.length, 0);
  console.log('  [AF-SPELL c] clean PASS: tokens=%d', res.renderTokens.length);
});

test('AF-SPELL (c2) known acronym not in spec still PASSES (allowlist)', () => {
  // GHL / SOP / VSL are real acronyms on the allowlist; absent from spec is OK.
  const res = compareSpellingFidelity('Sync GHL via SOP and VSL', 'Sync the system');
  assert.equal(res.pass, true, `known acronyms must not be flagged: ${res.explanation}`);
  // sanity: those acronyms ARE on the allowlist
  assert.ok(AF_SPELL_KNOWN_ACRONYMS.has('GHL'));
  console.log('  [AF-SPELL c2] known-acronym allowlist PASS');
});

test('AF-SPELL (c3) proper noun / brand name present in spec ⇒ PASS', () => {
  // The brand names Zorp Widgets / Acme Consulting are in the spec copy → must not
  // be flagged as misspellings even though they are not dictionary words.
  const res = compareSpellingFidelity('Zorp Widgets Acme Consulting', 'Built by Zorp Widgets for Acme Consulting');
  assert.equal(res.pass, true, `spec brand names must not be flagged: ${res.explanation}`);
  console.log('  [AF-SPELL c3] brand-name PASS');
});

test('AF-SPELL (c4) render shows NO text ⇒ PASS (vacuously consistent)', () => {
  const res = compareSpellingFidelity('', 'Spec has ZHC and Workforce');
  assert.equal(res.pass, true);
  console.log('  [AF-SPELL c4] empty-render PASS');
});

// ─────────────────────────────────────────────────────────────────────────────
// (d) Criterion derivation carries the spec copy
// ─────────────────────────────────────────────────────────────────────────────

test('AF-SPELL (d) deriveAcceptanceCriteria emits a spelling_fidelity criterion with spec copy', () => {
  const crit = deriveAcceptanceCriteria(
    'Create ZHC welcome slide image',
    'Welcome to ZHC the Zero Human Workforce.',
  );
  const spell = crit.find((c) => c.type === 'spelling_fidelity');
  assert.ok(spell, 'spelling_fidelity criterion must be derived for image/deck tasks');
  const specCopy = (spell!.params as { specCopy?: string })?.specCopy ?? '';
  assert.match(specCopy, /ZHC/, 'spec copy (the brief) must be carried in params for the OCR diff');
  console.log('  [AF-SPELL d] criteria types: %s', crit.map((c) => c.type).join(','));
});
