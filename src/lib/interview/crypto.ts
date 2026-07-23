/**
 * Interview answer encryption at rest (U048).
 *
 * chacha20-poly1305 AEAD encryption for the interview transcript and the DB
 * mirror's answer/question columns. Key material is resolved at runtime from
 * the box identity secret (MC_INTERVIEW_SECRET, falling back to
 * MC_BOX_SECRET, then a SHA-256 derivation of the box hostname + a per-box
 * salt file). NEVER hardcoded, NEVER committed.
 *
 * Wire format (file):  "enc:v1:" + base64(nonce ‖ tag ‖ ciphertext)
 * Wire format (DB):    same string stored in the TEXT column.
 *
 * The nonce is 12 random bytes per encrypt call (never reused with the same
 * key). The 16-byte poly1305 tag is prepended to the ciphertext inside the
 * base64 envelope so decrypt can verify integrity before returning plaintext.
 */

import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

const ALGORITHM = 'chacha20-poly1305';
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
const ENVELOPE_PREFIX = 'enc:v1:';

/* ─────────────────────────── Key resolution ──────────────────────────────── */

let _cachedKey: Buffer | null = null;

/**
 * Resolve the 32-byte encryption key. Priority:
 *   1. MC_INTERVIEW_SECRET env var (hex or raw string, SHA-256 hashed to 32B)
 *   2. MC_BOX_SECRET env var (same treatment)
 *   3. Per-box salt file (~/.openclaw/.interview-key-salt) + hostname,
 *      SHA-256 hashed to 32B. The salt file is created on first use with
 *      32 random bytes (mode 0600).
 *
 * The key is cached in-process after first resolution.
 */
export function resolveInterviewKey(): Buffer {
  if (_cachedKey) return _cachedKey;

  const fromEnv =
    process.env.MC_INTERVIEW_SECRET || process.env.MC_BOX_SECRET || '';
  if (fromEnv.trim()) {
    // Accept hex-encoded or raw strings; normalize to 32 bytes via SHA-256.
    _cachedKey = crypto.createHash('sha256').update(fromEnv.trim()).digest();
    return _cachedKey;
  }

  // Derive from box identity: hostname + a persistent per-box random salt.
  const saltDir = path.join(os.homedir(), '.openclaw');
  const saltPath = path.join(saltDir, '.interview-key-salt');
  let salt: Buffer;
  try {
    salt = fs.readFileSync(saltPath);
    if (salt.length < 32) throw new Error('salt too short');
  } catch {
    salt = crypto.randomBytes(32);
    try {
      fs.mkdirSync(saltDir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(saltPath, salt, { mode: 0o600 });
    } catch {
      // Non-fatal: key still works for this process lifetime; persistence
      // retries on next boot. A box that cannot write its salt still encrypts.
    }
  }
  const hostname = os.hostname() || 'unknown-box';
  _cachedKey = crypto
    .createHash('sha256')
    .update(Buffer.concat([Buffer.from(hostname, 'utf-8'), salt.subarray(0, 32)]))
    .digest();
  return _cachedKey;
}

/** Test-only: clear the cached key so a new env/salt is picked up. */
export function _resetKeyCache(): void {
  _cachedKey = null;
}

/* ─────────────────────────── Encrypt / Decrypt ───────────────────────────── */

/**
 * Encrypt a UTF-8 plaintext string. Returns the wire-format envelope string
 * ("enc:v1:" + base64). Throws on crypto failure (callers decide fallback).
 */
export function encryptAtRest(plaintext: string): string {
  const key = resolveInterviewKey();
  const nonce = crypto.randomBytes(NONCE_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, key, nonce, {
    authTagLength: TAG_BYTES,
  });
  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf-8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  // nonce ‖ tag ‖ ciphertext
  const envelope = Buffer.concat([nonce, tag, encrypted]);
  return ENVELOPE_PREFIX + envelope.toString('base64');
}

/**
 * Decrypt a wire-format envelope string back to UTF-8 plaintext.
 * Returns null if the input is not a valid envelope or integrity check fails.
 */
export function decryptAtRest(envelope: string): string | null {
  if (!envelope.startsWith(ENVELOPE_PREFIX)) return null;
  try {
    const key = resolveInterviewKey();
    const raw = Buffer.from(envelope.slice(ENVELOPE_PREFIX.length), 'base64');
    if (raw.length < NONCE_BYTES + TAG_BYTES) return null;
    const nonce = raw.subarray(0, NONCE_BYTES);
    const tag = raw.subarray(NONCE_BYTES, NONCE_BYTES + TAG_BYTES);
    const ciphertext = raw.subarray(NONCE_BYTES + TAG_BYTES);
    const decipher = crypto.createDecipheriv(ALGORITHM, key, nonce, {
      authTagLength: TAG_BYTES,
    });
    decipher.setAuthTag(tag);
    const decrypted = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);
    return decrypted.toString('utf-8');
  } catch {
    return null;
  }
}

/**
 * True when the string looks like an encrypted envelope (starts with the
 * prefix). Used by read paths to decide whether to decrypt or pass through.
 */
export function isEncryptedEnvelope(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.startsWith(ENVELOPE_PREFIX);
}

/**
 * Smart decrypt: if the value is an encrypted envelope, decrypt it; otherwise
 * return it as-is (plaintext passthrough for pre-migration data).
 */
export function decryptOrPassthrough(value: string | null | undefined): string | null {
  if (value == null) return null;
  if (isEncryptedEnvelope(value)) return decryptAtRest(value);
  return value;
}

/* ─────────────────────────── File-level encryption ───────────────────────── */

/**
 * Encrypt a UTF-8 string and write it to `encPath` in the wire-format envelope.
 * Atomic: writes to a temp file then renames. Creates parent dirs as needed.
 */
export function writeEncryptedFile(encPath: string, plaintext: string): void {
  const envelope = encryptAtRest(plaintext);
  const dir = path.dirname(encPath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${encPath}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, envelope, 'utf-8');
  fs.renameSync(tmp, encPath);
}

/**
 * Read and decrypt an encrypted file. Returns null if the file doesn't exist
 * or decryption fails.
 */
export function readEncryptedFile(encPath: string): string | null {
  try {
    const envelope = fs.readFileSync(encPath, 'utf-8');
    return decryptAtRest(envelope);
  } catch {
    return null;
  }
}

/**
 * U048 migration: if a plaintext file exists at `plainPath` and no encrypted
 * file exists at `encPath`, encrypt the plaintext content into `encPath` and
 * remove the plaintext file. Returns true if a migration was performed.
 * Never throws — a migration failure leaves the plaintext in place (the read
 * path falls back to it).
 */
export function migratePlaintextFile(plainPath: string, encPath: string): boolean {
  try {
    if (fs.existsSync(encPath)) return false; // already migrated
    if (!fs.existsSync(plainPath)) return false; // nothing to migrate
    const plaintext = fs.readFileSync(plainPath, 'utf-8');
    writeEncryptedFile(encPath, plaintext);
    fs.unlinkSync(plainPath);
    return true;
  } catch {
    return false;
  }
}
