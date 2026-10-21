/**
 * launch-ability-runs.ts — server-only ingestion + read core for the five
 * launch abilities (49/50/44/38/83) registered in `launch-abilities.ts`.
 *
 * This is the launch twin of `skill71-runs.ts` and follows the same pattern on
 * purpose (the swarm-management rule: runs and progress flow through EXISTING
 * patterns, one ingestion core per event family):
 *
 *   validate against the frozen run-events contract → dedupe by event_id →
 *   upsert the run record with the latest event state → score progress against
 *   the ability's declared stage order.
 *
 * Idempotent: re-importing the same events changes nothing. Read-only with
 * respect to run folders — nothing here writes outside the Command Center DB.
 *
 * Auth for the HTTP transport REUSES the existing per-client ingest token store
 * (`verifySkill71IngestToken`). No new credential surface is minted by this
 * lane: client boxes keep their own token, and the token record still binds
 * client_slug + host_shape. An event that CONTRADICTS its token (different
 * client, host shape or installation) is rejected before a row is written.
 *
 * Storage: the tables are created by the NUMBERED migration `173`
 * (`src/lib/db/migrations.ts`) from the one versioned contract in
 * `src/lib/launch-schema.ts`. `ensureLaunchSchema()` remains only as the
 * idempotent bootstrap for isolated tests and fresh code paths; it executes the
 * SAME SQL, so production and tests can never diverge.
 */

import { queryAll, queryOne, run, transaction } from '@/lib/db';
import { launchSchemaStatements, LAUNCH_STORAGE_CONTRACT_VERSION } from '@/lib/launch-schema';
import {
  LAUNCH_ABILITIES,
  computeLaunchProgress,
  getLaunchAbility,
  validateProgressSample,
  type LaunchAbility,
  type LaunchProgress,
  type LaunchStageRow,
  type ProgressSample,
} from '@/lib/launch-abilities';
import {
  launchEventContradictsToken,
  validateLaunchRunEvent,
  type LaunchHostShape,
  type LaunchIngestToken,
  type LaunchRunEvent,
} from '@/lib/launch-run-events';

let schemaReady = false;

/** Provision this lane's tables on first use. Idempotent, additive, and the
 *  exact SQL migration 173 applies. Safe to call from every entry point (the
 *  DB handle itself is the process singleton). */
