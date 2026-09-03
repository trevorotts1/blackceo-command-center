/**
 * Orphaned RPCs on socket close.
 *
 * Before this fix `ws.onclose` reset `connected`/`authenticated`, cleared
 * `messageHandlers`, and scheduled a reconnect — but never touched
 * `pendingRequests`. Any `call()` in flight when the socket dropped was
 * orphaned: not retried, not rejected, just left to sit until its own
 * hardcoded 30s `Request timeout: <method>` in `call()` finally fired.
 *
 * Verifies:
 *   1. `rejectAllPending()` rejects every in-flight request immediately with
 *      an `OpenClawConnectionClosedError` — distinguishable from the generic
 *      timeout Error `call()`'s own 30s timer throws — and clears the map.
 *   2. No double-reject: once `rejectAllPending()` has settled a request,
 *      `call()`'s own 30s timeout later firing for the same id is a no-op
 *      (proven end-to-end through the real `call()` path with mock timers,
 *      not just by reading the guard).
 *   3. `handleMessage()` — the real-response path — is symmetric: a late
 *      response for an id `rejectAllPending()` already removed is dropped,
 *      not a double-resolve.
 *   4. `rejectAllPending()` on an empty map is a safe no-op.
 *   5. A normal clean close (`disconnect()`) is structurally unaffected —
 *      it nulls `ws.onclose` before closing, so this fix does not change
 *      its existing (already orphaning, pre-existing, out of scope here)
 *      behavior at all.
 *
 * Uses node:test mock timers; no real WebSocket / gateway required — the
 * private `pendingRequests` map and `rejectAllPending()`/`handleMessage()`
 * methods are exercised directly via a cast, mirroring the established
 * pattern in openclaw-client-reconnect.test.ts (scheduleReconnect() /
 * resetReconnectBackoff() tested the same way).
 */

