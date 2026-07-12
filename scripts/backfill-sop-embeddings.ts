#!/usr/bin/env tsx
/**
 * scripts/backfill-sop-embeddings.ts
 *
 * One-time (resumable) backfill: embed every SOP in the DB that does not yet
 * have an embedding in the sop_embeddings table, OR that was embedded with a
 * stale / retired model.
 *
 * PRD 1.8c — Google model migration: gemini-embedding-001 HARD SHUTDOWN 2026-07-14.
 * This script migrates all stored SOP vectors to gemini-embedding-2 @3072-dim.
 * Running with a Google key automatically detects stale gemini-embedding-001 rows
 * and re-embeds them with gemini-embedding-2. The --check-stale flag prints a
 * count of stale rows without running the embed.
 *
 * PROVIDER SELECTION (auto-detected, same logic as sop-embeddings.ts):
 *   OpenAI (text-embedding-3-small, 1536-dim)  — requires OPENAI_API_KEY
 *   Google (gemini-embedding-2, 3072-dim)       — requires GOOGLE_API_KEY /
 *                                                  GOOGLE_AI_STUDIO_API_KEY /
 *                                                  GEMINI_API_KEY
 *   SOP_EMBEDDING_PROVIDER=openai|google        — force a specific provider
 *
 * Google-only clients need NO OPENAI_API_KEY.
 * Set any Google key and the script uses gemini-embedding-2 automatically.
 *
 * QUOTA / PACING (Google free tier):
 *   Google embedContent is one-call-per-text. The script defaults to batch-size=5
 *   (instead of 10 for OpenAI) with a 1s inter-batch delay AND an inter-call delay
 *   inside each batch (250ms, configurable via GOOGLE_EMBED_DELAY_MS env override).
 *   On a sustained 429, the script stops gracefully, reports how many were embedded,
 *   and tells the operator to re-run later — resumable because already-embedded
 *   rows are skipped.
 *
 * USAGE
 *   chmod +x scripts/backfill-sop-embeddings.ts
 *   tsx scripts/backfill-sop-embeddings.ts [--dry-run] [--batch-size=N] [--force]
 *   tsx scripts/backfill-sop-embeddings.ts --check-stale   # count stale rows, exit
 *
 *   Or via env override:
 *   DATABASE_PATH=/abs/path/to/db tsx scripts/backfill-sop-embeddings.ts
 *   SOP_EMBEDDING_PROVIDER=google GOOGLE_API_KEY=AIza... tsx scripts/backfill-sop-embeddings.ts
 *
 * ENV REQUIREMENTS
 *   OPENAI_API_KEY  OR  GOOGLE_API_KEY / GOOGLE_AI_STUDIO_API_KEY / GEMINI_API_KEY
 *   At least one must be set; script exits early with a clear message if both absent.
 *   DATABASE_PATH    — optional; defaults to ./mission-control.db (same as the app).
 *
 * OPTIONS
 *   --dry-run          Print which SOPs would be embedded without calling the API.
 *   --batch-size=N     SOPs per API-call batch (default: 10 for OpenAI, 5 for Google).
 *                      For Google, this controls how many per outer loop iteration;
 *                      the actual API is still 1 call per text.
 *   --force            Re-embed SOPs that already have an embedding (full refresh).
 *   --check-stale      Print count of stale gemini-embedding-001 rows + exit. No embeds.
 *
 * RESUMABILITY
 *   The script skips SOPs that already have a row in sop_embeddings with the SAME
 *   provider model (unless --force). Rows from a different or retired model are
 *   treated as unembedded for the active provider. Re-running after a partial failure
 *   or interruption will only embed the remaining rows.
 *
 * DEPLOY NOTE (P4-03 — DELTA-ONLY, not a per-client full re-embed)
 *   The shared SOP library (~2,578 rows, identical content across clients) is
 *   now embedded ONCE by the operator and shipped to every client box via
 *   shared-utils/sop-embed-once/ (onboarding repo) +
 *   32-command-center-setup/scripts/ingest-sop-library.sh, which calls
 *   provision_sop_embeddings.py automatically at install AND every Sunday
 *   update — ZERO client-key embed calls for that content. This script's job
 *   is now GENUINELY DELTA-ONLY: it only ever touches rows NOT already
 *   covered by the shipped asset (client-specific SOPs from `sop_proposals`,
 *   or a genuine model migration). It already skips any sop_id with an
 *   up-to-date row for the active model (see "discover work" below), so a
 *   normal (non---force) run against a box that already has the shipped
 *   asset imported does ZERO API calls for the shared library by construction.
 *   `--force` (full re-embed of EVERY sop, including shipped-covered rows) is
 *   REFUSED when the `sop_embeddings_shipped_asset` marker table is present
 *   (written by provision_sop_embeddings.py) — mirrors
 *   embedding_engine.py::_refuse_full_rebuild_if_prebuilt in the onboarding
 *   repo. Use --force-full-rebuild-shipped (operator-only; never surface to a
 *   client) for a genuine embedding-model migration that must re-embed
 *   shipped rows too — that is an operator decision, not a per-client default.
 *
 *   For gemini-embedding-001 → gemini-embedding-2 migration on CLIENT-DELTA
 *   rows only:
 *     SOP_EMBEDDING_PROVIDER=google GOOGLE_API_KEY=<client-key> tsx scripts/backfill-sop-embeddings.ts
 *   Typical Google run (delta only, N rows): sequential + quota pacing, ~N/2
 *   seconds. Google free-tier limit: ~1,500 embeds/min in normal conditions.
 *   Typical OpenAI run: batch 10, 1s pause, ~$0.003 total for a small delta.
 */

