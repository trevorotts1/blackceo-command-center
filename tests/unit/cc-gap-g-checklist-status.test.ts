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
      'Kanban - Department Board View',
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
// the department board rail (AgentsSidebar) shows no per-department task count (gap A follow-up).
test('screens with a known-missing checklist item stay Partial and name it', () => {
  const knownMissing: Record<string, string> = {
    'Department Boards': 'Reads department-config.json',
    'Kanban - Department Board View': 'Departments display emoji + name + task count badge',
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

// Intelligence Settings Persona Categories: met through the linked /personas screen, not embedded. The three
// lines are marked met only while the link and the /personas screen they rely on are in the code.
test('Persona Categories items are marked met only while Intelligence Settings links to /personas', () => {
  const page = fs.readFileSync(path.join(root, 'src/app/settings/intelligence/page.tsx'), 'utf-8');
  assert.ok(/href="\/personas"/.test(page), 'Intelligence Settings no longer links to /personas');
  assert.ok(fs.existsSync(path.join(root, 'src/app/personas/page.tsx')), '/personas page is missing');
  for (const item of ['Displays all personas from persona-categories.json', 'Category filters by domain work', 'Persona details: name, description, tags, use cases']) {
    assert.ok(md.includes(`- [ ] ${item} (met in code via the linked \`/personas\` screen;`), `checklist line not marked met: ${item}`);
  }
  const row = rows.find((r) => r[0] === 'Intelligence Settings')!;
  assert.ok(/linked `\/personas` screen/.test(row[3]) && /not embedded/.test(row[3]), 'row does not say the items are met via the linked screen');
});

// An overstated row is the failure this file exists to catch: "Code-checked" and "Open at" must never meet.
test('a "Code-checked" row names no open item, and a row naming one is not "Code-checked"', () => {
  for (const [name, status, , notes] of rows) {
    assert.ok(!(/code-checked/i.test(status) && /open at/i.test(notes)), `${name}: "${status}" but the notes name an open item`);
  }
});

// Gap A, Trevor's answer "2: yes" (2026-10-19): /tasks/all is the one department board, the unmounted
// five-column DepartmentBrowser is gone, and the focus view's Back button goes to the live board.
test('gap A: one department board, DepartmentBrowser removed, Back button targets /tasks/all', () => {
  assert.ok(fs.existsSync(path.join(root, 'src/app/tasks/all/page.tsx')), '/tasks/all page is missing');
  assert.ok(!fs.existsSync(path.join(root, 'src/components/ceo-board/DepartmentBrowser.tsx')), 'DepartmentBrowser.tsx is back');
  const focus = fs.readFileSync(path.join(root, 'src/app/ceo-board/[dept]/focus/page.tsx'), 'utf-8');
  assert.ok(focus.includes("router.push('/tasks/all')"), 'focus Back button does not go to /tasks/all');
  assert.ok(!focus.includes("router.push('/ceo-board/departments')"), 'focus Back button still goes to /ceo-board/departments');
  for (const f of ['CHECKLIST.md', 'PRD.md', 'README.md']) {
    assert.ok(!/Department Browser/.test(fs.readFileSync(path.join(root, f), 'utf-8')), `${f}: still describes a Department Browser`);
  }
  const focusRow = rows.find((r) => r[0] === 'Kanban - Focused Single-Department View')!;
  assert.ok(focusRow[3].includes('#569') && /gap A/.test(focusRow[3]), 'focus row does not cite #569 and gap A');
  assert.ok(md.includes('Large "Back" button returns to the department board'), 'checklist Back line missing');
  const boardRow = rows.find((r) => r[0] === 'Kanban - Department Board View')!;
  assert.ok(/partial/i.test(boardRow[1]) && /gap A/.test(boardRow[3]) && /superseded/.test(boardRow[3]), 'board row must be Partial and cite gap A / superseded');
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
