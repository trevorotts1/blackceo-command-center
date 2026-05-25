/**
 * GET  /api/operator/journal              — list entries (newest first)
 * POST /api/operator/journal              — upsert today's (or any date's) entry
 *
 * Track B6 (Operator Console Journal, PRD Section 4.7).
 *
 * Query params on GET:
 *   ?limit=<int 1..365>
 *   ?offset=<int>
 *   ?from=YYYY-MM-DD
 *   ?to=YYYY-MM-DD
 *   ?q=<substring>
 *
 * POST body:
 *   { entry_date: YYYY-MM-DD (required), body: string (required, <=200k chars) }
 *
 * One entry per date by UNIQUE constraint. Auto-save from the UI calls POST
 * repeatedly with the same `entry_date`; we upsert and re-mirror the markdown
 * file to `<vault>/journal/YYYY/MM/YYYY-MM-DD.md`.
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import {
  isValidEntryDate,
  listJournalEntries,
  upsertJournalEntry,
  writeJournalMirror,
} from '@/lib/operator/journal';

const upsertSchema = z.object({
  entry_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  body: z.string().max(200_000),
});

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const limit = Number(url.searchParams.get('limit')) || undefined;
  const offset = Number(url.searchParams.get('offset')) || undefined;
  const from = url.searchParams.get('from') || undefined;
  const to = url.searchParams.get('to') || undefined;
  const q = url.searchParams.get('q') || undefined;
  if (from && !isValidEntryDate(from)) {
    return NextResponse.json({ error: 'invalid_from' }, { status: 400 });
  }
  if (to && !isValidEntryDate(to)) {
    return NextResponse.json({ error: 'invalid_to' }, { status: 400 });
  }
  try {
    const result = listJournalEntries({ limit, offset, from, to, query: q });
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      { error: 'list_failed', detail: err instanceof Error ? err.message : 'unknown' },
      { status: 500 }
    );
  }
}

export async function POST(req: NextRequest) {
  let parsed;
  try {
    const json = await req.json();
    parsed = upsertSchema.parse(json);
  } catch (err) {
    return NextResponse.json(
      { error: 'invalid_body', detail: err instanceof Error ? err.message : 'unknown' },
      { status: 400 }
    );
  }
  try {
    const entry = upsertJournalEntry({
      entry_date: parsed.entry_date,
      body: parsed.body,
    });
    void writeJournalMirror(entry);
    return NextResponse.json(entry);
  } catch (err) {
    return NextResponse.json(
      { error: 'upsert_failed', detail: err instanceof Error ? err.message : 'unknown' },
      { status: 500 }
    );
  }
}
