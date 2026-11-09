'use client';

/**
 * WF19 / A23 (display side) — GHL hybrid progress UI.
 *
 * Shows the owner what a `ghl-hybrid`-produced card ACTUALLY did and what is
 * still required, without redesigning Kanban and without a second board or a
 * second task-status truth (Document 1 s14.7, s14.8, s14.11).
 *
 * DATA SOURCE (one): the WF18 receipt surface
 *   GET /api/tasks/{taskId}/ghl-operations
 * returning a redacted operation summary (Document 1 s14.4). The board card
 * additionally reads an optional `ghl_hybrid` summary already attached to the
 * task row (zero extra requests per card). BOTH are parsed here by ONE
 * validator, so the card and the modal can never disagree.
 *
 * HONESTY RULES ENFORCED BY THIS MODULE (they are the whole point of A23):
 *   - A malformed receipt payload is a HARD parse failure with a named reason
 *     (`{ ok: false }`), never a partial success. The caller renders an
 *     explicit "could not be read" surface; no chips, no counts, no checkmarks.
 *   - `unknown_outcome` dominates every other result — one ambiguous write can
 *     never be displayed as verified.
 *   - A fallback rail is labelled "Fallback selected"; its ACTUAL result is
 *     shown verbatim, or "result not recorded". Never "fallback successful".
 *   - Timestamps are shown only when the payload carries them. Nothing is
 *     synthesized, so a stalled task cannot look alive.
 *   - `scheduled` is never rendered as `published`.
 *   - An unrecognised rail / outcome / sub-result state is shown AS
 *     unrecognised. It is never mapped to a comfortable word.
 *   - Missing sub-result dimensions render "Not reported" (unknown), never a
 *     checkmark.
 *   - Stale/unknown board lifecycle is reused (src/lib/types.ts LifecycleCard),
 *     never re-derived from a timer of this module's own invention.
 */

import { useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, Clock, Link2, ShieldAlert, Wrench } from 'lucide-react';
import type { LifecycleCard } from '@/lib/types';

// ─── Contract vocabulary (Document 1 s5.3 / s5.5) ───────────────────────────

export const GHL_RAILS = ['public_rest', 'official_mcp', 'firebase_private', 'managed_browser'] as const;
export type GhlRail = (typeof GHL_RAILS)[number];

export const GHL_OUTCOMES = [
  'planned', 'submitted', 'processing', 'verified', 'failed', 'blocked', 'unknown_outcome', 'not_requested',
] as const;
export type GhlOutcome = (typeof GHL_OUTCOMES)[number];

/** The four sub-results every native-family card must show separately (s14.11). */
export const GHL_SUB_RESULT_DIMENSIONS = ['configuration', 'activation', 'functional_proof', 'sync'] as const;
export type GhlSubResultDimension = (typeof GHL_SUB_RESULT_DIMENSIONS)[number];

export const GHL_SUB_RESULT_STATES = [
  'verified', 'pending', 'blocked', 'failed', 'unknown', 'not_requested',
] as const;
export type GhlSubResultState = (typeof GHL_SUB_RESULT_STATES)[number];

const RAIL_LABELS: Record<GhlRail, string> = {
  public_rest: 'Public REST',
  official_mcp: 'Official MCP',
  firebase_private: 'Firebase (private)',
  managed_browser: 'Managed browser',
};

const OUTCOME_LABELS: Record<GhlOutcome, string> = {
  planned: 'Planned',
  submitted: 'Submitted',
  processing: 'Processing',
  verified: 'Verified',
  failed: 'Failed',
  blocked: 'Blocked',
  unknown_outcome: 'Outcome unknown',
  not_requested: 'Not requested',
};

const IMPLEMENTATION_LABELS: Record<string, string> = {
  implemented: 'Implemented',
  not_implemented: 'Not implemented',
  unknown: 'Unknown',
};

const ACTIVATION_LABELS: Record<string, string> = {
  activated: 'Activated',
  not_activated: 'Not activated',
  pending: 'Pending activation',
  unknown: 'Unknown',
  not_requested: 'Not requested',
};

const DIMENSION_LABELS: Record<GhlSubResultDimension, string> = {
  configuration: 'Configuration',
  activation: 'Activation',
  functional_proof: 'Functional proof',
  sync: 'Sync',
};

const SUB_RESULT_STATE_LABELS: Record<GhlSubResultState, string> = {
  verified: 'Verified',
  pending: 'Pending',
  blocked: 'Blocked',
  failed: 'Failed',
  unknown: 'Unknown',
  not_requested: 'Not requested',
};

/** Families s14.11 requires to be shown as four distinct sub-results. */
export const GHL_FAMILY_LABELS: Record<string, string> = {
  meetings: 'Meetings',
  ai: 'AI agents',
  kb: 'Knowledge bases',
  widgets: 'Widgets',
  projects: 'Projects',
};

export type Tone = 'verified' | 'progress' | 'attention' | 'danger' | 'unknown' | 'none';

const TONE_CLASS: Record<Tone, string> = {
  verified: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  progress: 'bg-blue-50 text-blue-700 border-blue-200',
  attention: 'bg-amber-50 text-amber-800 border-amber-200',
  danger: 'bg-red-50 text-red-700 border-red-200',
  unknown: 'bg-gray-100 text-gray-700 border-gray-300',
  none: 'bg-gray-50 text-gray-500 border-gray-200',
};

