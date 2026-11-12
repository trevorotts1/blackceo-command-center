/**
 * Interview answer encryption at rest (U048).
 *
 * chacha20-poly1305 AEAD encryption for the interview transcript and the DB
 * mirror's answer/question columns. Key material is resolved at runtime from
 * the box identity secret (MC_INTERVIEW_SECRET, falling back to MC_BOX_SECRET,
 * then a per-box key file that carries its own key — see WF-011 below). NEVER
 * hardcoded, NEVER committed.
 *
 * WF-011 — THE KEY NO LONGER DEPENDS ON THE MACHINE'S NAME. The key file
 * `.interview-key-salt.v2` is 64 bytes: 32 random salt bytes followed by the
 * 32-byte key itself, so bytes 32 to 63 ARE the key and no hostname enters the
 * derivation. A box renamed (or restored under a new name) still reads its own
 * answers. A legacy 32-byte `.interview-key-salt` file is still accepted for
 * READING — today's SHA-256(hostname + salt) derivation — and the first
 * successful decrypt writes the v2 file beside it and re-encrypts the
 * transcript with it (readEncryptedFile). A salt file that is unreadable or
 * the wrong size is NEVER overwritten: `InterviewKeyUnavailable` is thrown so
 * callers answer 503 "temporarily unavailable" and write nothing.
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

/** Legacy v1 key file: 32 random salt bytes only; the key was derived from the
 * machine name + that salt. Read for older boxes, never written. */
const LEGACY_SALT_FILE = '.interview-key-salt';
/** v2 key file: 32 salt bytes followed by the 32-byte key. Written on first use. */
const KEY_FILE_V2 = '.interview-key-salt.v2';
const V2_FILE_BYTES = 2 * KEY_BYTES;

/* ─────────────────────────── Key resolution ──────────────────────────────── */

/**
 * Thrown when this box's interview key material cannot be used: a key/salt
 * file is unreadable or the wrong size, or new material cannot be persisted.
 * An existing file is never overwritten to recover. Callers answer 503
 * "temporarily unavailable" and write nothing.
 */
export class InterviewKeyUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InterviewKeyUnavailable';
  }
}

let _cachedKey: Buffer | null = null;

function keyDir(): string {
  return path.join(os.homedir(), '.openclaw');
}

function legacySaltPath(): string {
  return path.join(keyDir(), LEGACY_SALT_FILE);
}

function v2KeyPath(): string {
  return path.join(keyDir(), KEY_FILE_V2);
}

/**
 * Read one key file and require an exact size. A missing file returns null; a
 * file that exists but cannot be read or is the wrong size throws
 * `InterviewKeyUnavailable` — it is evidence of an older/corrupt box, and
 * overwriting it would destroy the only way to read the answers it protects.
 */
function readKeyFile(file: string, expectedBytes: number, label: string): Buffer | null {
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new InterviewKeyUnavailable(
      `${label} at ${file} is unreadable: ${err instanceof Error ? err.message : 'read failed'}`,
    );
  }
  if (bytes.length !== expectedBytes) {
    throw new InterviewKeyUnavailable(
      `${label} at ${file} is ${bytes.length} bytes, expected ${expectedBytes}; it is never overwritten`,
    );
  }
  return bytes;
}

/** The v2 key: bytes 32 to 63 of the 64-byte file, no hostname involved. */
function readV2Key(): Buffer | null {
  const material = readKeyFile(v2KeyPath(), V2_FILE_BYTES, 'interview key file');
  return material ? material.subarray(KEY_BYTES) : null;
}

/** The legacy key: today's SHA-256(hostname + 32-byte salt), READ paths only. */
function readLegacyKey(): Buffer | null {
  const salt = readKeyFile(legacySaltPath(), KEY_BYTES, 'legacy interview salt file');
  if (!salt) return null;
  const hostname = os.hostname() || 'unknown-box';
  return crypto
    .createHash('sha256')
    .update(Buffer.concat([Buffer.from(hostname, 'utf-8'), salt]))
    .digest();
}

/**
 * First use on this box: write 32 random salt bytes followed by a 32-byte
 * random key to `.interview-key-salt.v2` (mode 0600). Never overwrites — the
 * write is exclusive, and a file another process won the race for is read and
 * used instead. Failure to persist is fatal for encryption: a key that lives
 * only in memory would make this box's answers unreadable on the next boot.
 */
