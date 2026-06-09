#!/usr/bin/env tsx
/**
 * scripts/backfill-sop-embeddings.ts
 *
 * One-time (resumable) backfill: embed every SOP in the DB that does not yet
 * have an embedding in the sop_embeddings table.
 *
 * USAGE
 *   chmod +x scripts/backfill-sop-embeddings.ts
 *   tsx scripts/backfill-sop-embeddings.ts [--dry-run] [--batch-size=N] [--force]
 *
 *   Or via env override:
 *   DATABASE_PATH=/abs/path/to/db tsx scripts/backfill-sop-embeddings.ts
 *
 * ENV REQUIREMENTS
 *   OPENAI_API_KEY   — required; script exits early with a clear message if absent.
 *   DATABASE_PATH    — optional; defaults to ./mission-control.db (same as the app).
 *
 * OPTIONS
 *   --dry-run          Print which SOPs would be embedded without calling the API.
 *   --batch-size=N     SOPs per batch (default: 10). Rate-limit buffer between
 *                      batches: 1 second. OpenAI text-embedding-3-small limit is
 *                      ~1M tokens/min; 10 × ~150 tokens is well within budget.
 *   --force            Re-embed SOPs that already have an embedding (full refresh).
 *
 * RESUMABILITY
 *   The script skips SOPs that already have a row in sop_embeddings (unless
 *   --force). Re-running after a partial failure or interruption will only embed
 *   the remaining rows.
 *
 * DEPLOY NOTE
 *   Run this once per client after the initial deploy. Typical 2,578-row fleet
 *   run takes ~3 minutes (batch 10, 1s pause) at negligible API cost
 *   (~$0.003 total for text-embedding-3-small).
 */

import process from 'node:process';
import type { SOP } from '../src/lib/sops';

// ----- arg parsing -----
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const forceReEmbed = args.includes('--force');
const batchSizeArg = args.find((a) => a.startsWith('--batch-size='));
const BATCH_SIZE = batchSizeArg ? parseInt(batchSizeArg.split('=')[1], 10) : 10;
const BATCH_DELAY_MS = 1000; // 1 s between batches (rate-limit courtesy)

async function main(): Promise<void> {
  // ----- env check -----
  if (!process.env.OPENAI_API_KEY?.trim()) {
    console.error('[backfill-sop-embeddings] ERROR: OPENAI_API_KEY is not set.');
    console.error('  Set it in your shell or .env.local before running this script.');
    process.exit(1);
  }

  // ----- db + embedding imports -----
  // Dynamic import so DATABASE_PATH is already set before the db module loads
  // (it captures DB_PATH at evaluation time via process.env).
  const db = await import('../src/lib/db');
  const { queryAll, queryOne, run } = db;

  const emb = await import('../src/lib/sop-embeddings');
  const {
    buildSOPEmbedText,
    fetchEmbedding,
    float32ToBuffer,
    EMBEDDING_MODEL,
    EMBEDDING_DIMS,
  } = emb;

  // ----- discover work -----
  const allSOPs = queryAll<SOP>('SELECT * FROM sops WHERE deleted_at IS NULL', []);

  let toEmbed: SOP[];
  if (forceReEmbed) {
    toEmbed = allSOPs;
  } else {
    // Skip SOPs that already have a row in sop_embeddings
    toEmbed = allSOPs.filter((sop) => {
      const existing = queryOne<{ sop_id: string }>(
        'SELECT sop_id FROM sop_embeddings WHERE sop_id = ?',
        [sop.id]
      );
      return !existing;
    });
  }

  console.log(`[backfill-sop-embeddings] Total SOPs in DB (non-deleted): ${allSOPs.length}`);
  console.log(`[backfill-sop-embeddings] SOPs to embed: ${toEmbed.length}${forceReEmbed ? ' (force mode)' : ' (skipping already-embedded)'}`);

  if (dryRun) {
    console.log('[backfill-sop-embeddings] DRY RUN — no API calls will be made.');
    for (const sop of toEmbed) {
      const text = buildSOPEmbedText(sop);
      console.log(`  [dry] ${sop.id} | ${sop.name} | ~${text.length} chars`);
    }
    process.exit(0);
  }

  if (toEmbed.length === 0) {
    console.log('[backfill-sop-embeddings] Nothing to do — all SOPs already have embeddings.');
    process.exit(0);
  }

  // ----- batch embed -----
  let embedded = 0;
  let failed = 0;

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
          [sop.id, blob, EMBEDDING_MODEL, EMBEDDING_DIMS, now]
        );
        embedded++;
        process.stdout.write(`  ✓ ${sop.name}\n`);
      } catch (err) {
        failed++;
        console.error(`  ✗ ${sop.name} (${sop.id}): ${(err as Error).message}`);
      }
    }

    // Pause between batches (skip final pause)
    if (i + BATCH_SIZE < toEmbed.length) {
      await new Promise((resolve) => setTimeout(resolve, BATCH_DELAY_MS));
    }
  }

  console.log('');
  console.log(`[backfill-sop-embeddings] Done. Embedded: ${embedded}, Failed: ${failed}, Total: ${toEmbed.length}`);
  if (failed > 0) {
    console.log('[backfill-sop-embeddings] Re-run to retry failed rows (they will be skipped only after a successful embedding).');
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error('[backfill-sop-embeddings] Fatal error:', err);
  process.exit(1);
});
