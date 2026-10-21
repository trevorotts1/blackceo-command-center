/**
 * launch-run-events.ts — pure validator for launch run events (WF-CC).
 *
 * The Command Center already ingests Skill 71 run events (frozen contract v1.0:
 * `71-blackceo-signature-page/references/run-events-schema.md` +
 * `run-events.schema.json`) through `src/lib/skill71-runs.ts`. Launch skills
 * emit the SAME event shape — same field names, same event types, same
 * per-type requirements — so runs and progress flow through the existing
 * patterns instead of a parallel one.
 *
 * Launch extensions (the only two fields the Skill 71 schema does not name):
 *   - `skill`     — which registered launch ability emitted the event (49/50/44/38/83);
 *   - `launch_id` — the U-CONTRACT launch identity
 *                   (`shared-utils/signature_launch_contract/launch-plan.schema.json`).
 *
 * Everything else is the frozen contract, unchanged. A field the contract does
 * not name is rejected, exactly as the Skill 71 validator does. Payload
 * discipline is the contract's: IDs, verdicts, timestamps, hashes, counts and
 * score aggregates only — never credentials, copy, prompt text or client PII.
 *
 * PURE module: no fs, no db, no node builtins beyond nothing at all, so the
 * validator can run on any surface and be unit-tested without a database.
 */

import { getLaunchAbility, isLaunchStage, type LaunchAbility } from './launch-abilities';

export const LAUNCH_EVENT_TYPES = [
  'run_initialized',
  'stage_closed',
  'stage_blocked',
  'item_closed',
  'item_blocked',
  'report_generated',
  'pin_drift',
] as const;

export type LaunchEventType = (typeof LAUNCH_EVENT_TYPES)[number];

/** Same host shapes the Skill 71 contract names. */
export const LAUNCH_HOST_SHAPES = ['fleet-mac', 'fleet-hostinger', 'fleet-contabo'] as const;
export type LaunchHostShape = (typeof LAUNCH_HOST_SHAPES)[number];

/** Same review modes the Skill 71 contract names. */
export const LAUNCH_REVIEW_MODES = ['INDEPENDENT', 'SELF-REVIEWED', 'UNKNOWN'] as const;
export type LaunchReviewMode = (typeof LAUNCH_REVIEW_MODES)[number];

export interface LaunchScoresSummary {
  criteria_count: number;
  min: number;
  mean: number;
}

export interface LaunchCost {
  provider: string;
  credits_used: number;
}

