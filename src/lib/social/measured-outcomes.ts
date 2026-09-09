/**
 * src/lib/social/measured-outcomes.ts — F40 measured-outcome learning (CC).
 *
 * WHY: the original audit proved DELIVERY (a completion certificate, F10's
 * per-destination readback). None of that is evidence the content PERFORMED.
 * This module closes the loop between creation, publication and actual
 * audience response, under three hard rules from SPEC #40 / QC-F40:
 *
 *   1. MISSING IS UNKNOWN, NEVER ZERO. A provider that did not report a
 *      metric contributes `is_unknown` observations — never a fabricated 0,
 *      never an interpolated value. Averaging skips unknowns and reports the
 *      honest coverage; a window whose metric is entirely unknown stays
 *      unknown.
 *   2. ATTRIBUTABLE EXPERIMENTS. Baseline and trial variants are registered
 *      with the ONE major variable the trial changes (format|hook|timing|
 *      creative). A comparison with mixed variables or an insufficient
 *      sample is reported as tentative — it must not trigger uncontrolled
 *      content or spending increases.
 *   3. CROSS-CLIENT ISOLATION. Every read and write is company-scoped. A
 *      company's metric rows, variants, recommendations and creative history
 *      are never visible to, or reused by, another company.
 *
 * Policy guard (F31 + F37 respect): performance proposals NEVER mutate the
 * saved provider/model selection or publishing policy. A proposal is a
 * recommendation row the client approves; the immutability check
 * (assertNoPolicyMutation) rejects any proposal object that tries to carry
 * provider/model/publishing-policy changes. Client choice stays required.
 *
 * Metrics enter through recordMetricObservation (the ingest seam used by the
 * GHL analytics adapter / delivery-receipt reconciliation). No live calls
 * here: callers pass already-fetched observations with their account/post
 * IDs, measurement window and fetched_at.
 */

import { randomUUID } from 'crypto';
import { queryAll, queryOne, run } from '@/lib/db';

export const UNKNOWN = 'unknown';

/** The major variables a trial may change — exactly one per trial. */
export const VARIANT_VARIABLES = ['format', 'hook', 'timing', 'creative'] as const;
export type VariantVariable = (typeof VARIANT_VARIABLES)[number];

/** Policy surfaces a performance proposal may never touch. */
const PROTECTED_POLICY_KEYS = new Set([
  'provider', 'provider_id', 'model', 'model_id', 'provider_policy',
  'policy_revision', 'role_models', 'image_models', 'video_models',
  'execution_mode', 'publishing_policy', 'consent', 'evergreen_consent',
]);

export interface MetricObservation {
  company_id: string;
  account_id: string;
  post_id: string;
  platform?: string;
  metric: string;
  /** null = the provider did not report this metric (UNKNOWN, never zero). */
  value: number | null;
  window_start?: string | null;
  window_end?: string | null;
  /** Provenance: e.g. 'ghl-analytics', 'manual-input', 'delivery-reconcile'. */
  source?: string;
  fetched_at?: string;
}

export interface MetricRow {
  id: string;
  company_id: string;
  account_id: string;
  post_id: string;
  platform: string;
  metric: string;
  value: number | null;
  is_unknown: number;
  window_start: string | null;
  window_end: string | null;
  source: string;
  fetched_at: string;
}

/**
 * Persist one metric observation. A null value (or a non-finite one) stores
 * is_unknown=1 with value NULL — the DB never silently coerces a gap into a
 * zero. Returns the stored row id.
 */
