/**
 * launch-storage.ts — explicit adapter + typed discovery for launch storage.
 *
 * TWO VIEWS, ONE CONTRACT:
 *   disk view      — `<launch>.plan.json` (approved plan) + `<launch>.progress.json`
 *                    (WF-SWARM resumable progress). Owned by the launch skills.
 *   database view  — validated run events ingested from the fleet (skill 49/50/
 *                    44/38/83) into launch_runs / launch_run_stages.
 *
 * They answer DIFFERENT questions and neither silently replaces the other:
 * the disk view says what the plan contains and how far the producer got; the
 * database view says which stages a skill actually closed with a pass receipt.
 * `relateLaunchViews()` states the relationship explicitly instead of letting a
 * caller treat "no events yet" as "nothing planned" (or the reverse).
 *
 * Everything here fails CLOSED. A manifest that is absent, unreadable, an
 * array, a null, the wrong schema version, a foreign launch id, a stale plan
 * hash or a changed revision is NEVER consumed as progress: it is quarantined
 * with an actionable issue code and contributes zero completion.
 */

import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';

import {
  LAUNCH_PLAN_SCHEMA_VERSION,
  LAUNCH_PROGRESS_SCHEMA_VERSION,
} from './launch-schema';

export type LaunchStorageView = 'disk' | 'database';

export type LaunchIssueCode =
  | 'unreadable_directory'
  | 'unreadable_file'
  | 'invalid_json'
  | 'not_an_object'
  | 'unsupported_schema'
  | 'invalid_manifest'
  | 'foreign_launch'
  | 'foreign_installation'
  | 'plan_hash_mismatch'
  | 'revision_mismatch'
  | 'conflicting_duplicate';

export interface LaunchIssue {
  file: string;
  code: LaunchIssueCode;
  message: string;
}

export interface LaunchPlanUnitManifest {
  id: string;
  kind: string;
  waits_for: string[];
}

export interface LaunchPlanManifest {
  schema_version: string;
  launch_id: string;
  revision?: number;
  offer: Record<string, unknown>;
  launch_calendar: Record<string, unknown>;
  a2p_ready: boolean;
  conversation_ai: { requested: boolean; mode: string; channels?: unknown[] };
  pages: LaunchPlanUnitManifest[];
  email_sequences: LaunchPlanUnitManifest[];
  text_sets: LaunchPlanUnitManifest[];
  automations: LaunchPlanUnitManifest[];
}

export const LAUNCH_PROGRESS_STATES = [
  'pending', 'running', 'done', 'failed', 'blocked', 'dropped',
] as const;
export type LaunchProgressState = (typeof LAUNCH_PROGRESS_STATES)[number];

export interface LaunchProgressUnit {
  kind: string;
  waits_for: string[];
  state: LaunchProgressState;
}

export interface LaunchProgressManifest {
  schema_version: string;
  launch_id: string;
  plan_hash: string;
  revision?: number;
  created_at: string;
  updated_at: string;
  units: Record<string, LaunchProgressUnit>;
}

export const LAUNCH_ID_RE = /^[a-z0-9][a-z0-9-]{2,}$/;
export const PLAN_HASH_RE = /^sha256:[0-9a-f]{64}$/;
const DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isDateTime(value: unknown): boolean {
  return typeof value === 'string' && DATETIME_RE.test(value) && !Number.isNaN(Date.parse(value));
}

/**
 * Canonical JSON matching the producer's `_canonical()` in
 * `shared-utils/signature_launch/progress.py`: sorted keys, compact
 * separators, ASCII-escaped. The producer hashes the PARSED plan, so this
 * hashes the parsed object too.
 *
 * ponytail: Python writes a float that is integral as `297.0`, JS writes
 * `297`. A producer plan containing explicit floats would hash differently —
 * that is safe (a mismatch quarantines, never inflates). Fix only if a real
 * producer starts emitting floats.
 */
export function canonicalPlanJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalPlanJson(entry)).join(',')}]`;
  }
  if (isPlainObject(value)) {
    const keys = Object.keys(value).sort();
    return `{${keys
      .map((key) => `${JSON.stringify(key)}:${canonicalPlanJson(value[key])}`)
      .join(',')}}`;
  }
  if (typeof value === 'string') {
    // Python's json.dumps defaults to ensure_ascii=True.
    return JSON.stringify(value).replace(
      /[\u0080-￿]/g,
      (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`,
    );
  }
  if (typeof value === 'number' && !Number.isFinite(value)) return 'null';
  return JSON.stringify(value ?? null);
}

