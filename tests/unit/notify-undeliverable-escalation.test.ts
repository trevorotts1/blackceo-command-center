/**
 * notify-undeliverable-escalation.test.ts — MSG-07.
 *
 * THE BUG THIS LOCKS DOWN
 * -----------------------
 * `notifyOwner()` ended in a `console.warn` + `return false` when it could not
 * resolve an owner chat id. Every AUTOMATED caller throws that boolean away
 * (task-dispatcher, qc-scorer ×2, all 5 owner-reports helpers), so the alert
 * simply ceased to exist. The live error log on the operator's box held 501
 * `"no owner chat ID found"` drops — one of them a blocked-task notification the
 * operator was never told about.
 *
 * WHY IT WAS ALWAYS NULL ON THE OPERATOR'S BOX: every chat-id source rejects
 * OPERATOR ids (the guardrail that stops an agent DMing an operator as if they
 * were the client). But the operator's own box lists ONLY operator ids in
 * `allowFrom` — there is no client on it. So every source rejected every
 * candidate, forever. The rail built to protect clients had made the operator's
 * own board mute.
 *
 * THE SEAM: two mirror-image guards that partition the chat-id space.
 *   validOwnerChatId    → clients only   (operator ids rejected)  [unchanged]
 *   validOperatorChatId → operators only (client ids rejected)    [new]
 * A SYSTEM alert therefore CANNOT reach a client — not by convention, but by
 * construction. That is what makes the operator loud without making clients loud.
 *
 * PROVES:
 *   1. An undeliverable owner notification ESCALATES (it does not vanish).
 *   2. On an operator-only box, the escalation REACHES THE OPERATOR by Telegram.
 *   3. A SYSTEM alert can NEVER be sent to a client chat id — the invariant.
 *   4. The client-spam guardrail is UNCHANGED: an operator id still never
 *      resolves as the owner.
 *   5. With nothing reachable at all, the alert still leaves a DURABLE record —
 *      it is never silently dropped.
 *
 * Run: node --import tsx --test tests/unit/notify-undeliverable-escalation.test.ts
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

// A known OPERATOR id (in the built-in DEFAULT_OPERATOR_CHAT_IDS fail-safe list)
// and a CLIENT id (any non-operator chat).
const OPERATOR_ID = '5252140759';
const CLIENT_ID = '8959124298';

/** Build a throwaway workspace with an openclaw.json carrying `allowFrom`. */
function makeBox(allowFrom: string[]): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-notify-box-'));
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(
    path.join(root, 'openclaw.json'),
    JSON.stringify({ channels: { telegram: { allowFrom } } }),
    'utf8',
  );
  process.env.OPENCLAW_WORKSPACE_PATH = workspace;
  return workspace;
}

/**
 * Load a FRESH copy of notify.ts. The module reads env at import time, so each
 * scenario needs its own instance.
 */
async function freshNotify() {
  const mod = await import(`../../src/lib/notify?u=${Math.random()}`);
  return mod as typeof import('../../src/lib/notify');
}

/** Capture every `openclaw message send` the module dispatches. */
function captureSends(): { sends: Array<{ chatId: string; message: string }>; restore: () => void } {
  const sends: Array<{ chatId: string; message: string }> = [];
  const cp = require('child_process') as typeof import('child_process');
  const realExecFile = cp.execFile;
  // SAFETY-01: notify.ts now hard-refuses every send inside a test runner, so a
  // forgotten gate can never spam a real phone again. These MSG-07 tests are the
  // ONE legitimate exception: they must observe that a dispatch happens. We opt
  // in ONLY here — the same call that installs the execFile double — and opt out
  // again in restore(). Coupling the opt-in to the stub means a send can never be
  // permitted unless execFile is already a test double, so this can never reach
  // the real `openclaw` binary.
  process.env.OWNER_NOTIFY_ALLOW_SEND_IN_TEST = '1';
  // @ts-expect-error — test double
  cp.execFile = (_file: string, args: string[], _opts: unknown, cb?: (e: unknown) => void) => {
    const t = args.indexOf('--target');
    const m = args.indexOf('--message');
    if (t !== -1 && m !== -1) sends.push({ chatId: args[t + 1], message: args[m + 1] });
    if (cb) cb(null);
    return { on: () => {}, unref: () => {} };
  };
  return {
    sends,
    restore: () => {
      // @ts-expect-error — restore
      cp.execFile = realExecFile;
      // Withdraw the opt-in the instant the double is removed (SAFETY-01).
      delete process.env.OWNER_NOTIFY_ALLOW_SEND_IN_TEST;
    },
  };
}

function cleanEnv(): void {
  delete process.env.OWNER_NOTIFY_TELEGRAM_DISABLED;
  delete process.env.RESCUE_RANGERS_WEBHOOK_URL;
  delete process.env.OPENCLAW_OWNER_CHAT_ID;
  delete process.env.CC_OPERATOR_CHAT_ID;
  delete process.env.OPENCLAW_OPERATOR_CHAT_ID;
}

