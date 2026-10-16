#!/usr/bin/env npx tsx
/**
 * scripts/guard-silent-terminal-stops.ts — "no card stops permanently in silence".
 *
 * ── The defect this closes ───────────────────────────────────────────────────
 * Every terminal-stop path in this codebase grew its own block writer, and each
 * decided independently whether to tell a human. The answer drifted to "no"
 * wherever nobody was looking: on a live client box an episode card failed at
 * 08:26:27, and eleven hours later `blocked_notice_sent_at` was NULL,
 * `block_reason` was NULL, and the gateway log showed zero outbound sends in
 * that window against a control of 58 sends the rest of that day.
 *
 * `src/lib/stop-card.ts::stopCardPermanently()` is the fix — one function that
 * writes a plain-English reason, persists the machine detail, stamps the notice
 * claim and sends exactly one notification. This guard is what keeps it the
 * ONLY way in: a new terminal write that skips the chokepoint fails the build.
 *
 * ── What this guard enumerates ───────────────────────────────────────────────
 * Every site that parks a card in `blocked`, anywhere under `src/`:
 *
 *   - a raw `UPDATE tasks SET … status = 'blocked' …`, and
 *   - a `transition(<id>, 'blocked', …)` call.
 *
 * Each hit must, within LOOKBACK_LINES lines above it (or on the line itself),
 * either
 *
 *   (a) be part of a `stopCardPermanently(` call — the chokepoint, or
 *   (b) carry an explicit `// SILENT-STOP-EXEMPT: <reason>` annotation.
 *
 * (b) is the point of the design, not a loophole in it. A path that genuinely
 * should not notify — an operator blocking a card by hand, a fixture, an
 * unblock-then-reblock of the same card — states so in code, with a written
 * reason, where a reviewer reads it. Silence becomes a reviewed choice.
 *
 * Two categorical exclusions, both out of the app runtime entirely:
 *   - src/lib/task-lifecycle.ts — the state machine itself (it has no notion of
 *     an audience and cannot notify; it is the mechanism the chokepoint uses).
 *   - src/lib/db/migrations.ts, src/lib/db/schema.ts — DDL / one-time data
 *     migrations, which may run before the schema the chokepoint reads exists.
 *
 * ── Mutation proof ───────────────────────────────────────────────────────────
 * tests/unit/silent-terminal-stop-guard.test.ts plants an unannotated silent
 * block in a scratch tree, asserts this script rejects it, then proves BOTH
 * heals: routing it through stopCardPermanently, and annotating it.
 *
 * Usage:
 *   npx tsx scripts/guard-silent-terminal-stops.ts [--root <path>] [--lookback <n>]
 *
 * Exit codes:
 *   0  PASS — every terminal stop notifies or is annotated.
 *   1  FAIL — a silent terminal stop was found.
 *   2  usage error.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(__dirname, '..');

const EXEMPT_MARKER = 'SILENT-STOP-EXEMPT';
const CHOKEPOINT = 'stopCardPermanently';
const DEFAULT_LOOKBACK_LINES = 15;

const SCANNED_EXTENSIONS = new Set(['.ts', '.tsx']);
const SKIP_DIRS = new Set(['node_modules', '.next', 'dist', 'build', '.git', 'coverage']);

/** Out of the app runtime: the state machine itself, and DDL/migration code. */
const CATEGORICAL_EXCLUSIONS = new Set([
  'lib/task-lifecycle.ts',
  'lib/db/migrations.ts',
  'lib/db/schema.ts',
  // The chokepoint's own implementation — it IS the compliant write.
  'lib/stop-card.ts',
]);

interface Hit {
  file: string;
  line: number;
  snippet: string;
  kind: 'raw-update' | 'transition';
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

/** 1-indexed line number of the character at `index` in `text`. */
function lineOf(text: string, index: number): number {
  return text.slice(0, index).split('\n').length;
}

/**
 * Raw `UPDATE tasks SET …` whose SET clause (up to the first top-level WHERE)
 * assigns status to the literal 'blocked'. Mirrors guard-raw-status-writers.ts'
 * SET-clause isolation so a `WHERE status = 'blocked'` read never false-positives.
 */
function findRawBlockedWrites(text: string): number[] {
  const lines: number[] = [];
  const updateRe = /UPDATE\s+tasks\s+SET/g;
  let m: RegExpExecArray | null;
  while ((m = updateRe.exec(text)) !== null) {
    const setStart = m.index + m[0].length;
    const tail = text.slice(setStart, setStart + 1000);
    const whereMatch = /\bWHERE\b/.exec(tail);
    const setClause = whereMatch ? tail.slice(0, whereMatch.index) : tail.slice(0, 300);
    if (/(?<![a-zA-Z_])status\s*=\s*'blocked'/.test(setClause)) {
      lines.push(lineOf(text, m.index));
    }
  }
  return lines;
}

/** `transition(<anything>, 'blocked'` — the state-machine route into blocked. */
function findTransitionsToBlocked(text: string): number[] {
  const lines: number[] = [];
  // Non-greedy id argument, no newline, so a multi-call line cannot run together.
  const re = /\btransition\s*\(\s*[^,()\n]{1,200},\s*'blocked'/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    lines.push(lineOf(text, m.index));
  }
  return lines;
}

/**
 * The half-open line range [start, end) of the top-level declaration containing
 * `lineNo`. In this repo's formatting a top-level function starts at column 0
 * and its body closes with a `}` at column 0, so scanning outward to the nearest
 * column-0 boundaries brackets exactly one function.
 *
 * Both indices are 0-based into `lines`; `lineNo` is 1-based.
 */
function enclosingBlock(lines: string[], lineNo: number): [number, number] {
  const hitIdx = lineNo - 1;
  let start = hitIdx;
  // Walk back to the first column-0 line that opens something (not a closer).
  while (start > 0 && !(/^[A-Za-z_$@]/.test(lines[start]) && !/^}/.test(lines[start]))) start--;
  let end = hitIdx;
  while (end < lines.length - 1 && !/^\}/.test(lines[end])) end++;
  return [start, Math.min(lines.length, end + 1)];
}

