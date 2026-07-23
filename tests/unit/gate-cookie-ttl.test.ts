/**
 * gate-cookie-ttl.test.ts — U047: Interview completion cookie TTL extension.
 *
 * BUG: COMPLETE_TTL_SECONDS was 24h, causing browser-session cookie loss and
 * re-interview loops. FIX: extended to 30 days.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

let polyfilled = false;
function ensureCrypto() {
  if (polyfilled) return;
  if (!(globalThis as any).crypto?.subtle) {
    Object.defineProperty(globalThis.crypto, 'subtle', {
      value: crypto.webcrypto.subtle, configurable: true,
    });
  }
  polyfilled = true;
}

const TEST_SECRET = 'u047-gate-cookie-ttl-test-secret-32ch';
const ONE_DAY = 24 * 60 * 60;
const THIRTY_DAYS = 30 * ONE_DAY;

test('U047: COMPLETE_TTL_SECONDS >= 30 days', async () => {
  ensureCrypto();
  process.env.MC_INTERVIEW_COOKIE_SECRET = TEST_SECRET;
  delete process.env.NODE_ENV;
  const mod = await import('../../src/lib/interview/gate-cookie');
  assert.ok(mod.COMPLETE_TTL_SECONDS >= THIRTY_DAYS,
    `must be >= 30 days (${THIRTY_DAYS}s), got ${mod.COMPLETE_TTL_SECONDS}s`);
});

test('U047: signInterviewToken(true) maxAge >= 30 days', async () => {
  ensureCrypto();
  process.env.MC_INTERVIEW_COOKIE_SECRET = TEST_SECRET;
  delete process.env.NODE_ENV;
  const mod = await import('../../src/lib/interview/gate-cookie');
  const { value, maxAge } = await mod.signInterviewToken(true);
  assert.ok(maxAge >= THIRTY_DAYS, `maxAge must be >= 30 days, got ${maxAge}s`);
  assert.ok(typeof value === 'string' && value.length > 30);
  assert.ok(value.includes('.'));
});

test('U047 edge: incomplete TTL unchanged (60s)', async () => {
  ensureCrypto();
  process.env.MC_INTERVIEW_COOKIE_SECRET = TEST_SECRET;
  delete process.env.NODE_ENV;
  const mod = await import('../../src/lib/interview/gate-cookie');
  assert.equal(mod.INCOMPLETE_TTL_SECONDS, 60);
  const { maxAge } = await mod.signInterviewToken(false);
  assert.ok(maxAge <= 300, `incomplete maxAge must be short, got ${maxAge}s`);
});

test('U047: exp field is roughly now + 30 days', async () => {
  ensureCrypto();
  process.env.MC_INTERVIEW_COOKIE_SECRET = TEST_SECRET;
  delete process.env.NODE_ENV;
  const mod = await import('../../src/lib/interview/gate-cookie');
  const before = Math.floor(Date.now() / 1000);
  const { value } = await mod.signInterviewToken(true);
  const after = Math.floor(Date.now() / 1000);
  const b64 = value.split('.')[0].replace(/-/g, '+').replace(/_/g, '/');
  const pad = b64.length % 4 === 0 ? '' : '='.repeat(4 - (b64.length % 4));
  const dec = JSON.parse(Buffer.from(b64 + pad, 'base64').toString('utf-8'));
  assert.ok(typeof dec.exp === 'number' && dec.exp > 0);
  assert.equal(dec.complete, true);
  assert.ok(dec.exp >= before + THIRTY_DAYS - 10 && dec.exp <= after + THIRTY_DAYS + 10,
    `exp ${dec.exp} not in range`);
});

test('U047: valid complete token verifies', async () => {
  ensureCrypto();
  process.env.MC_INTERVIEW_COOKIE_SECRET = TEST_SECRET;
  delete process.env.NODE_ENV;
  const mod = await import('../../src/lib/interview/gate-cookie');
  const { value } = await mod.signInterviewToken(true);
  const v = await mod.verifyInterviewToken(value);
  assert.equal(v.complete, true);
  assert.equal(v.valid, true);
  assert.equal(v.expired, false);
});
