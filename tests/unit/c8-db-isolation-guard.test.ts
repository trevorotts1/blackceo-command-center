/**
 * C8 ROOT-CAUSE GUARD — no test harness may write to the LIVE Command Center DB.
 *
 * This is the lint that stops C8 from happening AGAIN. Everything else in the C8
 * fix (migrations 091/093/094, the API gates, the converge assertion) cleans up
 * or contains residue a harness ALREADY leaked. None of it prevents the NEXT
 * harness from leaking more.
 *
 * The mechanism is one line in src/lib/db/index.ts:
 *
 *     export const DB_PATH = process.env.DATABASE_PATH
 *       || path.join(process.cwd(), 'mission-control.db');
 *
 * It is a module-level `const`: whatever DATABASE_PATH says AT MODULE-EVAL TIME is
 * frozen for the life of the process. A test that reaches that module without
 * having set DATABASE_PATH first silently opens the real, live mission-control.db
 * in the repo root, runs migrations on it, and writes its fixtures straight into a
 * production board. That is exactly how ~30 `test-dept` SOPs, the `smoke-test-dept`
 * / `no-script-dept` workspaces (7 synthetic agents each) and the `testco` company
 * row reached a client's Command Center.
 *
 * TWO ways to get this wrong, and this guard catches BOTH:
 *
 *   1. NO isolation at all (ad-campaigns.test.ts did this — it *documented* that
 *      "the harness MUST set DATABASE_PATH ... Never point this at
 *      mission-control.db" and then trusted a caller to do it. `npm run test:unit`
 *      sets nothing, so it wrote to the live DB on every run.)
 *
 *   2. Isolation that is SILENTLY DEAD because of ES import hoisting — the subtle
 *      one, and the one six suites in this repo were hitting:
 *
 *          import { normalizeTitle } from '../../src/lib/tasks';  // hoisted!
 *          process.env.DATABASE_PATH = TMP_DB;                    // runs too late
 *
 *      `import` declarations are hoisted and evaluated BEFORE any body statement.
 *      lib/tasks imports @/lib/db, so DB_PATH froze to the LIVE path before the
 *      assignment ever ran. The trap is TRANSITIVE and invisible at the call site:
 *      the import looks completely DB-free.
 *
 * The only reliable pattern is to isolate INSIDE AN IMPORT, so it is ordered
 * against the other imports rather than racing them:
 *
 *     import './_isolated-db';   // ← FIRST import; sets DATABASE_PATH to a temp file
 *
 * This guard resolves the real static import graph (not a keyword grep) so it
 * flags the transitive hazard precisely, with no false positives on suites that
 * import DB-free project modules.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TESTS_ROOT = path.resolve(HERE, '..');
const REPO_ROOT = path.resolve(HERE, '../..');
const SRC_ROOT = path.join(REPO_ROOT, 'src');

/** Recursively collect every test file under tests/. */
function collectTestFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'fixtures') continue;
      out.push(...collectTestFiles(full));
      continue;
    }
    if (/\.test\.(ts|tsx|js|mjs)$/.test(entry.name)) out.push(full);
  }
  return out;
}

/** Every STATIC (hoisted, non-type-only) import specifier in a source file. */
function staticImportSpecifiers(src: string): string[] {
  const out: string[] = [];
  // `import ... from 'x'` and bare `import 'x'` — excluding `import type ...`.
  const re = /^\s*import\s+(?!type\b)(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) out.push(m[1]!);
  return out;
}

