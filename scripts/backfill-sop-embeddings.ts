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
 * Google-only clients (Sheila, Corey, Kofi) need NO OPENAI_API_KEY.
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
 * DEPLOY NOTE
 *   Run this once per client at Wave-5 deploy (operator-gated, with the client's
 *   own key). For gemini-embedding-001 → gemini-embedding-2 migration:
 *     SOP_EMBEDDING_PROVIDER=google GOOGLE_API_KEY=<client-key> tsx scripts/backfill-sop-embeddings.ts
 *   This re-embeds every stale gemini-embedding-001 row with gemini-embedding-2.
 *   Typical Google 2,578-row run: ~30–45 minutes (sequential + quota pacing).
 *   Google free-tier limit: ~1,500 embeds/min in normal conditions; slowdown expected.
 *   Typical OpenAI 2,578-row run:  ~3 minutes (batch 10, 1s pause)  ~$0.003 total.
 */

import process from 'node:process';
import type { SOP } from '../src/lib/sops';

// ----- arg parsing -----
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const forceReEmbed = args.includes('--force');
const checkStale = args.includes('--check-stale');
const batchSizeArg = args.find((a) => a.startsWith('--batch-size='));

async function main(): Promise<void> {
  // ----- db + embedding imports (dynamic so DATABASE_PATH is set first) -----
  const db = await import('../src/lib/db');
  const { queryAll, queryOne, run } = db;

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
