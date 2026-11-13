/**
 * stale-return-note-cleanup.test.ts — U-25 / CC-052 (the stored-note half).
 *
 * The stale-task job used to PREPEND an internal bookkeeping note
 * (`[STALE-RETURN] …`) to the CLIENT'S OWN task description every time it
 * returned a stale card. U-17 stopped new notes being written; this suite pins
 * the one-time clean-up that removes the notes already stored, keeps every
 * removed note in the card's event list, leaves the client's text byte-for-byte
 * alone, and never touches a card that was edited in the meantime.
 *
 * Nine cases, one per acceptance row in 01-BUILD-SPEC.md section U-25.
 *
 * MUST import _isolated-db FIRST: every test here runs against a throwaway DB,
 * never the live board.
 */

import './_isolated-db';

import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { v4 as uuidv4 } from 'uuid';
import { queryAll, queryOne, run, getDb, transaction } from '../../src/lib/db';
import {
  runStaleReturnNoteCleanup,
  stripStaleReturnNotes,
} from '../../src/lib/jobs/stale-return-note-cleanup';

const require = createRequire(import.meta.url);

const NOTE_TAG = '[STALE-RETURN] ';
const TRIED = 'Tried: stale sweep detected no progress';
const NEEDS = 'Needs: orchestrator re-route or human triage';
const SEP = '\n\n---\n\n';
const TS = '2026-11-01T12:00:00.000Z';

/** A note exactly as the old stale-task job wrote it (no trailing separator). */
function note(problem: string, stamp = TS): string {
  return `${NOTE_TAG}${stamp}\nProblem: ${problem}\n${TRIED}\n${NEEDS}`;
}

const WORKSPACE = `ws-u25-${uuidv4().slice(0, 8)}`;
run('INSERT INTO workspaces (id, name, slug, sort_order) VALUES (?, ?, ?, 1000)', [
  WORKSPACE,
  'U-25 fixture workspace',
  `u25-${uuidv4().slice(0, 8)}`,
]);

/** Every card this suite creates, so each test starts from a clean board. */
const fixtureIds: string[] = [];

function seedTask(description: string | null): string {
  const id = uuidv4();
  fixtureIds.push(id);
  run(
    `INSERT INTO tasks (id, title, status, workspace_id, description, updated_at, last_progress_at)
     VALUES (?, ?, 'inbox', ?, ?, ?, ?)`,
    [id, `U-25 fixture ${id.slice(0, 8)}`, WORKSPACE, description, TS, TS],
  );
  return id;
}

function readTask(id: string) {
  return queryOne<{ description: string | null; updated_at: string; last_progress_at: string | null }>(
    'SELECT description, updated_at, last_progress_at FROM tasks WHERE id = ?',
    [id],
  );
}

function eventsOf(id: string, type: string) {
  return queryAll<{ message: string }>('SELECT message FROM events WHERE task_id = ? AND type = ?', [
    id,
    type,
  ]);
}

beforeEach(() => {
  if (fixtureIds.length === 0) return;
  const placeholders = fixtureIds.map(() => '?').join(',');
  run(`DELETE FROM events WHERE task_id IN (${placeholders})`, fixtureIds);
  run(`DELETE FROM tasks WHERE id IN (${placeholders})`, fixtureIds);
  fixtureIds.length = 0;
});

// ── Case 1 — one note in front of the client's text ────────────────────────────
test('1) one note is removed, the client text is exact, the note is kept as an event, no other column moves', () => {
  const problem = 'Task stale in "in_progress" for 30h with no progress';
  const id = seedTask(`${note(problem)}${SEP}Write the newsletter`);

  const result = runStaleReturnNoteCleanup();

  assert.equal(result.scanned, 1);
  assert.equal(result.cleaned, 1);
  assert.equal(result.unrecognised, 0);

  const row = readTask(id);
  assert.equal(row?.description, 'Write the newsletter', 'exactly the client text, nothing else');
  assert.equal(row?.updated_at, TS, 'updated_at must not be touched — the board clock is the client visible one');
  assert.equal(row?.last_progress_at, TS, 'last_progress_at must not be touched — staleness clocks stay as they were');

  const removed = eventsOf(id, 'stale_return_note_removed');
  assert.equal(removed.length, 1, 'the removal is recorded once');
  assert.ok(removed[0].message.includes(`Problem: ${problem}`), 'the removed note survives in the card event list');
});

// ── Case 2 — three stacked notes ───────────────────────────────────────────────
test('2) three stacked notes are all removed, and all three are kept in one event', () => {
  const clientText = 'Prepare the Q4 board pack';
  const n1 = note('Task stale in "review" for 12h', '2026-11-03T09:00:00.000Z');
  const n2 = note('Blocked task stale for 9h', '2026-11-02T09:00:00.000Z');
  const n3 = note('Task stale in "in_progress" for 40h', '2026-11-01T09:00:00.000Z');
  const id = seedTask(`${n1}${SEP}${n2}${SEP}${n3}${SEP}${clientText}`);

  runStaleReturnNoteCleanup();

  assert.equal(readTask(id)?.description, clientText);
  const removed = eventsOf(id, 'stale_return_note_removed');
  assert.equal(removed.length, 1);
  for (const n of [n1, n2, n3]) {
    assert.ok(removed[0].message.includes(n), 'every peeled note is in the event message');
  }
});

