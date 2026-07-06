/**
 * Unit tests for the hardened owner-chat resolution + gateway send contract in
 * src/lib/notify.ts. Runs under `npm run test:unit` (node --import tsx --test).
 *
 * Verifies:
 *   1. S0: OPENCLAW_OWNER_CHAT_ID env pin resolves — and an OPERATOR id pinned
 *      there is REJECTED (operator denylist applies to every source).
 *   2. S1: channels.telegram.allowFrom in the openclaw.json that sits beside
 *      the workspace resolves the first NON-OPERATOR entry.
 *   3. S1b: commands.ownerAllowFrom is honored when the channel list is
 *      operator-only.
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

// ── 1. env pin resolves; operator ids pinned there are rejected ──────────────
test('S0: OPENCLAW_OWNER_CHAT_ID resolves, but an operator id is rejected', () => {
  clearConfig();
  clearSessions();

  process.env.OPENCLAW_OWNER_CHAT_ID = CLIENT_ID;
  assert.equal(resolveOwnerChatId(), CLIENT_ID);

  process.env.OPENCLAW_OWNER_CHAT_ID = OPERATOR_ID;
  assert.equal(resolveOwnerChatId(), null, 'operator id must never resolve as owner');

  delete process.env.OPENCLAW_OWNER_CHAT_ID;
});

// ── 2. allowFrom resolution (first non-operator entry) ───────────────────────
test('S1: channels.telegram.allowFrom resolves first non-operator entry', () => {
  clearSessions();
  writeConfig({
    channels: { telegram: { allowFrom: [OPERATOR_ID, CLIENT_ID, OPERATOR_ID_2] } },
  });
  assert.equal(resolveOwnerChatId(), CLIENT_ID);
  clearConfig();
});

// ── 3. commands.ownerAllowFrom fallback ───────────────────────────────────────
test('S1b: commands.ownerAllowFrom honored when channel list is operator-only', () => {
  clearSessions();
  writeConfig({
    channels: { telegram: { allowFrom: [OPERATOR_ID] } },
    commands: { ownerAllowFrom: [CLIENT_ID] },
  });
  assert.equal(resolveOwnerChatId(), CLIENT_ID);
  clearConfig();
});

// ── 4. operator-only sessions resolve to null (no legacy any-session fallback) ─
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
