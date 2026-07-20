/**
 * P1-07 (c)2 — update.sh install-dir resolution regression lock.
 *
 * GROUNDED BUG FOUND WHILE WIRING P1-07: update.sh's own autodetect
 * CANDIDATES list (`$HOME/clawd/projects/blackceo-command-center`,
 * `/data/clawd/projects/blackceo-command-center`, `$HOME/blackceo-command-center`,
 * `/data/blackceo-command-center`) never matched the ACTUAL canonical install
 * layout used everywhere else in this repo and the onboarding repo:
 * `~/projects/command-center` (Mac) / `/data/projects/command-center` (VPS) —
 * see scripts/atomic-deploy.sh's mission-control.db resolve list,
 * scripts/watchdog-cc.sh, scripts/seed-workspaces.py,
 * scripts/install/mac-mini-bootstrap.sh, scripts/install/vps-docker-bootstrap.sh,
 * and the onboarding repo's INSTALL.md clone target + DASHBOARD_DIR default.
 * Standalone (autodetect-only) invocation of update.sh would therefore have
 * failed "Command Center not found at any expected install path" on every
 * real box — making it unusable as the P1-07 single canonical update path
 * until fixed.
 *
 * These tests exercise the ACTUAL detection logic extracted from update.sh
 * (not a reimplementation) via a shell fixture harness, proving:
 *   1. CC_APP_DIR env override is honored and skips autodetection entirely.
 *   2. The canonical `~/projects/command-center`-shaped layout is now found
 *      by fallback autodetection (the fix).
 *   3. When nothing matches, the script still fails loudly (fatal, exit 1) —
 *      no silent false-success.
 *
 * TRAP-2 (canary, operator Mac mini) HARDENED THE CONTRACT THESE TESTS LOCK:
 * "is a directory and contains a package.json" used to be the whole test, and
 * the first candidate that matched won. On the operator box
 * `~/projects/command-center` — FIRST in the candidate list — exists as a
 * non-git DATA directory, so any decoy holding a package.json shadows the
 * real checkout, and two real checkouts were resolved by list order with no
 * signal to the operator. Detection now VALIDATES (git worktree ROOT + origin
 * remote is this repo + the app structure this updater drives) and fails
 * closed on zero OR multiple matches. Fixtures below therefore build REAL
 * checkouts; a bare package.json is no longer a Command Center install, and
 * these tests assert that directly:
 *   4. A non-git decoy is rejected, and the real checkout wins.
 *   5. Two validated checkouts = fatal, never a silent first-match pick.
 *   6. A CC_APP_DIR pin that is not a checkout is fatal, never a silent
 *      fall-through to autodetection.
 *
 * Run: node --import tsx --test tests/unit/p1-07-update-sh-install-dir.test.ts
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const UPDATE_SH = path.join(REPO_ROOT, 'update.sh');
const CC_ORIGIN = 'https://github.com/trevorotts1/blackceo-command-center.git';

function makeTmpDir(): string {
  return mkdtempSync(path.join(os.tmpdir(), 'p107-update-sh-'));
}

/**
 * Build a directory that genuinely satisfies update.sh's validation: a git
 * worktree ROOT whose `origin` is this repo, holding the app structure the
 * updater drives. Markers are the ones update.sh actually requires — keep
 * this list in sync with CC_REQUIRED_MARKERS there.
 */
function makeCheckout(dir: string, opts: { origin?: string; pkgName?: string; markers?: boolean } = {}): string {
  const origin = opts.origin ?? CC_ORIGIN;
  const pkgName = opts.pkgName ?? 'mission-control';
  const markers = opts.markers ?? true;
  mkdirSync(dir, { recursive: true });
  const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { stdio: 'ignore' });
  git('init', '-q');
  git('remote', 'add', 'origin', origin);
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: pkgName, version: '0.0.0' }, null, 2));
  if (markers) {
    writeFileSync(path.join(dir, 'next.config.mjs'), '');
    writeFileSync(path.join(dir, 'ecosystem.config.cjs'), '');
    mkdirSync(path.join(dir, 'src'), { recursive: true });
    mkdirSync(path.join(dir, 'scripts'), { recursive: true });
    writeFileSync(path.join(dir, 'scripts', 'atomic-deploy.sh'), '');
    writeFileSync(path.join(dir, 'version'), '0.0.0\n');
  }
  return dir;
}