export function ensureLaunchSchema(): void {
  if (schemaReady) return;
  transaction(() => {
    const db = queryAll<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'launch_runs'`,
    );
    if (db.length > 0) return;
    // `run` executes one statement; split the DDL so each statement is prepared
    // on its own (better-sqlite3 refuses multi-statement prepare).
    for (const statement of launchSchemaStatements()) {
      run(`${statement};`);
    }
  });
  schemaReady = true;
}

/** @deprecated use ensureLaunchSchema — kept so existing imports keep working. */
export const ensureLaunchRunSchema = ensureLaunchSchema;

/** The storage-contract version this process wrote/expects. */
export function launchStorageContractVersion(): number {
  ensureLaunchSchema();
  const row = queryOne<{ version: number }>(
    `SELECT version FROM launch_storage_contract WHERE contract = 'launch'`,
  );
  return row?.version ?? LAUNCH_STORAGE_CONTRACT_VERSION;
}

function nowIso(): string {
  return new Date().toISOString();
}

export interface LaunchIngestOutcome {
  status: 'inserted' | 'duplicate';
  event_id: string;
}

export interface LaunchIngestStamp {
  /** Transport provenance (HTTP ingest): applied when the event omits the field. */
  client_slug?: string;
  host_shape?: LaunchHostShape;
  installation_id?: string;
  source: string;
}

/**
 * A duplicate whose content CONTRADICTS the row already stored, or an event
 * that would rebind a run to a different launch. Never merged optimistically:
 * the caller reports a rejection and the stored state is unchanged.
 */
export class LaunchIngestConflictError extends Error {
  readonly code = 'conflicting_duplicate';
}

/** Reject a run re-bind before any row is written. */
function assertRunIdentityCompatible(event: LaunchRunEvent): void {
  if (!event.launch_id) return;
  const row = queryOne<{ launch_id: string | null }>(
    `SELECT launch_id FROM launch_runs WHERE run_id = ?`,
    [event.run_id],
  );
  if (row?.launch_id && row.launch_id !== event.launch_id) {
    throw new LaunchIngestConflictError(
      `run ${event.run_id} is already bound to launch "${row.launch_id}"; ` +
      `event claims "${event.launch_id}"`,
    );
  }
}

/**
 * Ingest one validated launch run event. Dedupe is by `event_id`, exactly as
 * the Skill 71 core does, so an at-least-once shipper can safely re-send.
 *
 * Throws `LaunchIngestConflictError` when the event would rebind the run to a
 * different launch; nothing is written in that case.
 */
export function ingestLaunchRunEvent(
  event: LaunchRunEvent,
  ability: LaunchAbility,
  stamp: LaunchIngestStamp,
): LaunchIngestOutcome {
  ensureLaunchSchema();
  assertRunIdentityCompatible(event);
  let outcome: LaunchIngestOutcome = { status: 'inserted', event_id: event.event_id };
  transaction(() => {
    const inserted = run(
      `INSERT OR IGNORE INTO launch_run_events
         (event_id, run_id, skill, event_type, emitted_at, source, payload_json, installation_id, received_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [event.event_id, event.run_id, ability.skill, event.event_type, event.emitted_at,
       stamp.source, JSON.stringify(event), stamp.installation_id ?? null, nowIso()],
    );
    if (inserted.changes === 0) {
      outcome = { status: 'duplicate', event_id: event.event_id };
      return;
    }
    applyLaunchEvent(event, ability, stamp);
  });
  return outcome;
}

export type LaunchIngestDecision =
  | { ok: true; outcome: LaunchIngestOutcome }
  | { ok: false; errors: string[] };

/**
 * The authenticated entry point: validate the event against the frozen
 * contract, then against the verified token's client / host shape /
 * installation, then ingest. A contradiction or a run rebind is a rejection;
 * nothing is written.
 */
export function ingestAuthenticatedLaunchRunEvent(
  raw: unknown,
  token: LaunchIngestToken,
  source: string,
): LaunchIngestDecision {
  const validation = validateLaunchRunEvent(raw);
  if (!validation.ok) return { ok: false, errors: validation.errors };
  // The frozen contract leaves `launch_id` optional (Skill 71 parity); the
  // Launch ingest cannot. A run with no launch identity can never be tied to a
  // plan, so it is rejected as absent identity rather than listed as progress.
  if (!validation.event.launch_id) {
    return {
      ok: false,
      errors: ['launch_id is required for launch ingest; an event with no launch identity cannot report progress'],
    };
  }
  const contradiction = launchEventContradictsToken(validation.event, token);
  if (contradiction) return { ok: false, errors: [contradiction] };
  try {
    return {
      ok: true,
      outcome: ingestLaunchRunEvent(validation.event, validation.ability, {
        client_slug: token.client_slug,
        host_shape: token.host_shape,
        installation_id: token.installation_id,
        source,
      }),
    };
  } catch (error) {
    if (error instanceof LaunchIngestConflictError) {
      return { ok: false, errors: [error.message] };
    }
    throw error;
  }
}

