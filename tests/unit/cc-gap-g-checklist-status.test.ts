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

// Truth at the merge-train-2 head (main 2be019fd + #569, #573). Gaps B and E are in the code, but the two
// rows they touch still have a different unmet checklist item, so no row may say "Implemented". Each
// row below must cite the PR that closed its gap AND name the still-open item.
test('rows touched by a merged gap fix cite that PR and stay Partial', () => {
  const closedBy: Record<string, string> = {
    'Kanban - Focused Single-Department View': '#569',
    'Intelligence Settings': '#571',
  };
  for (const [name, pr] of Object.entries(closedBy)) {
    const row = rows.find((r) => r[0] === name)!;
    assert.ok(/partial/i.test(row[1]) && !/implemented/i.test(row[1]), `${name}: status is "${row[1]}"`);
    assert.ok(row[3].includes(pr), `${name}: does not cite ${pr}`);
  }
});

// No row may say "Implemented" while any checklist item for it is known missing; today none qualifies.
test('no screen says "Implemented"', () => {
  for (const [name, status] of rows) {
    assert.ok(!/implemented/i.test(status), `${name}: claims "${status}"`);
  }
});

// Each item below was verified missing at the train head: no code under src reads department-config.json;
// the focus page Back button goes to
// /ceo-board/departments, not the unmounted Department Browser (gap A); Intelligence Settings has no
// persona category list, domain filter or link to /personas.
test('screens with a known-missing checklist item stay Partial and name it', () => {
  const knownMissing: Record<string, string> = {
    'Department Boards': 'Reads department-config.json',
    'Kanban - Focused Single-Department View': 'Large "Back" button returns to Browser view',
    "Devil's Advocate": 'Respects department-config.json DA settings',
    'Intelligence Settings': 'Displays all personas from persona-categories.json',
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

// Trevor's decisions of 2026-10-19: the spec follows the code for grade weights (25/30/20/25 in
// grading.ts), and industry benchmarks live on department pages only, so no spec text may promise
// the old 40/30/15/15 grade or a company-level benchmark on the Performance Board.
test('spec text matches the grade-weights and benchmark decisions', () => {
  const prd = fs.readFileSync(path.join(root, 'PRD.md'), 'utf-8');
  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf-8');
  const grading = fs.readFileSync(path.join(root, 'src/lib/grading.ts'), 'utf-8');
  for (const [name, text] of [['PRD.md', prd], ['CHECKLIST.md', md], ['README.md', readme]] as const) {
    assert.ok(!/40% KPI|30% Agent|15% DA|15% Recommend|40\/30\/15\/15 formula/i.test(text), `${name}: still states the old 40/30/15/15 weights`);
  }
  assert.ok(/throughput:\s*0\.25[\s\S]*qcPassRate:\s*0\.30[\s\S]*sopCoverage:\s*0\.20[\s\S]*kpiAttainment:\s*0\.25/.test(grading), 'grading.ts weights no longer 25/30/20/25: update the spec text');
  assert.ok(/25% Throughput[\s\S]*30% QC Pass Rate[\s\S]*20% SOP Coverage[\s\S]*25% KPI/.test(prd), 'PRD.md does not list the live weights');
  const home = fs.readFileSync(path.join(root, 'src/app/page.tsx'), 'utf-8');
  assert.ok(!/KPIs, benchmarks/.test(home), 'home card still promises benchmarks on the Performance Board');
});
