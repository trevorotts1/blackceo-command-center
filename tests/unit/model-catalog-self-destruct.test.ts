/**
 * model-catalog-self-destruct.test.ts — MODEL-07.
 *
 * THE BUG THIS LOCKS DOWN
 * -----------------------
 * `deprecateMissingModels()` compared `last_seen_at < ?` as raw TEXT:
 *   • the column was written by SQLite `datetime('now')` → '2026-07-11 16:02:42'
 *     (SPACE separator)
 *   • the bound cutoff came from JS `.toISOString()` → '2026-07-11T16:02:41.637Z'
 *     ('T' separator)
 * Both land on the SAME DATE (the cutoff IS the run's own start), so the
 * separator alone decided the compare — and ' ' (0x20) sorts BELOW 'T' (0x54).
 * Every model the refresh had JUST stamped therefore matched
 * `last_seen_at < cutoff` and instantly re-deprecated ITSELF.
 *
 * Live blast radius: a refresh on the operator's box took a 20-model active
 * catalog to ZERO. The code shipped in the shared repo, so every box in the
 * fleet had a catalog that self-destructs the moment anything runs a refresh.
 * A zeroed catalog means no model can be resolved for ANY task — which is how a
 * task that required a (non-existent) vision model died silently.
 *
 * There was NO test over refreshOneProvider() at all. This is that test.
 *
 * PROVES:
 *   1. THE HEADLINE — a model that IS in the provider's catalog is STILL ACTIVE
 *      after a refresh. Asserts the active count before AND after. This test
 *      FAILS against the pre-fix code (count goes N → 0).
 *   2. A pre-existing SPACE-dialect row (what every real box actually has on
 *      disk today) survives a refresh — the fix must handle legacy rows, not
 *      just newly-written canonical ones.
 *   3. NO OVER-CORRECTION — a model that genuinely VANISHED from the provider
 *      catalog is still correctly deprecated. The fix must not neuter the
 *      tombstoning feature to make the headline test pass.
 *   4. Repeated refreshes are stable (the catalog does not erode run over run).
 *
 * Run: node --import tsx --test tests/unit/model-catalog-self-destruct.test.ts
 */

import './_isolated-db'; // MUST be first.
import test from 'node:test';
import assert from 'node:assert/strict';
import { getDb, queryOne } from '../../src/lib/db';
import { refreshOneProvider } from '../../src/lib/jobs/refresh-models';
import type { ModelProvider, ProviderModel } from '../../src/lib/model-providers/types';

const db = getDb();

const PROVIDER_SLUG = 'test-selfdestruct';

/** A model as the provider's catalog reports it. */
function providerModel(id: string): ProviderModel {
  return {
    model_id: id,
    label: id,
    provider: PROVIDER_SLUG,
    context_window: 128_000,
    capabilities: ['text', 'reasoning'],
    status: 'active',
  };
}

/**
 * A stub connector. `authType: 'local_endpoint'` makes the refresh job skip API
 * key detection entirely, so the test needs no credentials and touches no network.
 */
function stubProvider(models: ProviderModel[]): ModelProvider {
  return {
    slug: PROVIDER_SLUG,
    displayName: 'Self-Destruct Test Provider',
    authType: 'local_endpoint',
    fetchModels: async () => models,
  };
}

function activeCount(): number {
  return (
    queryOne<{ n: number }>(
      `SELECT COUNT(*) AS n FROM model_registry WHERE provider = ? AND status = 'active'`,
      [PROVIDER_SLUG],
    )?.n ?? 0
  );
}

function statusOf(modelId: string): string | null {
  return (
    queryOne<{ status: string }>(
      `SELECT status FROM model_registry WHERE model_id = ?`,
      [modelId],
    )?.status ?? null
  );
}

function reset(): void {
  db.prepare(`DELETE FROM model_registry WHERE provider = ?`).run(PROVIDER_SLUG);
}

// ─── 1. THE HEADLINE: a refreshed model is STILL ACTIVE afterward ────────────
test('MODEL-07: models that were just refreshed are STILL ACTIVE (catalog does not self-destruct)', async () => {
  reset();
  const catalog = [
    providerModel(`${PROVIDER_SLUG}/model-a`),
    providerModel(`${PROVIDER_SLUG}/model-b`),
    providerModel(`${PROVIDER_SLUG}/model-c`),
  ];

  // First pass populates the registry.
  const first = await refreshOneProvider(stubProvider(catalog));
  assert.equal(first.success, true, 'refresh must succeed');
  assert.equal(first.models_added, 3, 'three models added on the first pass');

  const before = activeCount();
  assert.equal(before, 3, 'three ACTIVE models after the seeding refresh');

  // Second pass: the provider still reports all three. NOTHING may deprecate.
  const second = await refreshOneProvider(stubProvider(catalog));
  assert.equal(second.success, true);

  const after = activeCount();

  // The bug's exact signature: N → 0.
  assert.notEqual(after, 0, 'CATALOG SELF-DESTRUCT: every refreshed model deprecated itself');
  assert.equal(
    second.models_deprecated,
    0,
    'a model still present in the provider catalog must NEVER be deprecated by its own refresh',
  );
  assert.equal(after, before, `active count must be stable across a refresh (before=${before} after=${after})`);
  for (const m of catalog) {
    assert.equal(statusOf(m.model_id), 'active', `${m.model_id} must remain active`);
  }
});

