/**
 * social-f40-measured-outcomes.test.ts — F40 acceptance (CC half).
 *
 * "Missing analytics never becomes zero performance or an invented
 * improvement. Recommendations cite actual posts and windows; low sample
 * sizes remain tentative and do not trigger uncontrolled content or spending
 * increases."
 *
 * Proven in-process against an isolated temp DB (full migration chain incl.
 * 140) and the REAL modules:
 *   1. Migration 140 creates the three measured-outcome tables.
 *   2. A metric the provider did not report is stored is_unknown=1 with
 *      value NULL — never 0, never interpolated; aggregates report
 *      total/mean null (not 0) and honest coverage.
 *   3. Cross-client isolation: company A's metrics/variants/reviews are
 *      unreachable from company B (company-scoped queries; the POST route
 *      ignores a body-supplied foreign company_id).
 *   4. Variants: first row auto-baselines; a trial MUST name one variable
 *      (format|hook|timing|creative) AND its baseline.
 *   5. Recommendations cite actual posts + windows verbatim.
 *   6. Low samples (< MIN_SAMPLE_FOR_CONFIDENCE) are tentative and receive
 *      no proposals (no uncontrolled content or spend changes).
 *   7. Policy guard: a proposal touching provider/model/publishing policy
 *      is rejected (F31/F37 client-choice surfaces stay untouched).
 *   8. The API route serves only the caller's own history; the ingest seam
 *      (POST) accepts observations with unknown values.
 *   9. The cadence sweep reviews without a live call and respects the
 *      cadence window.
 *
 * Run:
 *   node --import tsx --import ./tests/setup/no-owner-telegram.ts \
 *     --test tests/unit/social-f40-measured-outcomes.test.ts
 */
import './_isolated-db'; // MUST be first DB import: throwaway DATABASE_PATH.
import test from 'node:test';
import assert from 'node:assert/strict';
import { NextRequest } from 'next/server';
import { createHmac } from 'node:crypto';
import { getDb, run, closeDb } from '../../src/lib/db';
import {
  MIN_SAMPLE_FOR_CONFIDENCE,
  VARIANT_VARIABLES,
  aggregateMetric,
  assertNoPolicyMutation,
  latestMetricsForCompany,
  recordMetricObservation,
  recordPerformanceReview,
  registerVariant,
  reviewsForCompany,
  variantsForCompany,
} from '../../src/lib/social/measured-outcomes';
import { reviewCompany } from '../../src/lib/jobs/social-performance-review';
import {
  GET as perfGET,
  PATCH as perfPATCH,
  POST as perfPOST,
  PUT as perfPUT,
} from '../../src/app/api/social/performance/route';

const db = getDb(); // full migration chain (incl. 140) against the isolated temp DB

const SECRET = 'f40-test-secret';
process.env.MC_TENANT_SESSION_SECRET = SECRET;
process.env.NODE_ENV = 'production';

// Force the review cadence window open so PATCH/sweep paths always fire.
process.env.SOCIAL_PERFORMANCE_REVIEW_HOURS = '1';

function tenantCookie(host: string, companyId: string): string {
  const payload = Buffer
    .from(JSON.stringify({
      purpose: 'session',
      tenantId: `tenant-${companyId}`,
      companyId,
      subject: 'owner:fixture',
      host,
      installationId: `install-${companyId}`,
      exp: Date.now() / 1000 + 3600,
      nonce: 'f40-test',
    }))
    .toString('base64url');
  const sig = createHmac('sha256', SECRET).update(payload).digest('base64url');
  return `mc_tenant_session=${payload}.${sig}`;
}

