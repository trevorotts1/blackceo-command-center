import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { broadcast } from '@/lib/events';
import type { PublishQueueItem } from '@/lib/types';
import {
  resolvePublishCompany,
  assertTaskOwnedByCompany,
  assertPlannerSheetOwnedByCompany,
} from '@/lib/social/company-context';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

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
  /** Registered planner spreadsheet this intent writes to (sheet_registry contract). */
  sheet_id?: string;
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
    company_id: row.company_id ? String(row.company_id) : 'default',
    sheet_id: row.sheet_id ? String(row.sheet_id) : null,
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
 *     sheet_id?: string,        // optional registered planner spreadsheet
 *   }
 *
 * F01 company binding: the caller's company identity is resolved from the
 * authenticated request context (bearer MC_API_TOKEN / signed tenant session
 * / CF Access JWT) and every referenced resource is verified to belong to
 * that company BEFORE anything is enqueued:
 *   - task_id, when provided, must resolve (through its workspace) to this
 *     company; a foreign/absent task_id answers 404 with zero writes,
 *   - sheet_id, when provided, must be registered in this company's
 *     social_sheet_registry; a foreign/unregistered sheet_id answers 404 with
 *     zero writes, and the enforced sheet_id is persisted on the queue row,
 *   - the queue row is stamped company_id and every read is company-scoped.
 * A substituted B-company task or sheet identifier answers 404 with zero B
 * writes. Tasks resolving to the 'default' company are not ownable by a
 * verified non-default company (F01-D2).
 */
export async function POST(request: NextRequest) {
  const identity = await resolvePublishCompany(request);
  if (!identity.ok) {
    return NextResponse.json({ error: identity.error }, { status: identity.status });
  }
  const { companyId } = identity.company;

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

  // F01 — task ownership: a task_id that is foreign or absent is rejected
  // with 404 (indistinguishable, so existence is not an oracle) and nothing
  // is written.
  const taskId = body.task_id || null;
  const taskOwnership = assertTaskOwnedByCompany(taskId, companyId);
  if (!taskOwnership.owned) {
    return NextResponse.json({ error: 'task not found' }, { status: 404 });
  }

  // F01-D1 — sheet registration is ENFORCED: a sheet_id provided but not
  // registered to THIS company answers 404 with zero writes (indistinguishable
  // from a foreign task, so existence is not an oracle). Resolved from the
  // company registry, not caller trust; the enforced sheet_id is persisted on
  // the queue row so downstream resolves it from the registry.
  const sheetId = body.sheet_id || null;
  const sheetOwnership = assertPlannerSheetOwnedByCompany(sheetId, companyId);
  if (sheetId && !sheetOwnership.sheet) {
    return NextResponse.json({ error: 'sheet not found' }, { status: 404 });
  }

  const schedule = (body.schedule || 'auto').trim() || 'auto';
  const requestedBy = body.requested_by || null;
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  const db = getDb();
  db.prepare(
    `INSERT INTO publish_queue
      (id, task_id, company_id, sheet_id, topic, platforms, schedule, status, requested_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?)`,
  ).run(id, taskId, companyId, sheetId, topic, JSON.stringify(platforms), schedule, requestedBy, now, now);

  const row = db.prepare('SELECT * FROM publish_queue WHERE id = ? AND company_id = ?')
    .get(id, companyId) as Record<string, unknown>;
  const item = rowToItem(row);

  // F01-D3 — per-company event scope: the tenant id rides on the event TYPE
  // (publish_queued:<company_id>) so a client that only subscribes to its own
  // company's type never sees another tenant's queue payloads. The shared SSE
  // fan-out (src/lib/events.ts broadcast + the events stream route) is owned
  // outside WF01 and is deliberately untouched; filtering happens by
  // subscription, not by touching shared infra. Payload keeps company_id for
  // belt-and-braces client-side checks.
  broadcast({ type: `publish_queued:${companyId}`, payload: item });

  return NextResponse.json({
    publish: item,
    sheet: sheetOwnership.sheet
      ? { sheet_id: sheetOwnership.sheet.sheet_id, sharing: sheetOwnership.sheet.sharing }
      : null,
  }, { status: 201 });
}

/**
 * GET /api/skill-35/publish
 *
 * List queued publish intents FOR THE CALLER'S COMPANY (F01 — the list route
 * is company-scoped; rows enqueued before migration 135 carry 'default').
 * Optional filters:
 *   - ?task_id=<id>   (must also be owned by this company)
 *   - ?status=queued|running|done|failed|cancelled
 *   - ?limit=<n>   (default 50, max 200)
 */
export async function GET(request: NextRequest) {
  const identity = await resolvePublishCompany(request);
  if (!identity.ok) {
    return NextResponse.json({ error: identity.error }, { status: identity.status });
  }
  const { companyId } = identity.company;

  const db = getDb();
  const { searchParams } = new URL(request.url);
  const taskId = searchParams.get('task_id');
  const status = searchParams.get('status');
  let limit = Number.parseInt(searchParams.get('limit') || '50', 10);
  if (!Number.isFinite(limit) || limit <= 0) limit = 50;
  if (limit > 200) limit = 200;

  // F01 — a substituted foreign task_id answers 404 before any row leaks.
  if (taskId) {
    const taskOwnership = assertTaskOwnedByCompany(taskId, companyId);
    if (!taskOwnership.owned) {
      return NextResponse.json({ error: 'task not found' }, { status: 404 });
    }
  }

  const clauses: string[] = ['company_id = ?'];
  const params: unknown[] = [companyId];
  if (taskId) {
    clauses.push('task_id = ?');
    params.push(taskId);
  }
  if (status) {
    clauses.push('status = ?');
    params.push(status);
  }
  const where = `WHERE ${clauses.join(' AND ')}`;
  const rows = db
    .prepare(`SELECT * FROM publish_queue ${where} ORDER BY created_at DESC LIMIT ?`)
    .all(...params, limit) as Record<string, unknown>[];

  return NextResponse.json({ publishes: rows.map(rowToItem) });
}