export interface LaunchRunEvent {
  // launch extensions
  skill: number;
  launch_id?: string;
  /** Launch extension: the installation that emitted the event. Optional on the
   *  wire; when present it must equal the receiving installation, and the HTTP
   *  transport rejects a contradiction instead of importing a foreign box's run. */
  installation_id?: string;
  // frozen run-events contract v1.0
  event_id: string;
  event_type: LaunchEventType;
  schema_version: string;
  emitted_at: string;
  run_id: string;
  run_dir?: string;
  host_shape?: LaunchHostShape;
  client_slug?: string;
  page_name?: string;
  brand_id?: string;
  client?: string;
  test_run?: boolean;
  stage?: string;
  receipt_status?: 'pass' | 'not_authorized';
  closed_at?: string;
  blocked_at?: string;
  duration_s?: number | null;
  scores_summary?: LaunchScoresSummary | null;
  cost?: LaunchCost | null;
  artifact_hashes?: Record<string, string>;
  review_files?: string[];
  failures?: string[];
  item_id?: string;
  artifact_hash?: string;
  overall?: 'complete' | 'incomplete' | 'test-run';
  review_mode?: LaunchReviewMode;
  report_json_path?: string;
  report_md_path?: string;
  authority_id?: string;
  pinned_sha?: string;
  observed_sha?: string | null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256_RE = /^[0-9a-f]{64}$/;
/** Same shape as `launch-plan.schema.json`'s launch_id (minLength 3). */
const LAUNCH_ID_RE = /^[a-z0-9][a-z0-9-]{2,}$/;
const DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

const ALLOWED_KEYS = new Set<string>([
  // launch extensions
  'skill', 'launch_id', 'installation_id',
  // frozen contract
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

export type LaunchValidationResult =
  | { ok: true; event: LaunchRunEvent; ability: LaunchAbility }
  | { ok: false; errors: string[] };

/**
 * Validate one launch run event against the frozen contract plus the ability's
 * declared stage order. Fail-closed: anything the contract does not name, a
 * missing `skill`, or a stage the ability does not declare is a rejection.
 */
export function validateLaunchRunEvent(raw: unknown): LaunchValidationResult {
  const errors: string[] = [];
  if (!isPlainObject(raw)) {
    return { ok: false, errors: ['event is not a JSON object'] };
  }
  for (const key of Object.keys(raw)) {
    if (!ALLOWED_KEYS.has(key)) errors.push(`unknown field: ${key}`);
  }
  const e = raw as Record<string, unknown>;

  const ability = getLaunchAbility(
    typeof e.skill === 'number' || typeof e.skill === 'string' ? e.skill : null,
  );
  if (!ability) {
    errors.push('skill must be one of the registered launch abilities (49, 50, 44, 38, 83)');
  }

  if (typeof e.event_id !== 'string' || !UUID_RE.test(e.event_id)) errors.push('event_id must be a UUID');
  if (typeof e.run_id !== 'string' || !UUID_RE.test(e.run_id)) errors.push('run_id must be a UUID');
  if (e.schema_version !== '1.0') errors.push('schema_version must be "1.0"');
  if (!isDateTime(e.emitted_at)) errors.push('emitted_at must be an ISO-8601 date-time');
  if (typeof e.event_type !== 'string' || !(LAUNCH_EVENT_TYPES as readonly string[]).includes(e.event_type)) {
    errors.push(`event_type must be one of ${LAUNCH_EVENT_TYPES.join(', ')}`);
    return { ok: false, errors };
  }
  const type = e.event_type as LaunchEventType;

  const optString = (k: string) => {
    if (e[k] !== undefined && typeof e[k] !== 'string') errors.push(`${k} must be a string`);
  };
  ['launch_id', 'installation_id', 'run_dir', 'client_slug', 'page_name', 'brand_id', 'client', 'stage', 'item_id',
   'report_json_path', 'report_md_path', 'authority_id', 'pinned_sha'].forEach(optString);
  if (typeof e.launch_id === 'string' && !LAUNCH_ID_RE.test(e.launch_id)) {
    errors.push('launch_id must be a lowercase slug matching the launch-plan contract');
  }

  if (e.host_shape !== undefined &&
      !(LAUNCH_HOST_SHAPES as readonly string[]).includes(e.host_shape as string)) {
    errors.push('host_shape is not a known fleet shape');
  }
  if (e.test_run !== undefined && typeof e.test_run !== 'boolean') errors.push('test_run must be a boolean');
  if (e.stage !== undefined) {
    if (ability && !isLaunchStage(ability, e.stage)) {
      errors.push(
        `stage "${String(e.stage)}" is not in Skill ${ability.skill}'s declared stage order ` +
        `(${ability.stageOrder.join(', ')})`,
      );
    }
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
  if (e.artifact_hash !== undefined &&
      (typeof e.artifact_hash !== 'string' || !SHA256_RE.test(e.artifact_hash))) {
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
  if (e.review_mode !== undefined &&
      !(LAUNCH_REVIEW_MODES as readonly string[]).includes(e.review_mode as string)) {
    errors.push('review_mode must be INDEPENDENT, SELF-REVIEWED, or UNKNOWN');
  }

  // Per-type required fields — identical to the frozen contract's allOf clauses.
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

  if (errors.length || !ability) return { ok: false, errors };
  return { ok: true, event: e as unknown as LaunchRunEvent, ability };
}

// ---------------------------------------------------------------------------
// Authenticated transport binding
// ---------------------------------------------------------------------------

/**
 * What a verified per-client ingest token proves: the client slug, the fleet
 * host shape, and THIS installation's id. Nothing else about the event is
 * trusted before this comparison.
 */
export interface LaunchIngestToken {
  client_slug: string;
  host_shape: LaunchHostShape;
  installation_id: string;
}

/**
 * An event whose claimed client slug, host shape or installation contradicts
 * the authenticated token is rejected. Absent claims are filled from the token
 * by the ingestion stamp; a CONTRADICTION is never a fill-in.
 */
export function launchEventContradictsToken(
  event: LaunchRunEvent,
  token: LaunchIngestToken,
): string | null {
  if (event.client_slug !== undefined && event.client_slug !== token.client_slug) {
    return `client_slug ${event.client_slug} contradicts the token's ${token.client_slug}`;
  }
  if (event.host_shape !== undefined && event.host_shape !== token.host_shape) {
    return `host_shape ${event.host_shape} contradicts the token's ${token.host_shape}`;
  }
  if (event.installation_id !== undefined && event.installation_id !== token.installation_id) {
    return `installation_id ${event.installation_id} contradicts this installation's ${token.installation_id}`;
  }
  return null;
}

