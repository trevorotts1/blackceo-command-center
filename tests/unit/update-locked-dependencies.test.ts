import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(__dirname, '../..');
const updater = readFileSync(path.join(root, 'update.sh'), 'utf8');

function section(start: string, end: string): string {
  const from = updater.indexOf(start);
  const to = updater.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `Updater section missing: ${start}`);
  return updater.slice(from, to + end.length);
}

// Execute the actual updater's preflight and dependency-install section with
// fake executables. No checkout, package installation, database or server runs.
const preflight = section('# Node runtime preflight', '# End Node runtime preflight');
const install = section('step "Step 4: Install npm dependencies"', 'success "Dependencies installed"');

function runFixture(options: { lock?: boolean; ciStatus?: number; nodeVersion?: string } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cc-update-locked-'));
  const bin = path.join(dir, 'bin');
  const calls = path.join(dir, 'calls');
  mkdirSync(bin);
  const lock = '{"lockfileVersion":3,"packages":{}}\n';
  if (options.lock !== false) writeFileSync(path.join(dir, 'package-lock.json'), lock);
  writeFileSync(path.join(bin, 'node'), '#!/bin/sh\nprintf "%s\\n" "$FIXTURE_NODE_VERSION"\n', { mode: 0o755 });
  writeFileSync(path.join(bin, 'npm'), '#!/bin/sh\nprintf "npm %s\\n" "$*" >> "$FIXTURE_CALLS"\nexit "$FIXTURE_CI_STATUS"\n', { mode: 0o755 });
  const script = [
    'set -euo pipefail',
    'fatal() { echo "FATAL: $1"; exit 1; }',
    'step() { :; }',
    'success() { echo "$1"; }',
    preflight,
    'echo checkout-mutation >> "$FIXTURE_CALLS"',
    install,
    'echo migrations >> "$FIXTURE_CALLS"',
    'echo build >> "$FIXTURE_CALLS"',
    'echo restart >> "$FIXTURE_CALLS"',
  ].join('\n');
  try {
    const result = spawnSync('/bin/bash', ['-c', script], {
      cwd: dir,
      env: {
        PATH: `${bin}:${process.env.PATH}`,
        FIXTURE_CALLS: calls,
        FIXTURE_NODE_VERSION: options.nodeVersion ?? 'v24.0.0',
        FIXTURE_CI_STATUS: String(options.ciStatus ?? 0),
      },
      encoding: 'utf8',
      timeout: 10_000,
    });
    assert.equal(result.error, undefined);
    const log = existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n') : [];
    if (options.lock !== false) assert.equal(readFileSync(path.join(dir, 'package-lock.json'), 'utf8'), lock);
    return { ...result, log };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('updater installs only the locked graph with strict engines, then permits later actions', () => {
  const result = runFixture();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.log, [
    'checkout-mutation', 'npm ci --engine-strict --no-audit --no-fund',
    'migrations', 'build', 'restart',
  ]);
});

test('updater refuses a missing lockfile before npm or any later migration/build/restart', () => {
  const result = runFixture({ lock: false });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /package-lock\.json is missing/);
  assert.deepEqual(result.log, ['checkout-mutation']);
});

test('updater npm ci failure never falls back to npm install or later actions', () => {
  const result = runFixture({ ciStatus: 42 });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /npm ci failed/);
  assert.match(result.stdout, /Fix the reported runtime, lockfile or registry error/);
  assert.deepEqual(result.log, ['checkout-mutation', 'npm ci --engine-strict --no-audit --no-fund']);
});

// ISSUE-09. The preflight now does TWO things in order: resolve the ONE node
// this box uses (identity), then check THAT node against the declared engines
// range (support). The fixture has no scripts/lib/node-runtime.sh, so identity
// falls through to ambient node, which is exactly the path these cases cover.
//
// The accepted set is deliberately the ORIGINAL range, not a Node 24 pin. An
// earlier revision of this branch required major 24; measured against the live
// fleet that would have refused Command Center updates on most boxes, since two
// client machines and the operator Mac run v26.7.0 or v26.8.1 with no node@24
// present. ABI drift is a consistency problem between the node that rebuilds
// the native module and the node that runs the server, not a version problem,
// and it is closed by reusing the SAME binary rather than by narrowing which
// versions may update.
test('updater rejects a Node below the supported range, before checkout mutation or dependency installation', () => {
  for (const nodeVersion of ['v18.20.4', 'v20.18.3', 'v22.12.0', 'unexpected']) {
    const result = runFixture({ nodeVersion });
    assert.equal(result.status, 1, nodeVersion);
    assert.match(result.stdout, /Unsupported Node\.js|Cannot read the version/);
    assert.deepEqual(result.log, [], nodeVersion);
  }
  assert.ok(updater.indexOf('# Node runtime preflight') < updater.indexOf('# Backup retention + disk pre-check'));
});

test('updater bootstrap Node floor matches package engines at supported boundaries', () => {
  assert.equal(
    JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).engines.node,
    '^20.19.0 || ^22.13.0 || >=24',
  );
  // The boundaries of the declared range, plus the majors the fleet actually
  // runs. v25 and v26 are the load-bearing cases: a Node 24 pin rejected them
  // and would have locked most of the fleet out of updating.
  for (const nodeVersion of ['v20.19.0', 'v22.13.0', 'v24.0.0', 'v25.6.1', 'v26.8.1']) {
    const result = runFixture({ nodeVersion });
    assert.equal(result.status, 0, `${nodeVersion}: ${result.stderr}`);
  }
});

test('updater checks the RESOLVED node, and reports it by path', () => {
  // The identity half: whatever node the preflight settled on is the one whose
  // version is checked and the one exported as CC_NODE_BIN for npm ci.
  const result = runFixture({ nodeVersion: 'v26.8.1' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Node runtime: \S+ \(v26\.8\.1/);
});
