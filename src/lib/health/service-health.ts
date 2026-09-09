/**
 * src/lib/health/service-health.ts — the F21 sanitized service-health view
 * (social-planner-doctor contract, CC half).
 *
 * ONE read-only computation that mirrors the ONB doctor's checks against the
 * CC-native durable records — the deployment half the doctor reads as files,
 * CC reads as tables. SANITIZED by contract: the response carries states,
 * ids, ages and repair actions ONLY — never a credential value, never a
 * client secret, never a raw token (F18 rule extends to health output).
 *
 * Checks (all read-only):
 *   identity   company_ghl_bindings presence (F01) per company
 *   engine     social_engine_ownership — exactly one ACTIVE durable owner
 *              per company (F17); a superseded-only box is UNHEALTHY, not
 *              "still working on the legacy trigger"
 *   worker     job_liveness ticks for the social jobs (social-cycle,
 *              social-publish-dispatcher): a stale/error/disabled tick is a
 *              HEALTH PROBLEM — the view NEVER claims work is progressing
 *              when the worker is stopped
 *   cycles     social_cycles latest row per company + overdue invited cycles
 *              (missed invitation = actionable state, never "in progress")
 *   queue      publish_queue overdue/failed rows (F03 overdue derivation)
 *   expiry     social_expiry_events unresolved rows awaiting reconnect (F35)
 *   registry   social_sheet_registry schema/sharing drift (F02/F14)
 *
 * Used by GET /api/health/service (route) and safe to call from tests.
 */
import { getDb, queryAll, timeNow } from '@/lib/db';

export interface ServiceHealthCheck {
  ok: boolean;
  state: string;
  detail?: string;
  count?: number;
}

export interface ServiceHealthReport {
  ok: boolean;
  degraded: boolean;
  generated_at: string;
  checks: Record<string, ServiceHealthCheck>;
  /** Actionable overdue/failed states — bounded, actionable, sanitized. */
  actionable: Array<Record<string, unknown>>;
}

const SOCIAL_JOBS = ['social-cycle', 'social-expiry-recovery', 'social-publish-dispatcher'] as const;
/** A worker with no tick for 3x its cadence (5 min jobs -> 15 min). */
const LIVENESS_STALE_MS = 15 * 60_000;

