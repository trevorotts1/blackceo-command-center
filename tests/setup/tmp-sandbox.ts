/**
 * Suite-wide temp sandbox — no test may leak into the real $TMPDIR.
 *
 * Loaded via `node --import ./tests/setup/tmp-sandbox.ts` from the `test:unit`
 * script. The FIRST process to load it (the node:test runner) makes one
 * throwaway dir and points TMPDIR at it; os.tmpdir() reads TMPDIR on every
 * call, so every mkdtempSync(os.tmpdir(), ...) in every test file — and every
 * child process a test spawns — lands inside it. Test child processes inherit
 * the marker and reuse the same dir instead of nesting (nested dirs push tsx's
 * IPC socket path past the 104-byte unix-socket limit).
 *
 * The runner removes the whole dir on exit, pass or fail, so a test that skips
 * its own cleanup — or a child killed by a timeout — leaves nothing behind.
 * Before this, one `npm run test:unit` left ~230 dirs (~117 MB) in $TMPDIR.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

if (!process.env.CC_TEST_TMP_SANDBOX) {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-test-tmp-'));
  process.env.CC_TEST_TMP_SANDBOX = sandbox;
  process.env.TMPDIR = sandbox;
  process.on('exit', () => {
    try {
      fs.rmSync(sandbox, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup: must never mask the suite's own result.
    }
  });
}

// vitest globalSetup entry point (vitest.config.ts): importing this module in
// vitest's main process already did the work above; vitest requires an export.
export default function setup(): void {}
