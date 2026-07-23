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
 */

import { describe, it, expect, vi } from 'vitest';
import {
  signInterviewBypassToken,
  verifyInterviewBypassToken,
  BYPASS_TTL_SECONDS,
} from '@/lib/interview/gate-cookie';

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
    const forged = `${btoa(JSON.stringify({ exp: 9999999999 })).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`;
    const ok = await verifyInterviewBypassToken(forged);
    expect(ok).toBe(false);
  });

  it('verifyInterviewBypassToken returns false for an expired token', async () => {
    vi.useFakeTimers();
    try {
      // Sign a REAL token while fake timers are active
      const { value } = await signInterviewBypassToken();

      // Token should be valid right now
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
});
