/**
 * u033-cert-format.test.ts -- U033 (audit E3): certificate format validation at the schema layer.
 *
 * Proves that UpdateTaskSchema:
 *   - accepts a valid 64-hex digest (lowercase, uppercase, whitespace-padded)
 *   - rejects non-hex, wrong-length, and empty strings
 *   - still accepts a payload that omits the field entirely (the .optional() ordering guard)
 *   - does not require any unrelated field
 *
 *   node --import tsx --test tests/unit/u033-cert-format.test.ts
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { UpdateTaskSchema } from '../../src/lib/validation';

const HEX_64 = 'a'.repeat(64);

test('valid lowercase 64-hex digest is accepted and preserved lowercased', () => {
  const r = UpdateTaskSchema.safeParse({
    status: 'done',
    process_certificate_sha: HEX_64,
  });
  assert.equal(r.success, true);
  assert.equal((r.data as Record<string, unknown>).process_certificate_sha, HEX_64);
});

test('valid UPPERCASE 64-hex digest is accepted and lowercased by transform', () => {
  const r = UpdateTaskSchema.safeParse({
    status: 'done',
    process_certificate_sha: HEX_64.toUpperCase(),
  });
  assert.equal(r.success, true);
  assert.equal((r.data as Record<string, unknown>).process_certificate_sha, HEX_64);
});

test('whitespace-padded 64-hex digest is accepted and trimmed', () => {
  const r = UpdateTaskSchema.safeParse({
    status: 'done',
    process_certificate_sha: '  ' + HEX_64 + '  ',
  });
  assert.equal(r.success, true);
  assert.equal((r.data as Record<string, unknown>).process_certificate_sha, HEX_64);
});

test('64 non-hex chars (z.repeat(64)) is rejected', () => {
  const r = UpdateTaskSchema.safeParse({
    status: 'done',
    process_certificate_sha: 'z'.repeat(64),
  });
  assert.equal(r.success, false);
});

test('63 hex chars is rejected (too short)', () => {
  const r = UpdateTaskSchema.safeParse({
    status: 'done',
    process_certificate_sha: 'a'.repeat(63),
  });
  assert.equal(r.success, false);
});

test('65 hex chars is rejected (too long)', () => {
  const r = UpdateTaskSchema.safeParse({
    status: 'done',
    process_certificate_sha: 'a'.repeat(65),
  });
  assert.equal(r.success, false);
});

test('empty string is rejected', () => {
  const r = UpdateTaskSchema.safeParse({
    status: 'done',
    process_certificate_sha: '',
  });
  assert.equal(r.success, false);
});

test('field entirely absent is ACCEPTED -- the .optional() ordering guard', () => {
  const r = UpdateTaskSchema.safeParse({ status: 'done' });
  assert.equal(r.success, true);
  assert.equal((r.data as Record<string, unknown>).process_certificate_sha, undefined);
});

test('unrelated field only (title) is accepted -- no field became required', () => {
  const r = UpdateTaskSchema.safeParse({ title: 'x' });
  assert.equal(r.success, true);
});