/** The approved-plan hash, in the producer's `sha256:<hex>` shape. */
export function planHash(plan: unknown): string {
  return `sha256:${createHash('sha256').update(canonicalPlanJson(plan), 'utf8').digest('hex')}`;
}

function unitList(
  source: Record<string, unknown>,
  key: string,
  required: string[],
  errors: string[],
): LaunchPlanUnitManifest[] {
  const rows = source[key];
  if (rows === undefined || rows === null) {
    errors.push(`${key} is required and must be an array`);
    return [];
  }
  if (!Array.isArray(rows)) {
    errors.push(`${key} must be an array, got ${Array.isArray(rows) ? 'array' : typeof rows}`);
    return [];
  }
  const units: LaunchPlanUnitManifest[] = [];
  const seen = new Set<string>();
  for (const [index, row] of rows.entries()) {
    if (!isPlainObject(row)) {
      errors.push(`${key}[${index}] is not an object`);
      continue;
    }
    for (const field of required) {
      if (row[field] === undefined) errors.push(`${key}[${index}] is missing ${field}`);
    }
    const id = typeof row.id === 'string' ? row.id : '';
    if (!id) errors.push(`${key}[${index}] id must be a non-empty string`);
    if (id && seen.has(id)) errors.push(`${key} has duplicate unit id "${id}"`);
    seen.add(id);
    const waits = row.waits_for;
    if (waits !== undefined && !Array.isArray(waits)) {
      errors.push(`${key}[${index}].waits_for must be an array`);
    }
    units.push({
      id,
      kind: typeof row.kind === 'string' ? row.kind : '',
      waits_for: Array.isArray(waits) ? waits.filter((w): w is string => typeof w === 'string') : [],
    });
  }
  return units;
}

export type LaunchManifestResult<T> =
  | { ok: true; manifest: T }
  | { ok: false; code: LaunchIssueCode; errors: string[] };

/**
 * Validate one launch plan against `launch-plan.schema.json` v1.0.0.
 * Typed per file: a malformed section fails THIS file only.
 */
export function validateLaunchPlan(raw: unknown): LaunchManifestResult<LaunchPlanManifest> {
  if (!isPlainObject(raw)) {
    return { ok: false, code: 'not_an_object', errors: ['launch plan is not a JSON object'] };
  }
  if (raw.schema_version !== LAUNCH_PLAN_SCHEMA_VERSION) {
    return {
      ok: false,
      code: 'unsupported_schema',
      errors: [`schema_version must be "${LAUNCH_PLAN_SCHEMA_VERSION}", got ${JSON.stringify(raw.schema_version)}`],
    };
  }
  const errors: string[] = [];
  const launchId = typeof raw.launch_id === 'string' ? raw.launch_id : '';
  if (!LAUNCH_ID_RE.test(launchId)) errors.push('launch_id must be a lowercase slug of at least 3 characters');
  if (!isPlainObject(raw.offer)) errors.push('offer must be an object');
  if (!isPlainObject(raw.launch_calendar)) errors.push('launch_calendar must be an object');
  if (typeof raw.a2p_ready !== 'boolean') errors.push('a2p_ready must be a boolean');
  if (!isPlainObject(raw.conversation_ai)) {
    errors.push('conversation_ai must be an object');
  } else {
    if (typeof raw.conversation_ai.requested !== 'boolean') errors.push('conversation_ai.requested must be a boolean');
    if (typeof raw.conversation_ai.mode !== 'string') errors.push('conversation_ai.mode must be a string');
  }
  if (raw.revision !== undefined && (!Number.isInteger(raw.revision) || (raw.revision as number) < 0)) {
    errors.push('revision must be a non-negative integer when present');
  }

  const pages = unitList(raw, 'pages', ['id', 'kind', 'url', 'waits_for'], errors);
  const emails = unitList(raw, 'email_sequences', ['id', 'kind', 'provider', 'email_count', 'draft_only', 'waits_for'], errors);
  const texts = unitList(raw, 'text_sets', ['id', 'kind', 'messages', 'promotional', 'draft_only', 'opt_out_keyword', 'includes_reply_invitation', 'send_window', 'waits_for'], errors);
  const automations = unitList(raw, 'automations', ['id', 'family', 'template', 'build_rail', 'draft_only', 'trigger', 'waits_for'], errors);

  const known = new Set([...pages, ...emails, ...texts, ...automations].map((u) => u.id));
  if (known.has('conversation_ai') && isPlainObject(raw.conversation_ai) && raw.conversation_ai.requested === true) {
    errors.push('unit id "conversation_ai" is reserved for the Conversation AI unit');
  }
  for (const unit of [...pages, ...emails, ...texts, ...automations]) {
    for (const wait of unit.waits_for) {
      if (!known.has(wait)) errors.push(`unit ${unit.id} waits_for unknown unit "${wait}"`);
    }
  }

  if (errors.length) return { ok: false, code: 'invalid_manifest', errors };
  return {
    ok: true,
    manifest: {
      schema_version: raw.schema_version,
      launch_id: launchId,
      revision: typeof raw.revision === 'number' ? raw.revision : undefined,
      offer: raw.offer as Record<string, unknown>,
      launch_calendar: raw.launch_calendar as Record<string, unknown>,
      a2p_ready: raw.a2p_ready as boolean,
      conversation_ai: raw.conversation_ai as LaunchPlanManifest['conversation_ai'],
      pages,
      email_sequences: emails,
      text_sets: texts,
      automations,
    },
  };
}

