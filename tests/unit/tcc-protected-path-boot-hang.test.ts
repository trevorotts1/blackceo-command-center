/**
 * tcc-protected-path-boot-hang.test.ts — the AUTHORITATIVE regression proof for
 * the macOS-TCC boot-hang outage (2026-07-14).
 *
 * THE BUG (proven live): a synchronous fs.readdirSync('~/Downloads/…') on the
 * boot path (resolveDepartmentsConfigPath → newestZhcChild) BLOCKED FOREVER
 * inside the kernel because macOS TCC gates open()/opendir() under ~/Downloads
 * for an unprivileged background process — WITHOUT throwing (it awaits a consent
 * prompt no headless process can answer). That single blocked syscall froze the
 * entire Node event loop: the port bound but the server never reached Ready.
 * The box that hit it had a perfectly valid ZERO_HUMAN_COMPANY_DIR that WOULD
 * HAVE WON — it hung on a lower-priority candidate it did not even need, because
 * the resolver built its candidate list EAGERLY.
 *
 * WHY A STRING TEST IS NOT ENOUGH: asserting isTccProtectedPath('~/Downloads/x')
 * === true tests a string helper, not the hang. These tests instead INJECT A
 * READDIR THAT NEVER RETURNS and prove the boot resolver still completes.
 *
 * Test A (in-process, fast) — LAYER 2 (short-circuit): records every path the
 *   resolver passes to fs.readdirSync and asserts it NEVER reads a TCC-protected
 *   path when a higher-priority candidate resolves. FAILS on pre-fix main (the
 *   eager list readdirs ~/Downloads before checking the env candidate).
 *
 * Test B (subprocess) — LAYER 3 (never block boot): runs the REAL resolver in a
 *   child whose fs.readdirSync BLOCKS FOREVER (Atomics.wait) on any protected
 *   path, and asserts the resolver returns the correct high-priority candidate
 *   within a hard wall-clock bound. On pre-fix main the child hangs forever and
 *   the wall-clock kills it → the assertion fails. On the fix it returns
 *   instantly. This is the true "readdirSync never returns → boot still
 *   completes" proof.
 *
 * Test C (subprocess) — LAYER 3 (bounded primitive): proves safe-fs's bounded
 *   probe itself cannot hang: with a 1ms budget a protected-path read is
 *   abandoned and returns [] while recording a degraded probe, instead of
 *   freezing. (A functional proof of the new primitive.)
 *
 * Runs under the Node built-in runner via `npm run test:unit`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { resolveDepartmentsConfigPath } from '../../src/lib/db/migrations';
import { isTccProtectedPath } from '../../src/lib/fs/safe-fs';

const REPO_ROOT = process.cwd();
const MIGRATIONS_TS = path.join(REPO_ROOT, 'src', 'lib', 'db', 'migrations.ts');
const SAFE_FS_TS = path.join(REPO_ROOT, 'src', 'lib', 'fs', 'safe-fs.ts');

function makeCompanyFixture(): { dir: string; configPath: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tcc-company-'));
  const configPath = path.join(dir, 'departments.json');
  fs.writeFileSync(
    configPath,
    JSON.stringify([{ id: 'marketing', name: 'Marketing' }]),
  );
  return { dir, configPath };
}

function looksProtected(p: string): boolean {
  return /[/\\](Downloads|Desktop|Documents)([/\\]|$)/.test(p) || p.startsWith('/Volumes');
}

/* ───────────────────────── Test A — Layer 2 short-circuit ───────────────── */

