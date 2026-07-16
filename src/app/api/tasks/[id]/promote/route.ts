/**
 * POST /api/tasks/[id]/promote — U38 (C-07, master spec v2
 * `skill6-blended-persona-kanban-MASTER-SPEC-v2-2026-07-13.md` §C+I.2) S3
 * closure: the ONE human-promote control for a review card the QC heuristic
 * fallback parked (no LLM/judge key configured — see `src/lib/qc-promote.ts`
 * and `qc-scorer.ts:4104-4186`).
 *
 * Before this route, a task the QC scorer parked with `[QC-HEURISTIC]` /
 * `[QC-HEURISTIC-FINAL]` had NO way to reach `done` short of hand-editing the
 * database — the operator PATCH review→done path exists
 * (`api/tasks/[id]/route.ts`) but requires either `updated_by_agent_id` set to
 * a department QC agent/master (an agent-approval flow, not a human one) or a
 * verified `Cf-Access-Authenticated-User-Email` header AND does its DB write
 * as a raw `UPDATE ... WHERE id = ?` with no compare-and-swap guard on the
 * observed status — a genuinely different, non-CAS code path (targeted grep,
 * `app/api/tasks/[id]/route.ts:640`). This route is the dedicated,
 * purpose-built promote control the spec calls for: it (1) is scoped ONLY to
 * cards the QC heuristic fallback actually parked (checked server-side, not
 * just at the button's render gate — see the two 403s below), (2) writes
 * through the shared `transition()` state machine
 * (`src/lib/task-lifecycle.ts:384+`) with `expectedFrom:'review'`, so a
 * concurrent status change surfaces `CAS_CONFLICT` instead of a silent
 * overwrite, and (3) stamps the literal `actor:'operator'` on the resulting
 * `task_events` row, so every row this route ever produces is unambiguously a
 * human promote (never conflated with the QC auto-scorer's own
 * `actor:'qc-auto-scorer'` review→done writes).
 *
 * `transition(...,'done',...)` fires `notifyOwnerDone` internally
 * (`task-lifecycle.ts:490-492`) — this route does not call it a second time.
 *
 * SCOPE — deliberately NOT gated behind a verified Cloudflare Access identity
 * (unlike the PATCH review→done path's INGEST-11 guard): this route sits
 * behind the SAME app-wide Cloudflare Access edge (`src/middleware.ts`) every
 * other same-origin task-action route relies on (archive, dispatch,
 * return-to-orchestrator carry no additional per-route auth either); when a
 * verified operator identity IS present it is folded into the audit `reason`
 * text for a richer trail, but its absence never blocks the promote — the
 * card-scope check (heuristic-parked + status='review') is the route's real
 * gate, re-verified here independently of the button's own render gate so a
 * forged POST at an out-of-scope card is refused identically.
 */
