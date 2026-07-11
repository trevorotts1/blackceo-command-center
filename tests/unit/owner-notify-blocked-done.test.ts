/**
 * Unit tests for owner notification on BLOCKED and DONE board states.
 *
 * Tests the new @/lib/notify module (resolveOwnerChatId + notifyTelegram +
 * notifyOwner) in isolation — no DB, no openclaw binary required.
 *
 * Verifies:
 *   1. resolveOwnerChatId returns the client's chat ID, skipping Trevor's
 *      operator ID.
 *   2. resolveOwnerChatId returns null gracefully when sessions file is absent.
 *   3. notifyTelegram is suppressed when OWNER_NOTIFY_TELEGRAM_DISABLED=1.
 *   4. notifyOwner returns false (non-throwing) when no chat ID is resolvable.
 *   5. notifyOwner returns false (non-throwing) when openclaw binary is absent.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Point OPENCLAW_WORKSPACE_PATH at a temp dir so notify.ts reads from there.
const TMP_WS = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-notify-test-'));
process.env.OPENCLAW_WORKSPACE_PATH = TMP_WS;
// Suppress actual openclaw binary calls in all tests.
process.env.OWNER_NOTIFY_TELEGRAM_DISABLED = '1';

type NotifyModule = typeof import('../../src/lib/notify');

let resolveOwnerChatId: NotifyModule['resolveOwnerChatId'];
let notifyTelegram: NotifyModule['notifyTelegram'];
let notifyOwner: NotifyModule['notifyOwner'];

test.before(async () => {
  const mod = await import('../../src/lib/notify');
  resolveOwnerChatId = mod.resolveOwnerChatId;
  notifyTelegram = mod.notifyTelegram;
  notifyOwner = mod.notifyOwner;
});

test.after(() => {
  fs.rmSync(TMP_WS, { recursive: true, force: true });
});

// ── 1. Resolves client chat ID, skips Trevor's operator ID ──────────────────
test('resolveOwnerChatId: returns client ID and skips operator ID', () => {
  const agentsDir = path.join(TMP_WS, 'agents', 'main', 'sessions');
  fs.mkdirSync(agentsDir, { recursive: true });

  const CLIENT_ID = '1000000001'; // synthetic client chat ID (not a real client)
  const TREVOR_ID = '5252140759'; // operator — should be skipped
  const sessions: Record<string, unknown> = {
    [`agent:main:telegram:direct:${TREVOR_ID}`]: { ts: 1 },
    [`agent:main:telegram:direct:${CLIENT_ID}`]: { ts: 2 },
    'agent:main:telegram:other-key': {},
  };
  fs.writeFileSync(
    path.join(agentsDir, 'sessions.json'),
    JSON.stringify(sessions),
  );

  const result = resolveOwnerChatId();
  assert.equal(result, CLIENT_ID, 'should return the non-operator chat ID');

  // Cleanup for isolation
  fs.rmSync(agentsDir, { recursive: true, force: true });
});

// ── 2. Returns null when sessions file absent ────────────────────────────────
test('resolveOwnerChatId: returns null when sessions file missing', () => {
  const result = resolveOwnerChatId();
  assert.equal(result, null, 'should return null when no sessions file');
});

// ── 3. notifyTelegram is suppressed by disable flag ──────────────────────────
test('notifyTelegram: returns false when OWNER_NOTIFY_TELEGRAM_DISABLED=1', () => {
  // env var is already set at module level
  const sent = notifyTelegram({ chatId: '12345', message: 'test' });
  assert.equal(sent, false, 'should be suppressed by disable flag');
});

// ── 4. notifyOwner returns false (non-throwing) when no chat ID ──────────────
test('notifyOwner: returns false without throwing when no chat ID resolvable', () => {
  // No sessions file → resolveOwnerChatId returns null → should not throw
  let threw = false;
  let result = false;
  try {
    result = notifyOwner('test message');
  } catch {
    threw = true;
  }
  assert.equal(threw, false, 'notifyOwner must not throw when chat ID unavailable');
  assert.equal(result, false, 'notifyOwner should return false when chat ID unavailable');
});

// ── 5. notifyOwner returns false when openclaw is absent (no throw) ───────────
test('notifyOwner: returns false without throwing when openclaw binary absent (disable flag)', () => {
  // With OWNER_NOTIFY_TELEGRAM_DISABLED=1 this tests the short-circuit path.
  // Prove notify never crashes the caller's state machine.
  const agentsDir = path.join(TMP_WS, 'agents', 'main', 'sessions');
  fs.mkdirSync(agentsDir, { recursive: true });
  const sessions: Record<string, unknown> = {
    'agent:main:telegram:direct:9999999999': { ts: 1 },
  };
  fs.writeFileSync(
    path.join(agentsDir, 'sessions.json'),
    JSON.stringify(sessions),
  );

  let threw = false;
  let result = false;
  try {
    result = notifyOwner('blocked message');
  } catch {
    threw = true;
  }
  assert.equal(threw, false, 'notifyOwner must not throw even when send is suppressed');
  assert.equal(result, false, 'notifyOwner returns false when disabled');

  fs.rmSync(agentsDir, { recursive: true, force: true });
});
