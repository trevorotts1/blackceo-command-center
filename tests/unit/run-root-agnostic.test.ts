/**
 * Run-root-agnostic doctrine tests (2026-08-27, OPUS-13).
 *
 * BINDING DOCTRINE under test:
 *   1. PRESENTATION_RUNS_DIRS adds extra run roots while the department-tree
 *      default is kept; "!" makes the list exclusive.
 *   2. A run living ONLY under a configured extra root (e.g.
 *      ~/webinar-decks/<client>/<deck>/<date>/) is discovered by
 *      collectPipelineRecords / collectCoverageInputs — the department tree
 *      is not the only root.
 *   3. An unreadable/missing root is skipped, never fatal, and never reads
 *      as "the run is missing" — the all-false/all-null result stays
 *      UNDETERMINED (fail-closed for the gate, absent-proof for the doctrine).
 *   4. No component blocks a deck purely on a path being absent from one
 *      root when the run lives under another configured root.
 */

// C8 — DB isolation. qc-scorer transitively pulls in '@/lib/db'. This suite
// does not open the DB; './_isolated-db' points DATABASE_PATH at a temp file
// and MUST stay the first import.
import './_isolated-db';

import test from 'node:test';
import assert from 'node:assert/strict';

// node:test shims so the suite runs under BOTH `node --test` (the repo's
// tests/unit runner) and vitest's describe/it shape.
const describe = (name: string, fn: () => void) => fn();
const it = (name: string, fn: () => void) => test(name, fn);

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';

import {
  collectPipelineRecords,
  collectCoverageInputs,
} from '../../src/lib/qc-scorer';
import {
  resolvePresentationRunRoots,
  expandTildeRoot,
} from '../../src/lib/presentation-run-roots';

let tmpDir: string;
let oldEnv: NodeJS.ProcessEnv;

const beforeEach = (fn: () => void) => test.beforeEach(fn);
const afterEach = (fn: () => void) => test.afterEach(fn);

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), 'run-root-agnostic-'));
  oldEnv = { ...process.env };
  // Pin every root resolution to the temp tree so no test reads the real box.
  process.env.HOME = tmpDir;
  delete process.env.PRESENTATION_RUNS_DIRS;
});

afterEach(() => {
  process.env = oldEnv;
  try {
    chmodSync(path.join(tmpDir, 'locked'), 0o755);
  } catch { /* already gone */ }
  rmSync(tmpDir, { recursive: true, force: true });
});

/** A canonical Presentations run dir under an arbitrary root (the extra-root
 *  shape: ~/webinar-decks/<client>/<deck>/<date>/<run>). Returns the .pptx
 *  path that anchors the walk-up. */
function makeRunUnder(root: string, opts: { research?: boolean; qc?: boolean; ghl?: boolean } = {}): string {
  const runDir = path.join(root, 'run-x');
  mkdirSync(path.join(runDir, 'working', 'research'), { recursive: true });
  mkdirSync(path.join(runDir, 'working', 'qc'), { recursive: true });
  mkdirSync(path.join(runDir, 'working', 'checkpoints'), { recursive: true });
  const outputDir = path.join(runDir, 'output');
  mkdirSync(outputDir, { recursive: true });
  const pptx = path.join(outputDir, 'DECK_v1.pptx');
  writeFileSync(pptx, 'PK fake pptx bytes');
  if (opts.research) {
    writeFileSync(path.join(runDir, 'working', 'research', 'brief-deck.md'),
      '# Research brief\n\nresearch_complete: true\n');
  }
  if (opts.qc) {
    writeFileSync(path.join(runDir, 'working', 'qc', 'copy_qc_report.json'),
      JSON.stringify({ pass: true }));
  }
  if (opts.ghl) {
    writeFileSync(path.join(runDir, 'working', 'checkpoints', 'media_library.json'),
      JSON.stringify({ ghl_folder_id: 'fld_123', uploaded: [] }));
  }
  return pptx;
}