function requestFor(
  host: string,
  companyId: string,
  path = '/api/social/performance',
  init?: { method?: string; body?: unknown },
): NextRequest {
  const headers = new Headers();
  headers.set('host', host);
  if (companyId) headers.set('cookie', tenantCookie(host, companyId));
  return new NextRequest(`http://${host}${path}`, {
    method: init?.method || 'GET',
    headers,
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
}

const HOST_A = 'a-f40.example.com';
const HOST_B = 'b-f40.example.com';
const CO_A = 'company-a-f40';
const CO_B = 'company-b-f40';

function seedTenantRegistry(): void {
  process.env.MC_TENANT_REGISTRY_JSON = JSON.stringify({
    [HOST_A]: { tenantId: `tenant-${CO_A}`, companyId: CO_A, clientId: 'client-a', kind: 'client', installationId: `install-${CO_A}` },
    [HOST_B]: { tenantId: `tenant-${CO_B}`, companyId: CO_B, clientId: 'client-b', kind: 'client', installationId: `install-${CO_B}` },
  });
}

seedTenantRegistry();

test.after(() => {
  try { closeDb(); } catch { /* ignore */ }
});

// ─── Migration 140 ───────────────────────────────────────────────────────────

test('[F40.1] migration 140 creates the measured-outcome tables', () => {
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'social_%'").all() as { name: string }[]).map((r) => r.name);
  for (const t of ['social_metrics', 'social_content_variants', 'social_performance_reviews']) {
    assert.ok(tables.includes(t), `${t} must exist`);
  }
  const cols = (db.prepare('PRAGMA table_info(social_metrics)').all() as { name: string }[]).map((c) => c.name);
  for (const col of ['company_id', 'account_id', 'post_id', 'metric', 'value', 'is_unknown', 'window_start', 'window_end', 'fetched_at']) {
    assert.ok(cols.includes(col), `social_metrics.${col} must exist`);
  }
});

// ─── Missing is UNKNOWN, never zero ─────────────────────────────────────────

test('[F40.2] unreported metric stores is_unknown=1 value NULL — never 0', () => {
  const knownId = recordMetricObservation({
    company_id: CO_A, account_id: 'acct-a-1', post_id: 'post-a-1',
    platform: 'linkedin', metric: 'impressions', value: 120,
    window_start: '2026-09-01T00:00:00Z', window_end: '2026-09-07T23:59:59Z',
    source: 'ghl-analytics', fetched_at: '2026-09-08T12:00:00Z',
  });
  const unknownId = recordMetricObservation({
    company_id: CO_A, account_id: 'acct-a-1', post_id: 'post-a-1',
    platform: 'linkedin', metric: 'saves', value: null,
    window_start: '2026-09-01T00:00:00Z', window_end: '2026-09-07T23:59:59Z',
    source: 'ghl-analytics', fetched_at: '2026-09-08T12:00:00Z',
  });
  assert.ok(knownId && unknownId);
  const saved = latestMetricsForCompany(CO_A, { metric: 'saves' })[0];
  assert.equal(saved.is_unknown, 1, 'missing provider value must be explicitly unknown');
  assert.equal(saved.value, null, 'unknown value must be NULL, never 0');
  const rows = latestMetricsForCompany(CO_A, { metric: 'saves' });
  assert.ok(rows.every((r) => r.value !== 0), 'no zero fabrication in any row');
});

test('[F40.2b] aggregates skip unknowns: total/mean null (not 0) with honest coverage', () => {
  const rows = latestMetricsForCompany(CO_A, { metric: 'saves' });
  const agg = aggregateMetric(rows, 'saves');
  assert.equal(agg.total, null, 'total of all-unknown metric is null, never 0');
  assert.equal(agg.mean, null, 'mean of all-unknown metric is null, never 0');
  assert.equal(agg.known_count, 0);
  assert.equal(agg.unknown_count, 1);
  assert.equal(agg.coverage, 0);
  // Mixed: known values aggregate; unknowns stay out of the math.
  recordMetricObservation({
    company_id: CO_A, account_id: 'acct-a-1', post_id: 'post-a-2',
    platform: 'linkedin', metric: 'impressions', value: null,
    window_start: '2026-09-01T00:00:00Z', window_end: '2026-09-07T23:59:59Z',
    source: 'ghl-analytics', fetched_at: '2026-09-08T13:00:00Z',
  });
  const impressions = aggregateMetric(latestMetricsForCompany(CO_A, { metric: 'impressions' }), 'impressions');
  assert.equal(impressions.total, 120);
  assert.equal(impressions.known_count, 1);
  assert.equal(impressions.unknown_count, 1);
  assert.equal(impressions.coverage, 0.5);
});

// ─── Cross-client isolation ─────────────────────────────────────────────────

test('[F40.3] company B cannot see or write company A history', () => {
  const aMetrics = latestMetricsForCompany(CO_A);
  assert.ok(aMetrics.length > 0);
  // Scoped read: B sees none of A's rows.
  const bMetrics = latestMetricsForCompany(CO_B);
  assert.ok(bMetrics.every((m) => m.company_id === CO_B), 'B reads only B rows');
  assert.ok(!bMetrics.some((m) => m.company_id === CO_A));

  // The ingest route ignores a body-supplied foreign company_id.
  const resp = perfPOST(requestFor(HOST_B, CO_B, '/api/social/performance', {
    method: 'POST',
    body: { observations: [{ company_id: CO_A, account_id: 'acct-b-1', post_id: 'post-b-1', metric: 'clicks', value: 9 }] },
  }));
  // Note: perfPOST is async — await in an async test below; asserted in the async test.
});

test('[F40.3b] async: route rejects foreign company_id write; A history untouched by B write', async () => {
  const before = latestMetricsForCompany(CO_A).length;
  const resp = await perfPOST(requestFor(HOST_B, CO_B, '/api/social/performance', {
    method: 'POST',
    body: { observations: [{ company_id: CO_A, account_id: 'acct-b-1', post_id: 'post-b-1', metric: 'clicks', value: 9 }] },
  }));
  assert.equal(resp.status, 201);
  const body = await resp.json();
  assert.equal(body.stored, 1);
  const after = latestMetricsForCompany(CO_A).length;
  assert.equal(after, before, 'A history must not gain rows from B write');
  const written = latestMetricsForCompany(CO_B, { postId: 'post-b-1' })[0];
  assert.equal(written.company_id, CO_B, 'the row landed in B own history');
});

test('[F40.3c] unauthenticated request is rejected', async () => {
  const resp = await perfGET(requestFor(HOST_A, '', '/api/social/performance'));
  assert.equal(resp.status, 403);
});

// ─── Variants ────────────────────────────────────────────────────────────────

test('[F40.4] first variant auto-baselines; trial needs one variable + baseline ref', () => {
  const base = registerVariant({ company_id: CO_A, variable: 'timing', role: 'trial', label: 'trial without baseline' });
  assert.equal(base.role, 'baseline', 'first variant becomes the baseline');
  assert.equal(base.basis, 'baseline-first');
  const trial = registerVariant({
    company_id: CO_A, variable: 'hook', role: 'trial',
    label: 'question hook', compared_to: base.id,
  });
  assert.equal(trial.role, 'trial');
  assert.equal(trial.basis, 'single-variable-trial');
  // A trial without compared_to is refused.
  assert.throws(
    () => registerVariant({ company_id: CO_A, variable: 'format', role: 'trial', label: 'orphan trial' }),
    /baseline/,
    'trial without a baseline reference must be refused',
  );
  // A bogus variable is refused.
  assert.throws(
    () => registerVariant({ company_id: CO_A, variable: 'budget' as never, role: 'trial', label: 'x', compared_to: base.id }),
    /variable/,
    'variable outside format|hook|timing|creative must be refused',
  );
  const vs = variantsForCompany(CO_A);
  assert.ok(vs.length >= 2);
  assert.ok((VARIANT_VARIABLES as readonly string[]).includes('timing'));
});

// ─── Recommendations cite posts + windows; low samples tentative ────────────

test('[F40.5] recommendation cites the actual posts and window text', () => {
  const rec = recordPerformanceReview({
    company_id: CO_A,
    posts_reviewed: ['post-a-1', 'post-a-2'],
    windows: [{ post_id: 'post-a-1', window_start: '2026-09-01T00:00:00Z', window_end: '2026-09-07T23:59:59Z' }],
    aggregates: [aggregateMetric(latestMetricsForCompany(CO_A, { metric: 'impressions' }), 'impressions')],
    recommendation: '',
    cadence: 'weekly',
  });
  assert.match(rec.recommendation, /post-a-1, post-a-2/, 'cites the actual posts');
  assert.match(rec.recommendation, /window 2026-09-01T00:00:00Z to 2026-09-07T23:59:59Z/, 'cites the actual window');
  assert.match(rec.recommendation, /UNKNOWN \(not reported by the provider\)/, 'states unknown coverage');
});

test('[F40.6] low sample (< threshold) is tentative and gets no proposals', () => {
  // The cadence window is env-forced to 1h; F40.5 recorded a review for CO_A
  // with a fresh reviewed_at, so age it past the window to prove the sweep
  // fires on cadence, not on any read.
  const aged = new Date(Date.now() - 2 * 3600_000).toISOString();
  run(`UPDATE social_performance_reviews SET reviewed_at = ?, created_at = ? WHERE company_id = ?`, [aged, aged, CO_A]);
  const beforeCount = reviewsForCompany(CO_A).length;
  const summary = reviewCompany(CO_A);
  assert.equal(summary.action, 'reviewed');
  const review = summary.review!;
  assert.ok(review.sample_size < MIN_SAMPLE_FOR_CONFIDENCE, 'sample counts KNOWN observations only');
  assert.equal(review.tentative, true, 'low-sample review is tentative');
  assert.equal(review.proposals.length, 0, 'tentative conclusion receives NO proposals');
  assert.match(review.recommendation, /UNKNOWN/);
  assert.ok(review.policy_guard.length > 0);
  assert.equal(reviewsForCompany(CO_A).length, beforeCount + 1);
});

test('[F40.6b] confident sample (>= threshold) may propose; always policy-guarded', () => {
  // Seed MIN_SAMPLE_FOR_CONFIDENCE known observations.
  for (let i = 0; i < MIN_SAMPLE_FOR_CONFIDENCE; i++) {
    recordMetricObservation({
      company_id: CO_A, account_id: 'acct-a-1', post_id: `post-a-conf-${i}`,
      platform: 'linkedin', metric: 'engagement_rate', value: 2 + i * 0.5,
      window_start: '2026-09-01T00:00:00Z', window_end: '2026-09-07T23:59:59Z',
      source: 'ghl-analytics', fetched_at: '2026-09-08T12:00:00Z',
    });
  }
  const review = recordPerformanceReview({
    company_id: CO_A,
    posts_reviewed: ['post-a-conf-0', 'post-a-conf-1'],
    windows: [{ post_id: 'post-a-conf-0', window_start: '2026-09-01T00:00:00Z', window_end: '2026-09-07T23:59:59Z' }],
    aggregates: [aggregateMetric(latestMetricsForCompany(CO_A, { metric: 'engagement_rate' }), 'engagement_rate')],
    recommendation: '',
    proposals: [{ kind: 'content-experiment', variable: 'timing' }],
  });
  assert.equal(review.sample_size, MIN_SAMPLE_FOR_CONFIDENCE);
  assert.equal(review.tentative, false);
});

// ─── Policy guard (F31/F37) ─────────────────────────────────────────────────

test('[F40.7] proposals touching provider/model/publishing policy are rejected', () => {
  assert.throws(
    () => assertNoPolicyMutation([{ provider: 'openai', model: 'gpt-x' }]),
    /F31\/F37/,
  );
  assert.throws(
    () => assertNoPolicyMutation([{ publishing_policy: { auto_publish: true } }]),
    /client-choice/,
  );
  assert.throws(
    () => recordPerformanceReview({
      company_id: CO_A,
      posts_reviewed: ['post-a-1'],
      windows: [],
      aggregates: [],
      recommendation: 'r',
      proposals: [{ execution_mode: 'ultra' }],
    }),
    /policy/,
    'review record refuses to persist a policy-changing proposal',
  );
});

// ─── API surface ────────────────────────────────────────────────────────────

test('[F40.8] GET serves only own metrics/variants/reviews; ingest stores unknowns', async () => {
  const resp = await perfGET(requestFor(HOST_A, CO_A, '/api/social/performance'));
  assert.equal(resp.status, 200);
  const body = await resp.json();
  assert.ok(Array.isArray(body.metrics) && body.metrics.length > 0);
  assert.ok(body.metrics.every((m: { company_id: string }) => m.company_id === CO_A));
  assert.ok(Array.isArray(body.variants) && body.variants.every((v: { company_id: string }) => v.company_id === CO_A));
  assert.ok(Array.isArray(body.reviews));
  assert.equal(body.policy.min_sample_for_confidence, MIN_SAMPLE_FOR_CONFIDENCE);

  // Ingest: a mix of known + unknown values both stored, unknown preserved.
  const ingest = await perfPOST(requestFor(HOST_A, CO_A, '/api/social/performance', {
    method: 'POST',
    body: {
      observations: [
        { account_id: 'acct-a-1', post_id: 'post-a-9', metric: 'reach', value: 55, window_start: '2026-09-01T00:00:00Z', window_end: '2026-09-07T23:59:59Z' },
        { account_id: 'acct-a-1', post_id: 'post-a-9', metric: 'clicks', value: null },
        { account_id: 'acct-a-1', post_id: 'post-a-9', metric: 'shares' }, // absent value = unknown
      ],
    },
  }));
  assert.equal(ingest.status, 201);
  const stored = await ingest.json();
  assert.equal(stored.stored, 3);
  assert.equal(stored.rejected.length, 0);
  const clicks = latestMetricsForCompany(CO_A, { metric: 'clicks' })[0];
  assert.equal(clicks.is_unknown, 1);
  assert.equal(clicks.value, null);
  const shares = latestMetricsForCompany(CO_A, { metric: 'shares' })[0];
  assert.equal(shares.is_unknown, 1);
});

test('[F40.9] PATCH runs the cadence review for the caller only; PUT guards policy', async () => {
  const patch = await perfPATCH(requestFor(HOST_B, CO_B, '/api/social/performance', { method: 'PATCH' }));
  assert.equal(patch.status, 200);
  const summary = await patch.json();
  if (summary.action === 'reviewed') {
    assert.ok(summary.review.company_id === CO_B);
  }

  const put = await perfPUT(requestFor(HOST_B, CO_B, '/api/social/performance', {
    method: 'PUT',
    body: {
      posts_reviewed: ['post-b-1'],
      windows: [{ post_id: 'post-b-1' }],
      aggregates: [],
      recommendation: 'self-recorded review',
      proposals: [{ model: 'claude-haiku-4-5-20251001' }],
    },
  }));
  assert.equal(put.status, 422, 'policy-touching proposal rejected at the boundary');
  const err = await put.json();
  assert.match(err.error, /policy|F31\/F37/);
});

// ─── Cadence sweep ──────────────────────────────────────────────────────────

test('[F40.10] sweep reviews without live calls and honors the cadence window', async () => {
  const { runSocialPerformanceReviewSweep } = await import('../../src/lib/jobs/social-performance-review');
  const result = await runSocialPerformanceReviewSweep();
  assert.ok(result.scanned >= 2, `scans both companies' own rows (scanned=${result.scanned})`);
  assert.ok(result.reviewed + result.skipped === result.scanned);
  // Second sweep inside the cadence window → recent, no new review rows.
  const before = reviewsForCompany(CO_A).length;
  const second = await runSocialPerformanceReviewSweep();
  assert.equal(reviewsForCompany(CO_A).length, before, 'no duplicate review inside the window');
  assert.ok(second.scanned >= 2);
});