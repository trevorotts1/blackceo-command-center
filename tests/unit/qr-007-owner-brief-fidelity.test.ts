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
  reuseInstruction,
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

test('QR-010: image-demanding card with no image file keeps its image gates and FAILS', async () => {
  const full = deriveAcceptanceCriteria('Render a hero banner image for Acme', 'Render a hero banner image for Acme homepage.');
  const mdOnly = [mk({ title: 'notes.md', path: '/tmp/x/notes.md' })];
  const narrowed = criteriaForManifest(full, mdOnly);
  assert.ok(
    narrowed.some((c) => c.type === 'valid_image'),
    'QR-010: image-demanding criteria must keep their image gates when the manifest holds no image file',
  );
  const ev = await evaluateCriteria(narrowed, mdOnly);
  assert.equal(ev.pass, false, 'QR-010: a .md-only manifest for an image card must FAIL, not pass existence-only');
  console.log('  [QR-010] narrowed: %s | score: %s', narrowed.map((c) => c.type).join(','), ev.score);
});

test('QR-010 non-regression: card that never demanded an image still narrows without image gates', () => {
  const full = deriveAcceptanceCriteria('Week 1 concepts doc', 'Write the Week 1 concepts doc.');
  const mdOnly = [mk({ title: 'concepts.md', path: '/tmp/x/concepts.md' })];
  const narrowed = criteriaForManifest(full, mdOnly);
  assert.ok(
    !narrowed.some((c) => c.type === 'valid_image'),
    'ART-001/KAN-003: a card that never demanded an image must not mint image gates',
  );
  console.log('  [QR-010 regress] narrowed: %s', narrowed.map((c) => c.type).join(','));
});

test('QR-013 (a) slash-written resolution brief on a sub-floor image mints min_resolution and FAILS', async () => {
  const full = deriveAcceptanceCriteria('Hero banner', 'Build a 1080/4k hero banner for the sale.');
  const types = full.map((c) => c.type);
  assert.ok(
    types.includes('min_resolution'),
    `a '1080/4k' brief must mint min_resolution, got [${types.join(',')}]`,
  );
  const tinyImage = [mk({ title: 'banner.png', path: '/tmp/x/banner.png', type: 'image', sizeBytes: 512 })];
  const narrowed = criteriaForManifest(full, tinyImage);
  assert.ok(
    narrowed.some((c) => c.type === 'min_resolution'),
    'min_resolution must survive manifest narrowing for an image manifest',
  );
  const ev = await evaluateCriteria(narrowed, tinyImage);
  assert.equal(ev.pass, false, 'QR-013: a 512-byte image against a 1080/4k brief must FAIL, not pass existence-only');
  console.log('  [QR-013 a] narrowed: %s | score: %s | pass: %s', narrowed.map((c) => c.type).join(','), ev.score, ev.pass);
});

test('QR-013 (b) 1080/4k and 1080p 4k derive the SAME criteria set', () => {
  const slash = deriveAcceptanceCriteria('Hero banner', 'Build a 1080/4k hero banner for the sale.').map((c) => c.type);
  const plain = deriveAcceptanceCriteria('Hero banner', 'Build a 1080p 4k hero banner for the sale.').map((c) => c.type);
  assert.deepEqual(slash, plain, 'slash-written and space-written resolution demands must mint identical gates');
  console.log('  [QR-013 b] criteria: %s', slash.join(','));
});

test('QR-013 (c) a brief with no gate words gains no gates from the slash change', () => {
  const slash = deriveAcceptanceCriteria('Banner', 'Deliver a banner with N/A placeholders.').map((c) => c.type);
  const plain = deriveAcceptanceCriteria('Banner', 'Deliver a banner with placeholders.').map((c) => c.type);
  assert.deepEqual(slash, plain, 'a slash token carrying no gate words must not add gates');
  assert.ok(!slash.includes('min_resolution'), 'no resolution demand, no min_resolution gate');
  console.log('  [QR-013 c] criteria: %s', slash.join(','));
});

