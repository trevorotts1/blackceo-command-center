/**
 * Unit-prove the AF-COVERAGE deck coverage / anti-compression gate (v4.49.0)
 * against the REAL exported code in src/lib/qc-scorer.ts (no reimplementation).
 *
 * AF-COVERAGE closes the silent-compression gap: a ~2800-line transcript that
 * warranted ~30-62 slides was shortened to 12, yet the .pptx was technically
 * valid, went through the pipeline, and rendered legible/correct text — so
 * AF-LANG/AF-NUM/AF-SPELL/AF-PIPELINE-COMPLETE all passed and the deck could be
 * moved review→Done. None of those gates count slides against the client's
 * content. This gate does, and it is fully unit-provable without any key:
 *
 *   (a) checkCoverage (pure) FAILS a compressed deck (actual far below target,
 *       no client cap), PASSES a full-coverage deck (actual ≥ 90% of target),
 *       and PASSES a deck whose smaller count is explained by an explicit
 *       client_requested_slide_cap.
 *   (b) checkCoverage flags an implausibly-low TARGET for a large source
 *       (suspected upstream compression) and is fail-closed on unknown
 *       actual/target.
 *   (c) collectCoverageInputs reads slide_count_target / client_requested_slide_cap
 *       / source size from a real on-disk run dir (intake.json + mission_prd.json),
 *       and falls back to measuring a transcript on disk for source size.
 *   (d) countDeckSlides counts per-slide images from the manifest.
 *   (e) deriveAcceptanceCriteria emits a coverage criterion for DECK tasks and
 *       NOT for a standalone single-image (logo) task.
 *
 * Run: npm run test:unit  (node --import tsx --test tests/unit/*.test.ts)
 */

// C8 — DB isolation. A statically-imported project module here transitively
// pulls in '@/lib/db', whose module-level
// `DB_PATH = process.env.DATABASE_PATH || <cwd>/mission-control.db` is frozen at
// eval time. This suite does not open the DB today, but nothing stopped it from
// starting to — and then it would have written to the LIVE production board.
// './_isolated-db' points DATABASE_PATH at a temp file and MUST stay the first
// import (it is a no-op for a suite that never opens the DB).
// Enforced by tests/unit/c8-db-isolation-guard.test.ts.
import './_isolated-db';

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';

import {
  checkCoverage,
  collectCoverageInputs,
  countDeckSlides,
  deriveAcceptanceCriteria,
  type DeliverableManifestItem,
} from '../../src/lib/qc-scorer';

// Build a run dir on disk seeding the Director's targets + (optionally) a source
// transcript. Returns the deck .pptx path (in an output/ subdir, to also prove
// the upward run-dir walk).
function makeRunDir(opts: {
  slideCountTarget?: number;
  clientRequestedSlideCap?: number;
  sourceLineCount?: number;
  transcriptLines?: number; // write a real transcript.txt with this many lines
}): { runDir: string; pptx: string; cleanup: () => void } {
  const runDir = mkdtempSync(path.join(tmpdir(), 'af-coverage-'));
  const intake: Record<string, unknown> = {};
  if (opts.slideCountTarget !== undefined) intake.slide_count_target = opts.slideCountTarget;
  if (opts.clientRequestedSlideCap !== undefined) intake.client_requested_slide_cap = opts.clientRequestedSlideCap;
  if (opts.sourceLineCount !== undefined) intake.source_line_count = opts.sourceLineCount;
  writeFileSync(path.join(runDir, 'intake.json'), JSON.stringify(intake));

  if (opts.transcriptLines !== undefined) {
    writeFileSync(path.join(runDir, 'transcript.txt'), Array.from({ length: opts.transcriptLines }, (_, i) => `line ${i}`).join('\n'));
  }

  const outputDir = path.join(runDir, 'output');
  mkdirSync(outputDir, { recursive: true });
  const pptx = path.join(outputDir, 'DECK_v1.pptx');
  writeFileSync(pptx, 'PK fake pptx bytes');

  return { runDir, pptx, cleanup: () => rmSync(runDir, { recursive: true, force: true }) };
}

// Build a deliverable manifest with `n` valid slide images plus the .pptx.
function makeManifest(pptx: string, slideImageCount: number): DeliverableManifestItem[] {
  const items: DeliverableManifestItem[] = [
    { title: 'deck', path: pptx, type: 'file', sizeBytes: 1024, dimensions: null, valid: true },
  ];
  for (let i = 0; i < slideImageCount; i++) {
    items.push({
      title: `slide ${i + 1}`,
      path: path.join(path.dirname(pptx), `slide_${String(i + 1).padStart(2, '0')}.png`),
      type: 'image',
      sizeBytes: 50_000,
      dimensions: '1920x1080',
      valid: true,
    });
  }
  return items;
}

// ─────────────────────────────────────────────────────────────────────────────
// (a) Pure gate: compressed ⇒ FAIL; full coverage ⇒ PASS; client cap ⇒ PASS
// ─────────────────────────────────────────────────────────────────────────────