test('LAYER 2: resolveDepartmentsConfigPath short-circuits — never readdirs a TCC-protected path when a higher-priority candidate resolves', () => {
  const { dir, configPath } = makeCompanyFixture();
  const prevEnv = process.env.ZERO_HUMAN_COMPANY_DIR;
  const prevCcRoot = process.env.BLACKCEO_COMMAND_CENTER_ROOT;
  process.env.ZERO_HUMAN_COMPANY_DIR = dir; // strongest candidate → must win
  delete process.env.BLACKCEO_COMMAND_CENTER_ROOT;

  const readdirCalls: string[] = [];
  const origReaddir = fs.readdirSync;
  // Record every readdir the resolver attempts. For a protected path we RECORD
  // and return [] WITHOUT touching the real filesystem — so this test never
  // reads (or hangs on) the operator's real ~/Downloads.
  (fs as unknown as { readdirSync: unknown }).readdirSync = ((p: fs.PathLike, opts?: unknown) => {
    const s = String(p);
    readdirCalls.push(s);
    if (looksProtected(s)) return [] as unknown as string[];
    return (origReaddir as (p: fs.PathLike, o?: unknown) => unknown)(p, opts);
  }) as typeof fs.readdirSync;

  try {
    const resolved = resolveDepartmentsConfigPath();
    assert.equal(resolved, configPath, 'the explicit ZERO_HUMAN_COMPANY_DIR candidate must win');
    const protectedReads = readdirCalls.filter(looksProtected);
    assert.deepEqual(
      protectedReads,
      [],
      `resolver must NOT readdir a TCC-protected path when a higher-priority candidate resolves; ` +
        `it read: ${JSON.stringify(protectedReads)}`,
    );
  } finally {
    (fs as unknown as { readdirSync: unknown }).readdirSync = origReaddir;
    if (prevEnv === undefined) delete process.env.ZERO_HUMAN_COMPANY_DIR;
    else process.env.ZERO_HUMAN_COMPANY_DIR = prevEnv;
    if (prevCcRoot !== undefined) process.env.BLACKCEO_COMMAND_CENTER_ROOT = prevCcRoot;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/* ───────────── Test B — Layer 3: readdir blocks forever, boot completes ──── */

test('LAYER 3: resolver completes within bound even when fs.readdirSync BLOCKS FOREVER on every TCC-protected path', () => {
  const { dir, configPath } = makeCompanyFixture();

  // Child: install a readdirSync that NEVER returns on a protected path (the
  // real outage), then run the REAL boot resolver and print its result.
  const childSrc = `
import fs from 'node:fs';
const origReaddir = fs.readdirSync;
fs.readdirSync = ((p, opts) => {
  const s = String(p);
  if (/[/\\\\](Downloads|Desktop|Documents)([/\\\\]|$)/.test(s) || s.startsWith('/Volumes')) {
    // Simulate the TCC opendir() that awaits a consent prompt forever — the
    // exact kernel block that froze the event loop for 13 hours.
    const sab = new Int32Array(new SharedArrayBuffer(4));
    Atomics.wait(sab, 0, 0); // never returns
  }
  return origReaddir(p, opts);
});
const mod = await import(${JSON.stringify(MIGRATIONS_TS)});
const res = mod.resolveDepartmentsConfigPath();
process.stdout.write('RESULT=' + String(res));
`;
  const childFile = path.join(os.tmpdir(), `tcc-boot-child-${process.pid}-${Date.now()}.mjs`);
  fs.writeFileSync(childFile, childSrc);

  try {
    const HARD_BOUND_MS = 20000; // the fix returns in <2s; main hangs forever
    const r = spawnSync(process.execPath, ['--import', 'tsx', childFile], {
      cwd: REPO_ROOT,
      timeout: HARD_BOUND_MS,
      killSignal: 'SIGKILL',
      encoding: 'utf8',
      env: {
        ...process.env,
        ZERO_HUMAN_COMPANY_DIR: dir,
        OWNER_NOTIFY_TELEGRAM_DISABLED: '1',
        DISABLE_CRON: '1',
        // Neutralize any inherited CC-root so the ONLY winning candidate is the
        // explicit company dir (proves the outage box's own situation).
        BLACKCEO_COMMAND_CENTER_ROOT: '',
        MASTER_FILES_DIR: '',
      },
    });

    assert.ok(
      !(r.error && (r.error as NodeJS.ErrnoException).code === 'ETIMEDOUT') && r.signal !== 'SIGKILL',
      `boot resolver HUNG on a forever-blocking readdir (killed after ${HARD_BOUND_MS}ms) — ` +
        `this is the pre-fix outage. stderr: ${r.stderr ?? ''}`,
    );
    assert.equal(r.status, 0, `child exited non-zero. stderr: ${r.stderr ?? ''}`);
    assert.match(
      r.stdout ?? '',
      new RegExp('RESULT=' + configPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      `resolver must still return the valid high-priority candidate. stdout: ${r.stdout ?? ''}`,
    );
  } finally {
    fs.rmSync(childFile, { force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/* ─────────── Test C — Layer 3: the bounded probe cannot itself hang ───────── */

test('LAYER 3: safe-fs bounded probe abandons a protected-path read at the deadline and returns [] (records degraded) instead of hanging', () => {
  // 1ms budget → even a fast protected read is abandoned (node child can't boot
  // in 1ms), proving the probe is hard-bounded and degrades gracefully.
  const childSrc = `
const mod = await import(${JSON.stringify(SAFE_FS_TS)});
// A /Volumes path is classified protected on every platform → routes through
// the bounded child probe. It does not exist, but the 1ms budget guarantees the
// probe is abandoned before it could ever answer.
const out = mod.safeReaddirNames('/Volumes/__tcc_regression_never__');
process.stdout.write('LEN=' + out.length + ';DEGRADED=' + mod.isFilesystemDegraded());
`;
  const childFile = path.join(os.tmpdir(), `tcc-probe-child-${process.pid}-${Date.now()}.mjs`);
  fs.writeFileSync(childFile, childSrc);

  try {
    const r = spawnSync(process.execPath, ['--import', 'tsx', childFile], {
      cwd: REPO_ROOT,
      timeout: 15000, // generous: the probe self-bounds at 1ms, so this is slack
      killSignal: 'SIGKILL',
      encoding: 'utf8',
      env: { ...process.env, TCC_PROBE_TIMEOUT_MS: '1', OWNER_NOTIFY_TELEGRAM_DISABLED: '1' },
    });

    assert.notEqual(r.signal, 'SIGKILL', `bounded probe did not self-bound — parent had to kill it. stderr: ${r.stderr ?? ''}`);
    assert.equal(r.status, 0, `child exited non-zero. stderr: ${r.stderr ?? ''}`);
    assert.match(r.stdout ?? '', /LEN=0;DEGRADED=true/, `expected [] + degraded flag. stdout: ${r.stdout ?? ''}`);
  } finally {
    fs.rmSync(childFile, { force: true });
  }
});

/* ─────────── supplementary: classifier sanity (NOT the regression proof) ─── */

test('supplementary: isTccProtectedPath classifies the protected set (string-level sanity only)', () => {
  const home = process.env.HOME || os.homedir();
  if (process.platform === 'darwin') {
    assert.equal(isTccProtectedPath(path.join(home, 'Downloads', 'x')), true);
    assert.equal(isTccProtectedPath(path.join(home, 'Desktop', 'x')), true);
    assert.equal(isTccProtectedPath(path.join(home, 'Documents', 'x')), true);
    assert.equal(isTccProtectedPath(path.join(home, 'Library', 'Mobile Documents', 'x')), true);
    assert.equal(isTccProtectedPath(path.join(home, '.openclaw', 'master-files')), false);
    assert.equal(isTccProtectedPath(path.join(home, 'clawd', 'zero-human-company')), false);
  }
  // Cross-platform: /Volumes and network mounts are guarded everywhere.
  assert.equal(isTccProtectedPath('/Volumes/USB/x'), true);
  assert.equal(isTccProtectedPath('/data/.openclaw/workspace'), false);
});
