/**
 * Unit tests for the hardened owner-chat resolution + gateway send contract in
 * src/lib/notify.ts. Runs under `npm run test:unit` (node --import tsx --test).
 *
 * Verifies:
 *   1. S0: OPENCLAW_OWNER_CHAT_ID env pin resolves — an OPERATOR id pinned
 *      there too (an operator's own box, v7.6.80).
 *   2. allowFrom / ownerAllowFrom ORDER is never an owner record (a spouse
 *      listed first received a client's stop-cards): it resolves nothing, and
 *      neither does an operator-only allowFrom with nothing pinned.
 *   3. The explicit owner records resolve, in order: openclaw.json env.vars,
 *      <root>/secrets/.env, the build state's ownerChat — an operator's pinned
 *      ownerChat included; a client box is unchanged.
 *   4. S2 hardening: a sessions file whose ONLY direct session is an operator
 *      id resolves to null (the legacy "any session" fallback is gone).
 *   5. CLI-flag contract: the gateway send uses the REAL `openclaw message
 *      send` flags (--target/--message). The old --to/--text flags do not
 *      exist on the CLI and made every owner send fail silently — pin the fix.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Isolated openclaw root: <root>/openclaw.json + <root>/workspace/…
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-notify-res-'));
const WORKSPACE = path.join(ROOT, 'workspace');
fs.mkdirSync(WORKSPACE, { recursive: true });

process.env.OPENCLAW_WORKSPACE_PATH = WORKSPACE;
process.env.OWNER_NOTIFY_TELEGRAM_DISABLED = '1';
delete process.env.OPENCLAW_OWNER_CHAT_ID;

const OPERATOR_ID = '5252140759'; // known operator id (config, not a secret)
const OPERATOR_ID_2 = '6663821679';
const CLIENT_ID = '1000000042'; // synthetic — not a real client

type NotifyModule = typeof import('../../src/lib/notify');
let resolveOwnerChatId: NotifyModule['resolveOwnerChatId'];

test.before(async () => {
  const mod = await import('../../src/lib/notify');
  resolveOwnerChatId = mod.resolveOwnerChatId;
});

test.after(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
});

function writeConfig(cfg: Record<string, unknown>): void {
  fs.writeFileSync(path.join(ROOT, 'openclaw.json'), JSON.stringify(cfg), 'utf-8');
}

function clearConfig(): void {
  fs.rmSync(path.join(ROOT, 'openclaw.json'), { force: true });
}

function writeSessions(ids: string[]): void {
  const dir = path.join(WORKSPACE, 'agents', 'main', 'sessions');
  fs.mkdirSync(dir, { recursive: true });
  const sessions: Record<string, unknown> = {};
  ids.forEach((id, i) => {
    sessions[`agent:main:telegram:direct:${id}`] = { ts: i };
  });
  fs.writeFileSync(path.join(dir, 'sessions.json'), JSON.stringify(sessions), 'utf-8');
}

function clearSessions(): void {
  fs.rmSync(path.join(WORKSPACE, 'agents'), { recursive: true, force: true });
}

// ── 1. env pin resolves, an operator's own pinned id included ────────────────
test('S0: OPENCLAW_OWNER_CHAT_ID resolves, an operator id pinned there too', () => {
  clearConfig();
  clearSessions();

  process.env.OPENCLAW_OWNER_CHAT_ID = CLIENT_ID;
  assert.equal(resolveOwnerChatId(), CLIENT_ID);

  // An operator's own box: the pin is the owner.
  process.env.OPENCLAW_OWNER_CHAT_ID = OPERATOR_ID_2;
  assert.equal(resolveOwnerChatId(), OPERATOR_ID_2, 'a pinned operator id is the owner of its own box');

  delete process.env.OPENCLAW_OWNER_CHAT_ID;
});

// ── 2. allowFrom resolution (first non-operator entry) ───────────────────────
test('allowFrom order is NOT an owner record: nothing resolves from it', () => {
  clearConfig();
  clearSessions();
  delete process.env.OPENCLAW_OWNER_CHAT_ID;
  writeConfig({
    channels: { telegram: { allowFrom: [CLIENT_ID, '1000000077'] } },
    commands: { ownerAllowFrom: [CLIENT_ID] },
  });
  assert.equal(resolveOwnerChatId(), null);
  // An operator's box with nothing pinned stays fail-closed: allowFrom holding
  // only operator ids is still a guess, never an owner record.
  writeConfig({ channels: { telegram: { allowFrom: [OPERATOR_ID, OPERATOR_ID_2] } } });
  assert.equal(resolveOwnerChatId(), null);
  clearConfig();
});

test('the explicit owner records resolve: env.vars, then secrets/.env, then build-state ownerChat', () => {
  clearConfig();
  clearSessions();
  delete process.env.OPENCLAW_OWNER_CHAT_ID;
  const secrets = path.join(ROOT, 'secrets');
  const state = path.join(WORKSPACE, '.workforce-build-state.json');
  try {
    fs.writeFileSync(state, JSON.stringify({ ownerChat: 1000000033 }));
    assert.equal(resolveOwnerChatId(), '1000000033', 'build-state ownerChat');
    fs.mkdirSync(secrets, { recursive: true });
    fs.writeFileSync(path.join(secrets, '.env'), 'OTHER=x\nexport OPENCLAW_OWNER_CHAT_ID="1000000022"\n');
    assert.equal(resolveOwnerChatId(), '1000000022', 'secrets/.env beats the build state');
    writeConfig({ env: { vars: { OPENCLAW_OWNER_CHAT_ID: CLIENT_ID } }, channels: { telegram: { allowFrom: ['1000000077'] } } });
    assert.equal(resolveOwnerChatId(), CLIENT_ID, 'openclaw.json env.vars beats secrets/.env');
    writeConfig({ env: { vars: { OPENCLAW_OWNER_CHAT_ID: OPERATOR_ID } } });
    assert.equal(resolveOwnerChatId(), OPERATOR_ID, 'an operator id pinned in env.vars is the owner');
  } finally {
    clearConfig();
    fs.rmSync(secrets, { recursive: true, force: true });
    fs.rmSync(state, { force: true });
  }
});

test('v7.6.80: an operator id pinned only as the build-state ownerChat resolves; ownerChat 0 resolves nothing', () => {
  clearConfig();
  clearSessions();
  delete process.env.OPENCLAW_OWNER_CHAT_ID;
  const state = path.join(WORKSPACE, '.workforce-build-state.json');
  try {
    writeConfig({ channels: { telegram: { allowFrom: [OPERATOR_ID, OPERATOR_ID_2] } } });
    fs.writeFileSync(state, JSON.stringify({ ownerChat: Number(OPERATOR_ID_2) }));
    assert.equal(resolveOwnerChatId(), OPERATOR_ID_2, 'the operator who owns this box');
    fs.writeFileSync(state, JSON.stringify({ ownerChat: 0 }));
    assert.equal(resolveOwnerChatId(), null, 'ownerChat 0 is not a record: fail closed');
  } finally {
    clearConfig();
    fs.rmSync(state, { force: true });
  }
});

test('v7.6.80: a client box is unchanged — the client pin wins, the operator listed first in allowFrom does not', () => {
  clearConfig();
  clearSessions();
  delete process.env.OPENCLAW_OWNER_CHAT_ID;
  const state = path.join(WORKSPACE, '.workforce-build-state.json');
  try {
    writeConfig({
      env: { vars: { OPENCLAW_OWNER_CHAT_ID: CLIENT_ID } },
      channels: { telegram: { allowFrom: [OPERATOR_ID, CLIENT_ID] } },
    });
    fs.writeFileSync(state, JSON.stringify({ ownerChat: Number(CLIENT_ID) }));
    assert.equal(resolveOwnerChatId(), CLIENT_ID);
  } finally {
    clearConfig();
    fs.rmSync(state, { force: true });
  }
});

test('S2: operator-only sessions file resolves to null', () => {
  clearConfig();
  writeSessions([OPERATOR_ID, OPERATOR_ID_2]);
  assert.equal(
    resolveOwnerChatId(),
    null,
    'a box where only operators have DMed must not resolve an owner chat',
  );
  clearSessions();
});

// ── 5. gateway CLI-flag contract (pin the --target/--message fix) ─────────────
test('gateway send uses --target/--message (never the nonexistent --to/--text)', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', '..', 'src', 'lib', 'notify.ts'),
    'utf-8',
  );
  assert.ok(src.includes("'--target'"), 'must pass --target to openclaw message send');
  assert.ok(src.includes("'--message'"), 'must pass --message to openclaw message send');
  assert.ok(!src.includes("'--to',"), '--to is not a real openclaw flag (send would fail)');
  assert.ok(!src.includes("'--text'"), '--text is not a real openclaw flag (send would fail)');
});
