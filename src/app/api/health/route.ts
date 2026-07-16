import { NextResponse } from 'next/server';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import fs from 'node:fs';
import { getDb, getMigrationStatus, getDbInitFailure, getDbPath } from '@/lib/db';
import type { DbInitFailure } from '@/lib/db';
import { getSOPEmbeddingHealth, resolveEmbeddingProvider } from '@/lib/sop-embeddings';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const execFileAsync = promisify(execFile);

/**
 * GET /api/health
 *
 * PRD 3.10: surface applied + expected migrations so the System Status
 * Panel can flag schema drift between client deployments. Older v3.6
 * installs that upgrade to v4.0 must show their pending migrations.
 *
 * F2.3 / DEP-11: ALSO surface the dual-store embedding health — the persona
 * index (Gemini-only) and the SOP/routing index (provider-flexible) reported
 * side-by-side (provider, model, row-model histogram, stale count) so an
 * asymmetric degradation (e.g. an OpenAI-only box that gets semantic SOP
 * routing but keyword-only persona Layer-5) is visible. Computed by
 * shared-utils/embedding_health.py (reads both SQLite stores, NEVER touches a
 * key/secret); on any probe failure the route falls back to the TypeScript
 * SOP-store snapshot so the field is always populated and never 500s.
 *
 * Response shape:
 *   {
 *     status: 'ok' | 'degraded',
 *     timestamp: ISO-8601,
 *     migrations: { applied, expected, pending, gap },
 *     embeddings: {
 *       status: 'ok' | 'degraded',
 *       degraded: boolean,
 *       asymmetric: boolean,
 *       asymmetric_detail: string,
 *       source: 'embedding_health.py' | 'ts-fallback',
 *       persona_index: {...} | null,   // null in ts-fallback (python-only store)
 *       sop_index: {...}
 *     }
 *   }
 *
 * DATA-02 — dedicated 503 for a captured DB-init / migration failure:
 * When boot (src/instrumentation.ts) or a prior request tripped a schema-apply
 * or migration failure, getDb() records it in module state (getDbInitFailure()).
 * This route reads that FIRST and, when set, returns HTTP 503 with
 * status='error', reason='migration_failed' (or 'db_init_failed' when the
 * failure predates the migration loop), and failedMigration=<id>. That is a
 * fail-CLOSED signal: a half-migrated DB is a downed box, so a load balancer /
 * watchdog must see 503, not a green 200. The state is a durable snapshot of the
 * boot-time failure, so repeated polls return the SAME 503 without re-running
 * migrations — the health check never thrashes the DB or the watchdog.
 *
 * A TRANSIENT error (e.g. a probe hiccup) that is NOT a captured init failure
 * still returns 200 with status='degraded' so the top-bar pill does not flap
 * OFFLINE on a blip. The `embeddings` block is ADDITIVE and its degradation
 * never flips the top-level `status` — asymmetric embedding state is operational
 * (keyword fallback still serves), not a downed box.
 */

const HEALTH_SCRIPT_TIMEOUT_MS = 4_000;

/**
 * DATA-02: build the fail-closed 503 body for a captured DB-init / migration
 * failure. `failedMigration` is the migration id when the failure happened
 * inside the migration loop; null when the DB failed to open/apply-schema
 * (reason 'db_init_failed'). Never leaks a stack trace — just the message.
 */
function migrationFailureResponse(failure: DbInitFailure) {
  return NextResponse.json(
    {
      status: 'error',
      timestamp: new Date().toISOString(),
      reason: failure.failedMigrationId ? 'migration_failed' : 'db_init_failed',
      failedMigration: failure.failedMigrationId,
      migrations: { applied: [], expected: [], pending: [], gap: 0 },
      embeddings: {
        check: 'dual_store_embedding_health',
        status: 'degraded',
        degraded: true,
        asymmetric: false,
        asymmetric_detail: 'DB init failed — embedding health not probed',
        source: 'error',
        persona_index: null,
        sop_index: null,
      },
      error: failure.message,
      failedAt: failure.at,
    },
    { status: 503 },
  );
}

function resolveHealthScript(): string {
  const override = process.env.EMBEDDING_HEALTH_SCRIPT;
  if (override) return override;
  return path.join(process.cwd(), 'shared-utils', 'embedding_health.py');
}

/**
 * Run the Python dual-store probe with one retry. Returns the parsed JSON, or
 * null when python3 / the script is unavailable so the caller can fall back to
 * the TypeScript SOP snapshot. Never throws.
 */