const SUB_RESULT_TONE: Record<GhlSubResultState, Tone> = {
  verified: 'verified',
  pending: 'progress',
  blocked: 'danger',
  failed: 'danger',
  unknown: 'unknown',
  not_requested: 'none',
};

const OUTCOME_TONE: Record<GhlOutcome, Tone> = {
  planned: 'progress',
  submitted: 'progress',
  processing: 'progress',
  verified: 'verified',
  failed: 'danger',
  blocked: 'danger',
  unknown_outcome: 'unknown',
  not_requested: 'none',
};

// ─── Parsed payload ─────────────────────────────────────────────────────────

export interface GhlHybridOperation {
  operation_id: string;
  operation_key: string | null;
  rail: string;
  outcome: string;
  observed_at: string;
  attempt_id: string | null;
  skill: string | null;
  readback_state: string | null;
  readback_fields: string[];
  requested_visibility: string | null;
  actual_visibility: string | null;
  next_action: string | null;
}

export interface GhlHybridSubResult {
  family: string;
  dimension: string;
  state: string;
  detail: string | null;
  observed_at: string | null;
}

export interface GhlHybridFallback {
  reason: string;
  rail: string | null;
  result: string | null;
}

export interface GhlHybridObjectLink {
  label: string;
  href: string;
  objectType: string | null;
}

export interface GhlHybridSummary {
  schemaVersion: string | null;
  taskId: string | null;
  runId: string | null;
  businessGoal: string | null;
  owningDepartment: string | null;
  phase: string | null;
  implementationState: string | null;
  activationState: string | null;
  currentBlocker: string | null;
  nextAction: string | null;
  lastEventAt: string | null;
  builderId: string | null;
  reviewerId: string | null;
  fallback: GhlHybridFallback | null;
  operations: GhlHybridOperation[];
  subResults: GhlHybridSubResult[];
  objectLinks: GhlHybridObjectLink[];
}

