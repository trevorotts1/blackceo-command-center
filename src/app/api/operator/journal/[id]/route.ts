/**
 * GET    /api/operator/journal/[id] — fetch one journal entry.
 *
 *   The [id] segment can be EITHER the UUID primary key or a YYYY-MM-DD date.
 *   Date is the convenience path the UI uses for direct deep links from
 *   Memory search and the Command Palette.
 *
 * PATCH  /api/operator/journal/[id] — partial body update.
 * DELETE /api/operator/journal/[id] — remove the entry by UUID only.
 *
 * Track B6 (Operator Console Journal, PRD Section 4.7).
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import {
  deleteJournalEntry,
  getJournalEntryById,
  getJournalEntryByDate,
  isValidEntryDate,
  upsertJournalEntry,
  writeJournalMirror,
} from '@/lib/operator/journal';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const patchSchema = z.object({
  body: z.string().max(200_000),
});

function resolveEntry(idOrDate: string) {
  if (isValidEntryDate(idOrDate)) {
    return getJournalEntryByDate(idOrDate);
  }
  return getJournalEntryById(idOrDate);
}

export async function GET(_req: NextRequest, ctx: { params: { id: string } }) {
  const entry = resolveEntry(ctx.params.id);
  if (!entry) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }
  return NextResponse.json(entry);
}

export async function PATCH(req: NextRequest, ctx: { params: { id: string } }) {
  let parsed;
  try {
    const json = await req.json();
    parsed = patchSchema.parse(json);
  } catch (err) {
    return NextResponse.json(
      { error: 'invalid_body', detail: err instanceof Error ? err.message : 'unknown' },
      { status: 400 }
    );
  }
  const existing = resolveEntry(ctx.params.id);
  if (!existing) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }
  try {
    const updated = upsertJournalEntry({ entry_date: existing.entry_date, body: parsed.body });
    void writeJournalMirror(updated);
    return NextResponse.json(updated);
  } catch (err) {
    return NextResponse.json(
      { error: 'update_failed', detail: err instanceof Error ? err.message : 'unknown' },
      { status: 500 }
    );
  }
}

export async function DELETE(_req: NextRequest, ctx: { params: { id: string } }) {
  // Deletion is by primary key only. Date deletion would be too easy to do
  // accidentally from a deep link.
  if (isValidEntryDate(ctx.params.id)) {
    return NextResponse.json({ error: 'delete_requires_uuid' }, { status: 400 });
  }
  try {
    const removed = deleteJournalEntry(ctx.params.id);
    if (!removed) {
      return NextResponse.json({ error: 'not_found' }, { status: 404 });
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: 'delete_failed', detail: err instanceof Error ? err.message : 'unknown' },
      { status: 500 }
    );
  }
}
