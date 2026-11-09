/**
 * ghl-hybrid-receipts.ts — WF18 · Command Center receipt backend and engine
 * ownership (Document 1 §5.5, §14.4-14.7, §29.7; Document 2 WF18).
 *
 * WHY THIS EXISTS
 * A GHL engine operation (course build, group/Learning association, Community
 * publish, native feature, Projects projection) must leave ONE trustworthy
 * receipt trail in Command Center without making Command Center a second GHL
 * executor. This module owns the store, the redaction, the idempotency /
 * monotonicity rules and the company/location binding check. The HTTP boundary
 * lives in src/app/api/tasks/[id]/ghl-operations/route.ts.
 *
 * THE THREE HARD RULES (§14.4, A22)
 *  1. AUTHORIZATION NEVER COMES FROM THE BODY. The owning company is derived
 *     from server context. A receipt naming another company or a location
 *     outside the company's server-side allow-list is refused even when the
 *     HMAC is valid.
 *  2. RECEIPTS ARE IMMUTABLE EVENTS. Insert only. An identical replay is
 *     acknowledged; the same receipt_id or the same event_sequence with
 *     different bytes is a CONFLICT, never an overwrite. A lower event
 *     sequence (or a pending outcome against an already-verified one) never
 *     replaces a later verified outcome — it is STALE and stored nowhere.
 *  3. VERIFIED MEANS READ BACK. `outcome: "verified"` requires
 *     `readback.state: "matched"`; a bare 2xx create is not evidence (§14.5,
 *     A23). `unknown_outcome` stays visible until a real reconciliation event
 *     arrives.
 *
 * Everything here is server-side only. It reads the DB and (defensively read-
 * only) the box's company config for the location allow-list.
 */
import type Database from 'better-sqlite3';
import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import type {
  GhlOperationReceipt,
  GhlOperationReceiptRow,
  GhlReceiptOutcome,
  GhlReceiptReadbackState,
} from './types';
import { GHL_RECEIPT_OUTCOMES } from './types';

/** The ONE producer identity for every GHL engine operation (§14.4). */
export const GHL_HYBRID_SOURCE = 'ghl-hybrid';

/** Receipt envelope versions this store accepts. */
export const GHL_RECEIPT_SCHEMA_VERSION = '1.0.0';
export const GHL_RECEIPT_ACCEPTED_SCHEMA_VERSIONS: readonly string[] = [GHL_RECEIPT_SCHEMA_VERSION];

/**
 * Bound the request and the stored JSON. A producer that tries to smuggle a
 * full provider response into a receipt is refused rather than truncated —
 * a silently shortened receipt is a false record.
 */
export const GHL_RECEIPT_MAX_BODY_BYTES = 96 * 1024;
export const GHL_RECEIPT_MAX_STORED_JSON_BYTES = 48 * 1024;
export const GHL_RECEIPT_MAX_EVENTS_PER_OPERATION = 500;

export const GHL_REDACTED = '[REDACTED]';
export const GHL_REDACTED_PATH = '[redacted-path]';

// ── Redaction ────────────────────────────────────────────────────────────────

/**
 * Keys whose VALUE is never stored. Case-insensitive, matches substrings so
 * `x-api-key`, `set-cookie`, `refreshToken`, `Authorization` all land here.
 */
const SECRET_KEY_PATTERN =
  /(authorization|proxy-authorization|cookie|token|secret|password|passwd|api[-_]?key|apikey|bearer|credential|private[-_]?key|session[-_]?key)/i;