import { NextRequest, NextResponse } from 'next/server';
import { queryOne } from '@/lib/db';
import type { Task } from '@/lib/types';
import { transition, TransitionError } from '@/lib/task-lifecycle';
import { getQcHeuristicPark } from '@/lib/qc-promote';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;

    const existing = queryOne<Task>('SELECT * FROM tasks WHERE id = ?', [id]);
    if (!existing) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }

    // ── Route guard (server-side, independent of the button's own render
    // gate) — this route only EVER promotes a review card the QC heuristic
    // fallback actually parked. A forged POST at a normal in-progress card,
    // a Blocked card, or an LLM-scored review card (latest qc_review event is
    // [QC-AUTO] / [QC-DEFERRED-PROVIDER-DOWN], not a heuristic marker) is
    // refused here exactly as the button never renders for it. ──
    if (existing.status !== 'review') {
      return NextResponse.json(
        {
          error: `Forbidden: task is '${existing.status}', not 'review'. Only a parked review card can be promoted this way.`,
        },
        { status: 403 },
      );
    }
    const park = getQcHeuristicPark(id);
    if (!park) {
      return NextResponse.json(
        {
          error:
            "Forbidden: this task's latest QC review is not a heuristic-parked state " +
            '([QC-HEURISTIC] / [QC-HEURISTIC-FINAL]). Only a card the QC heuristic ' +
            'fallback parked for human review (no LLM/judge key configured) may be ' +
            'promoted this way. An LLM-scored review card is decided only by the ' +
            'independent QC auto-scorer or PATCH /api/tasks/{id}.',
        },
        { status: 403 },
      );
    }

    // Verified operator identity (INGEST-11 boundary), when present, is folded
    // into the audit reason text only — it is never a hard requirement here
    // (see file header SCOPE note). middleware.ts strips any inbound copy of
    // this header from external callers, so a same-origin request through
    // Cloudflare Access is the only way a genuine value arrives.
    const cfAccessEmail =
      request.headers.get('cf-access-authenticated-user-email')?.trim() || null;

    // ── Persist via the shared lifecycle state machine ─────────────────────
    // CAS-guarded on expectedFrom:'review': a concurrent writer that already
    // moved the task out of review in the read→click window surfaces
    // CAS_CONFLICT (409) instead of a silent overwrite. operatorOverride:true
    // skips only the AGENT-ASSIGNMENT preconditions checkPreconditions()
    // enforces for other target statuses (irrelevant to review->done, which
    // has no blocking precondition of its own — task-lifecycle.ts:279-283);
    // the ILLEGAL_TRANSITION guard runs BEFORE checkPreconditions() and is
    // fully enforced regardless. actor:'operator' is the ONE literal audit
    // value this route ever writes to task_events, exactly per spec.
    try {
      const updated = await transition(id, 'done', {
        actor: 'operator',
        reason: cfAccessEmail
          ? `[U38 promote] heuristic-parked review card (${park.marker}) promoted by verified operator ${cfAccessEmail}`
          : `[U38 promote] heuristic-parked review card (${park.marker}) promoted by operator`,
        operatorOverride: true,
        expectedFrom: 'review',
      });
      return NextResponse.json(updated, { status: 200 });
    } catch (err) {
      if (err instanceof TransitionError) {
        if (err.code === 'CAS_CONFLICT') {
          return NextResponse.json(
            {
              error: err.message,
              code: 'CAS_CONFLICT',
              hint: 'Someone else already moved this task. Reload the card and try again.',
            },
            { status: 409 },
          );
        }
        if (err.code === 'NOT_FOUND') {
          return NextResponse.json({ error: 'Task not found' }, { status: 404 });
        }
        return NextResponse.json({ error: err.message, code: err.code }, { status: 422 });
      }
      throw err; // unknown error -> outer catch -> 500
    }
  } catch (error) {
    console.error('[tasks promote] Failed to promote task:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

/**
 * GET /api/tasks/[id]/promote — describe the endpoint (no data), matching the
 * self-describing GET on the sibling status/ingest routes.
 */
export async function GET() {
  return NextResponse.json({
    endpoint: '/api/tasks/[id]/promote',
    method: 'POST',
    scope:
      'U38 (C-07) — promotes a review card the QC heuristic fallback parked ' +
      '(latest qc_review event is [QC-HEURISTIC] or [QC-HEURISTIC-FINAL], i.e. the ' +
      'box has no LLM/judge key configured) straight to done via the shared ' +
      "transition() state machine, actor:'operator'. Refuses (403) any task that " +
      "isn't currently 'review', and any review card whose latest qc_review event " +
      "is NOT a heuristic marker (an LLM-scored card stays owned by the QC " +
      'auto-scorer / PATCH /api/tasks/{id}). Refuses (409 CAS_CONFLICT) if the task ' +
      'moved out of review between the button rendering and the click.',
    returns:
      '200 with the updated task JSON; 403 out-of-scope card, 404 unknown id, ' +
      '409 CAS conflict, 422 other transition error, 500 error',
  });
}
