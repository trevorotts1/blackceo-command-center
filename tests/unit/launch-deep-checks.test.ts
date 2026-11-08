/**
 * CON-24 — deep health check for launch ingest freshness + quarantine.
 *
 * Proves checkLaunchIngest():
 *   - reports newest-ingest freshness and the quarantined-run count;
 *   - a stale launch feed (in-flight run silent past the window) WARNS only:
 *     pass stays true, degraded/stale are set, so it can never fail health;
 *   - a progress file that quarantines a plan is counted;
 *   - an empty box (no launch data, no plans dir) is a clean OK, not a warning.
 */

import './_isolated-db';

import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { run } from '@/lib/db';
import { ensureLaunchSchema } from '@/lib/launch-ability-runs';
import { planHash } from '@/lib/launch-storage';
import { checkLaunchIngest, LAUNCH_INGEST_STALE_MS } from '@/lib/health/deep-checks';

const FIXTURES = path.join(process.cwd(), 'tests', 'fixtures', 'launch-runs');
const PLAN = JSON.parse(
  fs.readFileSync(path.join(FIXTURES, 'sample-launch.plan.json'), 'utf8'),
) as Record<string, unknown>;

const NOW = Date.parse('2026-11-02T12:00:00.000Z');
const HOUR = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();

const created: string[] = [];
function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-CON-24-'));
  created.push(dir);
  return dir;
}
process.on('exit', () => {
  for (const dir of created) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

function seedRun(runId: string, lastEventAt: number, overall = 'incomplete') {
  run(
    `INSERT INTO launch_runs (run_id, skill, ability_slug, launch_id, overall, last_event_at, created_at, updated_at)
     VALUES (?, 49, 'signature-funnel', 'sample-launch-2026-11', ?, ?, ?, ?)`,
    [runId, overall, iso(lastEventAt), iso(lastEventAt), iso(lastEventAt)],
  );
  run(
    `INSERT INTO launch_run_events (event_id, run_id, skill, event_type, emitted_at, source, payload_json, received_at)
     VALUES (?, ?, 49, 'run_initialized', ?, 'test', '{}', ?)`,
    [`ev-${runId}`, runId, iso(lastEventAt), iso(lastEventAt)],
  );
}

beforeEach(() => {
  ensureLaunchSchema();
  run('DELETE FROM launch_run_events');
  run('DELETE FROM launch_runs');
  run('DELETE FROM launch_progress_samples');
});

describe('CON-24 — checkLaunchIngest', () => {
  it('is a clean OK on a box with no launch data and no plans directory', () => {
    const r = checkLaunchIngest({ now: NOW, plansDir: path.join(tmpDir(), 'absent') });
    expect(r.pass).toBe(true);
    expect(r.degraded).toBe(false);
    expect(r.newest_ingest_at).toBeNull();
    expect(r.quarantined_runs).toBe(0);
    expect(r.disk_view).toBe('unavailable');
  });

  it('reports freshness for a live feed without warning', () => {
    seedRun('run-live', NOW - 5 * 60_000);
    const r = checkLaunchIngest({ now: NOW, plansDir: tmpDir() });
    expect(r.newest_ingest_at).toBe(iso(NOW - 5 * 60_000));
    expect(r.newest_ingest_age_seconds).toBe(300);
    expect(r.in_flight_runs).toBe(1);
    expect(r.stalled_runs).toBe(0);
    expect(r.stale).toBe(false);
    expect(r.degraded).toBe(false);
  });

  it('a stale launch feed only warns: pass stays true, never fails health', () => {
    seedRun('run-stalled', NOW - 3 * 24 * HOUR);
    seedRun('run-done', NOW - 9 * 24 * HOUR, 'complete'); // finished runs never stall
    const r = checkLaunchIngest({ now: NOW, plansDir: tmpDir() });
    expect(r.stale).toBe(true);
    expect(r.degraded).toBe(true);
    expect(r.stalled_runs).toBe(1);
    expect(r.in_flight_runs).toBe(1);
    expect(r.stale_after_seconds).toBe(LAUNCH_INGEST_STALE_MS / 1000);
    expect(r.newest_ingest_age_seconds).toBe(3 * 24 * 3600);
    expect(r.pass).toBe(true);
    expect(r.indeterminate).not.toBe(true);
    expect(r.detail).toContain('non-gating');
    // Even if a caller aggregated it with the gating checks, overall stays green.
    expect([{ pass: true }, r].every((c) => c.pass === true)).toBe(true);
  });

  it('counts a quarantined progress file and warns without failing', () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'sample-launch.plan.json'), JSON.stringify(PLAN));
    fs.writeFileSync(
      path.join(dir, 'sample-launch.progress.json'),
      JSON.stringify({
        schema_version: '1.0',
        launch_id: PLAN.launch_id,
        plan_hash: planHash({ ...PLAN, revision: 99, stale: true }), // not this plan
        created_at: '2026-10-01T12:00:00Z',
        updated_at: '2026-10-01T12:45:00Z',
        units: { page_landing: { kind: 'page', waits_for: [], state: 'done' } },
      }),
    );
    const r = checkLaunchIngest({ now: NOW, plansDir: dir });
    expect(r.disk_view).toBe('ok');
    expect(r.quarantined_runs).toBe(1);
    expect(r.degraded).toBe(true);
    expect(r.pass).toBe(true);
    expect(r.detail).toContain('1 quarantined');
  });
});

