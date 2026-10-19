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

// Truth at the merge-train-2 head (main 2be019fd + #569 + #573). Gaps B, D and E are in the code, so the
// rows whose only open item was one of them are Implemented and cite the PR that closed it. Every other
// row has an open item that is NOT a gap fix and must stay Partial/Open.
test('screens closed by a merged gap fix are Implemented and cite that PR', () => {
  const closedBy: Record<string, string> = {
    'Kanban - Focused Single-Department View': '#569',
    'Intelligence Settings': '#571',
  };
  for (const [name, pr] of Object.entries(closedBy)) {
    const row = rows.find((r) => r[0] === name)!;
    assert.ok(/implemented/i.test(row[1]) && !/partial|open/i.test(row[1]), `${name}: status is "${row[1]}"`);
    assert.ok(row[3].includes(pr), `${name}: does not cite ${pr}`);
    assert.ok(!/open at/i.test(row[3]), `${name}: Implemented row still lists an open item`);
  }
});

// Only the two rows above may say "Implemented"; any other row claiming it is a false claim.
test('no other screen says "Implemented"', () => {
  const allowed = new Set(['Kanban - Focused Single-Department View', 'Intelligence Settings']);
  for (const [name, status] of rows) {
    if (allowed.has(name)) continue;
    assert.ok(!/implemented/i.test(status), `${name}: claims "${status}"`);
  }
});

// Any row whose own checklist section still has an unchecked item known to be missing at the train head
// cannot say "Implemented". Each item below was verified missing: grading.ts weights are 25/30/20/25
// (grade-calculator.ts 40/30/15/15 is @deprecated); no code under src reads department-config.json (so
// neither Department Boards nor the DA row's "Respects department-config.json DA settings" item can be
// met); company-level benchmark comparison is not rendered; DepartmentBrowser.tsx is not mounted (gap A).
test('screens with a known-missing checklist item never say "Implemented"', () => {
  const knownMissing: Record<string, string> = {
    'CEO Board': 'Grade calculation uses correct weights',
    'Department Boards': 'Reads department-config.json',
    'Performance Board': 'Industry benchmark comparisons',
    "Devil's Advocate": 'Respects department-config.json DA settings',
  };
  for (const [name, status, , notes] of rows) {
    const item = knownMissing[name];
    if (!item) continue;
    assert.ok(md.includes(`- [ ] ${item}`), `${name}: item "${item}" is no longer an open checklist line, update this guard`);
    assert.ok(/partial/i.test(status) && !/implemented/i.test(status), `${name}: status is "${status}"`);
    assert.ok(/open at/i.test(notes), `${name}: row does not cite the open item`);
  }
});

test('the department browser row stays Open (gap A, five-column browser unmounted)', () => {
  const row = rows.find((r) => r[0] === 'Kanban - Department Browser View')!;
  assert.ok(/open|partial/i.test(row[1]) && !/implemented/i.test(row[1]), `status is "${row[1]}"`);
  assert.ok(/gap A/.test(row[3]), 'row does not cite gap A as the open item');
});