// ─── 1 + 2. THE HEADLINE: undeliverable → escalates → operator RECEIVES it ───
test('MSG-07: an undeliverable owner notification escalates and REACHES THE OPERATOR', async () => {
  cleanEnv();
  // The operator's box exactly as it is in production: allowFrom holds ONLY
  // operator ids. There is no client here, so resolveOwnerChatId() is null.
  makeBox([OPERATOR_ID]);
  const cap = captureSends();
  try {
    const notify = await freshNotify();

    assert.equal(
      notify.resolveOwnerChatId(),
      null,
      'precondition: on an operator-only box no OWNER chat resolves (this is the mute)',
    );

    const delivered = notify.notifyOwner('Task blocked: no vision model available.');

    // notifyOwner still reports false to callers that check (send-link relies on it)…
    assert.equal(delivered, false, 'notifyOwner still returns false for a real owner-send');

    // …but the alert MUST NOT have vanished. It escalated to the operator.
    assert.equal(cap.sends.length, 1, 'the undeliverable notification must be ESCALATED, not dropped');
    assert.equal(cap.sends[0].chatId, OPERATOR_ID, 'the escalation goes to the OPERATOR');
    assert.match(
      cap.sends[0].message,
      /UNDELIVERABLE/,
      'the escalation says plainly that a notification could not be delivered',
    );
    assert.match(cap.sends[0].message, /no vision model available/, 'the original alert is carried through');
  } finally {
    cap.restore();
  }
});

// ─── 3. THE INVARIANT: a SYSTEM alert can NEVER reach a client ───────────────
test('MSG-07: a SYSTEM alert is NEVER sent to a client chat id', async () => {
  cleanEnv();
  // A CLIENT box: allowFrom holds the client. There is no operator listed.
  makeBox([CLIENT_ID]);
  const cap = captureSends();
  try {
    const notify = await freshNotify();

    // The client IS resolvable as the owner — normal client notifications work.
    assert.equal(notify.resolveOwnerChatId(), CLIENT_ID, 'the client is the owner on a client box');
    // But NO operator is resolvable here…
    assert.equal(notify.resolveOperatorChatId(), null, 'no operator id in this box config');

    notify.notifySystem('dispatch failed: gateway down');

    // …so the SYSTEM alert must reach NOBODY by Telegram — above all, not the client.
    const toClient = cap.sends.filter((s) => s.chatId === CLIENT_ID);
    assert.equal(toClient.length, 0, 'MOVE-IN-SILENCE: a SYSTEM alert must NEVER reach a client');
    assert.equal(cap.sends.length, 0, 'no Telegram send at all when no operator is reachable');
  } finally {
    cap.restore();
  }
});

// Even if a client id is FORCED into the operator env pin, the inverse guard
// must reject it. This is the guardrail's load-bearing assertion.
test('MSG-07: a client id forced into CC_OPERATOR_CHAT_ID is REJECTED', async () => {
  cleanEnv();
  makeBox([CLIENT_ID]);
  process.env.CC_OPERATOR_CHAT_ID = CLIENT_ID; // misconfiguration / hostile input
  const cap = captureSends();
  try {
    const notify = await freshNotify();
    assert.equal(
      notify.resolveOperatorChatId(),
      null,
      'a CLIENT id must never be accepted as a SYSTEM/operator target, even when pinned',
    );
    notify.notifySystem('operator-only alert');
    assert.equal(
      cap.sends.filter((s) => s.chatId === CLIENT_ID).length,
      0,
      'the client must receive NOTHING',
    );
  } finally {
    cap.restore();
  }
});

// ─── 4. The client-protection guardrail is UNCHANGED ─────────────────────────
test('MSG-07: an OPERATOR id still never resolves as the client owner (guardrail intact)', async () => {
  cleanEnv();
  makeBox([OPERATOR_ID, CLIENT_ID]);
  const notify = await freshNotify();

  // With BOTH present, the owner must be the CLIENT — never the operator.
  assert.equal(
    notify.resolveOwnerChatId(),
    CLIENT_ID,
    'the owner resolver must skip the operator id and pick the client',
  );
  // And the operator resolver picks the OPERATOR — never the client.
  assert.equal(notify.resolveOperatorChatId(), OPERATOR_ID);
});

test('MSG-07: an operator id pinned as the OWNER is still rejected', async () => {
  cleanEnv();
  makeBox([]);
  process.env.OPENCLAW_OWNER_CHAT_ID = OPERATOR_ID;
  const notify = await freshNotify();
  assert.equal(
    notify.resolveOwnerChatId(),
    null,
    'operator id pinned as owner must STILL be rejected — the guardrail is untouched',
  );
});

// ─── 5. Nothing reachable → still a DURABLE record. Never silent. ────────────
test('MSG-07: with nothing reachable, an undeliverable alert still leaves a durable record', async () => {
  cleanEnv();
  // A box with NO operator and NO client, and no webhook: the worst case.
  const workspace = makeBox([]);
  const cap = captureSends();
  try {
    const notify = await freshNotify();
    assert.equal(notify.resolveOwnerChatId(), null);
    assert.equal(notify.resolveOperatorChatId(), null);

    notify.notifyOwner('Task blocked: assignee has no runtime.');

    const ledger = path.join(workspace, 'notification-failures.jsonl');
    assert.ok(fs.existsSync(ledger), 'an undeliverable alert MUST leave a durable trace on disk');
    const lines = fs.readFileSync(ledger, 'utf8').trim().split('\n').filter(Boolean);
    assert.ok(lines.length >= 1, 'at least one failure recorded');
    const rec = JSON.parse(lines[lines.length - 1]) as { kind: string; message: string };
    assert.equal(rec.kind, 'system_alert');
    assert.match(rec.message, /UNDELIVERABLE/);
    assert.match(rec.message, /no runtime/, 'the original alert content is preserved in the record');
  } finally {
    cap.restore();
  }
});
