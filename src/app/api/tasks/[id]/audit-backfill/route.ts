/**
 * POST /api/tasks/[id]/audit-backfill — FIX 35 audit backfill (spec REV 3, Phase D).
 *
 * The ONE sanctioned way to append a missing `to-done` audit event to a task
 * that is ALREADY done. Backfills the exact task_events row transition()
 * writes — via recordStatusEvent (DISP-10 / DATA-07), the sanctioned sink for
 * status events that cannot route through transition() itself — without
 * touching tasks.status (the row is already done; a no-op status PATCH writes
 * NO event, so this surface must exist).
 *
 * WHY A DEDICATED ROUTE (not PATCH /api/tasks/[id]):
 *   - PATCH only writes task_events when status ACTUALLY changes (route.ts
 *     `status !== existing.status` guard); on an already-done row it is a
 *     silent no-op.
 *   - /api/tasks/[id]/status hard-blocks 'done' (FORBIDDEN_STATUSES), and
 *     transition() is idempotent (no event) when already at target.
 *   - Writing task_events directly from a hygiene script would bypass the
 *     sanctioned sink and the API trust boundary entirely.
 *
 * FAIL-CLOSED GATES (all must pass, in order):
 *   1. Bearer MC_API_TOKEN — this route is NOT on the same-origin passthrough
 *      list and NOT a webhook-secret route, so the middleware's external /api/*
 *      bearer gate (Gate B) already applies. This route-level check mirrors
 *      the per-task status consumer so a direct route hit is still gated even
 *      if middleware wiring changes.
 *   2. HMAC-SHA256 x-webhook-signature over the RAW body bytes (only when
 *      WEBHOOK_SECRET is configured — same layered contract as the status
 *      consumer and move-task.py's producer side).
 *   3. Target task must EXIST and already be status 'done' — a backfill is a
 *      historical record of a completed run, never a status change. Any other
 *      current status is rejected 409.
 *   4. The task must have NO existing to-done task_events row — idempotency by
 *      refusal: a second backfill for the same task is rejected 409, so the
 *      audit trail can never be double-written.
 *   5. Request body MUST carry the operator's explicit acknowledgement:
 *      { "confirmation": "I-UNDERSTAND-THIS-PURGES-LIVE-BOARD-ROWS" } — the
 *      same literal the FIX 35 hygiene script's
 *      PRESENTATION_CONFIRM_DESTRUCTIVE env gate enforces. A backfill is
 *      destructive-adjacent (it rewrites the audit trail), so it rides the
 *      same destructive-confirmation discipline. Rejected 403 without it.
 *
 * The write itself is INSERT-ONLY into task_events (never UPDATE, never
 * DELETE), actor 'fix35-hygiene', reason recording the provenance verdict.
 */

import { NextRequest, NextResponse } from 'next/server';
import { createHmac, timingSafeEqual } from 'crypto';
import { queryOne, run } from '@/lib/db';
import { recordStatusEvent } from '@/lib/task-lifecycle';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// The literal destructive-confirmation string — shared with the FIX 35 hygiene
// script's PRESENTATION_CONFIRM_DESTRUCTIVE gate.
const CONFIRM_VALUE = 'I-UNDERSTAND-THIS-PURGES-LIVE-BOARD-ROWS';

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

type AuthResult = { ok: true } | { ok: false; status: number; error: string };

/** Two-layer auth over the raw body — mirrors the Skill-6 status consumer. */
function authenticate(request: NextRequest, rawBody: string): AuthResult {
  const token = process.env.MC_API_TOKEN;
  const secret = process.env.WEBHOOK_SECRET;

  if (token) {
    const authHeader = request.headers.get('authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return { ok: false, status: 401, error: 'Unauthorized' };
    }
    if (!safeEqual(authHeader.slice(7), token)) {
      return { ok: false, status: 401, error: 'Unauthorized' };
    }
  }

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

    const auth = authenticate(request, rawBody);
    if (!auth.ok) {
      return NextResponse.json({ error: auth.error }, { status: auth.status });
    }

    let payload: { confirmation?: string; provenance?: string };
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    // Destructive-confirmation gate (FIX 35 hard rule): the body must carry the
    // literal confirmation string, matching the hygiene script's env gate.
    if (payload.confirmation !== CONFIRM_VALUE) {
      return NextResponse.json(
        {
          error: 'Refused: audit backfill requires the literal destructive confirmation.',
          hint: `Body must carry {"confirmation":"${CONFIRM_VALUE}"}.`,
        },
        { status: 403 },
      );
    }

    const existing = queryOne<{ id: string; status: string }>(
      'SELECT id, status FROM tasks WHERE id = ?',
      [id],
    );
    if (!existing) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }
    if (existing.status !== 'done') {
      return NextResponse.json(
        {
          error: `Task status is '${existing.status}', not 'done'.`,
          hint: 'audit-backfill is a historical record for ALREADY-done rows only — it never changes tasks.status.',
        },
        { status: 409 },
      );
    }

    // Idempotency by refusal: exactly one to-done event per task, ever.
    const already = queryOne<{ n: number }>(
      "SELECT COUNT(*) AS n FROM task_events WHERE task_id = ? AND to_status = 'done'",
      [id],
    );
    if (already && already.n > 0) {
      return NextResponse.json(
        { error: 'A to-done audit event already exists for this task.' },
        { status: 409 },
      );
    }

    const provenance =
      typeof payload.provenance === 'string' && payload.provenance.trim()
        ? payload.provenance.trim().slice(0, 500)
        : 'provenance verified by FIX 35 hygiene run';

    recordStatusEvent(id, 'done', 'done', {
      actor: 'fix35-hygiene',
      reason: `FIX 35 backfill (no-op status row, audit-only): ${provenance}`,
    });

    const event = queryOne<{ id: string; created_at: string }>(
      "SELECT id, created_at FROM task_events WHERE task_id = ? AND to_status = 'done' " +
        'ORDER BY created_at DESC LIMIT 1',
      [id],
    );

    return NextResponse.json({
      ok: true,
      id,
      event_id: event?.id ?? null,
      recorded_at: event?.created_at ?? null,
      note: 'to-done audit event backfilled via recordStatusEvent (INSERT-only; tasks.status untouched).',
    });
  } catch (error) {
    console.error('[audit-backfill] failed:', error);
    return NextResponse.json({ error: 'Failed to backfill audit event' }, { status: 500 });
  }
}