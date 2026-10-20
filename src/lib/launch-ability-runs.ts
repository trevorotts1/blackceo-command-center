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
 * client_slug + host_shape.
 *
 * Tables are provisioned lazily (`CREATE TABLE IF NOT EXISTS`) so this lane
 * adds new FILES only. ponytail: lazy DDL instead of a numbered migration;
 * fold into `src/lib/db/migrations.ts` (next free id) when the integrator edits
 * shared files, then drop `ensureLaunchRunSchema`.
 */

import { queryAll, queryOne, run, transaction } from '@/lib/db';
import {
  LAUNCH_ABILITIES,
  computeLaunchProgress,
  getLaunchAbility,
  type LaunchAbility,
  type LaunchProgress,
  type LaunchStageRow,
  type ProgressSample,
} from '@/lib/launch-abilities';
import type {
  LaunchHostShape,
  LaunchRunEvent,
} from '@/lib/launch-run-events';

const LAUNCH_RUN_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS launch_runs (
  run_id TEXT PRIMARY KEY,
  skill INTEGER NOT NULL,
  ability_slug TEXT NOT NULL,
  launch_id TEXT,
  client_slug TEXT,
  host_shape TEXT,
  run_dir TEXT,
  overall TEXT NOT NULL DEFAULT 'incomplete',
  review_mode TEXT,
  report_json_path TEXT,
  report_md_path TEXT,
  blocked_stage TEXT,
  started_at TEXT,
  last_event_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_launch_runs_skill ON launch_runs(skill);
CREATE INDEX IF NOT EXISTS idx_launch_runs_launch ON launch_runs(launch_id);

CREATE TABLE IF NOT EXISTS launch_run_stages (
  run_id TEXT NOT NULL,
  stage TEXT NOT NULL,
  status TEXT NOT NULL,
  receipt_status TEXT,
  closed_at TEXT,
  blocked_at TEXT,
  duration_s REAL,
  scores_summary_json TEXT,
  cost_json TEXT,
  artifact_hashes_json TEXT,
  failures_json TEXT,
  items_json TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (run_id, stage)
);

CREATE TABLE IF NOT EXISTS launch_run_events (
  event_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  skill INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  emitted_at TEXT NOT NULL,
  source TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  received_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_launch_run_events_run ON launch_run_events(run_id);

CREATE TABLE IF NOT EXISTS launch_progress_samples (
  launch_id TEXT NOT NULL,
  room_id TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  build_percent REAL NOT NULL,
  batch_merge_percent REAL NOT NULL,
  batch_status TEXT NOT NULL,
  sample_json TEXT NOT NULL,
  received_at TEXT NOT NULL,
  PRIMARY KEY (launch_id, room_id, observed_at)
);
`;

let schemaReady = false;

/** Provision this lane's tables on first use. Idempotent and safe to call
 *  from every entry point (the DB handle itself is the process singleton). */
export function ensureLaunchRunSchema(): void {
  if (schemaReady) return;
  transaction(() => {
    const db = queryAll<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'launch_runs'`,
    );
    if (db.length > 0) return;
    // `run` executes one statement; split the DDL so each statement is prepared
    // on its own (better-sqlite3 refuses multi-statement prepare).
    for (const statement of LAUNCH_RUN_SCHEMA_SQL.split(';')
      .map((s) => s.trim())
      .filter(Boolean)) {
      run(`${statement};`);
    }
  });
  schemaReady = true;
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
  source: string;
}

/**
 * Ingest one validated launch run event. Dedupe is by `event_id`, exactly as
 * the Skill 71 core does, so an at-least-once shipper can safely re-send.
 */
