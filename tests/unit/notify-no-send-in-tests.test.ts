/**
 * SAFETY-01 REGRESSION — a unit test can NEVER invoke a real Telegram send.
 *
 * The incident: `tests/unit/u26-b-u12-qc-producer-scorecard-contract.test.ts`
 * drove fixture tasks through `runQCOnReview()` to done/blocked. qc-scorer calls
 * notifyOwner()/notifyOwnerDone() on those transitions, and notifyTelegram()
 * execFile()s the REAL `openclaw message send`. That file never set
 * OWNER_NOTIFY_TELEGRAM_DISABLED=1 (unlike ~19 sibling files), so every run of
 * the unit suite delivered live Telegram messages to a real person's phone.
 *
 * The root defect was NOT the missing line — it was that a test could send at
 * all. The old gate was opt-IN: safety depended on every author remembering it,
 * and the penalty for forgetting was spamming a human. src/lib/notify.ts now
 * refuses any send when it detects a test runner (SAFETY-01).
 *
 * This test proves that guard HOLDS EVEN WITH THE ENV GATE EXPLICITLY REMOVED —
 * i.e. it reproduces the exact condition of the leaky file and shows no send
 * escapes.
 *
 * It is deliberately NOT vacuous: a stub `openclaw` on PATH records any
 * invocation to a sentinel file, and one case proves the stub DOES capture a
 * send when the guard is explicitly opted out of. So "no sentinel" in the
 * guarded cases means the GUARD stopped it, not that the harness is broken.
 *
 * SAFETY OF THIS TEST ITSELF: during the send-path cases PATH is replaced with
 * ONLY the stub directory, so the real `openclaw` binary is unreachable by
 * construction — this file cannot send a message even if the guard regresses.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-notify-nosend-'));
const SENTINEL = path.join(TMP_DIR, 'openclaw-was-invoked.log');
const SHIM_DIR = path.join(TMP_DIR, 'bin');

// A stub `openclaw` that records every invocation. Absolute shebang, so it runs
// even when PATH is restricted to SHIM_DIR alone.
fs.mkdirSync(SHIM_DIR, { recursive: true });
fs.writeFileSync(
  path.join(SHIM_DIR, 'openclaw'),
  `#!/bin/sh\necho "invoked: $@" >> ${JSON.stringify(SENTINEL)}\n`,
  { mode: 0o755 },
);

// Isolate: never let this file touch a real workspace/config while resolving.
process.env.OPENCLAW_WORKSPACE_PATH = path.join(TMP_DIR, 'workspace');
fs.mkdirSync(process.env.OPENCLAW_WORKSPACE_PATH, { recursive: true });

const REAL_PATH = process.env.PATH ?? '';

/** Wait for the stub to have (or not have) fired. execFile is fire-and-forget. */
async function sentinelAppeared(timeoutMs = 3_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(SENTINEL)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

type NotifyModule = typeof import('../../src/lib/notify');

// ── 1. The runner is detected without any cooperation from the test author ────
test('isTestEnvironment(): true under the node:test runner (no env var needed)', async () => {
  const { isTestEnvironment } = (await import('../../src/lib/notify')) as NotifyModule;

  // The signal that actually matters for THIS repo: `npm run test:unit` is
  // node:test, which sets NODE_TEST_CONTEXT in every test child process.
  // NODE_ENV is undefined under it — a NODE_ENV-only check would catch nothing.
  assert.ok(process.env.NODE_TEST_CONTEXT, 'node:test must set NODE_TEST_CONTEXT');
  assert.equal(isTestEnvironment(), true);
});

// ── 2. THE REGRESSION: no send even with the env gate REMOVED ─────────────────
test('notifyTelegram(): refuses to send in a test run even with OWNER_NOTIFY_TELEGRAM_DISABLED unset', async () => {
  const { notifyTelegram } = (await import('../../src/lib/notify')) as NotifyModule;

  const savedGate = process.env.OWNER_NOTIFY_TELEGRAM_DISABLED;
  // Reproduce the leaky file's exact condition: the gate is simply absent.
  delete process.env.OWNER_NOTIFY_TELEGRAM_DISABLED;
  delete process.env.OWNER_NOTIFY_ALLOW_SEND_IN_TEST;
  // Real `openclaw` is now unreachable: only the stub is on PATH.
  process.env.PATH = SHIM_DIR;

  try {
    const dispatched = notifyTelegram({ chatId: '12345', message: 'REGRESSION: must never send' });
    assert.equal(dispatched, false, 'notifyTelegram must report suppressed, not dispatched');
    assert.equal(
      await sentinelAppeared(1_000),
      false,
      'the openclaw binary must NEVER be invoked from a test run',
    );
  } finally {
    process.env.PATH = REAL_PATH;
    if (savedGate !== undefined) process.env.OWNER_NOTIFY_TELEGRAM_DISABLED = savedGate;
  }
});

// ── 3. notifyOwner() — the path qc-scorer actually calls — is also refused ────
test('notifyOwner(): refuses to send in a test run even with OWNER_NOTIFY_TELEGRAM_DISABLED unset', async () => {
  const { notifyOwner } = (await import('../../src/lib/notify')) as NotifyModule;

  const savedGate = process.env.OWNER_NOTIFY_TELEGRAM_DISABLED;
  delete process.env.OWNER_NOTIFY_TELEGRAM_DISABLED;
  delete process.env.OWNER_NOTIFY_ALLOW_SEND_IN_TEST;
  process.env.PATH = SHIM_DIR;

  try {
    // This is exactly what runQCOnReview -> qc-scorer does on promote-to-done.
    const dispatched = notifyOwner('REGRESSION: task promoted to done — must never send');
    assert.equal(dispatched, false);
    assert.equal(
      await sentinelAppeared(1_000),
      false,
      'promoting a fixture task must NEVER reach a real phone',
    );
  } finally {
    process.env.PATH = REAL_PATH;
    if (savedGate !== undefined) process.env.OWNER_NOTIFY_TELEGRAM_DISABLED = savedGate;
  }
});

// ── 4. ANTI-VACUOUS: prove the stub DOES capture a send when opted out ────────
// Without this, tests 2-3 would still "pass" if the harness silently never ran
// the binary. This shows the sentinel mechanism genuinely detects a dispatch,
// so its ABSENCE above is real evidence that the guard is what stopped it.
test('stub harness is real: an explicit OWNER_NOTIFY_ALLOW_SEND_IN_TEST=1 opt-in DOES dispatch', async () => {
  const { notifyTelegram } = (await import('../../src/lib/notify')) as NotifyModule;

  const savedGate = process.env.OWNER_NOTIFY_TELEGRAM_DISABLED;
  delete process.env.OWNER_NOTIFY_TELEGRAM_DISABLED;
  process.env.OWNER_NOTIFY_ALLOW_SEND_IN_TEST = '1';
  // Only the stub is reachable — the real binary is not on PATH.
  process.env.PATH = SHIM_DIR;

  try {
    const dispatched = notifyTelegram({ chatId: '12345', message: 'stub-capture probe' });
    assert.equal(dispatched, true, 'explicit opt-in must dispatch');
    assert.equal(
      await sentinelAppeared(3_000),
      true,
      'the stub must capture the dispatch — otherwise tests 2-3 prove nothing',
    );
  } finally {
    process.env.PATH = REAL_PATH;
    delete process.env.OWNER_NOTIFY_ALLOW_SEND_IN_TEST;
    if (savedGate !== undefined) process.env.OWNER_NOTIFY_TELEGRAM_DISABLED = savedGate;
    fs.rmSync(SENTINEL, { force: true });
  }
});
