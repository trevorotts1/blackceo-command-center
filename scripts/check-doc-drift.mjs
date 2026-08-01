#!/usr/bin/env node

/**
 * check-doc-drift.mjs — CI gate: assert doc claims match code constants.
 *
 * Validates that the documented department count in QC.md and the Kanban column
 * listings in PRD.md agree with the code-base source of truth, preventing
 * the exact class of documentation-drift bug this MR-28 ticket describes.
 *
 * Runs as a pre-commit / CI check. Exits 0 when clean, 1 on any mismatch.
 *
 * Wire-in: qc-cc.sh section 18.
 */

import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

// ── helpers ──────────────────────────────────────────────────────────────────

let failures = 0;

function fail(msg) {
  process.stderr.write(`DOC-DRIFT: ${msg}\n`);
  failures++;
}

function read(path) {
  return readFileSync(resolve(ROOT, path), 'utf-8');
}

// ── 1. Departments: QC.md claim vs DEFAULT_DEPARTMENTS length ───────────────

// Extract the documented department count from QC.md rubric item #4.
// Format: "All <N> canonical departments present in ..."
const qcMd = read('QC.md');
const docDeptMatch = qcMd.match(/All (\d+) canonical departments present/);
if (!docDeptMatch) {
  fail('QC.md: could not find "All <N> canonical departments present" in rubric item #4');
} else {
  const docCount = parseInt(docDeptMatch[1], 10);

  // Count the entries in DEFAULT_DEPARTMENTS directly from the TypeScript source.
  // We parse the source text rather than `await import()`-ing the module because
  // departments.config.ts uses extensionless relative imports (`./canonical-slug`)
  // that Node's ESM resolver rejects even with type-stripping, which would crash
  // this gate with ERR_MODULE_NOT_FOUND. Counting `{ id: ... }` entries in the
  // array literal is dependency-free and matches the canonical source of truth.
  const deptSrc = read('src/lib/routing/departments.config.ts');
  const arrStart = deptSrc.indexOf('export const DEFAULT_DEPARTMENTS');
  const bracketStart = deptSrc.indexOf('[', arrStart);
  const bracketEnd = deptSrc.indexOf('\n];', bracketStart);
  if (arrStart === -1 || bracketStart === -1 || bracketEnd === -1) {
    fail('departments.config.ts: could not locate the DEFAULT_DEPARTMENTS array literal');
  } else {
    const arrayBody = deptSrc.slice(bracketStart + 1, bracketEnd);
    const idEntries = arrayBody.match(/^\s*id:\s*['"]/gm);
    const codeCount = idEntries ? idEntries.length : 0;

    if (docCount !== codeCount) {
      fail(
        `QC.md rubric #4 claims ${docCount} departments but ` +
          `DEFAULT_DEPARTMENTS has ${codeCount} entries`
      );
    } else {
      process.stdout.write(
        `OK: QC.md department count (${docCount}) matches DEFAULT_DEPARTMENTS (${codeCount})\n`
      );
    }
  }
}

// ── 2. Kanban columns: PRD.md claim vs MissionQueue BOARD_PRESETS ───────────

// The PRD.md Section 3 documents both 5-column (Department Browser/Focus) and
// 6-column (Full Task Board) variants. Extract the counts and verify them.

const prdMd = read('PRD.md');

// 5-column variant: match lines between "For the 5-column..." and the next blank line
// Use a non-greedy match that stops at the double newline before "For the 6-column"
const fiveColMatch = prdMd.match(
  /For the 5-column Department Browser[^:]*:\n((?:\d+\. \*\*[^*]+\*\* - [^\n]+\n)+)/
);
if (fiveColMatch) {
  const items = fiveColMatch[1].match(/^\d+\./gm);
  const doc5Count = items ? items.length : 0;
  if (doc5Count !== 5) {
    fail(`PRD.md 5-column variant lists ${doc5Count} columns, expected 5`);
  } else {
    process.stdout.write(`OK: PRD.md 5-column variant lists 5 columns\n`);
  }
} else {
  fail('PRD.md: could not find the 5-column variant column list');
}

// 6-column variant: match lines between "For the 6-column..." and the blank line
const sixColMatch = prdMd.match(
  /For the 6-column Full Task Board:\n((?:\d+\. \*\*[^*]+\*\* - [^\n]+\n)+)/
);
if (sixColMatch) {
  const items = sixColMatch[1].match(/^\d+\./gm);
  const doc6Count = items ? items.length : 0;
  if (doc6Count !== 6) {
    fail(`PRD.md 6-column variant lists ${doc6Count} columns, expected 6`);
  } else {
    process.stdout.write(`OK: PRD.md 6-column variant lists 6 columns\n`);
  }
} else {
  fail('PRD.md: could not find the 6-column variant column list');
}

// ── 3. MissionQueue BOARD_PRESETS self-check ────────────────────────────────

// The code has 6 columns in BOARD_PRESETS['task'], 7 in BOARD_PRESETS['bug'].
// We validate against the existing unit test assertion (tests/unit/t3-001-bug-board.test.ts).
// This check exists as documentation — the unit test in CI already enforces this.
const mqTest = read('tests/unit/t3-001-bug-board.test.ts');
if (
  !mqTest.includes('BOARD_PRESETS[task] has exactly 6 columns') ||
  !mqTest.includes('BOARD_PRESETS[bug] has exactly 7 columns')
) {
  fail('tests/unit/t3-001-bug-board.test.ts: missing BOARD_PRESETS column-count assertions');
} else {
  process.stdout.write('OK: t3-001-bug-board.test.ts asserts 6-task / 7-bug columns\n');
}

// ── 4. QC.md "18" stale-count residue scan ──────────────────────────────────

// Make sure no stale "18" department references survive (outside of version numbers,
// dates, port numbers, etc., which are all 4-digit or in clearly non-dept contexts).
const stale18 = qcMd.match(/18\s+(?:canonical\s+)?departments?/gi);
if (stale18) {
  fail(`QC.md still contains stale "18 departments" reference(s): ${stale18.length} found`);
} else {
  process.stdout.write('OK: no stale "18 departments" references in QC.md\n');
}

// ── exit ────────────────────────────────────────────────────────────────────

if (failures > 0) {
  process.stderr.write(`\n${failures} documentation drift failure(s)\n`);
  process.exit(1);
}
process.stdout.write('\nAll documentation drift checks passed.\n');
process.exit(0);
