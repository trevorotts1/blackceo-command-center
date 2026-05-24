import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { broadcast } from '@/lib/events';
import type { PublishQueueItem } from '@/lib/types';

// Supported platform slugs — mirrors run-publishing-cycle.sh --platforms.
const SUPPORTED_PLATFORMS = new Set([
  'wordpress', 'medium', 'substack', 'linkedin', 'ghl', 'youtube',
  'x', 'twitter', 'facebook', 'instagram', 'tiktok', 'threads', 'pinterest',
  'email', 'podcast',
]);

interface PublishRequestBody {
  task_id?: string;
  topic: string;
  platforms: string[];
  schedule?: string;
  requested_by?: string;
}

function rowToItem(row: Record<string, unknown>): PublishQueueItem {
  let platforms: string[] = [];
  const raw = row.platforms;
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) platforms = parsed.map(String);
    } catch {
      platforms = [];
    }
  }
  return {
    id: String(row.id),
    task_id: row.task_id ? String(row.task_id) : null,
    topic: String(row.topic ?? ''),
    platforms,
    schedule: (row.schedule as string) || 'auto',
    status: (row.status as PublishQueueItem['status']) || 'queued',
    run_id: row.run_id ? String(row.run_id) : null,
    requested_by: row.requested_by ? String(row.requested_by) : null,
    error: row.error ? String(row.error) : null,
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
    started_at: row.started_at ? String(row.started_at) : null,
    completed_at: row.completed_at ? String(row.completed_at) : null,
  };
}

/**
 * POST /api/skill-35/publish
 *
 * Queues a Skill 35 publishing cycle. Body:
 *   {
 *     task_id?: string,         // optional Marketing task this is queued for
 *     topic: string,            // required — passed to --topic
 *     platforms: string[],      // required — passed to --platforms (CSV)
 *     schedule?: string,        // 'auto' (default) | 'now' | ISO 8601
 *     requested_by?: string,    // audit field (agent id, user id, etc.)
 *   }
 *
 * Inserts a row into publish_queue, broadcasts a `publish_queued` SSE
 * event, and returns the queued item. A downstream worker / the OpenClaw
 * master orchestrator picks up `status = 'queued'` rows and invokes
 * 35-social-media-planner/scripts/run-publishing-cycle.sh.
 */
export async function POST(request: NextRequest) {
  let body: PublishRequestBody;
  try {
    body = (await request.json()) as PublishRequestBody;
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
  }

  const topic = (body.topic || '').trim();
  if (!topic) {
    return NextResponse.json({ error: 'topic is required' }, { status: 400 });
  }
  if (!Array.isArray(body.platforms) || body.platforms.length === 0) {
    return NextResponse.json({ error: 'platforms must be a non-empty array' }, { status: 400 });
  }

  // Normalize platform list (lowercase, trim, dedupe, alias twitter->x).
  const platforms: string[] = [];
  const seen = new Set<string>();
  for (const raw of body.platforms) {
    if (typeof raw !== 'string') continue;
    let p = raw.trim().toLowerCase();
    if (!p) continue;
    if (p === 'twitter') p = 'x';
    if (!SUPPORTED_PLATFORMS.has(p)) {
      return NextResponse.json(
        { error: `unsupported platform: '${p}'`, supported: Array.from(SUPPORTED_PLATFORMS) },
        { status: 400 },
      );
    }
    if (!seen.has(p)) {
      seen.add(p);
      platforms.push(p);
    }
  }
  if (platforms.length === 0) {
    return NextResponse.json({ error: 'platforms produced an empty list after normalization' }, { status: 400 });
  }

  const schedule = (body.schedule || 'auto').trim() || 'auto';
  const taskId = body.task_id || null;
  const requestedBy = body.requested_by || null;
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  const db = getDb();
  db.prepare(
    `INSERT INTO publish_queue
      (id, task_id, topic, platforms, schedule, status, requested_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?)`,
  ).run(id, taskId, topic, JSON.stringify(platforms), schedule, requestedBy, now, now);

  const row = db.prepare('SELECT * FROM publish_queue WHERE id = ?').get(id) as Record<string, unknown>;
  const item = rowToItem(row);

  broadcast({ type: 'publish_queued', payload: item });

  return NextResponse.json({ publish: item }, { status: 201 });
}

/**
 * GET /api/skill-35/publish
 *
 * List queued publish intents. Optional filters:
 *   - ?task_id=<id>
 *   - ?status=queued|running|done|failed|cancelled
 *   - ?limit=<n>   (default 50, max 200)
 */
export async function GET(request: NextRequest) {
  const db = getDb();
  const { searchParams } = new URL(request.url);
  const taskId = searchParams.get('task_id');
  const status = searchParams.get('status');
  let limit = Number.parseInt(searchParams.get('limit') || '50', 10);
  if (!Number.isFinite(limit) || limit <= 0) limit = 50;
  if (limit > 200) limit = 200;

  const clauses: string[] = [];
  const params: unknown[] = [];
  if (taskId) {
    clauses.push('task_id = ?');
    params.push(taskId);
  }
  if (status) {
    clauses.push('status = ?');
    params.push(status);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = db
    .prepare(`SELECT * FROM publish_queue ${where} ORDER BY created_at DESC LIMIT ?`)
    .all(...params, limit) as Record<string, unknown>[];

  return NextResponse.json({ publishes: rows.map(rowToItem) });
}
