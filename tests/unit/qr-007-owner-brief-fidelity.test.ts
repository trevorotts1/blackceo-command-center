/**
 * QR-007 — owner-brief fidelity in cleanDetectionText / specCopy
 * (REVL-006 D2 HIGH + D4 MEDIUM; overlaps REVR-010 L4b).
 *
 * Two coupled defects at the ART-001/KAN-003 commit (2d39b3683):
 *
 *  (a) cleanDetectionText dropped any line matching
 *      /^(Problem|Tried|Needs|Suggested dept):/i regardless of provenance, so
 *      an OWNER line ("Needs: update pricing to $997/mo") was deleted along
 *      with the machine handback fields the kickback writer emits under its
 *      "[... HANDBACK]"/"[STALE-RETURN]"/[HANDBACK] header.
 *  (b) numeric/spelling specCopy was built from the CLEANED text, so the money
 *      the owner wrote on such a line vanished from the spec and a render
 *      printing exactly $997/$11,964 was reported fabricated by AF-NUM.
 *
 * These tests exercise the REAL exported functions — no reimplementation.
 * The machine-side half (handback block still stripped, machine lines mint no
 * gates) and the QR-001 / ART-001 / KAN-003 non-regression halves are asserted
 * here too, so a future edit to the cleaner cannot fix one half by breaking
 * the other.
 *
 * Run: node --import tsx --test tests/unit/qr-007-owner-brief-fidelity.test.ts
 */

// C8 — DB isolation. src/lib/qc-scorer statically reaches '@/lib/db', whose
// DB_PATH is frozen at module-eval time. './_isolated-db' points DATABASE_PATH
// at a temp file and MUST stay the first import (enforced by
// tests/unit/c8-db-isolation-guard.test.ts).
import './_isolated-db';

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  cleanDetectionText,
  deriveAcceptanceCriteria,
  criteriaForManifest,
  evaluateCriteria,
  compareNumericFidelity,
  compareSpellingFidelity,
  describesDeckDeliverable,
  type DeliverableManifestItem,
} from '../../src/lib/qc-scorer';

const mk = (over: Partial<DeliverableManifestItem>): DeliverableManifestItem => ({
  title: 'x',
  path: '/tmp/x/x',
  type: 'file',
  sizeBytes: 4096,
  dimensions: null,
  valid: true,
  ...over,
});

/**
 * The machine handback block, field lines verbatim from the qc-scorer writer
 * (src/lib/qc-scorer.ts ~6259-6263): header line first, then Problem / Tried /
 * Needs / Suggested dept.
 */
const MACHINE_HANDBACK = [
  '[QC-NO-ARTIFACT HANDBACK] 2026-09-26T12:00:00.000Z',
  'Problem: No artifact registered: task reached review with no reachable deliverable in task_deliverables. The executing agent must register its output before submitting for QC — a file/artifact/image deliverable for produced work, or a url deliverable pointing at where the work landed (a decision, a review, a record changed in another system).',
  'Tried: QC auto-scorer attempted to evaluate the artifact but found zero registered deliverables in task_deliverables.',
  'Needs: The executing agent must register the output file via POST /api/tasks/[id]/deliverables before transitioning to review status.',
  'Suggested dept: Sales',
].join('\n');

test('QR-007 (a) owner line beginning with a handback field word SURVIVES cleaning', () => {
  const cleaned = cleanDetectionText(
    'Pricing update for Acme',
    'Rework the pricing page.\nNeeds: update pricing to $997/mo',
  );
  assert.match(
    cleaned,
    /Needs: update pricing/,
    'an owner line that happens to begin "Needs:" must not be deleted — it is the brief, not a machine field',
  );
  console.log('  [QR-007 a] cleaned: %s', JSON.stringify(cleaned));
});

test('QR-007 (a-control) the machine handback block is STILL stripped and mints no gates', () => {
  const cleaned = cleanDetectionText('Task', MACHINE_HANDBACK);
  assert.equal(cleaned, 'Task', 'the machine handback block (header + fields) must still be stripped');
  assert.ok(
    !describesDeckDeliverable('Task', cleaned),
    'the stripped machine block must not contribute a deck verdict',
  );
  const types = deriveAcceptanceCriteria('Task', MACHINE_HANDBACK).map((c) => c.type);
  assert.deepEqual(
    types,
    ['deliverable_registered'],
    'a machine handback block alone must derive no image/deck/render gates',
  );
  console.log('  [QR-007 a-control] cleaned: %s | criteria: %s', JSON.stringify(cleaned), types.join(','));
});

