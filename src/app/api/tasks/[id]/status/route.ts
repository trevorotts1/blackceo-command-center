import { NextRequest, NextResponse } from 'next/server';
import { createHmac, timingSafeEqual } from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';
import { queryOne, run } from '@/lib/db';
import { broadcast } from '@/lib/events';
import type { Task } from '@/lib/types';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * POST /api/tasks/[id]/status — Skill-6 Kanban status-transition CONSUMER.
 *
 * This is the Command Center half of the Skill-6 board status hookup. The
 * PRODUCER (06-ghl-install-pages/tools/cc_board.py) posts a SIGNED transition
 * for one card:
 *
 *   POST {MISSION_CONTROL_URL}/api/tasks/{id}/status
 *     headers:
 *       Content-Type: application/json
 *       Authorization: Bearer <MC_API_TOKEN>            (sent when MC_API_TOKEN set)
 *       x-webhook-signature: <hex HMAC-SHA256>          (sent when WEBHOOK_SECRET set)
 *     body: {"status": "<TaskStatus>", "note": "<optional>"}
 *
 * AUTH — byte-for-byte parity with the producer's cc_board.py `_sign()` and the
 * sibling ingest route's `verifyWebhookSignature()`:
 *
 *   1. Bearer layer (same as src/middleware.ts external-caller gate): when
 *      MC_API_TOKEN is configured, the request MUST carry
 *      `Authorization: Bearer <MC_API_TOKEN>`. Compared in constant time.
 *   2. HMAC layer (same as /api/tasks/ingest): when WEBHOOK_SECRET is
 *      configured, `x-webhook-signature` MUST equal
 *      HMAC-SHA256(WEBHOOK_SECRET, rawBody) as a lowercase hex digest over the
 *      EXACT received bytes. Compared in constant time.
 *
 *   Either layer failing → 401. When a secret is unset (dev / same-origin) that
 *   layer is skipped, exactly as the producer only sends the header when the
 *   corresponding secret is configured, and as the sibling task routes rely on
 *   src/middleware.ts (Cloudflare Access + MC_API_TOKEN) in that case.
 *
 *   NOTE FOR THE OPERATOR: for full fail-closed parity with the ingest route,
 *   consider adding '/api/tasks/[id]/status' to WEBHOOK_SECRET_ROUTES in
 *   src/middleware.ts so the middleware 503s when WEBHOOK_SECRET is unset. This
 *   route already authenticates itself; that addition is defence-in-depth only.
 *
 * SCOPE — this endpoint performs a focused status transition (+ optional note),
 * writes the same audit rows the operator UI's PATCH /api/tasks/[id] writes (a
 * task_status_changed / task_completed event and a task_history row), and
 * broadcasts task_updated so the board card moves live. It intentionally does
 * NOT run the interactive Triad / QC / blocked-authority gates that the human
 * PATCH path enforces: the Skill-6 producer only advances its own funnel /
 * website cards, and those gates remain authoritative on the operator PATCH
 * path and the independent QC auto-scorer.
 */

// LOCKSTEP: mirrors the canonical 10-status TaskStatus union in
// src/lib/types.ts:5 (and the enforcer in src/lib/validation.ts). Keep in sync.
const StatusValue = z.enum([
  'backlog',
  'inbox',
  'planning',
  'in_progress',
  'assigned',
  'review',
  'testing',
  'blocked',
  'pending_dispatch',
  'done',
]);

const StatusTransitionSchema = z.object({
  status: StatusValue,
  note: z.string().max(5000).optional().nullable(),
});

/**
 * Constant-time string comparison. Returns false (without leaking timing beyond
 * length) when the lengths differ, since timingSafeEqual throws on unequal
 * buffer lengths.
 */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

type AuthResult = { ok: true } | { ok: false; status: number; error: string };

/**
 * Verify the two-layer auth against the raw request body. Each layer is only
 * enforced when its secret is configured — matching the producer, which only
 * sends the corresponding header when the secret is present.
 */
