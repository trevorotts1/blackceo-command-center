/**
 * QR-008 — cli-probe's PATH fallback must actually search PATH.
 *
 * The defect (REVR-010 L6): `resolveCliBinary`'s docstring promised a
 * login-shell-style lookup, but the body walked a frozen four-directory list
 * (~/.local/bin, /opt/homebrew/bin, /usr/local/bin, ~/.npm-global/bin) and
 * never read the process's own PATH. A CLI installed anywhere else on the
 * login PATH — ~/bin on this box holds adb/fastboot — was reported absent.
 *
 * These tests pin all three required properties:
 *   1. A binary that exists ONLY in a PATH directory outside the fixed list
 *      resolves to that exact path (`command -v` equivalence).
 *   2. A genuinely absent name still returns null.
 *   3. QR-002 additivity: every name the fixed list already resolved still
 *      resolves to the SAME path (the fixed list is scanned first), and a
 *      registered path that still exists is never swapped for a same-named
 *      binary found elsewhere (stale-path rule, not weakened).
 *
 * Runs via the repo's node:test runner under node 20:
 *   PATH=/opt/homebrew/opt/node@20/bin:$PATH \
 *     node --import tsx --test tests/unit/qr008-cli-probe-path-lookup.test.ts
 */

import './_isolated-db';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveCliBinary } from '../../src/lib/probes/cli-probe';

const HOME = os.homedir();

/** The fixed list as it stood BEFORE QR-008 (QR-002's four directories). */
const PRE_QR008_DIRS = [
  path.join(HOME, '.local', 'bin'),
  '/opt/homebrew/bin',
  '/usr/local/bin',
  path.join(HOME, '.npm-global', 'bin'),
];

/** Old resolver, reimplemented here so additivity is asserted, not assumed. */
function preQr008Resolve(bare: string): string | null {
  for (const dir of PRE_QR008_DIRS) {
    const candidate = path.join(dir, bare);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // not here
    }
  }
  return null;
}

// ── fixtures ────────────────────────────────────────────────────────────────

/** Create an executable stub binary in a fresh temp dir; returns [dir, bin]. */
function makeFixtureBin(name: string, mode = 0o755): { dir: string; bin: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ltrn-qr8-'));
  const bin = path.join(dir, name);
  fs.writeFileSync(bin, '#!/bin/sh\nexit 0\n', { mode });
  return { dir, bin };
}

/** Run fn with `dirs` PREPENDED to process.env.PATH, then restore it. */
function withPathPrefix<T>(dirs: string[], fn: () => T): T {
  return withPathExact([...dirs, process.env.PATH ?? ''].join(path.delimiter), fn);
}

/** Run fn with process.env.PATH REPLACED by `value`, then restore it. */
function withPathExact<T>(value: string, fn: () => T): T {
  const original = process.env.PATH;
  process.env.PATH = value;
  try {
    return fn();
  } finally {
    process.env.PATH = original;
  }
}

// ── 1. the defect: PATH-only binary must resolve ─────────────────────────────

test('QR-008: binary living ONLY in a PATH dir outside the fixed list resolves', () => {
  const name = `qr008-pathonly-${process.pid}-${Date.now()}`;
  const { dir, bin } = makeFixtureBin(name);

  // The fixture dir is on no fixed-list directory, and the name is unique.
  assert.equal(preQr008Resolve(name), null, 'fixture must be outside the fixed list');

  const resolved = withPathPrefix([dir], () => resolveCliBinary(null, name));
  assert.equal(
    resolved,
    bin,
    `PATH-only binary must resolve to ${bin}; got ${String(resolved)}`
  );
});

test('QR-008: the measured box case — ~/bin resolves under pm2-shaped minimal PATH', () => {
  // The reviewed defect, verbatim: adb + fastboot live in ~/bin, which was on
  // no fixed-list directory. Reproduce the PRODUCTION shape: pm2 pins a minimal
  // PATH with no ~/bin entry, so process.env.PATH alone cannot find them — the
  // login-shell harvest must supply ~/bin. Nothing is written to ~/bin.
  const adb = path.join(HOME, 'bin', 'adb');
  if (!fs.existsSync(adb)) {
    // Honest skip on a box without the Android tools: the mechanism is covered
    // by the fixture test above regardless of what is installed here.
    return;
  }
  const resolved = withPathExact('/usr/bin:/bin:/usr/sbin:/sbin', () =>
    resolveCliBinary(null, 'adb')
  );
  assert.equal(resolved, adb, `adb must resolve to ${adb} even without ~/bin on PATH`);
});

// ── 2. absent stays absent ───────────────────────────────────────────────────

test('QR-008: a genuinely absent name still returns null', () => {
  const name = `qr008-absent-${process.pid}-${Date.now()}`;
  assert.equal(preQr008Resolve(name), null);
  assert.equal(resolveCliBinary(null, name), null);
});

// ── 3. QR-002 additivity + stale-path rule intact ────────────────────────────

test('QR-008: QR-002 names still resolve to the SAME path as before', () => {
  const names = ['pm2', 'pm2-runtime', 'vercel', 'ccr', 'gws', 'node'];

  for (const name of names) {
    // (a) Additivity: whenever the pre-QR-008 list could resolve the name, the
    // new resolver returns the byte-identical path — the fixed list is scanned
    // before PATH, so PATH can never hijack an existing verdict.
    const before = preQr008Resolve(name);
    if (before) {
      assert.equal(resolveCliBinary(null, name), before, `${name} regressed`);
    }
  }

  // (b) Non-vacuous on this box: the npm-global tools really are installed and
  // really do resolve to their npm-global path (QR-002's fix, preserved).
  for (const name of ['pm2', 'pm2-runtime', 'vercel', 'ccr', 'gws']) {
    const installed = path.join(HOME, '.npm-global', 'bin', name);
    if (fs.existsSync(installed)) {
      assert.equal(
        resolveCliBinary(null, name),
        installed,
        `${name} must resolve to ${installed}`
      );
    }
  }
});

test('QR-008: an existing registered path is never swapped for a PATH shadow', () => {
  const name = `qr008-shadow-${process.pid}-${Date.now()}`;
  const stored = makeFixtureBin(name); // the registered path, still executable
  const shadowDir = makeFixtureBin(name).dir; // same basename, earlier on PATH

  const resolved = withPathPrefix([shadowDir], () =>
    resolveCliBinary(stored.bin, name)
  );
  assert.equal(resolved, stored.bin, 'stored path must win while it still exists');
});

test('QR-008: a non-executable candidate is not resolved (X_OK check kept)', () => {
  const name = `qr008-noexec-${process.pid}-${Date.now()}`;
  const { dir } = makeFixtureBin(name, 0o644); // exists on PATH, not executable

  const resolved = withPathPrefix([dir], () => resolveCliBinary(null, name));
  assert.equal(resolved, null, `non-executable ${name} must not resolve`);
});