// ── Case 3 — a note and nothing else ───────────────────────────────────────────
test('3) a description that is only a note becomes null (the column is nullable) and records one event', () => {
  const id = seedTask(note('Task stale in "in_progress" for 30h with no progress'));

  runStaleReturnNoteCleanup();

  assert.equal(readTask(id)?.description, null, 'no client text survived, so the description is empty');
  assert.equal(eventsOf(id, 'stale_return_note_removed').length, 1);
});

// ── Case 4 — the client's own text contains the separator ──────────────────────
test('4) a separator inside the client text is left alone; only the note and its separator go', () => {
  const clientText = 'Intro paragraph.\n\n---\n\nSecond section that must survive byte for byte.';
  const id = seedTask(`${note('Task stale in "review" for 14h')}${SEP}${clientText}`);

  runStaleReturnNoteCleanup();

  assert.equal(readTask(id)?.description, clientText);
});

// ── Case 5 — the client's own words happen to start with the tag ───────────────
test('5) "[STALE-RETURN] is what my assistant keeps telling me" is left alone, recorded once, and not re-read', () => {
  const clientText = '[STALE-RETURN] is what my assistant keeps telling me';
  const id = seedTask(clientText);

  const first = runStaleReturnNoteCleanup();
  assert.equal(first.scanned, 1);
  assert.equal(first.unrecognised, 1);
  assert.equal(first.cleaned, 0);

  assert.equal(readTask(id)?.description, clientText, 'the client text is untouched');
  const unrecognised = eventsOf(id, 'stale_return_note_unrecognised');
  assert.equal(unrecognised.length, 1);
  assert.match(unrecognised[0].message, /does not match the note format/);

  const second = runStaleReturnNoteCleanup();
  assert.equal(second.scanned, 0, 'the NOT EXISTS guard stops the row being re-read on every run');
  assert.equal(second.unrecognised, 0);
  assert.equal(eventsOf(id, 'stale_return_note_unrecognised').length, 1, 'still exactly one record');
});

// ── Case 6 — the per-run bound ─────────────────────────────────────────────────
test('6) 250 cards, limit 200: 200 cleaned, then 50, then nothing left to scan', () => {
  transaction(() => {
    for (let i = 0; i < 250; i++) {
      seedTask(`${note(`Task stale in "in_progress" for ${20 + i}h with no progress`)}${SEP}Card ${i}`);
    }
  });

  const first = runStaleReturnNoteCleanup(200);
  assert.equal(first.scanned, 200);
  assert.equal(first.cleaned, 200);

  const second = runStaleReturnNoteCleanup(200);
  assert.equal(second.scanned, 50);
  assert.equal(second.cleaned, 50);

  const third = runStaleReturnNoteCleanup(200);
  assert.equal(third.scanned, 0);
  assert.equal(third.cleaned, 0);
});

// ── Case 7 — the kill switch ───────────────────────────────────────────────────
test('7) DISABLE_STALE_RETURN_NOTE_CLEANUP=1 changes nothing and reports why', () => {
  const id = seedTask(`${note('Task stale in "review" for 12h')}${SEP}Leave me alone`);
  const before = readTask(id);

  process.env.DISABLE_STALE_RETURN_NOTE_CLEANUP = '1';
  try {
    const result = runStaleReturnNoteCleanup();
    assert.equal(result.scanned, 0);
    assert.equal(result.cleaned, 0);
    assert.equal(result.skippedReason, 'DISABLE_STALE_RETURN_NOTE_CLEANUP set');
  } finally {
    delete process.env.DISABLE_STALE_RETURN_NOTE_CLEANUP;
  }

  assert.deepEqual(readTask(id), before, 'the description and both clocks are untouched');
  assert.equal(eventsOf(id, 'stale_return_note_removed').length, 0);
});

