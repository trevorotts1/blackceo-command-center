/**
 * GET  /api/operator/memory/search?q=...&limit=...&sources=vault,chat,...
 * POST /api/operator/memory/search   (body: { query, limit?, sources? })
 *
 * Track B6 (Operator Console Memory, PRD Section 4.7).
 *
 * Aggregates lexical search across:
 *   - Vault markdown files
 *   - Per-agent scratch directories
 *   - operator_journal_entries
 *   - operator_chat_messages
 *   - operator_goals
 *   - research_searches  (read only; Track B7 owns writes)
 *   - tasks
 *   - agents (persona blueprints / hints)
 *
 * The PRD calls for SQLite FTS5 with hourly re-indexing eventually. This
 * route ships the user-facing contract today; the swap to FTS5 is internal
 * to `src/lib/operator/memory-search.ts`.
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { searchMemory, type MemorySourceType } from '@/lib/operator/memory-search';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const VALID_SOURCES: MemorySourceType[] = [
  'vault',
  'scratch',
  'journal',
  'chat',
  'goal',
  'research',
  'task',
  'persona',
];

const querySchema = z.object({
  query: z.string().min(1).max(2000),
  limit: z.number().int().min(1).max(200).optional(),
  sources: z.array(z.enum(VALID_SOURCES as [MemorySourceType, ...MemorySourceType[]])).optional(),
});

function parseSourcesParam(value: string | null): MemorySourceType[] | undefined {
  if (!value) return undefined;
  const list = value
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean) as MemorySourceType[];
  const valid = list.filter((s) => (VALID_SOURCES as string[]).includes(s));
  return valid.length > 0 ? valid : undefined;
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const query = url.searchParams.get('q') || url.searchParams.get('query') || '';
  const limitRaw = url.searchParams.get('limit');
  const sources = parseSourcesParam(url.searchParams.get('sources'));
  const limit = limitRaw ? Number(limitRaw) : undefined;
  if (!query.trim()) {
    return NextResponse.json({ error: 'missing_query' }, { status: 400 });
  }
  try {
    const result = await searchMemory({ query, limit, sources });
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      { error: 'search_failed', detail: err instanceof Error ? err.message : 'unknown' },
      { status: 500 }
    );
  }
}

export async function POST(req: NextRequest) {
  let parsed;
  try {
    const json = await req.json();
    parsed = querySchema.parse(json);
  } catch (err) {
    return NextResponse.json(
      { error: 'invalid_body', detail: err instanceof Error ? err.message : 'unknown' },
      { status: 400 }
    );
  }
  try {
    const result = await searchMemory(parsed);
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      { error: 'search_failed', detail: err instanceof Error ? err.message : 'unknown' },
      { status: 500 }
    );
  }
}