function touchRun(event: LaunchRunEvent, ability: LaunchAbility) {
  run(
    `INSERT INTO launch_runs
       (run_id, skill, ability_slug, launch_id, started_at, last_event_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(run_id) DO UPDATE SET
       launch_id = COALESCE(launch_runs.launch_id, excluded.launch_id),
       last_event_at = MAX(COALESCE(launch_runs.last_event_at, ''), excluded.last_event_at),
       updated_at = excluded.updated_at`,
    [event.run_id, ability.skill, ability.slug, event.launch_id ?? null,
     event.emitted_at, event.emitted_at, nowIso(), nowIso()],
  );
}
function applyLaunchEvent(
  event: LaunchRunEvent,
  ability: LaunchAbility,
  stamp: LaunchIngestStamp,
) {
  touchRun(event, ability);
  switch (event.event_type) {
    case 'run_initialized': {
      run(
        `UPDATE launch_runs SET
           launch_id = COALESCE(?, launch_id),
           client_slug = COALESCE(?, client_slug),
           host_shape = COALESCE(?, host_shape),
           installation_id = COALESCE(?, installation_id),
           run_dir = COALESCE(?, run_dir),
           started_at = COALESCE(started_at, ?),
           updated_at = ?
         WHERE run_id = ?`,
        [event.launch_id ?? null,
         event.client_slug ?? stamp.client_slug ?? null,
         event.host_shape ?? stamp.host_shape ?? null,
         event.installation_id ?? stamp.installation_id ?? null,
         event.run_dir ?? null,
         event.emitted_at, nowIso(), event.run_id],
      );
      break;
    }
    case 'stage_closed': {
      run(
        `INSERT INTO launch_run_stages
           (run_id, stage, status, receipt_status, closed_at, duration_s,
            scores_summary_json, cost_json, artifact_hashes_json, failures_json, updated_at)
         VALUES (?, ?, 'closed', ?, ?, ?, ?, ?, ?, NULL, ?)
         ON CONFLICT(run_id, stage) DO UPDATE SET
           status = 'closed', receipt_status = excluded.receipt_status,
           closed_at = excluded.closed_at, duration_s = excluded.duration_s,
           scores_summary_json = excluded.scores_summary_json,
           cost_json = excluded.cost_json,
           artifact_hashes_json = excluded.artifact_hashes_json,
           failures_json = NULL, updated_at = excluded.updated_at
         -- Nonregressing terminal state: a stage already closed with a pass
         -- receipt is never downgraded to not_authorized by a later duplicate.
         WHERE NOT (launch_run_stages.status = 'closed'
                    AND launch_run_stages.receipt_status = 'pass'
                    AND excluded.receipt_status = 'not_authorized')`,
        [event.run_id, event.stage, event.receipt_status, event.closed_at,
         event.duration_s ?? null,
         event.scores_summary ? JSON.stringify(event.scores_summary) : null,
         event.cost ? JSON.stringify(event.cost) : null,
         event.artifact_hashes ? JSON.stringify(event.artifact_hashes) : null,
         nowIso()],
      );
      run(
        `UPDATE launch_runs SET blocked_stage = NULL
         WHERE run_id = ? AND blocked_stage = ?`,
        [event.run_id, event.stage],
      );
      break;
    }
    case 'stage_blocked': {
      // A blocked close after a successful close does not unclose the stage:
      // the close record stands; the refusal stays in the event log.
      run(
        `INSERT INTO launch_run_stages
           (run_id, stage, status, receipt_status, failures_json, blocked_at, updated_at)
         VALUES (?, ?, 'blocked', NULL, ?, ?, ?)
         ON CONFLICT(run_id, stage) DO UPDATE SET
           status = 'blocked', failures_json = excluded.failures_json,
           blocked_at = excluded.blocked_at, updated_at = excluded.updated_at
         WHERE launch_run_stages.status != 'closed'`,
        [event.run_id, event.stage, JSON.stringify(event.failures ?? []),
         event.blocked_at ?? null, nowIso()],
      );
      run(
        `UPDATE launch_runs SET blocked_stage = ?
         WHERE run_id = ? AND NOT EXISTS (
           SELECT 1 FROM launch_run_stages
           WHERE run_id = ? AND stage = ? AND status = 'closed')`,
        [event.stage, event.run_id, event.run_id, event.stage],
      );
      break;
    }
    case 'item_closed':
    case 'item_blocked': {
      const row = queryOne<{ items_json: string | null }>(
        `SELECT items_json FROM launch_run_stages WHERE run_id = ? AND stage = ?`,
        [event.run_id, event.stage],
      );
      let items: Record<string, unknown> = {};
      if (row?.items_json) {
        try { items = JSON.parse(row.items_json) as Record<string, unknown>; } catch { items = {}; }
      }
      items[event.item_id as string] = event.event_type === 'item_closed'
        ? { status: 'closed', closed_at: event.closed_at, artifact_hash: event.artifact_hash ?? null }
        : { status: 'blocked', blocked_at: event.blocked_at, failures: event.failures ?? [] };
      run(
        `INSERT INTO launch_run_stages (run_id, stage, status, items_json, updated_at)
         VALUES (?, ?, 'open', ?, ?)
         ON CONFLICT(run_id, stage) DO UPDATE SET
           items_json = excluded.items_json, updated_at = excluded.updated_at`,
        [event.run_id, event.stage, JSON.stringify(items), nowIso()],
      );
      break;
    }
    case 'report_generated': {
      run(
        `UPDATE launch_runs SET
           overall = ?, review_mode = ?,
           report_json_path = COALESCE(?, report_json_path),
           report_md_path = COALESCE(?, report_md_path),
           run_dir = COALESCE(?, run_dir),
           updated_at = ?
         WHERE run_id = ?`,
        [event.overall, event.review_mode, event.report_json_path ?? null,
         event.report_md_path ?? null, event.run_dir ?? null, nowIso(), event.run_id],
      );
      break;
    }
    case 'pin_drift': {
      // No run-state change: the event row itself is the record.
      break;
    }
  }
}

