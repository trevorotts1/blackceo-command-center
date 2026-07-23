/**
 * U048 — Interview answers encryption at rest.
 *
 * Asserts:
 *   1. encryptAtRest produces an envelope that does NOT contain the plaintext.
 *   2. decryptAtRest round-trips back to the original plaintext.
 *   3. writeEncryptedFile → readEncryptedFile round-trips.
 *   4. The raw bytes on disk do NOT contain the answer string.
 *   5. decryptOrPassthrough passes plaintext through unchanged (pre-migration).
 *   6. migratePlaintextFile encrypts-in-place and removes the plaintext.
 *   7. DB mirror: upsertAnswer encrypts, listAnswers decrypts.
 */
import os from 'os';
import fs from 'fs';
import path from 'path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

// Isolated DB — must be imported before any @/lib/db import.
import './_isolated-db';

// Force a known test key so encryption is deterministic across runs.
process.env.MC_INTERVIEW_SECRET = 'u048-test-secret-do-not-use-in-prod';

import {
  encryptAtRest,
  decryptAtRest,
  decryptOrPassthrough,
  isEncryptedEnvelope,
  writeEncryptedFile,
  readEncryptedFile,
  migratePlaintextFile,
  _resetKeyCache,
} from '@/lib/interview/crypto';

const ANSWER = 'My business goal is to scale to 50 clients by Q4 with $2M ARR.';

let tmpDir: string;

beforeAll(() => {
  _resetKeyCache();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'u048-test-'));
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('U048 crypto primitives', () => {
  it('encryptAtRest produces an envelope that hides the plaintext', () => {
    const envelope = encryptAtRest(ANSWER);
    expect(envelope).toMatch(/^enc:v1:/);
    // The raw envelope must NOT contain the plaintext answer.
    expect(envelope).not.toContain(ANSWER);
    expect(envelope).not.toContain('business goal');
  });

  it('decryptAtRest round-trips to the original plaintext', () => {
    const envelope = encryptAtRest(ANSWER);
    const decrypted = decryptAtRest(envelope);
    expect(decrypted).toBe(ANSWER);
  });

  it('decryptAtRest returns null for non-envelope input', () => {
    expect(decryptAtRest('plaintext answer')).toBeNull();
    expect(decryptAtRest('')).toBeNull();
  });

  it('decryptAtRest returns null for tampered envelope', () => {
    const envelope = encryptAtRest(ANSWER);
    // Flip a character in the base64 payload.
    const tampered = envelope.slice(0, 10) + 'X' + envelope.slice(11);
    expect(decryptAtRest(tampered)).toBeNull();
  });

  it('isEncryptedEnvelope detects envelopes correctly', () => {
    expect(isEncryptedEnvelope(encryptAtRest('test'))).toBe(true);
    expect(isEncryptedEnvelope('plaintext')).toBe(false);
    expect(isEncryptedEnvelope(null)).toBe(false);
    expect(isEncryptedEnvelope(undefined)).toBe(false);
  });

  it('decryptOrPassthrough passes plaintext through unchanged', () => {
    expect(decryptOrPassthrough(ANSWER)).toBe(ANSWER);
    expect(decryptOrPassthrough(null)).toBeNull();
  });

  it('decryptOrPassthrough decrypts envelopes', () => {
    const envelope = encryptAtRest(ANSWER);
    expect(decryptOrPassthrough(envelope)).toBe(ANSWER);
  });

  it('each encryption produces a unique envelope (random nonce)', () => {
    const e1 = encryptAtRest(ANSWER);
    const e2 = encryptAtRest(ANSWER);
    expect(e1).not.toBe(e2); // different nonces
    expect(decryptAtRest(e1)).toBe(ANSWER);
    expect(decryptAtRest(e2)).toBe(ANSWER);
  });
});

describe('U048 file-level encryption', () => {
  it('writeEncryptedFile → readEncryptedFile round-trips', () => {
    const encPath = path.join(tmpDir, 'transcript.md.enc');
    writeEncryptedFile(encPath, ANSWER);
    expect(readEncryptedFile(encPath)).toBe(ANSWER);
  });

  it('raw bytes on disk do NOT contain the answer string', () => {
    const encPath = path.join(tmpDir, 'raw-check.md.enc');
    writeEncryptedFile(encPath, ANSWER);
    const rawBytes = fs.readFileSync(encPath, 'utf-8');
    expect(rawBytes).not.toContain(ANSWER);
    expect(rawBytes).not.toContain('business goal');
    expect(rawBytes).toMatch(/^enc:v1:/);
  });

  it('readEncryptedFile returns null for missing file', () => {
    expect(readEncryptedFile(path.join(tmpDir, 'nonexistent.enc'))).toBeNull();
  });

  it('migratePlaintextFile encrypts-in-place and removes plaintext', () => {
    const plainPath = path.join(tmpDir, 'migrate-test.md');
    const encPath = `${plainPath}.enc`;
    fs.writeFileSync(plainPath, ANSWER, 'utf-8');

    const migrated = migratePlaintextFile(plainPath, encPath);
    expect(migrated).toBe(true);
    expect(fs.existsSync(plainPath)).toBe(false); // plaintext removed
    expect(fs.existsSync(encPath)).toBe(true); // encrypted exists
    expect(readEncryptedFile(encPath)).toBe(ANSWER); // content preserved
  });

  it('migratePlaintextFile is idempotent (skips when .enc exists)', () => {
    const plainPath = path.join(tmpDir, 'idempotent.md');
    const encPath = `${plainPath}.enc`;
    fs.writeFileSync(plainPath, ANSWER, 'utf-8');
    writeEncryptedFile(encPath, ANSWER);

    const migrated = migratePlaintextFile(plainPath, encPath);
    expect(migrated).toBe(false); // already migrated
    expect(fs.existsSync(plainPath)).toBe(true); // plaintext untouched
  });
});

describe('U048 DB mirror encryption', () => {
  it('upsertAnswer encrypts the answer column; listAnswers decrypts', async () => {
    // Dynamic import so _isolated-db has already set DATABASE_PATH.
    const { upsertAnswer, listAnswers } = await import('@/lib/interview/store');
    const { queryOne } = await import('@/lib/db');

    const sessionId = 'u048-test-session';
    upsertAnswer({
      sessionId,
      questionNumber: 1,
      question: 'What is your business goal?',
      answer: ANSWER,
    });

    // The RAW DB row must hold the encrypted envelope, not the plaintext.
    const rawRow = queryOne<{ answer: string }>(
      `SELECT answer FROM interview_answers WHERE session_id = ? AND question_number = 1`,
      [sessionId],
    );
    expect(rawRow).toBeTruthy();
    expect(rawRow!.answer).toMatch(/^enc:v1:/);
    expect(rawRow!.answer).not.toContain(ANSWER);

    // The public API (listAnswers) must return the decrypted plaintext.
    const rows = listAnswers(sessionId);
    expect(rows.length).toBe(1);
    expect(rows[0].answer).toBe(ANSWER);
  });
});
