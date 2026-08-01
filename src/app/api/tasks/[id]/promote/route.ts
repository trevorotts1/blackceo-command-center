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
 * SCOPE — gated behind a verified Cloudflare Access identity (U032, audit
 * E2b). This route writes the TERMINAL status with operatorOverride:true, so
 * unlike archive/dispatch/return-to-orchestrator it is NOT merely a same-origin
 * task action — it is the last word on a card. Three gates run in order, all
 * server-side and all independent of the button's render gate:
 *   1. status === 'review'                        → else 403
 *   2. the latest qc_review event is a parked marker (getQcHeuristicPark)
 *                                                  → else 403
 *   3. a verified Cf-Access-Authenticated-User-Email is present
 *                                                  → else 403
 * Gate 3 is new. Before it, the identity was read and folded into the audit
 * `reason` text but never checked, so a forged same-origin POST (the
 * Origin/Referer residual in src/middleware.ts) reached `done` with no token,
 * no cf-access header, and — before U031 — no process certificate. The
 * card-scope checks (1 and 2) bound the blast radius to already-parked review
 * cards; they do not authenticate the mover.
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
    // gate) — this route only EVER promotes a review card QC actually parked
    // for a human: a heuristic (no-key) park, or a judge escalated as
    // FAILING ([QC-JUDGE-FAILED-FINAL]). A forged POST at a
    // normal in-progress card, a Blocked card, or an LLM-scored review card
    // (latest qc_review event is [QC-AUTO], or a still-retrying
    // [QC-DEFERRED-PROVIDER-DOWN]) is refused here exactly as the button never
    // renders for it. NOTE the escalated-judge case is deliberately promotable:
    // telling a human "your judge is failing and this task is stuck" while
    // refusing to let them unstick it would just be a politer six-day park. ──
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
            '([QC-HEURISTIC] / [QC-HEURISTIC-FINAL] / [QC-JUDGE-FAILED-FINAL]). ' +
            'Only a card the QC heuristic fallback parked for human review — no LLM/judge ' +
            'key configured, or a judge escalated as failing — may be promoted this ' +
            'way. An LLM-scored card, or one still auto-retrying a provider blip, is ' +
            'decided only by the independent QC auto-scorer or PATCH /api/tasks/{id}.',
        },
        { status: 403 },
      );
    }

    // ── IDENTITY GATE (U032 / audit E2b) ─────────────────────────────────────
    // This route reaches the TERMINAL status with operatorOverride:true. Before
    // U032 the verified identity was read and used only to choose a log string,
    // so a request with no identity promoted a card exactly as well as one with
    // an identity — and composed with the same-origin passthrough
    // (src/middleware.ts, the Origin/Referer residual) that made 'done'
    // reachable with no token and no cf-access header at all. A promote is a
    // TERMINAL, owner-visible decision: it must name a human.
    //
    // middleware.ts STRIPS any inbound copy of this header from external callers,
    // so a non-empty value here can only have come from the Cloudflare Access
    // edge on a same-origin request. Absence is therefore a real refusal, not a
    // configuration nuisance.
    const cfAccessEmail =
      request.headers.get('cf-access-authenticated-user-email')?.trim() || null;
    if (!cfAccessEmail) {
      // Rule 3.5 staging — the target box may not be fronted by Cloudflare
      // Access, and shipping a hard gate would lock a real operator out of a
      // real stuck card. This escape hatch is logged loudly on every use so an
      // auditor cannot mistake it for a permanent bypass. Remove it once the
      // box is confirmed behind Cloudflare Access.
      if (process.env.CC_PROMOTE_ALLOW_UNVERIFIED !== 'true') {
        return NextResponse.json(
          {
            error:
              'Forbidden: promoting a parked review card to done requires a verified operator identity.',
            code: 'operator_identity_required',
            hint:
              'This control writes the TERMINAL status with an operator override, so it must name a human. ' +
              'Sign in through Cloudflare Access on this subdomain (the edge sets ' +
              'Cf-Access-Authenticated-User-Email at the trust boundary), or use ' +
              'PATCH /api/tasks/{id} with updated_by_agent_id set to the department QC Specialist. ' +
              'If this box is not fronted by Cloudflare Access, that is the thing to fix — see ' +
              'REQUIRE_CF_ACCESS in src/middleware.ts.',
          },
          { status: 403 },
        );
      }
      console.warn(
        '[SECURITY] CC_PROMOTE_ALLOW_UNVERIFIED is ON — promoting a parked review card to done without a verified operator identity. ' +
          'Set this ONLY when the box is not yet behind Cloudflare Access. Remove it as soon as Cloudflare Access is active on this subdomain.',
      );
    }

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
        reason: `[U38 promote] heuristic-parked review card (${park.marker}) promoted by verified operator ${cfAccessEmail}`,
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
      'U38 (C-07) / U032 (E2b) — promotes a review card QC parked for a human (latest ' +
      'qc_review event is [QC-HEURISTIC] / [QC-HEURISTIC-FINAL], i.e. no LLM/judge ' +
      'key, or [QC-JUDGE-FAILED-FINAL]) straight to done via the shared transition() ' +
      "state machine, actor:'operator'. Three server-side gates run in order: " +
      "(1) status === 'review', (2) the latest qc_review event is a parked marker " +
      '(getQcHeuristicPark), (3) a verified Cf-Access-Authenticated-User-Email is ' +
      'present (U032 identity gate). Refuses (403) any task that fails any of the ' +
      'three. Refuses (409 CAS_CONFLICT) if the task moved out of review between the ' +
      'button rendering and the click.',
    returns:
      '200 with the updated task JSON; 403 out-of-scope card or missing operator ' +
      'identity (code operator_identity_required), 404 unknown id, ' +
      '409 CAS conflict, 422 other transition error, 500 error',
  });
}