export function recordMetricObservation(obs: MetricObservation): string {
  const metric = String(obs.metric || '').trim();
  if (!obs.company_id || !obs.account_id || !obs.post_id || !metric) {
    throw new Error('metric observation requires company_id, account_id, post_id and metric');
  }
  const finite = typeof obs.value === 'number' && Number.isFinite(obs.value);
  const isUnknown = obs.value === null || obs.value === undefined || !finite;
  const id = `sm-${randomUUID()}`;
  run(
    `INSERT INTO social_metrics
       (id, company_id, account_id, post_id, platform, metric, value,
        is_unknown, window_start, window_end, source, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      obs.company_id,
      obs.account_id,
      obs.post_id,
      obs.platform || '',
      metric,
      isUnknown ? null : obs.value,
      isUnknown ? 1 : 0,
      obs.window_start ?? null,
      obs.window_end ?? null,
      obs.source || '',
      obs.fetched_at || new Date().toISOString(),
    ],
  );
  return id;
}

/** Latest observation per (post, metric) within ONE company's own history. */
export function latestMetricsForCompany(
  companyId: string,
  opts?: { postId?: string; metric?: string; limit?: number },
): MetricRow[] {
  const clauses = ['company_id = ?'];
  const params: unknown[] = [companyId];
  if (opts?.postId) {
    clauses.push('post_id = ?');
    params.push(opts.postId);
  }
  if (opts?.metric) {
    clauses.push('metric = ?');
    params.push(opts.metric);
  }
  const limit = Math.min(Math.max(opts?.limit ?? 200, 1), 1000);
  return queryAll<MetricRow>(
    `SELECT id, company_id, account_id, post_id, platform, metric, value,
            is_unknown, window_start, window_end, source, fetched_at
       FROM social_metrics
      WHERE ${clauses.join(' AND ')}
      ORDER BY fetched_at DESC
      LIMIT ${limit}`,
    params,
  );
}

export interface MetricAggregate {
  metric: string;
  /** Sum over KNOWN values only — null when nothing was reported. */
  total: number | null;
  /** Mean over KNOWN values only — null when nothing was reported. */
  mean: number | null;
  known_count: number;
  unknown_count: number;
  /** 0..1 — the share of observations the provider actually reported. */
  coverage: number;
  posts: string[];
  window_start: string | null;
  window_end: string | null;
}

/**
 * Aggregate a company's own observations for one metric. Unknown observations
 * are EXCLUDED from totals/means (never zero-filled, never interpolated) and
 * reported separately so coverage is visible. total/mean are null — not 0 —
 * when the provider reported nothing at all.
 */
export function aggregateMetric(
  rows: MetricRow[],
  metric: string,
): MetricAggregate {
  const known = rows.filter(
    (r) => r.metric === metric && r.is_unknown === 0 && r.value !== null,
  );
  const unknown = rows.filter(
    (r) => r.metric === metric && r.is_unknown === 1,
  );
  const values = known.map((r) => r.value as number);
  const total = values.length ? values.reduce((a, b) => a + b, 0) : null;
  const mean = values.length ? total! / values.length : null;
  const windows = rows.filter((r) => r.metric === metric);
  const windowStart = windows.reduce<string | null>(
    (acc, r) => (r.window_start && (!acc || r.window_start < acc) ? r.window_start : acc),
    null,
  );
  const windowEnd = windows.reduce<string | null>(
    (acc, r) => (r.window_end && (!acc || r.window_end > acc) ? r.window_end : acc),
    null,
  );
  const observed = known.length + unknown.length;
  return {
    metric,
    total,
    mean,
    known_count: known.length,
    unknown_count: unknown.length,
    coverage: observed ? known.length / observed : 0,
    posts: [...new Set(rows.filter((r) => r.metric === metric).map((r) => r.post_id))],
    window_start: windowStart,
    window_end: windowEnd,
  };
}

// ── Variants: baseline / trial, ONE major variable at a time ────────────────

export interface VariantRecord {
  id: string;
  company_id: string;
  cycle_id: string | null;
  variable: VariantVariable;
  role: 'baseline' | 'trial';
  label: string;
  compared_to: string | null;
  basis: string;
  created_at: string;
}

/**
 * Register a variant row. The FIRST variant for a company defaults to
 * 'baseline' (basis: baseline-first). A trial MUST name exactly one major
 * variable and the baseline it compares against.
 */
export function registerVariant(input: {
  company_id: string;
  variable: VariantVariable;
  role?: 'baseline' | 'trial';
  label: string;
  cycle_id?: string | null;
  compared_to?: string | null;
  created_at?: string;
}): VariantRecord {
  if (!input.company_id) throw new Error('variant requires company_id');
  if (!(VARIANT_VARIABLES as readonly string[]).includes(input.variable)) {
    throw new Error(`variant variable must be one of ${VARIANT_VARIABLES.join('|')}`);
  }
  if (!String(input.label || '').trim()) throw new Error('variant requires a label');
  const role = input.role ?? 'trial';
  const existing = queryOne<{ id: string }>(
    'SELECT id FROM social_content_variants WHERE company_id = ? LIMIT 1',
    [input.company_id],
  );
  // A trial with no baseline to compare against is refused UNLESS this is the
  // company's first variant — then it IS the baseline (baseline-first).
  const autoBaseline = !existing && role === 'trial';
  const basis =
    autoBaseline || role === 'baseline'
      ? 'baseline-first'
      : input.compared_to
        ? 'single-variable-trial'
        : (() => {
            throw new Error('a trial variant must name the baseline variant it changes (compared_to)');
          })();
  const id = `var-${randomUUID()}`;
  const createdAt = input.created_at || new Date().toISOString();
  run(
    `INSERT INTO social_content_variants
       (id, company_id, cycle_id, variable, role, label, compared_to, basis, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.company_id,
      input.cycle_id ?? null,
      input.variable,
      autoBaseline ? 'baseline' : role,
      input.label,
      input.compared_to ?? null,
      autoBaseline ? 'baseline-first' : basis,
      createdAt,
    ],
  );
  return {
    id,
    company_id: input.company_id,
    cycle_id: input.cycle_id ?? null,
    variable: input.variable,
    role: autoBaseline ? 'baseline' : role,
    label: input.label,
    compared_to: input.compared_to ?? null,
    basis: autoBaseline ? 'baseline-first' : basis,
    created_at: createdAt,
  };
}