// ---------------------------------------------------------------------------
// Queries — the board reads the database only, never run folders.
// ---------------------------------------------------------------------------

export interface LaunchRunRow {
  run_id: string;
  skill: number;
  ability_slug: string;
  launch_id: string | null;
  client_slug: string | null;
  host_shape: string | null;
  installation_id: string | null;
  run_dir: string | null;
  overall: string;
  review_mode: string | null;
  report_json_path: string | null;
  report_md_path: string | null;
  blocked_stage: string | null;
  started_at: string | null;
  last_event_at: string | null;
}

export interface LaunchRunSummary extends LaunchRunRow {
  progress: LaunchProgress;
}

export interface ListLaunchRunsFilter {
  skill?: number;
  launch_id?: string;
  status?: string;
  client_slug?: string;
  host_shape?: string;
  limit?: number;
  offset?: number;
}

function stageRows(runId: string): LaunchStageRow[] {
  return queryAll<LaunchStageRow>(
    `SELECT stage, status, receipt_status FROM launch_run_stages WHERE run_id = ?`,
    [runId],
  );
}

function summarize(row: LaunchRunRow): LaunchRunSummary {
  const ability = getLaunchAbility(row.skill);
  const progress: LaunchProgress = ability
    ? computeLaunchProgress(ability, row.launch_id ?? row.run_id, stageRows(row.run_id))
    : {
        launch_id: row.launch_id ?? row.run_id,
        skill: row.skill,
        ability_slug: row.ability_slug,
        stages_closed: 0,
        stages_total: 0,
        build_percent: 0,
        blocked_stages: [],
        next_stage: null,
      };
  return { ...row, progress };
}

/** The database view could not be read. Never converted to an empty result. */
export class LaunchStoreUnavailableError extends Error {
  readonly code = 'launch_store_unavailable';
}

export interface LaunchRunsPage {
  runs: LaunchRunSummary[];
  total: number;
  /** `unavailable` means the database could not be read — NOT "no runs". */
  availability: 'ok' | 'unavailable';
  error?: string;
}

