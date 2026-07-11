/**
 * presentations-cert-gate.test.ts — FIX C done-gate (pure, no DB).
 *
 * Guards: a presentations task can reach done/delivered ONLY with a matching
 * process_certificate_sha; non-presentations tasks and non-terminal moves are
 * never gated; the registered cert cannot be spoofed with a different one.
 *
 *   node --import tsx --test tests/unit/presentations-cert-gate.test.ts
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluatePresentationsDoneGate } from '../../src/lib/presentations-cert-gate';

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);

test('presentations → done with NO certificate is refused (required)', () => {
  const r = evaluatePresentationsDoneGate({
    department: 'presentations',
    currentStatus: 'review',
    targetStatus: 'done',
    storedCert: null,
    providedCert: null,
  });
  assert.equal(r.applies, true);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'process_certificate_required');
});

test('presentations → done WITH a valid presented certificate passes + persists it', () => {
  const r = evaluatePresentationsDoneGate({
    department: 'presentations',
    currentStatus: 'review',
    targetStatus: 'done',
    storedCert: null,
    providedCert: SHA_A,
  });
  assert.equal(r.applies, true);
  assert.equal(r.ok, true);
  assert.equal(r.persistCert, SHA_A);
});

test('presentations → done presenting a DIFFERENT cert than registered is a mismatch (anti-spoof)', () => {
  const r = evaluatePresentationsDoneGate({
    department: 'presentations',
    currentStatus: 'review',
    targetStatus: 'done',
    storedCert: SHA_A,
    providedCert: SHA_B,
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'process_certificate_mismatch');
});

test('presentations → done with the SAME registered cert passes (nothing new to persist)', () => {
  const r = evaluatePresentationsDoneGate({
    department: 'presentations',
    currentStatus: 'review',
    targetStatus: 'done',
    storedCert: SHA_A,
    providedCert: SHA_A,
  });
  assert.equal(r.ok, true);
  assert.equal(r.persistCert ?? null, null);
});

test('registered cert but mover presents nothing is refused', () => {
  const r = evaluatePresentationsDoneGate({
    department: 'presentations',
    currentStatus: 'review',
    targetStatus: 'done',
    storedCert: SHA_A,
    providedCert: null,
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'process_certificate_required');
});

test('aliased presentations slug variants are still gated (canonicalized)', () => {
  const r = evaluatePresentationsDoneGate({
    department: 'dept-presentations',
    currentStatus: 'in_progress',
    targetStatus: 'done',
    storedCert: null,
    providedCert: null,
  });
  assert.equal(r.applies, true);
  assert.equal(r.ok, false);
});

test('NON-presentations task is never gated', () => {
  const r = evaluatePresentationsDoneGate({
    department: 'marketing',
    currentStatus: 'review',
    targetStatus: 'done',
    storedCert: null,
    providedCert: null,
  });
  assert.equal(r.applies, false);
  assert.equal(r.ok, true);
});

test('non-terminal move (→ review) is never gated even for presentations', () => {
  const r = evaluatePresentationsDoneGate({
    department: 'presentations',
    currentStatus: 'in_progress',
    targetStatus: 'review',
    storedCert: null,
    providedCert: null,
  });
  assert.equal(r.applies, false);
  assert.equal(r.ok, true);
});

test('already-done presentations task (no status change) is not re-gated', () => {
  const r = evaluatePresentationsDoneGate({
    department: 'presentations',
    currentStatus: 'done',
    targetStatus: 'done',
    storedCert: null,
    providedCert: null,
  });
  assert.equal(r.applies, false);
  assert.equal(r.ok, true);
});
