/**
 * U057 — Interview skip/defer bypass option tests.
 *
 * Tests:
 *   1. Main behavior: signInterviewBypassToken produces a verifiable token.
 *   2. Main behavior: verifyInterviewBypassToken accepts a valid, non-expired token.
 *   3. Edge case: verifyInterviewBypassToken rejects an expired token.
 *   4. Edge case: verifyInterviewBypassToken rejects a tampered token.
 *   5. Edge case: verifyInterviewBypassToken rejects an absent/null/empty token.
 *   6. Edge case: bypass token expires after BYPASS_TTL_SECONDS (1 hour).
 *   7. MR-17 fix2: the URL escape-hatch token is SINGLE-USE — a replay is refused.
 *   8. MR-17 fix2: each minted token carries a distinct nonce (no shared nonce).
 *   9. MR-17 fix2: the COOKIE verifier is NON-consuming — the same token stays
 *      valid across repeated presentations (a "Skip for now" session), while the
 *      URL verifier consumes it.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  signInterviewBypassToken,
  verifyInterviewBypassToken,
  verifyInterviewBypassCookieToken,
  BYPASS_TTL_SECONDS,
} from '@/lib/interview/gate-cookie';
import { __resetBypassNoncesForTest } from '@/lib/interview/bypass-replay';

beforeEach(() => {
  // The replay ledger is module-scope state; reset it so single-use assertions
  // in one test never leak into another.
  __resetBypassNoncesForTest();
});

describe('U057 — Interview skip/defer bypass cookie', () => {
  it('signs a bypass token that verifies successfully', async () => {
    const { value, maxAge } = await signInterviewBypassToken();
    expect(maxAge).toBe(BYPASS_TTL_SECONDS);
    expect(value).toBeTruthy();
    expect(typeof value).toBe('string');
    expect(value).toContain('.');

    const ok = await verifyInterviewBypassToken(value);
    expect(ok).toBe(true);
  });

  it('verifyInterviewBypassToken returns false for a null/undefined/empty token', async () => {
    expect(await verifyInterviewBypassToken(null)).toBe(false);
    expect(await verifyInterviewBypassToken(undefined)).toBe(false);
    expect(await verifyInterviewBypassToken('')).toBe(false);
  });

  it('verifyInterviewBypassToken returns false for a tampered token', async () => {
    const { value } = await signInterviewBypassToken();
    const [payload, sig] = value.split('.');
    const tampered = `${payload}.${sig}_tampered`;
    const ok = await verifyInterviewBypassToken(tampered);
    expect(ok).toBe(false);
  });

  it('verifyInterviewBypassToken returns false for a forged payload', async () => {
    // Forge a payload with a fake signature — must reject.
    const forged = `${btoa(JSON.stringify({ exp: 9999999999, nonce: 'x' })).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`;
    const ok = await verifyInterviewBypassToken(forged);
    expect(ok).toBe(false);
  });

  it('verifyInterviewBypassToken returns false for an expired token', async () => {
    vi.useFakeTimers();
    try {
      // Sign a REAL token while fake timers are active
      const { value } = await signInterviewBypassToken();

      // Token should be valid right now (consumes its single nonce)
      expect(await verifyInterviewBypassToken(value)).toBe(true);

      // Advance time past the TTL
      vi.advanceTimersByTime((BYPASS_TTL_SECONDS + 1) * 1000);

      // Now the real signed token should be expired
      const ok = await verifyInterviewBypassToken(value);
      expect(ok).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('bypass TTL is exactly 1 hour (3600 seconds)', () => {
    expect(BYPASS_TTL_SECONDS).toBe(3600);
  });

  /* ── MR-17 fix2 — nonce + revocation (replay resistance) ─────────────── */

  it('the URL escape-hatch token is SINGLE-USE: first verify passes, a replay is refused', async () => {
    const { value } = await signInterviewBypassToken();
    // First URL presentation consumes the nonce → admitted.
    expect(await verifyInterviewBypassToken(value)).toBe(true);
    // Replays of the SAME captured URL are refused (nonce already consumed).
    expect(await verifyInterviewBypassToken(value)).toBe(false);
    expect(await verifyInterviewBypassToken(value)).toBe(false);
  });

  it('each minted token carries a distinct nonce (no shared/reused nonce)', async () => {
    const a = await signInterviewBypassToken();
    const b = await signInterviewBypassToken();
    // Distinct tokens (distinct nonces) — consuming one must not consume the other.
    expect(a.value).not.toBe(b.value);
    expect(await verifyInterviewBypassToken(a.value)).toBe(true);
    expect(await verifyInterviewBypassToken(b.value)).toBe(true);
    // Both are now consumed; replays of either are refused.
    expect(await verifyInterviewBypassToken(a.value)).toBe(false);
    expect(await verifyInterviewBypassToken(b.value)).toBe(false);
  });

  it('the COOKIE verifier is NON-consuming: the same token stays valid across repeated loads (session grant)', async () => {
    const { value } = await signInterviewBypassToken();
    // The browser resends the same httpOnly cookie on every navigation of a
    // "Skip for now" session — the cookie verifier must admit EVERY load for the
    // whole TTL, not just the first (consuming it would bounce the operator to
    // /interview on the second page load — the regression this test locks out).
    expect(await verifyInterviewBypassCookieToken(value)).toBe(true);
    expect(await verifyInterviewBypassCookieToken(value)).toBe(true);
    expect(await verifyInterviewBypassCookieToken(value)).toBe(true);
  });

  it('a nonce burned via the URL path cannot be laundered into a cookie grant', async () => {
    const { value } = await signInterviewBypassToken();
    // Consume it as a one-time URL.
    expect(await verifyInterviewBypassToken(value)).toBe(true);
    // The now-consumed nonce must NOT then validate as a (non-consuming) cookie.
    expect(await verifyInterviewBypassCookieToken(value)).toBe(false);
  });

  it('a token without a nonce is rejected by BOTH verifiers (legacy replayable shape)', async () => {
    // Reconstruct the pre-fix payload shape ({exp} only, no nonce) and sign it
    // with the REAL key — it must still be refused, proving the nonce is mandatory.
    const { webcrypto } = await import('node:crypto');
    const secret = process.env.MC_INTERVIEW_COOKIE_SECRET
      || process.env.MC_API_TOKEN
      || process.env.WEBHOOK_SECRET
      || 'mc-interview-gate-unsigned-dev-secret';
    const enc = new TextEncoder();
    const key = await webcrypto.subtle.importKey(
      'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
    );
    const payloadB64 = btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 }))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const sig = new Uint8Array(await webcrypto.subtle.sign('HMAC', key, enc.encode(payloadB64)));
    let bin = '';
    for (let i = 0; i < sig.length; i++) bin += String.fromCharCode(sig[i]);
    const sigB64 = btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const nonceless = `${payloadB64}.${sigB64}`;
    expect(await verifyInterviewBypassToken(nonceless)).toBe(false);
    expect(await verifyInterviewBypassCookieToken(nonceless)).toBe(false);
  });
});