function tableExists(db: ReturnType<typeof getDb>, table: string): boolean {
  const row = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name = ?`)
    .get(table) as { name: string } | undefined;
  return Boolean(row);
}

/** identity: every company with a binding is verified; zero bindings = fresh. */
export function checkIdentity(): ServiceHealthCheck {
  const db = getDb();
  if (!tableExists(db, 'company_ghl_bindings')) {
    return { ok: true, state: 'no_bindings_table', detail: 'fresh install — no bindings recorded yet' };
  }
  const rows = queryAll<{ company_id: string }>(
    `SELECT DISTINCT company_id FROM company_ghl_bindings`, [],
  );
  return { ok: true, state: rows.length ? 'ok' : 'no_bindings', count: rows.length };
}

/** engine: exactly one ACTIVE durable owner per company (F17). */
export function checkEngine(): ServiceHealthCheck {
  const db = getDb();
  if (!tableExists(db, 'social_engine_ownership')) {
    return { ok: false, state: 'no_owner', detail: 'social_engine_ownership absent — the durable cycle service never claimed this box' };
  }
  const rows = queryAll<{ company_id: string; state: string; engine: string; next_run_at: string | null }>(
    `SELECT company_id, state, engine, next_run_at FROM social_engine_ownership`, [],
  );
  const byCompany = new Map<string, { active: number; superseded: number; durable: number }>();
  for (const r of rows) {
    const e = byCompany.get(r.company_id) ?? { active: 0, superseded: 0, durable: 0 };
    if (r.state === 'active') {
      e.active += 1;
      if (r.engine === 'cc-cycle-service') e.durable += 1;
    } else if (r.state === 'superseded') e.superseded += 1;
    byCompany.set(r.company_id, e);
  }
  const bad = [...byCompany.entries()].filter(([, e]) => e.active !== 1 || e.durable !== 1);
  if (bad.length) {
    return {
      ok: false,
      state: 'ownership_violated',
      detail: `companies with != 1 active durable owner: ${bad.map(([c]) => c).join(', ')}`,
    };
  }
  return {
    ok: byCompany.size > 0,
    state: byCompany.size ? 'ok' : 'no_owner',
    detail: byCompany.size ? undefined : 'no engine-ownership rows — the durable cycle service never claimed this box',
    count: byCompany.size,
  };
}

/**
 * worker: job_liveness freshness for the social jobs. A stale or erroring
 * worker is a HEALTH PROBLEM surfaced HERE — the view never reports work as
 * progressing when the worker is stopped (F21 required outcome).
 */
export function checkWorker(nowMs: number = Date.now()): ServiceHealthCheck {
  const db = getDb();
  if (!tableExists(db, 'job_liveness')) {
    return { ok: false, state: 'no_liveness', detail: 'job_liveness absent — the scheduler never ticked' };
  }
  const rows = queryAll<{ job_name: string; last_ran_at: string; last_status: string; last_error: string | null }>(
    `SELECT job_name, last_ran_at, last_status, last_error FROM job_liveness WHERE job_name IN ('social-cycle','social-expiry-recovery','social-publish-dispatcher')`,
    [],
  );
  const stale: string[] = [];
  for (const name of SOCIAL_JOBS) {
    const row = rows.find((r) => r.job_name === name);
    if (!row) {
      stale.push(`${name}: never ticked`);
      continue;
    }
    if (row.last_status === 'disabled') {
      stale.push(`${name}: disabled`);
      continue;
    }
    const ageMs = nowMs - new Date(row.last_ran_at).getTime();
    if (!Number.isFinite(ageMs) || ageMs > LIVENESS_STALE_MS) {
      stale.push(`${name}: last tick ${row.last_ran_at} (stale${row.last_error ? ': ' + row.last_error.slice(0, 80) : ''})`);
    }
  }
  if (stale.length) {
    return { ok: false, state: 'worker_stale', detail: stale.join('; ') };
  }
  return { ok: true, state: 'ok', count: SOCIAL_JOBS.length };
}

/** cycles: invited cycles whose cutoff passed = MISSED INVITATION (actionable). */
export function checkCycles(nowMs: number = Date.now()): ServiceHealthCheck {
  const db = getDb();
  if (!tableExists(db, 'social_cycles')) {
    return { ok: true, state: 'no_cycles_yet', detail: 'fresh install — no cycle rows yet' };
  }
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM social_cycles`).get() as { n: number }).n;
  const missed = queryAll<{ id: string; company_id: string; week_start_local: string; cutoff_at: string | null }>(
    `SELECT id, company_id, week_start_local, cutoff_at FROM social_cycles
      WHERE state = 'invited' AND cutoff_at IS NOT NULL AND cutoff_at <= ?
      ORDER BY cutoff_at LIMIT 25`,
    [new Date(nowMs).toISOString()],
  );
  if (missed.length) {
    return {
      ok: false,
      state: 'missed_invitation',
      detail: `${missed.length} invited cycle(s) past cutoff with no response — actionable, not in progress`,
      count: missed.length,
    };
  }
  return { ok: true, state: total ? 'ok' : 'no_cycles_yet', count: total };
}

/** queue: overdue/failed publish rows (the F03 actionable states). */
export function checkQueue(nowMs: number = Date.now()): ServiceHealthCheck {
  const db = getDb();
  if (!tableExists(db, 'publish_queue')) {
    return { ok: true, state: 'no_queue', detail: 'fresh install' };
  }
  const rows = queryAll<{ id: string; status: string; created_at: string }>(
    `SELECT id, status, created_at FROM publish_queue
      WHERE status IN ('queued','running','retrying') ORDER BY created_at ASC LIMIT 100`,
    [],
  );
  const OVERDUE_MS = 15 * 60_000;
  // SQLite stores created_at as 'YYYY-MM-DD HH:MM:SS' (datetime('now')) —
  // normalize to ISO before parsing (Safari/strict Date.parse rejects the
  // space form).
  const iso = (s: string) => s.replace(' ', 'T') + (s.endsWith('Z') ? '' : 'Z');
  const overdue = rows.filter(
    (r) => Number.isFinite(new Date(iso(r.created_at)).getTime())
      && nowMs - new Date(iso(r.created_at)).getTime() > OVERDUE_MS,
  );
  if (overdue.length) {
    return {
      ok: false,
      state: 'overdue',
      detail: `${overdue.length} publish row(s) past the overdue window — the consumer is stopped or stalled`,
      count: overdue.length,
    };
  }
  return { ok: true, state: 'ok' };
}