import process from 'node:process';
import type { SOP } from '../src/lib/sops';

// ----- arg parsing -----
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const forceReEmbed = args.includes('--force');
const forceFullRebuildShipped = args.includes('--force-full-rebuild-shipped');
const checkStale = args.includes('--check-stale');
const batchSizeArg = args.find((a) => a.startsWith('--batch-size='));

/**
 * P4-03 step 3 — mirrors embedding_engine.py::_refuse_full_rebuild_if_prebuilt
 * in the onboarding repo. Refuses a `--force` full re-embed (which would
 * re-embed EVERY sop, including the shared-library rows the operator already
 * shipped with zero client-key spend) when the `sop_embeddings_shipped_asset`
 * marker table is present — written by
 * shared-utils/sop-embed-once/provision_sop_embeddings.py on import.
 * `--force-full-rebuild-shipped` is the operator-only override for a genuine
 * embedding-model migration; never surface it in any client-facing doc/reflex.
 */
function refuseFullRebuildIfShipped(
  queryOne: (sql: string, params: unknown[]) => unknown,
): void {
  if (forceFullRebuildShipped) return;
  let marker: { release_tag: string; sop_count: number } | undefined;
  try {
    marker = queryOne(
      'SELECT release_tag, sop_count FROM sop_embeddings_shipped_asset WHERE id = 1',
      []
    ) as { release_tag: string; sop_count: number } | undefined;
  } catch {
    // Table absent (no shipped asset ever imported on this box) — nothing to refuse.
    return;
  }
  if (!marker) return;
  console.error(
    '[backfill-sop-embeddings] REFUSED: --force requested but this box carries the ' +
      `operator-shipped SOP-embeddings asset (release=${marker.release_tag}, ` +
      `${marker.sop_count} rows, zero client-key embed calls). A full re-embed would ` +
      'discard it and re-pay the full per-client embed cost this pipeline exists to avoid. ' +
      'A normal (non---force) run already embeds ONLY genuinely uncovered rows. If you are ' +
      'an OPERATOR performing a real embedding-model migration, pass ' +
      '--force-full-rebuild-shipped alongside --force to override (operator-only — never ' +
      'surface this to a client).'
  );
  process.exit(3);
}

