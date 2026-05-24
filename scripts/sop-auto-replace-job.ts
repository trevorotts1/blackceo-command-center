/**
 * Track S — Standalone auto-replace job runner.
 *
 * Usage:
 *   tsx scripts/sop-auto-replace-job.ts <deleted-sop-id> [--no-notify] [--fixtures]
 *
 * Normally `enqueueAutoReplace()` is called in-process from the DELETE
 * endpoint. This script exists as the fallback path for:
 *   • Backfilling proposals against deletes that happened before Track S
 *   • Manual operator re-runs after a failure
 *   • Future queue-based processing if we move to async
 *
 * Test-mode (`--fixtures`) reads Tavily + Gemini responses from local
 * fixture files so the job runs at $0 cost and never fires Telegram.
 */

import path from 'node:path';
import fs from 'node:fs';
import { enqueueAutoReplace } from '../src/lib/sop-auto-replace';

async function main() {
  const args = process.argv.slice(2);
  const sopId = args.find((a) => !a.startsWith('--'));
  if (!sopId) {
    console.error('Usage: tsx scripts/sop-auto-replace-job.ts <sop-id> [--no-notify] [--fixtures]');
    process.exit(1);
  }
  const noNotify = args.includes('--no-notify');
  const useFixtures = args.includes('--fixtures');

  if (useFixtures) {
    process.env.SOP_AUTO_REPLACE_TELEGRAM_DISABLED = '1';
    const tavilyFixture = path.resolve(__dirname, 'fixtures/tavily-sample.json');
    const geminiFixture = path.resolve(__dirname, 'fixtures/gemini-sample.json');
    if (!fs.existsSync(tavilyFixture)) {
      console.error(`Fixture not found: ${tavilyFixture}`);
      process.exit(2);
    }
    if (!fs.existsSync(geminiFixture)) {
      console.error(`Fixture not found: ${geminiFixture}`);
      process.exit(2);
    }
    process.env.TAVILY_FIXTURE_JSON_PATH = tavilyFixture;
    process.env.GEMINI_FIXTURE_JSON_PATH = geminiFixture;
  }

  console.log(`[sop-auto-replace-job] starting for SOP ${sopId}`);
  console.log(`[sop-auto-replace-job] fixtures=${useFixtures} notify=${!noNotify}`);

  const result = await enqueueAutoReplace(sopId, { notify: !noNotify });
  console.log(`[sop-auto-replace-job] done:`);
  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error('[sop-auto-replace-job] failed:', err);
  process.exit(1);
});
