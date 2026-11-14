/**
 * POST /api/interview/skip  (BU-13)
 *
 * Replaces the deleted POST /api/interview/state. Two tenants, two stores —
 * never each other's:
 *
 *   • self / operator tenant — the STEP GATE decides. `skip` records a skip on
 *     the CURRENT question; `unsure` ("I am not sure") asks the gate for the
 *     helper flow and leaves the question current. The gate refuses a required
 *     question and any question that is not the current one, and this route
 *     passes that refusal through as a 409 with the gate's own reason.
 *
 *   • client tenant — unchanged ILJ-004 behaviour: the skip is remembered in
 *     this box's `tenant_interview_skips` table for that client's own session.
 *     A skip never touches the operator's gate state or transcript.
 *
 * Body: `{questionId, unsure?}`. `skipped:false` (the pre-BU-13 shape) clears a
 * client tenant's mark, so the existing circle-back UI keeps working.
 *
 * Error mapping:
 *   400 invalid_request / unknown_question — malformed body / unknown id (client)
 *   403 forbidden                         — unverified tenant
 *   409 refused / already_answered        — the gate (or the skip store) refused
 *   503 temporarily_unavailable           — the gate is missing or could not run
 */

import { NextRequest, NextResponse } from 'next/server';
import { runGate, type GateResult } from '@/lib/interview/seam';
import { resolveInterviewTenant, refuseUnverifiedTenant } from '@/lib/interview/tenant';
import { ensureTenantInterview, tenantAnswers } from '@/lib/interview/remote-store';
import { INTERVIEW_QUESTIONS } from '@/lib/interview-questions';
import { clearSessionSkip, readSessionSkips, recordSessionSkip } from '../state/route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

/** Known structured question ids of the CLIENT deck (the gate has its own). */
function knownStructuredIds(): Set<string> {
  return new Set(INTERVIEW_QUESTIONS.map((q) => q.id));
}

/** The gate's `next` payload, or null when the gate could not answer. */
async function nextPayload(): Promise<unknown> {
  const next: GateResult = await runGate(['next']);
  return next.code === 0 ? next.json : null;
}

export async function POST(request: NextRequest) {
  const tenant = await resolveInterviewTenant(request);
  const refusedTenant = refuseUnverifiedTenant(tenant);
  if (refusedTenant) return refusedTenant;

  let body: { questionId?: unknown; unsure?: unknown; skipped?: unknown };
  try {
    body = (await request.json()) as { questionId?: unknown; unsure?: unknown; skipped?: unknown };
  } catch {
    return NextResponse.json({ error: 'invalid_request', detail: 'bad body' }, { status: 400 });
  }
  const questionId = typeof body.questionId === 'string' ? body.questionId.trim() : '';
  const unsure = body.unsure === true;
  if (!questionId) {
    return NextResponse.json(
      { error: 'invalid_request', detail: 'questionId is required' },
      { status: 400 },
    );
  }

  /* ── client tenant: its own skip store (unchanged ILJ-004 behaviour) ─────── */
  if (tenant.kind === 'client' && tenant.client && tenant.context) {
    if (!knownStructuredIds().has(questionId)) {
      return NextResponse.json(
        { error: 'unknown_question', detail: 'questionId must be a known structured question id' },
        { status: 400 },
      );
    }
    const persisted = ensureTenantInterview(tenant.context.tenantId);
    // `skipped: false` clears the mark (circle-back without answering yet keeps
    // the card out of the skipped queue on this device; the server forgets it).
    if (body.skipped === false) {
      clearSessionSkip(tenant.context.tenantId, persisted.interview_id, questionId);
      const skippedIds = readSessionSkips(
        tenant.context.tenantId,
        persisted.interview_id,
        tenantAnswers(tenant.context.tenantId).map((a) => a.question_id),
      );
      return NextResponse.json({
        ok: true,
        questionId,
        skipped: false,
        unsure: false,
        skippedIds,
        next: null,
      });
    }
    // Never persist a skip for an already-answered question — an answer wins.
    const savedAnswers = tenantAnswers(tenant.context.tenantId);
    if (savedAnswers.some((a) => a.question_id === questionId)) {
      return NextResponse.json(
        {
          error: 'already_answered',
          detail: 'this question already has an answer; the skip is not needed',
        },
        { status: 409 },
      );
    }
    if (!recordSessionSkip(tenant.context.tenantId, persisted.interview_id, questionId)) {
      return NextResponse.json({ error: 'skip_not_saved' }, { status: 503 });
    }
    const skippedIds = readSessionSkips(
      tenant.context.tenantId,
      persisted.interview_id,
      savedAnswers.map((a) => a.question_id),
    );
    return NextResponse.json({
      ok: true,
      questionId,
      skipped: true,
      unsure: false,
      skippedIds,
      next: null,
    });
  }

  /* ── self tenant: the gate is the only authority ────────────────────────── */
  const gate = await runGate([unsure ? 'unsure' : 'skip', '--qid', questionId]);
  if (gate.code === 0) {
    return NextResponse.json({
      ok: true,
      questionId,
      skipped: gate.json?.skipped === true,
      unsure: gate.json?.unsure === true,
      next: await nextPayload(),
    });
  }
  if (gate.code === 2) {
    return NextResponse.json(
      {
        ok: false,
        questionId,
        skipped: false,
        unsure,
        error: 'refused',
        reason: gate.json?.reason ?? null,
        expected: gate.json?.expected ?? null,
        next: null,
      },
      { status: 409 },
    );
  }
  return NextResponse.json({ error: 'temporarily_unavailable' }, { status: 503 });
}
