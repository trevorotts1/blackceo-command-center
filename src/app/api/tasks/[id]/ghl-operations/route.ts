/**
 * /api/tasks/[id]/ghl-operations — WF18 · the `ghl-hybrid` operation-receipt
 * API (Document 1 §14.4-14.5, §5.5).
 *
 * POST  authenticated producer context, signed raw JSON body
 *       body: {schema_version, run_id, operation_receipt}
 * GET   existing task-read authorization + company scope
 *       returns the redacted operation summary and scoped evidence references
 *
 * WHAT THE POST VERIFIES (in order, fail-closed)
 *   1. Bearer MC_API_TOKEN (when configured) + HMAC-SHA256 x-webhook-signature
 *      (when WEBHOOK_SECRET is configured). In PRODUCTION an unset
 *      WEBHOOK_SECRET is a 503 — the same fail-closed posture as
 *      /api/tasks/ingest, never a quietly unauthenticated write surface.
 *   2. Bounded body size, parseable JSON, and the shared zod envelope.
 *   3. The owning company comes from SERVER CONTEXT
 *      (taskRequestCompany → MC_COMPANY_ID / COMPANY_SLUG). A body
 *      `company_id` is never trusted: a disagreeing value is a 403.
 *   4. The task exists IN THAT COMPANY (404 otherwise — a known UUID from
 *      another company must not be readable).
 *   5. Parent-child scope: the task's own parent, and any parent the receipt
 *      names, must be in the same company.
 *   6. Source provenance: the card carries the immutable `ghl-hybrid` stamp.
 *   7. Schema version, rail, and location: the location must be in the
 *      company's trusted server-side allow-list (GHL_ALLOWED_LOCATION_IDS /
 *      GHL_ALLOWED_LOCATIONS_JSON / company-config.json).
 *   8. `verified` requires a matched readback (a 2xx create is not evidence).
 *   9. Monotonic, idempotent progression: an identical replay is acknowledged;
 *      a reused receipt_id or sequence with different bytes is a 409; an older
 *      event never displaces a later verified outcome.
 *
 * The route never changes `tasks.status`. §14.7 keeps the ten TaskStatus
 * values; WF19 renders the typed progress from GET.
 */
import { NextRequest, NextResponse } from 'next/server';
import { timingSafeEqual } from 'crypto';
import { getDb } from '@/lib/db';
import { taskRequestCompany } from '@/lib/task-request-identity';
import { verifyWebhookSignatureStrict } from '@/lib/webhook-signature';
import { GhlOperationIngestSchema } from '@/lib/validation';
import type { GhlOperationReceipt } from '@/lib/types';
import {
  GHL_RECEIPT_ACCEPTED_SCHEMA_VERSIONS,
  GHL_RECEIPT_MAX_BODY_BYTES,
  GHL_HYBRID_SOURCE,
  insertGhlReceiptEvent,
  isGhlHybridTask,
  isGhlLocationAllowed,
  isVerifiableOutcome,
  loadCompanyBoundTask,
  loadGhlOperationSummaries,
  resolveAllowedGhlLocationIds,
} from '@/lib/ghl-hybrid-receipts';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

type AuthResult = { ok: true } | { ok: false; status: number; error: string };

function authenticate(request: NextRequest, rawBody: string): AuthResult {
  const token = process.env.MC_API_TOKEN;
  const secret = process.env.WEBHOOK_SECRET;
  const allowInsecure =
    process.env.NODE_ENV !== 'production' && process.env.ALLOW_INSECURE_OPEN_API === 'true';

  // Bearer layer — mirrors src/middleware.ts's external-caller gate.
  if (token) {
    const authHeader = request.headers.get('authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return { ok: false, status: 401, error: 'Unauthorized' };
    }
    if (!safeEqual(authHeader.slice(7), token)) {
      return { ok: false, status: 401, error: 'Unauthorized' };
    }
  }

  // HMAC layer — constant-time, over the EXACT received bytes.
  if (secret) {
    const signature = request.headers.get('x-webhook-signature');
    if (!signature) {
      return { ok: false, status: 401, error: 'Unauthorized: missing signature' };
    }
    if (!verifyWebhookSignatureStrict(signature, rawBody)) {
      return { ok: false, status: 401, error: 'Unauthorized: invalid signature' };
    }
    return { ok: true };
  }

  // No HMAC secret. Development keeps the zero-config path; production refuses.
  if (process.env.NODE_ENV === 'production' && !allowInsecure) {
    return {
      ok: false,
      status: 503,
      error:
        'WEBHOOK_SECRET not configured — the ghl-operations receipt API is disabled ' +
        'until this box sets it. Set WEBHOOK_SECRET to enable signed GHL receipts.',
    };
  }
  return { ok: true };
}