test('QR-013 (d) a bare URL with a slash path still mints no gate', () => {
  const types = deriveAcceptanceCriteria(
    'Banner',
    'Build a banner per https://cdn.example.com/shots/1080/hero.png spec.',
  ).map((c) => c.type);
  assert.ok(
    !types.includes('min_resolution'),
    `a 1080 inside a URL path must not mint min_resolution, got [${types.join(',')}]`,
  );
  console.log('  [QR-013 d] criteria: %s', types.join(','));
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

// ─────────────────────────────────────────────────────────────────────────────
// QZ-001 — slash-token admission, both arms (REVL-016-D1 over-admission +
// REVR-020-R1 under-admission), the bare-verb `render` misclassification
// (REVP-018-F1 lifecycle shape), and the never-true clause comments.
//
// The class boundary is measured, not asserted by eye: of every slash token the
// W36 lenses recorded, the only prose class whose halves are gate-bearing is the
// resolution class, so admission keys on resolution words. The tests below pin
// BOTH sides of that boundary plus the shapes that must not move at all.
// ─────────────────────────────────────────────────────────────────────────────

test('QZ-001 (i) a brief naming a mime type mints NO render gate and PASSES', async () => {
  const mdOnly = [mk({ title: 'report.md', path: '/tmp/x/report.md' })];
  for (const [title, desc] of [
    ['Write the weekly report', 'Attach the chart as image/png to the report.'],
    ['Write the weekly report', 'Accepted formats: application/pdf, image/png, text/plain.'],
    ['Write the launch email', 'Use the image/word pairing from the brief.'],
  ] as [string, string][]) {
    const full = deriveAcceptanceCriteria(title, desc);
    const types = full.map((c) => c.type);
    assert.deepEqual(
      types,
      ['deliverable_registered'],
      `REVL-016-D1: a mime type must not mint render gates, got [${types.join(',')}] for "${desc}"`,
    );
    const narrowed = criteriaForManifest(full, mdOnly);
    const ev = await evaluateCriteria(narrowed, mdOnly);
    assert.equal(ev.pass, true, `REVL-016-D1: "${desc}" delivered as .md must PASS, got ${ev.score}`);
    console.log('  [QZ-001 i] "%s" -> [%s] score=%s pass=%s', desc, types.join(','), ev.score, ev.pass);
  }
});

test('QZ-001 (ii) a single-slash relative path whose halves are detector keywords mints NO render gate', async () => {
  const mdOnly = [mk({ title: 'report.md', path: '/tmp/x/report.md' })];
  for (const [title, desc] of [
    ['Write the weekly report', 'Copy lives in outputs/deck for reference.'],
    ['Write the weekly report', 'Draft is at notes/slides and needs review.'],
    ['Update the runbook', 'Working dir: runs/deck'],
  ] as [string, string][]) {
    const full = deriveAcceptanceCriteria(title, desc);
    const types = full.map((c) => c.type);
    assert.deepEqual(
      types,
      ['deliverable_registered'],
      `REVL-016-D1: a relative path segment must not mint render gates, got [${types.join(',')}] for "${desc}"`,
    );
    const narrowed = criteriaForManifest(full, mdOnly);
    const ev = await evaluateCriteria(narrowed, mdOnly);
    assert.equal(ev.pass, true, `REVL-016-D1: "${desc}" delivered as .md must PASS, got ${ev.score}`);
    console.log('  [QZ-001 ii] "%s" -> [%s] score=%s pass=%s', desc, types.join(','), ev.score, ev.pass);
  }
});

test('QZ-001 (iii) dot-arm slash prose and its spaced control derive the SAME criteria and score the SAME', async () => {
  const tinyImage = [mk({ title: 'banner.png', path: '/tmp/x/banner.png', type: 'image', sizeBytes: 512 })];
  for (const [slashDesc, plainDesc] of [
    ['Build a 1080/4k.v2 hero banner.', 'Build a 1080p 4k v2 hero banner.'],
    ['Build a 1.5x/1080 hero banner.', 'Build a 1.5x 1080 hero banner.'],
    ['Build a v1.2/1080 hero banner.', 'Build a v1.2 1080 hero banner.'],
  ] as [string, string][]) {
    const slash = deriveAcceptanceCriteria('Hero banner', slashDesc).map((c) => c.type);
    const plain = deriveAcceptanceCriteria('Hero banner', plainDesc).map((c) => c.type);
    assert.deepEqual(slash, plain, `REVR-020-R1: "${slashDesc}" must derive the same gates as "${plainDesc}"`);
    assert.ok(slash.includes('min_resolution'), `REVR-020-R1: "${slashDesc}" must mint min_resolution, got [${slash.join(',')}]`);
    const sev = await evaluateCriteria(criteriaForManifest(deriveAcceptanceCriteria('Hero banner', slashDesc), tinyImage), tinyImage);
    const pev = await evaluateCriteria(criteriaForManifest(deriveAcceptanceCriteria('Hero banner', plainDesc), tinyImage), tinyImage);
    assert.equal(
      sev.pass,
      pev.pass,
      `REVR-020-R1: slash and spaced forms must score the same — ${sev.score}/${sev.pass} vs ${pev.score}/${pev.pass}`,
    );
    assert.equal(sev.pass, false, `REVR-020-R1: a sub-floor image must FAIL, not auto-pass ${sev.score}`);
    console.log('  [QZ-001 iii] "%s" vs "%s" -> %s | %s/%s both', slashDesc, plainDesc, slash.join(','), sev.score, pev.score);
  }
});

test('QZ-001 (iv) the multi-slash arm behaves like its spaced control', async () => {
  const tinyImage = [mk({ title: 'banner.png', path: '/tmp/x/banner.png', type: 'image', sizeBytes: 512 })];
  const slash = deriveAcceptanceCriteria('Hero banner', 'Build a hd/4k/render hero banner.').map((c) => c.type);
  const plain = deriveAcceptanceCriteria('Hero banner', 'Build a hd 4k render hero banner.').map((c) => c.type);
  assert.deepEqual(slash, plain, 'REVR-020-R1: "hd/4k/render" must derive the same gates as "hd 4k render"');
  assert.ok(slash.includes('min_resolution'), `REVR-020-R1: multi-slash resolution chain must mint min_resolution, got [${slash.join(',')}]`);
  const sev = await evaluateCriteria(
    criteriaForManifest(deriveAcceptanceCriteria('Hero banner', 'Build a hd/4k/render hero banner.'), tinyImage), tinyImage);
  const pev = await evaluateCriteria(
    criteriaForManifest(deriveAcceptanceCriteria('Hero banner', 'Build a hd 4k render hero banner.'), tinyImage), tinyImage);
  assert.equal(sev.pass, pev.pass, `multi-slash arm must score like its control — ${sev.score} vs ${pev.score}`);
  assert.equal(sev.pass, false, 'multi-slash arm on a sub-floor image must FAIL, not auto-pass');
  console.log('  [QZ-001 iv] hd/4k/render vs hd 4k render -> %s | %s both', slash.join(','), sev.score);
});

test('QZ-001 (v) genuine absolute, drive and URL paths still mint nothing', () => {
  for (const desc of [
    'Build a banner from /tmp/x/1080.png',
    'Build a banner from C:/work/1080.png',
    'Build a banner per https://cdn.example.com/shots/1080/hero.png spec.',
    'Deliver a/b/c/1080 asset.',
    'Deliver shots/1080/hero.png asset.',
    'Deliver deck.pptx/1080 asset.',
  ]) {
    const types = deriveAcceptanceCriteria('Banner', desc).map((c) => c.type);
    assert.ok(
      !types.includes('min_resolution'),
      `QZ-001: a genuine path/URL must not mint min_resolution, got [${types.join(',')}] for "${desc}"`,
    );
    console.log('  [QZ-001 v] "%s" -> [%s]', desc, types.join(','));
  }
});

test('QZ-001 (vi) ART-001 markdown brief and the and/or + N/A controls hold', async () => {
  const mdOnly = [mk({ title: 'concepts.md', path: '/tmp/x/concepts.md' })];

  // ART-001: a markdown concepts file is not a proven deck and must not be
  // deck-gated. With the bare verb `render` no longer an image signal, the
  // lifecycle shape that burned qc_reroute_attempts takes Mode A content review.
  for (const [title, desc] of [
    ['badge-journey-week1-concepts', 'Write the week 1 concepts markdown file.'],
    ['Ops report render', 'Render the weekly ops report as a markdown file for the team.'],
  ] as [string, string][]) {
    const full = deriveAcceptanceCriteria(title, desc);
    assert.deepEqual(
      full.map((c) => c.type),
      ['deliverable_registered'],
      `ART-001: a markdown-only brief must not mint render gates, got [${full.map((c) => c.type).join(',')}]`,
    );
    const narrowed = criteriaForManifest(full, mdOnly);
    assert.equal(
      narrowed.some((c) => c.type !== 'deliverable_registered'),
      false,
      'ART-001: the Markdown concepts shape must take Mode A content review, not the checklist path',
    );
    const ev = await evaluateCriteria(narrowed, mdOnly);
    assert.equal(ev.pass, true, `ART-001: a reachable .md must PASS, got ${ev.score}`);
  }

  // Controls whose slash halves are gate-free: unchanged, no resolution gate.
  for (const desc of ['Approve cash and/or accrual.', 'Use N/A placeholders.']) {
    const types = deriveAcceptanceCriteria('Approval', desc).map((c) => c.type);
    assert.deepEqual(types, ['deliverable_registered'], `control "${desc}" must stay gate-free, got [${types.join(',')}]`);
    console.log('  [QZ-001 vi] control "%s" -> [%s]', desc, types.join(','));
  }
  console.log('  [QZ-001 vi] ART-001 markdown shapes take Mode A content review');
});

test('QZ-001 (vii) QR-010 hole stays closed: an image-demanding card with no image still FAILS', async () => {
  const mdOnly = [mk({ title: 'notes.md', path: '/tmp/x/notes.md' })];
  const full = deriveAcceptanceCriteria('Logo for Acme', 'Create a logo for Acme. Brand colors: blue.');
  const types = full.map((c) => c.type);
  assert.ok(types.includes('valid_image'), `QR-010: an image-demanding card must keep its image gates, got [${types.join(',')}]`);
  const narrowed = criteriaForManifest(full, mdOnly);
  assert.deepEqual(
    narrowed.map((c) => c.type),
    types,
    'QZ-001: criteriaForManifest is identity — it must strip nothing and not mask the missing image',
  );
  const ev = await evaluateCriteria(narrowed, mdOnly);
  assert.equal(ev.pass, false, `QR-010: a .md-only manifest for an image card must FAIL, got ${ev.score}`);
  assert.ok(
    ev.results.some((r) => r.id === 'valid_image' && !r.pass),
    'QR-010: the FAIL must be on valid_image, not an incidental gate',
  );
  console.log('  [QZ-001 vii] image card + .md only -> [%s] score=%s pass=%s', types.join(','), ev.score, ev.pass);
});

test('QZ-001 (viii) bare verb render alone no longer classifies a card as an image task', () => {
  const withVerb = deriveAcceptanceCriteria('Ops report render', 'Render the weekly ops report as a markdown file.').map((c) => c.type);
  const withoutVerb = deriveAcceptanceCriteria('Ops report', 'Write the weekly ops report as a markdown file.').map((c) => c.type);
  assert.deepEqual(
    withVerb,
    withoutVerb,
    'REVP-018-F1: the bare verb render must not add render gates the same brief without it does not have',
  );
  // But a real image noun must still classify — the root cause fix must not
  // cost genuine image detection.
  for (const [title, desc] of [
    ['Create a company logo image', 'A simple logo, PNG.'],
    ['Render a hero banner image for Acme', 'Render a hero banner image for Acme homepage.'],
  ] as [string, string][]) {
    const types = deriveAcceptanceCriteria(title, desc).map((c) => c.type);
    assert.ok(types.includes('valid_image'), `genuine image detection must survive, got [${types.join(',')}] for "${title}"`);
  }
  console.log('  [QZ-001 viii] render-verb brief [%s] == no-verb brief [%s]', withVerb.join(','), withoutVerb.join(','));
});

// ─────────────────────────────────────────────────────────────────────────────
// QR-016 — REVR-030 F1 + F2. Two undeclared regressions that ate OWNER prose.
//
//  F1 (qc-scorer.ts, the "Already <verb>" strip): the pattern matched the
//     PHRASE, so an owner sentence opening the same way as the rework-reuse
//     trailer was deleted and its render demand went with it. The strip is now
//     anchored to the trailer SHAPE the writer emits (`reuseInstruction`).
//  F2 (qc-scorer.ts, machine-block membership): membership was decided by the
//     NEXT line's shape alone, so an owner line that merely LOOKS like a
//     handback field, abutting an unterminated field run, was deleted. The
//     reader now requires the writers\' canonical, ordered, non-repeating
//     field set (Problem → Tried → Needs → Suggested dept).
//
// Both are asserted against the REAL exported functions and the REAL writer
// (`reuseInstruction`), never a reimplementation.
// ─────────────────────────────────────────────────────────────────────────────

const RENDER_TYPES = [
  'valid_image',
  'vision_match',
  'language_match',
  'numeric_fidelity',
  'spelling_fidelity',
  'min_resolution',
] as const;
const DECK_TYPES = ['coverage', 'pipeline_complete'] as const;
const renderCount = (ids: string[]) => ids.filter((i) => (RENDER_TYPES as readonly string[]).includes(i)).length;
const deckCount = (ids: string[]) => ids.filter((i) => (DECK_TYPES as readonly string[]).includes(i)).length;
const typesOf = (title: string, desc: string) => deriveAcceptanceCriteria(title, desc).map((c) => c.type);

test('QR-016 F1 (a) "Already delivered a banner last week." is OWNER prose — 5 render gates retained', () => {
  const ids = typesOf('Refresh', 'Already delivered a banner last week. Please update it.');
  assert.equal(renderCount(ids), 5, `REVR-030 F1: the owner sentence must keep 5 render gates, got ${renderCount(ids)} [${ids.join(',')}]`);
  assert.ok(
    cleanDetectionText('Refresh', 'Already delivered a banner last week. Please update it.').includes('Already delivered a banner'),
    'the owner sentence itself must survive cleanDetectionText',
  );
  console.log('  [QR-016 F1 a] render=%s ids=[%s]', renderCount(ids), ids.sort().join(','));
});

test('QR-016 F1 (b) "Already produced a logo. Redo it at 4k." keeps min_resolution — 6 render gates', () => {
  const ids = typesOf('Refresh', 'Already produced a logo. Redo it at 4k.');
  assert.equal(renderCount(ids), 6, `REVR-030 F1: the owner resolution demand must survive, got ${renderCount(ids)} [${ids.join(',')}]`);
  assert.ok(ids.includes('min_resolution'), 'REVR-030 F1: min_resolution must be retained from the owner "4k" demand');
  console.log('  [QR-016 F1 b] render=%s ids=[%s]', renderCount(ids), ids.sort().join(','));
});

test('QR-016 F1 (c) "Already delivered the pitch deck. Add the appendix." keeps BOTH deck gates', () => {
  const ids = typesOf('Refresh', 'Already delivered the pitch deck. Add the appendix.');
  assert.equal(deckCount(ids), 2, `REVR-030 F1: deck gates must be retained, got ${deckCount(ids)} [${ids.join(',')}]`);
  assert.equal(renderCount(ids), 5, 'REVR-030 F1: the deck-card render set must be retained too');
  console.log('  [QR-016 F1 c] render=%s deck=%s ids=[%s]', renderCount(ids), deckCount(ids), ids.sort().join(','));
});

test('QR-016 F2 (d) an owner field-shaped line abutting an unterminated field run SURVIVES', () => {
  const unterminated = '[STALE-RETURN] 2026-09-26T12:00:00.000Z\nProblem: none\nSuggested dept: Sales\nNeeds: a real image please.';
  const ids = typesOf('Pricing', unterminated);
  assert.equal(renderCount(ids), 5, `REVR-030 F2: the owner line must survive and mint 5 render gates, got ${renderCount(ids)} [${ids.join(',')}]`);
  assert.ok(
    cleanDetectionText('Pricing', unterminated).includes('Needs: a real image please'),
    'REVR-030 F2: the owner "Needs:" line must survive cleanDetectionText',
  );

  // Same input with the blank separator the real writers always emit: same answer.
  const blanked = '[STALE-RETURN] 2026-09-26T12:00:00.000Z\nProblem: none\nSuggested dept: Sales\n\nNeeds: a real image please.';
  assert.equal(renderCount(typesOf('Pricing', blanked)), 5, 'REVR-030 F2: the blank-line variant must also render 5');
  console.log('  [QR-016 F2 d] unterminated render=%s | blank render=%s', renderCount(ids), renderCount(typesOf('Pricing', blanked)));
});

test('QR-016 F2 (d-control) a GENUINE machine block per the writers\' format is STILL stripped', () => {
  // Field set and order verbatim from the three real writers.
  const genuine = [
    '[QC-NO-ARTIFACT HANDBACK] 2026-09-26T12:00:00.000Z',
    'Problem: none',
    'Tried: QC auto-scorer attempted to evaluate',
    'Needs: register the output',
    'Suggested dept: Sales',
  ].join('\n');
  assert.equal(cleanDetectionText('Pricing', genuine), 'Pricing', 'a genuine ordered machine block must still be stripped whole');
  assert.deepEqual(typesOf('Pricing', genuine), ['deliverable_registered'], 'a genuine machine block must mint no render gates');
  console.log('  [QR-016 F2 d-control] cleaned=%s', JSON.stringify(cleanDetectionText('Pricing', genuine)));
});

test('QR-016 (e) the REAL reuseInstruction trailer still renders 0', () => {
  const trailer = reuseInstruction('t1', () => [{ path: '/out/a.pptx' }, { path: '/out/b.png' }]);
  assert.ok(trailer.includes('Already delivered and STILL VALID'), `writer shape changed: ${JSON.stringify(trailer)}`);
  const desc = 'Update the creative.' + trailer;
  assert.equal(renderCount(typesOf('Refresh', desc)), 0, 'REVR-030 graded-intended: the trailer alone must render 0');
  assert.ok(
    !cleanDetectionText('Refresh', desc).includes('do NOT regenerate'),
    'the trailer instruction must be stripped from detection text',
  );
  console.log('  [QR-016 e] trailer render=0 | cleaned=%s', JSON.stringify(cleanDetectionText('Refresh', desc)));
});

test('REVL-026-R2-F1 an UNTERMINATED trailer occurrence must not eat a demand after it', () => {
  // Truncated writer output — the "Already delivered and STILL VALID" opener is
  // present but the declared terminator ("Produce ONLY what the gaps above
  // name.") never printed. The old `|$` alternative ran the strip to end of
  // input and deleted the real demand that followed: measured render 0.
  const desc = 'Build the launch hero. Already delivered and STILL VALID - do NOT regenerate: /out/a.png. '
    + 'Please add a 4k banner image.';
  const ids = typesOf('Refresh', desc);
  assert.equal(renderCount(ids), 6, `the owner demand after an unterminated trailer must survive, got ${renderCount(ids)} [${ids.join(',')}]`);
  assert.ok(ids.includes('valid_image'), 'the image demand after an unterminated trailer must keep valid_image');
  assert.ok(ids.includes('min_resolution'), 'the 4k demand after an unterminated trailer must keep min_resolution');
  assert.ok(
    cleanDetectionText('Refresh', desc).includes('Please add a 4k banner image'),
    'the demand sentence itself must survive cleanDetectionText',
  );

  // Terminated writer output is still stripped whole, and a demand after it survives.
  const terminated = 'Build the launch hero.' + reuseInstruction('t1', () => [{ path: '/out/a.png' }])
    + ' Please add a 4k banner image.';
  const tIds = typesOf('Refresh', terminated);
  assert.ok(!cleanDetectionText('Refresh', terminated).includes('do NOT regenerate'), 'the terminated trailer must still be stripped');
  assert.equal(renderCount(tIds), 6, `the demand after a terminated trailer must survive too, got ${renderCount(tIds)} [${tIds.join(',')}]`);
  console.log('  [REVL-026-R2-F1] unterminated render=%s | terminated render=%s', renderCount(ids), renderCount(tIds));
});

test('QR-016 (e-control) owner prose placed BEFORE the trailer survives alongside it', () => {
  const trailer = reuseInstruction('t1', () => [{ path: '/out/a.png' }]);
  const desc = 'Build a hero banner image for the launch.' + trailer;
  const ids = typesOf('Refresh', desc);
  assert.ok(ids.includes('valid_image'), `the owner image demand before the trailer must survive, got [${ids.join(',')}]`);
  assert.ok(!cleanDetectionText('Refresh', desc).includes('do NOT regenerate'), 'the trailer itself must still be stripped');
  console.log('  [QR-016 e-control] ids=[%s]', ids.sort().join(','));
});

// ─────────────────────────────────────────────────────────────────────────────
// REVL-026-R2-F2 — the QR-016 trailer strip was fail-OPEN on span extent.
//
// The R2-F1 fix (above) removed the `|$` alternative so a terminator was
// required. That was necessary but NOT sufficient: the span between opener and
// terminator was still `[\s\S]*?`, so any OWNER prose sitting between an opener
// and a later terminator was deleted along with the trailer. Measured at the
// tip d9f080b2: 223 chars collapsed to 18 and 156 collapsed to 18, demand gone
// in both. A SINGLE opener suffices — a second opener is not required, which is
// broader than the original finding stated.
//
// The strip is now bounded against the WRITER's own shape (never owner prose):
// it cannot cross a second opener, and it must contain the writer's invariant
// continuation "Re-register each one".
// ─────────────────────────────────────────────────────────────────────────────

/** Owner demand written in prose, as an owner brief actually reads. */
const OWNER_DEMAND = 'Please add a 4k hero banner image at 1920x1080.';

/** The truncated shape the QR-016 writer emits when no terminator is printed. */
const STRAY_OPENER = 'Already delivered and STILL VALID — do NOT regenerate: /out/a.png.';
const TRAILER_TERMINATOR = 'Produce ONLY what the gaps above name.';

test('REVL-026-R2-F2 a SINGLE opener must not reach a later terminator and eat demand between', () => {
  // S4 — the shape the R2-F1 fix still deleted. One opener, owner demand, then a
  // terminator that belongs to no trailer. The strip must not use it as a free
  // terminator and delete the demand.
  const desc = `Build the launch page. ${STRAY_OPENER} ${OWNER_DEMAND} ${TRAILER_TERMINATOR}`;
  const cleaned = cleanDetectionText('Refresh', desc);
  assert.ok(
    cleaned.includes('4k hero banner image'),
    `the demand between a single opener and a later terminator must survive, got ${JSON.stringify(cleaned)}`,
  );
  const ids = typesOf('Refresh', desc);
  assert.ok(ids.includes('valid_image'), `the image demand must keep valid_image, got [${ids.join(',')}]`);
  assert.ok(ids.includes('min_resolution'), `the 4k demand must keep min_resolution, got [${ids.join(',')}]`);
  console.log('  [REVL-026-R2-F2 S4] cleaned=%s', JSON.stringify(cleaned));
});

test('REVL-026-R2-F2 an opener must not cross a SECOND opener to reach a later terminator', () => {
  // S3 — two openers, owner demand between them.
  const desc = `Build the launch page. ${STRAY_OPENER} ${OWNER_DEMAND} `
    + `${STRAY_OPENER.replace('/out/a.png', '/out/b.png')} ${TRAILER_TERMINATOR}`;
  const cleaned = cleanDetectionText('Refresh', desc);
  assert.ok(
    cleaned.includes('4k hero banner image'),
    `the demand between two openers must survive, got ${JSON.stringify(cleaned)}`,
  );
  const ids = typesOf('Refresh', desc);
  assert.ok(ids.includes('valid_image'), `the image demand must keep valid_image, got [${ids.join(',')}]`);
  console.log('  [REVL-026-R2-F2 S3] cleaned=%s', JSON.stringify(cleaned));
});

test('REVL-026-R2-F2 owner prose under a stray opener survives a LATER genuine trailer', () => {
  // The realistic composite: owner prose uses the opener words, then the writer
  // appends a real trailer. The genuine trailer must still strip whole, and the
  // owner demand must survive alongside it.
  const genuine = reuseInstruction('t1', () => [{ path: '/out/a.png' }, { path: '/out/b.png' }]);
  assert.ok(genuine.includes('Re-register each one'), `writer shape changed: ${JSON.stringify(genuine)}`);
  const desc = `Already delivered and STILL VALID last week as requested. ${OWNER_DEMAND}` + genuine;
  const cleaned = cleanDetectionText('Refresh', desc);
  assert.ok(
    cleaned.includes('4k hero banner image'),
    `the owner demand before a genuine trailer must survive, got ${JSON.stringify(cleaned)}`,
  );
  assert.ok(
    !cleaned.includes('do NOT regenerate') && !cleaned.includes('Re-register each one'),
    `the genuine trailer must still strip whole, got ${JSON.stringify(cleaned)}`,
  );
  console.log('  [REVL-026-R2-F2 composite] cleaned=%s', JSON.stringify(cleaned));
});

test('REVL-026-R2-F2 controls: genuine trailer alone still strips, owner demand still survives', () => {
  // S1 control — the genuine writer trailer with nothing else must strip whole,
  // so the strip did not degrade into a no-op.
  const genuine = reuseInstruction('t1', () => [{ path: '/out/a.png' }]);
  assert.equal(
    cleanDetectionText('Refresh', genuine).includes('do NOT regenerate'),
    false,
    'a genuine trailer alone must still strip whole',
  );
  assert.equal(renderCount(typesOf('Refresh', genuine)), 0, 'a genuine trailer alone must render 0');

  // S2 control — owner demand BEFORE a genuine trailer keeps its gates.
  const desc = `Build the launch page. ${OWNER_DEMAND}` + genuine;
  const ids = typesOf('Refresh', desc);
  assert.ok(ids.includes('valid_image'), `the demand before a trailer must keep valid_image, got [${ids.join(',')}]`);
  assert.equal(
    cleanDetectionText('Refresh', desc).includes('do NOT regenerate'),
    false,
    'the genuine trailer must still strip when owner prose precedes it',
  );

  // S6 control — F1's unterminated shape must stay fixed.
  const unterminated = `Build the hero. ${STRAY_OPENER} ${OWNER_DEMAND}`;
  assert.ok(
    cleanDetectionText('Refresh', unterminated).includes('4k hero banner image'),
    'an unterminated trailer must still not eat demand after it (R2-F1 must not regress)',
  );
  console.log('  [REVL-026-R2-F2 controls] genuine render=%s', renderCount(typesOf('Refresh', genuine)));
});