/** Resolve a project import specifier to a file on disk, or null if external. */
function resolveProjectModule(spec: string, fromFile: string): string | null {
  let base: string;
  if (spec.startsWith('@/')) {
    base = path.join(SRC_ROOT, spec.slice(2));
  } else if (spec.startsWith('.')) {
    base = path.resolve(path.dirname(fromFile), spec);
  } else {
    return null; // npm package or node builtin
  }
  // Only care about modules inside src/ — that's where the db singleton lives.
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.js`,
    path.join(base, 'index.ts'),
    path.join(base, 'index.tsx'),
    path.join(base, 'index.js'),
  ];
  for (const c of candidates) {
    try {
      if (fs.statSync(c).isFile()) return c;
    } catch {
      /* not this one */
    }
  }
  return null;
}

const DB_INDEX_FILES = new Set(
  ['index.ts', 'index.tsx', 'index.js']
    .map((f) => path.join(SRC_ROOT, 'lib', 'db', f))
    .concat([path.join(SRC_ROOT, 'lib', 'db.ts')]),
);

/** Is this resolved file the DB singleton module (the one that freezes DB_PATH)? */
function isDbSingletonModule(file: string): boolean {
  return DB_INDEX_FILES.has(file);
}

const reachCache = new Map<string, boolean>();

/**
 * Following ONLY static imports (the hoisted ones — a dynamic `await import()`
 * inside a module does NOT evaluate at load time), does `file` reach the DB
 * singleton module?
 */
function staticallyReachesDbSingleton(file: string, seen = new Set<string>()): boolean {
  if (isDbSingletonModule(file)) return true;
  const cached = reachCache.get(file);
  if (cached !== undefined) return cached;
  if (seen.has(file)) return false;
  seen.add(file);

  let src: string;
  try {
    src = fs.readFileSync(file, 'utf8');
  } catch {
    return false;
  }

  let reaches = false;
  for (const spec of staticImportSpecifiers(src)) {
    const resolved = resolveProjectModule(spec, file);
    if (!resolved) continue;
    if (staticallyReachesDbSingleton(resolved, seen)) {
      reaches = true;
      break;
    }
  }
  reachCache.set(file, reaches);
  return reaches;
}

/** Does this test reach the DB singleton at all — statically OR dynamically? */
function touchesDbSingleton(testFile: string, src: string): boolean {
  const byDynamicOrDirect =
    /(?:from|import|require)\s*\(?\s*['"](?:@\/lib\/db|[.\/][^'"]*\/lib\/db)(?:\/index)?['"]/.test(src) ||
    /\bgetDb\s*\(/.test(src);
  return byDynamicOrDirect || staticallyReachesDbSingleton(testFile);
}

/** Isolation via the shared helper — an IMPORT, so it is ordered against other imports. */
function usesIsolationHelper(src: string): boolean {
  return /_isolated-db/.test(src);
}

/** Isolation via a bare `process.env.DATABASE_PATH = ...` in the module BODY. */
function usesBodyIsolation(src: string): boolean {
  return (
    /process\.env\.DATABASE_PATH\s*=/.test(src) ||
    /process\.env\[['"]DATABASE_PATH['"]\]\s*=/.test(src)
  );
}

const testFiles = collectTestFiles(TESTS_ROOT);

test('C8 guard — the scanner actually found the test tree', () => {
  assert.ok(
    testFiles.length > 20,
    `expected to scan a real test tree, found only ${testFiles.length} file(s) — scanner is broken`,
  );
});

// Self-test: the import-graph resolver must actually work, or the two guards below
// are green for the wrong reason (vacuously passing on an empty/failed scan).
test('C8 guard — the import-graph resolver detects a TRANSITIVE db reach', () => {
  const tasksModule = path.join(SRC_ROOT, 'lib', 'tasks.ts');
  assert.ok(fs.existsSync(tasksModule), 'precondition: src/lib/tasks.ts exists');
  assert.ok(
    staticallyReachesDbSingleton(tasksModule),
    'src/lib/tasks must be seen to statically reach @/lib/db — if this fails the resolver is broken ' +
      'and the hoisting guard below is meaningless',
  );

  const pureModule = path.join(SRC_ROOT, 'lib', 'test-residue.ts');
  assert.ok(fs.existsSync(pureModule), 'precondition: src/lib/test-residue.ts exists');
  assert.ok(
    !staticallyReachesDbSingleton(pureModule),
    'src/lib/test-residue is a pure constants module and must NOT be reported as reaching the db — ' +
      'otherwise the guard false-positives on every suite that imports it',
  );
});

test('C8 guard — every test that reaches the DB singleton isolates DATABASE_PATH', () => {
  const offenders: string[] = [];

  for (const file of testFiles) {
    const src = fs.readFileSync(file, 'utf8');
    if (!touchesDbSingleton(file, src)) continue;
    if (usesIsolationHelper(src) || usesBodyIsolation(src)) continue;
    offenders.push(path.relative(TESTS_ROOT, file));
  }

  assert.deepEqual(
    offenders,
    [],
    'These test files reach the DB singleton without isolating DATABASE_PATH at all. They open the ' +
      'LIVE mission-control.db in the repo root and write fixtures straight into a production board — ' +
      'this is the exact C8 leak (test-dept SOPs, smoke-test-dept/no-script-dept workspaces, the ' +
      'testco company row).\n\n' +
      "FIX: add `import './_isolated-db';` as the FIRST import — it points DATABASE_PATH at a unique " +
      'temp file before anything else is evaluated.\n\n' +
      `OFFENDERS:\n  ${offenders.join('\n  ')}`,
  );
});

test('C8 guard — body-assignment isolation is never defeated by a hoisted static db reach', () => {
  const offenders: string[] = [];

  for (const file of testFiles) {
    const src = fs.readFileSync(file, 'utf8');
    // The helper is the SAFE form: it is an import, so it is evaluated in import
    // order — before any project module declared below it.
    if (usesIsolationHelper(src)) continue;
    if (!usesBodyIsolation(src)) continue;
    // Body assignment is only trustworthy if NO statically-imported module
    // transitively pulls in the db singleton (which would be evaluated first).
    if (staticallyReachesDbSingleton(file)) offenders.push(path.relative(TESTS_ROOT, file));
  }

  assert.deepEqual(
    offenders,
    [],
    'These test files isolate by assigning process.env.DATABASE_PATH in the module BODY, but a ' +
      'STATICALLY imported module transitively pulls in @/lib/db. ES `import` declarations are ' +
      'HOISTED, so @/lib/db — and its module-level ' +
      '`DB_PATH = process.env.DATABASE_PATH || <cwd>/mission-control.db` — is evaluated BEFORE the ' +
      'assignment ever runs. The isolation silently does nothing and the LIVE database is opened.\n\n' +
      'The trap is transitive and invisible: `import { normalizeTitle } from "../../src/lib/tasks"` ' +
      'looks DB-free, but lib/tasks imports @/lib/db.\n\n' +
      "FIX: add `import './_isolated-db';` as the FIRST import, and pull project modules in via " +
      '`await import(...)` inside a `test.before(...)` hook if they must see the isolated env.\n\n' +
      `OFFENDERS:\n  ${offenders.join('\n  ')}`,
  );
});
