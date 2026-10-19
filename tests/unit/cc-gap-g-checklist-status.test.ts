/**
 * Gap G - CHECKLIST.md's "Component Verification Status" table still said
 * every one of the seven screens was "Not Started" with no verifier, long after
 * they shipped, so the instrument meant to record what is verified recorded
 * nothing. This guards the table: no row may claim "Not Started" or an empty
 * verifier, and every file a row cites must exist, so the table cannot drift
 * into either false direction unnoticed.
 *
 * node --import tsx --test tests/unit/cc-gap-g-checklist-status.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '..', '..');
const md = fs.readFileSync(path.join(root, 'CHECKLIST.md'), 'utf-8');

const section = md.slice(
  md.indexOf('## Component Verification Status'),
  md.indexOf('## CEO Board Checklist'),
);
const rows = section
  .split('\n')
  .filter((l) => l.startsWith('|') && !/^\|\s*-+/.test(l) && !l.startsWith('| Component'))
  .map((l) => l.split('|').slice(1, -1).map((c) => c.trim()));

test('the table lists all seven screens', () => {
  assert.deepEqual(
    rows.map((r) => r[0]),
    [
      'CEO Board',
      'Department Boards',
      'Kanban - Department Browser View',
      'Kanban - Focused Single-Department View',
      'Performance Board',
      "Devil's Advocate",
      'Intelligence Settings',
    ],
  );
});

test('no screen is recorded as "Not Started" or has an empty verifier', () => {
  for (const [name, status, verifiedBy] of rows) {
    assert.ok(!/not started/i.test(status), `${name}: still "${status}"`);
    assert.ok(verifiedBy && verifiedBy !== '-', `${name}: no verifier recorded`);
  }
});

test('every file a row cites exists in the repo', () => {
  for (const [name, , , notes] of rows) {
    const cited = [...notes.matchAll(/`([^`]+\.(?:tsx?|md|json))`/g)].map((m) => m[1]);
    assert.ok(cited.length > 0, `${name}: cites no file as evidence`);
    for (const rel of cited) {
      assert.ok(fs.existsSync(path.join(root, rel)), `${name}: cited file missing: ${rel}`);
    }
  }
});

// Rows that the checklist's own sections show as incomplete at main must not say "Implemented".
// Each must be Partial and name the open PR carrying the fix.
test('screens with a known open defect are Partial and cite their fix PR', () => {
  const expectPr: Record<string, string> = {
    'Kanban - Focused Single-Department View': '#569',
    "Devil's Advocate": '#570',
    'Intelligence Settings': '#571',
  };
  for (const [name, status, , notes] of rows) {
    if (!expectPr[name]) continue;
    assert.ok(/partial/i.test(status) && !/implemented/i.test(status), `${name}: status is "${status}"`);
    assert.ok(notes.includes(expectPr[name]), `${name}: does not cite ${expectPr[name]}`);
  }
});
