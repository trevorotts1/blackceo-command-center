/**
 * scripts/sop-learning-job.ts
 *
 * Standalone runner for the SOP Layer 3 learning loop. Two responsibilities:
 *
 *   1. Detect recurring un-SOP'd patterns in completed tasks and write
 *      candidate proposals to `sop_proposals`.
 *   2. Re-compute performance scores for every active SOP (last 30 days)
 *      and emit a one-line summary per SOP for the operator log.
 *
 * Trigger options (pick whichever Trevor's ops layer prefers):
 *
 *   a) External cron pinging /api/cron/sop-learning (recommended for prod)
 *   b) Direct invocation: `npx tsx scripts/sop-learning-job.ts`
 *   c) Local nightly: launchd / systemd timer running this script
 *
 * Exits 0 on success, non-zero on any error so cron alerting can fire.
 */
import { queryAll } from '@/lib/db';
import { detectPatternsAndPropose, computePerformance } from '@/lib/sop-learning';

async function main() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('SOP Learning Job —', new Date().toISOString());
  console.log('═══════════════════════════════════════════════════════════');

  // Step 1 — pattern detection
  console.log('\n[1/2] Scanning completed tasks for recurring patterns...');
  const detection = detectPatternsAndPropose();
  console.log(`  scanned: ${detection.scanned_tasks} completed tasks`);
  console.log(`  candidates: ${detection.clusters_found} clusters above threshold`);
  console.log(`  proposals_created: ${detection.proposals_created}`);
  if (detection.proposal_ids.length > 0) {
    for (const id of detection.proposal_ids) {
      console.log(`    • ${id}`);
    }
  }

  // Step 2 — performance scoring
  console.log('\n[2/2] Computing 30-day performance scores...');
  const sops = queryAll<{ id: string; name: string; department: string | null }>(
    `SELECT id, name, department FROM sops WHERE deleted_at IS NULL`,
    []
  );

  let boost = 0;
  let flag = 0;
  let neutral = 0;

  for (const sop of sops) {
    const perf = computePerformance(sop.id, 30);
    if (perf.feedback_count === 0) {
      console.log(`  ○ [no-data] ${sop.name}`);
      continue;
    }
    const tag = perf.ranking_signal === 'boost' ? '↑' : perf.ranking_signal === 'flag' ? '↓' : '·';
    console.log(
      `  ${tag} [${perf.ranking_signal}] ${sop.name} — score=${perf.score.toFixed(2)} ` +
        `(${perf.positive_count}+/${perf.negative_count}-, ${perf.skip_count} skip)`
    );
    if (perf.ranking_signal === 'boost') boost++;
    else if (perf.ranking_signal === 'flag') flag++;
    else neutral++;

    if (perf.suggested_revisions.length > 0) {
      for (const rev of perf.suggested_revisions) {
        console.log(`      ↳ ${rev}`);
      }
    }
  }

  console.log('\n═══════════════════════════════════════════════════════════');
  console.log(`Summary: ${boost} boost, ${flag} flagged, ${neutral} neutral`);
  console.log('═══════════════════════════════════════════════════════════');
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[sop-learning-job] FAILED:', err);
    process.exit(1);
  });
