/**
 * Owner-notification guards from a live incident (2026-09-28): a client box's
 * Command Center sent 7 stop-cards and board alerts to the owner's spouse --
 * the first id in channels.telegram.allowFrom -- while the operator copy
 * failed with "chat not found" (364 such failures on another box).
 *
 * PROVES:
 *   1. With no explicit owner record, nothing is sent to anyone listed in
 *      allowFrom, whatever the order.
 *   2. ownerSendsHold=true in the build state stops every client-bound send.
 *   3. On a client box with the fleet's operator alert webhook, a SYSTEM alert
 *      goes to that webhook -- not through the client's bot to the operator.
 *
 * Run: node --import tsx --test tests/unit/notify-owner-guards.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const OPERATOR_ID = '5252140759';
const OWNER_ID = '1000000042';   // synthetic
const SPOUSE_ID = '1000000077';  // synthetic

function makeBox(cfg: Record<string, unknown>, state?: Record<string, unknown>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-notify-guards-'));
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(path.join(root, 'openclaw.json'), JSON.stringify(cfg), 'utf8');
  if (state) fs.writeFileSync(path.join(workspace, '.workforce-build-state.json'), JSON.stringify(state), 'utf8');
  process.env.OPENCLAW_WORKSPACE_PATH = workspace;
  return workspace;
}

function cleanEnv(): void {
  for (const k of ['OWNER_NOTIFY_TELEGRAM_DISABLED', 'RESCUE_RANGERS_WEBHOOK_URL', 'OPENCLAW_OWNER_CHAT_ID',
    'CC_OPERATOR_CHAT_ID', 'OPENCLAW_OPERATOR_CHAT_ID', 'CC_OPERATOR_IS_OWNER', 'FLEET_OPERATOR_ALERT_URL',
    'FLEET_STANDING_GATE_URL', 'FLEET_STANDING_GATE_SECRET', 'FLEET_STANDING_GATE_HEADER']) delete process.env[k];
}

async function freshNotify() {
  return (await import(`../../src/lib/notify?u=${Math.random()}`)) as typeof import('../../src/lib/notify');
}

function capture(notify: typeof import('../../src/lib/notify')) {
  const sends: Array<{ chatId: string; message: string }> = [];
  const posts: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
  const cp = require('child_process') as typeof import('child_process');
  const realExecFile = cp.execFile;
  const realFetch = globalThis.fetch;
  notify.__resetNotifyThrottleForTests();
  process.env.OWNER_NOTIFY_ALLOW_SEND_IN_TEST = '1';
  // @ts-expect-error test double
  cp.execFile = (_f: string, args: string[], _o: unknown, cb?: (e: unknown) => void) => {
    const t = args.indexOf('--target');
    const m = args.indexOf('--message');
    if (t !== -1 && m !== -1) sends.push({ chatId: args[t + 1], message: args[m + 1] });
    if (cb) cb(null);
    return { on: () => {}, unref: () => {} };
  };
  // @ts-expect-error test double
  globalThis.fetch = async (url: string, init: { headers: Record<string, string>; body: string }) => {
    posts.push({ url: String(url), headers: init.headers, body: init.body });
    return { ok: true, status: 200 };
  };
  return {
    sends, posts,
    restore: () => {
      // @ts-expect-error restore
      cp.execFile = realExecFile;
      globalThis.fetch = realFetch;
      delete process.env.OWNER_NOTIFY_ALLOW_SEND_IN_TEST;
      notify.__resetNotifyThrottleForTests();
    },
  };
}

test('no owner record: nobody in allowFrom is messaged as the owner, whatever the order', async () => {
  cleanEnv();
  makeBox({ channels: { telegram: { allowFrom: [SPOUSE_ID, OWNER_ID] } } });
  const notify = await freshNotify();
  const cap = capture(notify);
  try {
    assert.equal(notify.resolveOwnerChatId(), null);
    notify.notifyOwner('"Welcome to Bugs" has stopped and needs you.');
    assert.deepEqual(cap.sends.filter((s) => s.chatId === SPOUSE_ID || s.chatId === OWNER_ID), []);
  } finally {
    cap.restore();
  }
});

test('ownerSendsHold=true: nothing reaches the owner; the hold is recorded', async () => {
  cleanEnv();
  const ws = makeBox({ env: { vars: { OPENCLAW_OWNER_CHAT_ID: OWNER_ID } } },
    { ownerChat: Number(OWNER_ID), ownerSendsHold: true, ownerSendsHoldReason: 'interview not closed' });
  const notify = await freshNotify();
  const cap = capture(notify);
  try {
    assert.equal(notify.ownerSendsHeld(), true);
    assert.equal(notify.notifyOwner('Your task is complete.'), false);
    assert.equal(notify.notifyTelegram({ chatId: OWNER_ID, message: 'direct' }), false);
    assert.deepEqual(cap.sends, []);
    const log = fs.readFileSync(path.join(ws, 'notification-failures.jsonl'), 'utf8');
    assert.match(log, /owner_send_held/);
  } finally {
    cap.restore();
  }
});

test('client box with the operator alert webhook: SYSTEM alerts are muted — no webhook relay (2026-10-02 spam-fix)', async () => {
  cleanEnv();
  makeBox({
    channels: { telegram: { allowFrom: [OWNER_ID, OPERATOR_ID] } },
    env: { vars: { OPENCLAW_OWNER_CHAT_ID: OWNER_ID,
      FLEET_STANDING_GATE_URL: 'https://n8n.example.test/webhook/fleet-standing-check',
      FLEET_STANDING_GATE_SECRET: 'test-secret' } },
  });
  const notify = await freshNotify();
  const cap = capture(notify);
  try {
    assert.equal(notify.notifySystem('[PERSONA-GROUNDING] persona_grounding_degraded'), false);
    assert.deepEqual(cap.sends, [], 'no Telegram through the client bot (the operator never opened that chat)');
    assert.deepEqual(cap.posts, [], 'no webhook relay — board chatter stays on the box, fleet operator gets nothing');
    assert.match(fs.readFileSync(path.join(String(process.env.OPENCLAW_WORKSPACE_PATH), 'notification-failures.jsonl'), 'utf8'), /system_alert/);
  } finally {
    cap.restore();
  }
});

// ── Operator-owned boxes: the owner IS an operator (their own box). ──────────
const OWN_OPERATOR_ID = '6771245262'; // an operator whose own box this is

test('operator-owned box (marker): the box owner\'s own recorded operator id is the owner, not the fleet operator', async () => {
  cleanEnv();
  const ws = makeBox({ channels: { telegram: { allowFrom: [OPERATOR_ID, OWN_OPERATOR_ID] } } },
    { ownerChat: Number(OWN_OPERATOR_ID) });
  fs.writeFileSync(path.join(path.dirname(ws), '.operator-is-owner'), 'operator-owned\n');
  const notify = await freshNotify();
  const cap = capture(notify);
  try {
    assert.equal(notify.resolveOwnerChatId(), OWN_OPERATOR_ID);
    assert.equal(notify.notifyOwner('Your task is complete.'), true);
    assert.deepEqual(cap.sends.map((s) => s.chatId), [OWN_OPERATOR_ID], 'delivered to the box owner only');
    assert.ok(!fs.existsSync(path.join(ws, 'notification-failures.jsonl')), 'nothing undeliverable');
  } finally {
    cap.restore();
  }
});

test('operator-owned box (CC_OPERATOR_IS_OWNER=1): a pinned OPENCLAW_OWNER_CHAT_ID operator id resolves', async () => {
  cleanEnv();
  makeBox({ env: { vars: { OPENCLAW_OWNER_CHAT_ID: OWN_OPERATOR_ID } } });
  process.env.CC_OPERATOR_IS_OWNER = '1';
  const notify = await freshNotify();
  try {
    assert.equal(notify.resolveOwnerChatId(), OWN_OPERATOR_ID);
  } finally {
    delete process.env.CC_OPERATOR_IS_OWNER;
  }
});

test('client box (not operator-owned): the same operator pin still resolves nothing', async () => {
  cleanEnv();
  makeBox({ env: { vars: { OPENCLAW_OWNER_CHAT_ID: OWN_OPERATOR_ID } } }, { ownerChat: Number(OWN_OPERATOR_ID) });
  const notify = await freshNotify();
  assert.equal(notify.resolveOwnerChatId(), null);
});

test('no tracked pm2 config marks a box operator-owned (it ships to client boxes)', () => {
  const repo = path.resolve(__dirname, '../..');
  for (const f of fs.readdirSync(repo).filter((n) => /^ecosystem.*\.c?js$/.test(n))) {
    const src = fs.readFileSync(path.join(repo, f), 'utf8');
    assert.doesNotMatch(src, /^\s*CC_OPERATOR_IS_OWNER\s*:/m, `${f} sets CC_OPERATOR_IS_OWNER`);
  }
});

test('operator-owned box with the operator alert webhook: SYSTEM alerts still relay, operator box only (2026-10-02)', async () => {
  cleanEnv();
  const ws = makeBox({
    channels: { telegram: { allowFrom: ['6663821679', OPERATOR_ID] } },
    env: { vars: { OPENCLAW_OWNER_CHAT_ID: '6663821679',
      FLEET_STANDING_GATE_URL: 'https://n8n.example.test/webhook/fleet-standing-check',
      FLEET_STANDING_GATE_SECRET: 'test-secret' } },
  });
  fs.writeFileSync(path.join(path.dirname(ws), '.operator-is-owner'), 'operator-owned\n');
  const notify = await freshNotify();
  const cap = capture(notify);
  try {
    assert.equal(notify.notifySystem('[DISPATCH] placement refused'), true);
    assert.deepEqual(cap.sends, [], "no Telegram through the box's own bot (it would reach the box owner)");
    assert.equal(cap.posts.length, 1);
    assert.equal(cap.posts[0].url, 'https://n8n.example.test/webhook/fleet-standing-alert');
  } finally {
    cap.restore();
  }
});
