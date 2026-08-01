/**
 * MR-38 — task-phases unit tests.
 *
 * Proves:
 *   - computeTaskProgress returns 6 labels always, in order
 *   - STATUS_TO_GENERIC_LABEL maps every known TaskStatus
 *   - task_events drive phase progress correctly
 *   - current status fallback works when events are sparse
 *   - unmapped records unknown statuses
 *   - done + blocked are handled correctly
 */

import { describe, it, expect } from 'vitest';
import {
  GENERIC_PHASE_LABELS,
  STATUS_TO_GENERIC_LABEL,
  computeTaskProgress,
} from '@/lib/task-phases';
import type { TaskEventRow } from '@/lib/task-phases';

describe('MR-38 — task-phases', () => {
  describe('STATUS_TO_GENERIC_LABEL', () => {
    it('maps all 9 lifecycle TaskStatus values', () => {
      const statuses = [
        'backlog',
        'inbox',
        'planning',
        'assigned',
        'pending_dispatch',
        'in_progress',
        'review',
        'testing',
        'done',
      ];
      for (const s of statuses) {
        expect(STATUS_TO_GENERIC_LABEL[s]).toBeDefined();
      }
    });

    it('deliberately does NOT map blocked to any label (floor is derived)', () => {
      // "blocked" is a safety valve that can interrupt any non-terminal step,
      // so it has no static label — computeTaskProgress derives the floor.
      expect(STATUS_TO_GENERIC_LABEL.blocked).toBeUndefined();
    });

    it('maps backlog and inbox to Intake', () => {
      expect(STATUS_TO_GENERIC_LABEL.backlog).toBe('Intake');
      expect(STATUS_TO_GENERIC_LABEL.inbox).toBe('Intake');
    });

    it('maps planning to Planning', () => {
      expect(STATUS_TO_GENERIC_LABEL.planning).toBe('Planning');
    });

    it('maps assigned and pending_dispatch to Dispatch', () => {
      expect(STATUS_TO_GENERIC_LABEL.assigned).toBe('Dispatch');
      expect(STATUS_TO_GENERIC_LABEL.pending_dispatch).toBe('Dispatch');
    });

    it('maps in_progress to Execution', () => {
      expect(STATUS_TO_GENERIC_LABEL.in_progress).toBe('Execution');
    });

    it('maps review and testing to Review', () => {
      expect(STATUS_TO_GENERIC_LABEL.review).toBe('Review');
      expect(STATUS_TO_GENERIC_LABEL.testing).toBe('Review');
    });

    it('maps done to Done', () => {
      expect(STATUS_TO_GENERIC_LABEL.done).toBe('Done');
    });

    it('has exactly 6 labels in GENERIC_PHASE_LABELS', () => {
      expect(GENERIC_PHASE_LABELS.length).toBe(6);
      expect(GENERIC_PHASE_LABELS).toEqual([
        'Intake',
        'Planning',
        'Dispatch',
        'Execution',
        'Review',
        'Done',
      ]);
    });
  });

  describe('computeTaskProgress', () => {
    it('returns 6 phases in GENERIC_PHASE_LABELS order', () => {
      const result = computeTaskProgress([], null);
      expect(result.phases.length).toBe(6);
      expect(result.phases.map((p) => p.label)).toEqual([
        'Intake',
        'Planning',
        'Dispatch',
        'Execution',
        'Review',
        'Done',
      ]);
    });

    it('returns all not_started with no events and null status', () => {
      const result = computeTaskProgress([], null);
      for (const step of result.phases) {
        expect(step.status).toBe('not_started');
      }
      expect(result.current_label).toBeNull();
    });

    it('uses current status fallback when events are empty', () => {
      const result = computeTaskProgress([], 'in_progress');
      const statuses = result.phases.map((p) => `${p.label}=${p.status}`);
      // Everything up to Execution should be done/in_progress
      expect(statuses).toEqual([
        'Intake=done',
        'Planning=done',
        'Dispatch=done',
        'Execution=in_progress',
        'Review=not_started',
        'Done=not_started',
      ]);
      expect(result.current_label).toBe('Execution');
    });

    it('advances through events: backlog -> in_progress', () => {
      const events: TaskEventRow[] = [
        { from_status: 'none', to_status: 'backlog', created_at: '2024-01-01', reason: null },
        { from_status: 'backlog', to_status: 'in_progress', created_at: '2024-01-02', reason: null },
      ];
      const result = computeTaskProgress(events, 'in_progress');
      const statuses = result.phases.map((p) => `${p.label}=${p.status}`);
      expect(statuses).toEqual([
        'Intake=done',
        'Planning=done',
        'Dispatch=done',
        'Execution=in_progress',
        'Review=not_started',
        'Done=not_started',
      ]);
    });

    it('handles done status correctly', () => {
      const result = computeTaskProgress([], 'done');
      const statuses = result.phases.map((p) => `${p.label}=${p.status}`);
      expect(statuses).toEqual([
        'Intake=done',
        'Planning=done',
        'Dispatch=done',
        'Execution=done',
        'Review=done',
        'Done=done',
      ]);
      expect(result.current_label).toBe('Done');
    });

    it('records unmapped statuses', () => {
      const events: TaskEventRow[] = [
        { from_status: 'backlog', to_status: 'future_stage', created_at: '2024-01-01', reason: null },
      ];
      const result = computeTaskProgress(events, 'in_progress');
      expect(result.unmapped).toContain('future_stage');
    });

    it('deduplicates unmapped statuses', () => {
      const events: TaskEventRow[] = [
        { from_status: 'backlog', to_status: 'unknown', created_at: '2024-01-01', reason: null },
        { from_status: 'unknown', to_status: 'unknown', created_at: '2024-01-02', reason: null },
      ];
      const result = computeTaskProgress(events, null);
      expect(result.unmapped.filter((u) => u === 'unknown').length).toBe(1);
    });

    it('blocked out of in_progress floors at Execution', () => {
      const events: TaskEventRow[] = [
        { from_status: 'backlog', to_status: 'in_progress', created_at: '2024-01-01', reason: null },
        { from_status: 'in_progress', to_status: 'blocked', created_at: '2024-01-02', reason: null },
      ];
      const result = computeTaskProgress(events, 'blocked');
      const statuses = result.phases.map((p) => `${p.label}=${p.status}`);
      // blocked is derived from the interrupted step (in_progress -> Execution)
      expect(statuses).toEqual([
        'Intake=done',
        'Planning=done',
        'Dispatch=done',
        'Execution=in_progress',
        'Review=not_started',
        'Done=not_started',
      ]);
      expect(result.current_label).toBe('Execution');
    });

    it('blocked out of planning floors at Planning, not Execution', () => {
      // Regression for MR-38: a static blocked->Execution mapping wrongly
      // advanced a planning-blocked task all the way to Execution.
      const events: TaskEventRow[] = [
        { from_status: 'backlog', to_status: 'planning', created_at: '2024-01-01', reason: null },
        { from_status: 'planning', to_status: 'blocked', created_at: '2024-01-02', reason: null },
      ];
      const result = computeTaskProgress(events, 'blocked');
      const statuses = result.phases.map((p) => `${p.label}=${p.status}`);
      expect(statuses).toEqual([
        'Intake=done',
        'Planning=in_progress',
        'Dispatch=not_started',
        'Execution=not_started',
        'Review=not_started',
        'Done=not_started',
      ]);
      expect(result.current_label).toBe('Planning');
    });

    it('blocked out of review floors at Review', () => {
      const events: TaskEventRow[] = [
        { from_status: 'in_progress', to_status: 'review', created_at: '2024-01-01', reason: null },
        { from_status: 'review', to_status: 'blocked', created_at: '2024-01-02', reason: null },
      ];
      const result = computeTaskProgress(events, 'blocked');
      expect(result.current_label).toBe('Review');
      const statuses = result.phases.map((p) => `${p.label}=${p.status}`);
      expect(statuses).toEqual([
        'Intake=done',
        'Planning=done',
        'Dispatch=done',
        'Execution=done',
        'Review=in_progress',
        'Done=not_started',
      ]);
    });

    it('blocked with sparse events derives floor from last non-blocked to_status', () => {
      // Only the blocking transition is recorded; the current status is
      // blocked. The floor must come from the prior to_status (planning),
      // not a hardcoded Execution.
      const events: TaskEventRow[] = [
        { from_status: 'planning', to_status: 'blocked', created_at: '2024-01-02', reason: null },
      ];
      const result = computeTaskProgress(events, 'blocked');
      expect(result.current_label).toBe('Planning');
    });

    it('blocked with no usable events does not guess Execution', () => {
      // Fully sparse: no events at all, current status blocked. Nothing
      // establishes a floor, so no step is falsely marked reached.
      const result = computeTaskProgress([], 'blocked');
      expect(result.current_label).toBeNull();
      for (const step of result.phases) {
        expect(step.status).toBe('not_started');
      }
      // blocked is a known status, not an unmapped one.
      expect(result.unmapped).not.toContain('blocked');
    });

    it('current_label falls back to null for entirely empty input', () => {
      const result = computeTaskProgress([], null);
      expect(result.current_label).toBeNull();
    });

    it('walks multiple events in sequence correctly', () => {
      const events: TaskEventRow[] = [
        { from_status: 'none', to_status: 'backlog', created_at: '2024-01-01', reason: null },
        { from_status: 'backlog', to_status: 'planning', created_at: '2024-01-02', reason: null },
        { from_status: 'planning', to_status: 'assigned', created_at: '2024-01-03', reason: null },
        { from_status: 'assigned', to_status: 'in_progress', created_at: '2024-01-04', reason: null },
        { from_status: 'in_progress', to_status: 'review', created_at: '2024-01-05', reason: null },
      ];
      const result = computeTaskProgress(events, 'review');
      const statuses = result.phases.map((p) => `${p.label}=${p.status}`);
      expect(statuses).toEqual([
        'Intake=done',
        'Planning=done',
        'Dispatch=done',
        'Execution=done',
        'Review=in_progress',
        'Done=not_started',
      ]);
      expect(result.current_label).toBe('Review');
    });
  });
});
