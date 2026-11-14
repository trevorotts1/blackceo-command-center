/**
 * Stale-return note clean-up — CC-052 (stored-note half), built by U-25.
 *
 * THE DEFECT. Until U-17, `returnToOrchestrator()` in stale-task-sweep.ts
 * prepended an internal bookkeeping note to the CLIENT'S OWN description every
 * time it returned a stale card to the queue:
 *
 *   [STALE-RETURN] <ISO timestamp>[ (<counters>)]
 *   Problem: <reason>
 *   Tried: stale sweep detected no progress
 *   Needs: orchestrator re-route or human triage
 *
 *   ---
 *
 *   <what the client wrote>
 *
 * U-17 stops the note being WRITTEN; the notes already sitting on live boards
 * stay there — inside the text the client reads. This module removes them, once,
 * safely, and keeps every removed note in the card's own event list so nothing
 * is lost and a human can read it back (or put it back) by hand.
 *
 * TWO RULES THAT MAKE IT SAFE:
 *   1. Recognition is EXACT and narrow. A note is peeled only when all four
 *      markers are present in the shipped format and the note is terminated by
 *      end-of-text or the exact blank-line/`---`/blank-line separator. Anything
 *      else is left byte-for-byte alone and recorded as unrecognised once.
 *   2. The write is a compare-and-set on the exact text that was read
 *      (`WHERE id = ? AND description = ?`), and no other column is written —
 *      not updated_at, not last_progress_at — so the board's "last changed"
 *      times and every staleness clock are untouched. A card edited in between
 *      fails the set, the transaction rolls back, and the next run reads it
 *      again.
 *
 * No message is sent to anyone and nothing is broadcast.
 *
 * Disable with DISABLE_STALE_RETURN_NOTE_CLEANUP=1 (or "true"): the clean-up
 * reports its skippedReason and touches nothing.
 */

import { queryAll, run, transaction } from '@/lib/db';
import { v4 as uuidv4 } from 'uuid';

/** Line 1 of a note. The trailing space is part of the shipped format. */
const NOTE_TAG = '[STALE-RETURN] ';
/** Line 2 of a note. Its reason may continue over further lines. */
const PROBLEM_PREFIX = 'Problem: ';
/** The two fixed lines that identify the note body, as COMPLETE lines. */
const TRIED_LINE = 'Tried: stale sweep detected no progress';
const NEEDS_LINE = 'Needs: orchestrator re-route or human triage';
/** Between a note and whatever follows it. A note at the very end has none. */
const NOTE_SEPARATOR = '\n\n---\n\n';

const REMOVED_EVENT_TYPE = 'stale_return_note_removed';
const UNRECOGNISED_EVENT_TYPE = 'stale_return_note_unrecognised';

const REMOVED_EVENT_HEADER =
  "Removed internal notes from this task's description (kept here so nothing is lost):";
const UNRECOGNISED_MESSAGE =
  'A description starts with [STALE-RETURN] but does not match the note format; left unchanged.';

interface ParsedNote {
  /** The note text itself, from line 1 through the `Needs:` line. */
  note: string;
  /** What follows the note's separator, or null when the note ends the text. */
  rest: string | null;
}

interface StripResult {
  cleaned: string | null;
  removed: string[];
}

interface CleanupResult {
  scanned: number;
  cleaned: number;
  unrecognised: number;
  skippedReason?: string;
}

/**
 * Index just past the `Needs:` line — i.e. the index of the `\n` that ends it,
 * or `text.length` when the text ends with that line. Null when the two fixed
 * lines are not present as two complete consecutive lines.
 *
 * The `Problem:` reason may span several lines, so this takes the FIRST
 * occurrence of the exact pair rather than assuming a fixed line number.
 */
function findNeedsLineEnd(text: string): number | null {
  let from = 0;
  for (;;) {
    const tried = text.indexOf(TRIED_LINE, from);
    if (tried < 0) return null;
    const atLineStart = tried > 0 && text[tried - 1] === '\n';
    const afterTried = tried + TRIED_LINE.length;
    if (atLineStart && text.startsWith('\n' + NEEDS_LINE, afterTried)) {
      const afterNeeds = afterTried + 1 + NEEDS_LINE.length;
      // Complete line: end of text, or a newline after it.
      if (afterNeeds === text.length || text[afterNeeds] === '\n') return afterNeeds;
    }
    from = tried + 1;
  }
}

/**
 * Peel ONE note from the front. Null means this text does not start with a
 * recognised note (either it does not start with the tag at all, or the tag is
 * there but the rest of the shipped format is not).
 */
function parseNote(text: string): ParsedNote | null {
  if (!text.startsWith(NOTE_TAG)) return null;

  const firstNewline = text.indexOf('\n');
  if (firstNewline < 0) return null;
  const secondLineStart = firstNewline + 1;
  if (!text.startsWith(PROBLEM_PREFIX, secondLineStart)) return null;

  const afterNeeds = findNeedsLineEnd(text);
  if (afterNeeds === null) return null;

  const note = text.slice(0, afterNeeds);
  if (afterNeeds === text.length) return { note, rest: null };
  if (!text.startsWith(NOTE_SEPARATOR, afterNeeds)) return null;
  return { note, rest: text.slice(afterNeeds + NOTE_SEPARATOR.length) };
}

