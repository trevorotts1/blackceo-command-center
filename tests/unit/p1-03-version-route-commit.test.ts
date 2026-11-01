/**
 * Installed-commit reporting on GET /api/version.
 *
 * The version string is a release stamp shared by many commits (verified:
 * origin/main is 94 commits past the last `/version` bump while still reading
 * v7.6.126), so it cannot answer "which build is this box serving". These
 * cases pin the commit fields that can, and the independent degradation path
 * that must not turn a clean version read into an `error`.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { GET } from '../../src/app/api/version/route';

const REPO_ROOT = process.cwd();
const HEAD = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf-8' }).trim();

test('[W3] GET /api/version: reports the live checkout commit and the build-recorded commit', async () => {
  const res = await GET();
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.match(body.checkoutCommit, /^[0-9a-f]{40}$/);
  assert.equal(body.checkoutCommit, HEAD);
  assert.equal(body.buildCommit, HEAD, 'build record matches the checkout while it has not moved');
  assert.ok(!('error' in body), 'clean version reads must not emit error');
  assert.ok(!('commitError' in body), 'clean commit reads must not emit commitError');
});

test('[W3] GET /api/version: a checkout without .git degrades commit fields independently, not the version read', async () => {
  const recordedBuildCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: REPO_ROOT,
    encoding: 'utf-8',
  }).trim();
  const tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-w3-commit-'));
  fs.writeFileSync(path.join(tmpCwd, 'version'), 'v7.6.126\n');
  process.chdir(tmpCwd);
  try {
    const res = await GET();
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.checkoutVersion, 'v7.6.126');
    assert.equal(body.checkoutCommit, null);
    assert.equal(body.buildCommit, recordedBuildCommit, 'build record must not follow a moved checkout');
    assert.ok(!('error' in body), 'a clean version read stays clean');
    assert.equal(typeof body.commitError, 'string');
    assert.ok(body.commitError.length > 0);
  } finally {
    process.chdir(REPO_ROOT);
    fs.rmSync(tmpCwd, { recursive: true, force: true });
  }
});
