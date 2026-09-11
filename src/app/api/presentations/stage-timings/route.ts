import { NextRequest, NextResponse } from 'next/server';
import { createHash } from 'crypto';
import { getDb } from '@/lib/db';
import { runMigrations } from '@/lib/db/migrations';
import { resolveActiveCompanyId } from '@/lib/company';
import { boardWhereClause } from '@/lib/workspaces/board-query';
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
    // PRES-037 (W3 WF12-B) — transactional idempotent ingest. The whole
    // validated batch inserts inside ONE better-sqlite3 transaction: a
    // mid-batch failure rolls back every row, so a retry never duplicates an
    // accepted prefix. Rows that carry event_id use the company-scoped
    // idempotency key (company_id, run_id, event_id) from migration 141:
    //   - same key + byte-identical canonical payload → replay ignored,
    //     reported back as duplicate (the lost-ACK case: the producer's
    //     outbox replays, totals do not move);
    //   - same key + DIFFERENT payload → 409 conflict naming the event, and
    //     the ENTIRE batch rolls back (a changed replay is never half-applied).
    // Legacy rows without event_id take the plain-insert path exactly as
    // before — no dedupe possible, no behavior change. Every accepted event
    // also writes its per-event ACK row (presentation_stage_acks), the durable
    // record the producer replays against. Task/run linkage is enforced when
    // the row names a task: the task must exist in the active company scope
    // (boardWhereClause convention — NULL workspace is the box's own data and
    // passes); a foreign task binding is refused with 422 and rolls back the
    // batch. Out-of-order events from an OLD run never move current-run
    // totals: the timing read path keys current execution off the task's
    // registered run, not insertion order.
    const companyId = resolveActiveCompanyId(db) ?? '';

    const scopedTaskIds = ((): string[] => {
      try {
        const activeId = resolveActiveCompanyId(db);
        const scope = boardWhereClause(activeId);
        const ids = (
          db.prepare(`SELECT w.id FROM workspaces w ${scope.sql}`).all(...scope.params) as { id: string }[]
        ).map((w) => w.id);
        return ids.length > 0 ? ids : ['__no_workspace__'];
      } catch {
        return ['__no_workspace__'];
      }
    })();

    const assertTaskLinkage = (taskId: string): void => {
      const placeholders = scopedTaskIds.map(() => '?').join(',');
      const row = db
        .prepare(
          `SELECT id FROM tasks WHERE id = ? AND (workspace_id IS NULL OR workspace_id IN (${placeholders}))`,
        )
        .get(taskId, ...scopedTaskIds) as { id: string } | undefined;
      if (!row) {
        const err = new Error(`task/run linkage refused: task ${taskId} is not in the active company scope`) as Error & { statusCode?: number };
        err.statusCode = 422;
        throw err;
      }
    };

    const eventHashOf = (row: unknown): string =>
      createHash('sha256').update(JSON.stringify(row)).digest('hex');

    const hasTimingEventKeys = ((): boolean => {
      try {
        const cols = (
          db.prepare(`PRAGMA table_info(presentation_stage_timings)`).all() as { name: string }[]
        ).map((c) => c.name);
        return cols.includes('company_id') && cols.includes('event_id') && cols.includes('event_hash');
      } catch {
        return false;
      }
    })();

    interface TimingWriteResult {
      accepted: number;
      duplicates: number;
      acks: Array<{ run_id: string; event_id: string; status: string }>;
    }

    const writeRows = (): TimingWriteResult => {
      const insertLegacy = db.prepare(`
        INSERT INTO presentation_stage_timings (
          run_id, event, phase_id, wave, model_used, started_at, ended_at,
          duration_s, status, return_code, error_class, total_wall_s,
          phase_count, slowest_3, payload, task_id
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `);
      const insertKeyed = hasTimingEventKeys
        ? db.prepare(`
          INSERT INTO presentation_stage_timings (
            run_id, event, phase_id, wave, model_used, started_at, ended_at,
            duration_s, status, return_code, error_class, total_wall_s,
            phase_count, slowest_3, payload, task_id,
            company_id, event_id, attempt_id, sequence, event_hash,
            provider_s, queue_s, qc_s
          ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        `)
        : null;
      const upsertAck = db.prepare(`
        INSERT INTO presentation_stage_acks (company_id, run_id, event_id, status, event_hash)
        VALUES (?,?,?,?,?)
        ON CONFLICT (company_id, run_id, event_id)
        DO UPDATE SET status = excluded.status, event_hash = excluded.event_hash, ack_at = datetime('now')
      `);
      let accepted = 0;
      let duplicates = 0;
      const acks: Array<{ run_id: string; event_id: string; status: string }> = [];

      const applyBatch = db.transaction(() => {
        for (const raw of validated.data.rows) {
          if (raw.event === 'run_summary') {
            const row = raw;
            insertLegacy.run(
              row.run_id, row.event, null, null, null, null, null,
              null, null, null, null,
              row.total_wall_s, row.phase_count, JSON.stringify(row.slowest_3),
              JSON.stringify(row),
              null,
            );
            accepted += 1;
            continue;
          }
          const row = raw as Extract<typeof raw, { event: 'phase_exit' }>;
          const taskId = row.task_id ?? null;
          if (taskId) assertTaskLinkage(taskId);

          const eventId = row.event_id ?? null;
          if (eventId && insertKeyed) {
            const hash = eventHashOf(row);
            const prior = db
              .prepare(
                `SELECT event_hash FROM presentation_stage_timings
                  WHERE company_id = ? AND run_id = ? AND event_id = ?`,
              )
              .get(companyId, row.run_id, eventId) as { event_hash: string } | undefined;
            if (prior) {
              if (prior.event_hash !== hash) {
                const err = new Error(
                  `conflicting replay for event ${eventId} in run ${row.run_id}: payload differs from the accepted row`,
                ) as Error & { statusCode?: number };
                err.statusCode = 409;
                throw err;
              }
              duplicates += 1;
              upsertAck.run(companyId, row.run_id, eventId, 'duplicate', hash);
              acks.push({ run_id: row.run_id, event_id: eventId, status: 'duplicate' });
              continue;
            }
            insertKeyed.run(
              row.run_id, row.event, row.phase_id, row.wave ?? null,
              row.model_used ?? null, row.started_at, row.ended_at,
              row.duration_s, row.status, row.return_code ?? null,
              row.error_class ?? null,
              null, null, null, JSON.stringify(row),
              taskId,
              companyId, eventId, row.attempt_id ?? null, row.sequence ?? null, hash,
              row.provider_s ?? null, row.queue_s ?? null, row.qc_s ?? null,
            );
            upsertAck.run(companyId, row.run_id, eventId, 'accepted', hash);
            acks.push({ run_id: row.run_id, event_id: eventId, status: 'accepted' });
            accepted += 1;
          } else if (row.event === 'phase_exit') {
            insertLegacy.run(
              row.run_id, row.event, row.phase_id, row.wave ?? null,
              row.model_used ?? null, row.started_at, row.ended_at,
              row.duration_s, row.status, row.return_code ?? null,
              row.error_class ?? null,
              null, null, null, JSON.stringify(row),
              taskId,
            );
            accepted += 1;
          } else {
            insertLegacy.run(
              row.run_id, row.event, row.phase_id, row.wave ?? null,
              row.model_used ?? null, row.started_at, row.ended_at,
              row.duration_s, row.status, row.return_code ?? null,
              row.error_class ?? null,
              null, null, null, JSON.stringify(row),
              taskId,
            );
            accepted += 1;
          }
        }
      });

      applyBatch();
      return { accepted, duplicates, acks };
    };

    let result: TimingWriteResult;
    try {
      result = writeRows();
    } catch (err) {
      // Missing-table self-heal (INGEST-07 pattern, latched once per process).
      const msg = err instanceof Error ? err.message : String(err);
      if (!selfHealDone && /no such table/i.test(msg)) {
        selfHealDone = true;
        runMigrations(db);
        result = writeRows();
      } else {
        const statusCode = (err as Error & { statusCode?: number }).statusCode;
        if (statusCode === 409 || statusCode === 422) {
          return NextResponse.json(
            { error: (err as Error).message },
            { status: statusCode },
          );
        }
        throw err;
      }
    }

    // BACK-COMPAT: legacy engine builds (phases.py run_phase_timed) assert
    // the exact `{ ok: true, accepted: N }` envelope. The PRES-037 fields ride
    // alongside ONLY when they carry information (keyed rows seen); a batch
    // with no event ids responds byte-identically to the old contract.
    const body: Record<string, unknown> = { ok: true, accepted: result.accepted };
    if (result.duplicates > 0 || result.acks.length > 0) {
      body.duplicates = result.duplicates;
      body.acks = result.acks;
    }
    return NextResponse.json(body, { status: 201 });

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
