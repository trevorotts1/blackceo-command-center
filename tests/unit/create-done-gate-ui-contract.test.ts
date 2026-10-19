/**
 * Create-done gate — UI contract (Gap 1 of the 8b2b4a2728 QC).
 *
 * POST /api/tasks refuses a task created already `done` or `review` (no
 * deliverable can exist yet — see the completion-evidence gate in
 * src/app/api/tasks/route.ts). The create form must not offer those two, and
 * a "+" pressed on the board's Done / Review column must land the task in a
 * non-terminal status instead of letting the submit 403.
 *
 * This file locks the pure contract in src/lib/board-projection.ts; the render
 * proof (the dropdown itself, the downgrade notice, the seeded value) lives in
 * create-done-gate-modal.test.tsx.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CREATE_TERMINAL_STATUSES,
  createDropdownStatuses,
  createSubmitStatus,
  isCreateTerminalStatus,
} from '../../src/lib/board-projection';

const ALL_STATUSES = ['backlog', 'inbox', 'planning', 'in_progress', 'assigned', 'review', 'testing', 'blocked', 'pending_dispatch', 'done'] as const;

test('terminal-at-create is exactly {done, review} — mirrors the server gate', () => {
  assert.deepEqual([...CREATE_TERMINAL_STATUSES].sort(), ['done', 'review']);
  for (const s of ALL_STATUSES) {
    assert.equal(isCreateTerminalStatus(s), s === 'done' || s === 'review', `isCreateTerminalStatus(${s})`);
  }
});

test('the create dropdown offers every status EXCEPT done/review; the full list is untouched', () => {
  const offered = createDropdownStatuses(ALL_STATUSES);
  assert.deepEqual(offered, ALL_STATUSES.filter((s) => s !== 'done' && s !== 'review'));
  // Frozen input: a helper that mutated its argument would throw here.
  const frozen = Object.freeze([...ALL_STATUSES]) as readonly TaskStatus[];
  assert.equal(createDropdownStatuses(frozen).length, ALL_STATUSES.length - 2);
  assert.equal(frozen.length, ALL_STATUSES.length);
});

test('a create seeded from the Done/Review column is downgraded to a non-terminal status', () => {
  for (const s of ALL_STATUSES) {
    assert.equal(isCreateTerminalStatus(createSubmitStatus(s)), false, `createSubmitStatus(${s}) = ${createSubmitStatus(s)} is still terminal`);
  }
});

test('downgrade targets: review -> assigned (queued), done -> in_progress (claimed)', () => {
  assert.equal(createSubmitStatus('review'), 'assigned');
  assert.equal(createSubmitStatus('done'), 'in_progress');
});

test('every other status passes through unchanged (no silent reshaping)', () => {
  for (const s of ALL_STATUSES) {
    if (isCreateTerminalStatus(s)) continue;
    assert.equal(createSubmitStatus(s), s);
  }
});