export function listLaunchRuns(filter: ListLaunchRunsFilter = {}): LaunchRunsPage {
  try {
    ensureLaunchSchema();
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.skill !== undefined) { where.push('skill = ?'); params.push(filter.skill); }
    if (filter.launch_id) { where.push('launch_id = ?'); params.push(filter.launch_id); }
    if (filter.status) { where.push('overall = ?'); params.push(filter.status); }
    if (filter.client_slug) { where.push('client_slug = ?'); params.push(filter.client_slug); }
    if (filter.host_shape) { where.push('host_shape = ?'); params.push(filter.host_shape); }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const totalRow = queryOne<{ n: number }>(
      `SELECT COUNT(*) AS n FROM launch_runs ${whereSql}`, params);
    const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200);
    const offset = Math.max(filter.offset ?? 0, 0);
    const rows = queryAll<LaunchRunRow>(
      `SELECT * FROM launch_runs ${whereSql}
       ORDER BY COALESCE(last_event_at, started_at, created_at) DESC
       LIMIT ? OFFSET ?`,
      [...params, limit, offset]);
    return {
      runs: rows.map(summarize),
      total: totalRow?.n ?? 0,
      availability: 'ok',
    };
  } catch (error) {
    return {
      runs: [],
      total: 0,
      availability: 'unavailable',
      error: error instanceof Error ? error.message : 'launch store unavailable',
    };
  }
}

export interface LaunchRunDetail {
  run: LaunchRunRow;
  progress: LaunchProgress;
  stages: Array<LaunchStageRow & { items: Record<string, unknown> }>;
}

export function getLaunchRun(runId: string): LaunchRunDetail | null {
  try {
    ensureLaunchSchema();
  } catch (error) {
    throw new LaunchStoreUnavailableError(
      error instanceof Error ? error.message : 'launch store unavailable',
    );
  }
  const row = queryOne<LaunchRunRow>(`SELECT * FROM launch_runs WHERE run_id = ?`, [runId]);
  if (!row) return null;
  let detailRows: Record<string, unknown>[];
  try {
    detailRows = queryAll<Record<string, unknown>>(
      `SELECT * FROM launch_run_stages WHERE run_id = ?`, [runId]);
  } catch (error) {
    throw new LaunchStoreUnavailableError(
      error instanceof Error ? error.message : 'launch stage store unavailable',
    );
  }
  const byStage = new Map(detailRows.map((r) => [r.stage as string, r]));
  const ability = getLaunchAbility(row.skill);
  const order = ability?.stageOrder ?? detailRows.map((r) => r.stage as string);
  const stages = order.map((stage) => {
    const r = byStage.get(stage);
    let items: Record<string, unknown> = {};
    if (typeof r?.items_json === 'string') {
      try { items = JSON.parse(r.items_json as string) as Record<string, unknown>; } catch { items = {}; }
    }
    return {
      stage,
      status: (r?.status as string) ?? 'not_run',
      receipt_status: (r?.receipt_status as string | null) ?? null,
      items,
    };
  });
  return {
    run: row,
    progress: summarize(row).progress,
    stages,
  };
}

// ---------------------------------------------------------------------------
// Progress samples — the launch progress contract, stored verbatim.
// `project_id` in the contract carries the launch plan's `launch_id`.
// ---------------------------------------------------------------------------

export type ProgressSampleOutcome =
  | { status: 'inserted' | 'duplicate' }
  | { status: 'rejected'; errors: string[] };

/**
 * Upsert one progress sample. Idempotent on (launch_id, room_id, observed_at)
 * ONLY when the bytes agree: a conflicting payload at the same key is
 * rejected, never allowed to overwrite the stored observation and inflate or
 * deflate completion.
 */
