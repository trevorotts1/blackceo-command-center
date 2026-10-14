/**
 * skill71-runs.ts: Skill 71 (blackceo-signature-page) run tracking.
 *
 * The Command Center half of fix plan Items 24–26. Skill 71's stage gate
 * and swarm runner emit factual run events (run-events contract, FROZEN
 * v1.0: onboarding repo, 71-blackceo-signature-page/references/
 * run-events-schema.md + run-events.schema.json). This module is the ONE
 * ingestion core both transports feed:
 *
 *   - file transport : scripts/import-skill71-runs.ts reads the host
 *     index files (fleet-contabo: /srv/skill71-runs/<client>/runs.jsonl,
 *     aggregated on the host by per-client bind mounts);
 *   - HTTP transport : POST /api/skill-runs/ingest (fleet-hostinger push;
 *     fleet-mac only when that deployment opted in), authenticated by a
 *     per-client bearer token whose record binds client_slug + host_shape.
 *
 * Ingestion is: validate against the frozen schema → dedupe by event_id
 * → upsert the run record with the latest event state. It is idempotent
 * (re-importing the same lines changes nothing) and read-only with
 * respect to run folders: nothing here ever writes outside the CC
 * database.
 *
 * Payload discipline (from the frozen contract): events carry IDs,
 * verdicts, timestamps, hashes, counts, and score aggregates only. No
 * credential values, no page copy, no prompt text, no review notes, no
 * client PII. The validator below rejects any line carrying a field the
 * schema does not name.
 *
 * Tables (schema.ts + migration 171, see DB-CHANGES.md in the build
 * tree): skill71_runs, skill71_run_stages, skill71_run_events,
 * skill71_ingest_tokens.
 */

import { createHash } from 'crypto';
import { queryAll, queryOne, run, transaction } from '@/lib/db';

/**
 * The 13 stages, mirroring references/stage-contract.json `stage_order`
 * in the Skill 71 folder. If the contract's stage order changes, this
 * list changes with it (the panel renders progress against it).
 */
export const SKILL71_STAGE_ORDER = [
  'intake',
  'copy',
  'font-action-plan',
  'desktop-wireframe',
  'mobile-tablet',
  'visual-mockup',
  'image-inventory-prompts',
  'image-generation-qc',
  'image-map-upload',
  'final-mockups',
  'responsive-html',
  'ghl-install-test',
  'publish-verify',
  'automation-wiring',
] as const;

export const SKILL71_EVENT_TYPES = [
  'run_initialized',
  'stage_closed',
  'stage_blocked',
  'item_closed',
  'item_blocked',
  'report_generated',
  'pin_drift',
] as const;

export const SKILL71_HOST_SHAPES = ['fleet-mac', 'fleet-hostinger', 'fleet-contabo'] as const;
export const SKILL71_REVIEW_MODES = ['INDEPENDENT', 'SELF-REVIEWED', 'UNKNOWN'] as const;

export type Skill71EventType = (typeof SKILL71_EVENT_TYPES)[number];
export type Skill71HostShape = (typeof SKILL71_HOST_SHAPES)[number];
export type Skill71ReviewMode = (typeof SKILL71_REVIEW_MODES)[number];

export interface Skill71ScoresSummary {
  criteria_count: number;
  min: number;
  mean: number;
}

export interface Skill71Cost {
  provider: string;
  credits_used: number;
}

export interface Skill71Event {
  event_id: string;
  event_type: Skill71EventType;
  schema_version: string;
  emitted_at: string;
  run_id: string;
  run_dir?: string;
  host_shape?: Skill71HostShape;
  client_slug?: string;
  // run_initialized
  page_name?: string;
  brand_id?: string;
  client?: string;
  test_run?: boolean;
  // stage events
  stage?: string;
  receipt_status?: 'pass' | 'not_authorized';
  closed_at?: string;
  blocked_at?: string;
  duration_s?: number | null;
  scores_summary?: Skill71ScoresSummary | null;
  cost?: Skill71Cost | null;
  artifact_hashes?: Record<string, string>;
  review_files?: string[];
  failures?: string[];
  // item events
  item_id?: string;
  artifact_hash?: string;
  // report_generated
  overall?: 'complete' | 'incomplete' | 'test-run';
  review_mode?: Skill71ReviewMode;
  report_json_path?: string;
  report_md_path?: string;
  // pin_drift
  authority_id?: string;
  pinned_sha?: string;
  observed_sha?: string | null;
}