// ── Case 8 — a card edited between the read and the write ──────────────────────
test('8) a card edited between the read and the write keeps the newer text; no removal event exists', () => {
  const id = seedTask(`${note('Task stale in "in_progress" for 30h with no progress')}${SEP}Original text`);
  const newerText = 'Edited by a human while the clean-up was running';

  // Simulate the edit landing AFTER the candidate SELECT has read the old text.
  // The clean-up module calls the live `getDb().prepare(...)` binding on every
  // query, so the interleave is injected at the shared better-sqlite3 handle:
  // after the candidate SELECT's statement is prepared, the edit lands first.
  const dbModule = require('../../src/lib/db') as { getDb: typeof getDb };
  void dbModule;
  let edited = false;
  const handle = getDb();
  const realPrepare = handle.prepare.bind(handle);

  handle.prepare = ((sql: string, ...rest: unknown[]) => {
    const stmt = (realPrepare as (...a: unknown[]) => { all: (...a: unknown[]) => unknown[] })(
      sql,
      ...rest,
    );
    // Fire only on the candidate SELECT's execution (not on prepare): let its
    // .all() read the old text first, THEN land the concurrent edit, so the
    // row the loop holds is stale and the compare-and-set must refuse it.
    if (typeof sql === 'string' && sql.includes('SELECT id, description FROM tasks')) {
      const realAll = stmt.all.bind(stmt);
      (stmt as { all: unknown }).all = (...args: unknown[]) => {
        const rows = realAll(...(args as []));
        if (!edited) {
          edited = true;
          (realPrepare as (...a: unknown[]) => { run: (...a: unknown[]) => unknown })(
            'UPDATE tasks SET description = ? WHERE id = ?',
          ).run(newerText, id);
        }
        return rows;
      };
    }
    return stmt;
  }) as typeof handle.prepare;

  let result: ReturnType<typeof runStaleReturnNoteCleanup> = {
    scanned: -1,
    cleaned: -1,
    unrecognised: -1,
  };
  try {
    result = runStaleReturnNoteCleanup();
  } finally {
    handle.prepare = realPrepare as typeof handle.prepare;
  }

  assert.equal(edited, true, 'the interleaving really happened');
  assert.equal(result.scanned, 1);
  assert.equal(result.cleaned, 0, 'the compare-and-set refused: zero rows changed');
  assert.equal(readTask(id)?.description, newerText, 'the newer text is kept');
  assert.equal(
    eventsOf(id, 'stale_return_note_removed').length,
    0,
    'the whole transaction rolled back, so no removal event was left behind',
  );
});

// ── Case 9 — the parser itself ─────────────────────────────────────────────────
test('9) stripStaleReturnNotes: every recognition rule, including a Problem reason over two lines', () => {
  const clientText = 'Client text';

  // Not a note at all.
  assert.equal(stripStaleReturnNotes(null), null);
  assert.equal(stripStaleReturnNotes('plain text'), null);

  // A single note ending the description.
  const single = note('Task stale in "review" for 12h');
  assert.deepEqual(stripStaleReturnNotes(single), { cleaned: null, removed: [single] });

  // A note followed by the client's text.
  assert.deepEqual(stripStaleReturnNotes(`${single}${SEP}${clientText}`), {
    cleaned: clientText,
    removed: [single],
  });

  // A reason that spans two lines is still recognised; the note runs to `Needs:`.
  const multiLine = `${NOTE_TAG}${TS}\nProblem: Task stale in "in_progress" for 30h\nwith no progress\n${TRIED}\n${NEEDS}`;
  assert.deepEqual(stripStaleReturnNotes(`${multiLine}${SEP}${clientText}`), {
    cleaned: clientText,
    removed: [multiLine],
  });

  // Stacked notes are all peeled.
  const second = note('Blocked task stale for 9h');
  const stacked = `${single}${SEP}${second}${SEP}${clientText}`;
  assert.deepEqual(stripStaleReturnNotes(stacked), {
    cleaned: clientText,
    removed: [single, second],
  });

  // Tag present but the format is not: unchanged, nothing removed.
  const notANote = `${NOTE_TAG}is what my assistant keeps telling me`;
  assert.deepEqual(stripStaleReturnNotes(notANote), { cleaned: notANote, removed: [] });

  // Peeled note followed by an unrecognised tag: stop there, keep the rest as-is.
  const trailing = `${NOTE_TAG}and another one`;
  assert.deepEqual(stripStaleReturnNotes(`${single}${SEP}${trailing}`), {
    cleaned: trailing,
    removed: [single],
  });

  // The two fixed lines must be COMPLETE and CONSECUTIVE, and the Needs line must
  // end the text or be followed by the exact separator.
  const notConsecutive = `${NOTE_TAG}${TS}\nProblem: x\n${TRIED}\nnot the needs line\n${NEEDS}\nmore text`;
  assert.deepEqual(stripStaleReturnNotes(notConsecutive), {
    cleaned: notConsecutive,
    removed: [],
  });
  const wrongTerminator = `${NOTE_TAG}${TS}\nProblem: x\n${TRIED}\n${NEEDS}\nnot-a-separator`;
  assert.deepEqual(stripStaleReturnNotes(wrongTerminator), {
    cleaned: wrongTerminator,
    removed: [],
  });

  // `cleaned` is always a byte-for-byte suffix of the input.
  const noTrim = `${single}${SEP}  spaced client text  `;
  const stripped = stripStaleReturnNotes(noTrim);
  assert.equal(stripped?.cleaned, '  spaced client text  ');
  assert.ok(noTrim.endsWith(stripped!.cleaned as string));
});