/**
 * Remove the `[STALE-RETURN]` notes stored in front of a task description.
 *
 * Returns null when the text does not start with the tag (nothing to do).
 * Otherwise `cleaned` is a byte-for-byte SUFFIX of the input — the text is never
 * trimmed, re-wrapped or otherwise rewritten — and `removed` holds the notes
 * that were peeled, newest first (they are stored that way).
 *
 * A description that starts with the tag but carries no recognised note is
 * returned unchanged with `removed: []`, so the caller can record the one-off
 * "unrecognised" note and stop re-reading the row on every run.
 */
export function stripStaleReturnNotes(description: string | null): StripResult | null {
  if (description === null || !description.startsWith(NOTE_TAG)) return null;

  const removed: string[] = [];
  let remaining = description;

  for (;;) {
    const parsed = parseNote(remaining);
    if (parsed === null) break;
    removed.push(parsed.note);
    if (parsed.rest === null) return { cleaned: null, removed };
    remaining = parsed.rest;
    // The rest of the description is the client's unless another note follows.
    if (!remaining.startsWith(NOTE_TAG)) break;
  }

  return { cleaned: remaining, removed };
}

function cleanupDisabled(): boolean {
  const raw = (process.env.DISABLE_STALE_RETURN_NOTE_CLEANUP ?? '').trim();
  return raw === '1' || raw === 'true';
}

/** Thrown inside a row's transaction to roll it back when the card changed. */
class CompareAndSetMiss extends Error {}

/**
 * Remove stored `[STALE-RETURN]` notes, at most `limit` cards per run.
 *
 * One transaction per card:
 *   - notes peeled  → one `stale_return_note_removed` event carrying them, then
 *                     the compare-and-set update. A zero-row update (the card
 *                     was edited in between) rolls the whole transaction back
 *                     and counts nothing; the next run reads the row again.
 *   - tag only      → one `stale_return_note_unrecognised` event, task untouched.
 *
 * The `NOT EXISTS` on the candidate query is what stops an unrecognised row
 * being re-read on every run (the same class of fault CC-063 fixed in the
 * stale-task job). Archived cards are included on purpose: the client must not
 * meet an old internal note when a card is un-archived.
 *
 * Never throws: a failure on one card is logged and the loop continues.
 */
export function runStaleReturnNoteCleanup(limit = 200): CleanupResult {
  const result: CleanupResult = { scanned: 0, cleaned: 0, unrecognised: 0 };

  if (cleanupDisabled()) {
    result.skippedReason = 'DISABLE_STALE_RETURN_NOTE_CLEANUP set';
    return result;
  }

  let rows: Array<{ id: string; description: string | null }>;
  try {
    rows = queryAll<{ id: string; description: string | null }>(
      `SELECT id, description FROM tasks
        WHERE description LIKE '[STALE-RETURN] %'
          AND NOT EXISTS (
            SELECT 1 FROM events e
             WHERE e.task_id = tasks.id AND e.type = 'stale_return_note_unrecognised'
          )
        ORDER BY id
        LIMIT ?`,
      [limit],
    );
  } catch (err) {
    console.warn(
      '[stale-return-note-cleanup] could not read task descriptions (non-fatal):',
      (err as Error).message,
    );
    return result;
  }

  result.scanned = rows.length;

  for (const row of rows) {
    try {
      const parsed = stripStaleReturnNotes(row.description);
      if (parsed === null) continue; // cannot happen for a row this query selects

      const now = new Date().toISOString();
      const outcome = transaction(() => {
        if (parsed.removed.length > 0) {
          run(
            `INSERT INTO events (id, type, task_id, message, created_at)
             VALUES (?, 'stale_return_note_removed', ?, ?, ?)`,
            [uuidv4(), row.id, `${REMOVED_EVENT_HEADER}\n\n${parsed.removed.join('\n\n')}`, now],
          );
          const res = run(
            'UPDATE tasks SET description = ? WHERE id = ? AND description = ?',
            [parsed.cleaned, row.id, row.description],
          );
          if (res.changes === 0) throw new CompareAndSetMiss();
          return 'cleaned' as const;
        }

        run(
          `INSERT INTO events (id, type, task_id, message, created_at)
           VALUES (?, 'stale_return_note_unrecognised', ?, ?, ?)`,
          [uuidv4(), row.id, UNRECOGNISED_MESSAGE, now],
        );
        return 'unrecognised' as const;
      });

      if (outcome === 'cleaned') result.cleaned++;
      else result.unrecognised++;
    } catch (err) {
      // The card was edited between the read and the write: the transaction is
      // already rolled back, nothing was counted, and the next run re-reads it.
      if (err instanceof CompareAndSetMiss) continue;
      console.warn(
        `[stale-return-note-cleanup] card ${row.id} failed (non-fatal):`,
        (err as Error).message,
      );
    }
  }

  return result;
}
