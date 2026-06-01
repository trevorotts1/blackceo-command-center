/**
 * Seed the starter SOP library that anchors the Hybrid SOP system / Triad Rule.
 *
 * The SOP definitions + idempotent seeder now live in the shared module
 * `src/lib/sops-seed.ts` so the SAME data is used by BOTH this manual script
 * and the first-boot / Skill-23 DB-init auto-seed (src/lib/db/migrations.ts).
 * This script remains as the manual entrypoint (`npm run db:seed:sops`) and as
 * a way to re-seed on demand.
 *
 * Run with:   npx tsx scripts/seed-starter-sops.ts
 *
 * Idempotent: skips any SOP whose slug already exists (matched on slug).
 */

import { getDb } from '../src/lib/db';
import { seedStarterSOPs } from '../src/lib/sops-seed';

function seed() {
  // Initialize DB / run migrations (this also triggers the boot auto-seed, but
  // idempotency makes the explicit call below harmless).
  const db = getDb();
  const { inserted, skipped, total } = seedStarterSOPs(db);
  console.log(`\n[seed-starter-sops] Done. Inserted ${inserted}, skipped ${skipped} (of ${total} total).`);
}

seed();
