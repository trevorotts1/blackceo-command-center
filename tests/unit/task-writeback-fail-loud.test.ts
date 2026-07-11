/**
 * task-writeback-fail-loud.test.ts — server-side write-back helpers now (a)
 * attach the canonical `Authorization: Bearer $MC_API_TOKEN` header and (b) FAIL
 * LOUD on an auth rejection (401/403) instead of the old silent console.error
 * swallow that let finished work rot in_progress.
 *
 *   node --import tsx --test tests/unit/task-writeback-fail-loud.test.ts
 */

process.env.MC_API_TOKEN = 'writeback-test-token';

import test from 'node:test';
import assert from 'node:assert/strict';
import { logActivity, logDeliverable } from '../../src/lib/orchestration';
import { MissionControlWriteError } from '../../src/lib/mc-auth';

type Captured = { url: string; headers: Record<string, string> };

const realFetch = globalThis.fetch;

function stubFetch(status: number, capture: Captured[]) {
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    capture.push({
      url: String(url),
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => (status >= 400 ? 'Unauthorized' : 'ok'),
    } as Response;
  }) as typeof fetch;
}

test('logActivity attaches the Bearer header and throws MissionControlWriteError on 401', async () => {
  const cap: Captured[] = [];
  stubFetch(401, cap);
  try {
    await assert.rejects(
      () => logActivity({ taskId: 't1', activityType: 'completed', message: 'done' }),
      (err: unknown) => {
        assert.ok(err instanceof MissionControlWriteError, 'auth failure surfaces as MissionControlWriteError (fail loud)');
        assert.equal((err as MissionControlWriteError).status, 401);
        return true;
      },
    );
    assert.equal(cap.length, 1, 'fetch was called once');
    assert.equal(cap[0].headers['Authorization'], 'Bearer writeback-test-token', 'canonical bearer header attached');
    assert.match(cap[0].url, /\/api\/tasks\/t1\/activities$/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('logDeliverable throws MissionControlWriteError on 403 (fail loud)', async () => {
  const cap: Captured[] = [];
  stubFetch(403, cap);
  try {
    await assert.rejects(
      () => logDeliverable({ taskId: 't2', deliverableType: 'file', title: 'x', path: '/tmp/x.html' }),
      (err: unknown) => err instanceof MissionControlWriteError && (err as MissionControlWriteError).status === 403,
    );
    assert.equal(cap[0].headers['Authorization'], 'Bearer writeback-test-token');
    assert.match(cap[0].url, /\/api\/tasks\/t2\/deliverables$/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('a 200 write-back resolves (no throw) with the bearer attached', async () => {
  const cap: Captured[] = [];
  stubFetch(201, cap);
  try {
    await logActivity({ taskId: 't3', activityType: 'completed', message: 'ok' });
    assert.equal(cap[0].headers['Authorization'], 'Bearer writeback-test-token');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('a non-auth failure (500) does NOT throw — best-effort is preserved for transient errors', async () => {
  const cap: Captured[] = [];
  stubFetch(500, cap);
  try {
    // Must not reject: only 401/403 are fail-loud; transient 5xx stays best-effort.
    await logActivity({ taskId: 't4', activityType: 'completed', message: 'ok' });
    assert.equal(cap.length, 1);
  } finally {
    globalThis.fetch = realFetch;
  }
});
