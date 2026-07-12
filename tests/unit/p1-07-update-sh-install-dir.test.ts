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
 * Run: node --import tsx --test tests/unit/p1-07-update-sh-install-dir.test.ts
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const UPDATE_SH = path.join(REPO_ROOT, 'update.sh');

function makeTmpDir(): string {
  return mkdtempSync(path.join(os.tmpdir(), 'p107-update-sh-'));
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
  return [
    '#!/usr/bin/env bash',
    'set -uo pipefail',
    'fatal() { echo "FATAL: $1"; exit 1; }',
    'success() { echo "$1"; }',
    'warn() { :; }',
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
  mkdirSync(override, { recursive: true });
  writeFileSync(path.join(override, 'package.json'), '{}');
  try {
    const script = extractDetectionScript(readUpdateSh());
    const { stdout, status } = runDetection(script, { HOME: home, CC_APP_DIR: override });
    assert.equal(status, 0, `expected success, got: ${stdout}`);
    assert.match(stdout, new RegExp(`RESOLVED:${override}$`, 'm'));
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(override, { recursive: true, force: true });
  }
});

test('P1-07: fallback autodetection finds the canonical ~/projects/command-center layout (the fix)', () => {
  const home = makeTmpDir();
  const canonical = path.join(home, 'projects', 'command-center');
  mkdirSync(canonical, { recursive: true });
  writeFileSync(path.join(canonical, 'package.json'), '{}');
  try {
    const script = extractDetectionScript(readUpdateSh());
    const { stdout, status } = runDetection(script, { HOME: home });
    assert.equal(status, 0, `expected success, got: ${stdout}`);
    assert.match(stdout, new RegExp(`RESOLVED:${canonical}$`, 'm'));
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
