/**
 * P1-03 step 3 — GET /api/version.
 *
 * "render the CC version (from the `version` file, exposed via an existing
 * or new tiny `/api/version` route) in the dashboard footer. This makes
 * build-generation drift diagnosable at a glance."
 *
 * FAIL-FIRST PROOF: `src/app/api/version/route.ts` did not exist before this
 * change — the import below throws MODULE_NOT_FOUND against the pre-fix
 * tree. Confirmed during development via `git stash`.
 *
 * Runs via the Node built-in test runner under tsx (`npm run test:unit`).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { GET } from '../../src/app/api/version/route';

const REPO_ROOT = process.cwd();

test('[P1-03] GET /api/version: 200 with the exact trimmed content of the repo-root `version` file', async () => {
  const expected = fs.readFileSync(path.join(REPO_ROOT, 'version'), 'utf-8').trim();
  const res = await GET();
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.version, expected);
  assert.equal(body.checkoutVersion, expected);
  assert.equal(body.buildVersion, expected, 'build record matches the checkout while it has not moved');
  assert.ok(!('error' in body), 'two clean reads must not emit error');
  // Sanity: the CC repo's version file uses the vX.Y.Z convention documented
  // in scripts/bump-version.sh.
  assert.match(body.version, /^v\d+\.\d+\.\d+/);
});

test('[P1-03] GET /api/version: degrades to version:null (200, never a 500) when the version file is missing — the diagnostic endpoint must never itself become a source of dashboard breakage', async () => {
  const recordedAtBuild = fs.readFileSync(path.join(REPO_ROOT, 'version'), 'utf-8').trim();
  const tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-p1-03-version-'));
  process.chdir(tmpCwd);
  try {
    const res = await GET();
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.version, null);
    assert.equal(body.checkoutVersion, null);
    // fix-45: the build record must survive a degraded live read — the whole
    // point is that it does not follow the checkout, healthy or missing.
    assert.equal(body.buildVersion, recordedAtBuild);
    assert.ok(typeof body.error === 'string' && body.error.length > 0);
  } finally {
    process.chdir(REPO_ROOT);
    fs.rmSync(tmpCwd, { recursive: true, force: true });
  }
});

test('[fix-45] GET /api/version: reports the build-recorded revision separately from the live checkout version, so a checkout that moves under an older running build cannot advertise the newer number as the build', async () => {
  // The route module was imported from the repo root above — that import is
  // when a running build records its own revision. Moving the working
  // directory to a checkout carrying a different `version` is exactly the
  // reported failure: the checkout moves under an older running build.
  const recordedAtBuild = fs.readFileSync(path.join(REPO_ROOT, 'version'), 'utf-8').trim();
  const movedTo = 'v9.9.9-drift';
  const tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-fix-45-version-drift-'));
  fs.writeFileSync(path.join(tmpCwd, 'version'), `${movedTo}\n`);
  process.chdir(tmpCwd);
  try {
    const res = await GET();
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.buildVersion, recordedAtBuild, 'buildVersion must not follow the checkout');
    assert.equal(body.checkoutVersion, movedTo, 'checkoutVersion must be read live');
    assert.equal(body.version, movedTo, 'legacy `version` key stays the live checkout value for the footer');
    assert.ok(!('error' in body), 'drift alone is not a read failure — no error key');
  } finally {
    process.chdir(REPO_ROOT);
    fs.rmSync(tmpCwd, { recursive: true, force: true });
  }
});

test('[P1-03] GET /api/version: degrades to version:null (200) when the version file exists but is empty', async () => {
  const tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-p1-03-version-empty-'));
  fs.writeFileSync(path.join(tmpCwd, 'version'), '');
  process.chdir(tmpCwd);
  try {
    const res = await GET();
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.version, null);
  } finally {
    process.chdir(REPO_ROOT);
    fs.rmSync(tmpCwd, { recursive: true, force: true });
  }
});