test('QR-007 (b) render money written in the owner brief is NOT flagged fabricated', () => {
  const title = 'Pricing deck for Acme';
  const description = 'Build the pricing deck.\nNeeds: update pricing to $997/mo and $11,964/yr.';
  const num = deriveAcceptanceCriteria(title, description).find((c) => c.id === 'numeric_fidelity');
  assert.ok(num, 'numeric_fidelity criterion must be derived for a deck task');
  const specCopy = String((num!.params as { specCopy?: string })?.specCopy ?? '');
  assert.match(specCopy, /\$997/, 'the spec copy must carry the owner money token');
  assert.match(specCopy, /\$11,964/, 'the spec copy must carry the owner second money token');

  const cmp = compareNumericFidelity('Plan $997 per month, $11,964 per year', specCopy);
  assert.deepEqual(
    cmp.fabricated,
    [],
    'a render printing exactly the owner brief amounts must not be reported fabricated',
  );
  assert.equal(cmp.pass, true);
  console.log('  [QR-007 b] specCopy: %s | pass: %s', JSON.stringify(specCopy), cmp.pass);
});

test('QR-007 (b2) money inside a slash path in the owner brief is not flagged fabricated', () => {
  const crit = deriveAcceptanceCriteria(
    'Pricing deck',
    'Reference /offers/$997-vs-$11964/deck.pptx for the tiers.',
  ).find((c) => c.id === 'numeric_fidelity');
  const specCopy = String((crit?.params as { specCopy?: string } | undefined)?.specCopy ?? '');
  const cmp = compareNumericFidelity('Plan $997 per month and $11,964 per year', specCopy);
  assert.deepEqual(cmp.fabricated, [], 'money inside a slash path is still owner text and must be in the spec');
  assert.equal(cmp.pass, true);
  console.log('  [QR-007 b2] specCopy: %s | pass: %s', JSON.stringify(specCopy), cmp.pass);
});

test('QR-007 (b3) acronym spec copy survives for the spelling gate', () => {
  const spell = deriveAcceptanceCriteria(
    'ZHC pricing deck',
    'Needs: keep ZHC branding on every slide.',
  ).find((c) => c.id === 'spelling_fidelity');
  assert.ok(spell, 'spelling_fidelity criterion must be derived for a deck task');
  const specCopy = String((spell!.params as { specCopy?: string })?.specCopy ?? '');
  assert.match(specCopy, /ZHC/, 'the owner acronym must be in the spelling spec copy');
  assert.equal(compareSpellingFidelity('ZHC', specCopy).pass, true);
});

test('QR-007 non-regression: QR-001 deck-class card with no deck file still FAILS', async () => {
  const full = deriveAcceptanceCriteria('Week 1 Concepts deck for Acme', 'Build the week 1 concepts deck.');
  const mdOnly = [mk({ title: 'concepts.md', path: '/tmp/x/concepts.md' })];
  const narrowed = criteriaForManifest(full, mdOnly);
  assert.ok(
    narrowed.some((c) => c.type === 'pipeline_complete') && narrowed.some((c) => c.type === 'coverage'),
    'QR-001: deck-class criteria must keep their deck gates when the manifest holds no deck file',
  );
  const ev = await evaluateCriteria(narrowed, mdOnly);
  assert.equal(ev.pass, false, 'QR-001: a .md-only manifest for a deck card must FAIL, not pass existence-only');
  console.log('  [QR-007 regress-1] narrowed: %s | score: %s', narrowed.map((c) => c.type).join(','), ev.score);
});

test('QR-007 non-regression: ART-001 / KAN-003 audit history derives no deck gates', () => {
  const types = deriveAcceptanceCriteria(
    'badge-journey-week1-concepts',
    'PRIOR STATE: concept deck at /Users/x/runs/badge-journey-week1-concepts/deck.pptx already produced.\n' +
      'Artifacts already produced: /Users/x/a.png, /Users/x/b.png.',
  ).map((c) => c.type);
  assert.deepEqual(
    types,
    ['deliverable_registered'],
    'ART-001/KAN-003: prior-state paths must not mint deck/image/render gates',
  );
  console.log('  [QR-007 regress-2] criteria: %s', types.join(','));
});