/** expiry: unresolved expiry events awaiting reconnection (F35). */
export function checkExpiry(): ServiceHealthCheck {
  const db = getDb();
  if (!tableExists(db, 'social_expiry_events')) {
    return { ok: true, state: 'no_expiry_events' };
  }
  const rows = queryAll<{ id: string; error_type: string; status: string }>(
    `SELECT id, error_type, status FROM social_expiry_events
      WHERE status = 'open' LIMIT 25`,
    [],
  );
  if (rows.length) {
    const kinds = new Map<string, number>();
    for (const r of rows) kinds.set(r.error_type, (kinds.get(r.error_type) ?? 0) + 1);
    return {
      ok: false,
      state: 'awaiting_reconnect',
      detail: [...kinds.entries()].map(([k, n]) => `${k}: ${n}`).join(', ') + ' — affected resources need reconnection; healthy accounts continue',
      count: rows.length,
    };
  }
  return { ok: true, state: 'ok' };
}

/** sheet registry: sharing + schema drift (F02/F14). */
export function checkSheetRegistry(): ServiceHealthCheck {
  const db = getDb();
  if (!tableExists(db, 'social_sheet_registry')) {
    return { ok: false, state: 'unregistered', detail: 'no planner sheet registered — first-time setup has not completed' };
  }
  const rows = queryAll<{ company_id: string; sharing: string | null; schema_version: string | null; verified_at: string | null }>(
    `SELECT company_id, sharing, schema_version, verified_at FROM social_sheet_registry`,
    [],
  );
  if (!rows.length) {
    return { ok: false, state: 'unregistered', detail: 'empty sheet registry' };
  }
  const drifted = rows.filter(
    (r) => (r.sharing && r.sharing !== 'anyone,writer' && r.sharing !== 'anyone-with-the-link-can-edit')
      || (r.schema_version && r.schema_version !== '1.1.0'),
  );
  if (drifted.length) {
    return {
      ok: false,
      state: 'registry_drift',
      detail: `${drifted.length} registered sheet(s) drifted from the F02/F15 contract`,
      count: drifted.length,
    };
  }
  return { ok: true, state: 'ok', count: rows.length };
}

const HARD_CHECKS = ['identity', 'engine', 'worker', 'cycles', 'queue', 'sheet_registry'] as const;

/** Full sanitized report. NEVER includes a credential value. */
export function serviceHealthReport(nowMs: number = Date.now()): ServiceHealthReport {
  const checks: Record<string, ServiceHealthCheck> = {
    identity: checkIdentity(),
    engine: checkEngine(),
    worker: checkWorker(nowMs),
    cycles: checkCycles(nowMs),
    queue: checkQueue(nowMs),
    expiry: checkExpiry(),
    sheet_registry: checkSheetRegistry(),
  };
  const hardFail = HARD_CHECKS.some((k) => !checks[k]?.ok);
  const softFail = Object.entries(checks).some(
    ([k, c]) => !(HARD_CHECKS as readonly string[]).includes(k) && !c?.ok,
  );
  const actionable: Array<Record<string, unknown>> = Object.entries(checks)
    .filter(([, c]) => !c?.ok)
    .map(([name, c]) => ({ check: name, state: c.state, detail: c.detail ?? '', count: c.count }));
  return {
    ok: !hardFail,
    degraded: !hardFail && softFail,
    generated_at: timeNow(),
    checks,
    actionable,
  };
}