/**
 * seam-rate-limit-session-id-wiring.test.ts
 *
 * The seam-level half of the P0 fix (Cassandra Henriquez incident, 2026-07).
 * seam.resolveInterviewWriteIdentity (see resolve-interview-write-identity.test.ts)
 * decides WHEN to hand update-interview-state.sh a real session id instead of
 * letting it fall back to the shared 'interview-web' literal. This file pins
 * that seam.updateInterviewState() actually WIRES that decision onto the CLI
 * correctly -- a real script contract (argv shape + exit code), tested against
 * a throwaway stub script so this test needs no sibling-repo checkout and
 * touches no real box or client data.
 *
 * (The actual rate-limit / session-bucketing BEHAVIOR is the authoritative
 * onboarding repo's job and is proven there, RED-before-fix/GREEN-after, in
 * 23-ai-workforce-blueprint/scripts/test-interview-rate-limit-session-key.sh.
 * This file only proves the Command Center's side of the contract: the flag
 * gets sent, or doesn't, exactly when it should, and a 89 exit surfaces as a
 * typed, distinguishable InterviewScriptError.)
 *
 * Runs via the Node built-in test runner (`node:test`), discovered by
 * `npm run test:unit`'s glob.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { updateInterviewState, InterviewScriptError } from '../../src/lib/interview/seam';

function makeStubScriptsDir(): { dir: string; outFile: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-seam-stub-'));
  const outFile = path.join(dir, 'captured-argv.txt');
  const script = path.join(dir, 'update-interview-state.sh');
  fs.writeFileSync(
    script,
    `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > "${outFile}"\nexit "\${FAKE_EXIT:-0}"\n`,
    { mode: 0o755 },
  );
  return { dir, outFile };
}

test('a resolved rateLimitSessionId is sent to the script as --session-id', async () => {
  const { dir, outFile } = makeStubScriptsDir();
  const prevScripts = process.env.OPENCLAW_SKILL23_SCRIPTS;
  process.env.OPENCLAW_SKILL23_SCRIPTS = dir;
  try {
    await updateInterviewState({
      phase: 'discovery',
      questionNumber: 4,
      askedBy: 'interview-web',
      rateLimitSessionId: 'session-real-uuid',
    });
    const argv = fs.readFileSync(outFile, 'utf-8').split('\n').filter(Boolean);
    const idx = argv.indexOf('--session-id');
    assert.ok(idx >= 0, `expected --session-id in argv, got: ${JSON.stringify(argv)}`);
    assert.equal(argv[idx + 1], 'session-real-uuid');
    // askedBy is still sent too -- lastQuestionAskedBy recording is unaffected.
    const byIdx = argv.indexOf('--asked-by');
    assert.ok(byIdx >= 0);
    assert.equal(argv[byIdx + 1], 'interview-web');
  } finally {
    process.env.OPENCLAW_SKILL23_SCRIPTS = prevScripts;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an authenticated call (no rateLimitSessionId) sends NO --session-id flag at all -- the authenticated path is unchanged', async () => {
  const { dir, outFile } = makeStubScriptsDir();
  const prevScripts = process.env.OPENCLAW_SKILL23_SCRIPTS;
  process.env.OPENCLAW_SKILL23_SCRIPTS = dir;
  try {
    await updateInterviewState({
      phase: 'discovery',
      questionNumber: 6,
      askedBy: 'owner@example.com',
      // rateLimitSessionId intentionally omitted, exactly as the answer route
      // does whenever resolveInterviewWriteIdentity found a real identity.
    });
    const argv = fs.readFileSync(outFile, 'utf-8').split('\n').filter(Boolean);
    assert.ok(
      !argv.includes('--session-id'),
      `--session-id must NOT be sent when there is a real identity, got: ${JSON.stringify(argv)}`,
    );
    const byIdx = argv.indexOf('--asked-by');
    assert.equal(argv[byIdx + 1], 'owner@example.com');
  } finally {
    process.env.OPENCLAW_SKILL23_SCRIPTS = prevScripts;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a rate-limited (exit 89) script surfaces as a typed InterviewScriptError with exitCode === 89, never a silent/generic failure', async () => {
  const { dir } = makeStubScriptsDir();
  const prevScripts = process.env.OPENCLAW_SKILL23_SCRIPTS;
  const prevFakeExit = process.env.FAKE_EXIT;
  process.env.OPENCLAW_SKILL23_SCRIPTS = dir;
  process.env.FAKE_EXIT = '89';
  try {
    await assert.rejects(
      () =>
        updateInterviewState({
          phase: 'discovery',
          questionNumber: 4,
          askedBy: 'interview-web',
          rateLimitSessionId: 'session-real-uuid',
        }),
      (err: unknown) => {
        assert.ok(err instanceof InterviewScriptError, 'must be the typed InterviewScriptError');
        assert.equal((err as InterviewScriptError).exitCode, 89);
        return true;
      },
    );
  } finally {
    process.env.OPENCLAW_SKILL23_SCRIPTS = prevScripts;
    process.env.FAKE_EXIT = prevFakeExit;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