// ─── 2. Legacy SPACE-dialect rows (what real boxes have on disk) survive ─────
test('MODEL-07: a pre-existing SPACE-dialect last_seen_at row survives a refresh', async () => {
  reset();
  const id = `${PROVIDER_SLUG}/legacy-space-row`;

  // Exactly what `datetime('now')` wrote on every box before this fix: no 'T',
  // no 'Z'. This is the row shape that made the naive compare deprecate itself.
  db.prepare(
    `INSERT INTO model_registry (model_id, label, provider, capabilities, status, last_seen_at)
     VALUES (?, ?, ?, ?, 'active', datetime('now'))`,
  ).run(id, 'Legacy Space Row', PROVIDER_SLUG, JSON.stringify(['text']));

  assert.equal(statusOf(id), 'active', 'precondition: legacy row starts active');

  // The provider still reports it → it must stay active.
  const outcome = await refreshOneProvider(stubProvider([providerModel(id)]));
  assert.equal(outcome.success, true);

  assert.equal(
    statusOf(id),
    'active',
    'a legacy space-dialect row that is still in the catalog must NOT be deprecated',
  );
  assert.equal(outcome.models_deprecated, 0, 'no deprecations for a fully-present catalog');
});

// ─── 3. NO OVER-CORRECTION: a genuinely-missing model IS still deprecated ────
test('MODEL-07: a model that VANISHED from the provider catalog is still deprecated', async () => {
  reset();
  const kept = providerModel(`${PROVIDER_SLUG}/kept`);
  const dropped = providerModel(`${PROVIDER_SLUG}/dropped`);

  // Seed as the PREVIOUS refresh run would have left the registry.
  await refreshOneProvider(stubProvider([kept, dropped]));
  assert.equal(activeCount(), 2, 'both models active after the seeding refresh');

  // Age both rows by an hour so this reads like the REAL cadence: refreshes run
  // on a schedule (weekly), not twice inside the same millisecond. Without this
  // the two runs share a wall-clock instant and `last_seen_at < cutoff` is
  // legitimately false for BOTH rows — a test artifact, not product behaviour.
  const anHourAgo = new Date(Date.now() - 3_600_000).toISOString();
  db.prepare(`UPDATE model_registry SET last_seen_at = ? WHERE provider = ?`).run(
    anHourAgo,
    PROVIDER_SLUG,
  );

  // The provider's catalog no longer lists `dropped`.
  const outcome = await refreshOneProvider(stubProvider([kept]));
  assert.equal(outcome.success, true);

  assert.equal(
    statusOf(dropped.model_id),
    'deprecated',
    'tombstoning must still work — a vanished model gets deprecated',
  );
  // If the self-destruct bug is present, THIS is the assertion that catches it:
  // the buggy predicate deprecates the still-present model too.
  assert.equal(statusOf(kept.model_id), 'active', 'the still-present model stays active');
  assert.equal(outcome.models_deprecated, 1, 'exactly ONE model (the vanished one) was deprecated');
  assert.equal(activeCount(), 1);
});

// ─── 4. Stability across repeated refreshes (no slow erosion) ────────────────
test('MODEL-07: the catalog is stable across repeated refreshes', async () => {
  reset();
  const catalog = [providerModel(`${PROVIDER_SLUG}/stable-1`), providerModel(`${PROVIDER_SLUG}/stable-2`)];

  await refreshOneProvider(stubProvider(catalog));
  const baseline = activeCount();
  assert.equal(baseline, 2);

  for (let i = 0; i < 5; i++) {
    const outcome = await refreshOneProvider(stubProvider(catalog));
    assert.equal(
      outcome.models_deprecated,
      0,
      `refresh #${i + 2} deprecated ${outcome.models_deprecated} model(s) — the catalog is eroding`,
    );
    assert.equal(activeCount(), baseline, `active count drifted on refresh #${i + 2}`);
  }
});

