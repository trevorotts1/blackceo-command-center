#!/usr/bin/env npx tsx
/**
 * scripts/guard-department-optout-wiring.ts — U110 (E5-5) send-back D3-R2:
 * "the clause that prevents that 500 is untested ... revert the entire route
 * wiring -> 6/6 green AND tsc clean."
 *
 * ── The defect this closes ───────────────────────────────────────────────────
 * The QC judge proved (round 2, mutation 3) that reverting ONLY
 * `src/app/api/system/converge/route.ts` to its pre-U110 shape — deleting the
 * `readDepartmentOptoutIds()` / `syncDepartmentOptoutArchive()` calls, the
 * `result.department_optout` response surface, and the second
 * (`optedOut`) argument to `listChosenDepartmentIds()` — leaves the unit's own
 * test suite at 6/6 GREEN and `tsc --noEmit` CLEAN, because that second
 * argument is optional-with-a-default. The board-wiring this unit is NAMED
 * for (U110 = "board wiring for a below-floor department set") can be silently
 * deleted from the one call site that matters and nothing in CI notices.
 *
 * ── What this guard enumerates ───────────────────────────────────────────────
 * Reads `src/app/api/system/converge/route.ts` (the ONE call site the U108
 * opt-out consumer is wired into) and asserts FOUR markers are all present:
 *   1. a `readDepartmentOptoutIds(` call — the file is actually read back.
 *   2. a `syncDepartmentOptoutArchive(` call — the opt-out archive pass runs.
 *   3. a `listChosenDepartmentIds(` call site passed TWO arguments (the
 *      declined set AND the opted-out set) — on `origin/main` before U110 this
 *      call took exactly one argument (`declined`); dropping back to one
 *      argument (even though the parameter has a default) is precisely the
 *      silent regression mutation 3 proved untested.
 *   4. a `result.department_optout =` (or `.department_optout:`) assignment —
 *      the opt-out archive result is actually surfaced in the API response,
 *      not computed and discarded.
 *
 * Any missing marker is a VIOLATION — the wiring was silently removed or
 * narrowed — and the guard fails (exit 1). This gives D3-R2's untested clause
 * TEETH: see the mutation proof in
 * tests/unit/department-optout-wiring-guard.test.ts, which plants a
 * route.ts-shaped fixture missing each marker in turn (in a scratch tree) and
 * asserts this script rejects it, then restores it and asserts PASS.
 *
 * Mirrors this repo's OWN established convention for exactly this class of
 * problem (scripts/guard-raw-status-writers.ts,
 * scripts/guard-report-back-invariant.sh) — a static call-site guard, run
 * directly against the tree AND proven by mutation, wired into its own
 * standalone CI job.
 *
 * Usage:
 *   npx tsx scripts/guard-department-optout-wiring.ts [--root <path>] [--target <relative-path>]
 *     --root     Directory to scan (must contain the target file under it).
 *                Defaults to this script's own repo root. Tests pass a
 *                throwaway scratch directory here.
 *     --target   Path (relative to --root) of the file to check. Defaults to
 *                `src/app/api/system/converge/route.ts`. Tests override this
 *                to point at a fixture file with a different name.
 *
 * Exit codes:
 *   0  PASS — all four wiring markers are present in the target file.
 *   1  FAIL — one or more wiring markers are missing (silently removed/narrowed).
 *   2  usage error (bad --root/--target, target file missing).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(__dirname, '..');
const DEFAULT_TARGET = 'src/app/api/system/converge/route.ts';

interface Args {
  root: string;
  target: string;
}

function parseArgs(argv: string[]): Args {
  let root = DEFAULT_ROOT;
  let target = DEFAULT_TARGET;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--root') {
      const v = argv[++i];
      if (!v) usageError('--root requires a path argument');
      root = path.resolve(v);
    } else if (a.startsWith('--root=')) {
      root = path.resolve(a.slice('--root='.length));
    } else if (a === '--target') {
      const v = argv[++i];
      if (!v) usageError('--target requires a path argument');
      target = v;
    } else if (a.startsWith('--target=')) {
      target = a.slice('--target='.length);
    } else if (a === '-h' || a === '--help') {
      printHelp();
      process.exit(0);
    } else {
      usageError(`unknown arg: ${a}`);
    }
  }
  return { root, target };
}

function printHelp(): void {
  console.log(
    [
      'Usage: npx tsx scripts/guard-department-optout-wiring.ts [--root <path>] [--target <relative-path>]',
      '  --root     Directory to scan (must contain the target file under it).',
      '  --target   Path relative to --root (default: src/app/api/system/converge/route.ts).',
    ].join('\n'),
  );
}

function usageError(msg: string): never {
  console.error(`[guard-department-optout-wiring] ERROR: ${msg}`);
  process.exit(2);
}

interface MarkerCheck {
  name: string;
  re: RegExp;
  doctrine: string;
}

const MARKERS: MarkerCheck[] = [
  {
    name: 'readDepartmentOptoutIds() call',
    re: /\breadDepartmentOptoutIds\s*\(/,
    doctrine: 'the U108 provenance-gated opt-out file must be read back on this route.',
  },
  {
    name: 'syncDepartmentOptoutArchive() call',
    re: /\bsyncDepartmentOptoutArchive\s*\(/,
    doctrine: 'the opt-out archive pass must actually run — a ghost column read but never archived is not a fix.',
  },
  {
    name: 'listChosenDepartmentIds() called with the opted-out set (2 arguments)',
    // Matches `listChosenDepartmentIds(<anything without a top-level close-paren>, <anything>)`
    // i.e. at least one top-level comma between the parens — proving a SECOND
    // argument is passed, not merely that the call exists (it existed pre-U110
    // with exactly one argument, `declined`).
    re: /\blistChosenDepartmentIds\s*\(\s*[^,()]+,\s*[^)]+\)/,
    doctrine:
      "chosen must be computed with BOTH the declined set and the opted-out set — dropping back to " +
      "listChosenDepartmentIds(declined) alone silently un-wires the whole fix (the 2nd param has a " +
      'default, so this compiles and even passes the suite — see D3-R2).',
  },
  {
    name: 'department_optout surfaced in the response',
    re: /\bdepartment_optout\s*[:=]/,
    doctrine: 'the opt-out archive result must be surfaced in the API response, not computed and discarded.',
  },
];

function main(): void {
  const { root, target } = parseArgs(process.argv.slice(2));

  const targetPath = path.join(root, target);
  if (!fs.existsSync(targetPath) || !fs.statSync(targetPath).isFile()) {
    usageError(`${targetPath} does not exist (bad --root/--target?)`);
  }

  const text = fs.readFileSync(targetPath, 'utf-8');

  const missing = MARKERS.filter((m) => !m.re.test(text));
  const present = MARKERS.filter((m) => m.re.test(text));

  console.log(`[guard-department-optout-wiring] checked ${path.relative(root, targetPath)}`);
  for (const p of present) {
    console.log(`  OK   - ${p.name}`);
  }

  if (missing.length === 0) {
    console.log(
      '[guard-department-optout-wiring] PASS — the U110 board-wiring call site is intact (all 4 markers present).',
    );
    process.exit(0);
  }

  console.error(
    `\n[guard-department-optout-wiring] INVARIANT VIOLATED — ${missing.length} U110 wiring marker(s) missing from ${target}:`,
  );
  for (const m of missing) {
    console.error(`  MISSING - ${m.name}`);
    console.error(`            ${m.doctrine}`);
  }
  console.error(
    '\nDOCTRINE (U110 send-back D3-R2): the converge route must read the U108 opt-out file, run the ' +
      'opt-out archive pass, compute `chosen` with BOTH the declined and opted-out sets, and surface the ' +
      'result — dropping any one of these compiles cleanly (the 2nd listChosenDepartmentIds argument has a ' +
      'default) and can pass the rest of the suite, which is exactly why a runtime test alone was not enough.',
  );
  process.exit(1);
}

main();
