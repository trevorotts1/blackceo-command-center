import { NextRequest, NextResponse } from 'next/server';
import {
  resolvePublishCompany,
} from '@/lib/social/company-context';
import {
  MIN_SAMPLE_FOR_CONFIDENCE,
  aggregateMetric,
  latestMetricsForCompany,
  recordMetricObservation,
  recordPerformanceReview,
  reviewsForCompany,
  variantsForCompany,
  type MetricAggregate,
} from '@/lib/social/measured-outcomes';
import { reviewCompany } from '@/lib/jobs/social-performance-review';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * GET /api/social/performance — the planner Performance view (F40).
 *
 * Company-scoped through the SAME authenticated identity seam as every other
 * /api/social route (bearer MC_API_TOKEN / signed tenant session / CF Access
 * JWT). Returns the caller's OWN outcome data only:
 *   - metrics: raw observations with is_unknown flags (missing is unknown,
 *     never zero) and per-metric aggregates whose totals skip unknowns,
 *   - variants: the baseline/trial registry with the one changed variable,
 *   - reviews: cadence reviews whose recommendations cite actual posts and
 *     windows; tentative=true while the sample is below MIN_SAMPLE_FOR_CONFIDENCE.
 * A foreign company's history is unreachable by construction: every query
 * filters company_id = caller's.
 */
export async function GET(request: NextRequest) {
  const identity = await resolvePublishCompany(request);
  if (!identity.ok) {
    return NextResponse.json({ error: identity.error }, { status: identity.status });
  }
  const { companyId } = identity.company;

  const rows = latestMetricsForCompany(companyId, { limit: 1000 });
  const metricNames = [...new Set(rows.map((r) => r.metric))];
  const aggregates: MetricAggregate[] = metricNames
    .map((metric) => aggregateMetric(rows, metric))
    .filter((a) => a.known_count + a.unknown_count > 0);

  return NextResponse.json({
    metrics: rows,
    aggregates,
    variants: variantsForCompany(companyId),
    reviews: reviewsForCompany(companyId),
    policy: {
      min_sample_for_confidence: MIN_SAMPLE_FOR_CONFIDENCE,
      rule: 'missing analytics is unknown, never zero; recommendations cite actual posts and windows; low samples stay tentative and never trigger uncontrolled content or spending increases',
    },
  });
}

interface ObservationBody {
  observations?: Array<{
    /** Accepted but IGNORED — the authenticated caller's company always wins. */
    company_id?: string;
    account_id?: string;
    post_id?: string;
    platform?: string;
    metric?: string;
    /** null/absent = UNKNOWN (the provider did not report it). */
    value?: number | null;
    window_start?: string | null;
    window_end?: string | null;
    source?: string;
    fetched_at?: string;
  }>;
}

/**
 * POST /api/social/performance — ingest metric observations (the adapter
 * seam: GHL analytics where available, manual input, or delivery-receipt
 * reconciliation; NO live calls from this route itself).
 *
 * Value semantics: a missing/null/non-finite value is stored UNKNOWN —
 * never zero, never interpolated. Unknown metrics still record coverage.
 */
export async function POST(request: NextRequest) {
  const identity = await resolvePublishCompany(request);
  if (!identity.ok) {
    return NextResponse.json({ error: identity.error }, { status: identity.status });
  }
  const { companyId } = identity.company;

  let body: ObservationBody;
  try {
    body = (await request.json()) as ObservationBody;
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
  }
  const observations = body?.observations;
  if (!Array.isArray(observations) || observations.length === 0) {
    return NextResponse.json({ error: 'observations[] required' }, { status: 400 });
  }
  if (observations.length > 500) {
    return NextResponse.json({ error: 'too many observations (max 500 per call)' }, { status: 400 });
  }

  const stored: string[] = [];
  const rejected: Array<{ index: number; reason: string }> = [];
  observations.forEach((obs, index) => {
    try {
      // company_id is ALWAYS the authenticated caller's — a body-supplied
      // company_id is ignored, so one client can never write into another's
      // history.
      const { company_id: _ignored, ...rest } = obs;
      stored.push(recordMetricObservation({
        company_id: companyId,
        account_id: String(rest.account_id ?? ''),
        post_id: String(rest.post_id ?? ''),
        platform: rest.platform,
        metric: String(rest.metric ?? ''),
        value: rest.value ?? null,
        window_start: rest.window_start ?? null,
        window_end: rest.window_end ?? null,
        source: rest.source,
        fetched_at: rest.fetched_at,
      }));
    } catch (e) {
      rejected.push({ index, reason: e instanceof Error ? e.message : 'invalid observation' });
    }
  });

  return NextResponse.json(
    { stored: stored.length, rejected },
    { status: rejected.length && !stored.length ? 400 : 201 },
  );
}

/**
 * PATCH /api/social/performance — run the cadence review for the caller's
 * company on demand (the scheduled sweep also does this; the explicit verb
 * makes the "review performance at an agreed cadence" contract provable and
 * client-triggerable).
 */
export async function PATCH(request: NextRequest) {
  const identity = await resolvePublishCompany(request);
  if (!identity.ok) {
    return NextResponse.json({ error: identity.error }, { status: identity.status });
  }
  const { companyId } = identity.company;
  const summary = reviewCompany(companyId);
  return NextResponse.json(summary);
}

/**
 * PUT /api/social/performance — record a client-approved review outcome.
 * Proposals are policy-guarded: anything touching provider/model or
 * publishing policy is rejected here, at the boundary, for F31/F37.
 */
export async function PUT(request: NextRequest) {
  const identity = await resolvePublishCompany(request);
  if (!identity.ok) {
    return NextResponse.json({ error: identity.error }, { status: identity.status });
  }
  const { companyId } = identity.company;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
  }

  try {
    const review = recordPerformanceReview({
      company_id: companyId,
      posts_reviewed: (body.posts_reviewed as string[]) || [],
      windows: (body.windows as Array<{ post_id?: string }>) || [],
      aggregates: (body.aggregates as MetricAggregate[]) || [],
      recommendation: (body.recommendation as string) || '',
      proposals: (body.proposals as Array<Record<string, unknown>>) || [],
      cadence: (body.cadence as string) || undefined,
    });
    return NextResponse.json({ review }, { status: 201 });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'review rejected' },
      { status: 422 },
    );
  }
}