test('AF-COVERAGE (a1) compressed deck (12 of 45, no cap) ⇒ FAIL', () => {
  // The exact reported failure mode: a ~2800-line transcript warranting ~45
  // slides was compressed to 12, with NO client cap on record.
  const r = checkCoverage({
    slideCountTarget: 45,
    clientRequestedSlideCap: null,
    sourceLineCount: 2800,
    actualSlideCount: 12,
  });
  assert.equal(r.pass, false, `a 12-slide deck against a 45-slide target must FAIL: ${r.explanation}`);
  assert.match(r.explanation, /AF-COVERAGE FAIL/);
  assert.match(r.explanation, /12 slide/);
  assert.match(r.explanation, /45/);
  assert.match(r.explanation, /client_requested_slide_cap/);
  console.log('  [AF-COVERAGE a1] compressed FAIL');
});

test('AF-COVERAGE (a2) full-coverage deck (44 of 45) ⇒ PASS', () => {
  const r = checkCoverage({
    slideCountTarget: 45,
    clientRequestedSlideCap: null,
    sourceLineCount: 2800,
    actualSlideCount: 44, // ≥ 90% of 45 (floor = ceil(40.5) = 41)
  });
  assert.equal(r.pass, true, `44 of 45 must PASS (≥ 90%): ${r.explanation}`);
  assert.match(r.explanation, /AF-COVERAGE:/);
  console.log('  [AF-COVERAGE a2] full-coverage PASS');
});

test('AF-COVERAGE (a3) client-requested cap honored (12 with cap 12) ⇒ PASS', () => {
  // The sanctioned small deck: the client explicitly asked for 12 slides.
  const r = checkCoverage({
    slideCountTarget: 45,
    clientRequestedSlideCap: 12,
    sourceLineCount: 2800,
    actualSlideCount: 12,
  });
  assert.equal(r.pass, true, `an explicit client cap of 12 must allow a 12-slide deck: ${r.explanation}`);
  assert.match(r.explanation, /client_requested_slide_cap/);
  console.log('  [AF-COVERAGE a3] client-cap honored PASS');
});

test('AF-COVERAGE (a4) deck EXCEEDS the client cap ⇒ FAIL', () => {
  const r = checkCoverage({
    slideCountTarget: 45,
    clientRequestedSlideCap: 10,
    sourceLineCount: 2800,
    actualSlideCount: 14,
  });
  assert.equal(r.pass, false, 'a deck exceeding the client cap must FAIL');
  assert.match(r.explanation, /EXCEEDING the client_requested_slide_cap/);
  console.log('  [AF-COVERAGE a4] over-cap FAIL');
});

// ─────────────────────────────────────────────────────────────────────────────
// (b) Implausible-target heuristic + fail-closed
// ─────────────────────────────────────────────────────────────────────────────

test('AF-COVERAGE (b1) large source + implausibly low target (no cap) ⇒ FAIL', () => {
  // Even if the deck "meets" its target, a target of 8 for a 2800-line source
  // (and no client cap) is suspected upstream compression of the TARGET itself.
  const r = checkCoverage({
    slideCountTarget: 8,
    clientRequestedSlideCap: null,
    sourceLineCount: 2800,
    actualSlideCount: 8,
  });
  assert.equal(r.pass, false, 'a low target for a large source (no cap) must FAIL as suspected compression');
  assert.match(r.explanation, /suspected compression/);
  console.log('  [AF-COVERAGE b1] implausible-target FAIL');
});

test('AF-COVERAGE (b2) unknown actual slide count ⇒ fail-closed', () => {
  const r = checkCoverage({
    slideCountTarget: 45,
    clientRequestedSlideCap: null,
    sourceLineCount: 2800,
    actualSlideCount: null,
  });
  assert.equal(r.pass, false, 'an unknown actual slide count must block (fail-closed)');
  assert.match(r.explanation, /FAIL-CLOSED/);
  console.log('  [AF-COVERAGE b2] no-actual fail-closed');
});

test('AF-COVERAGE (b3) no target AND no client cap on record ⇒ fail-closed', () => {
  const r = checkCoverage({
    slideCountTarget: null,
    clientRequestedSlideCap: null,
    sourceLineCount: 2800,
    actualSlideCount: 30,
  });
  assert.equal(r.pass, false, 'no content-driven target and no client cap must block (fail-closed)');
  assert.match(r.explanation, /FAIL-CLOSED/);
  console.log('  [AF-COVERAGE b3] no-target fail-closed');
});

test('AF-COVERAGE (b4) short source + low target (no cap) ⇒ PASS (not flagged as compression)', () => {
  // A genuinely short source warrants few slides; the implausible-target check
  // must NOT fire (low false positive).
  const r = checkCoverage({
    slideCountTarget: 6,
    clientRequestedSlideCap: null,
    sourceLineCount: 120,
    actualSlideCount: 6,
  });
  assert.equal(r.pass, true, `a 6-slide deck for a short 120-line source must PASS: ${r.explanation}`);
  console.log('  [AF-COVERAGE b4] short-source low-target PASS');
});

