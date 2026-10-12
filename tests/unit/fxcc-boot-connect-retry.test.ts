/**
 * FXCC-1 / D09 — the boot Bridge connect retries until the gateway is ready.
 *
 * Before: instrumentation.ts made one fire-and-forget client.connect(); on a
 * pm2 boot the gateway answered 1013 "gateway starting", the client only
 * auto-reconnects a socket that WAS connected, so the bridge stayed down and
 * the boot agent sync never ran.
 *
 * Run: node --import tsx --test tests/unit/fxcc-boot-connect-retry.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { connectWithBootRetry } from '../../src/lib/openclaw/boot-connect';

const noSleep = (log: number[]) => async (ms: number) => { log.push(ms); };

test('two 1013 closes then an accept: ends connected after 3 attempts, backoff 2s then 4s', async () => {
  let calls = 0;
  const client = {
    async connect() {
      calls += 1;
      if (calls <= 2) throw new Error('gateway closed 1013 (gateway starting)');
    },
  };
  const delays: number[] = [];
  await connectWithBootRetry(client, { sleep: noSleep(delays) });
  assert.equal(calls, 3);
  assert.deepEqual(delays, [2000, 4000]);
});

test('backoff is bounded: capped at 60s and gives up after maxAttempts with the last error', async () => {
  let calls = 0;
  const client = { async connect() { calls += 1; throw new Error(`down ${calls}`); } };
  const delays: number[] = [];
  await assert.rejects(connectWithBootRetry(client, { sleep: noSleep(delays) }), /down 10/);
  assert.equal(calls, 10);
  assert.deepEqual(delays, [2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000, 60000]);
});

test('control: a first-try connect makes one call and sleeps never', async () => {
  let calls = 0;
  const delays: number[] = [];
  await connectWithBootRetry({ async connect() { calls += 1; } }, { sleep: noSleep(delays) });
  assert.equal(calls, 1);
  assert.deepEqual(delays, []);
});

test('instrumentation.ts boots the Bridge through connectWithBootRetry, and the agent sync still follows the connect', () => {
  const src = fs.readFileSync(path.join(process.cwd(), 'src', 'instrumentation.ts'), 'utf8');
  const retry = src.indexOf('connectWithBootRetry(client');
  const sync = src.indexOf('syncSpecialistAgentsFromOpenClaw');
  assert.ok(retry > 0, 'boot connect must go through connectWithBootRetry');
  assert.ok(sync > retry, 'agent sync must run after the (retried) connect succeeds');
  assert.ok(!/client\.connect\(\)\.then/.test(src), 'no single-shot boot connect left');
});
