/**
 * tests/unit/kanban-client-wording.test.ts
 *
 * U-09 (CC-014, CC-017, CC-040) — the board's client-facing vocabulary.
 *
 * The board used to say engineering words ("SOP", "persona", "lifecycle",
 * "QC-check", "groomed") and gave a status pill a label that contradicted the
 * column the card sat in. Both are pinned here against the single source in
 * src/lib/board-labels.ts, which the components import (no restatement).
 *
 *   node --import tsx --test tests/unit/kanban-client-wording.test.ts
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TODO_COLUMN_LABEL,
  STATUS_PILL_LABELS,
  COLUMN_HELP_TEXT,
  triadMissingPillText,
} from '../../src/lib/board-labels';

test('U-09: every status that buckets into To-Do wears the column\'s own label', () => {
  for (const status of ['inbox', 'planning', 'assigned', 'pending_dispatch']) {
    assert.equal(
      STATUS_PILL_LABELS[status],
      TODO_COLUMN_LABEL,
      `status "${status}" must show the "${TODO_COLUMN_LABEL}" label`,
    );
  }
});

test('U-09: review and testing both read "Review / QC"', () => {
  assert.equal(STATUS_PILL_LABELS.review, 'Review / QC');
  assert.equal(STATUS_PILL_LABELS.testing, 'Review / QC');
});

test('U-09: the Backlog card pill says "Still needs:" in plain English', () => {
  assert.equal(
    triadMissingPillText(['sop_id', 'persona_id']),
    'Still needs: a playbook, a working style',
  );
});

test('U-09: column help text uses no internal vocabulary', () => {
  const banned = /SOP|persona|lifecycle|QC-check|groomed/i;
  const entries = Object.entries(COLUMN_HELP_TEXT);
  assert.equal(entries.length, 6, 'all six columns must carry help text');
  for (const [column, text] of entries) {
    assert.ok(text.length > 0, `${column} help text must not be empty`);
    assert.doesNotMatch(text, banned, `${column} help text leaks internal vocabulary: ${text}`);
  }
});