/** A directory that is NOT a checkout but does hold a package.json — the decoy shape. */
function makeDecoy(dir: string): string {
  mkdirSync(path.join(dir, 'config'), { recursive: true });
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'mission-control' }));
  return dir;
}

/**
 * Extract JUST the install-dir detection block out of update.sh (from the
 * "Detect install location" step header through the `success "Found
 * install at..."` line) into a standalone script that echoes the resolved
 * INSTALL_DIR (or "FATAL" if update.sh's own fatal() would have fired).
 * This exercises the REAL logic living in update.sh — a future edit to it
 * is caught by this test, not a stale reimplementation.
 */
function extractDetectionScript(updateShContents: string): string {
  const startMarker = '# Detect install location';
  const endMarker = 'success "Found install at: $INSTALL_DIR"';
  const startIdx = updateShContents.indexOf(startMarker);
  const endIdx = updateShContents.indexOf(endMarker);
  assert.ok(startIdx >= 0, 'extraction anchor "# Detect install location" not found in update.sh — anchors drifted');
  assert.ok(endIdx >= 0, 'extraction anchor \'success "Found install at: $INSTALL_DIR"\' not found in update.sh — anchors drifted');
  const block = updateShContents.slice(startIdx, endIdx + endMarker.length);
  // The block derives the expected repo slug from REPO_URL, which is defined
  // ABOVE the extraction anchor. Carry the REAL line over rather than
  // hardcoding it, so a change to REPO_URL is reflected here too.
  const repoUrlLine = updateShContents.split('\n').find((l) => /^REPO_URL=/.test(l));
  assert.ok(repoUrlLine, 'REPO_URL= assignment not found in update.sh — anchors drifted');
  return [
    '#!/usr/bin/env bash',
    'set -uo pipefail',
    'fatal() { echo "FATAL: $1"; exit 1; }',
    'success() { echo "$1"; }',
    'warn() { :; }',
    repoUrlLine,
    block,
    'echo "RESOLVED:$INSTALL_DIR"',
  ].join('\n');
}

function readUpdateSh(): string {
  return require('node:fs').readFileSync(UPDATE_SH, 'utf8');
}

function runDetection(script: string, env: NodeJS.ProcessEnv): { stdout: string; status: number | null } {
  const dir = makeTmpDir();
  const scriptPath = path.join(dir, 'detect.sh');
  writeFileSync(scriptPath, script, { mode: 0o755 });
  const result = spawnSync('bash', [scriptPath], { env: { PATH: process.env.PATH, ...env }, encoding: 'utf8' });
  rmSync(dir, { recursive: true, force: true });
  return { stdout: result.stdout, status: result.status };
}

test('P1-07: CC_APP_DIR env override is honored, skipping autodetection', () => {
  const home = makeTmpDir();
  const override = makeTmpDir();
  makeCheckout(override);
  // A checkout the pin must BEAT: autodetection would find this one.
  makeCheckout(path.join(home, 'projects', 'command-center'));
  try {
    const script = extractDetectionScript(readUpdateSh());
    const { stdout, status } = runDetection(script, { HOME: home, CC_APP_DIR: override });
    assert.equal(status, 0, `expected success, got: ${stdout}`);
    // Detection reports the PHYSICAL path (macOS /var -> /private/var).
    assert.match(stdout, new RegExp(`RESOLVED:${realpathSync(override)}$`, 'm'));
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(override, { recursive: true, force: true });
  }
});