export function ingestProgressSample(
  sample: ProgressSample,
  stamp: LaunchIngestStamp = { source: 'file' },
): ProgressSampleOutcome {
  ensureLaunchSchema();
  const serialized = JSON.stringify(sample);
  const existing = queryOne<{ sample_json: string }>(
    `SELECT sample_json FROM launch_progress_samples
      WHERE launch_id = ? AND room_id = ? AND observed_at = ?`,
    [sample.project_id, sample.room_id, sample.observed_at],
  );
  if (existing) {
    if (existing.sample_json === serialized) return { status: 'duplicate' };
    return {
      status: 'rejected',
      errors: [
        `conflicting duplicate progress sample for launch "${sample.project_id}" room ` +
        `"${sample.room_id}" at ${sample.observed_at}; the stored sample is kept`,
      ],
    };
  }
  run(
    `INSERT INTO launch_progress_samples
       (launch_id, room_id, observed_at, build_percent, batch_merge_percent, batch_status,
        client_slug, host_shape, installation_id, sample_json, received_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [sample.project_id, sample.room_id, sample.observed_at,
     sample.build_percent, sample.batch_merge_percent, sample.batch_status,
     stamp.client_slug ?? null, stamp.host_shape ?? null, stamp.installation_id ?? null,
     serialized, nowIso()],
  );
  return { status: 'inserted' };
}

/**
 * Authenticated progress ingest: validate the sample against the launch
 * progress contract, then apply the token's client / host / installation as
 * provenance. A schema violation is a rejection; nothing is written.
 */
export function ingestAuthenticatedProgressSample(
  raw: unknown,
  token: LaunchIngestToken,
  source: string,
): ProgressSampleOutcome {
  const validation = validateProgressSample(raw);
  if (!validation.ok) return { status: 'rejected', errors: validation.errors };
  return ingestProgressSample(validation.sample, {
    client_slug: token.client_slug,
    host_shape: token.host_shape,
    installation_id: token.installation_id,
    source,
  });
}

export interface LaunchProgressRead {
  samples: Array<{ launch_id: string; room_id: string; observed_at: string; sample: ProgressSample }>;
  /** Rows whose stored JSON could not be read — reported, never dropped silently. */
  unavailable: Array<{ launch_id: string; room_id: string; observed_at: string; error: string }>;
}

/** Newest progress sample per room for one launch, newest first. */
export function getLaunchProgressSamples(launchId: string, limit = 20): LaunchProgressRead {
  ensureLaunchSchema();
  const rows = queryAll<{ launch_id: string; room_id: string; observed_at: string; sample_json: string }>(
    `SELECT launch_id, room_id, observed_at, sample_json
       FROM launch_progress_samples
      WHERE launch_id = ?
      ORDER BY observed_at DESC
      LIMIT ?`,
    [launchId, Math.min(Math.max(limit, 1), 200)],
  );
  const samples: LaunchProgressRead['samples'] = [];
  const unavailable: LaunchProgressRead['unavailable'] = [];
  for (const row of rows) {
    try {
      samples.push({
        launch_id: row.launch_id,
        room_id: row.room_id,
        observed_at: row.observed_at,
        sample: JSON.parse(row.sample_json) as ProgressSample,
      });
    } catch (error) {
      unavailable.push({
        launch_id: row.launch_id,
        room_id: row.room_id,
        observed_at: row.observed_at,
        error: error instanceof Error ? error.message : 'unreadable sample',
      });
    }
  }
  return { samples, unavailable };
}

/** Every registered ability with its latest runs — the registration surface. */
export function launchAbilityOverview(limitPerAbility = 5): Array<{
  ability: LaunchAbility;
  run_count: number;
  runs: LaunchRunSummary[];
}> {
  ensureLaunchSchema();
  return LAUNCH_ABILITIES.map((ability) => {
    const counts = queryOne<{ n: number }>(
      `SELECT COUNT(*) AS n FROM launch_runs WHERE skill = ?`, [ability.skill]);
    const { runs } = listLaunchRuns({ skill: ability.skill, limit: limitPerAbility });
    return { ability, run_count: counts?.n ?? 0, runs };
  });
}