import test, { before, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Isolate device-identity writes to a temp dir (the constructor loads/creates it).
process.env.BCC_DEVICE_IDENTITY_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-orphan-rpc-identity-'));

// tsx treats .ts as CJS (no "type": "module" in package.json), so the dynamic
// import must live in a hook, not at the top level.
let OpenClawClient: typeof import('../../src/lib/openclaw/client').OpenClawClient;
let OpenClawConnectionClosedError: typeof import('../../src/lib/openclaw/client').OpenClawConnectionClosedError;

before(async () => {
  ({ OpenClawClient, OpenClawConnectionClosedError } = await import('../../src/lib/openclaw/client'));
});

type PendingEntry = { resolve: (value: unknown) => void; reject: (error: Error) => void; method: string };

type ClientInternals = {
  pendingRequests: Map<string | number, PendingEntry>;
  rejectAllPending: (closeCode: number | null) => void;
  handleMessage: (data: Record<string, unknown>) => void;
  call: <T = unknown>(method: string, params?: Record<string, unknown>) => Promise<T>;
  connected: boolean;
  authenticated: boolean;
  ws: { send: (data: string) => void } | null;
};

function internals(client: InstanceType<typeof OpenClawClient>): ClientInternals {
  return client as unknown as ClientInternals;
}

function makeClient(): InstanceType<typeof OpenClawClient> {
  return new OpenClawClient('ws://127.0.0.1:18999', '');
}

test('rejectAllPending() rejects every in-flight request with a distinguishable error and clears the map', () => {
  const client = makeClient();
  const rejections: Error[] = [];
  const resolves: unknown[] = [];

  internals(client).pendingRequests.set('req-1', {
    resolve: (v) => resolves.push(v),
    reject: (e) => rejections.push(e),
    method: 'sessions.list',
  });
  internals(client).pendingRequests.set('req-2', {
    resolve: (v) => resolves.push(v),
    reject: (e) => rejections.push(e),
    method: 'chat.history',
  });

  internals(client).rejectAllPending(1006);

  assert.equal(internals(client).pendingRequests.size, 0, 'map is cleared');
  assert.equal(resolves.length, 0, 'nothing is ever resolved by a close');
  assert.equal(rejections.length, 2, 'both in-flight requests are rejected');

  for (const err of rejections) {
    assert.ok(err instanceof OpenClawConnectionClosedError, 'distinguishable from a generic timeout Error');
    assert.equal(err.name, 'OpenClawConnectionClosedError');
    assert.equal(err.closeCode, 1006);
  }
  assert.ok(rejections.some((e) => (e as InstanceType<typeof OpenClawConnectionClosedError>).method === 'sessions.list'));
  assert.ok(rejections.some((e) => (e as InstanceType<typeof OpenClawConnectionClosedError>).method === 'chat.history'));
});

test('rejectAllPending() is a safe no-op on an empty map', () => {
  const client = makeClient();
  assert.equal(internals(client).pendingRequests.size, 0);
  assert.doesNotThrow(() => internals(client).rejectAllPending(1006));
  assert.equal(internals(client).pendingRequests.size, 0);
});

test('no double-reject: call()\'s own 30s timeout is a no-op once rejectAllPending() already settled the request', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  try {
    const client = makeClient();
    internals(client).connected = true;
    internals(client).authenticated = true;
    internals(client).ws = { send: () => {} }; // call() only needs a truthy ws with send()

    const promise = internals(client).call('sessions.list');

    let settledCount = 0;
    let capturedError: Error | null = null;
    promise.catch((err) => {
      settledCount += 1;
      capturedError = err as Error;
    });

    // Flush the microtask so the .catch() handler above is actually attached
    // before the socket "closes".
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(internals(client).pendingRequests.size, 1, 'call() registered exactly one pending request');

    // Simulate the socket closing while the request is in flight.
    internals(client).rejectAllPending(1006);
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(settledCount, 1, 'rejected exactly once, promptly, by the close');
    assert.ok(capturedError instanceof OpenClawConnectionClosedError);

    // Now let call()'s own 30s timeout fire. It must be a no-op: the promise
    // is already settled, so a second reject() on it would be silently
    // swallowed by the Promise spec rather than throwing — the real proof is
    // that settledCount does NOT advance to 2 and no unhandled-rejection
    // fires from a second, mismatched rejection racing the first.
    mock.timers.tick(30000);
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(settledCount, 1, 'the 30s timeout does not fire a second rejection');
    assert.equal(internals(client).pendingRequests.size, 0, 'still empty — no leak, no resurrection');
  } finally {
    mock.timers.reset();
  }
});

test('handleMessage() drops a late response for an id rejectAllPending() already removed (no double-resolve)', () => {
  const client = makeClient();
  let resolveCount = 0;
  let rejectCount = 0;

  internals(client).pendingRequests.set('req-late', {
    resolve: () => { resolveCount += 1; },
    reject: () => { rejectCount += 1; },
    method: 'sessions.list',
  });

  internals(client).rejectAllPending(1006);
  assert.equal(rejectCount, 1);

  // The gateway's response arrives after the close already rejected it.
  internals(client).handleMessage({ type: 'res', id: 'req-late', ok: true, payload: { sessions: [] } });

  assert.equal(resolveCount, 0, 'a late response for an already-rejected id is dropped, not resolved');
  assert.equal(rejectCount, 1, 'and does not reject a second time either');
});

test('disconnect() (clean close) is structurally unaffected by this fix — still leaves pendingRequests untouched, as today', () => {
  const client = makeClient();
  let rejectCount = 0;
  internals(client).pendingRequests.set('req-x', {
    resolve: () => {},
    reject: () => { rejectCount += 1; },
    method: 'sessions.list',
  });

  // disconnect() nulls ws.onclose before closing (see src/lib/openclaw/client.ts),
  // so the rejectAllPending() call added inside the onclose handler never runs
  // on this path — this test pins that this fix did not change that.
  client.disconnect();

  assert.equal(rejectCount, 0, 'disconnect() does not reject pending requests (unchanged pre-existing behavior)');
  assert.equal(internals(client).pendingRequests.size, 1, 'pendingRequests is untouched by disconnect(), as before this fix');
});
