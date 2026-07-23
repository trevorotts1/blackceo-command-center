/**
 * U020 — WebSocket reconnect backoff + max attempts.
 *
 * Verifies:
 *   1. scheduleReconnect() uses bounded exponential backoff (2s → 4s → 8s …).
 *   2. After MAX_RECONNECT_ATTEMPTS consecutive failures the client enters a
 *      terminal "blocked" state, records the failure, and stops retrying.
 *   3. A successful connection resets the backoff/attempt counter (the same
 *      resetReconnectBackoff() the auth-success handler invokes), and
 *      setAutoReconnect(true) clears the blocked state for a manual retry.
 *
 * Uses node:test mock timers; the real connect() is stubbed so no network I/O
 * happens and no gateway is required. Node 22's mock timers expose a
 * synchronous tick(), so advance() ticks then flushes microtasks — the async
 * reconnect callback schedules its next attempt in a continuation.
 */

import test, { before, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Isolate device-identity writes to a temp dir (the constructor loads/creates it).
process.env.BCC_DEVICE_IDENTITY_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-u020-identity-'));
// Small, deterministic backoff window for the tests.
process.env.MAX_RECONNECT_ATTEMPTS = '3';
process.env.RECONNECT_BACKOFF_BASE_MS = '2000';
process.env.RECONNECT_BACKOFF_MAX_MS = '32000';

// tsx treats .ts as CJS (no "type": "module" in package.json), so the dynamic
// import must live in a hook, not at the top level.
let OpenClawClient: typeof import('../../src/lib/openclaw/client').OpenClawClient;

before(async () => {
  ({ OpenClawClient } = await import('../../src/lib/openclaw/client'));
});

type ClientInternals = {
  connect: () => Promise<void>;
  scheduleReconnect: () => void;
  resetReconnectBackoff: () => void;
};

function internals(client: InstanceType<typeof OpenClawClient>): ClientInternals {
  return client as unknown as ClientInternals;
}

function makeClient(): InstanceType<typeof OpenClawClient> {
  return new OpenClawClient('ws://127.0.0.1:18999', '');
}

/** Stub connect() to always fail, counting attempts. */
function stubFailingConnect(client: InstanceType<typeof OpenClawClient>): () => number {
  let connectCalls = 0;
  internals(client).connect = async () => {
    connectCalls += 1;
    throw new Error('gateway down');
  };
  return () => connectCalls;
}

/** Tick the mock clock, then flush microtasks so async timer callbacks
 *  (connect() → catch → next scheduleReconnect()) complete before we assert.
 *  setImmediate is NOT mocked (only setTimeout/setInterval are), so it flushes
 *  the real microtask/immediate queue. */
async function advance(ms: number): Promise<void> {
  mock.timers.tick(ms);
  await new Promise((resolve) => setImmediate(resolve));
}

test('reconnect backs off exponentially: 2s → 4s → 8s', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  try {
    const client = makeClient();
    const connectCalls = stubFailingConnect(client);

    internals(client).scheduleReconnect();

    // Attempt 1 fires at exactly 2000ms, not before.
    await advance(1999);
    assert.equal(connectCalls(), 0);
    await advance(1);
    assert.equal(connectCalls(), 1);

    // Attempt 2 fires 4000ms after attempt 1.
    await advance(3999);
    assert.equal(connectCalls(), 1);
    await advance(1);
    assert.equal(connectCalls(), 2);

    // Attempt 3 fires 8000ms after attempt 2.
    await advance(7999);
    assert.equal(connectCalls(), 2);
    await advance(1);
    assert.equal(connectCalls(), 3);

    client.disconnect();
  } finally {
    mock.timers.reset();
  }
});

test('blocks after MAX_RECONNECT_ATTEMPTS consecutive failures and stops retrying', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  try {
    const client = makeClient();
    const connectCalls = stubFailingConnect(client);

    internals(client).scheduleReconnect();
    // Drain all three attempts one backoff window at a time (each window's
    // continuation schedules the next attempt).
    await advance(2000);
    await advance(4000);
    await advance(8000);

    assert.equal(connectCalls(), 3, 'exactly MAX_RECONNECT_ATTEMPTS connect attempts');
    assert.equal(client.isReconnectBlocked(), true, 'terminal blocked state after the ceiling');
    assert.match(
      client.getLastConnectError()?.message ?? '',
      /blocked after 3 failed attempts/,
      'the failure is recorded for the status surface',
    );

    // Terminal: no further attempts no matter how long we wait.
    await advance(10 * 60 * 1000);
    assert.equal(connectCalls(), 3, 'no reconnect attempts after blocked');

    client.disconnect();
  } finally {
    mock.timers.reset();
  }
});

test('a successful connection resets the backoff/attempt counter', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  try {
    const client = makeClient();
    const connectCalls = stubFailingConnect(client);

    // Run up to the blocked state.
    internals(client).scheduleReconnect();
    await advance(2000);
    await advance(4000);
    await advance(8000);
    assert.equal(client.isReconnectBlocked(), true);
    assert.equal(connectCalls(), 3);

    // A successful connection invokes resetReconnectBackoff() (the auth-success
    // handler calls exactly this). Simulate that reset.
    internals(client).resetReconnectBackoff();
    assert.equal(client.isReconnectBlocked(), false, 'reset clears the blocked state');

    // The next failure sequence starts from the base delay again (2s), proving
    // the attempt counter was reset — not from the would-be 4th-attempt delay.
    internals(client).scheduleReconnect();
    await advance(1999);
    assert.equal(connectCalls(), 3, 'no attempt before the base delay elapses');
    await advance(1);
    assert.equal(connectCalls(), 4, 'attempt fires at the base 2s delay after reset');

    client.disconnect();
  } finally {
    mock.timers.reset();
  }
});

test('setAutoReconnect(true) clears the terminal blocked state for a manual retry', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  try {
    const client = makeClient();
    stubFailingConnect(client);

    internals(client).scheduleReconnect();
    await advance(2000);
    await advance(4000);
    await advance(8000);
    assert.equal(client.isReconnectBlocked(), true);

    client.setAutoReconnect(true);
    assert.equal(client.isReconnectBlocked(), false, 'manual re-enable unblocks the client');

    client.disconnect();
  } finally {
    mock.timers.reset();
  }
});
