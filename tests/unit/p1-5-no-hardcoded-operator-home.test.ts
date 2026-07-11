/**
 * Unit test for P1-5 — hardcoded operator home in the CC dispatch runtime.
 *
 * BUG: `src/app/api/tasks/[id]/dispatch/route.ts` and `src/lib/task-dispatcher.ts`
 * used to compute their OpenClaw agents-root path as:
 *
 *     process.env.HOME ?? '<operator's literal home path>'
 *
 * On a box where HOME is unset (PM2/systemd/container contexts — exactly the
 * VPS Docker deploy target), a CLIENT box silently resolved the OPERATOR's own
 * home directory. That is a wrong-path bug (the runtime dir never exists on
 * the client box) AND an operator-identifying string baked into a repo that
 * ships fleet-wide.
 *
 * FIX: both files now resolve the home-relative fallback via `os.homedir()`
 * and honor the existing VPS/Mac split already established in
 * `src/lib/platform.ts` (`detectPlatform()` / the `/data/.openclaw` marker),
 * mirroring the convention already used by `src/lib/context-pack.ts`
 * `agentsRoot()`.
 *
 * This test proves the regression cannot silently return: it walks every file
 * under `src/` and asserts the operator's literal home path never appears —
 * not even in a comment. The pattern below is built as a RegExp (not a plain
 * string literal) precisely so this assertion file cannot itself register as
 * a "hit" if the scan scope were ever widened to include `tests/`.
 *
 * Runs via the Node built-in test runner under tsx (`npm run test:unit`).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// Built from non-contiguous parts + RegExp so the banned literal (or even its
// bare username substring) is never written as a plain contiguous string
// anywhere in this file (see file header — this is intentional).
const BANNED_HOME_PATTERN = new RegExp(
  ['/', 'Users', '/', 'black', 'ceo', 'mac', 'mini'].join(''),
);

const SRC_ROOT = path.resolve(__dirname, '../../src');

const SKIP_DIRS = new Set(['node_modules', '.next', '.git']);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(path.join(dir, entry.name), out);
    } else if (entry.isFile()) {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

test('P1-5: no hardcoded operator home literal anywhere under src/', () => {
  assert.ok(fs.existsSync(SRC_ROOT), `expected src/ to exist at ${SRC_ROOT}`);

  const files = walk(SRC_ROOT);
  assert.ok(files.length > 100, 'sanity: src/ walk should discover a substantial file set');

  const offenders: string[] = [];
  for (const file of files) {
    let content: string;
    try {
      content = fs.readFileSync(file, 'utf8');
    } catch {
      continue; // binary/unreadable — not a source hit
    }
    if (BANNED_HOME_PATTERN.test(content)) {
      offenders.push(path.relative(SRC_ROOT, file));
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `hardcoded operator home literal found in: ${offenders.join(', ')} — ` +
    'use os.homedir() + the platform.ts VPS/Mac convention instead',
  );
});

test('P1-5: dispatch route resolves AGENTS_ROOT via os.homedir(), not a literal fallback', () => {
  const src = fs.readFileSync(
    path.resolve(__dirname, '../../src/app/api/tasks/[id]/dispatch/route.ts'),
    'utf8',
  );
  assert.ok(
    src.includes('os.homedir()'),
    'dispatch/route.ts must fall back to os.homedir(), not a literal path',
  );
  assert.ok(
    !/process\.env\.HOME\s*\?\?\s*['"]\//.test(src),
    'dispatch/route.ts must not use `process.env.HOME ?? "/literal/path"`',
  );
  assert.match(
    src,
    /detectPlatform/,
    'dispatch/route.ts should honor the platform.ts VPS/Mac convention for the agents root',
  );
});

test('P1-5: task-dispatcher resolves AGENTS_ROOT via os.homedir(), not a literal fallback', () => {
  const src = fs.readFileSync(
    path.resolve(__dirname, '../../src/lib/task-dispatcher.ts'),
    'utf8',
  );
  assert.ok(
    src.includes('os.homedir()'),
    'task-dispatcher.ts must fall back to os.homedir(), not a literal path',
  );
  assert.ok(
    !/process\.env\.HOME\s*\?\?\s*['"]\//.test(src),
    'task-dispatcher.ts must not use `process.env.HOME ?? "/literal/path"`',
  );
  assert.match(
    src,
    /detectPlatform/,
    'task-dispatcher.ts should honor the platform.ts VPS/Mac convention for the agents root',
  );
});