/** Resolve the owning company from server context only. */
function serverCompany(): string | null {
  try {
    return taskRequestCompany(getDb(), null, process.env.MC_COMPANY_ID);
  } catch {
    return null;
  }
}

function badRequest(error: string, details?: unknown, status = 400) {
  return NextResponse.json(details === undefined ? { error } : { error, details }, { status });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const rawBody = await request.text();

    const auth = authenticate(request, rawBody);
    if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const bodyBytes = Buffer.byteLength(rawBody, 'utf8');
    if (bodyBytes > GHL_RECEIPT_MAX_BODY_BYTES) {
      return NextResponse.json(
        {
          error: 'Payload too large',
          detail: `receipt body is ${bodyBytes} bytes; the limit is ${GHL_RECEIPT_MAX_BODY_BYTES}. ` +
            'Send the receipt, not the provider response.',
        },
        { status: 413 },
      );
    }

    let parsedBody: unknown;
    try {
      parsedBody = JSON.parse(rawBody);
    } catch {
      return badRequest('Invalid JSON body');
    }

    const envelopeVersion =
      parsedBody && typeof parsedBody === 'object'
        ? (parsedBody as { schema_version?: unknown }).schema_version
        : undefined;
    if (
      typeof envelopeVersion === 'string' &&
      !GHL_RECEIPT_ACCEPTED_SCHEMA_VERSIONS.includes(envelopeVersion)
    ) {
      return badRequest(
        `Unsupported schema_version "${envelopeVersion}". ` +
          `Accepted: ${GHL_RECEIPT_ACCEPTED_SCHEMA_VERSIONS.join(', ')}.`,
        undefined,
        422,
      );
    }

    const validation = GhlOperationIngestSchema.safeParse(parsedBody);
    if (!validation.success) {
      return NextResponse.json(
        {
          error: 'Validation failed',
          details: validation.error.issues,
          hint:
            'body = {schema_version, run_id, operation_receipt}. operation_receipt requires ' +
            'schema_version, receipt_id, attempt_id, event_sequence, run_id, operation_key, ' +
            'operation_id, location_id, rail, outcome, observed_at.',
        },
        { status: 400 },
      );
    }
    const { operation_receipt: receipt } = validation.data;
    const typed = receipt as GhlOperationReceipt;

    // ── Server-derived company (never the body) ──────────────────────────────
    const companyId = serverCompany();
    if (!companyId) {
      return NextResponse.json(
        { error: 'Server company context is not configured on this box' },
        { status: 503 },
      );
    }
    if (typeof typed.company_id === 'string' && typed.company_id && typed.company_id !== companyId) {
      return NextResponse.json(
        {
          error: 'Forbidden: receipt company does not match the authenticated server context',
          detail: 'company_mismatch',
        },
        { status: 403 },
      );
    }

    const db = getDb();

    // ── Task ownership (company-scoped) ──────────────────────────────────────
    const task = loadCompanyBoundTask(db, id, companyId);
    if (!task) {
      // A known task UUID from another company must read exactly like a
      // missing task — never a cross-tenant existence oracle.
      return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }

    // ── Parent-child scope ───────────────────────────────────────────────────
    if (task.parent_task_id) {
      const parent = loadCompanyBoundTask(db, task.parent_task_id, companyId);
      if (!parent) {
        return NextResponse.json(
          {
            error: 'Forbidden: this card\'s parent is outside the company scope',
            detail: 'parent_out_of_scope',
          },
          { status: 403 },
        );
      }
    }
    if (typed.parent_task_id) {
      const namedParent = loadCompanyBoundTask(db, typed.parent_task_id, companyId);
      const isThisTaskParent = typed.parent_task_id === task.parent_task_id;
      const isParentOfThisTask = typed.parent_task_id === task.id;
      if (!namedParent || (!isThisTaskParent && !isParentOfThisTask)) {
        return NextResponse.json(
          {
            error: 'Forbidden: receipt parent_task_id is outside this card\'s parent scope',
            detail: 'receipt_parent_out_of_scope',
          },
          { status: 403 },
        );
      }
    }

    // ── Source provenance (immutable stamp) ──────────────────────────────────
    if (!isGhlHybridTask(task)) {
      return NextResponse.json(
        {
          error: `Forbidden: this task is not a ${GHL_HYBRID_SOURCE} producer card.`,
          hint:
            `Only cards stamped source="${GHL_HYBRID_SOURCE}" accept operation receipts. ` +
            'A board card is moved through PATCH /api/tasks/{id}.',
        },
        { status: 403 },
      );
    }

    // ── Task identity cross-check ────────────────────────────────────────────
    if (typed.task_id && typed.task_id !== task.id) {
      return badRequest('operation_receipt.task_id must match the task in the URL path');
    }

    // ── Location allow-list (trusted server-side config) ─────────────────────
    if (!isGhlLocationAllowed(companyId, typed.location_id)) {
      const allowed = resolveAllowedGhlLocationIds(companyId);
      return NextResponse.json(
        {
          error: 'Forbidden: GHL location is not in this company\'s allowed set',
          detail: allowed.configured
            ? `location_not_allowed; allowed=${allowed.location_ids.join(',')} (${allowed.source})`
            : 'no_allowed_locations_configured; set GHL_ALLOWED_LOCATION_IDS or ' +
              'GHL_ALLOWED_LOCATIONS_JSON on this box',
        },
        { status: 403 },
      );
    }

    // ── Verified means read back ─────────────────────────────────────────────
    if (!isVerifiableOutcome(typed)) {
      return NextResponse.json(
        {
          error: 'A verified outcome requires readback.state="matched"',
          detail: 'verified_requires_matched_readback',
          hint:
            'Send outcome "submitted" or "processing" until the readback has actually ' +
            'matched; a 2xx create is not verification (§14.5).',
        },
        { status: 422 },
      );
    }

    const result = insertGhlReceiptEvent(db, {
      companyId,
      taskId: task.id,
      receipt: typed,
    });

    if (result.status === 'conflict') {
      return NextResponse.json(
        {
          error: 'Receipt conflict: the logical operation already holds different bytes at this identity',
          detail: result.reason,
          receipt_id: typed.receipt_id,
          event_sequence: typed.event_sequence,
        },
        { status: 409 },
      );
    }

    const row = result.row;
    const applied = result.status === 'inserted';
    return NextResponse.json(
      {
        ok: true,
        status: result.status, // inserted | replay | stale
        applied,
        reason: result.status === 'inserted' ? null : result.reason,
        receipt_id: row.receipt_id,
        task_id: row.task_id,
        run_id: row.run_id,
        operation_key: row.operation_key,
        event_sequence: row.event_sequence,
        outcome: row.outcome,
        needs_reconciliation: row.outcome === 'unknown_outcome',
      },
      { status: 200 },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // A missing table means migrations have not run on this box yet. Say so
    // instead of an opaque 500, and never pretend the receipt was stored.
    if (/no such table: ghl_operation_receipts/i.test(message)) {
      return NextResponse.json(
        {
          error: 'ghl_operation_receipts is not present yet — run migrations on this box',
          detail: 'receipt_store_unavailable',
        },
        { status: 503 },
      );
    }
    console.error('[ghl-operations] receipt ingest failed:', message);
    return NextResponse.json({ error: 'Failed to store the operation receipt' }, { status: 500 });
  }
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;

    const companyId = serverCompany();
    if (!companyId) {
      return NextResponse.json(
        { error: 'Server company context is not configured on this box' },
        { status: 503 },
      );
    }

    const db = getDb();
    const task = loadCompanyBoundTask(db, id, companyId);
    if (!task) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }

    const operations = loadGhlOperationSummaries(db, companyId, task.id);
    return NextResponse.json({
      ok: true,
      task_id: task.id,
      company_id: companyId,
      operations,
      needs_reconciliation: operations.some((op) => op.needs_reconciliation),
      generated_at: new Date().toISOString(),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/no such table: ghl_operation_receipts/i.test(message)) {
      return NextResponse.json(
        {
          ok: true,
          task_id: null,
          operations: [],
          detail: 'receipt_store_unavailable',
          error: 'ghl_operation_receipts is not present yet — run migrations on this box',
        },
        { status: 503 },
      );
    }
    console.error('[ghl-operations] receipt read failed:', message);
    return NextResponse.json({ error: 'Failed to read operation receipts' }, { status: 500 });
  }
}