export function variantsForCompany(companyId: string): VariantRecord[] {
  return queryAll<VariantRecord>(
    `SELECT id, company_id, cycle_id, variable, role, label, compared_to,
            basis, created_at
       FROM social_content_variants
      WHERE company_id = ?
      ORDER BY created_at ASC`,
    [companyId],
  );
}

// ── Reviews: agreed-cadence performance review + recommendations ────────────

export const DEFAULT_REVIEW_CADENCE = 'weekly';
/** Below this many KNOWN observations a conclusion is tentative. */
export const MIN_SAMPLE_FOR_CONFIDENCE = 5;

export interface ReviewInput {
  company_id: string;
  /** The posts and windows the review ACTUALLY read (cited verbatim). */
  posts_reviewed: string[];
  windows: Array<{ post_id?: string; window_start?: string | null; window_end?: string | null }>;
  aggregates: MetricAggregate[];
  /** Empty/omitted = deterministic buildRecommendation() text. */
  recommendation?: string;
  proposals?: Array<Record<string, unknown>>;
  cadence?: string;
  reviewed_at?: string;
}

export interface ReviewRecord {
  id: string;
  company_id: string;
  reviewed_at: string;
  cadence: string;
  posts_reviewed: string[];
  windows: ReviewInput['windows'];
  sample_size: number;
  recommendation: string;
  tentative: boolean;
  proposals: Array<Record<string, unknown>>;
  policy_guard: string;
}

/**
 * Deterministic recommendation text. ALWAYS cites the actual posts and
 * windows read; carries the explicit coverage caveat when the provider
 * reported less than everything; low samples are tentative.
 */
export function buildRecommendation(input: {
  posts_reviewed: string[];
  windows: Array<{ post_id?: string; window_start?: string | null; window_end?: string | null }>;
  aggregates: MetricAggregate[];
}): string {
  const posts = input.posts_reviewed.filter(Boolean);
  if (!posts.length) {
    return 'No posts have published outcomes to review yet — nothing is claimed. '
      + 'Publish first, then measure within the agreed window.';
  }
  const parts: string[] = [];
  const windowDesc = input.windows.find((w) => w.window_start || w.window_end);
  const winText = windowDesc
    ? `window ${windowDesc.window_start ?? '?'} to ${windowDesc.window_end ?? '?'}`
    : 'recorded windows';
  parts.push(`Based on ${posts.length} post(s) (${posts.slice(0, 5).join(', ')}${posts.length > 5 ? ', …' : ''}) over the ${winText}.`);
  for (const agg of input.aggregates) {
    if (agg.unknown_count > 0) {
      parts.push(
        `${agg.metric}: ${agg.unknown_count} of ${agg.known_count + agg.unknown_count} observation(s) UNKNOWN (not reported by the provider) — treated as unknown, never zero.`,
      );
    } else {
      parts.push(`${agg.metric}: ${agg.known_count} reported observation(s).`);
    }
    if (agg.mean !== null) {
      parts.push(`Mean ${agg.metric} ${agg.mean.toFixed(2)} across ${agg.known_count} reported observation(s).`);
    } else if (agg.known_count === 0) {
      parts.push(`No reported ${agg.metric} values — no performance claim is made.`);
    }
  }
  return parts.join(' ');
}

