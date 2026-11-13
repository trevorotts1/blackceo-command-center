/**
 * BU-112 — the owner-sends hold is honoured by every sender and is never
 * reported as a delivery failure.
 *
 * PROVES (state file with `ownerSendsHold: true` and a valid owner chat, a stub
 * `openclaw` on PATH, OWNER_NOTIFY_ALLOW_SEND_IN_TEST=1):
 *   1. notifyOwner() returns false and NEVER spawns the CLI.
 *   2. The durable log holds exactly one `owner_send_held` entry and NO
 *      `owner_undeliverable` entry — a hold is a deliberate pause, not a
 *      failed delivery, so it must not raise the undeliverable alarm.
 *   3. notifyOwnerPrivate() answers `not-dispatched`.
 *
 * Run: node --import tsx --test tests/unit/notify-owner-sends-hold.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const OWNER_ID = '1000000042'; // synthetic
const COMPANY_ID = 'co-bu-112';

function cleanEnv(): void {
  for (const k of [
    'OWNER_NOTIFY_TELEGRAM_DISABLED',
    'OPENCLAW_OWNER_CHAT_ID',
    'CC_OPERATOR_CHAT_ID',
    'OPENCLAW_OPERATOR_CHAT_ID',
    'CC_OPERATOR_IS_OWNER',
    'FLEET_OPERATOR_ALERT_URL',
    'FLEET_STANDING_GATE_URL',
    'FLEET_STANDING_GATE_SECRET',
    'FLEET_STANDING_GATE_HEADER',
    'RESCUE_RANGERS_WEBHOOK_URL',
  ]) delete process.env[k];
}

test('ownerSendsHold=true: no send, no undeliverable, private delivery not-dispatched', async () => {
  cleanEnv();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-notify-hold-'));
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(path.join(root, 'openclaw.json'), JSON.stringify({}), 'utf8');
  fs.writeFileSync(
    path.join(workspace, '.workforce-build-state.json'),
    JSON.stringify({ ownerChat: Number(OWNER_ID), ownerSendsHold: true }),
    'utf8',
  );

  // Stub `openclaw` on PATH: it records every invocation in a marker file.
  const bin = path.join(root, 'bin');
  const ranMarker = path.join(root, 'openclaw-ran');
  fs.mkdirSync(bin, { recursive: true });
  const stub = path.join(bin, 'openclaw');
  fs.writeFileSync(stub, `#!/bin/sh\necho "$@" >> ${JSON.stringify(ranMarker)}\nexit 0\n`, 'utf8');
  fs.chmodSync(stub, 0o755);

  process.env.OPENCLAW_WORKSPACE_PATH = workspace;
  process.env.OWNER_NOTIFY_ALLOW_SEND_IN_TEST = '1';
  const savedPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${savedPath ?? ''}`;

  try {
    const notify = (await import(
      `../../src/lib/notify?u=${Math.random()}`
    )) as typeof import('../../src/lib/notify');

    assert.equal(notify.ownerSendsHeld(), true);

    assert.equal(notify.notifyOwner('x'), false);
    assert.equal(fs.existsSync(ranMarker), false, 'the stub CLI must never be run while held');

    const priv = await notify.notifyOwnerPrivate({
      companyId: COMPANY_ID,
      expectedChatId: OWNER_ID,
      message: 'x',
    });
    assert.equal(priv.status, 'not-dispatched');

    const kinds = fs
      .readFileSync(path.join(workspace, 'notification-failures.jsonl'), 'utf8')
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line).kind as string);
    assert.equal(kinds.filter((k) => k === 'owner_send_held').length, 1, 'one hold record');
    assert.equal(kinds.filter((k) => k === 'owner_undeliverable').length, 0, 'a hold is not a failure');
  } finally {
    process.env.PATH = savedPath;
    delete process.env.OPENCLAW_WORKSPACE_PATH;
  }
});
