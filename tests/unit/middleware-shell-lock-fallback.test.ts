/**
 * tests/unit/middleware-shell-lock-fallback.test.ts — U010 regression lock
 *
 * MUTATION TARGET: removal of checkInterviewCompleteViaFallback() import
 * or call in src/middleware.ts. The test verifies the import and call site
 * exist by reading the source text. Remove either and this suite goes RED.
 *
 * Run with: npx vitest run tests/unit/middleware-shell-lock-fallback.test.ts
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const REPO_ROOT = process.cwd();
const MIDDLEWARE_SRC = path.join(REPO_ROOT, 'src', 'middleware.ts');

function readMiddleware(): string {
  return fs.readFileSync(MIDDLEWARE_SRC, 'utf-8');
}

describe('U010 — middleware shell-lock fallback wiring (static source checks)', () => {
  it('imports checkInterviewCompleteViaFallback from gate-fallback', () => {
    const src = readMiddleware();
    expect(
      src,
      'middleware must import checkInterviewCompleteViaFallback',
    ).toMatch(/import\s*{[^}]*checkInterviewCompleteViaFallback[^}]*}\s*from\s*['"]@\/lib\/interview\/gate-fallback['"]/);
  });

  it('imports signInterviewToken from gate-cookie', () => {
    const src = readMiddleware();
    expect(
      src,
      'middleware must import signInterviewToken',
    ).toMatch(/import\s*{[^}]*signInterviewToken[^}]*}\s*from\s*['"]@\/lib\/interview\/gate-cookie['"]/);
  });

  it('imports LATCH_COOKIE_NAME from gate-cookie', () => {
    const src = readMiddleware();
    expect(
      src,
      'middleware must import LATCH_COOKIE_NAME',
    ).toMatch(/import\s*{[^}]*LATCH_COOKIE_NAME[^}]*}\s*from\s*['"]@\/lib\/interview\/gate-cookie['"]/);
  });

  it('calls checkInterviewCompleteViaFallback in the shell-lock block', () => {
    const src = readMiddleware();
    expect(
      src,
      'middleware must CALL checkInterviewCompleteViaFallback',
    ).toContain('checkInterviewCompleteViaFallback(');
  });

  it('calls signInterviewToken(true) to mint cookie on fallback admission', () => {
    const src = readMiddleware();
    expect(
      src,
      'middleware must call signInterviewToken(true) when fallback admits',
    ).toContain('signInterviewToken(true)');
  });

  it('reads LATCH_COOKIE_NAME from cookies as fallback', () => {
    const src = readMiddleware();
    expect(
      src,
      'middleware must check LATCH_COOKIE_NAME cookie',
    ).toContain('cookies.get(LATCH_COOKIE_NAME)');
  });
});

describe('U010 — gate-fallback fail-closed', () => {
  it('checkInterviewCompleteViaFallback returns false on network error', async () => {
    const { checkInterviewCompleteViaFallback } = await import(
      '@/lib/interview/gate-fallback'
    );
    const result = await checkInterviewCompleteViaFallback('http://127.0.0.1:99999');
    expect(result, 'must fail closed on unreachable origin').toBe(false);
  });
});

describe('U010 — gate-cookie exports', () => {
  it('exports LATCH_COOKIE_NAME and signLatchToken', async () => {
    const mod = await import('@/lib/interview/gate-cookie');
    expect(typeof mod.LATCH_COOKIE_NAME).toBe('string');
    expect(mod.LATCH_COOKIE_NAME).toBe('mc_interview_gate_latch');
    expect(typeof mod.signLatchToken).toBe('function');
  });

  it('COMPLETE_TTL_SECONDS is at least 30 days', async () => {
    const mod = await import('@/lib/interview/gate-cookie');
    expect(mod.COMPLETE_TTL_SECONDS).toBeGreaterThanOrEqual(60 * 60 * 24 * 30);
  });

  it('does NOT export getInterviewCookieOptions (dead code removed)', async () => {
    const mod = await import('@/lib/interview/gate-cookie');
    expect(
      (mod as Record<string, unknown>).getInterviewCookieOptions,
      'getInterviewCookieOptions must be removed — dead export',
    ).toBeUndefined();
  });
});
