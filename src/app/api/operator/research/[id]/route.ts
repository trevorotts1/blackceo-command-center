/**
 * GET /api/operator/research/[id]
 *
 * Returns one saved research search by id, with full markdown and metadata.
 *
 * Track B7 (SCOPE-ADDITION Section 5).
 */

import { NextRequest, NextResponse } from 'next/server';
import { getResearchSearch } from '@/lib/research-store';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(_req: NextRequest, ctx: { params: { id: string } }) {
  const id = ctx.params.id;
  if (!id) {
    return NextResponse.json({ error: 'missing_id' }, { status: 400 });
  }

  try {
    const row = getResearchSearch(id);
    if (!row) {
      return NextResponse.json({ error: 'not_found' }, { status: 404 });
    }
    return NextResponse.json({
      id: row.id,
      query: row.query,
      model: row.model,
      markdown_result: row.result_markdown,
      created_at: row.created_at,
      search_metadata: row.search_metadata,
    });
  } catch (err) {
    return NextResponse.json(
      { error: 'fetch_failed', detail: err instanceof Error ? err.message : 'unknown' },
      { status: 500 }
    );
  }
}
