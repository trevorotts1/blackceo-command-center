import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { runMigrations } from '@/lib/db/migrations';
import { StageTimingBatchSchema } from '@/lib/validation';
import { verifyWebhookSignature } from '@/lib/webhook-signature';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * FIX 5 (presentation rev2 phase A) — stage-timings ingest.
 *
 * The presentation engine now writes one row per executed phase, plus a
 * run-level summary, to working/telemetry/stage-timings.jsonl (see
 * 23-ai-workforce-blueprint .../presentation_job/phases.py). The spec pairs
 * that durable file with a CC endpoint ("...AND TO A CC ENDPOINT") so run
 * duration and slowest-phase history is queryable after run dirs are cleaned.
 * This is the SMALL ingest route the spec calls for — no UI, no rollups yet.
 *
 * POST body: { "rows": [ {phase_exit...} | {run_summary...}, ... ] }
 *   - validated against StageTimingBatchSchema (zod),
 *   - raw body capped at 64KB (413),
 *   - non-JSON rejected (400),
 *   - HMAC-SHA256 over the raw body via x-webhook-signature, same scheme as
 *     /api/tasks/ingest and /api/webhooks/agent-completion. WEBHOOK_SECRET is
 *     REQUIRED in production (fail-loud 503, mirrors ingest W3.5); dev keeps
 *     the zero-config skip. This route also joins WEBHOOK_SECRET_ROUTES in
 *     src/middleware.ts, so the HTTP gate enforces it before we are reached.
 *
 * Schema self-heal: on a missing table (fresh box that predates migration
 * 127) we run migrations once (process-latched, like INGEST-07) and retry the
 * insert. Creating the table is additive and idempotent.
 */

const MAX_BODY_BYTES = 64 * 1024;

let selfHealDone = false;

export async function POST(request: NextRequest) {
  try {
    const rawBody = await request.text();

    if (Buffer.byteLength(rawBody, 'utf-8') > MAX_BODY_BYTES) {
      return NextResponse.json(
        { error: `payload exceeds ${MAX_BODY_BYTES} byte cap` },
        { status: 413 },
      );
    }

    // Auth — same HMAC scheme as /api/tasks/ingest (W3.5 fail-loud posture).
    const webhookSecret = process.env.WEBHOOK_SECRET;
    if (!webhookSecret) {
      if (process.env.NODE_ENV === 'production') {
        console.error(
          '[STAGE-TIMINGS] WEBHOOK_SECRET is not set — refusing unauthenticated ' +
            'timing writes in production.',
        );
        return NextResponse.json(
          { error: 'WEBHOOK_SECRET not configured — stage-timings ingest is disabled.' },
          { status: 503 },
        );
      }
      console.warn(
        '[STAGE-TIMINGS] WEBHOOK_SECRET unset — DEV mode, signature check skipped.',
      );
    } else {
      const signature = request.headers.get('x-webhook-signature');
      // FIX 56 — constant-time verify via the shared lib (src/lib/
      // webhook-signature.ts). Wrong-length signature is a clean false, 401.
      if (!verifyWebhookSignature(signature, rawBody)) {
        console.warn('[STAGE-TIMINGS] Invalid signature attempt');
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
      }
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    const validated = StageTimingBatchSchema.safeParse(parsed);
    if (!validated.success) {
      return NextResponse.json(
        { error: 'Validation failed', issues: validated.error.issues.slice(0, 20) },
        { status: 400 },
      );
    }

    const db = getDb();

    // NOTE: the request body is already consumed above, so the self-heal path
    // retries ONLY the insert loop — never re-enters POST (a second
    // request.text() would hang or throw).
    //
    // FIX 53a ([R5A §E, §H6]): phase_exit rows now persist `task_id` (optional
    // in the producer contract, validated in StageTimingExitSchema) and the
    // real `error_class` — migration 127 gave the column, but this route
    // previously hard-bound NULL into it, so every failure row landed
    // unclassified. run_summary rows keep NULL for both: the summary carries
    // no error class and predates task linkage.
    const writeRows = (): number => {
      const insert = db.prepare(`
        INSERT INTO presentation_stage_timings (
          run_id, event, phase_id, wave, model_used, started_at, ended_at,
          duration_s, status, return_code, error_class, total_wall_s,
          phase_count, slowest_3, payload, task_id
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `);
      let accepted = 0;
      for (const row of validated.data.rows) {
        if (row.event === 'phase_exit') {
          insert.run(
            row.run_id, row.event, row.phase_id, row.wave ?? null,
            row.model_used ?? null, row.started_at, row.ended_at,
            row.duration_s, row.status, row.return_code ?? null,
            row.error_class ?? null,
            null, null, null, JSON.stringify(row),
            row.task_id ?? null,
          );
        } else {
          insert.run(
            row.run_id, row.event, null, null, null, null, null,
            null, null, null, null,
            row.total_wall_s, row.phase_count, JSON.stringify(row.slowest_3),
            JSON.stringify(row),
            null,
          );
        }
        accepted += 1;
      }
      return accepted;
    };

    let accepted: number;
    try {
      accepted = writeRows();
    } catch (err) {
      // Missing-table self-heal (INGEST-07 pattern, latched once per process).
      const msg = err instanceof Error ? err.message : String(err);
      if (!selfHealDone && /no such table/i.test(msg)) {
        selfHealDone = true;
        runMigrations(db);
        accepted = writeRows();
      } else {
        throw err;
      }
    }

    return NextResponse.json({ ok: true, accepted }, { status: 201 });
  } catch (err) {
    console.error('[STAGE-TIMINGS] Unhandled error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function GET() {
  return NextResponse.json({
    endpoint: '/api/presentations/stage-timings',
    method: 'POST',
    accepts: '{ rows: [{event:"phase_exit", run_id, phase_id, wave, model_used, started_at, ended_at, duration_s, status, return_code?} | {event:"run_summary", run_id, total_wall_s, phase_count, slowest_3[], generated_at}] }',
    auth: 'x-webhook-signature: HMAC-SHA256(WEBHOOK_SECRET, rawBody) — REQUIRED in production (503 when unset); skipped only in development',
    limits: { maxBodyBytes: MAX_BODY_BYTES, maxRows: 1000 },
    producer: 'openclaw-onboarding presentation_job engine (FIX 5)',
  });
}