async function probeEmbeddingHealthPy(): Promise<Record<string, unknown> | null> {
  const script = resolveHealthScript();
  if (!fs.existsSync(script)) return null;

  // Resolve the ACTIVE provider NAME only (never a key). Defensive: if
  // resolution throws we still probe with 'none' rather than skipping the
  // Python path entirely — the caller only falls back to the TS snapshot when
  // python3/the script is unavailable, not on a provider-resolution hiccup.
  let activeProvider = 'none';
  try {
    activeProvider = resolveEmbeddingProvider().name;
  } catch {
    activeProvider = 'none';
  }

  const args = [
    '-s',
    script,
    '--format',
    'json',
    '--sop-db',
    getDbPath(),
    '--sop-active-provider',
    activeProvider,
  ];

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const { stdout } = await execFileAsync('python3', args, {
        timeout: HEALTH_SCRIPT_TIMEOUT_MS,
        encoding: 'utf-8',
        maxBuffer: 1_000_000,
      });
      return JSON.parse(stdout) as Record<string, unknown>;
    } catch {
      // retry once (transient DB lock / cold python), then fall back.
      if (attempt === 1) return null;
    }
  }
  return null;
}

/**
 * TypeScript-only fallback: report the SOP store from getSOPEmbeddingHealth()
 * and mark the persona index indeterminate (only the Python probe can read the
 * skill-folder gemini-index.sqlite). Asymmetry is 'indeterminate' — we cannot
 * compare against a store we could not read.
 */
function embeddingHealthFallback(): Record<string, unknown> {
  const sop = getSOPEmbeddingHealth();
  return {
    check: 'dual_store_embedding_health',
    status: sop.degraded ? 'degraded' : 'ok',
    degraded: sop.degraded,
    asymmetric: false,
    asymmetric_detail:
      'persona_index not read (embedding_health.py unavailable) — asymmetry indeterminate; SOP store reported by TS fallback.',
    source: 'ts-fallback',
    persona_index: null,
    sop_index: sop,
  };
}

async function getEmbeddingsBlock(): Promise<Record<string, unknown>> {
  try {
    const py = await probeEmbeddingHealthPy();
    if (py) {
      py.source = 'embedding_health.py';
      return py;
    }
    return embeddingHealthFallback();
  } catch {
    // Absolute last resort — surface a degraded block rather than 500.
    return {
      check: 'dual_store_embedding_health',
      status: 'degraded',
      degraded: true,
      asymmetric: false,
      asymmetric_detail: 'embedding health probe failed unexpectedly',
      source: 'error',
      persona_index: null,
      sop_index: null,
    };
  }
}

export async function GET() {
  // DATA-02: fail CLOSED on a captured DB-init / migration failure BEFORE
  // touching getDb() again. Reading the durable snapshot (rather than
  // re-invoking getDb(), which would re-attempt the failing migration on every
  // poll) keeps the 503 deterministic and stops the health check from thrashing
  // the DB or the watchdog.
  const bootFailure = getDbInitFailure();
  if (bootFailure) {
    return migrationFailureResponse(bootFailure);
  }

  try {
    const db = getDb();
    const { applied, pending } = getMigrationStatus(db);

    // expected = the union of applied + pending in sort order.
    const expected = Array.from(new Set([...applied, ...pending])).sort((a, b) => {
      const an = parseInt(a, 10);
      const bn = parseInt(b, 10);
      if (!Number.isNaN(an) && !Number.isNaN(bn) && an !== bn) return an - bn;
      return a.localeCompare(b);
    });

    const embeddings = await getEmbeddingsBlock();

    return NextResponse.json({
      status: pending.length === 0 ? 'ok' : 'degraded',
      timestamp: new Date().toISOString(),
      migrations: {
        applied,
        expected,
        pending,
        gap: pending.length,
      },
      embeddings,
    });
  } catch (error) {
    // DATA-02: if THIS getDb() call is what surfaced the DB-init / migration
    // failure, it is now captured — answer 503 fail-closed (not 200 degraded).
    const initFailure = getDbInitFailure();
    if (initFailure) {
      return migrationFailureResponse(initFailure);
    }
    // Otherwise it was a transient, non-init error — keep the top-bar pill from
    // flapping OFFLINE by returning 200 degraded.
    return NextResponse.json(
      {
        status: 'degraded',
        timestamp: new Date().toISOString(),
        migrations: {
          applied: [],
          expected: [],
          pending: [],
          gap: 0,
        },
        embeddings: {
          check: 'dual_store_embedding_health',
          status: 'degraded',
          degraded: true,
          asymmetric: false,
          asymmetric_detail: 'health route error before embedding probe',
          source: 'error',
          persona_index: null,
          sop_index: null,
        },
        error: error instanceof Error ? error.message : 'unknown',
      },
      { status: 200 }
    );
  }
}
