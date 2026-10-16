import './_isolated-db';
/**
 * ilj-011-seam-lock-missing-parent.test.ts (ILJ-011)
 *
 * ILJ-003's withTranscriptLock mkdirs `<enc>.lockdir` and treated EVERY mkdir
 * failure as contention. Pre-first-answer there is no `company-discovery/`
 * dir, so mkdir fails ENOENT (missing parent, not EEXIST) and the catch spun
 * the full 10000 ms TRANSCRIPT_LOCK_WAIT_MS deadline — Atomics.wait wedging
 * the whole Node event loop. Reachable read-only via
 * GET /api/interview/answers/export and GET /api/interview/state.
 *
 * Pins:
 *   1. readTranscriptText on a workspace with NO company-discovery/ dir
 *      returns promptly (well under the 10 s deadline) with the absent shape.
 *   2. appendTranscriptTextAtomic on the same workspace succeeds promptly —
 *      the lock ensures its own parent exists — and the store reads back.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.MC_INTERVIEW_SECRET = 'ilj011-test-secret-do-not-use-in-prod';

import { _resetKeyCache } from '../../src/lib/interview/crypto';
import {
  readTranscriptText,
  appendTranscriptTextAtomic,
} from '../../src/lib/interview/seam';

const PROMPT_MS = 2000;

function missingParentWorkspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ilj011-test-'));
  const ws = path.join(dir, 'ws');
  // Workspace root exists with build-state, but NO company-discovery/ child.
  fs.mkdirSync(ws, { recursive: true });
  fs.writeFileSync(
    path.join(ws, '.workforce-build-state.json'),
    JSON.stringify({ interviewProgress: {} }),
  );
  assert.ok(
    !fs.existsSync(path.join(ws, 'company-discovery')),
    'precondition: company-discovery/ must not exist',
  );
  process.env.OPENCLAW_WORKSPACE_ROOT = ws;
  _resetKeyCache();
  return ws;
}

test('read returns absent promptly when company-discovery/ is missing (ILJ-011)', () => {
  missingParentWorkspace();
  const t0 = Date.now();
  const read = readTranscriptText();
  const elapsed = Date.now() - t0;
  assert.ok(
    elapsed < PROMPT_MS,
    `read wedged on missing lock parent: ${elapsed} ms (deadline 10000 ms)`,
  );
  assert.equal(read.decrypt, 'absent');
  assert.equal(read.exists, false);
  assert.equal(read.text, '');
});

test('append creates the store promptly when company-discovery/ is missing (ILJ-011)', () => {
  missingParentWorkspace();
  const t0 = Date.now();
  const appended = appendTranscriptTextAtomic('**Q:** first\n**A:** answer\n');
  const elapsed = Date.now() - t0;
  assert.ok(
    elapsed < PROMPT_MS,
    `append wedged on missing lock parent: ${elapsed} ms (deadline 10000 ms)`,
  );
  assert.equal(appended.decrypt, 'ok');
  assert.equal(appended.exists, true);
  assert.ok(appended.text.includes('**Q:** first'));
  const reread = readTranscriptText();
  assert.equal(reread.decrypt, 'ok');
  assert.equal(reread.text, appended.text);
});
