/**
 * interview-key-stability.test.ts — WF-011 / BU-20.
 *
 * THE BUG THIS PREVENTS: the interview key was SHA-256(hostname + a 32-byte
 * salt). Rename the box, or restore it under another name, and the same
 * derivation produced a different key — the owner's saved answers became
 * unreadable forever, with the data still sitting on the disk.
 *
 * Proves:
 *   1. a v2 key file (32 salt bytes followed by the 32-byte key) keeps
 *      decrypting after the machine name changes;
 *   2. an older box's exactly-32-byte salt file still decrypts with its
 *      original name, and that first successful decrypt writes
 *      `.interview-key-salt.v2` beside it, which then becomes the key;
 *   3. a truncated (10-byte) salt file makes encryption throw
 *      `InterviewKeyUnavailable` and is left exactly as it was — never
 *      overwritten, never guessed around.
 *
 * No DB, no network, no live box. One temp HOME per case, cleaned up.
 */

import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  decryptAtRest,
  encryptAtRest,
  InterviewKeyUnavailable,
  _resetKeyCache,
} from '../../src/lib/interview/crypto';

// These cases exercise the key-file branch, never the env-secret branch. This
// file runs in its own process (node --test), so deleting them cannot leak.
delete process.env.MC_INTERVIEW_SECRET;
delete process.env.MC_BOX_SECRET;

const SALT_FILE = '.interview-key-salt';
const KEY_FILE_V2 = '.interview-key-salt.v2';

/** Point the module at a throwaway HOME and a hostname this test can change. */
function isolatedHome(t: TestContext): { home: string; setHostname: (name: string) => void } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bu20-interview-key-'));
  let hostname = 'box-original';
  t.mock.method(os, 'homedir', () => home);
  t.mock.method(os, 'hostname', () => hostname);
  t.after(() => {
    _resetKeyCache();
    fs.rmSync(home, { recursive: true, force: true });
  });
  return { home, setHostname: (name: string) => { hostname = name; } };
}

function keyDir(home: string): string {
  return path.join(home, '.openclaw');
}

/** The legacy v1 derivation, built here exactly as the old code did. */
function legacyKey(hostname: string, salt: Buffer): Buffer {
  return crypto
    .createHash('sha256')
    .update(Buffer.concat([Buffer.from(hostname, 'utf-8'), salt]))
    .digest();
}

/** Build a wire-format envelope under a given key, without touching key files. */
function encryptWith(key: Buffer, plaintext: string): string {
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('chacha20-poly1305', key, nonce, { authTagLength: 16 });
  const body = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()]);
  // nonce ‖ tag ‖ ciphertext, base64 — the wire format crypto.ts reads.
  return 'enc:v1:' + Buffer.concat([nonce, cipher.getAuthTag(), body]).toString('base64');
}

test('a v2 key file keeps decrypting after the machine name changes', (t) => {
  const { home, setHostname } = isolatedHome(t);
  _resetKeyCache();

  const envelope = encryptAtRest('answers written on the original box');
  const v2 = path.join(keyDir(home), KEY_FILE_V2);
  assert.equal(fs.statSync(v2).size, 64, 'first use writes 32 salt bytes followed by a 32-byte key');

  setHostname('box-renamed');
  _resetKeyCache(); // a fresh process starts with an empty cache

  assert.equal(decryptAtRest(envelope), 'answers written on the original box');
});

test('an older 32-byte salt file decrypts with its original name and writes the v2 file', (t) => {
  const { home, setHostname } = isolatedHome(t);
  _resetKeyCache();

  const salt = crypto.randomBytes(32);
  fs.mkdirSync(keyDir(home), { recursive: true, mode: 0o700 });
  const v1 = path.join(keyDir(home), SALT_FILE);
  fs.writeFileSync(v1, salt, { mode: 0o600 });
  const v2 = path.join(keyDir(home), KEY_FILE_V2);
  assert.equal(fs.existsSync(v2), false, 'precondition: only the legacy file exists');

  const envelope = encryptWith(legacyKey('box-original', salt), 'answers from before the change');
  assert.equal(decryptAtRest(envelope), 'answers from before the change');
  assert.equal(fs.statSync(v2).size, 64, 'the first successful legacy decrypt writes the v2 file');
  assert.equal(fs.readFileSync(v1).length, 32, 'the legacy salt file is left exactly as it was');

  // v2 is the key for everything from here on: the machine name no longer matters.
  setHostname('box-renamed');
  _resetKeyCache();
  assert.equal(
    decryptAtRest(encryptAtRest('written after the migration')),
    'written after the migration',
  );
});

test('a truncated salt file refuses to encrypt and is left untouched', (t) => {
  const { home } = isolatedHome(t);
  _resetKeyCache();

  fs.mkdirSync(keyDir(home), { recursive: true });
  const v1 = path.join(keyDir(home), SALT_FILE);
  fs.writeFileSync(v1, crypto.randomBytes(10), { mode: 0o600 });

  assert.throws(
    () => encryptAtRest('must not be written'),
    (err: unknown) => err instanceof InterviewKeyUnavailable && err.name === 'InterviewKeyUnavailable',
    'a corrupt salt file must fail closed, never be replaced',
  );
  assert.equal(fs.statSync(v1).size, 10, 'the 10-byte file is unchanged');
  assert.equal(fs.existsSync(path.join(keyDir(home), KEY_FILE_V2)), false, 'no new key file is written');
});
