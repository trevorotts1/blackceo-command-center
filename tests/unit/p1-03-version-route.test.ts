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
  // Sanity: the CC repo's version file uses the vX.Y.Z convention documented
  // in scripts/bump-version.sh.
  assert.match(body.version, /^v\d+\.\d+\.\d+/);
});

test('[P1-03] GET /api/version: degrades to version:null (200, never a 500) when the version file is missing — the diagnostic endpoint must never itself become a source of dashboard breakage', async () => {
  const tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-p1-03-version-'));
  process.chdir(tmpCwd);
  try {
    const res = await GET();
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.version, null);
    assert.ok(typeof body.error === 'string' && body.error.length > 0);
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
