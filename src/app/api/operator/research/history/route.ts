/**
 * GET /api/operator/research/history
 *
 * Returns paginated research search history (newest first).
 *
 * Query params:
 *   limit  (optional, 1..200, default 25)
 *   offset (optional, default 0)
 *
 * Track B7 (SCOPE-ADDITION Section 5).
 *
 * The response intentionally trims `result_markdown` to a 240 character
 * preview so the history sidebar can render hundreds of rows without paying
 * for the full markdown payload on each list call. Detail view fetches the
 * full row via /api/operator/research/[id].
 */

import { NextRequest, NextResponse } from 'next/server';
import { listResearchSearches } from '@/lib/research-store';

function clampInt(value: string | null, fallback: number, min: number, max: number): number {
  if (!value) return fallback;
  const n = parseInt(value, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function preview(md: string, max = 240): string {
  if (!md) return '';
  const trimmed = md.replace(/\s+/g, ' ').trim();
  if (trimmed.length <= max) return trimmed;
  return trimmed.slice(0, max) + '...';
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const limit = clampInt(url.searchParams.get('limit'), 25, 1, 200);
  const offset = clampInt(url.searchParams.get('offset'), 0, 0, 1_000_000);

  try {
    const page = listResearchSearches({ limit, offset });
    return NextResponse.json({
      items: page.items.map((row) => ({
        id: row.id,
        query: row.query,
        model: row.model,
        preview: preview(row.result_markdown),
        created_at: row.created_at,
        depth: typeof row.search_metadata?.depth === 'string' ? row.search_metadata.depth : null,
        citation_count:
          typeof row.search_metadata?.citation_count === 'number'
            ? row.search_metadata.citation_count
            : null,
      })),
      total: page.total,
      limit: page.limit,
      offset: page.offset,
    });
  } catch (err) {
    return NextResponse.json(
      { error: 'history_failed', detail: err instanceof Error ? err.message : 'unknown' },
      { status: 500 }
    );
  }
}
