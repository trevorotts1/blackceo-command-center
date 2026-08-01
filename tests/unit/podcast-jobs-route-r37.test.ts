/**
 * R-37 -- podcast jobs/[job_id] empty-DB semantics parity (Spec Section 13).
 *
 * Proves the single-job route returns 200 with { job: null, events: [] }
 * when the engine DB is absent, matching the list route's empty-state
 * semantics. Previously the single-job route returned 404, which the
 * EpisodeDetailLoader treated as an error state -- inconsistent with the
 * list route's graceful empty response (200 with { jobs: [], ... }).
 *
 * Strategy: set PODCAST_DB_PATH to a path that does not exist, which makes
 * getPodcastReadDb() return null (fileMustExist: true guard). Then invoke
 * the real route handler with a valid operator bypass (MC_API_TOKEN bearer).
 * Assert the response shape and status code.
 *
 * Runs via Node built-in test runner under tsx (npm run test:unit).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { NextRequest } from 'next/server';

// C8 unit-test isolation: force the DB resolution to an invalid path BEFORE
// any import can cache a real handle.
process.env.PODCAST_DB_PATH = '/dev/null/does-not-exist';

// Suppress Telegram notifications during test runs (safety).
process.env.OWNER_NOTIFY_TELEGRAM_DISABLED = '1';

// Import the route module AFTER setting env vars so the DB resolution
// happens with our overrides in place.
// Use a dynamic import wrapper for CJS compatibility.
let apiMod: Awaited<typeof import('../../src/app/api/podcast/jobs/[job_id]/route')>;

async function loadRoute() {
  if (!apiMod) {
    apiMod = await import('../../src/app/api/podcast/jobs/[job_id]/route');
  }
  return apiMod;
}

test('[R-37] single-job route returns 200 with {job:null, events:[]} when engine DB is absent (operator bypass)', async () => {
  const mod = await loadRoute();
  const oldToken = process.env.MC_API_TOKEN;
  process.env.MC_API_TOKEN = 'test-mc-token-for-r37';
  try {
    const req = new NextRequest('http://localhost/api/podcast/jobs/pj_test123', {
      headers: { authorization: 'Bearer test-mc-token-for-r37' },
    });
    const res = await mod.GET(req, { params: { job_id: 'pj_test123' } });
    assert.equal(res.status, 200, 'must return 200, not 404, when DB is absent');
    const body = await res.json();
    assert.equal(body.job, null, 'job must be null when DB is absent');
    assert.deepEqual(body.events, [], 'events must be an empty array');
  } finally {
    if (oldToken === undefined) delete process.env.MC_API_TOKEN;
    else process.env.MC_API_TOKEN = oldToken;
  }
});

test('[R-37] single-job route returns 200 even for valid-looking job IDs when DB is absent', async () => {
  const mod = await loadRoute();
  const oldToken = process.env.MC_API_TOKEN;
  process.env.MC_API_TOKEN = 'test-mc-token-for-r37';
  try {
    const req = new NextRequest('http://localhost/api/podcast/jobs/pj_01HZXTESTROW0000000000000', {
      headers: { authorization: 'Bearer test-mc-token-for-r37' },
    });
    const res = await mod.GET(req, { params: { job_id: 'pj_01HZXTESTROW0000000000000' } });
    assert.equal(res.status, 200, 'must return 200, not 404');
    const body = await res.json();
    assert.equal(body.job, null);
  } finally {
    if (oldToken === undefined) delete process.env.MC_API_TOKEN;
    else process.env.MC_API_TOKEN = oldToken;
  }
});

test('[R-37] single-job route still returns 401 for unauthenticated requests when DB is absent', async () => {
  const mod = await loadRoute();
  const oldToken = process.env.MC_API_TOKEN;
  delete process.env.MC_API_TOKEN;
  try {
    const req = new NextRequest('http://localhost/api/podcast/jobs/pj_test123');
    const res = await mod.GET(req, { params: { job_id: 'pj_test123' } });
    assert.equal(res.status, 401, 'unauthenticated requests must still return 401');
  } finally {
    if (oldToken === undefined) delete process.env.MC_API_TOKEN;
    else process.env.MC_API_TOKEN = oldToken;
  }
});