// ─── 5. CIRCUIT BREAKER: a mass-deprecation is REFUSED, loudly ──────────────
// The self-destruct ran on a Sunday cron and silently deprecated ~557 models a
// week for a month. Nothing ever looked at the MAGNITUDE of what it was about to
// do. Even if another dialect/response bug appears, a wipe must never again be a
// silent no-op: refuse, keep the catalog, and record the refusal where it shows.
test('MODEL-07: a refresh that would wipe the catalog is REFUSED and recorded', async () => {
  reset();
  const catalog = Array.from({ length: 12 }, (_, i) => providerModel(`${PROVIDER_SLUG}/mass-${i}`));

  await refreshOneProvider(stubProvider(catalog));
  assert.equal(activeCount(), 12, 'twelve models active after seeding');

  // Age them so they are all deprecation-eligible on the next pass.
  const anHourAgo = new Date(Date.now() - 3_600_000).toISOString();
  db.prepare(`UPDATE model_registry SET last_seen_at = ? WHERE provider = ?`).run(
    anHourAgo,
    PROVIDER_SLUG,
  );

  // The provider now returns an EMPTY catalog (a failed/empty upstream response,
  // or any future bug that makes every row look unseen). The old code would have
  // deprecated all 12 without a word.
  const outcome = await refreshOneProvider(stubProvider([]));

  assert.equal(outcome.models_deprecated, 0, 'the mass-deprecation must be REFUSED, not performed');
  assert.equal(activeCount(), 12, 'the catalog must be INTACT — nothing was deprecated');
  assert.match(
    String(outcome.error_message ?? ''),
    /REFUSED mass-deprecation/,
    'the refusal must be recorded in the refresh outcome (surfaced in the refresh log), not swallowed',
  );
});

// ─── 6. The breaker does NOT block a small, ordinary retirement ──────────────
test('MODEL-07: an ordinary small retirement still proceeds (breaker is not a straitjacket)', async () => {
  reset();
  const catalog = Array.from({ length: 12 }, (_, i) => providerModel(`${PROVIDER_SLUG}/ord-${i}`));

  await refreshOneProvider(stubProvider(catalog));
  const anHourAgo = new Date(Date.now() - 3_600_000).toISOString();
  db.prepare(`UPDATE model_registry SET last_seen_at = ? WHERE provider = ?`).run(
    anHourAgo,
    PROVIDER_SLUG,
  );

  // The provider retires ONE model of twelve (8%) — well under the breaker.
  const outcome = await refreshOneProvider(stubProvider(catalog.slice(1)));

  assert.equal(outcome.models_deprecated, 1, 'a single genuine retirement is still tombstoned');
  assert.equal(outcome.error_message ?? null, null, 'no refusal for an ordinary retirement');
  assert.equal(activeCount(), 11);
});

// ─── 8. THE REMEDIATION PLAN: one refresh SELF-HEALS a wiped catalog ────────
// This is the property the entire fleet recovery depends on: the upsert sets a
// re-seen model back to `active`, so on a box whose catalog was zeroed by the
// self-destruct, ONE post-fix refresh restores it. No DB surgery, no manual
// re-entry, no restore-from-backup. If a future change breaks this, the fleet
// loses its recovery path — so it is pinned here explicitly.
test('MODEL-07: ONE refresh fully SELF-HEALS a catalog the bug had wiped', async () => {
  reset();
  const catalog = Array.from({ length: 8 }, (_, i) => providerModel(`${PROVIDER_SLUG}/heal-${i}`));

  // Seed, then simulate the damage the live bug did: every row deprecated.
  await refreshOneProvider(stubProvider(catalog));
  db.prepare(`UPDATE model_registry SET status = 'deprecated' WHERE provider = ?`).run(PROVIDER_SLUG);
  assert.equal(activeCount(), 0, 'precondition: the catalog is WIPED, exactly as on the damaged boxes');

  // One ordinary refresh. Nothing else.
  const outcome = await refreshOneProvider(stubProvider(catalog));
  assert.equal(outcome.success, true);

  assert.equal(
    activeCount(),
    8,
    'a single refresh must bring EVERY re-found model back to active — this is the fleet remediation plan',
  );
  for (const m of catalog) {
    assert.equal(statusOf(m.model_id), 'active', `${m.model_id} must be healed back to active`);
  }
  assert.equal(outcome.models_deprecated, 0, 'healing must not deprecate anything');
});

// ─── 7. GET /api/cron/refresh-models must NOT mutate ────────────────────────
// This route aliased GET → POST, so a plain browser visit ran a full destructive
// refresh. Reading a URL must never rewrite the model catalog.
test('MODEL-07: GET /api/cron/refresh-models does not mutate the catalog', async () => {
  reset();
  const catalog = [providerModel(`${PROVIDER_SLUG}/get-safe-1`), providerModel(`${PROVIDER_SLUG}/get-safe-2`)];
  await refreshOneProvider(stubProvider(catalog));

  const before = activeCount();
  const beforeRows = db
    .prepare(`SELECT model_id, status, last_seen_at FROM model_registry WHERE provider = ? ORDER BY model_id`)
    .all(PROVIDER_SLUG);

  const { GET } = await import('../../src/app/api/cron/refresh-models/route');
  const res = await GET();

  assert.equal(res.status, 405, 'a GET must be rejected, not silently run a destructive refresh');

  const afterRows = db
    .prepare(`SELECT model_id, status, last_seen_at FROM model_registry WHERE provider = ? ORDER BY model_id`)
    .all(PROVIDER_SLUG);
  assert.equal(activeCount(), before, 'active count unchanged by a GET');
  assert.deepEqual(afterRows, beforeRows, 'the registry must be byte-identical after a GET');
});