/**
 * Validate one progress manifest against `progress_file.schema.json` (L03's
 * `validate()` — same SCHEMA_VERSION, same state set, same wait references).
 * An unknown state is a rejection, never coerced to "pending".
 */
export function validateLaunchProgress(raw: unknown): LaunchManifestResult<LaunchProgressManifest> {
  if (!isPlainObject(raw)) {
    return { ok: false, code: 'not_an_object', errors: ['launch progress is not a JSON object'] };
  }
  if (raw.schema_version !== LAUNCH_PROGRESS_SCHEMA_VERSION) {
    return {
      ok: false,
      code: 'unsupported_schema',
      errors: [`progress schema_version must be "${LAUNCH_PROGRESS_SCHEMA_VERSION}", got ${JSON.stringify(raw.schema_version)}`],
    };
  }
  const errors: string[] = [];
  const launchId = typeof raw.launch_id === 'string' ? raw.launch_id : '';
  if (!LAUNCH_ID_RE.test(launchId)) errors.push('progress launch_id must be a lowercase slug');
  if (typeof raw.plan_hash !== 'string' || !PLAN_HASH_RE.test(raw.plan_hash)) {
    errors.push('plan_hash must be sha256:<64 hex> (the approved plan this progress belongs to)');
  }
  if (!isDateTime(raw.created_at)) errors.push('created_at must be an ISO-8601 date-time');
  if (!isDateTime(raw.updated_at)) errors.push('updated_at must be an ISO-8601 date-time');
  if (raw.revision !== undefined && (!Number.isInteger(raw.revision) || (raw.revision as number) < 0)) {
    errors.push('revision must be a non-negative integer when present');
  }
  if (!isPlainObject(raw.units) || Object.keys(raw.units).length === 0) {
    errors.push('units must be a non-empty object');
    return { ok: false, code: 'invalid_manifest', errors };
  }
  const units: Record<string, LaunchProgressUnit> = {};
  for (const [id, row] of Object.entries(raw.units)) {
    if (!isPlainObject(row)) {
      errors.push(`unit ${id} is not an object`);
      continue;
    }
    const state = row.state;
    if (typeof state !== 'string' || !(LAUNCH_PROGRESS_STATES as readonly string[]).includes(state)) {
      errors.push(`unit ${id} has unknown state ${JSON.stringify(state)}`);
      continue;
    }
    const waits = row.waits_for ?? [];
    if (!Array.isArray(waits)) errors.push(`unit ${id} waits_for must be an array`);
    units[id] = {
      kind: typeof row.kind === 'string' ? row.kind : '',
      waits_for: Array.isArray(waits) ? waits.filter((w): w is string => typeof w === 'string') : [],
      state: state as LaunchProgressState,
    };
  }
  for (const [id, unit] of Object.entries(units)) {
    for (const wait of unit.waits_for) {
      if (!(wait in units)) errors.push(`unit ${id} waits_for unknown unit "${wait}"`);
    }
  }
  if (errors.length) return { ok: false, code: 'invalid_manifest', errors };
  return {
    ok: true,
    manifest: {
      schema_version: raw.schema_version,
      launch_id: launchId,
      plan_hash: raw.plan_hash as string,
      revision: typeof raw.revision === 'number' ? raw.revision : undefined,
      created_at: raw.created_at as string,
      updated_at: raw.updated_at as string,
      units,
    },
  };
}