// ─────────────────────────────────────────────────────────────────────────────
// (c) On-disk collector: reads targets from intake.json / mission_prd.json
// ─────────────────────────────────────────────────────────────────────────────

test('AF-COVERAGE (c1) collectCoverageInputs reads slide_count_target + cap from disk; compressed deck ⇒ FAIL', () => {
  const { pptx, cleanup } = makeRunDir({ slideCountTarget: 45, sourceLineCount: 2800 });
  try {
    const inputs = collectCoverageInputs(pptx, 12);
    assert.equal(inputs.slideCountTarget, 45, 'slide_count_target must be read from intake.json');
    assert.equal(inputs.clientRequestedSlideCap, null, 'no cap on record');
    assert.equal(inputs.sourceLineCount, 2800);
    assert.equal(inputs.actualSlideCount, 12);
    assert.equal(checkCoverage(inputs).pass, false, 'a 12-of-45 deck read from disk must FAIL');
    console.log('  [AF-COVERAGE c1] on-disk compressed FAIL');
  } finally {
    cleanup();
  }
});

test('AF-COVERAGE (c2) collectCoverageInputs honors an on-disk client cap; capped deck ⇒ PASS', () => {
  const { pptx, cleanup } = makeRunDir({ slideCountTarget: 45, clientRequestedSlideCap: 12, sourceLineCount: 2800 });
  try {
    const inputs = collectCoverageInputs(pptx, 12);
    assert.equal(inputs.clientRequestedSlideCap, 12, 'client_requested_slide_cap must be read from intake.json');
    assert.equal(checkCoverage(inputs).pass, true, 'a capped 12-slide deck read from disk must PASS');
    console.log('  [AF-COVERAGE c2] on-disk client-cap PASS');
  } finally {
    cleanup();
  }
});

test('AF-COVERAGE (c3) source size measured from transcript.txt when not in JSON', () => {
  const { pptx, cleanup } = makeRunDir({ slideCountTarget: 8, transcriptLines: 2800 });
  try {
    const inputs = collectCoverageInputs(pptx, 8);
    assert.ok((inputs.sourceLineCount ?? 0) >= 2800, 'source size must fall back to measuring transcript.txt');
    assert.equal(checkCoverage(inputs).pass, false, 'low target for a measured-large source must FAIL');
    console.log('  [AF-COVERAGE c3] measured-source FAIL (suspected compression)');
  } finally {
    cleanup();
  }
});

test('AF-COVERAGE (c4) unlocatable run dir / empty path ⇒ fail-closed', () => {
  const empty = collectCoverageInputs('', 30);
  assert.equal(empty.slideCountTarget, null);
  assert.equal(checkCoverage(empty).pass, false, 'empty artifact path must block (fail-closed)');

  const nonexistent = collectCoverageInputs('/nonexistent/path/with/no/run/dir/DECK.pptx', 30);
  assert.equal(nonexistent.slideCountTarget, null);
  assert.equal(checkCoverage(nonexistent).pass, false, 'a path with no run dir must block (fail-closed)');
  console.log('  [AF-COVERAGE c4] fail-closed OK');
});

// ─────────────────────────────────────────────────────────────────────────────
// (d) countDeckSlides: per-slide images from the manifest
// ─────────────────────────────────────────────────────────────────────────────

test('AF-COVERAGE (d) countDeckSlides counts per-slide images, ignoring the .pptx', () => {
  const manifest = makeManifest('/tmp/out/DECK_v1.pptx', 12);
  assert.equal(countDeckSlides(manifest), 12, 'twelve slide images ⇒ 12 slides');

  const noImages: DeliverableManifestItem[] = [
    { title: 'deck', path: '/tmp/out/DECK_v1.pptx', type: 'file', sizeBytes: 1024, dimensions: null, valid: true },
  ];
  assert.equal(countDeckSlides(noImages), null, 'no per-slide images ⇒ uncountable (fail-closed upstream)');
  console.log('  [AF-COVERAGE d] slide count OK');
});

// ─────────────────────────────────────────────────────────────────────────────
// (e) Criterion derivation: deck task gets the gate; lone logo image does not
// ─────────────────────────────────────────────────────────────────────────────

test('AF-COVERAGE (e) deriveAcceptanceCriteria emits coverage for DECK tasks only', () => {
  const deckCrit = deriveAcceptanceCriteria(
    'Build the client webinar deck',
    'Full slide presentation for the launch.',
  );
  assert.ok(
    deckCrit.find((c) => c.type === 'coverage'),
    'a deck/presentation task must carry a coverage criterion',
  );

  const logoCrit = deriveAcceptanceCriteria('Create a company logo image', 'A simple logo, PNG.');
  assert.equal(
    logoCrit.find((c) => c.type === 'coverage'),
    undefined,
    'a standalone logo/image task must NOT be blocked for deck coverage',
  );
  console.log('  [AF-COVERAGE e] deck=%s logo=%s',
    deckCrit.map((c) => c.type).join(','), logoCrit.map((c) => c.type).join(','));
});
