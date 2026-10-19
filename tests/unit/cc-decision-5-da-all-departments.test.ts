/**
 * Decision #5 (Trevor, 2026-10-19): Devil's Advocate applies to all departments. The unbuilt
 * per-department DA setting is dropped from the spec until a client asks for it. This guards that
 * PRD.md and CHECKLIST.md no longer present it as an open requirement.
 *
 * node --import tsx --test tests/unit/cc-decision-5-da-all-departments.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '..', '..');
const read = (f: string) => fs.readFileSync(path.join(root, f), 'utf-8');
const lines = (f: string) => read(f).split('\n').filter((l) => /DA settings/i.test(l));

test('every spec line mentioning DA settings is marked dropped by the 2026-10-19 decision', () => {
  for (const f of ['PRD.md', 'CHECKLIST.md']) {
    const hits = lines(f);
    assert.ok(hits.length > 0, `${f}: expected the dropped line to stay visible`);
    for (const l of hits) {
      assert.ok(/DROPPED/.test(l) && /2026-10-19/.test(l), `${f}: not marked dropped: ${l}`);
    }
  }
});

test('the DA checklist item is not described as an open requirement', () => {
  const row = read('CHECKLIST.md').split('\n').find((l) => l.startsWith("| Devil's Advocate"))!;
  assert.ok(/DROPPED/.test(row), 'status table row does not record the drop');
});

test('the status table names the drop outside its open items, and never lists the dropped item as open', () => {
  const notes = read('CHECKLIST.md').split('\n').find((l) => l.startsWith("| Devil's Advocate"))!;
  const at = notes.search(/open at/i);
  assert.ok(at > 0, 'row lost its open items; re-check the row before editing this guard');
  assert.ok(/DA settings/.test(notes.slice(0, at)), 'the drop is not recorded before the open items');
  assert.ok(!/department-config|DA settings/i.test(notes.slice(at)), 'the dropped item is listed among the open items');
});