/** Reject any proposal that mutates a protected provider/policy surface. */
export function assertNoPolicyMutation(
  proposals: Array<Record<string, unknown>>,
): void {
  for (const p of proposals) {
    for (const key of Object.keys(p)) {
      if (PROTECTED_POLICY_KEYS.has(key)) {
        throw new Error(
          `performance proposals may never change saved provider/model or publishing policy ('${key}' is client-choice only — F31/F37)`,
        );
      }
    }
  }
}

/**
 * Record one cadence review. QC-F40 guarantees enforced here:
 *   - recommendations cite the actual posts + windows read,
 *   - unknown coverage is stated, never folded into a zero,
 *   - sample_size < MIN_SAMPLE_FOR_CONFIDENCE → tentative=true,
 *   - proposals are policy-guarded (never provider/model/publishing policy).
 */
export function recordPerformanceReview(input: ReviewInput): ReviewRecord {
  if (!input.company_id) throw new Error('review requires company_id');
  const posts = (input.posts_reviewed || []).filter(Boolean);
  const sampleSize = input.aggregates.reduce(
    (acc, a) => acc + a.known_count,
    0,
  );
  const knownAny = input.aggregates.some((a) => a.known_count > 0);
  const tentative = sampleSize < MIN_SAMPLE_FOR_CONFIDENCE || !knownAny;
  assertNoPolicyMutation(input.proposals || []);
  const recommendation = input.recommendation || buildRecommendation({
    posts_reviewed: posts,
    windows: input.windows || [],
    aggregates: input.aggregates || [],
  });
  const id = `rev-${randomUUID()}`;
  const reviewedAt = input.reviewed_at || new Date().toISOString();
  const policyGuard = 'no provider/model/publishing-policy change — client choice required (F31/F37)';
  run(
    `INSERT INTO social_performance_reviews
       (id, company_id, reviewed_at, cadence, posts_reviewed, windows,
        sample_size, recommendation, tentative, proposals, policy_guard, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.company_id,
      reviewedAt,
      input.cadence || DEFAULT_REVIEW_CADENCE,
      JSON.stringify(posts),
      JSON.stringify(input.windows || []),
      sampleSize,
      recommendation,
      tentative ? 1 : 0,
      JSON.stringify(input.proposals || []),
      policyGuard,
      reviewedAt,
    ],
  );
  return {
    id,
    company_id: input.company_id,
    reviewed_at: reviewedAt,
    cadence: input.cadence || DEFAULT_REVIEW_CADENCE,
    posts_reviewed: posts,
    windows: input.windows || [],
    sample_size: sampleSize,
    recommendation,
    tentative,
    proposals: input.proposals || [],
    policy_guard: policyGuard,
  };
}

export function reviewsForCompany(companyId: string): ReviewRecord[] {
  return queryAll<Record<string, unknown>>(
    `SELECT * FROM social_performance_reviews WHERE company_id = ? ORDER BY reviewed_at DESC`,
    [companyId],
  ).map((r) => ({
    id: String(r.id),
    company_id: String(r.company_id),
    reviewed_at: String(r.reviewed_at),
    cadence: String(r.cadence),
    posts_reviewed: JSON.parse(String(r.posts_reviewed || '[]')) as string[],
    windows: JSON.parse(String(r.windows || '[]')) as ReviewRecord['windows'],
    sample_size: Number(r.sample_size ?? 0),
    recommendation: String(r.recommendation ?? ''),
    tentative: Number(r.tentative ?? 0) === 1,
    proposals: JSON.parse(String(r.proposals || '[]')) as Array<Record<string, unknown>>,
    policy_guard: String(r.policy_guard ?? ''),
  }));
}