function createV2Key(): Buffer {
  const dir = keyDir();
  const file = v2KeyPath();
  const material = crypto.randomBytes(V2_FILE_BYTES);
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, material, { mode: 0o600, flag: 'wx' });
    return material.subarray(KEY_BYTES);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      const existing = readV2Key();
      if (existing) return existing;
    }
    throw new InterviewKeyUnavailable(
      `cannot persist interview key material at ${file}: ${err instanceof Error ? err.message : 'write failed'}`,
    );
  }
}

function envKey(): Buffer | null {
  const fromEnv =
    process.env.MC_INTERVIEW_SECRET || process.env.MC_BOX_SECRET || '';
  if (!fromEnv.trim()) return null;
  // Accept hex-encoded or raw strings; normalize to 32 bytes via SHA-256.
  return crypto.createHash('sha256').update(fromEnv.trim()).digest();
}

/**
 * Resolve the 32-byte key used to WRITE. Priority:
 *   1. MC_INTERVIEW_SECRET env var (hex or raw string, SHA-256 hashed to 32B)
 *   2. MC_BOX_SECRET env var (same treatment)
 *   3. .interview-key-salt.v2 — the key is bytes 32 to 63 of that file
 *   4. first use: create the v2 file (after validating any legacy v1 file, so a
 *      corrupt one still fails closed instead of being silently outgrown)
 *
 * The key is cached in-process after first resolution.
 */
export function resolveInterviewKey(): Buffer {
  if (_cachedKey) return _cachedKey;

  const fromEnv = envKey();
  if (fromEnv) {
    _cachedKey = fromEnv;
    return _cachedKey;
  }

  const existingV2 = readV2Key();
  if (existingV2) {
    _cachedKey = existingV2;
    return _cachedKey;
  }

  // A legacy file is not the write key any more, but it must be usable before
  // this box starts writing under a new one: an unreadable/short v1 file throws
  // here, exactly as it would on the read path.
  readLegacyKey();
  _cachedKey = createV2Key();
  return _cachedKey;
}

/** Test-only: clear the cached key so a new env/key file is picked up. */
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

/** Decrypt one envelope with one key. Returns null on any failure (wrong key,
 * tampered/corrupt data, malformed envelope) — never throws. */
function decryptWithKey(key: Buffer, envelope: string): string | null {
  try {
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
 * Try the current key (env or v2), then the legacy v1 derivation. Reports
 * which key worked, so a file-level reader can re-encrypt what it just read
 * with the v2 key. Throws `InterviewKeyUnavailable` when a key file exists but
 * is unusable — a null here means only "this envelope does not decrypt".
 */
function decryptEnvelope(envelope: string): { plaintext: string; legacyKey: boolean } | null {
  const primary = _cachedKey ?? envKey() ?? readV2Key();
  if (primary) {
    const plaintext = decryptWithKey(primary, envelope);
    if (plaintext != null) {
      _cachedKey = primary;
      return { plaintext, legacyKey: false };
    }
  }

  const legacy = readLegacyKey();
  if (!legacy) return null;
  const plaintext = decryptWithKey(legacy, envelope);
  if (plaintext == null) return null;

  // First successful decrypt on an older box: write the v2 key file beside the
  // legacy salt (never overwriting anything) and use v2 from here on.
  if (!primary) _cachedKey = createV2Key();
  return { plaintext, legacyKey: true };
}

/**
 * Decrypt a wire-format envelope string back to UTF-8 plaintext. Tries the v2
 * key, then the legacy v1 (machine-name) derivation. Returns null if the input
 * is not a valid envelope or the ciphertext does not decrypt; throws
 * `InterviewKeyUnavailable` if this box's key material itself is unusable.
 */
export function decryptAtRest(envelope: string): string | null {
  if (!envelope.startsWith(ENVELOPE_PREFIX)) return null;
  const result = decryptEnvelope(envelope);
  return result ? result.plaintext : null;
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
 * Read and decrypt an encrypted file. Returns null if the file doesn't exist,
 * holds no envelope, or decryption fails. A file that only the legacy v1 key
 * could open is re-encrypted here with the v2 key (the one migration write of
 * WF-011) so the machine name stops mattering; the plaintext is still returned
 * if that rewrite cannot be made.
 */
export function readEncryptedFile(encPath: string): string | null {
  let envelope: string;
  try {
    envelope = fs.readFileSync(encPath, 'utf-8');
  } catch {
    return null;
  }
  if (!isEncryptedEnvelope(envelope)) return null;

  const result = decryptEnvelope(envelope);
  if (!result) return null;

  if (result.legacyKey) {
    try {
      writeEncryptedFile(encPath, result.plaintext);
    } catch {
      // Best-effort: the v2 key file is already written, so the next read (or
      // write) re-encrypts. The plaintext the caller asked for is returned.
    }
  }
  return result.plaintext;
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
