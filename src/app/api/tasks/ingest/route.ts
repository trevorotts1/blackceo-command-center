import { NextRequest, NextResponse } from 'next/server';
import { createHmac } from 'crypto';
import { queryOne } from '@/lib/db';
import { createTaskCore } from '@/lib/tasks';
import type { TaskPriority } from '@/lib/types';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * POST /api/tasks/ingest — Universal task-capture front door.
 *
 * The Command Center half of "anywhere the agent is told to do something, it
 * lands on the Kanban." An external caller (an OpenClaw agent via its
 * TASK-CAPTURE playbook, the Telegram bridge, a backfill script) posts a
 * friendly external shape; this endpoint resolves it onto the board through the
 * SAME canonical write path (`createTaskCore`) the operator UI uses.
 *
 * Auth: identical HMAC-SHA256 scheme to /api/webhooks/agent-completion —
 * `x-webhook-signature` = HMAC(WEBHOOK_SECRET, rawBody). When WEBHOOK_SECRET is
 * unset we run in dev mode and skip verification (matches the existing webhook).
 *
 * Agent-FK safety: `assigned_agent_id` / `created_by_agent_id` are `.uuid()` +
 * FK columns into `agents`. An external OpenClaw payload cannot carry a CC
 * agent UUID, so we NEVER pass external ids into those columns — they stay
 * NULL. Provenance (source/persona/session) is recorded in the description and
 * the `task_created` event message instead.
 *
 * Idempotency: when `idempotency_key` (or `source_ref`) is supplied we embed a
 * deterministic `[ingest:<key>]` marker in the task_created event message and
 * dedupe on it before inserting, so a Telegram retry or a backfill re-run can't
 * create duplicates. No schema column required.
 *
 * Expected payload:
 * {
 *   "title": "Follow up with the lead from this morning",   // required
 *   "description": "...",                                    // optional
 *   "priority": "low|medium|high|critical",                 // optional, default medium
 *   "source": "telegram|bridge|agent|backfill",             // optional provenance
 *   "source_ref": "telegram:msg:12345",                     // optional provenance / dedupe fallback
 *   "department_slug": "sales",                              // optional; resolves the workspace
 *   "persona": "Candace",                                    // optional; resolves the workspace by name
 *   "external_session_id": "agent:main:telegram:direct:123",// optional provenance
 *   "idempotency_key": "sha256(...)"                         // optional; primary dedupe key
 * }
 */

interface IngestPayload {
  title?: unknown;
  description?: unknown;
  priority?: unknown;
  source?: unknown;
  source_ref?: unknown;
  department_slug?: unknown;
  persona?: unknown;
  external_session_id?: unknown;
  idempotency_key?: unknown;
}

const VALID_PRIORITIES = new Set<TaskPriority>(['low', 'medium', 'high', 'critical']);

function verifyWebhookSignature(signature: string | null, rawBody: string): boolean {
  const webhookSecret = process.env.WEBHOOK_SECRET;
  if (!webhookSecret) return true; // Dev mode — skip validation.
  if (!signature) return false;
  const expected = createHmac('sha256', webhookSecret).update(rawBody).digest('hex');
  return signature === expected;
}

/**
 * Resolve the target workspace id. Tries department_slug, then persona/name,
 * then falls back to the CEO workspace — the CEO agent runs all other
 * departments, so it is the correct catch-all owner for unrouted work. Returns
 * { workspaceId, resolvedBy } so the caller can record how routing happened.
 */
function resolveWorkspaceId(
  departmentSlug: string | undefined,
  persona: string | undefined
): { workspaceId: string; resolvedBy: string } {
  // 1. department_slug → workspaces.slug (or id).
  if (departmentSlug) {
    const slug = departmentSlug.toLowerCase();
    const bySlug = queryOne<{ id: string }>(
      'SELECT id FROM workspaces WHERE lower(slug) = ? OR lower(id) = ? LIMIT 1',
      [slug, slug]
    );
    if (bySlug) return { workspaceId: bySlug.id, resolvedBy: `department_slug:${departmentSlug}` };
  }

  // 2. persona → workspaces.name (case-insensitive). Lets a caller route by the
  //    department head/persona name without knowing the slug.
  if (persona) {
    const byName = queryOne<{ id: string }>(
      'SELECT id FROM workspaces WHERE lower(name) = ? LIMIT 1',
      [persona.toLowerCase()]
    );
    if (byName) return { workspaceId: byName.id, resolvedBy: `persona:${persona}` };
  }

  // 3. CEO catch-all. Match the stable slug 'ceo'/'dept-ceo' (display name is
  //    free text — the client's main-agent persona — so we don't match name).
  const ceo = queryOne<{ id: string }>(
    "SELECT id FROM workspaces WHERE lower(slug) IN ('ceo', 'dept-ceo') OR lower(name) = 'ceo' ORDER BY sort_order ASC LIMIT 1",
    []
  );
  if (ceo) return { workspaceId: ceo.id, resolvedBy: 'ceo-fallback' };

  // 4. Last resort: the default workspace bucket (universal install with no CEO
  //    row seeded yet). createTaskCore also defaults workspace_id to 'default'.
  return { workspaceId: 'default', resolvedBy: 'default-fallback' };
}