/** Typed discovery: what a file IS, decided by its name, before parsing. */
export type LaunchFileKind = 'plan' | 'progress';

export interface LaunchDiscoveredFile {
  name: string;
  fullPath: string;
  kind: LaunchFileKind;
  /** Legacy `<id>.json` plans have no `.plan` marker. */
  legacyPlan: boolean;
}

export interface LaunchDiscovery {
  /** `unavailable` means the directory could not be read — never "empty". */
  availability: 'ok' | 'unavailable';
  files: LaunchDiscoveredFile[];
  errors: LaunchIssue[];
  dir: string;
}

export function discoverLaunchFiles(dir: string): LaunchDiscovery {
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch (error) {
    return {
      availability: 'unavailable',
      files: [],
      dir,
      errors: [{
        file: dir,
        code: 'unreadable_directory',
        message: `launch plans directory is unavailable: ${error instanceof Error ? error.message : 'unreadable'}`,
      }],
    };
  }

  const files: LaunchDiscoveredFile[] = [];
  for (const name of entries.sort()) {
    if (!name.endsWith('.json')) continue;
    const fullPath = path.join(dir, name);
    if (name.endsWith('.progress.json')) {
      files.push({ name, fullPath, kind: 'progress', legacyPlan: false });
    } else if (name.startsWith('progress-') && !name.endsWith('.plan.json')) {
      // Producer shape `progress-<launch_id>.json`: the progress filename the
      // producer actually writes. Classified by name before parsing; content
      // still goes through validateLaunchProgress (fail-closed), so a plan
      // misnamed into this shape is quarantined, never consumed.
      files.push({ name, fullPath, kind: 'progress', legacyPlan: false });
    } else {
      files.push({
        name,
        fullPath,
        kind: 'plan',
        legacyPlan: !name.endsWith('.plan.json'),
      });
    }
  }
  return { availability: 'ok', files, dir, errors: [] };
}

/** Read + parse one JSON file. `null` result means it could not be trusted. */
export function readLaunchJsonFile(
  file: LaunchDiscoveredFile,
): { ok: true; value: unknown; bytes: Buffer } | { ok: false; issue: LaunchIssue } {
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(file.fullPath);
  } catch (error) {
    return {
      ok: false,
      issue: {
        file: file.name,
        code: 'unreadable_file',
        message: `${file.name} is unreadable: ${error instanceof Error ? error.message : 'unknown'}`,
      },
    };
  }
  try {
    return { ok: true, value: JSON.parse(bytes.toString('utf8')) as unknown, bytes };
  } catch (error) {
    return {
      ok: false,
      issue: {
        file: file.name,
        code: 'invalid_json',
        message: `${file.name} is not valid JSON: ${error instanceof Error ? error.message : 'unknown'}`,
      },
    };
  }
}

/** Best-effort last-update stamp: the manifest's own `updated_at`, else mtime. */
export function fileLastUpdated(fullPath: string, manifestUpdatedAt?: string): string | null {
  if (manifestUpdatedAt) return manifestUpdatedAt;
  try {
    return fs.statSync(fullPath).mtime.toISOString();
  } catch {
    return null;
  }
}

export interface LaunchViewRelationship {
  diskOnly: string[];
  databaseOnly: string[];
  both: string[];
  /** Plain statement of which view answers what; never a computed guess. */
  note: string;
}

/**
 * The explicit relationship between the disk view and the database view.
 * Matching on `launch_id` only; a launch present in one view is reported as
 * such, never as empty in the other.
 */
export function relateLaunchViews(
  diskLaunchIds: readonly string[],
  databaseLaunchIds: readonly string[],
): LaunchViewRelationship {
  const disk = new Set(diskLaunchIds);
  const database = new Set(databaseLaunchIds);
  return {
    diskOnly: [...disk].filter((id) => !database.has(id)).sort(),
    databaseOnly: [...database].filter((id) => !disk.has(id)).sort(),
    both: [...disk].filter((id) => database.has(id)).sort(),
    note:
      'disk view = approved plan + producer progress file; database view = validated run events ' +
      'ingested from the launch skills. Neither overrides the other, and absence in one view is ' +
      'reported as absence — never as an empty or complete launch.',
  };
}
