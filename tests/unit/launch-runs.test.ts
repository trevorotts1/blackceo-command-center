/**
 * WF-CC / UL-022 — launch-runs disk-view unit tests.
 *
 * Proves:
 *   - the launch percentage is complete units / every planned unit, rounded
 *   - Conversation AI counts as a unit only when requested
 *   - dropped units are NOT complete (§4.5: the run is not done until the
 *     client drops it)
 *   - progress files parse in both the array and map shapes
 *   - listLaunchRuns pairs a plan with its producer progress file
 *   - an unreadable directory is `unavailable`, never `empty`
 *   - foreign launch, stale plan hash and changed revision never increase
 *     completion: the run is quarantined with every unit `unknown`
 *   - a malformed / array / null manifest fails one file and never the others
 *   - conflicting duplicate plans quarantine both; identical duplicates are
 *     ignored (never double-counted)
 *   - sequence/message counts, last update, unknown units and the neutral
 *     "Not included" label are reported from real producer defaults
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, it, expect } from 'vitest';

import {
  buildLaunchRun,
  getLaunchRun,
  listLaunchRuns,
  NOT_INCLUDED_LABEL,
  parseProgressStates,
  type LaunchUnitState,
} from '@/lib/launch-runs';
import { planHash } from '@/lib/launch-storage';

const FIXTURES = path.join(process.cwd(), 'tests', 'fixtures', 'launch-runs');
const PLAN = JSON.parse(
  fs.readFileSync(path.join(FIXTURES, 'sample-launch.plan.json'), 'utf8'),
) as Record<string, unknown>;
const PROGRESS = JSON.parse(
  fs.readFileSync(path.join(FIXTURES, 'sample-launch.progress.json'), 'utf8'),
) as Record<string, unknown>;

/** Every tmp path this file creates, removed on exit (never a shared db/dir). */
const created: string[] = [];
function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-UL-022-'));
  created.push(dir);
  return dir;
}
process.on('exit', () => {
  for (const dir of created) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

function writeLaunch(
  dir: string,
  plan: Record<string, unknown> | unknown,
  progress?: Record<string, unknown> | unknown,
  base = 'sample-launch',
): void {
  fs.writeFileSync(path.join(dir, `${base}.plan.json`), JSON.stringify(plan, null, 2));
  if (progress !== undefined) {
    fs.writeFileSync(path.join(dir, `${base}.progress.json`), JSON.stringify(progress, null, 2));
  }
}

function progressFor(launchId: string, states: Record<string, string>): Record<string, unknown> {
  return {
    schema_version: '1.0',
    launch_id: launchId,
    plan_hash: planHash(PLAN),
    created_at: '2026-10-01T12:00:00Z',
    updated_at: '2026-10-01T12:45:00Z',
    units: Object.fromEntries(
      Object.entries(states).map(([id, state]) => [
        id,
        { kind: 'page', waits_for: [], state },
      ]),
    ),
  };
}

describe('WF-CC — launch-runs', () => {
  it('computes the launch percentage across every planned unit', () => {
    const result = listLaunchRuns(FIXTURES);
    expect(result.errors).toEqual([]);
    expect(result.availability).toBe('ok');
    expect(result.status).toBe('ok');
    expect(result.runs).toHaveLength(1);

    const run = result.runs[0];
    // 4 pages + 2 emails + 1 text + 1 automation + requested AI = 9 units.
    expect(run.totalUnits).toBe(9);
    // complete: page_landing, page_sales, email_pre_launch = 3.
    expect(run.doneUnits).toBe(3);
    expect(run.percentage).toBe(33);
    expect(run.counts.email).toEqual({ total: 2, done: 1 });
    expect(run.counts.text).toEqual({ total: 1, done: 0 });
    expect(run.counts.automation).toEqual({ total: 1, done: 0 });
    expect(run.conversationAi).toMatchObject({
      requested: true,
      mode: 'reply_bot',
      channels: ['sms', 'chat'],
      state: 'pending',
    });
    expect(run.a2pReady).toBe(false);
    expect(run.availability).toBe('ok');
    expect(run.unknownUnits).toBe(0);
  });

  it('reports sequence/message counts, last update and the approved plan hash', () => {
    const run = listLaunchRuns(FIXTURES).runs[0];
    expect(run.sequenceCount).toBe(2);
    // 4 + 10 emails + 2 texts
    expect(run.messageCount).toBe(16);
    expect(run.lastUpdated).toBe('2026-10-01T12:45:00Z');
    expect(run.planHash).toBe(String(PROGRESS.plan_hash));
    expect(run.notIncluded).toEqual([]);
  });

  it('counts Conversation AI only when requested', () => {
    const run = buildLaunchRun(
      {
        launch_id: 'no-ai',
        offer: { name: 'No AI' },
        pages: [],
        email_sequences: [],
        text_sets: [],
        automations: [],
        conversation_ai: { requested: false, mode: 'none' },
      },
      new Map(),
    );
    expect(run.totalUnits).toBe(0);
    expect(run.percentage).toBe(0);
    expect(run.conversationAi.requested).toBe(false);
    expect(run.conversationAi.state).toBe('dropped');
    // Neutral label, never a fabricated 0/0 "complete" section.
    expect(run.notIncluded).toEqual(['page', 'email', 'text', 'automation', 'conversation_ai']);
    expect(NOT_INCLUDED_LABEL).toBe('Not included');
  });

  it('treats dropped and skipped units as not done', () => {
    const map = parseProgressStates({
      units: [
        { id: 'a', state: 'complete' },
        { id: 'b', state: 'dropped' },
        { id: 'c', state: 'skipped' },
        { id: 'd', state: 'DONE' },
      ],
    });
    expect(map.get('a')).toBe('complete');
    expect(map.get('b')).toBe('dropped');
    expect(map.get('c')).toBe('dropped');
    expect(map.get('d')).toBe('complete');

    const run = buildLaunchRun(
      {
        launch_id: 'drop-test',
        offer: { name: 'Drop' },
        pages: [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }],
        email_sequences: [],
        text_sets: [],
        automations: [],
        conversation_ai: { requested: false },
      },
      map,
    );
    expect(run.doneUnits).toBe(2);
    expect(run.percentage).toBe(50);
  });

  it('parses map-shape progress and unknown states honestly', () => {
    const map = parseProgressStates({
      progress: { x: 'in_progress', y: 'exploded', z: { state: 'blocked' } },
    });
    expect(map.get('x')).toBe('running');
    // Unreported garbage is unresolved (unknown), never silently pending:
    // pending would hide a unit the producer failed to report.
    expect(map.get('y')).toBe('unknown');
    expect(map.get('z')).toBe('blocked');
  });

  it('consumes the producer progress-<launch_id>.json filename', () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'sample-launch.plan.json'), JSON.stringify(PLAN));
    fs.writeFileSync(
      path.join(dir, 'progress-sample-launch-2026-11.json'),
      JSON.stringify(PROGRESS),
    );
    const result = listLaunchRuns(dir);
    expect(result.errors).toEqual([]);
    expect(result.runs).toHaveLength(1);
    // Same states as the .progress.json twin: 3 complete of 9 → 33%.
    expect(result.runs[0].doneUnits).toBe(3);
    expect(result.runs[0].percentage).toBe(33);
  });

  it('keeps conflicting plans quarantined after progress is applied', () => {
    const dir = tmpDir();
    writeLaunch(dir, PLAN, undefined, 'a');
    writeLaunch(dir, { ...PLAN, offer: { name: 'Different offer' } }, undefined, 'b');
    // Progress matching plan A exactly — must NOT revive it while B conflicts.
    fs.writeFileSync(
      path.join(dir, 'a.progress.json'),
      JSON.stringify({ ...PROGRESS, plan_hash: planHash(PLAN) }),
    );
    const result = listLaunchRuns(dir);
    expect(result.runs).toHaveLength(2);
    expect(result.quarantined).toBe(2);
    expect(result.runs.every((run) => run.doneUnits === 0)).toBe(true);
    expect(result.runs.every((run) => run.percentage === 0)).toBe(true);
    expect(result.runs.every((run) => run.availability === 'quarantined')).toBe(true);
  });

  it('never reports every-unit-complete with unknown or dropped units present', () => {
    const dir = tmpDir();
    const units: Record<string, unknown> = {};
    for (const [id, unit] of Object.entries(PROGRESS.units as Record<string, Record<string, unknown>>)) {
      units[id] = { ...unit, state: 'done' };
    }
    // One unit the producer never resolved: garbage state through an
    // unvalidated shape stays unknown, and the run cannot read 100%.
    const map = parseProgressStates({ units: { ghost_unit: 'exploded' } });
    expect(map.get('ghost_unit')).toBe('unknown');
    const run = buildLaunchRun(
      {
        ...(PLAN as Record<string, unknown>),
        pages: [...((PLAN as Record<string, unknown>).pages as unknown[]), { id: 'ghost_unit', kind: 'landing' }],
      },
      new Map([
        ...Object.keys(units).map((id) => [id, 'complete'] as [string, LaunchUnitState]),
        ['ghost_unit', map.get('ghost_unit')!],
      ]),
    );
    expect(run.percentage).toBeLessThan(100);
    expect(run.doneUnits).toBeLessThan(run.totalUnits);
  });

  it('separates an unreadable directory from a genuinely empty one', () => {
    const unavailable = listLaunchRuns(path.join(os.tmpdir(), 'cc-UL-022-does-not-exist'));
    expect(unavailable.availability).toBe('unavailable');
    expect(unavailable.status).toBe('unavailable');
    expect(unavailable.errors.length).toBeGreaterThan(0);
    expect(unavailable.issues[0].code).toBe('unreadable_directory');

    const empty = listLaunchRuns(tmpDir());
    expect(empty.availability).toBe('ok');
    expect(empty.status).toBe('empty');
    expect(empty.errors).toEqual([]);
    expect(empty.runs).toEqual([]);
  });

  it('leaves a plan with no progress file honestly pending (never complete)', () => {
    const dir = tmpDir();
    writeLaunch(dir, PLAN);
    const result = listLaunchRuns(dir);
    expect(result.runs).toHaveLength(1);
    expect(result.runs[0].doneUnits).toBe(0);
    expect(result.runs[0].percentage).toBe(0);
    expect(result.runs[0].availability).toBe('ok');
  });

  it('isolates a malformed, array or null plan to its own file', () => {
    const dir = tmpDir();
    writeLaunch(dir, PLAN);
    fs.writeFileSync(path.join(dir, 'array.plan.json'), '[]');
    fs.writeFileSync(path.join(dir, 'null.plan.json'), 'null');
    fs.writeFileSync(path.join(dir, 'broken.plan.json'), '{not json');

    const result = listLaunchRuns(dir);
    expect(result.runs).toHaveLength(1);
    expect(result.runs[0].launchId).toBe('sample-launch-2026-11');
    expect(result.errors).toHaveLength(3);
  });

  it('never consumes a progress file that names a different launch', () => {
    const dir = tmpDir();
    writeLaunch(dir, PLAN, progressFor('other-launch-2026-11', { page_landing: 'done' }));

    const result = listLaunchRuns(dir);
    expect(result.runs[0].doneUnits).toBe(0);
    expect(result.runs[0].availability).toBe('ok');
    expect(result.issues.some((issue) => issue.code === 'foreign_launch')).toBe(true);
  });

  it('quarantines a stale plan hash: zero completion, every unit unknown', () => {
    const dir = tmpDir();
    const stale = {
      ...progressFor('sample-launch-2026-11', { page_landing: 'done', page_sales: 'done' }),
      plan_hash: `sha256:${'0'.repeat(64)}`,
    };
    writeLaunch(dir, PLAN, stale);

    const result = listLaunchRuns(dir);
    const run = result.runs[0];
    expect(run.availability).toBe('quarantined');
    expect(run.doneUnits).toBe(0);
    expect(run.percentage).toBe(0);
    expect(run.unknownUnits).toBe(9);
    expect(run.units.every((unit) => unit.state === 'unknown')).toBe(true);
    expect(run.issueCodes).toContain('plan_hash_mismatch');
    expect(run.issues[0]).toMatch(/not consumed/);
  });

  it('quarantines a changed revision', () => {
    const dir = tmpDir();
    const revised = { ...PLAN, revision: 2 };
    writeLaunch(dir, revised, {
      ...progressFor('sample-launch-2026-11', { page_landing: 'done' }),
      plan_hash: planHash(revised),
      revision: 1,
    });
    const run = listLaunchRuns(dir).runs[0];
    expect(run.availability).toBe('quarantined');
    expect(run.issueCodes).toContain('revision_mismatch');
    expect(run.doneUnits).toBe(0);
  });

  it('quarantines a progress file with an unknown state instead of coercing it', () => {
    const dir = tmpDir();
    const progress = progressFor('sample-launch-2026-11', { page_landing: 'exploded' });
    writeLaunch(dir, PLAN, progress);
    const run = listLaunchRuns(dir).runs[0];
    expect(run.availability).toBe('quarantined');
    expect(run.doneUnits).toBe(0);
    expect(run.issues[0]).toMatch(/unknown state/);
  });

  it('quarantines conflicting duplicate plans and ignores identical duplicates', () => {
    const conflictDir = tmpDir();
    writeLaunch(conflictDir, PLAN, undefined, 'a');
    writeLaunch(conflictDir, { ...PLAN, offer: { name: 'Different offer' } }, undefined, 'b');
    const conflicted = listLaunchRuns(conflictDir);
    expect(conflicted.runs).toHaveLength(2);
    expect(conflicted.quarantined).toBe(2);
    expect(conflicted.runs.every((run) => run.doneUnits === 0)).toBe(true);
    expect(conflicted.runs.every((run) => run.issueCodes.includes('conflicting_duplicate'))).toBe(true);

    const duplicateDir = tmpDir();
    writeLaunch(duplicateDir, PLAN, undefined, 'a');
    writeLaunch(duplicateDir, PLAN, undefined, 'b');
    const duplicate = listLaunchRuns(duplicateDir);
    expect(duplicate.runs).toHaveLength(1);
    expect(duplicate.quarantined).toBe(0);
    expect(duplicate.errors.some((error) => /duplicates/.test(error))).toBe(true);
  });

  it('getLaunchRun reads the same quarantined state as the list', () => {
    const dir = tmpDir();
    const stale = { ...progressFor('sample-launch-2026-11', { page_landing: 'done' }),
      plan_hash: `sha256:${'a'.repeat(64)}` };
    writeLaunch(dir, PLAN, stale);
    const run = getLaunchRun('sample-launch-2026-11', dir);
    expect(run?.availability).toBe('quarantined');
    expect(run?.doneUnits).toBe(0);
  });
});