/** Absolute private paths — never a client-visible field (§14.5). */
const POSIX_PRIVATE_PATH = /(^|[\s"'(=:,\[])(\/(?:Users|Volumes|private|home|root|var|etc|tmp|opt|srv|mnt)\/[^\s"'),]*)/g;
const WINDOWS_PRIVATE_PATH = /(^|[\s"'(=:,\[])("[A-Za-z]:\\\\[^"]*"|[A-Za-z]:\\\\[^\s"'),]*)/g;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

const REDACT_MAX_DEPTH = 12;
const REDACT_MAX_ENTRIES = 100;

function redactString(value: string): string {
  let out = value.replace(CONTROL_CHARS, '');
  out = out.replace(POSIX_PRIVATE_PATH, (_m, lead: string) => `${lead}${GHL_REDACTED_PATH}`);
  out = out.replace(WINDOWS_PRIVATE_PATH, (_m, lead: string) => `${lead}${GHL_REDACTED_PATH}`);
  // An evidence path is allowed only as a relative pointer.
  return out;
}

/**
 * Deep-redact a receipt payload for storage and for GET responses. Deterministic
 * and pure so the same bytes always hash the same way (idempotency depends on
 * it). Over-deep or over-wide structures are refused by substitution rather
 * than dropped silently.
 */
export function redactGhlReceipt(value: unknown, depth = 0): unknown {
  if (depth > REDACT_MAX_DEPTH) return '[redacted-depth]';
  if (value === null || value === undefined) return value ?? null;
  const t = typeof value;
  if (t === 'string') return redactString(value as string);
  if (t === 'number') return Number.isFinite(value as number) ? value : String(value);
  if (t === 'boolean') return value;
  if (Array.isArray(value)) {
    const out = value.slice(0, REDACT_MAX_ENTRIES).map((v) => redactGhlReceipt(v, depth + 1));
    return out;
  }
  if (t === 'object') {
    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    const keys = Object.keys(src).slice(0, REDACT_MAX_ENTRIES);
    for (const key of keys) {
      if (SECRET_KEY_PATTERN.test(key)) {
        out[key] = GHL_REDACTED;
        continue;
      }
      out[key] = redactGhlReceipt(src[key], depth + 1);
    }
    return out;
  }
  return GHL_REDACTED; // functions/symbols never enter the store
}

// ── Hashing / canonical form ─────────────────────────────────────────────────

/** Deterministic JSON: sorted keys, no whitespace. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** The exact bytes that identify this event (post-redaction). */
export function receiptEventBytesHash(receipt: GhlOperationReceipt): string {
  return sha256Hex(canonicalJson(redactGhlReceipt(receipt)));
}

/**
 * The approved-intent hash. Producers may send their own `request_hash`;
 * otherwise it is derived from the intent fields ONLY (never from diagnostics),
 * so redaction cannot invalidate intent matching (§5.5).
 */
export function receiptIntentHash(receipt: GhlOperationReceipt): string {
  if (typeof receipt.request_hash === 'string' && receipt.request_hash.trim()) {
    return receipt.request_hash.trim();
  }
  return `sha256:${sha256Hex(
    canonicalJson({
      operation_key: receipt.operation_key,
      operation_id: receipt.operation_id,
      object_refs: receipt.object_refs ?? {},
      requested_visibility: receipt.requested_visibility ?? null,
    }),
  )}`;
}

// ── Location allow-list (trusted server-side) ────────────────────────────────

export interface AllowedLocations {
  /** False when this box has no allow-list at all — callers fail closed. */
  configured: boolean;
  /** Where the list came from, for an honest receipt/error message. */
  source: 'env_json' | 'env_list' | 'company_config' | 'none';
  location_ids: string[];
}

function splitList(raw: unknown): string[] {
  if (typeof raw === 'string') {
    return raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }
  if (Array.isArray(raw)) {
    return raw.map((v) => String(v).trim()).filter(Boolean);
  }
  return [];
}

/**
 * Resolve the GHL location IDs this company is allowed to receipt against.
 *
 * Order (all TRUSTED, none caller-supplied):
 *   1. GHL_ALLOWED_LOCATIONS_JSON = {"<companyId>": ["loc"], "*": ["loc"]}
 *   2. GHL_ALLOWED_LOCATION_IDS   = "locA,locB"  (box-wide)
 *   3. company-config.json        ghlLocationIds / ghl_location_ids /
 *                                 connectedSystems.ghlLocationId
 *
 * No list configured → `configured: false`, and every receipt is refused with
 * an explicit setup instruction. Fail-closed is the whole point: an unset
 * allow-list must not mean "any location is fine".
 */
export function resolveAllowedGhlLocationIds(companyId: string): AllowedLocations {
  const jsonRaw = process.env.GHL_ALLOWED_LOCATIONS_JSON;
  if (jsonRaw && jsonRaw.trim()) {
    try {
      const parsed = JSON.parse(jsonRaw) as Record<string, unknown>;
      const ids = splitList(parsed[companyId] ?? parsed['*']);
      if (ids.length > 0) return { configured: true, source: 'env_json', location_ids: ids };
    } catch {
      // Malformed JSON is not a list. Fall through; never widen.
    }
  }

  const envList = splitList(process.env.GHL_ALLOWED_LOCATION_IDS ?? '');
  if (envList.length > 0) return { configured: true, source: 'env_list', location_ids: envList };

  try {
    const candidates = [
      process.env.COMPANY_CONFIG_PATH,
      path.join(process.cwd(), 'company-config.json'),
    ].filter(Boolean) as string[];
    for (const file of candidates) {
      if (!fs.existsSync(file)) continue;
      const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
      const ids = splitList(
        raw.ghlLocationIds ?? raw.ghl_location_ids ?? raw.ghl_location_id ?? undefined,
      );
      const nested = splitList(
        (raw.connectedSystems as Record<string, unknown> | undefined)?.ghlLocationId,
      );
      const merged = Array.from(new Set([...ids, ...nested]));
      if (merged.length > 0) {
        return { configured: true, source: 'company_config', location_ids: merged };
      }
    }
  } catch {
    // Unreadable config is not an allow-list.
  }

  return { configured: false, source: 'none', location_ids: [] };
}

/** True only when the location is in the company's trusted allow-list. */
export function isGhlLocationAllowed(companyId: string, locationId: string): boolean {
  const allowed = resolveAllowedGhlLocationIds(companyId);
  if (!allowed.configured) return false;
  return allowed.location_ids.includes(locationId);
}

// ── Outcome ordering ─────────────────────────────────────────────────────────

const OUTCOME_RANK: Record<GhlReceiptOutcome, number> = {
  not_requested: 0,
  planned: 1,
  submitted: 2,
  processing: 3,
  unknown_outcome: 4,
  blocked: 5,
  failed: 5,
  verified: 6,
};

/** Rank of an outcome. Unknown strings rank lowest so they never win. */
export function ghlOutcomeRank(outcome: string | null | undefined): number {
  if (typeof outcome !== 'string') return -1;
  return GHL_RECEIPT_OUTCOMES.includes(outcome as GhlReceiptOutcome)
    ? OUTCOME_RANK[outcome as GhlReceiptOutcome]
    : -1;
}

/** Pending outcomes can never displace a verified one inside one operation. */
const PENDING_OUTCOMES = new Set<string>(['planned', 'submitted', 'processing']);

export type ReceiptInsertDecision =
  | { action: 'insert' }
  | { action: 'replay'; reason: string; existing: GhlOperationReceiptRow }
  | { action: 'conflict'; reason: string; existing?: GhlOperationReceiptRow }
  | { action: 'stale'; reason: string; existing: GhlOperationReceiptRow };

/** The row shape the decision needs — a subset of the stored row. */
export interface ReceiptEventIdentity {
  receipt_id: string;
  attempt_id: string;
  event_sequence: number;
  outcome: string;
  event_bytes_hash: string;
}

/**
 * Decide what a newly delivered event means for one logical operation.
 *
 * `existing` is every stored event for the same
 * (company_id, run_id, operation_key), in any order.
 */
export function decideReceiptEvent(
  existing: readonly (GhlOperationReceiptRow | ReceiptEventIdentity)[],
  incoming: ReceiptEventIdentity,
): ReceiptInsertDecision {
  const rows = existing as readonly (GhlOperationReceiptRow | ReceiptEventIdentity)[];

  // 1. Same receipt_id: identical bytes are the SAME event re-delivered.
  const sameId = rows.find((r) => r.receipt_id === incoming.receipt_id);
  if (sameId) {
    if (sameId.event_bytes_hash === incoming.event_bytes_hash) {
      return {
        action: 'replay',
        reason: 'identical_event_replay',
        existing: sameId as GhlOperationReceiptRow,
      };
    }
    return {
      action: 'conflict',
      reason: 'receipt_id_reused_with_different_bytes',
      existing: sameId as GhlOperationReceiptRow,
    };
  }

  // 2. Same sequence, different receipt id: a different event cannot borrow a
  //    sequence already consumed by the logical operation.
  const sameSequence = rows.find((r) => r.event_sequence === incoming.event_sequence);
  if (sameSequence) {
    return {
      action: 'conflict',
      reason: 'event_sequence_reused_with_different_event',
      existing: sameSequence as GhlOperationReceiptRow,
    };
  }

  // 2b. Same attempt, same sequence marker — bounded per-operation event count.
  if (rows.length >= GHL_RECEIPT_MAX_EVENTS_PER_OPERATION) {
    return {
      action: 'conflict',
      reason: 'operation_event_limit_reached',
      existing: rows[0] as GhlOperationReceiptRow,
    };
  }

  const maxSequence = rows.reduce((m, r) => Math.max(m, r.event_sequence), 0);
  const latest = rows.reduce<GhlOperationReceiptRow | ReceiptEventIdentity | null>(
    (best, r) => (best === null || r.event_sequence > best.event_sequence ? r : best),
    null,
  );

  // 3. Sequence must strictly advance.
  if (incoming.event_sequence <= maxSequence) {
    return {
      action: 'stale',
      reason: 'event_sequence_not_advanced',
      existing: latest as GhlOperationReceiptRow,
    };
  }

  // 4. A later pending event never overwrites an already-verified outcome from
  //    an earlier attempt. (§14.5: an older processing event cannot overwrite
  //    a later verified outcome; this is the mirror case for a same-run retry.)
  if (
    latest &&
    latest.outcome === 'verified' &&
    PENDING_OUTCOMES.has(incoming.outcome) &&
    latest.attempt_id !== incoming.attempt_id
  ) {
    return {
      action: 'stale',
      reason: 'pending_event_cannot_displace_verified_outcome',
      existing: latest as GhlOperationReceiptRow,
    };
  }

  return { action: 'insert' };
}

/** `verified` requires a matched readback — a 2xx create is not a verification. */
export function isVerifiableOutcome(receipt: Pick<GhlOperationReceipt, 'outcome' | 'readback'>): boolean {
  if (receipt.outcome !== 'verified') return true;
  const state = (receipt.readback?.state ?? 'not_run') as GhlReceiptReadbackState;
  return state === 'matched';
}

// ── Company/task binding ─────────────────────────────────────────────────────

export interface CompanyBoundTask {
  id: string;
  title: string;
  status: string;
  source: string | null;
  parent_task_id: string | null;
  workspace_id: string | null;
}

/**
 * Load a task ONLY when it belongs to this company — by workspace ownership or
 * by durable creation identity. A known task UUID from another company is a
 * 404, never a cross-tenant read (§14.4, A22).
 */
export function loadCompanyBoundTask(
  db: Database.Database,
  taskId: string,
  companyId: string,
): CompanyBoundTask | null {
  const row = db
    .prepare(
      `SELECT t.id, t.title, t.status, t.source, t.parent_task_id, t.workspace_id
         FROM tasks t
        WHERE t.id = ?
          AND (
            EXISTS (SELECT 1 FROM workspaces w WHERE w.id = t.workspace_id AND w.company_id = ?)
            OR EXISTS (SELECT 1 FROM task_request_keys k WHERE k.task_id = t.id AND k.company_id = ?)
          )`,
    )
    .get(taskId, companyId, companyId) as CompanyBoundTask | undefined;
  return row ?? null;
}

/** True when the task carries the immutable ghl-hybrid producer stamp. */
export function isGhlHybridTask(task: Pick<CompanyBoundTask, 'source'>): boolean {
  return typeof task.source === 'string' && task.source.trim().toLowerCase() === GHL_HYBRID_SOURCE;
}

// ── Store ────────────────────────────────────────────────────────────────────

export type InsertOutcome =
  | { status: 'inserted'; row: GhlOperationReceiptRow }
  | { status: 'replay'; row: GhlOperationReceiptRow; reason: string }
  | { status: 'stale'; row: GhlOperationReceiptRow; reason: string }
  | { status: 'conflict'; reason: string; row?: GhlOperationReceiptRow };

function loadOperationRows(
  db: Database.Database,
  companyId: string,
  runId: string,
  operationKey: string,
): GhlOperationReceiptRow[] {
  return db
    .prepare(
      `SELECT * FROM ghl_operation_receipts
        WHERE company_id = ? AND run_id = ? AND operation_key = ?
        ORDER BY event_sequence ASC`,
    )
    .all(companyId, runId, operationKey) as GhlOperationReceiptRow[];
}

/**
 * Insert one immutable receipt event. The decision (insert / replay / stale /
 * conflict) is computed from the stored events for this logical operation, so
 * two writers racing still cannot produce a duplicate sequence — the UNIQUE
 * constraint is the final backstop and is mapped to `conflict`, never a 500.
 */
export function insertGhlReceiptEvent(
  db: Database.Database,
  params: { companyId: string; taskId: string; receipt: GhlOperationReceipt },
): InsertOutcome {
  const { companyId, taskId, receipt } = params;
  if (!GHL_RECEIPT_ACCEPTED_SCHEMA_VERSIONS.includes(receipt.schema_version)) {
    return { status: 'conflict', reason: 'unsupported_schema_version' };
  }
  if (!isVerifiableOutcome(receipt)) {
    return { status: 'conflict', reason: 'verified_requires_matched_readback' };
  }

  const existing = loadOperationRows(db, companyId, receipt.run_id, receipt.operation_key);
  const bytesHash = receiptEventBytesHash(receipt);
  const decision = decideReceiptEvent(existing, {
    receipt_id: receipt.receipt_id,
    attempt_id: receipt.attempt_id,
    event_sequence: receipt.event_sequence,
    outcome: receipt.outcome,
    event_bytes_hash: bytesHash,
  });

  if (decision.action === 'replay') {
    return {
      status: 'replay',
      row: decision.existing,
      reason: decision.reason,
    };
  }
  if (decision.action === 'conflict') {
    return { status: 'conflict', reason: decision.reason, row: decision.existing };
  }
  if (decision.action === 'stale') {
    return { status: 'stale', row: decision.existing, reason: decision.reason };
  }

  const redacted = redactGhlReceipt(receipt) as Record<string, unknown>;
  const receiptJson = JSON.stringify(redacted);
  if (Buffer.byteLength(receiptJson, 'utf8') > GHL_RECEIPT_MAX_STORED_JSON_BYTES) {
    return { status: 'conflict', reason: 'receipt_too_large_after_redaction' };
  }

  const row: GhlOperationReceiptRow = {
    id: uuidv4(),
    company_id: companyId,
    task_id: taskId,
    run_id: receipt.run_id,
    operation_key: receipt.operation_key,
    attempt_id: receipt.attempt_id,
    event_sequence: receipt.event_sequence,
    schema_version: receipt.schema_version,
    operation_id: receipt.operation_id,
    rail: receipt.rail,
    outcome: receipt.outcome,
    observed_at: receipt.observed_at,
    received_at: new Date().toISOString(),
    intent_hash: receiptIntentHash(receipt),
    receipt_id: receipt.receipt_id,
    event_bytes_hash: bytesHash,
    receipt_json: receiptJson,
  };

  try {
    db.prepare(
      `INSERT INTO ghl_operation_receipts
        (id, company_id, task_id, run_id, operation_key, attempt_id, event_sequence,
         schema_version, operation_id, rail, outcome, observed_at, received_at,
         intent_hash, receipt_id, event_bytes_hash, receipt_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      row.id,
      row.company_id,
      row.task_id,
      row.run_id,
      row.operation_key,
      row.attempt_id,
      row.event_sequence,
      row.schema_version,
      row.operation_id,
      row.rail,
      row.outcome,
      row.observed_at,
      row.received_at,
      row.intent_hash,
      row.receipt_id,
      row.event_bytes_hash,
      row.receipt_json,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/UNIQUE|PRIMARY KEY/i.test(message)) {
      return { status: 'conflict', reason: 'concurrent_duplicate_event' };
    }
    throw err;
  }

  // Audit trail on the EXISTING events sink. The board status is NOT changed
  // here: §14.7 keeps the ten TaskStatus values, and WF19 renders the typed
  // progress. `unknown_outcome` stays visible because the row simply exists.
  try {
    db.prepare(
      `INSERT INTO events (id, type, agent_id, task_id, message, metadata, created_at)
       VALUES (?, ?, NULL, ?, ?, ?, ?)`,
    ).run(
      uuidv4(),
      'ghl_operation_receipt',
      taskId,
      `GHL operation ${receipt.operation_id} → ${receipt.outcome} (${receipt.rail})`,
      JSON.stringify({
        company_id: companyId,
        run_id: receipt.run_id,
        operation_key: receipt.operation_key,
        operation_id: receipt.operation_id,
        attempt_id: receipt.attempt_id,
        event_sequence: receipt.event_sequence,
        receipt_id: receipt.receipt_id,
        outcome: receipt.outcome,
        rail: receipt.rail,
        location_id: receipt.location_id,
        needs_reconciliation: receipt.outcome === 'unknown_outcome',
      }),
      new Date().toISOString(),
    );
  } catch {
    // The receipt row is the source of truth; a missing convenience event must
    // never roll back a verified insert.
  }

  return { status: 'inserted', row };
}

// ── Read model (GET) ─────────────────────────────────────────────────────────

export interface GhlOperationSummary {
  run_id: string;
  operation_key: string;
  operation_id: string;
  rail: string;
  outcome: string;
  event_sequence: number;
  attempt_id: string;
  receipt_id: string;
  observed_at: string;
  received_at: string;
  /** True while outcome is unknown_outcome/failed/blocked and unreconciled. */
  needs_reconciliation: boolean;
  /** Latest redacted receipt payload. */
  receipt: unknown;
  event_count: number;
  /** Every attempt id seen for this logical operation, oldest first. */
  attempts: string[];
  /** Per-outcome event counts, for the progress panel. */
  outcome_counts: Record<string, number>;
}

/**
 * Company-scoped, redacted summaries for ONE task. Grouped by
 * (run_id, operation_key); the latest event wins, with `verified` winning a
 * sequence tie. A stale/unknown operation stays listed until reconciled.
 */
export function loadGhlOperationSummaries(
  db: Database.Database,
  companyId: string,
  taskId: string,
): GhlOperationSummary[] {
  const rows = db
    .prepare(
      `SELECT * FROM ghl_operation_receipts
        WHERE company_id = ? AND task_id = ?
        ORDER BY received_at ASC, event_sequence ASC`,
    )
    .all(companyId, taskId) as GhlOperationReceiptRow[];

  const groups = new Map<string, GhlOperationReceiptRow[]>();
  for (const row of rows) {
    const key = `${row.run_id}\u0000${row.operation_key}`;
    const bucket = groups.get(key);
    if (bucket) bucket.push(row);
    else groups.set(key, [row]);
  }

  const summaries: GhlOperationSummary[] = [];
  for (const bucket of groups.values()) {
    const base = bucket[0];
    const latest = bucket.reduce((best, r) => {
      if (r.event_sequence > best.event_sequence) return r;
      if (r.event_sequence === best.event_sequence && ghlOutcomeRank(r.outcome) > ghlOutcomeRank(best.outcome)) {
        return r;
      }
      return best;
    }, base);

    const outcomeCounts: Record<string, number> = {};
    for (const r of bucket) outcomeCounts[r.outcome] = (outcomeCounts[r.outcome] ?? 0) + 1;

    let parsed: unknown = null;
    try {
      parsed = JSON.parse(latest.receipt_json);
    } catch {
      parsed = null; // corrupt row reads as "no detail", never as success
    }

    summaries.push({
      run_id: latest.run_id,
      operation_key: latest.operation_key,
      operation_id: latest.operation_id,
      rail: latest.rail,
      outcome: latest.outcome,
      event_sequence: latest.event_sequence,
      attempt_id: latest.attempt_id,
      receipt_id: latest.receipt_id,
      observed_at: latest.observed_at,
      received_at: latest.received_at,
      needs_reconciliation:
        latest.outcome === 'unknown_outcome' ||
        latest.outcome === 'failed' ||
        latest.outcome === 'blocked',
      receipt: parsed,
      event_count: bucket.length,
      attempts: Array.from(new Set(bucket.map((r) => r.attempt_id))),
      outcome_counts: outcomeCounts,
    });
  }

  // Newest activity first, deterministic on ties.
  summaries.sort(
    (a, b) =>
      b.received_at.localeCompare(a.received_at) ||
      a.operation_key.localeCompare(b.operation_key),
  );
  return summaries;
}

// ── WF18-CP01 · frozen request/response fixture ──────────────────────────────
//
// Downstream lanes (WF19 display, WF20 producer bridge, WF33 Projects
// projection) import these shapes instead of inventing their own. Synthetic
// values only — never live tenant data.

export const GHL_RECEIPT_REQUEST_EXAMPLE = {
  schema_version: '1.0.0',
  run_id: '11111111-1111-4111-8111-111111111111',
  operation_receipt: {
    schema_version: '1.0.0',
    receipt_id: '22222222-2222-4222-8222-222222222222',
    attempt_id: '33333333-3333-4333-8333-333333333333',
    event_sequence: 1,
    run_id: '11111111-1111-4111-8111-111111111111',
    operation_key: 'course:launch101:lesson:welcome:intro:create',
    operation_id: 'courses.lessons.create',
    location_id: 'SYNTHETIC_GHL_LOCATION',
    task_id: 'SYNTHETIC_CC_TASK_OR_NULL',
    skill: '06',
    department: 'courses',
    rail: 'public_rest',
    outcome: 'verified',
    build_state: 'implemented',
    requested_visibility: 'draft',
    actual_visibility: 'draft',
    request_hash: 'sha256:REDACTED_CANONICAL_INTENT',
    object_refs: { course_lesson_id: 'SYNTHETIC_LESSON_ID' },
    readback: { state: 'matched', checked_fields: ['title', 'categoryId', 'visibility'] },
    attempts: [],
    evidence_refs: ['evidence/redacted-readback.json'],
    next_action: null,
    observed_at: '2026-11-08T12:00:00Z',
  },
} as const;

export const GHL_RECEIPT_RESPONSE_EXAMPLE = {
  ok: true,
  status: 'inserted',
  receipt_id: '22222222-2222-4222-8222-222222222222',
  task_id: 'SYNTHETIC_CC_TASK_OR_NULL',
  run_id: '11111111-1111-4111-8111-111111111111',
  operation_key: 'course:launch101:lesson:welcome:intro:create',
  event_sequence: 1,
  outcome: 'verified',
  needs_reconciliation: false,
} as const;