async function main(): Promise<void> {
  // ----- db + embedding imports (dynamic so DATABASE_PATH is set first) -----
  const db = await import('../src/lib/db');
  const { queryAll, queryOne, run } = db;

  if (forceReEmbed) {
    refuseFullRebuildIfShipped(queryOne as (sql: string, params: unknown[]) => unknown);
  }

  const emb = await import('../src/lib/sop-embeddings');
  const {
    resolveEmbeddingProvider,
    buildSOPEmbedText,
    fetchEmbedding,
    float32ToBuffer,
    countStaleGoogleEmbeddings,
    PINNED_GOOGLE_MODEL,
  } = emb;

  // ----- --check-stale: report stale gemini-embedding-001 rows and exit -----
  if (checkStale) {
    const { stale, total, pinnedModel, retiredModel } = countStaleGoogleEmbeddings();
    console.log('[backfill-sop-embeddings] --check-stale report:');
    console.log(`  Total SOP embeddings in DB : ${total}`);
    console.log(`  Stale rows (${retiredModel}): ${stale}`);
    console.log(`  Pinned model (target)      : ${pinnedModel}`);
    if (stale > 0) {
      console.log('');
      console.log(`  ⚠️  ACTION REQUIRED: ${stale} row(s) must be re-embedded with ${pinnedModel}`);
      console.log(`  Run: SOP_EMBEDDING_PROVIDER=google GOOGLE_API_KEY=<key> tsx scripts/backfill-sop-embeddings.ts`);
      process.exit(1); // non-zero so CI / health checks can detect this state
    } else {
      console.log('  ✓ No stale embeddings detected. All rows use the pinned model.');
      process.exit(0);
    }
  }

  // ----- resolve provider -----
  const provider = resolveEmbeddingProvider();

  if (provider.name === 'none' || !provider.apiKey) {
    console.error('[backfill-sop-embeddings] ERROR: No embedding provider is configured.');
    console.error('  Set one of the following in your shell or .env.local:');
    console.error('    OPENAI_API_KEY             → uses OpenAI text-embedding-3-small (1536-dim)');
    console.error(`    GOOGLE_API_KEY             → uses Google ${PINNED_GOOGLE_MODEL} (3072-dim)`);
    console.error('    GOOGLE_AI_STUDIO_API_KEY   → same, alternate key name');
    console.error('    GEMINI_API_KEY             → same, alternate key name');
    console.error('  Or force a specific provider: SOP_EMBEDDING_PROVIDER=openai|google');
    process.exit(1);
  }

  // ----- model-drift report: warn loudly if there are stale Google rows -----
  if (provider.name === 'google') {
    const { stale, retiredModel } = countStaleGoogleEmbeddings();
    if (stale > 0) {
      console.log(
        `[backfill-sop-embeddings] ⚠️  MODEL-DRIFT: ${stale} row(s) stored as "${retiredModel}" ` +
        `(hard shutdown 2026-07-14) will be re-embedded with "${provider.model}".`
      );
    }
  }

  const isGoogle = provider.name === 'google';
  const DEFAULT_BATCH_SIZE = isGoogle ? 5 : 10;
  const BATCH_SIZE = batchSizeArg ? parseInt(batchSizeArg.split('=')[1], 10) : DEFAULT_BATCH_SIZE;
  const BATCH_DELAY_MS = isGoogle ? 2000 : 1000; // longer pause between batches for Google

  console.log(`[backfill-sop-embeddings] Provider: ${provider.name} (${provider.model}, ${provider.dims}-dim)`);
  if (isGoogle) {
    console.log(
      `[backfill-sop-embeddings] NOTE: using pinned model ${PINNED_GOOGLE_MODEL} (output_dimensionality=3072). ` +
      'Google free-tier pacing active — sequential calls with delays. ' +
      'A full 2,578-SOP run may take 30–45 min. The script is resumable; ^C and re-run anytime.'
    );
  }

  // ----- purge non-active-model rows -----
  // Delete any sop_embeddings rows that are NOT for the current active model
  // (e.g. text-embedding-3-small @ 1536-dim and gemini-embedding-001 rows).
  // This ensures only one canonical embedding per SOP exists after the run.
  const staleRows = queryAll<{ embedding_model: string; cnt: number }>(
    'SELECT embedding_model, COUNT(*) AS cnt FROM sop_embeddings WHERE embedding_model != ? GROUP BY embedding_model',
    [provider.model]
  );
  if (staleRows.length > 0) {
    const totalStale = staleRows.reduce((s, r) => s + r.cnt, 0);
    console.log(`[backfill-sop-embeddings] PURGE: deleting ${totalStale} non-active-model rows:`);
    for (const r of staleRows) {
      console.log(`  - ${r.embedding_model}: ${r.cnt} row(s)`);
    }
    run('DELETE FROM sop_embeddings WHERE embedding_model != ?', [provider.model]);
    console.log('[backfill-sop-embeddings] Purge complete. Only active-model rows remain.');
  } else {
    console.log('[backfill-sop-embeddings] Purge: no non-active-model rows found (already clean).');
  }

  // ----- discover work -----
  const allSOPs = queryAll<SOP>('SELECT * FROM sops WHERE deleted_at IS NULL', []);

  let toEmbed: SOP[];
  if (forceReEmbed) {
    toEmbed = allSOPs;
  } else {
    // Skip SOPs that already have a row in sop_embeddings for the ACTIVE provider model.
    // SOPs embedded with a different provider/model are treated as unembed for this run.
    toEmbed = allSOPs.filter((sop) => {
      const existing = queryOne<{ sop_id: string; embedding_model: string }>(
        'SELECT sop_id, embedding_model FROM sop_embeddings WHERE sop_id = ?',
        [sop.id]
      );
      // Skip only if already embedded with the SAME model
      return !existing || existing.embedding_model !== provider.model;
    });
  }

  console.log(`[backfill-sop-embeddings] Total SOPs in DB (non-deleted): ${allSOPs.length}`);
  console.log(
    `[backfill-sop-embeddings] SOPs to embed: ${toEmbed.length}` +
    `${forceReEmbed ? ' (force mode)' : ` (skipping already-embedded with model=${provider.model})`}`
  );

  if (dryRun) {
    console.log('[backfill-sop-embeddings] DRY RUN — no API calls will be made.');
    for (const sop of toEmbed) {
      const text = buildSOPEmbedText(sop);
      console.log(`  [dry] ${sop.id} | ${sop.name} | ~${text.length} chars`);
    }
    process.exit(0);
  }

  if (toEmbed.length === 0) {
    console.log('[backfill-sop-embeddings] Nothing to do — all SOPs already have embeddings for this provider.');
    process.exit(0);
  }

  // ----- batch embed -----
  let embedded = 0;
  let failed = 0;
  let quotaHit = false;

  for (let i = 0; i < toEmbed.length; i += BATCH_SIZE) {
    const batch = toEmbed.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(toEmbed.length / BATCH_SIZE);
    console.log(`[backfill-sop-embeddings] Batch ${batchNum}/${totalBatches} (${batch.length} SOPs)...`);

    for (const sop of batch) {
      try {
        const text = buildSOPEmbedText(sop);
        const embedding = await fetchEmbedding(text);
        const blob = float32ToBuffer(embedding);
        const now = new Date().toISOString();

        run(
          `INSERT INTO sop_embeddings (sop_id, embedding, embedding_model, embedding_dims, embedded_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(sop_id) DO UPDATE SET
             embedding = excluded.embedding,
             embedding_model = excluded.embedding_model,
             embedding_dims = excluded.embedding_dims,
             embedded_at = excluded.embedded_at`,
          [sop.id, blob, provider.model, provider.dims, now]
        );
        embedded++;
        process.stdout.write(`  ✓ ${sop.name}\n`);
      } catch (err) {
        const msg = (err as Error).message;
        // Detect quota exhaustion (Google 429) — stop gracefully
        if (msg.toLowerCase().includes('quota exceeded') || msg.includes('429')) {
          quotaHit = true;
          console.error(`\n[backfill-sop-embeddings] QUOTA LIMIT HIT (${provider.name} 429): ${msg}`);
          console.error(`  Embedded so far: ${embedded}/${toEmbed.length}`);
          console.error(`  The script is RESUMABLE — re-run later and it will skip already-embedded rows.`);
          break;
        }
        failed++;
        console.error(`  ✗ ${sop.name} (${sop.id}): ${msg}`);
      }
    }

    if (quotaHit) break;

    // Pause between batches (skip final pause)
    if (i + BATCH_SIZE < toEmbed.length) {
      await new Promise((resolve) => setTimeout(resolve, BATCH_DELAY_MS));
    }
  }

  console.log('');
  console.log(
    `[backfill-sop-embeddings] Done. Embedded: ${embedded}, Failed: ${failed}, ` +
    `Total: ${toEmbed.length}${quotaHit ? ' (stopped early — quota limit)' : ''}`
  );

  if (quotaHit) {
    console.log('[backfill-sop-embeddings] Re-run when quota resets to embed remaining SOPs.');
    process.exit(1);
  }
  if (failed > 0) {
    console.log('[backfill-sop-embeddings] Re-run to retry failed rows (already-embedded rows are skipped).');
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error('[backfill-sop-embeddings] Fatal error:', err);
  process.exit(1);
});
