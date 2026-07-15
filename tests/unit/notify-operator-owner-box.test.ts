/**
 * notify-operator-owner-box.test.ts — MSG-08.
 *
 * THE BUG THIS LOCKS DOWN
 * -----------------------
 * `notifyOwnerDone()` (owner-reports.ts) -> `notifyOwner()` (notify.ts ~line 625)
 * calls `resolveOwnerChatId()`, which is STRUCTURALLY always null on the
 * operator's OWN board: `validOwnerChatId()` rejects every OPERATOR id by
 * design (the guardrail that stops a client box from DMing the operator as
 * if he were the client), and the operator's own `allowFrom` lists ONLY
 * operator ids — there is no client on that box. So every owner report his
 * own tasks generate (assigned / started / done) fell into
 * `escalateUndeliverableOwner()`, which DMs the operator's own Telegram via
 * `notifySystem()` RUNG 2 with an "UNDELIVERABLE owner (no owner chat
 * resolvable)" digest wrapper — noise about his own board's own activity.
 *
 * THE FIX: an explicit, config-gated, opt-in-only per-box signal
 * (`CC_OPERATOR_IS_OWNER=1`, set ONLY on the operator's own board's
 * environment — never a client box). When set, and only after
 * `resolveOwnerChatId()` has already returned null, `notifyOwner()` delivers
 * the owner-facing message directly to the resolved OPERATOR chat id — once,
 * cleanly, with no UNDELIVERABLE wrapper — instead of escalating.
 *
 * PROVES (both required scenarios):
 *   (a) CLIENT-BOX: owner = a client id. The client still receives the
 *       notice; the operator id is NEVER used as owner and NEVER DM'd the
 *       client's notice — even with CC_OPERATOR_IS_OWNER=1 set (the fallback
 *       only ever engages when NO real owner resolves; it must never override
 *       a real client owner).
 *   (b) OPERATOR-BOX: only operator ids present (resolveOwnerChatId() is
 *       null, exactly as in production). With the flag set, the notice is
 *       delivered ONCE, cleanly, to the operator — no "UNDELIVERABLE" wrapper,
 *       no digest framing, the real payload verbatim — and NO
 *       'owner_undeliverable' record is written (nothing was actually
 *       undeliverable).
 *
 * Both tests FAIL on the pre-fix code: CC_OPERATOR_IS_OWNER does not exist
 * there, so scenario (b) always falls into the UNDELIVERABLE digest path
 * (delivered === false, wrapped/digest message, no verbatim payload).
 *
 * Run: node --import tsx --test tests/unit/notify-operator-owner-box.test.ts
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

// A known OPERATOR id (in the built-in DEFAULT_OPERATOR_CHAT_IDS fail-safe
// list) and a CLIENT id (any non-operator chat) — same fixtures used by the
// sibling MSG-07 suite (notify-undeliverable-escalation.test.ts).
const OPERATOR_ID = '5252140759';
const CLIENT_ID = '8959124298';

/** Build a throwaway workspace with an openclaw.json carrying `allowFrom`. */
function makeBox(allowFrom: string[]): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-notify-opbox-'));
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
 * Load a FRESH copy of notify.ts. The module reads env at import time (and
 * caches OPERATOR_CHAT_IDS at module load), so each scenario needs its own
 * instance.
 */
async function freshNotify() {
  const mod = await import(`../../src/lib/notify?u=${Math.random()}`);
  return mod as typeof import('../../src/lib/notify');
}

/** Capture every `openclaw message send` the module dispatches. */
function captureSends(notify: typeof import('../../src/lib/notify')): {
  sends: Array<{ chatId: string; message: string }>;
  restore: () => void;
} {
  const sends: Array<{ chatId: string; message: string }> = [];
  const cp = require('child_process') as typeof import('child_process');
  const realExecFile = cp.execFile;
  // SAFETY-03: reset the dedup / rate-limit / digest counters — module-level
  // and long-lived by design, but a re-import in a test file does not
  // reliably yield a fresh instance.
  notify.__resetNotifyThrottleForTests();
  // SAFETY-01: notify.ts hard-refuses every send inside a test runner by
  // default. Opt in ONLY here — the same call that installs the execFile
  // double — and opt out again in restore(), so a real send can never reach
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
      delete process.env.OWNER_NOTIFY_ALLOW_SEND_IN_TEST;
      notify.__resetNotifyThrottleForTests();
    },
  };
}

function cleanEnv(): void {
  delete process.env.OWNER_NOTIFY_TELEGRAM_DISABLED;
  delete process.env.RESCUE_RANGERS_WEBHOOK_URL;
  delete process.env.OPENCLAW_OWNER_CHAT_ID;
  delete process.env.CC_OPERATOR_CHAT_ID;
  delete process.env.OPENCLAW_OPERATOR_CHAT_ID;
  delete process.env.CC_OPERATOR_IS_OWNER;
}

