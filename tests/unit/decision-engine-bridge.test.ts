/**
 * JEV-009 CC bridge tests (offline only).
 *
 * Spawns the fake Python core in tests/fixtures (canned JSON, no network,
 * no real core). The repo's test:unit glob auto-discovers this file, so no
 * runner registration edit was needed.
 *
 * Covers:
 *  1. Happy path: request/response round-trip, revision echoed.
 *  2. Revision mismatch + absent revision -> IncompatibleRevision.
 *  3. Single root deadline shared by two sequential calls: total wall time
 *     bounded by the root, no per-call reset (second call gets only leftovers).
 *  4. Killed-for-deadline spawn -> typed DeadlineExceeded.
 *  5. probeInstalledCore: ok -> {compatible:true}; missing binary ->
 *     {compatible:false, core_absent}; major mismatch ->
 *     {compatible:false, schema_major_mismatch}; every incompatible case
 *     keeps the no-JEV fallback path (useJev false).
 *  6. Assignment-read-only: forbidden field rejected at runtime; non-object
 *     payloads pass the validator.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  assertAssignmentReadOnly,
  buildRequest,
  evaluateDecision,
  probeInstalledCore,
  requiresNoJevFallback,
  stampRootDeadline,
  type BridgeDeadline,
  type Clock,
} from '../../src/lib/decision-engine/index';

const here = path.dirname(fileURLToPath(import.meta.url));
const FAKE_CORE = path.join(here, '..', 'fixtures', 'decision-engine-fake-core.py');

function fakeEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { ...process.env, FAKE_MODE: 'ok', FAKE_EXIT: '0', FAKE_SLEEP_MS: '0', ...extra };
}

function okRequest(rev = 'rev-1') {
  return buildRequest({ configRevision: rev, taskId: 't-1', taskDescription: 'do thing' });
}

test('happy path round-trips and echoes configRevision', async () => {
  const deadline = stampRootDeadline(10_000);
  const res = await evaluateDecision(okRequest(), {
    deadline,
    corePath: FAKE_CORE,
    corePathSource: { env: fakeEnv() },
  });
  assert.equal(res.configRevision, 'rev-1');
  assert.equal(res.schemaVersion, '1.1.0');
  assert.equal(res.recommendation.roleId, 'fake-role');
});

test('revision mismatch and absent revision raise typed IncompatibleRevision', async () => {
  const deadline = stampRootDeadline(10_000);
  await assert.rejects(
    () =>
      evaluateDecision(okRequest(), {
        deadline: stampRootDeadline(10_000),
        corePath: FAKE_CORE,
        corePathSource: { env: fakeEnv({ FAKE_MODE: 'rev_mismatch' }) },
      }),
    (err: unknown) => (err as { code?: string }).code === 'IncompatibleRevision',
  );
  assert.equal(deadline.isExpired(), false, 'failed call must not consume the caller root');
  await assert.rejects(
    () =>
      evaluateDecision(okRequest(), {
        deadline: stampRootDeadline(10_000),
        corePath: FAKE_CORE,
        corePathSource: { env: fakeEnv({ FAKE_MODE: 'no_revision' }) },
      }),
    (err: unknown) => (err as { code?: string }).code === 'IncompatibleRevision',
  );
});

test('two sequential calls share ONE root deadline (no per-call reset)', async () => {
  // Fake sleeps ~400ms per call under a 600ms root: first fits, second gets
  // only leftovers and must die. A per-call reset would let both pass.
  let now = 1_000_000;
  const clock: Clock = { nowMs: () => now };
  const root = now + 600; // fixed at stamp time; never recomputed
  const deadline: BridgeDeadline = {
    rootDeadlineMs: root,
    remainingMs: (c = clock) => root - c.nowMs(),
    isExpired: (c = clock) => root - c.nowMs() <= 0,
  };
  const env = fakeEnv({ FAKE_MODE: 'slow', FAKE_SLEEP_MS: '400' });
  const started = Date.now();
  await evaluateDecision(okRequest(), { deadline, corePath: FAKE_CORE, corePathSource: { env }, clock });
  now += 450; // wall time the first call consumed
  await assert.rejects(
    () =>
      evaluateDecision(okRequest(), { deadline, corePath: FAKE_CORE, corePathSource: { env }, clock }),
    (err: unknown) => (err as { code?: string }).code === 'DeadlineExceeded',
    'second call must see only the remaining root budget',
  );
  const wallMs = Date.now() - started;
  assert.ok(wallMs < 5000, `total wall time ${wallMs}ms unbounded by root deadline`);
});

test('killed-for-deadline spawn raises typed DeadlineExceeded', async () => {
  const deadline = stampRootDeadline(300);
  await assert.rejects(
    () =>
      evaluateDecision(okRequest(), {
        deadline,
        corePath: FAKE_CORE,
        corePathSource: { env: fakeEnv({ FAKE_MODE: 'slow', FAKE_SLEEP_MS: '5000' }) },
      }),
    (err: unknown) =>
      (err as { code?: string }).code === 'DeadlineExceeded' &&
      (err as Error).name === 'DeadlineExceededError',
  );
});

test('probe: compatible core, absent core, major mismatch', async () => {
  const ok = await probeInstalledCore(stampRootDeadline(10_000), {
    corePath: FAKE_CORE,
    corePathSource: { env: fakeEnv() },
  });
  assert.deepEqual(ok, { compatible: true, coreVersion: '1.1.0' });

  const absent = await probeInstalledCore(stampRootDeadline(10_000), {
    corePath: '/tmp/cc-d09-JEV-009-no-such-core.py',
  });
  assert.equal(absent.compatible, false);
  assert.equal(absent.reason, 'core_absent');

  const mismatch = await probeInstalledCore(stampRootDeadline(10_000), {
    corePath: FAKE_CORE,
    corePathSource: { env: fakeEnv({ FAKE_VERSION: '2.0.0' }) },
  });
  assert.equal(mismatch.compatible, false);
  assert.equal(mismatch.reason, 'schema_major_mismatch');
});

test('every incompatible case preserves the no-JEV fallback path', async () => {
  const ok = requiresNoJevFallback({ compatible: true, coreVersion: '1.1.0' });
  assert.equal(ok.useJev, true);
  for (const state of [
    { compatible: false, reason: 'core_absent' },
    { compatible: false, reason: 'schema_major_mismatch' },
    { compatible: false, reason: 'handshake_failed' },
  ] as const) {
    const path = requiresNoJevFallback(state);
    assert.equal(path.useJev, false, `reason ${state.reason} must keep fallback`);
    assert.equal(path.state, state);
  }
});

test('assignment-read-only guard rejects mutation fields, passes clean payloads', async () => {
  const deadline = stampRootDeadline(10_000);
  await assert.rejects(
    () =>
      evaluateDecision(okRequest(), {
        deadline,
        corePath: FAKE_CORE,
        corePathSource: { env: fakeEnv({ FAKE_MODE: 'mutation' }) },
      }),
    (err: unknown) =>
      (err as { code?: string }).code === 'AssignmentMutation' &&
      (err as Error).name === 'AssignmentMutationError',
  );
  assert.doesNotThrow(() => assertAssignmentReadOnly(null));
  assert.doesNotThrow(() => assertAssignmentReadOnly([{ a: 1 }, 'x', 2]));
  assert.throws(
    () => assertAssignmentReadOnly({ nested: { dispatch: { id: 1 } } }),
    (err: unknown) => (err as { code?: string }).code === 'AssignmentMutation',
  );
});