describe('resolvePresentationRunRoots — the single documented setting', () => {
  it('defaults to the department tree when PRESENTATION_RUNS_DIRS is unset', () => {
    const roots = resolvePresentationRunRoots();
    assert.deepEqual(roots, [path.join(tmpDir, '.openclaw', 'workspace', 'departments', 'Presentations', 'runs')]);
  });

  it('additive list keeps the department tree first and appends extras', () => {
    process.env.PRESENTATION_RUNS_DIRS = `${tmpDir}/webinar-decks`;
    const roots = resolvePresentationRunRoots();
    assert.ok(roots[0].includes('departments/Presentations/runs'));
    assert.ok(roots.includes(`${tmpDir}/webinar-decks`));
  });

  it('exclusive (!) list contains exactly the configured roots', () => {
    process.env.PRESENTATION_RUNS_DIRS = `!${tmpDir}/a:${tmpDir}/b`;
    const roots = resolvePresentationRunRoots();
    assert.deepEqual(roots, [`${tmpDir}/a`, `${tmpDir}/b`]);
  });

  it('expands ~ against $HOME and dedups', () => {
    process.env.PRESENTATION_RUNS_DIRS = `~/webinar-decks:~/webinar-decks`;
    const roots = resolvePresentationRunRoots();
    assert.equal(roots.filter((r) => r === path.join(tmpDir, 'webinar-decks')).length, 1);
  });

  it('expandTildeRoot expands ~ alone and ~/path', () => {
    assert.equal(expandTildeRoot('~'), tmpDir);
    assert.equal(expandTildeRoot('~/webinar-decks'), path.join(tmpDir, 'webinar-decks'));
    assert.equal(expandTildeRoot('/abs/path'), '/abs/path');
  });
});

describe('collectPipelineRecords — extra-root run discovered (doctrine 2)', () => {
  it('finds a run living ONLY under a configured extra root', () => {
    const extraRoot = path.join(tmpDir, 'webinar-decks', 'client', 'deck', '2026-08-27');
    const pptx = makeRunUnder(extraRoot, { research: true, qc: true, ghl: true });
    process.env.PRESENTATION_RUNS_DIRS = path.join(tmpDir, 'webinar-decks');
    const records = collectPipelineRecords(pptx);
    assert.deepEqual(records, {
      researchBriefComplete: true,
      qcLogPresent: true,
      ghlMediaUploadRecorded: true,
    });
  });

  it('department-tree run still discovered when artifact walk-up fails', () => {
    // Artifact anchored nowhere near the run dir; run lives under the
    // (default) department tree root.
    const deptRoot = path.join(tmpDir, '.openclaw', 'workspace', 'departments', 'Presentations', 'runs');
    const pptx = makeRunUnder(deptRoot, { research: true, qc: true, ghl: true });
    const records = collectPipelineRecords(pptx);
    assert.equal(records.researchBriefComplete, true);
    assert.equal(records.qcLogPresent, true);
    assert.equal(records.ghlMediaUploadRecorded, true);
  });

  it('missing/unreadable extra root is skipped, not fatal, and NOT proof of absence (doctrine 3)', () => {
    const locked = path.join(tmpDir, 'locked');
    mkdirSync(locked, { recursive: true });
    chmodSync(locked, 0o000);
    process.env.PRESENTATION_RUNS_DIRS = `${locked}:${tmpDir}/never-exists`;
    // No run anywhere reachable → all-false = UNDETERMINED (fail-closed),
    // and the unreadable root must not throw.
    const records = collectPipelineRecords('/nonexistent-rrt13/deck.pptx');
    assert.deepEqual(records, {
      researchBriefComplete: false,
      qcLogPresent: false,
      ghlMediaUploadRecorded: false,
    });
  });
});

describe('collectCoverageInputs — extra-root run discovered (doctrine 2)', () => {
  it('reads slide_count_target from intake.json under a configured extra root', () => {
    const extraRoot = path.join(tmpDir, 'webinar-decks', 'client', 'deck', '2026-08-27');
    const runDir = path.join(extraRoot, 'run-x');
    mkdirSync(path.join(runDir, 'output'), { recursive: true });
    writeFileSync(path.join(runDir, 'intake.json'), JSON.stringify({
      slide_count_target: 12,
    }));
    const pptx = path.join(runDir, 'output', 'DECK_v1.pptx');
    writeFileSync(pptx, 'PK fake pptx bytes');
    process.env.PRESENTATION_RUNS_DIRS = path.join(tmpDir, 'webinar-decks');
    const inputs = collectCoverageInputs(pptx, 11);
    assert.equal(inputs.slideCountTarget, 12);
    assert.equal(inputs.actualSlideCount, 11);
  });

  it('nothing found anywhere → all-null targets (UNDETERMINED), never a fabricated verdict', () => {
    process.env.PRESENTATION_RUNS_DIRS = `${tmpDir}/nowhere:${tmpDir}/also-nowhere`;
    const inputs = collectCoverageInputs('/nonexistent-rrt13/deck.pptx', 5);
    assert.equal(inputs.slideCountTarget, null);
    assert.equal(inputs.clientRequestedSlideCap, null);
  });
});