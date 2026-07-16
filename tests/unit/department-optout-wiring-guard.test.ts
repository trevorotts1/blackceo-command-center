/**
 * department-optout-wiring-guard.test.ts — U110 (E5-5) send-back D3-R2:
 * "the clause that prevents that 500 is untested ... revert the entire route
 * wiring -> 6/6 green AND tsc clean" — closes the gap by giving the converge
 * route's opt-out wiring a call-site guard, proven by mutation, mirroring
 * this repo's OWN established pattern (raw-status-writer-guard.test.ts /
 * report-back-invariant.test.ts): run the guard against the REAL tree first,
 * then prove it has teeth by planting a route.ts-shaped fixture with each of
 * the four required markers removed in turn and asserting the guard rejects
 * it, then restoring the marker and asserting PASS.
 *
 * TWO-PART ACCEPTANCE:
 *   (a) STATICALLY — the guard PASSES against the real
 *       src/app/api/system/converge/route.ts: all four U110 wiring markers
 *       (readDepartmentOptoutIds call, syncDepartmentOptoutArchive call,
 *       listChosenDepartmentIds called with 2 arguments, department_optout
 *       surfaced in the response) are present.
 *   (b) MUTATION PROOF — for EACH marker independently: a scratch fixture
 *       missing only that marker FAILS the guard; restoring it PASSES again.
 *       This is what QC's mutation 3 proved missing — reverting the whole
 *       route wiring left the suite green, because no test read route.ts's
 *       own text at all.
 *
 *   node --import tsx --test tests/unit/department-optout-wiring-guard.test.ts
 *   (or: npm run test:unit, which globs this file in automatically)
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../..');
const GUARD = path.join(REPO_ROOT, 'scripts', 'guard-department-optout-wiring.ts');
const TSX_BIN = path.join(REPO_ROOT, 'node_modules', '.bin', 'tsx');
const TARGET_RELATIVE = 'src/app/api/system/converge/route.ts';

function runGuard(args: string[] = []): { status: number | null; stdout: string; stderr: string } {
  const res = spawnSync(TSX_BIN, [GUARD, ...args], { encoding: 'utf8' });
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

function makeScratchTree(): { root: string; dir: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'optout-wiring-guard-fixture-'));
  const dir = path.join(root, 'src', 'app', 'api', 'system', 'converge');
  fs.mkdirSync(dir, { recursive: true });
  return { root, dir };
}

/**
 * A minimal route.ts-shaped fixture carrying all four required markers — the
 * FULLY-WIRED baseline. Each mutation test below removes exactly one marker
 * from a fresh copy of this string.
 */
const FULLY_WIRED = [
  "import { readDepartmentOptoutIds, syncDepartmentOptoutArchive, listChosenDepartmentIds } from '@/lib/workspaces/archive';",
  '',
  'export async function POST() {',
  '  const declined = readHonoredDeclinedIds();',
  '  const optedOut = readDepartmentOptoutIds();',
  '  const optoutArchive = syncDepartmentOptoutArchive(db, optedOut);',
  '  result.department_optout = {',
  '    opted_out: optoutArchive.declined,',
  '  };',
  '  const chosen = listChosenDepartmentIds(declined, optedOut);',
  '  return chosen;',
  '}',
].join('\n');

/** MAIN's pre-U110 shape — origin/main's actual call site before this unit
 * (one argument, no opt-out read/archive/surface at all). This is exactly
 * what QC's mutation 3 reverted route.ts to and found 6/6 still green. */
const PRE_U110_MAIN_SHAPE = [
  "import { listChosenDepartmentIds } from '@/lib/workspaces/archive';",
  '',
  'export async function POST() {',
  '  const declined = readHonoredDeclinedIds();',
  '  const chosen = listChosenDepartmentIds(declined);',
  '  return chosen;',
  '}',
].join('\n');

function writeTarget(dir: string, contents: string): void {
  fs.writeFileSync(path.join(dir, 'route.ts'), contents, 'utf8');
}

test('[STATIC] guard PASSES against the real repository tree — all 4 U110 wiring markers are present in route.ts', () => {
  const { status, stdout, stderr } = runGuard();
  assert.equal(status, 0, `expected PASS against the real tree, got:\n${stdout}${stderr}`);
  assert.match(stdout, /PASS — the U110 board-wiring call site is intact/);
  assert.match(stdout, /OK\s+- readDepartmentOptoutIds\(\) call/);
  assert.match(stdout, /OK\s+- syncDepartmentOptoutArchive\(\) call/);
  assert.match(stdout, /OK\s+- listChosenDepartmentIds\(\) called with the opted-out set \(2 arguments\)/);
  assert.match(stdout, /OK\s+- department_optout surfaced in the response/);
});