function authenticate(request: NextRequest, rawBody: string): AuthResult {
  const token = process.env.MC_API_TOKEN;
  const secret = process.env.WEBHOOK_SECRET;

  // Layer 1 — Bearer MC_API_TOKEN.
  if (token) {
    const authHeader = request.headers.get('authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return { ok: false, status: 401, error: 'Unauthorized' };
    }
    const presented = authHeader.slice(7);
    if (!safeEqual(presented, token)) {
      return { ok: false, status: 401, error: 'Unauthorized' };
    }
  }

  // Layer 2 — HMAC-SHA256 signature over the raw body (hex), keyed by WEBHOOK_SECRET.
  if (secret) {
    const signature = request.headers.get('x-webhook-signature');
    if (!signature) {
      return { ok: false, status: 401, error: 'Unauthorized: missing signature' };
    }
    const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
    if (!safeEqual(signature, expected)) {
      return { ok: false, status: 401, error: 'Unauthorized: invalid signature' };
    }
  }

  return { ok: true };
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;

    // Read the raw body ONCE — the HMAC must be computed over these exact bytes.
    const rawBody = await request.text();

    // ── Auth: Bearer MC_API_TOKEN + HMAC-SHA256 signature (both constant-time) ──
    const auth = authenticate(request, rawBody);
    if (!auth.ok) {
      return NextResponse.json({ error: auth.error }, { status: auth.status });
    }

    // ── Parse + validate the transition payload ──
    let payload: unknown;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    const validation = StatusTransitionSchema.safeParse(payload);
    if (!validation.success) {
      return NextResponse.json(
        {
          error: 'Validation failed',
          details: validation.error.issues,
          hint: `status must be one of: ${StatusValue.options.join(', ')}. Optional: note (string).`,
        },
        { status: 400 },
      );
    }
    const { status, note } = validation.data;

    // ── Existence ──
    const existing = queryOne<Task>('SELECT * FROM tasks WHERE id = ?', [id]);
    if (!existing) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }

    const now = new Date().toISOString();
    const trimmedNote = typeof note === 'string' && note.trim() ? note.trim() : null;

    // Append the note (when provided) to the description as a timestamped audit
    // line — mirrors the description-append convention in return-to-orchestrator.
    let nextDescription = existing.description ?? null;
    if (trimmedNote) {
      const noteLine = `[status → ${status} @ ${now}] ${trimmedNote}`;
      nextDescription = existing.description ? `${existing.description}\n\n${noteLine}` : noteLine;
    }

    // ── Persist the transition ──
    const statusChanged = status !== existing.status;
    const updates: string[] = ['status = ?', 'updated_at = ?', 'last_progress_at = ?'];
    const values: unknown[] = [status, now, now];
    if (trimmedNote) {
      updates.push('description = ?');
      values.push(nextDescription);
    }
    values.push(id);
    run(`UPDATE tasks SET ${updates.join(', ')} WHERE id = ?`, values);

    // ── Audit trail: status-change event + task_history (parity with PATCH) ──
    if (statusChanged) {
      const eventType = status === 'done' ? 'task_completed' : 'task_status_changed';
      const eventMessage = trimmedNote
        ? `Task "${existing.title}" moved to ${status}: ${trimmedNote}`
        : `Task "${existing.title}" moved to ${status}`;
      run(
        `INSERT INTO events (id, type, task_id, message, created_at)
         VALUES (?, ?, ?, ?, ?)`,
        [uuidv4(), eventType, id, eventMessage, now],
      );

      // task_history feeds /api/performance duration + attribution. Best-effort:
      // older DBs without the table (pre-migration 027) simply skip this row.
      try {
        run(
          `INSERT INTO task_history (id, task_id, status_from, status_to, changed_at, changed_by_agent_id, agent_name)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [uuidv4(), id, existing.status, status, now, existing.assigned_agent_id ?? null, null],
        );
      } catch (err) {
        console.warn('[tasks status] task_history append skipped:', (err as Error).message);
      }
    }

    // ── Return the updated, joined task (parity with PATCH /api/tasks/[id]) ──
    const task = queryOne<Task>(
      `SELECT t.*,
        aa.name as assigned_agent_name,
        aa.avatar_emoji as assigned_agent_emoji,
        ca.name as created_by_agent_name,
        ca.avatar_emoji as created_by_agent_emoji
       FROM tasks t
       LEFT JOIN agents aa ON t.assigned_agent_id = aa.id
       LEFT JOIN agents ca ON t.created_by_agent_id = ca.id
       WHERE t.id = ?`,
      [id],
    );

    if (task) {
      broadcast({ type: 'task_updated', payload: task });
    }

    return NextResponse.json(task, { status: 200 });
  } catch (error) {
    console.error('[tasks status] Failed to update task status:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

/**
 * GET /api/tasks/[id]/status — describe the endpoint (no data), matching the
 * self-describing GET on /api/tasks/ingest.
 */
export async function GET() {
  return NextResponse.json({
    endpoint: '/api/tasks/[id]/status',
    method: 'POST',
    auth:
      'Authorization: Bearer <MC_API_TOKEN> (when set) AND ' +
      'x-webhook-signature: HMAC-SHA256(WEBHOOK_SECRET, rawBody) hex (when set). ' +
      'Either failing → 401.',
    accepts: {
      status: `one of: ${StatusValue.options.join(', ')} (required)`,
      note: 'string (optional; appended to the task description + status-change event)',
    },
    returns: '200 with the updated task JSON; 400 invalid body/status, 401 auth, 404 unknown id, 500 error',
  });
}
