// Device Identity Management for OpenClaw Gateway Pairing
// Generates and persists Ed25519 device identity for secure pairing with OpenClaw gateway

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { deviceIdentityDir, legacyDeviceIdentityDir } from '../platform';

interface DeviceIdentity {
  deviceId: string;
  publicKeyPem: string;
  privateKeyPem: string;
}

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

const IDENTITY_FILENAME = 'device.json';

/**
 * Absolute path to the persistent device-identity file for this platform.
 * Resolved at call time (NOT at module load) so `detectPlatform()` and the
 * `BCC_DEVICE_IDENTITY_DIR` override are honored after the env is populated.
 */
export function deviceIdentityFile(): string {
  return path.join(deviceIdentityDir(), IDENTITY_FILENAME);
}

/**
 * Absolute path to the legacy (`~/.mission-control/identity/device.json`)
 * identity file. Used only for the one-time forward migration.
 */
function legacyDeviceIdentityFile(): string {
  return path.join(legacyDeviceIdentityDir(), IDENTITY_FILENAME);
}

// Base64url encoding (RFC 4648)
function base64UrlEncode(buf: Buffer): string {
  return buf.toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/g, '');
}

// Derive raw 32-byte public key from PEM
function derivePublicKeyRaw(publicKeyPem: string): Buffer {
  const spki = crypto.createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' });
  if (spki.length === ED25519_SPKI_PREFIX.length + 32 &&
      spki.subarray(0, ED25519_SPKI_PREFIX.length).equals(ED25519_SPKI_PREFIX)) {
    return spki.subarray(ED25519_SPKI_PREFIX.length);
  }
  return spki;
}

// SHA-256 fingerprint of public key = deviceId
function fingerprintPublicKey(publicKeyPem: string): string {
  const raw = derivePublicKeyRaw(publicKeyPem);
  return crypto.createHash('sha256').update(raw).digest('hex');
}

// Get base64url-encoded raw public key (for wire format)
export function publicKeyRawBase64Url(publicKeyPem: string): string {
  return base64UrlEncode(derivePublicKeyRaw(publicKeyPem));
}

// Generate a new Ed25519 identity
function generateIdentity(): DeviceIdentity {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  return {
    deviceId: fingerprintPublicKey(publicKeyPem),
    publicKeyPem,
    privateKeyPem,
  };
}

/**
 * Parse + validate a stored identity file. Returns the identity on success,
 * or throws if the file exists but is unreadable / malformed. Returns null
 * only when the file does not exist.
 *
 * Throwing on a corrupt-but-present file is deliberate: silently minting a
 * NEW keypair when an old one is merely unreadable would change the deviceId
 * and orphan a device the gateway already approved. The caller decides what
 * to do (it does NOT regenerate over an existing file).
 */
function readIdentityFile(filePath: string): DeviceIdentity | null {
  if (!fs.existsSync(filePath)) return null;
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    throw new Error(
      `Device identity at ${filePath} exists but could not be read: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(
      `Device identity at ${filePath} exists but is not valid JSON. Refusing to regenerate (a new keypair would orphan the gateway-approved device). Fix or remove the file deliberately.`,
    );
  }
  const p = parsed as Record<string, unknown>;
  if (p?.version === 1 && typeof p.deviceId === 'string' && typeof p.publicKeyPem === 'string' && typeof p.privateKeyPem === 'string') {
    // Re-derive the deviceId from the public key so a hand-edited deviceId
    // can never disagree with the actual keypair.
    return {
      deviceId: fingerprintPublicKey(p.publicKeyPem),
      publicKeyPem: p.publicKeyPem,
      privateKeyPem: p.privateKeyPem,
    };
  }
  throw new Error(
    `Device identity at ${filePath} exists but is missing required fields. Refusing to regenerate over it.`,
  );
}

function writeIdentityFile(filePath: string, identity: DeviceIdentity): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const stored = {
    version: 1,
    deviceId: identity.deviceId,
    publicKeyPem: identity.publicKeyPem,
    privateKeyPem: identity.privateKeyPem,
    createdAtMs: Date.now(),
  };
  fs.writeFileSync(filePath, JSON.stringify(stored, null, 2) + '\n', { mode: 0o600 });
}

/**
 * One-time forward migration: if the persistent path has no identity yet but a
 * legacy `~/.mission-control/identity/device.json` exists (the pre-v4.1.2
 * location used on BOTH platforms), copy it forward so a box that was paired
 * before the fix keeps its already-approved deviceId. Best-effort: any failure
 * is non-fatal (the caller falls through to load-or-create on the new path).
 */
function migrateLegacyIdentityIfPresent(targetFile: string): void {
  const legacyFile = legacyDeviceIdentityFile();
  if (path.resolve(legacyFile) === path.resolve(targetFile)) return; // same path (Mac default) — nothing to migrate
  if (fs.existsSync(targetFile)) return; // already have a persistent identity
  let legacy: DeviceIdentity | null;
  try {
    legacy = readIdentityFile(legacyFile);
  } catch {
    return; // legacy file corrupt — do not propagate, just skip
  }
  if (!legacy) return;
  try {
    writeIdentityFile(targetFile, legacy);
    console.log(`[OpenClaw] Migrated legacy device identity ${legacy.deviceId} from ${legacyFile} to ${targetFile}`);
  } catch (err) {
    console.warn('[OpenClaw] Legacy device-identity migration failed (will load/create on persistent path):', err);
  }
}

/**
 * Load the persistent device identity, or create one on first run.
 *
 * Behavior:
 *   - Resolves the persistent path via `deviceIdentityFile()` (VPS: under
 *     `/data`; Mac: `~/.mission-control`). Pass `filePath` to override (tests).
 *   - Migrates a legacy `~/.mission-control` identity forward on first VPS run.
 *   - Loads an existing identity verbatim (re-deriving the deviceId).
 *   - Generates + persists a NEW keypair ONLY when no file exists at all.
 *   - THROWS if the file exists but is corrupt — never silently regenerates,
 *     so an already-approved device is never orphaned.
 */
export function loadOrCreateDeviceIdentity(filePath: string = deviceIdentityFile()): DeviceIdentity {
  migrateLegacyIdentityIfPresent(filePath);

  const existing = readIdentityFile(filePath); // may throw on corrupt file (intentional)
  if (existing) return existing;

  const identity = generateIdentity();
  writeIdentityFile(filePath, identity);
  return identity;
}

// Sign a payload with the device's private key (Ed25519)
export function signDevicePayload(privateKeyPem: string, payload: string): string {
  const key = crypto.createPrivateKey(privateKeyPem);
  return base64UrlEncode(crypto.sign(null, Buffer.from(payload, 'utf8'), key));
}

// Build the canonical payload string for signing
export function buildDeviceAuthPayload(params: {
  deviceId: string;
  clientId: string;
  clientMode: string;
  role: string;
  scopes: string[];
  signedAtMs: number;
  token: string | null;
  nonce?: string;
}): string {
  const version = params.nonce ? 'v2' : 'v1';
  const scopeStr = params.scopes.join(',');
  const token = params.token ?? '';
  const base = [version, params.deviceId, params.clientId, params.clientMode, params.role, scopeStr, String(params.signedAtMs), token];
  if (version === 'v2') base.push(params.nonce ?? '');
  return base.join('|');
}