export function ingestLaunchRunEvent(
  event: LaunchRunEvent,
  ability: LaunchAbility,
  stamp: LaunchIngestStamp,
): LaunchIngestOutcome {
  ensureLaunchRunSchema();
  let outcome: LaunchIngestOutcome = { status: 'inserted', event_id: event.event_id };
  transaction(() => {
    const inserted = run(
      `INSERT OR IGNORE INTO launch_run_events
         (event_id, run_id, skill, event_type, emitted_at, source, payload_json, received_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [event.event_id, event.run_id, ability.skill, event.event_type, event.emitted_at,
       stamp.source, JSON.stringify(event), nowIso()],
    );
    if (inserted.changes === 0) {
      outcome = { status: 'duplicate', event_id: event.event_id };
      return;
    }
    applyLaunchEvent(event, ability, stamp);
  });
  return outcome;
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
           run_dir = COALESCE(?, run_dir),
           started_at = COALESCE(started_at, ?),
           updated_at = ?
         WHERE run_id = ?`,
        [event.launch_id ?? null,
         event.client_slug ?? stamp.client_slug ?? null,
         event.host_shape ?? stamp.host_shape ?? null,
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
           failures_json = NULL, updated_at = excluded.updated_at`,
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

export function listLaunchRuns(
  filter: ListLaunchRunsFilter = {},
): { runs: LaunchRunSummary[]; total: number } {
  ensureLaunchRunSchema();
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
  return { runs: rows.map(summarize), total: totalRow?.n ?? 0 };
}

export interface LaunchRunDetail {
  run: LaunchRunRow;
  progress: LaunchProgress;
  stages: Array<LaunchStageRow & { items: Record<string, unknown> }>;
}

export function getLaunchRun(runId: string): LaunchRunDetail | null {
  ensureLaunchRunSchema();
  const row = queryOne<LaunchRunRow>(`SELECT * FROM launch_runs WHERE run_id = ?`, [runId]);
  if (!row) return null;
  const ability = getLaunchAbility(row.skill);
  const detailRows = queryAll<Record<string, unknown>>(
    `SELECT * FROM launch_run_stages WHERE run_id = ?`, [runId]);
  const byStage = new Map(detailRows.map((r) => [r.stage as string, r]));
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

/** Upsert one progress sample. Idempotent on (launch_id, room_id, observed_at). */
export function ingestProgressSample(sample: ProgressSample): void {
  ensureLaunchRunSchema();
  run(
    `INSERT INTO launch_progress_samples
       (launch_id, room_id, observed_at, build_percent, batch_merge_percent, batch_status, sample_json, received_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(launch_id, room_id, observed_at) DO UPDATE SET
       build_percent = excluded.build_percent,
       batch_merge_percent = excluded.batch_merge_percent,
       batch_status = excluded.batch_status,
       sample_json = excluded.sample_json,
       received_at = excluded.received_at`,
    [sample.project_id, sample.room_id, sample.observed_at,
     sample.build_percent, sample.batch_merge_percent, sample.batch_status,
     JSON.stringify(sample), nowIso()],
  );
}

/** Newest progress sample per room for one launch, newest first. */
export function getLaunchProgressSamples(
  launchId: string,
  limit = 20,
): Array<{ launch_id: string; room_id: string; observed_at: string; sample: ProgressSample }> {
  ensureLaunchRunSchema();
  const rows = queryAll<{ launch_id: string; room_id: string; observed_at: string; sample_json: string }>(
    `SELECT launch_id, room_id, observed_at, sample_json
       FROM launch_progress_samples
      WHERE launch_id = ?
      ORDER BY observed_at DESC
      LIMIT ?`,
    [launchId, Math.min(Math.max(limit, 1), 200)],
  );
  return rows.map((r) => ({
    launch_id: r.launch_id,
    room_id: r.room_id,
    observed_at: r.observed_at,
    sample: JSON.parse(r.sample_json) as ProgressSample,
  }));
}

/** Every registered ability with its latest runs — the registration surface. */
export function launchAbilityOverview(limitPerAbility = 5): Array<{
  ability: LaunchAbility;
  run_count: number;
  runs: LaunchRunSummary[];
}> {
  ensureLaunchRunSchema();
  return LAUNCH_ABILITIES.map((ability) => {
    const counts = queryOne<{ n: number }>(
      `SELECT COUNT(*) AS n FROM launch_runs WHERE skill = ?`, [ability.skill]);
    const { runs } = listLaunchRuns({ skill: ability.skill, limit: limitPerAbility });
    return { ability, run_count: counts?.n ?? 0, runs };
  });
}
