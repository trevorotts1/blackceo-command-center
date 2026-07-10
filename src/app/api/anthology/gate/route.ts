import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import {
  boardStatus,
  decideBoard,
  type BoardDecideFields,
} from '@/app/participant/_lib/gate-engine';
import { isFinalizeAction } from '@/components/anthology/finalize-action';

/**
 * POST /api/anthology/gate  — the producer/assembly BOARD DOOR (SPEC B10 / Gap G8).
 * GET  /api/anthology/gate?subjectKey=<k> — the open gate + its action set (read-only).
 *
 * THE BOTH-DOOR RULE (SPEC 11.3, §5): the participant token page and this route
 * are TWO DOORS onto the SAME gate endpoint and the SAME sole writer
 * (`gate_engine.py`, in the Anthology engine skill, resolved by
 * findGateEngineScript()). This route re-implements NO gate logic and holds NO
 * credentials: it shells `gate_engine.py status/decide --door board` via the
 * server-only bridge (src/app/participant/_lib/gate-engine.ts) exactly the way the
 * participant page shells `verify/status/decide --door token`. Layer 4 writes
 * nothing directly — the gate engine is the one sole writer, and it records this
 * door's provenance as `dashboard`.
 *
 * SESSION-GATED, NOT PUBLIC. This route is DELIBERATELY absent from
 * WEBHOOK_SECRET_ROUTES in src/middleware.ts. As a NON-webhook /api/* route it is
 * gated by the middleware's same-origin session passthrough: a same-origin board
 * request (the operator's Command Center, behind Cloudflare Access / the box's own
 * tunnel) passes through, while an EXTERNAL, non-same-origin caller with no
 * MC_API_TOKEN bearer is rejected by the middleware itself (401 when the token is
 * set, 503 when it is unset / fail-closed). This route therefore performs NO auth
 * of its own — it must not, or it would fork the auth model.
 *
 * SECRET DISCIPLINE: ANTHOLOGY_GATE_TOKEN_SECRET is never read, logged, or placed
 * on any command line here. The board door does not even resolve it (only the
 * token door does); the bridge inherits env into the child so the engine resolves
 * it itself. Only the engine's coarse, operator-facing result crosses back.
 *
 * Shelling out requires the Node.js runtime (never the Edge runtime).
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * Gate ACTIONS this route refuses outright, before the engine is ever shelled.
 * `done` is a board COLUMN owned SOLELY by the independent QC auto-scorer (≥ 8.5)
 * — mirrors FORBIDDEN_STATUSES in src/app/api/tasks/[id]/status/route.ts. A
 * producer may approve / hold / exclude / sign-off a GATE through this door, but
 * may never drive a card to `done` here: a builder or producer can never
 * self-grade its own card. `gate_engine.py` has no `done` action anyway (it would
 * refuse `action_not_allowed_at_gate`), so this is a belt-and-suspenders invariant
 * that keeps the 403 explicit and testable rather than incidental.
 */
const FORBIDDEN_ACTIONS = new Set(['done']);

const DecideSchema = z.object({
  /** participant_key (contains `::`) or anthology_id; the engine discriminates it. */
  subjectKey: z.string().trim().min(1).max(256),
  /** engine action name (approve | hold | exclude | escalate | select |
   *  approve_as_is | request_rewrite_with_notes | ready_to_assemble | sign_off).
   *  NOT enumerated here — the authoritative set comes from `status`, and the
   *  engine refuses an illegal action; hard-coding it would fork the source of
   *  truth. Only a length bound + the `done` guard are applied. */
  action: z.string().trim().min(1).max(64),
  reason: z.string().trim().max(5000).optional(),
  notes: z.string().trim().max(20000).optional(),
  title: z.string().trim().max(500).optional(),
  subtitle: z.string().trim().max(500).optional(),
  /** typed anthology name confirming `ready_to_assemble`. */
  confirmName: z.string().trim().max(500).optional(),
  /** CONFIRM-ORDER (U9/U13 finalize + finale). The producer's finalized
   *  running order (participant keys / chapter ids in sequence) plus the explicit
   *  opener + last co-author. Consumed for the FINALIZE-ACTION SET (any name the
   *  engine gives the confirm/finalize gate — `confirm_order`, `finalize_order`,
   *  … — matched by the shared isFinalizeAction predicate) and passed through to
   *  the engine; ignored for every genuinely non-finalize action. `opener` /
   *  `closer` are nullish because the cockpit derives them from `order` and may
   *  send null when the order is empty (the engine still validates). */
  order: z.array(z.string().trim().min(1).max(256)).max(500).optional(),
  opener: z.string().trim().min(1).max(256).nullish(),
  closer: z.string().trim().min(1).max(256).nullish(),
});

