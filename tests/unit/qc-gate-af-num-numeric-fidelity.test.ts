/**
 * Unit-prove the AF-NUM numeric / currency copy-fidelity gate (v4.46.0) against
 * the REAL exported code in src/lib/qc-scorer.ts (no reimplementation).
 *
 * AF-NUM closes the slide-39 copy-fidelity gap: a deck rendered fabricated
 * per-line dollar figures ($1,197 / $1,197 / $1,097) that are NOT in the spec
 * copy and CONTRADICT sibling slides ($997 / $997 / $1,497) — yet QC passed it
 * because AF-LANG only checks legibility/script, never the numbers themselves.
 *
 * The pass/fail decision is made by the pure, deterministic helper
 * compareNumericFidelity(renderText, specText) (the live vision call only OCRs
 * the rendered amounts), so the gate is fully unit-provable without a key:
 *
 *   (a) extractMoneyTokens normalises $5,000 == 5000 == $5000 and parses ranges.
 *   (b) SLIDE-39 input (render has $1,197, spec has $997) ⇒ FAIL with a named
 *       fabricated amount.
 *   (c) CLEAN input (every render amount present in the spec, incl. $5,000 /
 *       $2,500) ⇒ PASS (no false positive on legitimate spec numbers).
 *   (d) deriveAcceptanceCriteria emits a numeric_fidelity criterion carrying the
 *       spec copy for image/deck tasks.
 *
 * Run: npm run test:vitest  (or: node --import tsx --test)
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  extractMoneyTokens,
  compareNumericFidelity,
  deriveAcceptanceCriteria,
} from '../../src/lib/qc-scorer';

// ─────────────────────────────────────────────────────────────────────────────
// (a) Money-token extraction + normalisation
// ─────────────────────────────────────────────────────────────────────────────

test('AF-NUM (a) extractMoneyTokens normalises formatting: $5,000 == 5000 == $5000', () => {
  const a = extractMoneyTokens('Tier price is $5,000 today');
  const b = extractMoneyTokens('Tier price is $5000 today');
  assert.deepEqual([...a].sort(), ['5000']);
  assert.deepEqual([...b].sort(), ['5000']);
  // decimals: trailing .00 dropped, real cents preserved
  assert.deepEqual([...extractMoneyTokens('$2,500.00')], ['2500']);
  assert.deepEqual([...extractMoneyTokens('$2.50')], ['2.5']);
  // ranges: both endpoints captured
  assert.deepEqual([...extractMoneyTokens('$150-$300')].sort(), ['150', '300']);
  console.log('  [AF-NUM a] normalised tokens OK');
});

// ─────────────────────────────────────────────────────────────────────────────
// (b) Slide-39 failure mode ⇒ FAIL
// ─────────────────────────────────────────────────────────────────────────────

test('AF-NUM (b) SLIDE-39: render shows $1,197 but spec says $997 ⇒ FAIL', () => {
  // What slide 39 actually rendered (fabricated per-line figures):
  const render = 'Starter $1,197   Pro $1,197   Elite $1,097';
  // What the spec copy (slides 35/36/37) actually says:
  const spec = 'Starter is $997. Pro is $997. Elite is $1,497.';

  const res = compareNumericFidelity(render, spec);
  assert.equal(res.pass, false, 'slide-39 fabricated figures must FAIL AF-NUM');
  // The fabricated amounts (not in spec) are flagged; $997/$1,497 are not.
  assert.deepEqual(res.fabricated.sort(), ['1097', '1197']);
  assert.match(res.explanation, /\$1197/);
  assert.match(res.explanation, /not present in spec copy/);
  assert.match(res.explanation, /\$997/);
  console.log('  [AF-NUM b] slide-39 FAIL: fabricated=%s', res.fabricated.map((a) => `$${a}`).join(','));
});

// ─────────────────────────────────────────────────────────────────────────────
// (c) Clean input ⇒ PASS (no false positive on legitimate spec numbers)
// ─────────────────────────────────────────────────────────────────────────────

test('AF-NUM (c) CLEAN: render numbers all present in spec ($5,000 / $2,500) ⇒ PASS', () => {
  const render = 'Annual $5,000     Quarterly $2,500';
  const spec = 'Our annual plan is $5,000 and the quarterly plan is $2,500.';
  const res = compareNumericFidelity(render, spec);
  assert.equal(res.pass, true, `legitimate spec numbers must PASS AF-NUM: ${res.explanation}`);
  assert.equal(res.fabricated.length, 0);
  console.log('  [AF-NUM c] clean PASS: render=%s spec=%s', res.renderMoney.join(','), res.specMoney.join(','));
});

test('AF-NUM (c2) formatting-only difference still PASSES ($5000 render vs $5,000 spec)', () => {
  const res = compareNumericFidelity('Plan: $5000', 'Plan: $5,000');
  assert.equal(res.pass, true, `formatting difference must normalise to a PASS: ${res.explanation}`);
  console.log('  [AF-NUM c2] formatting-normalised PASS');
});

test('AF-NUM (c3) render shows NO money ⇒ PASS (vacuously consistent)', () => {
  const res = compareNumericFidelity('No prices on this slide', 'Spec mentions $997 elsewhere');
  assert.equal(res.pass, true);
  console.log('  [AF-NUM c3] empty-render PASS');
});

// ─────────────────────────────────────────────────────────────────────────────
// (d) Criterion derivation carries the spec copy
// ─────────────────────────────────────────────────────────────────────────────

test('AF-NUM (d) deriveAcceptanceCriteria emits a numeric_fidelity criterion with spec copy', () => {
  const crit = deriveAcceptanceCriteria(
    'Create pricing slide image',
    'Starter is $997. Pro is $997. Elite is $1,497.',
  );
  const num = crit.find((c) => c.type === 'numeric_fidelity');
  assert.ok(num, 'numeric_fidelity criterion must be derived for image/deck tasks');
  const specCopy = (num!.params as { specCopy?: string })?.specCopy ?? '';
  assert.match(specCopy, /\$997/, 'spec copy (the brief) must be carried in params for the OCR diff');
  console.log('  [AF-NUM d] criteria types: %s', crit.map((c) => c.type).join(','));
});