// ---------------------------------------------------------------------------
// Validation: a hand-rolled mirror of the frozen run-events.schema.json.
// Keep the two in lockstep: a field the schema does not name is rejected.
// ---------------------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256_RE = /^[0-9a-f]{64}$/;
const DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

const ALLOWED_KEYS = new Set([
  'event_id', 'event_type', 'schema_version', 'emitted_at', 'run_id', 'run_dir',
  'host_shape', 'client_slug', 'page_name', 'brand_id', 'client', 'test_run',
  'stage', 'receipt_status', 'closed_at', 'blocked_at', 'duration_s',
  'scores_summary', 'cost', 'artifact_hashes', 'review_files', 'failures',
  'item_id', 'artifact_hash', 'overall', 'review_mode', 'report_json_path',
  'report_md_path', 'authority_id', 'pinned_sha', 'observed_sha',
]);

function isDateTime(v: unknown): v is string {
  return typeof v === 'string' && DATETIME_RE.test(v) && !Number.isNaN(Date.parse(v));
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export type ValidationResult =
  | { ok: true; event: Skill71Event }
  | { ok: false; errors: string[] };

export function validateSkill71Event(raw: unknown): ValidationResult {
  const errors: string[] = [];
  if (!isPlainObject(raw)) {
    return { ok: false, errors: ['event is not a JSON object'] };
  }
  for (const key of Object.keys(raw)) {
    if (!ALLOWED_KEYS.has(key)) errors.push(`unknown field: ${key}`);
  }
  const e = raw as Record<string, unknown>;

  if (typeof e.event_id !== 'string' || !UUID_RE.test(e.event_id)) errors.push('event_id must be a UUID');
  if (typeof e.run_id !== 'string' || !UUID_RE.test(e.run_id)) errors.push('run_id must be a UUID');
  if (e.schema_version !== '1.0') errors.push('schema_version must be "1.0"');
  if (!isDateTime(e.emitted_at)) errors.push('emitted_at must be an ISO-8601 date-time');
  if (typeof e.event_type !== 'string' || !(SKILL71_EVENT_TYPES as readonly string[]).includes(e.event_type)) {
    errors.push(`event_type must be one of ${SKILL71_EVENT_TYPES.join(', ')}`);
    return { ok: false, errors };
  }
  const type = e.event_type as Skill71EventType;

  const optString = (k: string) => {
    if (e[k] !== undefined && typeof e[k] !== 'string') errors.push(`${k} must be a string`);
  };
  ['run_dir', 'client_slug', 'page_name', 'brand_id', 'client', 'stage', 'item_id',
   'report_json_path', 'report_md_path', 'authority_id', 'pinned_sha'].forEach(optString);
  if (e.host_shape !== undefined && !(SKILL71_HOST_SHAPES as readonly string[]).includes(e.host_shape as string)) {
    errors.push('host_shape is not a known fleet shape');
  }
  if (e.test_run !== undefined && typeof e.test_run !== 'boolean') errors.push('test_run must be a boolean');
  if (e.stage !== undefined && !(SKILL71_STAGE_ORDER as readonly string[]).includes(e.stage as string)) {
    errors.push('stage is not in the stage contract order');
  }
  if (e.receipt_status !== undefined && !['pass', 'not_authorized'].includes(e.receipt_status as string)) {
    errors.push('receipt_status must be pass or not_authorized');
  }
  if (e.closed_at !== undefined && !isDateTime(e.closed_at)) errors.push('closed_at must be a date-time');
  if (e.blocked_at !== undefined && !isDateTime(e.blocked_at)) errors.push('blocked_at must be a date-time');
  if (e.duration_s !== undefined && e.duration_s !== null &&
      (typeof e.duration_s !== 'number' || (e.duration_s as number) < 0)) {
    errors.push('duration_s must be a non-negative number or null');
  }
  if (e.artifact_hash !== undefined && (typeof e.artifact_hash !== 'string' || !SHA256_RE.test(e.artifact_hash))) {
    errors.push('artifact_hash must be a SHA-256 hex string');
  }
  if (e.observed_sha !== undefined && e.observed_sha !== null && typeof e.observed_sha !== 'string') {
    errors.push('observed_sha must be a string or null');
  }
  if (e.failures !== undefined &&
      (!Array.isArray(e.failures) || e.failures.some((f) => typeof f !== 'string'))) {
    errors.push('failures must be an array of strings');
  }
  if (e.review_files !== undefined &&
      (!Array.isArray(e.review_files) || e.review_files.some((f) => typeof f !== 'string'))) {
    errors.push('review_files must be an array of strings');
  }
  if (e.artifact_hashes !== undefined) {
    if (!isPlainObject(e.artifact_hashes)) {
      errors.push('artifact_hashes must be an object');
    } else {
      for (const [k, v] of Object.entries(e.artifact_hashes)) {
        if (typeof v !== 'string' || !SHA256_RE.test(v)) errors.push(`artifact_hashes.${k} must be SHA-256 hex`);
      }
    }
  }
  if (e.scores_summary !== undefined && e.scores_summary !== null) {
    const s = e.scores_summary;
    if (!isPlainObject(s)) {
      errors.push('scores_summary must be an object or null');
    } else {
      const keys = Object.keys(s).sort().join(',');
      if (keys !== 'criteria_count,mean,min') errors.push('scores_summary must carry exactly criteria_count, min, mean');
      if (typeof s.criteria_count !== 'number' || !Number.isInteger(s.criteria_count) || (s.criteria_count as number) < 1) {
        errors.push('scores_summary.criteria_count must be a positive integer');
      }
      if (typeof s.min !== 'number' || typeof s.mean !== 'number') errors.push('scores_summary.min/mean must be numbers');
    }
  }
  if (e.cost !== undefined && e.cost !== null) {
    const c = e.cost;
    if (!isPlainObject(c)) {
      errors.push('cost must be an object or null');
    } else {
      const keys = Object.keys(c).sort().join(',');
      if (keys !== 'credits_used,provider') errors.push('cost must carry exactly provider, credits_used');
      if (typeof c.provider !== 'string' || typeof c.credits_used !== 'number') {
        errors.push('cost.provider must be a string and cost.credits_used a number');
      }
    }
  }
  if (e.overall !== undefined && !['complete', 'incomplete', 'test-run'].includes(e.overall as string)) {
    errors.push('overall must be complete, incomplete, or test-run');
  }
  if (e.review_mode !== undefined && !(SKILL71_REVIEW_MODES as readonly string[]).includes(e.review_mode as string)) {
    errors.push('review_mode must be INDEPENDENT, SELF-REVIEWED, or UNKNOWN');
  }

  // Per-type required fields (the schema's allOf clauses).
  const requireFields = (fields: string[]) => {
    for (const f of fields) if (e[f] === undefined) errors.push(`${type} requires ${f}`);
  };
  switch (type) {
    case 'run_initialized': requireFields(['host_shape']); break;
    case 'stage_closed': requireFields(['stage', 'receipt_status', 'closed_at']); break;
    case 'stage_blocked': requireFields(['stage', 'failures', 'blocked_at']); break;
    case 'item_closed': requireFields(['stage', 'item_id', 'closed_at']); break;
    case 'item_blocked': requireFields(['stage', 'item_id', 'failures', 'blocked_at']); break;
    case 'report_generated': requireFields(['overall', 'review_mode', 'report_json_path']); break;
    case 'pin_drift': requireFields(['authority_id', 'pinned_sha', 'observed_sha']); break;
  }

  if (errors.length) return { ok: false, errors };
  return { ok: true, event: e as unknown as Skill71Event };
}

// ---------------------------------------------------------------------------
// Ingestion core: validate → dedupe by event_id → upsert latest run state.
// ---------------------------------------------------------------------------

export interface IngestOutcome {
  status: 'inserted' | 'duplicate';
  event_id: string;
}

export interface IngestStamp {
  /** Transport provenance (HTTP ingest): applied to run_initialized when the
   *  event itself omits the fields. File transport passes nothing. */
  client_slug?: string;
  host_shape?: Skill71HostShape;
  source: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

export function ingestSkill71Event(event: Skill71Event, stamp: IngestStamp): IngestOutcome {
  let outcome: IngestOutcome = { status: 'inserted', event_id: event.event_id };
  transaction(() => {
    const inserted = run(
      `INSERT OR IGNORE INTO skill71_run_events
         (event_id, run_id, event_type, emitted_at, source, payload_json, received_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [event.event_id, event.run_id, event.event_type, event.emitted_at,
       stamp.source, JSON.stringify(event), nowIso()],
    );
    if (inserted.changes === 0) {
      outcome = { status: 'duplicate', event_id: event.event_id };
      return;
    }
    applyEvent(event, stamp);
  });
  return outcome;
}

function touchRun(event: Skill71Event) {
  run(
    `INSERT INTO skill71_runs (run_id, overall, started_at, last_event_at, created_at, updated_at)
     VALUES (?, 'incomplete', ?, ?, ?, ?)
     ON CONFLICT(run_id) DO UPDATE SET
       last_event_at = MAX(COALESCE(skill71_runs.last_event_at, ''), excluded.last_event_at),
       updated_at = excluded.updated_at`,
    [event.run_id, event.emitted_at, event.emitted_at, nowIso(), nowIso()],
  );
}

function applyEvent(event: Skill71Event, stamp: IngestStamp) {
  touchRun(event);
  switch (event.event_type) {
    case 'run_initialized': {
      run(
        `UPDATE skill71_runs SET
           page_name = COALESCE(?, page_name),
           brand_id = COALESCE(?, brand_id),
           client = COALESCE(?, client),
           client_slug = COALESCE(?, client_slug),
           host_shape = COALESCE(?, host_shape),
           run_dir = COALESCE(?, run_dir),
           test_run = COALESCE(?, test_run),
           started_at = COALESCE(started_at, ?),
           updated_at = ?
         WHERE run_id = ?`,
        [event.page_name ?? null, event.brand_id ?? null, event.client ?? null,
         event.client_slug ?? stamp.client_slug ?? null,
         event.host_shape ?? stamp.host_shape ?? null,
         event.run_dir ?? null,
         event.test_run === undefined ? null : event.test_run ? 1 : 0,
         event.emitted_at, nowIso(), event.run_id],
      );
      break;
    }
    case 'stage_closed': {
      run(
        `INSERT INTO skill71_run_stages
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
        `UPDATE skill71_runs SET blocked_stage = NULL
         WHERE run_id = ? AND blocked_stage = ?`,
        [event.run_id, event.stage],
      );
      break;
    }
    case 'stage_blocked': {
      // A blocked close after a successful close does not unclose the stage:
      // the close record stands; the refusal is still in the event log.
      run(
        `INSERT INTO skill71_run_stages
           (run_id, stage, status, receipt_status, failures_json, updated_at)
         VALUES (?, ?, 'blocked', NULL, ?, ?)
         ON CONFLICT(run_id, stage) DO UPDATE SET
           status = 'blocked', failures_json = excluded.failures_json,
           updated_at = excluded.updated_at
         WHERE skill71_run_stages.status != 'closed'`,
        [event.run_id, event.stage, JSON.stringify(event.failures ?? []), nowIso()],
      );
      run(
        `UPDATE skill71_runs SET blocked_stage = ?
         WHERE run_id = ? AND NOT EXISTS (
           SELECT 1 FROM skill71_run_stages
           WHERE run_id = ? AND stage = ? AND status = 'closed')`,
        [event.stage, event.run_id, event.run_id, event.stage],
      );
      break;
    }
    case 'item_closed':
    case 'item_blocked': {
      const row = queryOne<{ items_json: string }>(
        `SELECT items_json FROM skill71_run_stages WHERE run_id = ? AND stage = ?`,
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
        `INSERT INTO skill71_run_stages (run_id, stage, status, items_json, updated_at)
         VALUES (?, ?, 'open', ?, ?)
         ON CONFLICT(run_id, stage) DO UPDATE SET
           items_json = excluded.items_json, updated_at = excluded.updated_at`,
        [event.run_id, event.stage, JSON.stringify(items), nowIso()],
      );
      break;
    }
    case 'report_generated': {
      run(
        `UPDATE skill71_runs SET
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
      // No run-state change: the drift is a fact about the host's skills
      // tree. The event row itself (payload_json) is the record.
      break;
    }
  }
}

// ---------------------------------------------------------------------------
// Queries: the board reads the database only, never run folders.
// ---------------------------------------------------------------------------

export interface Skill71RunRow {
  run_id: string;
  page_name: string | null;
  brand_id: string | null;
  client: string | null;
  client_slug: string | null;
  host_shape: string | null;
  run_dir: string | null;
  test_run: number;
  overall: string;
  review_mode: string | null;
  report_json_path: string | null;
  report_md_path: string | null;
  blocked_stage: string | null;
  started_at: string | null;
  last_event_at: string | null;
}

export interface Skill71StageRow {
  stage: string;
  status: string;
  receipt_status: string | null;
  closed_at: string | null;
  duration_s: number | null;
  scores_summary: Skill71ScoresSummary | null;
  cost: Skill71Cost | null;
  artifact_hashes: Record<string, string> | null;
  failures: string[] | null;
  items: Record<string, unknown>;
}

export interface Skill71RunSummary extends Skill71RunRow {
  stages_closed: number;
  stages_total: number;
  cost_by_provider: Record<string, number>;
  review_flag: 'SELF-REVIEWED' | 'UNKNOWN' | null;
}

function parseJson<T>(v: string | null): T | null {
  if (!v) return null;
  try { return JSON.parse(v) as T; } catch { return null; }
}

function stageRowFromDb(r: Record<string, unknown>): Skill71StageRow {
  return {
    stage: r.stage as string,
    status: r.status as string,
    receipt_status: (r.receipt_status as string) ?? null,
    closed_at: (r.closed_at as string) ?? null,
    duration_s: (r.duration_s as number) ?? null,
    scores_summary: parseJson<Skill71ScoresSummary>(r.scores_summary_json as string),
    cost: parseJson<Skill71Cost>(r.cost_json as string),
    artifact_hashes: parseJson<Record<string, string>>(r.artifact_hashes_json as string),
    failures: parseJson<string[]>(r.failures_json as string),
    items: parseJson<Record<string, unknown>>(r.items_json as string) ?? {},
  };
}

export function reviewFlagFor(mode: string | null): 'SELF-REVIEWED' | 'UNKNOWN' | null {
  if (mode === 'SELF-REVIEWED') return 'SELF-REVIEWED';
  if (mode === 'UNKNOWN') return 'UNKNOWN';
  return null;
}

export interface ListSkill71RunsFilter {
  overall?: string;
  brand_id?: string;
  client?: string;
  host_shape?: string;
  client_slug?: string;
  limit?: number;
  offset?: number;
}

export function listSkill71Runs(filter: ListSkill71RunsFilter = {}): { runs: Skill71RunSummary[]; total: number } {
  const where: string[] = [];
  const params: unknown[] = [];
  if (filter.overall) { where.push('overall = ?'); params.push(filter.overall); }
  if (filter.brand_id) { where.push('brand_id = ?'); params.push(filter.brand_id); }
  if (filter.client) { where.push('client = ?'); params.push(filter.client); }
  if (filter.host_shape) { where.push('host_shape = ?'); params.push(filter.host_shape); }
  if (filter.client_slug) { where.push('client_slug = ?'); params.push(filter.client_slug); }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const totalRow = queryOne<{ n: number }>(
    `SELECT COUNT(*) AS n FROM skill71_runs ${whereSql}`, params);
  const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200);
  const offset = Math.max(filter.offset ?? 0, 0);
  const rows = queryAll<Skill71RunRow>(
    `SELECT * FROM skill71_runs ${whereSql}
     ORDER BY COALESCE(last_event_at, started_at, created_at) DESC
     LIMIT ? OFFSET ?`,
    [...params, limit, offset]);
  const runs = rows.map((r) => {
    const stageRows = queryAll<Record<string, unknown>>(
      `SELECT * FROM skill71_run_stages WHERE run_id = ?`, [r.run_id]);
    const stages = stageRows.map(stageRowFromDb);
    const cost: Record<string, number> = {};
    for (const s of stages) {
      if (s.cost) cost[s.cost.provider] = (cost[s.cost.provider] ?? 0) + s.cost.credits_used;
    }
    return {
      ...r,
      stages_closed: stages.filter((s) => s.status === 'closed').length,
      stages_total: SKILL71_STAGE_ORDER.length,
      cost_by_provider: cost,
      review_flag: reviewFlagFor(r.review_mode),
    };
  });
  return { runs, total: totalRow?.n ?? 0 };
}

export function getSkill71Run(runId: string):
  | { run: Skill71RunRow; stages: Skill71StageRow[] }
  | null {
  const row = queryOne<Skill71RunRow>(`SELECT * FROM skill71_runs WHERE run_id = ?`, [runId]);
  if (!row) return null;
  const stageRows = queryAll<Record<string, unknown>>(
    `SELECT * FROM skill71_run_stages WHERE run_id = ?`, [runId]);
  const byStage = new Map(stageRows.map((r) => [(r.stage as string), stageRowFromDb(r)]));
  const stages = SKILL71_STAGE_ORDER.map((stage) =>
    byStage.get(stage) ?? {
      stage, status: 'not_run', receipt_status: null, closed_at: null,
      duration_s: null, scores_summary: null, cost: null,
      artifact_hashes: null, failures: null, items: {},
    });
  return { run: row, stages };
}

// ---------------------------------------------------------------------------
// Ingest tokens (HTTP transport): per-client, slug/shape bound.
// The database stores only the SHA-256 hash of each token; the token value
// lives on the client box, in its own secrets (fix plan Amendment 4
// doctrine: credentials stay with the install that owns them).
// ---------------------------------------------------------------------------

export interface Skill71IngestToken {
  client_slug: string;
  host_shape: Skill71HostShape;
}

export function verifySkill71IngestToken(bearer: string | null): Skill71IngestToken | null {
  if (!bearer) return null;
  const hash = createHash('sha256').update(bearer).digest('hex');
  const row = queryOne<{ client_slug: string; host_shape: string }>(
    `SELECT client_slug, host_shape FROM skill71_ingest_tokens
     WHERE token_hash = ? AND revoked_at IS NULL`, [hash]);
  if (!row) return null;
  return { client_slug: row.client_slug, host_shape: row.host_shape as Skill71HostShape };
}

/** An event whose claimed slug or shape contradicts its token is rejected. */
export function eventContradictsToken(event: Skill71Event, token: Skill71IngestToken): string | null {
  if (event.client_slug !== undefined && event.client_slug !== token.client_slug) {
    return `client_slug ${event.client_slug} contradicts the token's ${token.client_slug}`;
  }
  if (event.host_shape !== undefined && event.host_shape !== token.host_shape) {
    return `host_shape ${event.host_shape} contradicts the token's ${token.host_shape}`;
  }
  return null;
}
