#!/usr/bin/env npx tsx
/**
 * scripts/guard-raw-status-writers.ts — U99 (v1 U9; v1 ref C12.3 item 1;
 * master spec Section E4) — "Raw-writer convergence to transition() + CI
 * guard against new raw `UPDATE tasks SET status` writers."
 *
 * ── The defect this closes ───────────────────────────────────────────────────
 * `task-lifecycle.ts` names it in its own header: raw `UPDATE tasks SET …
 * status` writers exist in the dispatcher, QC scorer, sweeps, PATCH/status/
 * return-to-orchestrator routes, agent-completion + test webhooks,
 * sop-authoring, and execution-watcher — making `task_events` a PARTIAL audit
 * trail. Every status write outside `transition()` is either migrated to it or
 * paired with `recordStatusEvent()` (the DISP-10 "thin variant" transition()
 * itself documents for callers that legitimately cannot route through it — a
 * raw write with extra columns in the same UPDATE, or a multi-status CAS
 * clause `transition()`'s single `expectedFrom` cannot express).
 *
 * ── What this guard enumerates ───────────────────────────────────────────────
 * Every `UPDATE tasks SET …` occurrence, anywhere under `src/`, whose SET
 * clause (the text between `SET` and the first top-level `WHERE`) assigns the
 * `status` column. Two categorical exclusions, both DDL/migration code that
 * cannot run through the app-runtime `transition()` funnel at all (it may run
 * before the schema `transition()` depends on even exists) and is outside the
 * unit's own named scope (dispatcher / QC scorer / sweeps / routes / webhooks
 * / sop-authoring / execution-watcher — never migrations):
 *   - src/lib/task-lifecycle.ts   — the canonical funnel itself.
 *   - src/lib/db/migrations.ts    — one-time, ordered schema/data migrations.
 *   - src/lib/db/schema.ts        — CREATE TABLE / trigger DDL text.
 *
 * ── BINARY ACCEPTANCE (a) + (b) ──────────────────────────────────────────────
 * Every surviving raw writer must carry an in-code `U99-RAW-STATUS-WRITER:`
 * annotation comment within LOOKBACK_LINES lines above the call site — the
 * "in-code-annotated allowlist, each with a written reason" the unit's own
 * acceptance criterion (a) calls for. A raw writer with NO such annotation
 * within reach is a VIOLATION (new/rogue writer) and fails the guard (exit 1)
 * — this is what gives (b) its teeth: see the mutation proof in
 * tests/unit/raw-status-writer-guard.test.ts, which plants an unannotated
 * writer in a scratch tree and asserts this script rejects it.
 *
 * Usage:
 *   npx tsx scripts/guard-raw-status-writers.ts [--root <path>] [--lookback <n>]
 *     --root      Directory to scan (must contain a `src/` subdirectory).
 *                 Defaults to this script's own repo root. Tests pass a
 *                 throwaway scratch directory here.
 *     --lookback  Lines to search backward from each hit for the annotation
 *                 marker (default 15).
 *
 * Exit codes:
 *   0  PASS — every raw status writer outside the exclusions is annotated.
 *   1  FAIL — an unannotated (new/rogue) raw status writer was found.
 *   2  usage error (bad --root, missing src/).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(__dirname, '..');

const ANNOTATION_MARKER = 'U99-RAW-STATUS-WRITER';
const DEFAULT_LOOKBACK_LINES = 15;

const SCANNED_EXTENSIONS = new Set(['.ts', '.tsx']);
const SKIP_DIRS = new Set(['node_modules', '.next', 'dist', 'build', '.git', 'coverage']);

/**
 * Categorically out-of-scope: DDL / one-time-migration code, plus the
 * canonical funnel itself. Paths are relative to `src/`, forward-slash.
 */
const CATEGORICAL_EXCLUSIONS = new Set([
  'lib/task-lifecycle.ts',
  'lib/db/migrations.ts',
  'lib/db/schema.ts',
]);

interface Violation {
  file: string;
  line: number;
  snippet: string;
}

interface CleanHit {
  file: string;
  line: number;
}

function walk(dir: string, out: string[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) walk(full, out);
    } else if (e.isFile() && SCANNED_EXTENSIONS.has(path.extname(e.name))) {
      out.push(full);
    }
  }
}

/**
 * Find every `UPDATE tasks SET …status…` call site in `text` whose SET clause
 * (up to the first top-level WHERE, or a 300-char fallback window when no
 * WHERE follows within 1000 chars) assigns the `status` column. Returns 1-
 * indexed line numbers of the `UPDATE` keyword.
 */
function findRawStatusWriters(text: string): number[] {
  const lines: number[] = [];
  const updateRe = /UPDATE\s+tasks\s+SET/g;
  let m: RegExpExecArray | null;
  while ((m = updateRe.exec(text)) !== null) {
    const setStart = m.index + m[0].length;
    const tail = text.slice(setStart, setStart + 1000);
    const whereMatch = /\bWHERE\b/.exec(tail);
    const setClause = whereMatch ? tail.slice(0, whereMatch.index) : tail.slice(0, 300);
    // Word-boundary-ish: 'status' not preceded by a letter/underscore (so a
    // hypothetical 'sub_status' column would not false-positive).
    if (/(?<![a-zA-Z_])status\s*=/.test(setClause)) {
      const lineNo = text.slice(0, m.index).split('\n').length;
      lines.push(lineNo);
    }
  }
  return lines;
}