// Each callRoute re-imports the whole health route after resetModules, so two calls
// can pass the 15 s default on a loaded runner; the assertions are unchanged.
const ROUTE_TEST_TIMEOUT_MS = 90_000;

describe('CON-24 — GET /api/health/deep advisory.launch_ingest', () => {
  type RouteBody = {
    pass: boolean;
    indeterminate: boolean;
    checks: Record<string, unknown>;
    advisory: { launch_ingest: Record<string, unknown> };
  };

  async function callRoute(launchStub?: () => unknown) {
    vi.doMock('@/lib/health/deep-checks', async () => {
      const actual = await vi.importActual<typeof import('@/lib/health/deep-checks')>('@/lib/health/deep-checks');
      return {
        ...actual,
        ...(launchStub ? { checkLaunchIngest: launchStub } : {}),
        checkPersonaGrounding: async () => ({ pass: true, detail: 'stub' }),
      };
    });
    vi.resetModules();
    const mod = (await import('../../src/app/api/health/deep/route')) as { GET: () => Promise<Response> };
    const res = await mod.GET();
    return { status: res.status, body: (await res.json()) as RouteBody };
  }

  afterEach(() => {
    vi.doUnmock('@/lib/health/deep-checks');
    vi.resetModules();
    delete process.env.LAUNCH_PLANS_DIR;
  });

  it('reports freshness + quarantine count; a stale feed never changes pass/indeterminate or enters checks', async () => {
    const fresh = {
      pass: true, degraded: false, stale: false, quarantined_runs: 0, newest_ingest_age_seconds: 60,
      detail: 'launch_ingest: OK (advisory only, non-gating)',
    };
    const stale = {
      pass: true, degraded: true, stale: true, stalled_runs: 1, quarantined_runs: 2,
      detail: 'launch_ingest: WARN (advisory only, non-gating)',
    };
    const a = await callRoute(() => fresh);
    const b = await callRoute(() => stale);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body.advisory.launch_ingest).toEqual(fresh);
    expect(b.body.advisory.launch_ingest).toEqual(stale);
    expect(Object.keys(a.body.checks)).not.toContain('launch_ingest');
    expect(Object.keys(b.body.checks)).not.toContain('launch_ingest');
    expect(b.body.pass).toBe(a.body.pass);
    expect(b.body.indeterminate).toBe(a.body.indeterminate);
  }, ROUTE_TEST_TIMEOUT_MS);

  it('a throwing probe degrades to a non-gating UNKNOWN, never a 500', async () => {
    const ok = await callRoute(() => ({ pass: true, detail: 'ok' }));
    const r = await callRoute(() => { throw new Error('boom'); });
    expect(r.status).toBe(200);
    expect(r.body.advisory.launch_ingest.pass).toBe(true);
    expect(r.body.advisory.launch_ingest.indeterminate).toBe(true);
    expect(String(r.body.advisory.launch_ingest.detail)).toContain('launch_ingest');
    expect(String(r.body.advisory.launch_ingest.detail)).toContain('non-gating');
    expect(r.body.pass).toBe(ok.body.pass);
  }, ROUTE_TEST_TIMEOUT_MS);

  it('the real check is what the route serves (stalled run is reported)', async () => {
    process.env.LAUNCH_PLANS_DIR = tmpDir();
    seedRun('run-route-stalled', Date.now() - 3 * 24 * HOUR);
    const { status, body } = await callRoute();
    expect(status).toBe(200);
    expect(body.advisory.launch_ingest.stale).toBe(true);
    expect(body.advisory.launch_ingest.stalled_runs).toBe(1);
  }, ROUTE_TEST_TIMEOUT_MS);
});