export async function POST(request: NextRequest) {
  try {
    const rawBody = await request.text();

    // Auth — HMAC-SHA256, same scheme as /api/webhooks/agent-completion.
    if (process.env.WEBHOOK_SECRET) {
      const signature = request.headers.get('x-webhook-signature');
      if (!verifyWebhookSignature(signature, rawBody)) {
        console.warn('[INGEST] Invalid signature attempt');
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
      }
    }

    let body: IngestPayload;
    try {
      body = JSON.parse(rawBody) as IngestPayload;
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    const title = typeof body.title === 'string' ? body.title.trim() : '';
    if (!title) {
      return NextResponse.json({ error: 'title is required' }, { status: 400 });
    }
    if (title.length > 500) {
      return NextResponse.json({ error: 'title must be 500 characters or less' }, { status: 400 });
    }

    const description = typeof body.description === 'string' ? body.description : undefined;
    const source = typeof body.source === 'string' ? body.source.trim() : undefined;
    const sourceRef = typeof body.source_ref === 'string' ? body.source_ref.trim() : undefined;
    const departmentSlug =
      typeof body.department_slug === 'string' ? body.department_slug.trim() : undefined;
    const persona = typeof body.persona === 'string' ? body.persona.trim() : undefined;
    const externalSessionId =
      typeof body.external_session_id === 'string' ? body.external_session_id.trim() : undefined;
    const idempotencyKey =
      typeof body.idempotency_key === 'string' ? body.idempotency_key.trim() : undefined;

    const priorityRaw = typeof body.priority === 'string' ? body.priority.trim() : undefined;
    const priority: TaskPriority | undefined =
      priorityRaw && VALID_PRIORITIES.has(priorityRaw as TaskPriority)
        ? (priorityRaw as TaskPriority)
        : undefined;

    // Deterministic dedupe key: idempotency_key wins, else source_ref.
    const dedupeKey = idempotencyKey || sourceRef;

    // Idempotency check — embed `[ingest:<key>]` in the task_created event
    // message and match on it. A retry returns the existing task (200), never a
    // duplicate.
    if (dedupeKey) {
      const existing = queryOne<{ task_id: string }>(
        "SELECT task_id FROM events WHERE type = 'task_created' AND message LIKE ? AND task_id IS NOT NULL ORDER BY created_at ASC LIMIT 1",
        [`%[ingest:${dedupeKey}]%`]
      );
      if (existing?.task_id) {
        return NextResponse.json(
          { ok: true, deduped: true, task_id: existing.task_id },
          { status: 200 }
        );
      }
    }

    const { workspaceId, resolvedBy } = resolveWorkspaceId(departmentSlug, persona);

    // Build a provenance-rich description so the source survives even though we
    // intentionally leave the agent FK columns NULL.
    const provenanceLines: string[] = [];
    if (source) provenanceLines.push(`Source: ${source}`);
    if (persona) provenanceLines.push(`From persona: ${persona}`);
    if (externalSessionId) provenanceLines.push(`Session: ${externalSessionId}`);
    if (sourceRef) provenanceLines.push(`Ref: ${sourceRef}`);
    const provenanceBlock = provenanceLines.length
      ? `\n\n— Captured via task-ingest —\n${provenanceLines.join('\n')}`
      : '';
    const finalDescription = `${description ?? ''}${provenanceBlock}`.trim() || undefined;

    // Event message carries the human-readable provenance + the dedupe marker.
    const eventMessageParts = [`Task captured via ${source || 'ingest'}: ${title}`];
    if (dedupeKey) eventMessageParts.push(`[ingest:${dedupeKey}]`);
    const eventMessage = eventMessageParts.join(' ');

    const task = await createTaskCore(
      {
        title,
        description: finalDescription,
        status: 'backlog',
        priority,
        // Agent FKs intentionally NULL — external ids are not CC agent UUIDs.
        assigned_agent_id: null,
        created_by_agent_id: null,
        workspace_id: workspaceId,
        department: departmentSlug ?? null,
        eventMessage,
      },
      { origin: request.headers.get('origin') }
    );

    if (!task) {
      return NextResponse.json({ error: 'Failed to create task' }, { status: 500 });
    }

    return NextResponse.json(
      {
        ok: true,
        deduped: false,
        task_id: task.id,
        workspace_id: workspaceId,
        resolved_by: resolvedBy,
        status: task.status,
      },
      { status: 201 }
    );
  } catch (error) {
    console.error('[INGEST] Failed to ingest task:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

/**
 * GET /api/tasks/ingest — describe the endpoint (no data, universal).
 */
export async function GET() {
  return NextResponse.json({
    endpoint: '/api/tasks/ingest',
    method: 'POST',
    auth: 'x-webhook-signature: HMAC-SHA256(WEBHOOK_SECRET, rawBody) — skipped when WEBHOOK_SECRET unset',
    accepts: {
      title: 'string (required)',
      description: 'string (optional)',
      priority: 'low|medium|high|critical (optional, default medium)',
      source: 'string (optional provenance)',
      source_ref: 'string (optional provenance / dedupe fallback)',
      department_slug: 'string (optional; resolves workspace, default CEO)',
      persona: 'string (optional; resolves workspace by name)',
      external_session_id: 'string (optional provenance)',
      idempotency_key: 'string (optional; primary dedupe key)',
    },
  });
}
