/**
 * Unit tests for the v4.1.2 stable device identity (Problem A).
 *
 * Runs via the Node built-in test runner under tsx (`npm run test:unit`).
 * Uses a throwaway temp dir for the identity file so nothing touches the real
 * ~/.mission-control path.
 *
 * Covers:
 *   - First run creates + persists an identity at the given path (mode 0600).
 *   - A second load returns the SAME deviceId (no silent regeneration) — the
 *     core of the connect-failure fix.
 *   - A corrupt-but-present file THROWS instead of minting a new keypair (which
 *     would orphan a gateway-approved device).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { loadOrCreateDeviceIdentity } from '../../src/lib/openclaw/device-identity';

// Isolate HOME so the legacy-migration probe (which reads
// ~/.mission-control/identity) cannot pick up the test host's real identity.
// os.homedir() on POSIX resolves from $HOME.
const ORIGINAL_HOME = process.env.HOME;
const ISOLATED_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'bcc-home-'));
process.env.HOME = ISOLATED_HOME;
process.on('exit', () => {
  if (ORIGINAL_HOME === undefined) delete process.env.HOME;
  else process.env.HOME = ORIGINAL_HOME;
});

function tmpIdentityFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bcc-id-'));
  return path.join(dir, 'device.json');
}

test('first run creates and persists an identity', () => {
  const file = tmpIdentityFile();
  const id = loadOrCreateDeviceIdentity(file);
  assert.match(id.deviceId, /^[0-9a-f]{64}$/, 'deviceId is a sha256 hex fingerprint');
  assert.ok(id.publicKeyPem.includes('BEGIN PUBLIC KEY'));
  assert.ok(id.privateKeyPem.includes('BEGIN PRIVATE KEY'));
  assert.ok(fs.existsSync(file), 'identity file written to disk');
  // 0600 perms (owner read/write only).
  const mode = fs.statSync(file).mode & 0o777;
  assert.equal(mode, 0o600);
});

test('second load returns the SAME deviceId (no silent regeneration)', () => {
  const file = tmpIdentityFile();
  const first = loadOrCreateDeviceIdentity(file);
  const second = loadOrCreateDeviceIdentity(file);
  assert.equal(second.deviceId, first.deviceId, 'identity must be stable across loads');
  assert.equal(second.privateKeyPem, first.privateKeyPem);
});

test('a corrupt identity file THROWS instead of regenerating', () => {
  const file = tmpIdentityFile();
  loadOrCreateDeviceIdentity(file); // create a valid one first
  fs.writeFileSync(file, '{ this is not valid json', { mode: 0o600 });
  assert.throws(
    () => loadOrCreateDeviceIdentity(file),
    /not valid JSON|Refusing to regenerate/i,
    'must refuse to mint a new keypair over a corrupt file',
  );
});
