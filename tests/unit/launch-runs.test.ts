/**
 * WF-CC — launch-runs unit tests.
 *
 * Proves:
 *   - the launch percentage is complete units / every planned unit, rounded
 *   - Conversation AI counts as a unit only when requested
 *   - dropped units are NOT complete (§4.5: the run is not done until the
 *     client drops it)
 *   - progress files parse in both the array and map shapes
 *   - listLaunchRuns pairs a plan with its progress file
 */

import path from 'path';
import { describe, it, expect } from 'vitest';
import {
  buildLaunchRun,
  listLaunchRuns,
  parseProgressStates,
} from '@/lib/launch-runs';

const FIXTURES = path.join(process.cwd(), 'tests', 'fixtures', 'launch-runs');

describe('WF-CC — launch-runs', () => {
  it('computes the launch percentage across every planned unit', () => {
    const result = listLaunchRuns(FIXTURES);
    expect(result.errors).toEqual([]);
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
    expect(map.get('y')).toBe('pending');
    expect(map.get('z')).toBe('blocked');
  });
});
