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
 *   FAIL-CLOSED PARITY (P2-3 fix): this route is listed in
 *   WEBHOOK_SECRET_ROUTES (src/middleware.ts) alongside /api/tasks/ingest, so
 *   the middleware itself 503s external callers when WEBHOOK_SECRET is unset
 *   instead of relying solely on this route's own HMAC check.
 *
 * SCOPE (P2-3 fix) — this endpoint performs a focused status transition
 * (+ optional note), writes the same audit rows the operator UI's PATCH
 * /api/tasks/[id] writes (a task_status_changed / task_completed event and a
 * task_history row), and broadcasts task_updated so the board card moves
 * live. It intentionally does NOT run the interactive Triad / QC /
 * blocked-authority gates that the human PATCH path enforces: the Skill-6
 * producer only advances its own funnel / website cards, and those gates
 * remain authoritative on the operator PATCH path and the independent QC
 * auto-scorer. Two hard boundaries keep that scope real instead of aspirational:
 *
 *   1. Forbidden statuses — 'done' is rejected with 403 regardless of auth
 *      and regardless of card scope (see FORBIDDEN_STATUSES below), checked
 *      before the DB is even touched. 'done' is decided only by the
 *      independent QC auto-scorer (runQCOnReview) or a separate department
 *      QC Specialist / master agent — a builder may never self-grade its own
 *      card. This route's schema carries none of that required
 *      human-context metadata, so it never sets 'done'.
 *
 *      'blocked' is NOT in FORBIDDEN_STATUSES: the sanctioned onboarding
 *      producer (06-ghl-install-pages/tools/cc_board.py,
 *      BuildPhaseDriver.fail(human_required=True) /
 *      update_status_for_state('FAILED')) legitimately moves ITS OWN cards
 *      to 'blocked' to escalate a build failure for human sign-off —
 *      'blocked' here means escalating TO a human, not bypassing one. It is
 *      gated instead by the card-scope check below (#2): allowed only when
 *      the target card carries the Skill-6 source marker, exactly like every
 *      other status this route sets. An unmarked card still gets the
 *      existing non-Skill-6 403 for 'blocked', the same as any other status.
 *
 *   2. Card scope — the route only acts on tasks that carry the Skill-6
 *      producer's marker (see SKILL6_SOURCE_MARKER below). There is no
 *      dedicated `source` column on `tasks`; /api/tasks/ingest folds
 *      provenance into the description as a "Source: <value>" line inside a
 *      "— Captured via task-ingest —" block. cc_board.py's ingest_task()
 *      (06-ghl-install-pages/tools/cc_board.py) is the Skill-6 producer and
 *      is the only caller that stamps source to 'funnel' | 'survey' |
 *      'web-development' (its job_type → source mapping). A task missing
 *      that marker (i.e. not created by the Skill-6 board hookup) is
 *      rejected with 403 — a signed caller can only move Skill-6's own
 *      cards, not an arbitrary task on the board. This is the check that
 *      gates 'blocked': it runs after the 'done'-always-403 check but before
 *      any status transition is persisted, so a marked card may be set to
 *      'blocked' (human escalation) while an unmarked card may not.
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
 * Statuses this route refuses to set, regardless of auth and regardless of
 * card scope (P2-3 follow-up). 'done' is human/authority-gated on PATCH
 * /api/tasks/[id] — see the SCOPE section of the file header comment for the
 * full rationale. 'blocked' is deliberately NOT here: it is instead gated by
 * the Skill-6 card-scope check (hasSkill6Marker), same as every other status
 * this route sets — see point 1/2 of the SCOPE section above.
 */
const FORBIDDEN_STATUSES = new Set<z.infer<typeof StatusValue>>(['done']);

function forbiddenStatusHint(): string {
  return (
    'review → done is decided only by the independent QC auto-scorer ' +
    '(runQCOnReview) or a separate department QC Specialist / master agent — ' +
    'a builder can never self-grade its own card. PATCH /api/tasks/{id} with ' +
    'status=review and let the QC sweep promote it, or have a QC ' +
    'Specialist / master agent approve it via PATCH /api/tasks/{id}.'
  );
}

/**
 * SCOPE marker (P2-3 fix) — matches the "Source: <value>" provenance line
 * /api/tasks/ingest writes into the task description for a Skill-6 card
 * (see the SCOPE section of the file header comment). Multiline so it
 * matches regardless of where the "— Captured via task-ingest —" block ends
 * up after later note-appends (this route and others append below it).
 */
const SKILL6_SOURCE_MARKER = /^Source:\s*(?:funnel|survey|web-development)\s*$/m;

function hasSkill6Marker(description: string | null | undefined): boolean {
  return typeof description === 'string' && SKILL6_SOURCE_MARKER.test(description);
}

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

    // ── Forbidden statuses (P2-3 fix) — 'done' is rejected before touching
    // the DB, regardless of card scope. 'blocked' is intentionally NOT here
    // — see the card-scope check below, which gates it instead. ──
    if (FORBIDDEN_STATUSES.has(status)) {
      return NextResponse.json(
        {
          error: `Forbidden: this route cannot set status="${status}".`,
          hint: forbiddenStatusHint(),
        },
        { status: 403 },
      );
    }

    // ── Existence ──
    const existing = queryOne<Task>('SELECT * FROM tasks WHERE id = ?', [id]);
    if (!existing) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }

    // ── Scope (P2-3 fix; runs before any status, including 'blocked', is
    // persisted) — only act on tasks carrying the Skill-6 producer's source
    // marker; a signed caller can move Skill-6's own cards, not an arbitrary
    // task on the board. This is also what gates 'blocked': a marked card
    // may be escalated to 'blocked' (e.g. cc_board.py's
    // BuildPhaseDriver.fail(human_required=True) signaling a human is
    // needed); an unmarked card gets the same 403 as any other status. ──
    if (!hasSkill6Marker(existing.description)) {
      return NextResponse.json(
        {
          error: 'Forbidden: this task is not a Skill-6 producer card.',
          hint:
            'This route only transitions tasks created by the Skill-6 board hookup ' +
            '(cc_board.py ingest_task, source=funnel|survey|web-development). ' +
            'Use PATCH /api/tasks/{id} for other tasks.',
        },
        { status: 403 },
      );
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
      status: `one of: ${StatusValue.options.join(', ')} (required); ` +
        `'${Array.from(FORBIDDEN_STATUSES).join(`', '`)}' is always rejected — see 'scope'`,
      note: 'string (optional; appended to the task description + status-change event)',
    },
    scope:
      'Only acts on tasks carrying the Skill-6 producer source marker ' +
      '("Source: funnel|survey|web-development" in the description, written by ' +
      '/api/tasks/ingest for cc_board.py ingest_task() cards). Other tasks get 403. ' +
      "'done' is always rejected with 403 regardless of card scope — it is " +
      'authority-gated on PATCH /api/tasks/{id} (independent QC auto-scorer / ' +
      "master agent only). 'blocked' is allowed ONLY for Skill-6-marked cards " +
      '(the Skill-6 producer escalating its own build failure to a human via ' +
      "cc_board.py's BuildPhaseDriver.fail(human_required=True)) — an unmarked " +
      "card gets the same 403 as any other out-of-scope status.",
    returns:
      '200 with the updated task JSON; 400 invalid body/status, 401 auth, ' +
      '403 forbidden status or non-Skill-6 card, 404 unknown id, 500 error',
  });
}
