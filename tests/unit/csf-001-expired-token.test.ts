/**
 * CSF-001 — authentic-but-expired CSRF predicate.
 *
 * verifyCsrfToken() returns false for BOTH "forged" and "expired". The
 * middleware needs to tell those apart so it can safely re-mint ONLY a
 * visitor who once held a genuine server-minted token (re-minting on a
 * forged/absent token would hand an attacker a valid token).
 *
 * This suite proves isExpiredAuthenticCsrfToken() draws exactly that line:
 *   • authentic + live        -> verify true,  expired-predicate false
 *   • authentic + past exp    -> verify false, expired-predicate true
 *   • forged signature        -> verify false, expired-predicate false (NEGATIVE CONTROL)
 *   • absent / empty / undef  -> verify false, expired-predicate false (NEGATIVE CONTROL)
 *   • wrong role (not 'csrf') -> verify false, expired-predicate false (NEGATIVE CONTROL)
 *   • garbage string          -> verify false, expired-predicate false (NEGATIVE CONTROL)
 *
 * The past-exp case does NOT sleep: the clock is backdated 2h through the
 * module's REAL signCsrfToken() path, so the signature is genuine and the
 * exp lands 1h in the past.
 *
 * Style/imports follow tests/unit/middleware-same-origin-board.test.ts
 * (vitest globals + '@/...' alias).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import {
  signCsrfToken,
  verifyCsrfToken,
  isExpiredAuthenticCsrfToken,
} from '@/lib/csrf-protection';

const TEST_SECRET = 'csf-001-test-secret-value';

let savedSecret: string | undefined;

beforeEach(() => {
  savedSecret = process.env.MC_CSRF_COOKIE_SECRET;
  process.env.MC_CSRF_COOKIE_SECRET = TEST_SECRET;
});

afterEach(() => {
  if (savedSecret === undefined) delete process.env.MC_CSRF_COOKIE_SECRET;
  else process.env.MC_CSRF_COOKIE_SECRET = savedSecret;
  vi.useRealTimers();
});

function b64url(buf: Buffer): string {
  return buf
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * Sign an ARBITRARY payload under the same key the module uses (HMAC-SHA256
 * over the base64url payload, same UTF-8 key bytes) — used ONLY for the
 * wrong-role negative control, where the module itself can never mint such a
 * token (its role is hard-coded to 'csrf').
 */
function signRawPayload(payload: unknown): string {
  const payloadB64 = b64url(Buffer.from(JSON.stringify(payload), 'utf8'));
  const sig = b64url(createHmac('sha256', TEST_SECRET).update(payloadB64).digest());
  return `${payloadB64}.${sig}`;
}

describe('CSF-001 isExpiredAuthenticCsrfToken', () => {
  it('authentic + live token -> verify true, expired-predicate false', async () => {
    const { value } = await signCsrfToken();
    expect(await verifyCsrfToken(value)).toBe(true);
    expect(await isExpiredAuthenticCsrfToken(value)).toBe(false);
  });

  it('authentic + past-exp token (backdated clock, real sign path, no sleep) -> verify false, expired-predicate true', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() - 2 * 60 * 60 * 1000); // 2h back: exp lands 1h in the past
    const { value } = await signCsrfToken();
    vi.useRealTimers();
    expect(await verifyCsrfToken(value)).toBe(false);
    expect(await isExpiredAuthenticCsrfToken(value)).toBe(true);
  });

  it('forged signature -> verify false, expired-predicate false (NEGATIVE CONTROL — must not re-mint)', async () => {
    const { value } = await signCsrfToken();
    const dot = value.lastIndexOf('.');
    const sig = value.slice(dot + 1);
    const flipped = sig.slice(0, -1) + (sig.endsWith('A') ? 'B' : 'A');
    const forged = `${value.slice(0, dot + 1)}${flipped}`;
    expect(await verifyCsrfToken(forged)).toBe(false);
    expect(await isExpiredAuthenticCsrfToken(forged)).toBe(false);
  });

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['empty string', ''],
  ])(
    'absent/empty (%s) -> verify false, expired-predicate false (NEGATIVE CONTROL)',
    async (_label, v) => {
      expect(await verifyCsrfToken(v)).toBe(false);
      expect(await isExpiredAuthenticCsrfToken(v)).toBe(false);
    },
  );

  it("wrong role (valid signature, role != 'csrf') -> verify false, expired-predicate false (NEGATIVE CONTROL)", async () => {
    const liveWrongRole = signRawPayload({
      role: 'session',
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
    expect(await verifyCsrfToken(liveWrongRole)).toBe(false);
    expect(await isExpiredAuthenticCsrfToken(liveWrongRole)).toBe(false);
    // Role check dominates expiry: even a past-exp wrong-role token never re-mints.
    const expiredWrongRole = signRawPayload({
      role: 'session',
      exp: Math.floor(Date.now() / 1000) - 3600,
    });
    expect(await verifyCsrfToken(expiredWrongRole)).toBe(false);
    expect(await isExpiredAuthenticCsrfToken(expiredWrongRole)).toBe(false);
  });

  it('garbage string -> verify false, expired-predicate false (NEGATIVE CONTROL)', async () => {
    for (const g of ['not-a-token', '...', 'e30.e30.e30', 'zzzz']) {
      expect(await verifyCsrfToken(g)).toBe(false);
      expect(await isExpiredAuthenticCsrfToken(g)).toBe(false);
    }
  });

  it('dev-fallback hard-lock (production, no secrets) -> even a genuine expired token never re-mints (NEGATIVE CONTROL)', async () => {
    const { value } = await signCsrfToken(); // genuine, minted under TEST_SECRET
    const savedEnv = {
      NODE_ENV: process.env.NODE_ENV,
      MC_CSRF_COOKIE_SECRET: process.env.MC_CSRF_COOKIE_SECRET,
      MC_INTERVIEW_COOKIE_SECRET: process.env.MC_INTERVIEW_COOKIE_SECRET,
      MC_API_TOKEN: process.env.MC_API_TOKEN,
      WEBHOOK_SECRET: process.env.WEBHOOK_SECRET,
    };
    process.env.NODE_ENV = 'production';
    delete process.env.MC_CSRF_COOKIE_SECRET;
    delete process.env.MC_INTERVIEW_COOKIE_SECRET;
    delete process.env.MC_API_TOKEN;
    delete process.env.WEBHOOK_SECRET;
    try {
      expect(await verifyCsrfToken(value)).toBe(false);
      expect(await isExpiredAuthenticCsrfToken(value)).toBe(false);
    } finally {
      for (const [k, v] of Object.entries(savedEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});