function isAnnotated(text: string, lineNo: number, lookback: number): boolean {
  const allLines = text.split('\n');
  // lineNo is 1-indexed; look back `lookback` lines (inclusive of the hit line
  // itself, so an annotation on the same line as `run(` is also caught).
  const startIdx = Math.max(0, lineNo - 1 - lookback);
  const windowLines = allLines.slice(startIdx, lineNo);
  return windowLines.some((l) => l.includes(ANNOTATION_MARKER));
}

interface Args {
  root: string;
  lookback: number;
}

function parseArgs(argv: string[]): Args {
  let root = DEFAULT_ROOT;
  let lookback = DEFAULT_LOOKBACK_LINES;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--root') {
      const v = argv[++i];
      if (!v) usageError('--root requires a path argument');
      root = path.resolve(v);
    } else if (a.startsWith('--root=')) {
      root = path.resolve(a.slice('--root='.length));
    } else if (a === '--lookback') {
      const v = argv[++i];
      if (!v || Number.isNaN(Number(v))) usageError('--lookback requires a numeric argument');
      lookback = Number(v);
    } else if (a.startsWith('--lookback=')) {
      const v = a.slice('--lookback='.length);
      if (Number.isNaN(Number(v))) usageError('--lookback requires a numeric argument');
      lookback = Number(v);
    } else if (a === '-h' || a === '--help') {
      printHelp();
      process.exit(0);
    } else {
      usageError(`unknown arg: ${a}`);
    }
  }
  return { root, lookback };
}

function printHelp(): void {
  console.log(
    [
      'Usage: npx tsx scripts/guard-raw-status-writers.ts [--root <path>] [--lookback <n>]',
      '  --root       Directory to scan (must contain a src/ subdirectory).',
      '  --lookback   Lines to search backward for the annotation marker (default 15).',
    ].join('\n'),
  );
}

function usageError(msg: string): never {
  console.error(`[guard-raw-status-writers] ERROR: ${msg}`);
  process.exit(2);
}

function main(): void {
  const { root, lookback } = parseArgs(process.argv.slice(2));

  const srcDir = path.join(root, 'src');
  if (!fs.existsSync(srcDir) || !fs.statSync(srcDir).isDirectory()) {
    usageError(`${srcDir} does not exist (bad --root?)`);
  }

  const files: string[] = [];
  walk(srcDir, files);
  files.sort();

  const violations: Violation[] = [];
  const clean: CleanHit[] = [];

  for (const file of files) {
    const rel = path.relative(root, file).split(path.sep).join('/');
    const relFromSrc = path.relative(srcDir, file).split(path.sep).join('/');
    if (CATEGORICAL_EXCLUSIONS.has(relFromSrc)) continue;

    const text = fs.readFileSync(file, 'utf-8');
    const hitLines = findRawStatusWriters(text);
    for (const lineNo of hitLines) {
      if (isAnnotated(text, lineNo, lookback)) {
        clean.push({ file: rel, line: lineNo });
      } else {
        const snippet = text.split('\n')[lineNo - 1]?.trim().slice(0, 120) ?? '';
        violations.push({ file: rel, line: lineNo, snippet });
      }
    }
  }

  console.log(
    `[guard-raw-status-writers] scanned ${files.length} file(s) under ${path.relative(root, srcDir) || 'src'}/ ` +
      `(excluding: ${[...CATEGORICAL_EXCLUSIONS].join(', ')})`,
  );
  console.log(
    `[guard-raw-status-writers] ${clean.length} raw status writer(s) found, all annotated with '${ANNOTATION_MARKER}:':`,
  );
  for (const c of clean) {
    console.log(`  - ${c.file}:${c.line}`);
  }

  if (violations.length === 0) {
    console.log('[guard-raw-status-writers] PASS — no unannotated raw status writer outside task-lifecycle.ts.');
    process.exit(0);
  }

  console.error(
    `\n[guard-raw-status-writers] INVARIANT VIOLATED — ${violations.length} unannotated (new/rogue) raw status writer(s):`,
  );
  for (const v of violations) {
    console.error(`  - ${v.file}:${v.line}  ${v.snippet}`);
  }
  console.error(
    '\nDOCTRINE (master spec Section E4, U99): every status write outside transition() must either be ' +
      'migrated to it, or paired with recordStatusEvent() (see task-lifecycle.ts DISP-10) AND annotated ' +
      `with a '// ${ANNOTATION_MARKER}: <reason>' comment within ${lookback} lines above the call site. ` +
      'A raw write with no annotation in reach is treated as a NEW, unaudited status writer — route it ' +
      'through transition()/recordStatusEvent() and annotate it, never a silent add.',
  );
  process.exit(1);
}

main();