test('[STATIC] baseline fixture (fully wired) PASSES against a scratch tree', () => {
  const { root, dir } = makeScratchTree();
  try {
    writeTarget(dir, FULLY_WIRED);
    const result = runGuard(['--root', root, '--target', TARGET_RELATIVE]);
    assert.equal(result.status, 0, `expected PASS on the fully-wired fixture, got:\n${result.stdout}${result.stderr}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('[STATIC][MUTATION PROOF] reverting the ENTIRE route to pre-U110 main shape FAILS the guard on all 4 markers, and restoring it PASSES', () => {
  const { root, dir } = makeScratchTree();
  try {
    writeTarget(dir, PRE_U110_MAIN_SHAPE);
    const reverted = runGuard(['--root', root, '--target', TARGET_RELATIVE]);
    assert.equal(
      reverted.status,
      1,
      `expected the guard to FAIL against the pre-U110 (reverted) route shape, got exit ${reverted.status}:\n${reverted.stdout}${reverted.stderr}`,
    );
    assert.match(reverted.stderr, /INVARIANT VIOLATED/);
    assert.match(reverted.stderr, /MISSING - readDepartmentOptoutIds\(\) call/);
    assert.match(reverted.stderr, /MISSING - syncDepartmentOptoutArchive\(\) call/);
    assert.match(
      reverted.stderr,
      /MISSING - listChosenDepartmentIds\(\) called with the opted-out set \(2 arguments\)/,
    );
    assert.match(reverted.stderr, /MISSING - department_optout surfaced in the response/);

    writeTarget(dir, FULLY_WIRED);
    const restored = runGuard(['--root', root, '--target', TARGET_RELATIVE]);
    assert.equal(
      restored.status,
      0,
      `expected PASS after restoring the full wiring, got exit ${restored.status}:\n${restored.stdout}${restored.stderr}`,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('[STATIC][MUTATION PROOF] dropping the listChosenDepartmentIds() 2nd argument ALONE (the exact D3-R2 mutation) FAILS just that marker, and restoring it PASSES', () => {
  const { root, dir } = makeScratchTree();
  try {
    // Everything else stays wired — ONLY the 2nd argument is dropped, exactly
    // the mutation QC proved compiles clean (the parameter has a default) and
    // left the runtime suite green.
    const narrowed = FULLY_WIRED.replace(
      'listChosenDepartmentIds(declined, optedOut)',
      'listChosenDepartmentIds(declined)',
    );
    assert.notEqual(narrowed, FULLY_WIRED, 'sanity: the replacement must actually change the fixture');
    writeTarget(dir, narrowed);

    const mutated = runGuard(['--root', root, '--target', TARGET_RELATIVE]);
    assert.equal(
      mutated.status,
      1,
      `expected the guard to FAIL when the 2nd argument is dropped, got exit ${mutated.status}:\n${mutated.stdout}${mutated.stderr}`,
    );
    assert.match(
      mutated.stderr,
      /MISSING - listChosenDepartmentIds\(\) called with the opted-out set \(2 arguments\)/,
    );
    // The other three markers are untouched and must still read as present.
    assert.doesNotMatch(mutated.stderr, /MISSING - readDepartmentOptoutIds\(\) call/);
    assert.doesNotMatch(mutated.stderr, /MISSING - syncDepartmentOptoutArchive\(\) call/);
    assert.doesNotMatch(mutated.stderr, /MISSING - department_optout surfaced in the response/);

    writeTarget(dir, FULLY_WIRED);
    const restored = runGuard(['--root', root, '--target', TARGET_RELATIVE]);
    assert.equal(
      restored.status,
      0,
      `expected PASS after restoring the 2nd argument, got exit ${restored.status}:\n${restored.stdout}${restored.stderr}`,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('[STATIC][MUTATION PROOF] deleting the department_optout response surface ALONE FAILS just that marker, and restoring it PASSES', () => {
  const { root, dir } = makeScratchTree();
  try {
    const lines = FULLY_WIRED.split('\n').filter((l) => !l.includes('result.department_optout'));
    const narrowed = lines.join('\n');
    assert.notEqual(narrowed, FULLY_WIRED, 'sanity: the replacement must actually change the fixture');
    writeTarget(dir, narrowed);

    const mutated = runGuard(['--root', root, '--target', TARGET_RELATIVE]);
    assert.equal(
      mutated.status,
      1,
      `expected the guard to FAIL when department_optout is never surfaced, got exit ${mutated.status}:\n${mutated.stdout}${mutated.stderr}`,
    );
    assert.match(mutated.stderr, /MISSING - department_optout surfaced in the response/);

    writeTarget(dir, FULLY_WIRED);
    const restored = runGuard(['--root', root, '--target', TARGET_RELATIVE]);
    assert.equal(
      restored.status,
      0,
      `expected PASS after restoring the response surface, got exit ${restored.status}:\n${restored.stdout}${restored.stderr}`,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('[STATIC] usage error — a missing target file exits 2, not 0 or 1', () => {
  const { root } = makeScratchTree();
  try {
    const result = runGuard(['--root', root, '--target', TARGET_RELATIVE]);
    assert.equal(result.status, 2, `expected usage-error exit 2 for a missing target, got:\n${result.stdout}${result.stderr}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
