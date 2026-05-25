/**
 * GET /api/operator/web-agent/sessions
 *
 * Returns paginated Web Agent session history (newest first).
 *
 * Query params:
 *   limit  (optional, 1..200, default 25)
 *   offset (optional, default 0)
 *
 * Track B9 (SCOPE-ADDITION Section 7).
 *
 * The response trims `result_markdown` to a short preview so the sidebar
 * stays cheap to render. Detail view fetches the full row server-side via
 * `getSession` (no separate endpoint needed; the session detail page is a
 * server component).
 */

import { NextRequest, NextResponse } from 'next/server';
import { listSessions } from '@/lib/web-agent/runner';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

function clampInt(value: string | null, fallback: number, min: number, max: number): number {
  if (!value) return fallback;
  const n = parseInt(value, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function preview(md: string | null, max = 200): string {
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
    const page = listSessions({ limit, offset });
    return NextResponse.json({
      items: page.items.map((row) => ({
        id: row.id,
        task: row.task,
        status: row.status,
        preview: preview(row.result_markdown),
        started_at: row.started_at,
        ended_at: row.ended_at,
        action_count: row.action_log.filter((e) => e.kind === 'action').length,
        created_at: row.created_at,
      })),
      total: page.total,
      limit: page.limit,
      offset: page.offset,
    });
  } catch (err) {
    return NextResponse.json(
      { error: 'sessions_list_failed', detail: err instanceof Error ? err.message : 'unknown' },
      { status: 500 }
    );
  }
}
