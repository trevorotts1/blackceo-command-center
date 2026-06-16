/**
 * Unit-prove the AF-PIPELINE-COMPLETE deck pipeline-completeness gate (v4.48.0)
 * against the REAL exported code in src/lib/qc-scorer.ts (no reimplementation).
 *
 * AF-PIPELINE-COMPLETE closes the operator-shortcut gap: a deck was shipped by
 * hand-feeding a slides.json into build_deck.py (only the Phase-4 renderer + a
 * stripped Phase-8 assembler), which bypassed the entire Presentations pipeline
 * — no research, no copy/image QC gate, and no media-librarian GHL upload — yet
 * a technically-valid .pptx landed on disk and could be moved review→Done.
 *
 * AF-LANG/AF-NUM/AF-SPELL inspect rendered PIXELS; none of them prove the deck
 * went through the pipeline. This gate is a pure FILESYSTEM-presence check, so
 * it is fully unit-provable without any key:
 *
 *   (a) checkPipelineCompleteness (pure) FAILS when any of the three required
 *       records is missing, and PASSES only when all three are present.
 *   (b) collectPipelineRecords reads a real on-disk run dir: a fully-populated
 *       workdir ⇒ all records true ⇒ PASS; a build_deck.py-only run dir (just a
 *       .pptx, no working/ tree) ⇒ all records false ⇒ FAIL (the shortcut).
 *   (c) a media_library.json with a SEED ghl_folder_id:null does NOT count as a
 *       GHL upload (that is the unset Step-0 placeholder).
 *   (d) deriveAcceptanceCriteria emits a pipeline_complete criterion for DECK
 *       tasks and NOT for a standalone single-image (logo) task.
 *   (e) fail-closed: an unlocatable run dir yields an all-false record set.
 *
 * Run: npm run test:vitest  (or: node --import tsx --test)
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';

import {
  checkPipelineCompleteness,
  collectPipelineRecords,
  deriveAcceptanceCriteria,
} from '../../src/lib/qc-scorer';

// Build a canonical Presentations run dir on disk. `opts` selects which records
// to seed so we can prove each missing-record path. Returns the deck .pptx path.
function makeRunDir(opts: {
  research?: boolean;
  researchIncomplete?: boolean;
  qc?: boolean;
  ghl?: boolean;
  ghlSeedNull?: boolean;
}): { runDir: string; pptx: string; cleanup: () => void } {
  const runDir = mkdtempSync(path.join(tmpdir(), 'af-pipeline-'));
  const working = path.join(runDir, 'working');
  mkdirSync(path.join(working, 'research'), { recursive: true });
  mkdirSync(path.join(working, 'qc'), { recursive: true });
  mkdirSync(path.join(working, 'checkpoints'), { recursive: true });
  // The deck artifact sits in an output/ subdir, as a real assembler emits it,
  // so we also prove the upward run-dir walk.
  const outputDir = path.join(runDir, 'output');
  mkdirSync(outputDir, { recursive: true });
  const pptx = path.join(outputDir, 'DECK_v1.pptx');
  writeFileSync(pptx, 'PK fake pptx bytes');

  if (opts.research) {
    writeFileSync(
      path.join(working, 'research', 'brief-deck.md'),
      '# Research brief\n\nresearch_complete: true\n\nCategory A ...',
    );
  } else if (opts.researchIncomplete) {
    // Brief exists but is NOT marked complete → must NOT count.
    writeFileSync(path.join(working, 'research', 'brief-deck.md'), '# Research brief (draft)\nresearch_complete: false\n');
  }
  if (opts.qc) {
    writeFileSync(path.join(working, 'qc', 'copy_qc_report.json'), JSON.stringify({ gate: 'Phase 1Q', average: 9.1 }));
  }
  if (opts.ghl) {
    writeFileSync(
      path.join(working, 'checkpoints', 'media_library.json'),
      JSON.stringify({ version_number: 1, ghl_folder_id: 'fold_abc123', slides: [{ ghl_media_id: 'med_001' }] }),
    );
  } else if (opts.ghlSeedNull) {
    writeFileSync(
      path.join(working, 'checkpoints', 'media_library.json'),
      JSON.stringify({ version_number: 1, ghl_folder_id: null }),
    );
  }

  return { runDir, pptx, cleanup: () => rmSync(runDir, { recursive: true, force: true }) };
}

// ─────────────────────────────────────────────────────────────────────────────
// (a) Pure helper: missing any record ⇒ FAIL; all present ⇒ PASS
// ─────────────────────────────────────────────────────────────────────────────

test('AF-PIPELINE-COMPLETE (a) checkPipelineCompleteness FAILS on any missing record', () => {
  const allPresent = checkPipelineCompleteness({
    researchBriefComplete: true,
    qcLogPresent: true,
    ghlMediaUploadRecorded: true,
  });
  assert.equal(allPresent.pass, true, `all records present must PASS: ${allPresent.explanation}`);
  assert.equal(allPresent.missing.length, 0);

  const noGhl = checkPipelineCompleteness({
    researchBriefComplete: true,
    qcLogPresent: true,
    ghlMediaUploadRecorded: false,
  });
  assert.equal(noGhl.pass, false, 'missing GHL upload record must FAIL — the deck is NOT done');
  assert.match(noGhl.explanation, /NOT done/);
  assert.match(noGhl.explanation, /ghl_media_id|GHL media-upload/);

  const noResearch = checkPipelineCompleteness({
    researchBriefComplete: false,
    qcLogPresent: true,
    ghlMediaUploadRecorded: true,
  });
  assert.equal(noResearch.pass, false, 'missing research brief must FAIL');
  assert.match(noResearch.explanation, /research brief/);

  const noQc = checkPipelineCompleteness({
    researchBriefComplete: true,
    qcLogPresent: false,
    ghlMediaUploadRecorded: true,
  });
  assert.equal(noQc.pass, false, 'missing QC log must FAIL');
  assert.match(noQc.explanation, /QC log/);
  console.log('  [AF-PIPELINE-COMPLETE a] pure gate OK');
});

// ─────────────────────────────────────────────────────────────────────────────
// (b) On-disk collector: full workdir ⇒ PASS; build_deck.py-only ⇒ FAIL
// ─────────────────────────────────────────────────────────────────────────────

test('AF-PIPELINE-COMPLETE (b) full pipeline workdir ⇒ all records present ⇒ PASS', () => {
  const { pptx, cleanup } = makeRunDir({ research: true, qc: true, ghl: true });
  try {
    const records = collectPipelineRecords(pptx);
    assert.equal(records.researchBriefComplete, true, 'completed research brief must be detected');
    assert.equal(records.qcLogPresent, true, 'copy QC log must be detected');
    assert.equal(records.ghlMediaUploadRecorded, true, 'GHL upload record must be detected');
    const cmp = checkPipelineCompleteness(records);
    assert.equal(cmp.pass, true, `fully-populated run dir must PASS: ${cmp.explanation}`);
    console.log('  [AF-PIPELINE-COMPLETE b] full workdir PASS');
  } finally {
    cleanup();
  }
});

test('AF-PIPELINE-COMPLETE (b2) build_deck.py shortcut (.pptx only, no working/ tree) ⇒ FAIL', () => {
  // The exact operator-shortcut failure mode: a bare .pptx with no pipeline
  // records anywhere. The run-dir walk finds no working/ and no media_library →
  // all-false record set → block.
  const dir = mkdtempSync(path.join(tmpdir(), 'af-pipeline-bare-'));
  const pptx = path.join(dir, 'DECK_v1.pptx');
  writeFileSync(pptx, 'PK fake pptx');
  try {
    const records = collectPipelineRecords(pptx);
    assert.deepEqual(
      records,
      { researchBriefComplete: false, qcLogPresent: false, ghlMediaUploadRecorded: false },
      'a bare .pptx with no pipeline records must yield an all-false (blocking) record set',
    );
    assert.equal(checkPipelineCompleteness(records).pass, false, 'the build_deck.py shortcut deck is NOT done');
    console.log('  [AF-PIPELINE-COMPLETE b2] shortcut FAIL (deck NOT done)');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('AF-PIPELINE-COMPLETE (b3) incomplete research brief (research_complete:false) does NOT count', () => {
  const { pptx, cleanup } = makeRunDir({ researchIncomplete: true, qc: true, ghl: true });
  try {
    const records = collectPipelineRecords(pptx);
    assert.equal(records.researchBriefComplete, false, 'a brief that is not research_complete:true must not count');
    assert.equal(checkPipelineCompleteness(records).pass, false, 'incomplete research ⇒ deck NOT done');
    console.log('  [AF-PIPELINE-COMPLETE b3] incomplete-research FAIL');
  } finally {
    cleanup();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// (c) Seed ghl_folder_id:null is NOT a real upload
// ─────────────────────────────────────────────────────────────────────────────

test('AF-PIPELINE-COMPLETE (c) media_library.json with seed ghl_folder_id:null ⇒ no GHL upload', () => {
  const { pptx, cleanup } = makeRunDir({ research: true, qc: true, ghlSeedNull: true });
  try {
    const records = collectPipelineRecords(pptx);
    assert.equal(records.ghlMediaUploadRecorded, false, 'the unset Step-0 placeholder (ghl_folder_id:null) must NOT count');
    assert.equal(checkPipelineCompleteness(records).pass, false, 'seeded-but-not-uploaded ⇒ deck NOT done');
    console.log('  [AF-PIPELINE-COMPLETE c] seed-null FAIL');
  } finally {
    cleanup();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// (d) Criterion derivation: deck task gets the gate; lone logo image does not
// ─────────────────────────────────────────────────────────────────────────────

test('AF-PIPELINE-COMPLETE (d) deriveAcceptanceCriteria emits pipeline_complete for DECK tasks only', () => {
  const deckCrit = deriveAcceptanceCriteria(
    'Build the client webinar deck',
    'Full slide presentation for the launch.',
  );
  assert.ok(
    deckCrit.find((c) => c.type === 'pipeline_complete'),
    'a deck/presentation task must carry a pipeline_complete criterion',
  );

  const logoCrit = deriveAcceptanceCriteria('Create a company logo image', 'A simple logo, PNG.');
  assert.equal(
    logoCrit.find((c) => c.type === 'pipeline_complete'),
    undefined,
    'a standalone logo/image task must NOT be blocked for missing deck-pipeline records',
  );
  console.log('  [AF-PIPELINE-COMPLETE d] deck=%s logo=%s',
    deckCrit.map((c) => c.type).join(','), logoCrit.map((c) => c.type).join(','));
});

// ─────────────────────────────────────────────────────────────────────────────
// (e) Fail-closed: an unlocatable run dir yields an all-false (blocking) set
// ─────────────────────────────────────────────────────────────────────────────

test('AF-PIPELINE-COMPLETE (e) unlocatable run dir / empty path ⇒ fail-closed', () => {
  const empty = collectPipelineRecords('');
  assert.deepEqual(empty, { researchBriefComplete: false, qcLogPresent: false, ghlMediaUploadRecorded: false });
  assert.equal(checkPipelineCompleteness(empty).pass, false, 'empty artifact path must block (fail-closed)');

  const nonexistent = collectPipelineRecords('/nonexistent/path/with/no/working/tree/DECK.pptx');
  assert.equal(checkPipelineCompleteness(nonexistent).pass, false, 'a path with no run dir must block (fail-closed)');
  console.log('  [AF-PIPELINE-COMPLETE e] fail-closed OK');
});
