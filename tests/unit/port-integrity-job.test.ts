/**
 * port-integrity-job.test.ts — P1-02 Unit B, item 5: the daily port-integrity
 * self-check registered in scheduler.ts (src/lib/jobs/port-integrity.ts).
 *
 * FAIL-FIRST: against a pre-P1-02 tree `src/lib/jobs/port-integrity.ts` does
 * not exist, so this file fails to even import (MODULE_NOT_FOUND). Post-fix,
 * it drives the real check function (with `notify` + `fetch` swapped for
 * test doubles — never the real Telegram/Cloudflare network) through four
 * scenarios:
 *
 *   1. Canonical port (4000) + a healthy /api/health probe -> no alert.
 *   2. Drifted port (3000) -> exactly one notifySystem call naming both the
 *      drifted port and the canonical one.
 *   3. Tunnel ingress reachable but targeting the wrong port -> a SECOND,
 *      independent alert reason (tunnel mismatch) fires even though the
 *      process's own listen port is healthy — proving the two checks are
 *      wired independently, per P1-02(c).5 ("asserts... AND... targets
 *      :4000").
 *   4. Tunnel credentials absent on this box -> the tunnel half is silently
 *      SKIPPED (never reported as a failure) — the P1-05 lesson applied here:
 *      never guess/fabricate an unprovisioned check result.
 *
 * Run: node --import tsx --test tests/unit/port-integrity-job.test.ts
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { runPortIntegrityCheck, CANONICAL_CC_PORT } from '../../src/lib/jobs/port-integrity';
import type { notifySystem } from '../../src/lib/notify';

type NotifyFn = typeof notifySystem;
type FetchHandler = (url: string) => { ok: boolean; status: number; json?: () => Promise<unknown> };

function mockFetchSequence(handlers: FetchHandler[]): () => void {
  let call = 0;
  const original = globalThis.fetch;
  globalThis.fetch = (async (...args: unknown[]) => {
    const url = String(args[0]);
    const handler = handlers[Math.min(call, handlers.length - 1)];
    call += 1;
    const result = handler(url);
    return {
      ok: result.ok,
      status: result.status,
      json: result.json ?? (async () => ({})),
    } as Response;
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

function recordingNotify(): { notify: NotifyFn; calls: Array<[string, { agent?: string; action?: string } | undefined]> } {
  const calls: Array<[string, { agent?: string; action?: string } | undefined]> = [];
  const notify = ((message: string, meta?: { agent?: string; action?: string }) => {
    calls.push([message, meta]);
    return true;
  }) as NotifyFn;
  return { notify, calls };
}

function clearTunnelEnv(): void {
  delete process.env.CLOUDFLARE_API_TOKEN;
  delete process.env.CLOUDFLARE_ACCOUNT_ID;
  delete process.env.CLOUDFLARE_TUNNEL_ID;
  delete process.env.CC_TUNNEL_HOSTNAME;
}

test('port-integrity: canonical port + healthy health check -> no alert', async () => {
  process.env.CC_PORT = String(CANONICAL_CC_PORT);
  delete process.env.PORT;
  clearTunnelEnv();

  const restoreFetch = mockFetchSequence([() => ({ ok: true, status: 200 })]);
  const { notify, calls } = recordingNotify();

  try {
    const result = await runPortIntegrityCheck({ notify });
    assert.equal(result.listenPort, CANONICAL_CC_PORT);
    assert.equal(result.listenPortOk, true);
    assert.equal(result.alerted, false);
    assert.equal(calls.length, 0, 'notifySystem must not fire when everything is healthy');
  } finally {
    restoreFetch();
  }
});

test('port-integrity: drifted port -> exactly one alert naming the drifted and canonical ports', async () => {
  process.env.CC_PORT = '3000';
  delete process.env.PORT;
  clearTunnelEnv();

  const restoreFetch = mockFetchSequence([() => ({ ok: true, status: 200 })]);
  const { notify, calls } = recordingNotify();

  try {
    const result = await runPortIntegrityCheck({ notify });
    assert.equal(result.listenPort, 3000);
    assert.equal(result.listenPortOk, false);
    assert.equal(result.alerted, true);
    assert.equal(calls.length, 1, 'exactly one notifySystem call for one drift');
    const [message, meta] = calls[0];
    assert.match(message, /3000/);
    assert.match(message, new RegExp(String(CANONICAL_CC_PORT)));
    assert.equal(meta?.action, 'escalate');
  } finally {
    restoreFetch();
  }
});

test('port-integrity: tunnel ingress mismatch reported independently of a healthy listen port', async () => {
  process.env.CC_PORT = String(CANONICAL_CC_PORT);
  delete process.env.PORT;
  process.env.CLOUDFLARE_API_TOKEN = 'test-token';
  process.env.CLOUDFLARE_ACCOUNT_ID = 'acct-1';
  process.env.CLOUDFLARE_TUNNEL_ID = 'tunnel-1';
  process.env.CC_TUNNEL_HOSTNAME = 'client.example.com';

  const restoreFetch = mockFetchSequence([
    () => ({ ok: true, status: 200 }), // /api/health self-probe
    () => ({
      ok: true,
      status: 200,
      json: async () => ({
        result: {
          config: {
            ingress: [{ hostname: 'client.example.com', service: 'http://localhost:3000' }],
          },
        },
      }),
    }),
  ]);
  const { notify, calls } = recordingNotify();

  try {
    const result = await runPortIntegrityCheck({ notify });
    assert.equal(result.listenPortOk, true, 'the process listen port itself is still healthy');
    assert.equal(result.tunnelChecked, true);
    assert.equal(result.tunnelOk, false);
    assert.equal(result.alerted, true);
    assert.equal(calls.length, 1);
    const [message] = calls[0];
    assert.match(message, /tunnel ingress mismatch/i);
    assert.match(message, /client\.example\.com/);
  } finally {
    restoreFetch();
    clearTunnelEnv();
  }
});

test('port-integrity: tunnel credentials absent on this box -> tunnel check skipped, never a false failure', async () => {
  process.env.CC_PORT = String(CANONICAL_CC_PORT);
  delete process.env.PORT;
  clearTunnelEnv();

  const restoreFetch = mockFetchSequence([() => ({ ok: true, status: 200 })]);
  const notify = (() => {
    throw new Error('notify should not be called when nothing is wrong');
  }) as NotifyFn;

  try {
    const result = await runPortIntegrityCheck({ notify });
    assert.equal(result.tunnelChecked, false);
    assert.equal(result.tunnelOk, null);
    assert.equal(result.alerted, false);
  } finally {
    restoreFetch();
  }
});