/** Resolve the operator identity for `--producer-id` on the S9 gates. Sourced
 *  from the Cloudflare-Access email (the real person) or the middleware-injected
 *  `x-operator-email` mirror of it — never from a caller-controllable body field,
 *  so producer provenance can't be forged. Empty when neither is present; the
 *  engine then refuses the S9 gates with `missing_fields`, which is honest. */
function operatorEmail(request: NextRequest): string {
  const email =
    request.headers.get('Cf-Access-Authenticated-User-Email') ||
    request.headers.get('x-operator-email');
  return email && email.trim() ? email.trim() : '';
}

/** Map an engine refusal reason → an HTTP status (presentation only; NOT gate
 *  logic). EX_REFUSE-class refusals are user-correctable (422); EX_GATE-class
 *  provisioning/held states are server-not-ready (503); a closed/absent gate is a
 *  state conflict (409). */
function httpForDecideFailure(reason: string, held: boolean): number {
  if (!held) return 422; // missing_fields | validation_mismatch | action_not_allowed_at_gate | …
  if (reason === 'no_open_gate' || reason === 'gate_not_open') return 409;
  return 503; // sole_writer_held | secret_not_set | not_ready | engine not provisioned
}

// GET /api/anthology/gate?subjectKey=<participant_key|anthology_id>
// The panel's authoritative action set for the subject's open gate (read-only).
export async function GET(request: NextRequest): Promise<NextResponse> {
  const subjectKey = request.nextUrl.searchParams.get('subjectKey')?.trim() ?? '';
  if (!subjectKey) {
    return NextResponse.json(
      { ok: false, error: 'subjectKey query parameter is required.' },
      { status: 400 }
    );
  }

  try {
    const status = boardStatus(subjectKey);
    if (status.ok) {
      return NextResponse.json(status, { status: 200 });
    }
    const httpStatus =
      status.reason === 'unknown_subject' ? 404 : status.reason === 'not_ready' ? 503 : 500;
    return NextResponse.json(status, { status: httpStatus });
  } catch (error) {
    console.error('[anthology gate] status failed:', (error as Error)?.message ?? error);
    return NextResponse.json({ ok: false, reason: 'error' }, { status: 500 });
  }
}

// POST /api/anthology/gate — record a board-door decision (the Approve button).
export async function POST(request: NextRequest): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid JSON body.' }, { status: 400 });
  }

  const parsed = DecideSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: 'Validation failed', details: parsed.error.issues },
      { status: 400 }
    );
  }
  const { subjectKey, action, reason, notes, title, subtitle, confirmName, order, opener, closer } =
    parsed.data;

  // `done` is never reachable through the gate door (see FORBIDDEN_ACTIONS).
  if (FORBIDDEN_ACTIONS.has(action)) {
    return NextResponse.json(
      {
        ok: false,
        error: `Forbidden: "${action}" cannot be set through the gate door.`,
        hint:
          'review → done is decided only by the independent QC auto-scorer (≥ 8.5). ' +
          'The gate door records producer gate decisions, never a card grade.',
      },
      { status: 403 }
    );
  }

  const fields: BoardDecideFields = {
    reason,
    notes,
    title,
    subtitle,
    confirmName,
    // Operator identity for the S9 gates (ready_to_assemble / sign_off). Sourced
    // from the session, never the body; ignored by the engine for other gates.
    producerId: operatorEmail(request) || undefined,
  };

  // CONFIRM-ORDER (U9/U13): relay the producer's finalized order + opener + last
  // co-author to the engine for the WHOLE finalize-action SET — any name the
  // engine gives the confirm/finalize gate (`confirm_order`, `finalize_order`, …),
  // matched by the SAME shared predicate the cockpit's pickConfirmOrderAction uses
  // (finalize-action.ts). Gating on a single hardcoded literal here would silently
  // DROP order/opener/closer whenever the engine named the gate anything else —
  // the data-loss defect this closes. The predicate excludes every genuinely
  // non-finalize action (approve/hold/exclude/rewrite/…), so these args can never
  // leak onto an unrelated decision. The engine stays authoritative — it validates
  // the order against the finalized set and refuses a bad one.
  if (isFinalizeAction(action)) {
    fields.order = order;
    fields.opener = opener ?? undefined;
    fields.closer = closer ?? undefined;
  }

  try {
    const result = decideBoard(subjectKey, action, fields);
    if (result.ok) {
      return NextResponse.json(result, { status: 200 });
    }
    return NextResponse.json(result, {
      status: httpForDecideFailure(result.reason, result.held),
    });
  } catch (error) {
    console.error('[anthology gate] decide failed:', (error as Error)?.message ?? error);
    return NextResponse.json(
      { ok: false, committed: false, reason: 'error', held: false },
      { status: 500 }
    );
  }
}