test('P1-07: fallback autodetection finds the canonical ~/projects/command-center layout (the fix)', () => {
  const home = makeTmpDir();
  const canonical = path.join(home, 'projects', 'command-center');
  makeCheckout(canonical);
  try {
    const script = extractDetectionScript(readUpdateSh());
    const { stdout, status } = runDetection(script, { HOME: home });
    assert.equal(status, 0, `expected success, got: ${stdout}`);
    assert.match(stdout, new RegExp(`RESOLVED:${realpathSync(canonical)}$`, 'm'));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('TRAP-2: a non-git decoy at the FIRST candidate path never shadows the real checkout', () => {
  // Exactly the operator-Mac-mini shape: ~/projects/command-center exists and
  // is first in the candidate list, but is a data directory, not a checkout.
  const home = makeTmpDir();
  makeDecoy(path.join(home, 'projects', 'command-center'));
  const real = makeCheckout(path.join(home, 'blackceo-command-center'));
  try {
    const script = extractDetectionScript(readUpdateSh());
    const { stdout, status } = runDetection(script, { HOME: home });
    assert.equal(status, 0, `expected success, got: ${stdout}`);
    assert.match(stdout, new RegExp(`RESOLVED:${realpathSync(real)}$`, 'm'));
    assert.doesNotMatch(stdout, /RESOLVED:.*projects\/command-center$/m, `resolved to the decoy: ${stdout}`);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('TRAP-2: a path INSIDE another git repo is not a checkout root and is rejected', () => {
  // ~/clawd/projects/blackceo-command-center is a subdirectory of the ~/clawd
  // repo, whose origin IS this repo — "is git + origin matches" alone would
  // wrongly accept it, which is why the toplevel check exists.
  const home = makeTmpDir();
  makeCheckout(path.join(home, 'clawd'), { markers: false });
  const sub = path.join(home, 'clawd', 'projects', 'blackceo-command-center');
  mkdirSync(sub, { recursive: true });
  writeFileSync(path.join(sub, 'package.json'), JSON.stringify({ name: 'mission-control' }));
  try {
    const script = extractDetectionScript(readUpdateSh());
    const { stdout, status } = runDetection(script, { HOME: home });
    assert.notEqual(status, 0, `expected a fatal exit, got status ${status}: ${stdout}`);
    assert.match(stdout, /not a checkout root/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('TRAP-2: TWO validated checkouts is fatal — never a silent first-match pick', () => {
  const home = makeTmpDir();
  makeCheckout(path.join(home, 'projects', 'command-center'));
  makeCheckout(path.join(home, 'blackceo-command-center'));
  try {
    const script = extractDetectionScript(readUpdateSh());
    const { stdout, status } = runDetection(script, { HOME: home });
    assert.notEqual(status, 0, `expected a fatal exit, got status ${status}: ${stdout}`);
    assert.match(stdout, /Ambiguous install location: 2/);
    // Both must be named so the operator can pick one.
    assert.match(stdout, new RegExp(realpathSync(path.join(home, 'projects', 'command-center'))));
    assert.match(stdout, new RegExp(realpathSync(path.join(home, 'blackceo-command-center'))));
    assert.match(stdout, /CC_APP_DIR=/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('TRAP-2: a symlinked alias of ONE checkout is not ambiguity', () => {
  const home = makeTmpDir();
  const real = makeCheckout(path.join(home, 'blackceo-command-center'));
  mkdirSync(path.join(home, 'projects'), { recursive: true });
  require('node:fs').symlinkSync(real, path.join(home, 'projects', 'command-center'));
  try {
    const script = extractDetectionScript(readUpdateSh());
    const { stdout, status } = runDetection(script, { HOME: home });
    assert.equal(status, 0, `expected success, got: ${stdout}`);
    assert.match(stdout, new RegExp(`RESOLVED:${realpathSync(real)}$`, 'm'));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('TRAP-2: a CC_APP_DIR pin that is not a checkout is fatal, not a silent fall-through', () => {
  const home = makeTmpDir();
  const decoy = makeDecoy(makeTmpDir());
  // A perfectly good checkout autodetection WOULD have found — the point is
  // that a wrong pin must be reported, not quietly replaced by a guess.
  makeCheckout(path.join(home, 'projects', 'command-center'));
  try {
    const script = extractDetectionScript(readUpdateSh());
    const { stdout, status } = runDetection(script, { HOME: home, CC_APP_DIR: decoy });
    assert.notEqual(status, 0, `expected a fatal exit, got status ${status}: ${stdout}`);
    assert.match(stdout, /is not a Command Center checkout/);
    assert.doesNotMatch(stdout, /RESOLVED:.+/, `fell through to autodetection: ${stdout}`);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(decoy, { recursive: true, force: true });
  }
});

test('TRAP-2: a checkout of a DIFFERENT repo is rejected', () => {
  const home = makeTmpDir();
  makeCheckout(path.join(home, 'projects', 'command-center'), {
    origin: 'https://github.com/trevorotts1/some-other-repo.git',
  });
  try {
    const script = extractDetectionScript(readUpdateSh());
    const { stdout, status } = runDetection(script, { HOME: home });
    assert.notEqual(status, 0, `expected a fatal exit, got status ${status}: ${stdout}`);
    assert.match(stdout, /origin remote is a different repo/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('TRAP-2: this repo, but without the app structure the updater drives, is rejected', () => {
  const home = makeTmpDir();
  makeCheckout(path.join(home, 'projects', 'command-center'), { markers: false });
  try {
    const script = extractDetectionScript(readUpdateSh());
    const { stdout, status } = runDetection(script, { HOME: home });
    assert.notEqual(status, 0, `expected a fatal exit, got status ${status}: ${stdout}`);
    assert.match(stdout, /app structure is incomplete/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('P1-07: no match anywhere -> fatal, non-zero exit, no silent false-success', () => {
  const home = makeTmpDir();
  try {
    const script = extractDetectionScript(readUpdateSh());
    const { stdout, status } = runDetection(script, { HOME: home });
    assert.notEqual(status, 0, `expected a non-zero (fatal) exit, got status ${status}: ${stdout}`);
    assert.match(stdout, /FATAL/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('P1-07 FAIL-FIRST PROOF: this exact scenario 2 fails against the pre-fix CANDIDATES list', () => {
  // Reconstructs the ORIGINAL (pre-P1-07) CANDIDATES list verbatim and proves
  // it does NOT find the canonical ~/projects/command-center layout — the
  // grounded bug this fix closes. This does not read git history; it asserts
  // against the literal old list so the proof is self-contained and stable.
  const home = makeTmpDir();
  const canonical = path.join(home, 'projects', 'command-center');
  mkdirSync(canonical, { recursive: true });
  writeFileSync(path.join(canonical, 'package.json'), '{}');
  const preFixScript = [
    '#!/usr/bin/env bash',
    'set -uo pipefail',
    'fatal() { echo "FATAL: $1"; exit 1; }',
    'success() { echo "$1"; }',
    'CANDIDATES=(',
    '  "$HOME/clawd/projects/blackceo-command-center"',
    '  "/data/clawd/projects/blackceo-command-center"',
    '  "$HOME/blackceo-command-center"',
    '  "/data/blackceo-command-center"',
    ')',
    'INSTALL_DIR=""',
    'for c in "${CANDIDATES[@]}"; do',
    '  if [ -d "$c" ] && [ -f "$c/package.json" ]; then',
    '    INSTALL_DIR="$c"',
    '    break',
    '  fi',
    'done',
    'if [ -z "$INSTALL_DIR" ]; then',
    '  fatal "Command Center not found at any expected install path. Cannot update."',
    'fi',
    'success "Found install at: $INSTALL_DIR"',
    'echo "RESOLVED:$INSTALL_DIR"',
  ].join('\n');
  try {
    const { stdout, status } = runDetection(preFixScript, { HOME: home });
    assert.notEqual(status, 0, `pre-fix CANDIDATES list unexpectedly succeeded (bug not reproduced): ${stdout}`);
    assert.match(stdout, /FATAL/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
