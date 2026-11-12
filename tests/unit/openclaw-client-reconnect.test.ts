/**
 * U020 — WebSocket reconnect backoff + max attempts.
 *
 * Verifies:
 *   1. scheduleReconnect() uses bounded exponential backoff (2s → 4s → 8s …).
 *   2. After MAX_RECONNECT_ATTEMPTS consecutive failures the client records the
 *      outage ONCE and keeps retrying forever at the capped backoff — it never
 *      gives up (2026-11-12: a permanent "giving up" left a client's Command
 *      Center disconnected until a human restarted it).
 *   3. A successful connection resets the backoff/attempt counter (the same
 *      resetReconnectBackoff() the auth-success handler invokes).
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

/** Advance in 32s steps: each async reconnect callback schedules its successor
 *  in a continuation, so one huge tick would fire only the first timer. */
async function advanceInSteps(totalMs: number, stepMs = 32000): Promise<void> {
  for (let elapsed = 0; elapsed < totalMs; elapsed += stepMs) await advance(stepMs);
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

test('never gives up: keeps retrying at the capped delay after MAX_RECONNECT_ATTEMPTS', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  try {
    const client = makeClient();
    const connectCalls = stubFailingConnect(client);

    internals(client).scheduleReconnect();
    await advance(2000);
    await advance(4000);
    await advance(8000);

    assert.equal(connectCalls(), 3, 'the first MAX_RECONNECT_ATTEMPTS attempts run');
    assert.equal(client.isReconnectBlocked(), false, 'there is no terminal blocked state');

    // 4th attempt at 16s, 5th at 32s (cap), then every 32s for as long as the
    // gateway stays down.
    await advance(16000);
    assert.equal(connectCalls(), 4);
    await advance(32000);
    assert.equal(connectCalls(), 5);
    await advance(32000);
    assert.equal(connectCalls(), 6, 'still retrying at the capped 32s interval');
    await advanceInSteps(60 * 60 * 1000);
    assert.ok(connectCalls() > 100, `keeps retrying for an hour of outage, got ${connectCalls()}`);

    const msg = client.getLastConnectError()?.message ?? '';
    assert.match(msg, /unreachable after 3 attempts/, 'the outage is recorded for the status surface');
    assert.match(msg, /still retrying/);

    client.disconnect();
  } finally {
    mock.timers.reset();
  }
});

test('recovers when the gateway comes back after a long outage', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  try {
    const client = makeClient();
    let up = false;
    let calls = 0;
    internals(client).connect = async () => {
      calls += 1;
      if (!up) throw new Error('gateway down');
      internals(client).resetReconnectBackoff(); // what the auth-success handler does
    };

    internals(client).scheduleReconnect();
    await advanceInSteps(10 * 60 * 1000); // ten minutes down
    const downCalls = calls;
    assert.ok(downCalls > 5);

    up = true;
    await advance(32000); // next capped attempt lands
    assert.equal(calls, downCalls + 1, 'the next scheduled attempt connects once the gateway is back');
    await advanceInSteps(10 * 60 * 1000);
    assert.equal(calls, downCalls + 1, 'no further attempts after a successful connect');

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
    assert.equal(connectCalls(), 3);

    // A successful connection invokes resetReconnectBackoff() (the auth-success
    // handler calls exactly this). Simulate that reset.
    internals(client).resetReconnectBackoff();

    // The already-pending 4th attempt (scheduled at the old 16s delay) still
    // fires; its failure then reschedules from the RESET counter, so the next
    // delay is the base 2s, not the would-be 32s cap.
    await advance(16000);
    assert.equal(connectCalls(), 4);
    await advance(1999);
    assert.equal(connectCalls(), 4, 'no attempt before the base delay elapses');
    await advance(1);
    assert.equal(connectCalls(), 5, 'attempt fires at the base 2s delay after reset');

    client.disconnect();
  } finally {
    mock.timers.reset();
  }
});