/**
 * A hit is compliant when the chokepoint is called inside the SAME top-level
 * function, or when the site carries a written exemption.
 *
 * Function scope rather than a fixed line window, because a compound writer that
 * owns its own CAS (`recordDispatchFailure`, `blockTaskForQC`) lands the status
 * flip first and then hands the notice half to
 * `stopCardPermanently({ applyBlock: false })` — which, past the audit and
 * block-history writes between them, can be sixty lines below. A fixed window
 * would force those paths into a bogus exemption and hide exactly the sites
 * most worth seeing; a window loose enough to reach them would let an unrelated
 * chokepoint call elsewhere in the file mask a real violation.
 *
 * The exemption window stays ABOVE-only and line-bounded, matching this repo's
 * annotation convention (see scripts/guard-raw-status-writers.ts): a reason for
 * silence is a comment a reviewer reads immediately before the code it excuses.
 */
function isCompliant(text: string, lineNo: number, lookback: number): boolean {
  const allLines = text.split('\n');
  const above = allLines.slice(Math.max(0, lineNo - 1 - lookback), lineNo);
  if (above.some((l) => l.includes(EXEMPT_MARKER))) return true;
  const [start, end] = enclosingBlock(allLines, lineNo);
  return allLines.slice(start, end).some((l) => l.includes(CHOKEPOINT));
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
      'Usage: npx tsx scripts/guard-silent-terminal-stops.ts [--root <path>] [--lookback <n>]',
      '  --root       Directory to scan (must contain a src/ subdirectory).',
      '  --lookback   Lines to search backward for the chokepoint/exemption (default 15).',
    ].join('\n'),
  );
}

function usageError(msg: string): never {
  console.error(`[guard-silent-terminal-stops] ERROR: ${msg}`);
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

  const violations: Hit[] = [];
  const clean: Hit[] = [];

  for (const file of files) {
    const rel = path.relative(root, file).split(path.sep).join('/');
    const relFromSrc = path.relative(srcDir, file).split(path.sep).join('/');
    if (CATEGORICAL_EXCLUSIONS.has(relFromSrc)) continue;

    const text = fs.readFileSync(file, 'utf-8');
    const textLines = text.split('\n');
    const hits: Array<{ line: number; kind: Hit['kind'] }> = [
      ...findRawBlockedWrites(text).map((line) => ({ line, kind: 'raw-update' as const })),
      ...findTransitionsToBlocked(text).map((line) => ({ line, kind: 'transition' as const })),
    ].sort((a, b) => a.line - b.line);

    for (const h of hits) {
      const snippet = textLines[h.line - 1]?.trim().slice(0, 120) ?? '';
      const entry: Hit = { file: rel, line: h.line, snippet, kind: h.kind };
      if (isCompliant(text, h.line, lookback)) clean.push(entry);
      else violations.push(entry);
    }
  }

  console.log(
    `[guard-silent-terminal-stops] scanned ${files.length} file(s) under ${path.relative(root, srcDir) || 'src'}/ ` +
      `(excluding: ${[...CATEGORICAL_EXCLUSIONS].join(', ')})`,
  );
  console.log(
    `[guard-silent-terminal-stops] ${clean.length} terminal-stop write(s) found, all routed through ` +
      `'${CHOKEPOINT}(' or annotated '${EXEMPT_MARKER}:':`,
  );
  for (const c of clean) {
    console.log(`  - ${c.file}:${c.line}  [${c.kind}]`);
  }

  if (violations.length === 0) {
    console.log('[guard-silent-terminal-stops] PASS — no silent terminal stop.');
    process.exit(0);
  }

  console.error(
    `\n[guard-silent-terminal-stops] INVARIANT VIOLATED — ${violations.length} silent terminal stop(s):`,
  );
  for (const v of violations) {
    console.error(`  - ${v.file}:${v.line}  [${v.kind}]  ${v.snippet}`);
  }
  console.error(
    `\nDOCTRINE: "if it's stopped permanently because it failed the prerequisite amount of times, it ` +
      `should not be silent." Every write that parks a card in 'blocked' must route through ` +
      `${CHOKEPOINT}() (src/lib/stop-card.ts), which writes a plain-English block_reason, persists the ` +
      `machine detail, stamps blocked_notice_sent_at and sends exactly one notification. If a path ` +
      `legitimately must NOT notify, say so in code with a '// ${EXEMPT_MARKER}: <reason>' comment ` +
      `within ${lookback} lines above the write, so silence is a reviewed choice and not an accident.`,
  );
  process.exit(1);
}

main();
