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

import { describe, it, expect, beforeEach } from 'vitest';

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