// ─── (a) CLIENT-BOX: real owner still wins; operator never used/DM'd ────────
test('MSG-08: on a CLIENT box the client still receives the notice; the operator id is never used as owner and never DM\'d, even with the flag set', async () => {
  cleanEnv();
  // A CLIENT box: allowFrom holds the client, not the operator.
  makeBox([CLIENT_ID]);
  // Deliberately set the operator-owner opt-in too — it must NOT be able to
  // override a real, resolvable client owner. A client box should never carry
  // this flag in practice, but the fallback's own guard (only engages when
  // resolveOwnerChatId() is null) must hold even if it were misconfigured.
  process.env.CC_OPERATOR_IS_OWNER = '1';
  const notify = await freshNotify();
  const cap = captureSends(notify);
  try {
    assert.equal(
      notify.resolveOwnerChatId(),
      CLIENT_ID,
      'the client resolves as the owner on a client box',
    );

    const PAYLOAD = '✅ Your task is complete.\n\n*Task:* Draft Q3 report';
    const delivered = notify.notifyOwner(PAYLOAD);

    assert.equal(delivered, true, 'the client notice is dispatched');
    assert.equal(cap.sends.length, 1, 'exactly one send — to the client, not also to the operator');
    assert.equal(cap.sends[0].chatId, CLIENT_ID, 'the notice goes to the CLIENT');
    assert.equal(cap.sends[0].message, PAYLOAD, 'delivered verbatim, no wrapper');

    const toOperator = cap.sends.filter((s) => s.chatId === OPERATOR_ID);
    assert.equal(toOperator.length, 0, 'the operator must NEVER be DM\'d the client\'s task notice');
  } finally {
    cap.restore();
  }
});

// ─── (b) OPERATOR-BOX: clean, single, unwrapped delivery — no self-DM flood ─
test('MSG-08: on the OPERATOR box (only operator ids present) the notice is delivered ONCE, cleanly, with no UNDELIVERABLE wrapper', async () => {
  cleanEnv();
  // The operator's box exactly as it is in production: allowFrom holds ONLY
  // operator ids. There is no client here, so resolveOwnerChatId() is null —
  // this is the precondition that used to guarantee an UNDELIVERABLE escalation
  // for every single owner report on this box.
  const workspace = makeBox([OPERATOR_ID]);
  process.env.CC_OPERATOR_IS_OWNER = '1';
  const notify = await freshNotify();
  const cap = captureSends(notify);
  try {
    assert.equal(
      notify.resolveOwnerChatId(),
      null,
      'precondition: on an operator-only box no OWNER chat resolves',
    );

    const PAYLOAD = '✅ Your task is complete.\n\n*Task:* Draft Q3 report';
    const delivered = notify.notifyOwner(PAYLOAD);

    // The headline fix: this now reports TRUE (a real dispatch), not the old
    // always-false "escalated instead" outcome.
    assert.equal(delivered, true, 'the owner notice is dispatched, not just escalated');

    assert.equal(cap.sends.length, 1, 'exactly ONE send — no separate escalation DM on top of it');
    assert.equal(cap.sends[0].chatId, OPERATOR_ID, 'delivered to the operator, the only reachable candidate');
    assert.equal(
      cap.sends[0].message,
      PAYLOAD,
      'delivered VERBATIM — no "UNDELIVERABLE" / digest wrapper around a message that was, in fact, delivered',
    );
    assert.ok(
      !/undeliverable/i.test(cap.sends[0].message),
      'the clean delivery path must not carry the UNDELIVERABLE framing',
    );

    // Nothing was actually undeliverable, so no owner_undeliverable record.
    const ledger = path.join(workspace, 'notification-failures.jsonl');
    if (fs.existsSync(ledger)) {
      const recs = fs
        .readFileSync(ledger, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as { kind: string });
      const undeliverable = recs.find((r) => r.kind === 'owner_undeliverable');
      assert.ok(!undeliverable, 'a successfully delivered notice must not also be logged as undeliverable');
    }
  } finally {
    cap.restore();
  }
});

// ─── Guardrail sanity: without the flag, behaviour is UNCHANGED (MSG-07 holds) ─
test('MSG-08: without CC_OPERATOR_IS_OWNER, the operator box still falls back to the MSG-07 UNDELIVERABLE escalation (no regression)', async () => {
  cleanEnv();
  // Flag intentionally left unset — this is every existing box today.
  const workspace = makeBox([OPERATOR_ID]);
  const notify = await freshNotify();
  const cap = captureSends(notify);
  try {
    const PAYLOAD = 'Task blocked: no vision model available.';
    const delivered = notify.notifyOwner(PAYLOAD);

    assert.equal(delivered, false, 'unchanged: notifyOwner still reports false for a real owner-send');
    assert.equal(cap.sends.length, 1, 'unchanged: the MSG-07 escalation digest still reaches the operator');
    assert.equal(cap.sends[0].chatId, OPERATOR_ID);
    assert.match(cap.sends[0].message, /undeliverable/i, 'unchanged: still wrapped as an escalation');
    assert.ok(!cap.sends[0].message.includes(PAYLOAD), 'unchanged: still no verbatim payload in the escalation');

    const ledger = path.join(workspace, 'notification-failures.jsonl');
    const recs = fs
      .readFileSync(ledger, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { kind: string; message: string });
    const owner = recs.find((r) => r.kind === 'owner_undeliverable');
    assert.ok(owner, 'unchanged: the durable undeliverable record is still written');
  } finally {
    cap.restore();
  }
});