export type GhlHybridParseResult =
  | { ok: true; summary: GhlHybridSummary }
  | { ok: false; reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function fail(reason: string): GhlHybridParseResult {
  return { ok: false, reason };
}

/** Keys whose presence proves the payload is a hybrid summary at all. */
const SUMMARY_MARKER_KEYS = [
  'operations', 'sub_results', 'phase', 'implementation_state', 'activation_state',
  'fallback', 'object_links', 'business_goal', 'owning_department', 'builder_id', 'reviewer_id',
];

/**
 * Validate a receipt-summary payload. Strict on identity fields, open on
 * additive ones: a payload that cannot be trusted fails as a WHOLE (named
 * reason), it is never partially rendered as if the missing rows did not exist.
 */
export function parseGhlHybridSummary(raw: unknown): GhlHybridParseResult {
  if (!isRecord(raw)) return fail('payload was not a JSON object');

  // Accept either the documented envelope { schema_version, summary } or a bare
  // summary object — one validator for both the API response and the row field.
  const body = isRecord(raw.summary) ? raw.summary : raw;

  const schemaVersionRaw = raw.schema_version ?? body.schema_version;
  if (schemaVersionRaw !== undefined && typeof schemaVersionRaw !== 'string') {
    return fail('schema_version was not a string');
  }
  const schemaVersion = optString(schemaVersionRaw);

  if (!SUMMARY_MARKER_KEYS.some((k) => k in body)) {
    return fail('payload carries no recognisable hybrid summary fields');
  }

  const operations: GhlHybridOperation[] = [];
  const rawOperations = body.operations;
  if (rawOperations !== undefined) {
    if (!Array.isArray(rawOperations)) return fail('operations was not an array');
    for (let i = 0; i < rawOperations.length; i += 1) {
      const row: unknown = rawOperations[i];
      if (!isRecord(row)) return fail(`operations[${i}] was not an object`);
      const operationId = optString(row.operation_id);
      const rail = optString(row.rail);
      const outcome = optString(row.outcome);
      const observedAt = optString(row.observed_at);
      const missing = [
        operationId ? null : 'operation_id',
        rail ? null : 'rail',
        outcome ? null : 'outcome',
        observedAt ? null : 'observed_at',
      ].filter((v): v is string => v !== null);
      if (missing.length > 0) {
        // A receipt without identity/rail/outcome/time cannot be displayed as
        // evidence — refuse the payload rather than silently dropping a row.
        return fail(`operations[${i}] is missing ${missing.join(', ')}`);
      }
      const readback = isRecord(row.readback) ? row.readback : null;
      const checked = readback && Array.isArray(readback.checked_fields)
        ? readback.checked_fields.filter((f): f is string => typeof f === 'string')
        : [];
      operations.push({
        operation_id: operationId as string,
        operation_key: optString(row.operation_key),
        rail: rail as string,
        outcome: outcome as string,
        observed_at: observedAt as string,
        attempt_id: optString(row.attempt_id),
        skill: optString(row.skill),
        readback_state: readback ? optString(readback.state) : null,
        readback_fields: checked,
        requested_visibility: optString(row.requested_visibility),
        actual_visibility: optString(row.actual_visibility),
        next_action: optString(row.next_action),
      });
    }
  }

  const subResults: GhlHybridSubResult[] = [];
  const rawSubResults = body.sub_results;
  if (rawSubResults !== undefined) {
    if (!Array.isArray(rawSubResults)) return fail('sub_results was not an array');
    for (let i = 0; i < rawSubResults.length; i += 1) {
      const row: unknown = rawSubResults[i];
      if (!isRecord(row)) return fail(`sub_results[${i}] was not an object`);
      const family = optString(row.family);
      const dimension = optString(row.dimension);
      const state = optString(row.state);
      const missing = [
        family ? null : 'family',
        dimension ? null : 'dimension',
        state ? null : 'state',
      ].filter((v): v is string => v !== null);
      if (missing.length > 0) return fail(`sub_results[${i}] is missing ${missing.join(', ')}`);
      subResults.push({
        family: family as string,
        dimension: dimension as string,
        state: state as string,
        detail: optString(row.detail),
        observed_at: optString(row.observed_at),
      });
    }
  }

  let fallback: GhlHybridFallback | null = null;
  if (body.fallback !== undefined && body.fallback !== null) {
    if (!isRecord(body.fallback)) return fail('fallback was not an object');
    const reason = optString(body.fallback.reason);
    if (!reason) return fail('fallback.reason is missing');
    fallback = {
      reason,
      rail: optString(body.fallback.rail),
      // Deliberately NOT defaulted: an absent result must read as unrecorded.
      result: optString(body.fallback.result),
    };
  }

  const objectLinks: GhlHybridObjectLink[] = [];
  const rawObjectLinks = body.object_links;
  if (rawObjectLinks !== undefined) {
    if (!Array.isArray(rawObjectLinks)) return fail('object_links was not an array');
    for (let i = 0; i < rawObjectLinks.length; i += 1) {
      const row: unknown = rawObjectLinks[i];
      if (!isRecord(row)) return fail(`object_links[${i}] was not an object`);
      const label = optString(row.label);
      const href = optString(row.href);
      const missing = [label ? null : 'label', href ? null : 'href']
        .filter((v): v is string => v !== null);
      if (missing.length > 0) return fail(`object_links[${i}] is missing ${missing.join(', ')}`);
      objectLinks.push({
        label: label as string,
        href: href as string,
        objectType: optString(row.object_type),
      });
    }
  }

  return {
    ok: true,
    summary: {
      schemaVersion,
      taskId: optString(body.task_id),
      runId: optString(body.run_id),
      businessGoal: optString(body.business_goal),
      owningDepartment: optString(body.owning_department),
      phase: optString(body.phase),
      implementationState: optString(body.implementation_state),
      activationState: optString(body.activation_state),
      currentBlocker: optString(body.current_blocker),
      nextAction: optString(body.next_action),
      lastEventAt: optString(body.last_event_at),
      builderId: optString(body.builder_id),
      reviewerId: optString(body.reviewer_id),
      fallback,
      operations,
      subResults,
      objectLinks,
    },
  };
}

// ─── Derived view model ─────────────────────────────────────────────────────

export interface GhlSubResultRow {
  dimension: GhlSubResultDimension;
  dimensionLabel: string;
  stateLabel: string;
  tone: Tone;
  detail: string | null;
  observedAt: string | null;
  /** False when the state string is outside the contract vocabulary. */
  recognised: boolean;
}

export interface GhlFamilyRow {
  family: string;
  label: string;
  cells: Record<GhlSubResultDimension, GhlSubResultRow | null>;
  extra: GhlSubResultRow[];
}

export interface GhlOperationRow {
  operationId: string;
  railLabel: string;
  railRecognised: boolean;
  outcomeLabel: string;
  outcomeRecognised: boolean;
  tone: Tone;
  observedLabel: string;
  readbackLabel: string | null;
  visibilityLabel: string | null;
  nextAction: string | null;
}

export interface GhlHybridView {
  schemaVersion: string | null;
  schemaWarning: string | null;
  businessGoal: string | null;
  owningDepartment: string | null;
  phase: string | null;
  railLabel: string | null;
  railRecognised: boolean;
  resultLabel: string;
  resultTone: Tone;
  unknownOutcome: boolean;
  unrecognisedOutcome: string | null;
  verified: number;
  required: number;
  fallback: { reason: string; railLabel: string | null; result: string | null; resultMissing: boolean } | null;
  objectLinks: GhlHybridObjectLink[];
  blocker: string | null;
  nextAction: string | null;
  lastEventAt: string | null;
  lastEventLabel: string;
  freshness: 'live' | 'stale' | 'unknown';
  freshnessNote: string | null;
  builderId: string | null;
  reviewerId: string | null;
  implementationLabel: string;
  implementationRecognised: boolean;
  activationLabel: string;
  activationRecognised: boolean;
  families: GhlFamilyRow[];
  operations: GhlOperationRow[];
}

/** Deterministic US-Eastern 12-hour label. Returns null for an unusable value. */
export function formatGhlTime(iso: string | null | undefined): string | null {
  if (typeof iso !== 'string' || iso.trim() === '') return null;
  const when = new Date(iso);
  if (Number.isNaN(when.getTime())) return null;
  const text = when.toLocaleString('en-US', {
    timeZone: 'America/New_York',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
  return `${text} Eastern`;
}

function newestTimestamp(values: Array<string | null | undefined>): string | null {
  let best: { raw: string; at: number } | null = null;
  for (const value of values) {
    if (typeof value !== 'string' || value.trim() === '') continue;
    const at = new Date(value).getTime();
    if (Number.isNaN(at)) continue;
    if (!best || at > best.at) best = { raw: value, at };
  }
  return best ? best.raw : null;
}

/**
 * Turn a validated summary into exactly the display facts s14.8 requires.
 * Pure function — no clock reads, so a component re-render can never fabricate
 * freshness or a timestamp.
 */
export function buildGhlHybridView(
  summary: GhlHybridSummary,
  lifecycle?: LifecycleCard | null,
): GhlHybridView {
  const operations = summary.operations;
  const required = operations.length;
  const verified = operations.filter((op) => op.outcome === 'verified').length;

  const recognisedOutcomes = operations
    .map((op) => op.outcome)
    .filter((o): o is GhlOutcome => (GHL_OUTCOMES as readonly string[]).includes(o));
  const unrecognised = operations.find((op) => !(GHL_OUTCOMES as readonly string[]).includes(op.outcome));

  const unknownOutcome = recognisedOutcomes.includes('unknown_outcome');

  let resultLabel: string;
  let resultTone: Tone;
  if (unknownOutcome) {
    resultLabel = 'Outcome unknown — reconcile';
    resultTone = 'unknown';
  } else if (unrecognised) {
    resultLabel = `Unrecognised outcome: ${unrecognised.outcome}`;
    resultTone = 'unknown';
  } else if (recognisedOutcomes.includes('failed')) {
    resultLabel = `${verified}/${required} verified — a step failed`;
    resultTone = 'danger';
  } else if (recognisedOutcomes.includes('blocked')) {
    resultLabel = `${verified}/${required} verified — blocked`;
    resultTone = 'danger';
  } else if (required > 0 && verified === required) {
    resultLabel = `${verified}/${required} verified`;
    resultTone = 'verified';
  } else if (recognisedOutcomes.some((o) => o === 'planned' || o === 'submitted' || o === 'processing')) {
    resultLabel = `${verified}/${required} verified — in progress`;
    resultTone = 'progress';
  } else if (required === 0) {
    resultLabel = 'No operations recorded';
    resultTone = 'none';
  } else {
    resultLabel = `${verified}/${required} verified`;
    resultTone = 'attention';
  }

  // Newest REAL timestamp only — never the render time.
  const lastEventAt = summary.lastEventAt
    ?? newestTimestamp([
      ...operations.map((op) => op.observed_at),
      ...summary.subResults.map((row) => row.observed_at),
    ]);

  let freshness: GhlHybridView['freshness'] = 'live';
  let freshnessNote: string | null = null;
  if (lifecycle && lifecycle.state === 'stale') {
    freshness = 'stale';
    freshnessNote = lifecycle.stale_reason === 'source_missing'
      ? 'Board lifecycle can no longer prove this card: source record deleted.'
      : 'Board lifecycle can no longer prove this card: event stream stalled.';
  } else if (lifecycle && lifecycle.state === 'unknown') {
    freshness = 'unknown';
    freshnessNote = `Newest lifecycle event carries an unrecognised status (${lifecycle.unknown_event_type ?? 'unnamed'}).`;
  } else if (!lastEventAt) {
    freshness = 'unknown';
    freshnessNote = 'No real event timestamp is recorded for this task.';
  }

  // Group sub-results per family; each of the four dimensions stays distinct.
  const order: string[] = [
    ...Object.keys(GHL_FAMILY_LABELS),
    ...Array.from(new Set(summary.subResults.map((r) => r.family))).filter(
      (f) => !(f in GHL_FAMILY_LABELS),
    ),
  ];
  const families: GhlFamilyRow[] = [];
  for (const family of order) {
    const rows = summary.subResults.filter((r) => r.family === family);
    if (rows.length === 0) continue;
    const cells = {
      configuration: null, activation: null, functional_proof: null, sync: null,
    } as Record<GhlSubResultDimension, GhlSubResultRow | null>;
    const extra: GhlSubResultRow[] = [];
    for (const row of rows) {
      const recognisedState = (GHL_SUB_RESULT_STATES as readonly string[]).includes(row.state);
      const state = (recognisedState ? row.state : 'unknown') as GhlSubResultState;
      const cell: GhlSubResultRow = {
        dimension: (row.dimension as GhlSubResultDimension),
        dimensionLabel: (DIMENSION_LABELS as Record<string, string>)[row.dimension] ?? row.dimension,
        stateLabel: recognisedState
          ? SUB_RESULT_STATE_LABELS[state]
          : `Unrecognised: ${row.state}`,
        tone: recognisedState ? SUB_RESULT_TONE[state] : 'unknown',
        detail: row.detail,
        observedAt: row.observed_at,
        recognised: recognisedState,
      };
      if ((GHL_SUB_RESULT_DIMENSIONS as readonly string[]).includes(row.dimension)) {
        cells[row.dimension as GhlSubResultDimension] = cell;
      } else {
        extra.push(cell);
      }
    }
    families.push({
      family,
      label: GHL_FAMILY_LABELS[family] ?? family,
      cells,
      extra,
    });
  }

  const operationRows: GhlOperationRow[] = operations.map((op) => {
    const railRecognised = (GHL_RAILS as readonly string[]).includes(op.rail);
    const outcomeRecognised = (GHL_OUTCOMES as readonly string[]).includes(op.outcome);
    const visibilityParts: string[] = [];
    if (op.requested_visibility) visibilityParts.push(`requested ${op.requested_visibility}`);
    if (op.actual_visibility) {
      visibilityParts.push(
        op.actual_visibility === 'scheduled'
          ? 'scheduled — not published'
          : `actual ${op.actual_visibility}`,
      );
    }
    return {
      operationId: op.operation_id,
      railLabel: railRecognised ? RAIL_LABELS[op.rail as GhlRail] : `Unrecognised rail: ${op.rail}`,
      railRecognised,
      outcomeLabel: outcomeRecognised ? OUTCOME_LABELS[op.outcome as GhlOutcome] : `Unrecognised: ${op.outcome}`,
      outcomeRecognised,
      tone: outcomeRecognised ? OUTCOME_TONE[op.outcome as GhlOutcome] : 'unknown',
      observedLabel: formatGhlTime(op.observed_at) ?? `Unreadable time: ${op.observed_at}`,
      readbackLabel: op.readback_state
        ? `readback ${op.readback_state}${op.readback_fields.length ? ` (${op.readback_fields.join(', ')})` : ''}`
        : null,
      visibilityLabel: visibilityParts.length ? visibilityParts.join(' · ') : null,
      nextAction: op.next_action,
    };
  });

  const newestRail = operations.length > 0
    ? operations.reduce((best, op) => {
        const bestAt = new Date(best.observed_at).getTime();
        const opAt = new Date(op.observed_at).getTime();
        if (Number.isNaN(opAt)) return best;
        if (Number.isNaN(bestAt) || opAt > bestAt) return op;
        return best;
      }, operations[0]).rail
    : null;
  const railRecognised = newestRail !== null && (GHL_RAILS as readonly string[]).includes(newestRail);

  const implState = summary.implementationState;
  const activationState = summary.activationState;

  return {
    schemaVersion: summary.schemaVersion,
    schemaWarning: summary.schemaVersion && summary.schemaVersion !== '1.0.0'
      ? `Receipt schema ${summary.schemaVersion} (this panel displays 1.0.0)`
      : null,
    businessGoal: summary.businessGoal,
    owningDepartment: summary.owningDepartment,
    phase: summary.phase,
    railLabel: newestRail === null
      ? null
      : railRecognised
        ? RAIL_LABELS[newestRail as GhlRail]
        : `Unrecognised rail: ${newestRail}`,
    railRecognised,
    resultLabel,
    resultTone,
    unknownOutcome,
    unrecognisedOutcome: unrecognised ? unrecognised.outcome : null,
    verified,
    required,
    fallback: summary.fallback
      ? {
          reason: summary.fallback.reason,
          railLabel: summary.fallback.rail
            ? ((GHL_RAILS as readonly string[]).includes(summary.fallback.rail)
                ? RAIL_LABELS[summary.fallback.rail as GhlRail]
                : `Unrecognised rail: ${summary.fallback.rail}`)
            : null,
          result: summary.fallback.result,
          resultMissing: summary.fallback.result === null,
        }
      : null,
    objectLinks: summary.objectLinks,
    blocker: summary.currentBlocker,
    nextAction: summary.nextAction,
    lastEventAt,
    lastEventLabel: formatGhlTime(lastEventAt) ?? 'No event on record',
    freshness,
    freshnessNote,
    builderId: summary.builderId,
    reviewerId: summary.reviewerId,
    implementationLabel: implState
      ? (IMPLEMENTATION_LABELS[implState] ?? `Unrecognised: ${implState}`)
      : 'Not reported',
    implementationRecognised: implState !== null && implState in IMPLEMENTATION_LABELS,
    activationLabel: activationState
      ? (ACTIVATION_LABELS[activationState] ?? `Unrecognised: ${activationState}`)
      : 'Not reported',
    activationRecognised: activationState !== null && activationState in ACTIVATION_LABELS,
    families,
    operations: operationRows,
  };
}

/**
 * Card-face entry point: read the optional summary attached to the task row.
 * Zero network requests per card. `undefined` = the field is absent (nothing to
 * show); any other value is validated, and an invalid one is surfaced loudly.
 */
export function readGhlSummaryField(task: unknown): unknown {
  if (!isRecord(task)) return undefined;
  return task.ghl_hybrid;
}

// ─── Compact card-face chips ────────────────────────────────────────────────

export function GhlHybridChips({ view }: { view: GhlHybridView }) {
  return (
    <div
      data-testid="ghl-hybrid-chips"
      aria-label="GHL hybrid progress"
      className="mt-1 flex flex-wrap items-center gap-1"
    >
      {view.phase && (
        <span
          data-testid="ghl-chip-phase"
          className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium bg-sky-50 text-sky-700 border border-sky-200"
          title={`Current GHL phase: ${view.phase}`}
        >
          <Wrench className="h-2.5 w-2.5" aria-hidden="true" />
          {view.phase}
        </span>
      )}
      {view.railLabel && (
        <span
          data-testid="ghl-chip-rail"
          className={
            'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium border ' +
            (view.railRecognised ? TONE_CLASS.progress : TONE_CLASS.unknown)
          }
        >
          rail: {view.railLabel}
        </span>
      )}
      <span
        data-testid="ghl-chip-result"
        className={'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold border ' + TONE_CLASS[view.resultTone]}
      >
        {view.resultLabel}
      </span>
      {view.freshness !== 'live' && (
        <span
          data-testid="ghl-chip-freshness"
          className={
            'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold border ' +
            (view.freshness === 'stale' ? TONE_CLASS.danger : TONE_CLASS.unknown)
          }
          title={view.freshnessNote ?? undefined}
        >
          {view.freshness === 'stale' ? 'STALE' : 'UNKNOWN'}
        </span>
      )}
      {view.blocker && (
        <span
          data-testid="ghl-chip-blocker"
          className={'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium border ' + TONE_CLASS.danger}
          title={view.blocker}
        >
          <AlertTriangle className="h-2.5 w-2.5" aria-hidden="true" />
          {view.blocker.length > 48 ? `${view.blocker.slice(0, 48)}…` : view.blocker}
        </span>
      )}
    </div>
  );
}

/** Loud, honest card chip for a summary that could not be read. */
export function GhlHybridUnreadableChip({ reason }: { reason: string }) {
  return (
    <div className="mt-1 flex flex-wrap items-center gap-1">
      <span
        data-testid="ghl-hybrid-unreadable-chip"
        className={'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold border ' + TONE_CLASS.danger}
        title={reason}
      >
        <ShieldAlert className="h-2.5 w-2.5" aria-hidden="true" />
        GHL progress unreadable
      </span>
    </div>
  );
}

// ─── Full panel (task-detail modal) ─────────────────────────────────────────

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="py-1.5">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">{label}</p>
      <div className="mt-0.5 text-xs text-gray-700">{children}</div>
    </div>
  );
}

const MUTED = 'text-xs italic text-gray-400';

export function GhlHybridProgress({ view }: { view: GhlHybridView }) {
  const pct = view.required > 0 ? Math.round((view.verified / view.required) * 100) : 0;

  return (
    <div
      className="rounded-xl border border-gray-200 bg-gray-50 p-4"
      data-testid="ghl-hybrid-progress"
    >
      <div className="mb-2 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <div className="rounded-full bg-sky-100 p-1.5">
            <Wrench className="h-4 w-4 text-sky-700" aria-hidden="true" />
          </div>
          <h4 className="text-sm font-semibold text-gray-900">GHL hybrid progress</h4>
        </div>
        <span
          data-testid="ghl-progress-freshness"
          className={
            'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold border ' +
            (view.freshness === 'live' ? TONE_CLASS.verified : view.freshness === 'stale' ? TONE_CLASS.danger : TONE_CLASS.unknown)
          }
          title={view.freshnessNote ?? undefined}
        >
          {view.freshness === 'live' ? 'LIVE' : view.freshness === 'stale' ? 'STALE' : 'UNKNOWN'}
        </span>
      </div>

      {view.schemaWarning && (
        <p className="mb-2 text-[11px] text-amber-700" data-testid="ghl-progress-schema-warning">
          {view.schemaWarning}
        </p>
      )}

      {/* Phase / rail / result */}
      <div className="mb-2 flex flex-wrap items-center gap-1.5">
        {view.phase && (
          <span data-testid="ghl-progress-phase" className="inline-flex items-center rounded-full bg-sky-50 px-2 py-0.5 text-[11px] font-medium text-sky-700 border border-sky-200">
            Phase: {view.phase}
          </span>
        )}
        {view.railLabel && (
          <span
            data-testid="ghl-progress-rail"
            className={'inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium border ' + (view.railRecognised ? TONE_CLASS.progress : TONE_CLASS.unknown)}
          >
            Selected rail: {view.railLabel}
          </span>
        )}
        <span
          data-testid="ghl-progress-result"
          className={'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold border ' + TONE_CLASS[view.resultTone]}
        >
          {view.resultTone === 'verified' && <CheckCircle2 className="h-3 w-3" aria-hidden="true" />}
          {view.resultLabel}
        </span>
      </div>

      {/* Verified vs required */}
      <div className="mb-3" data-testid="ghl-progress-counts">
        <div className="flex items-center justify-between text-[11px] text-gray-600">
          <span>
            Verified <strong>{view.verified}</strong> of <strong>{view.required}</strong> required operation
            {view.required === 1 ? '' : 's'}
          </span>
          <span className="text-gray-400">{pct}%</span>
        </div>
        <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-gray-200">
          <div
            className={'h-full rounded-full ' + (view.verified === view.required && view.required > 0 ? 'bg-emerald-500' : 'bg-sky-500')}
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>

      <div className="divide-y divide-gray-200 border-t border-gray-200">
        {view.businessGoal && <Row label="Business goal">{view.businessGoal}</Row>}
        {view.owningDepartment && <Row label="Owning department">{view.owningDepartment}</Row>}

        {/* Implementation ≠ activation (s1.3): two separate rows, always. */}
        <Row label="Implementation">
          <span data-testid="ghl-progress-implementation">{view.implementationLabel}</span>
        </Row>
        <Row label="Tenant activation">
          <span data-testid="ghl-progress-activation">{view.activationLabel}</span>
          <span className="ml-2 text-[11px] italic text-gray-400">
            (code state and tenant state are separate facts)
          </span>
        </Row>

        <Row label="Fallback">
          {view.fallback ? (
            <div data-testid="ghl-progress-fallback">
              <p>
                <span className="font-medium">Fallback selected.</span> Reason: {view.fallback.reason}
              </p>
              {view.fallback.railLabel && <p className="text-gray-500">Rail: {view.fallback.railLabel}</p>}
              {view.fallback.resultMissing ? (
                <p className="text-amber-700" data-testid="ghl-progress-fallback-result">
                  Actual result not recorded — treat as unknown.
                </p>
              ) : (
                <p className="text-gray-700" data-testid="ghl-progress-fallback-result">
                  Actual result: {view.fallback.result}
                </p>
              )}
            </div>
          ) : (
            <span className={MUTED}>No fallback recorded.</span>
          )}
        </Row>

        <Row label="Current blocker">
          {view.blocker ? (
            <span className="font-medium text-red-700" data-testid="ghl-progress-blocker">{view.blocker}</span>
          ) : (
            <span className={MUTED}>No blocker recorded.</span>
          )}
        </Row>

        <Row label="Next action">
          {view.nextAction ? (
            <span data-testid="ghl-progress-next-action">{view.nextAction}</span>
          ) : (
            <span className={MUTED}>No next action recorded.</span>
          )}
        </Row>

        <Row label="Last real event">
          <span data-testid="ghl-progress-last-event" className="inline-flex items-center gap-1">
            <Clock className="h-3 w-3 text-gray-400" aria-hidden="true" />
            {view.lastEventLabel}
          </span>
        </Row>

        <Row label="Builder / reviewer">
          <span data-testid="ghl-progress-builder">builder {view.builderId ?? 'not recorded'}</span>
          <span className="mx-2 text-gray-300">·</span>
          <span data-testid="ghl-progress-reviewer">reviewer {view.reviewerId ?? 'not recorded'}</span>
        </Row>

        <Row label="Object links">
          {view.objectLinks.length === 0 ? (
            <span className={MUTED}>No object links recorded.</span>
          ) : (
            <ul className="space-y-1" data-testid="ghl-progress-links">
              {view.objectLinks.map((link, i) => (
                <li key={`${link.href}-${i}`} className="flex items-center gap-1">
                  <Link2 className="h-3 w-3 text-gray-400" aria-hidden="true" />
                  {/^https?:\/\//i.test(link.href) ? (
                    <a
                      className="text-indigo-600 hover:underline"
                      href={link.href}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {link.label}
                    </a>
                  ) : (
                    <span title="Only http(s) object links are rendered as links">
                      {link.label} <span className="italic text-gray-400">(link withheld)</span>
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Row>
      </div>

      {/* Distinct sub-results per family — configuration / activation / proof / sync */}
      {view.families.length > 0 && (
        <div className="mt-3 border-t border-gray-200 pt-3" data-testid="ghl-progress-sub-results">
          <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-gray-400">
            Feature families
          </p>
          <div className="space-y-2">
            {view.families.map((family) => (
              <div key={family.family} data-testid={`ghl-family-${family.family}`}>
                <p className="text-xs font-semibold text-gray-800">{family.label}</p>
                <div className="mt-1 grid grid-cols-2 gap-1 sm:grid-cols-4">
                  {GHL_SUB_RESULT_DIMENSIONS.map((dimension) => {
                    const cell = family.cells[dimension];
                    return (
                      <div
                        key={dimension}
                        data-testid={`ghl-family-${family.family}-${dimension}`}
                        className={
                          'rounded-md border px-2 py-1 text-[10px] ' +
                          (cell ? TONE_CLASS[cell.tone] : 'bg-white text-gray-400 border-gray-200')
                        }
                        title={cell?.detail ?? undefined}
                      >
                        <span className="block font-semibold uppercase tracking-wide opacity-70">
                          {DIMENSION_LABELS[dimension]}
                        </span>
                        <span>{cell ? cell.stateLabel : 'Not reported'}</span>
                      </div>
                    );
                  })}
                </div>
                {family.extra.length > 0 && (
                  <p className="mt-1 text-[10px] text-gray-500">
                    Additional reported dimensions:{' '}
                    {family.extra.map((cell) => `${cell.dimensionLabel} — ${cell.stateLabel}`).join('; ')}
                  </p>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Per-operation evidence */}
      <div className="mt-3 border-t border-gray-200 pt-3" data-testid="ghl-progress-operations">
        <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-gray-400">
          Operations
        </p>
        {view.operations.length === 0 ? (
          <p className={MUTED}>No operation receipts recorded.</p>
        ) : (
          <ul className="space-y-1.5">
            {view.operations.map((op, i) => (
              <li key={`${op.operationId}-${i}`} className="rounded-md border border-gray-200 bg-white p-2">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="font-mono text-[11px] text-gray-700">{op.operationId}</span>
                  <span className={'rounded-full border px-1.5 py-0.5 text-[10px] font-medium ' + TONE_CLASS[op.tone]}>
                    {op.outcomeLabel}
                  </span>
                  <span className={'rounded-full border px-1.5 py-0.5 text-[10px] ' + (op.railRecognised ? TONE_CLASS.progress : TONE_CLASS.unknown)}>
                    {op.railLabel}
                  </span>
                  <span className="text-[10px] text-gray-400">{op.observedLabel}</span>
                </div>
                {op.readbackLabel && <p className="mt-0.5 text-[10px] text-gray-500">{op.readbackLabel}</p>}
                {op.visibilityLabel && <p className="mt-0.5 text-[10px] text-gray-500">{op.visibilityLabel}</p>}
                {op.nextAction && <p className="mt-0.5 text-[10px] text-gray-600">Next: {op.nextAction}</p>}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

// ─── Fetching panel (one read, no execution controls) ───────────────────────

type PanelState =
  | { kind: 'loading' }
  | { kind: 'absent' }
  | { kind: 'error'; message: string }
  | { kind: 'ok'; raw: unknown };

/**
 * Read the WF18 receipt surface for one task.
 *
 * 404 renders NOTHING (no receipts, or the surface is not deployed yet) — a
 * quiet absence never asserts success. Any other failure and any unparseable
 * body render an explicit error, so a broken receipt feed can never look like
 * a clean run.
 */
export function GhlHybridPanel({
  taskId,
  lifecycle,
  initialRaw,
}: {
  taskId: string;
  lifecycle?: LifecycleCard | null;
  /** Test/pre-loaded payload; when provided no request is made. */
  initialRaw?: unknown;
}) {
  // The task id travels WITH the state, so switching tasks reads as loading
  // instead of briefly showing the previous task's receipts.
  const [scoped, setScoped] = useState<{ taskId: string; panel: PanelState }>(
    initialRaw !== undefined
      ? { taskId, panel: { kind: 'ok', raw: initialRaw } }
      : { taskId, panel: { kind: 'loading' } },
  );

  useEffect(() => {
    // A pre-loaded payload is already in state from the initializer; skip the
    // request entirely.
    if (initialRaw !== undefined) return;
    let cancelled = false;
    const controller = new AbortController();
    fetch(`/api/tasks/${encodeURIComponent(taskId)}/ghl-operations`, {
      cache: 'no-store',
      signal: controller.signal,
    })
      .then(async (res) => {
        if (cancelled) return;
        if (res.status === 404) {
          setScoped({ taskId, panel: { kind: 'absent' } });
          return;
        }
        if (!res.ok) {
          setScoped({
            taskId,
            panel: {
              kind: 'error',
              message: `GHL operation receipts could not be read (HTTP ${res.status}).`,
            },
          });
          return;
        }
        const body: unknown = await res.json().catch(() => null);
        if (cancelled) return;
        setScoped({ taskId, panel: { kind: 'ok', raw: body } });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof Error && err.name === 'AbortError') return;
        setScoped({
          taskId,
          panel: { kind: 'error', message: 'GHL operation receipts could not be reached.' },
        });
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [taskId, initialRaw]);

  // A state stamped with a different task is not this task's evidence.
  const state: PanelState = scoped.taskId === taskId ? scoped.panel : { kind: 'loading' };

  if (state.kind === 'loading' || state.kind === 'absent') return null;

  if (state.kind === 'error') {
    return (
      <div
        className="rounded-xl border border-red-300 bg-red-50 p-4"
        data-testid="ghl-hybrid-panel-error"
        role="status"
      >
        <div className="flex items-center gap-2">
          <ShieldAlert className="h-4 w-4 text-red-600" aria-hidden="true" />
          <h4 className="text-sm font-semibold text-red-900">GHL hybrid progress unavailable</h4>
        </div>
        <p className="mt-1 text-xs text-red-800">{state.message}</p>
        <p className="mt-1 text-[11px] italic text-red-700">
          Unknown is shown as unknown — this panel never reports a run as clean when it could not read the receipts.
        </p>
      </div>
    );
  }

  const parsed = parseGhlHybridSummary(state.raw);
  if (!parsed.ok) {
    return (
      <div
        className="rounded-xl border border-red-300 bg-red-50 p-4"
        data-testid="ghl-hybrid-panel-unreadable"
        role="status"
      >
        <div className="flex items-center gap-2">
          <ShieldAlert className="h-4 w-4 text-red-600" aria-hidden="true" />
          <h4 className="text-sm font-semibold text-red-900">GHL operation receipts unreadable</h4>
        </div>
        <p className="mt-1 text-xs text-red-800">{parsed.reason}</p>
      </div>
    );
  }

  return <GhlHybridProgress view={buildGhlHybridView(parsed.summary, lifecycle)} />;
}
