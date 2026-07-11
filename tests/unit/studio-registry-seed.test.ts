/**
 * DB round-trip test for the Studio registry boot/lazy seed (v4.1.6).
 *
 * Runs via the Node built-in test runner under tsx (`npm run test:unit`).
 *
 * The v4.1.4/v4.1.5 work proved `discoverRegistryRows()` emits the right rows
 * in isolation. This test closes the loop the build brief asks for: it drives
 * the ACTUAL seed path end-to-end against a real (temp-file) SQLite database —
 *
 *     discoverRegistryRows()  ->  bulkUpsertModels()  ->  listModels({capability})
 *
 * — which is exactly what `ensureRegistrySeeded()` / `seedRegistryIfEmpty()`
 * run, and exactly what the Studio tabs read. It asserts that an OFFLINE seed
 * (no network) with KIE_API_KEY + OPENAI_API_KEY + FISH_AUDIO_API_KEY present
 * leaves the registry with >= 1 image, >= 1 video, and >= 1 audio ACTIVE row,
 * and that re-seeding is idempotent (no duplicate model_ids).
 *
 * IMPORTANT: DATABASE_PATH is set to a throwaway temp file BEFORE `@/lib/db`'s
 * `getDb()` is ever called, so this never touches a developer's real DB.
 */

// C8 — DB isolation MUST happen in an IMPORTED module, and this MUST stay the
// first import. Assigning process.env.DATABASE_PATH in this file's BODY does not
// work: ES `import` declarations are HOISTED, so any statically-imported project
// module that transitively reaches '@/lib/db' is evaluated FIRST — freezing
// `export const DB_PATH = process.env.DATABASE_PATH || <cwd>/mission-control.db`
// from the un-isolated env. This suite did exactly that and silently opened,
// migrated and wrote the LIVE mission-control.db. Proven by deleting the file and
// re-running this suite alone: it came back.
// Enforced by tests/unit/c8-db-isolation-guard.test.ts.
import './_isolated-db';

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Point the DB at a unique temp file BEFORE the db module is loaded. The db
// module captures `DATABASE_PATH` into a module-level `const DB_PATH` at
// import-evaluation time, and static `import` statements are hoisted above this
// assignment — so the registry/db modules MUST be loaded via dynamic `import()`
// inside the test body, after this env var is set, or they would bind to the
// repo-local cwd path instead. This keeps the test fully isolated to a
// throwaway temp DB.
const TMP_DB = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'bc-studio-seed-')),
  'mission-control.test.db',
);
process.env.DATABASE_PATH = TMP_DB;

// provider-discovery never touches the DB, so a static import is safe here.
import { discoverRegistryRows } from '../../src/lib/studio/provider-discovery';

// Dynamically import the DB-backed registry helpers AFTER DATABASE_PATH is set.
type RegistryModule = typeof import('../../src/lib/model-registry');
type DbModule = typeof import('../../src/lib/db');
let bulkUpsertModels: RegistryModule['bulkUpsertModels'];
let listModels: RegistryModule['listModels'];
let closeDb: DbModule['closeDb'];

test.before(async () => {
  const registry = await import('../../src/lib/model-registry');
  const db = await import('../../src/lib/db');
  bulkUpsertModels = registry.bulkUpsertModels;
  listModels = registry.listModels;
  closeDb = db.closeDb;
});

const SEED_ENV_KEYS = [
  'KIE_API_KEY',
  'KIEAI_API_KEY',
  'KIE_AI_API_KEY',
  'OPENAI_API_KEY',
  'FISH_AUDIO_API_KEY',
  'FAL_KEY',
  'FAL_API_KEY',
  'FAL_AI_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'ELEVENLABS_API_KEY',
  'REPLICATE_API_TOKEN',
  'REPLICATE_API_KEY',
  'LUMA_API_KEY',
  'LUMAAI_API_KEY',
  'STABILITY_API_KEY',
  'STABILITY_AI_API_KEY',
  'RUNWAY_API_KEY',
  'RUNWAYML_API_SECRET',
] as const;

/** Run `fn` with a clean provider env containing only `vars`, then restore. */
function withEnv(vars: Record<string, string>, fn: () => void) {
  const saved: Record<string, string | undefined> = {};
  for (const k of SEED_ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  for (const [k, v] of Object.entries(vars)) process.env[k] = v;
  try {
    fn();
  } finally {
    for (const k of SEED_ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

test.after(() => {
  closeDb();
  try {
    fs.rmSync(path.dirname(TMP_DB), { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

// THE CORE BRIEF ASSERTION, end-to-end against a real DB.
test('offline seed (KIE + OPENAI + FISH_AUDIO) -> registry has >=1 image, video, audio active row', () => {
  withEnv(
    { KIE_API_KEY: 'sk-kie-fake', OPENAI_API_KEY: 'sk-oai-fake', FISH_AUDIO_API_KEY: 'fish-fake' },
    () => {
      // Exactly what ensureRegistrySeeded() does, minus the env hydration step
      // (we provide the env directly): discover offline rows, upsert to DB.
      const rows = discoverRegistryRows({ hydrate: false });
      assert.ok(rows.length > 0, 'discovery must emit rows when keys are present');
      const result = bulkUpsertModels(rows);
      assert.ok(result.models_added > 0, 'first seed must INSERT rows into an empty registry');

      // Now read back exactly the way the Studio tabs do.
      const image = listModels({ capability: 'image_generation', status: 'active' });
      const video = listModels({ capability: 'video_generation', status: 'active' });
      const audio = listModels({ capability: 'audio_generation', status: 'active' });

      assert.ok(image.length >= 1, 'expected >=1 active image_generation row in the registry');
      assert.ok(video.length >= 1, 'expected >=1 active video_generation row in the registry');
      assert.ok(audio.length >= 1, 'expected >=1 active audio_generation row in the registry');

      // The brief requires that at least one provider emits video_generation.
      const videoProviders = new Set(video.map((m) => m.provider));
      assert.ok(videoProviders.size >= 1, 'expected at least one provider emitting video_generation');

      // KIE must contribute BOTH an image and a video row (Fix #3 in the DB).
      const kieCaps = new Set(
        listModels({ provider: 'kie', status: 'active' }).flatMap((m) => m.capabilities),
      );
      assert.ok(
        kieCaps.has('image_generation') && kieCaps.has('video_generation'),
        'KIE rows must carry image_generation + video_generation (never streaming)',
      );
      // Fish Audio must contribute an audio row.
      const fishCaps = new Set(
        listModels({ provider: 'fish-audio', status: 'active' }).flatMap((m) => m.capabilities),
      );
      assert.ok(fishCaps.has('audio_generation'), 'fish-audio rows must carry audio_generation');
    },
  );
});

// Idempotency: a second seed UPDATEs, never duplicates model_ids.
test('re-seeding is idempotent (no duplicate model_ids)', () => {
  withEnv(
    { KIE_API_KEY: 'sk-kie-fake', OPENAI_API_KEY: 'sk-oai-fake', FISH_AUDIO_API_KEY: 'fish-fake' },
    () => {
      const rows = discoverRegistryRows({ hydrate: false });
      const before = listModels({ status: 'active' }).length;
      const result = bulkUpsertModels(rows);
      assert.equal(result.models_added, 0, 'second seed must add zero new rows');
      assert.ok(result.models_updated > 0, 'second seed must update the existing rows in place');

      const all = listModels({ status: 'active' });
      assert.equal(all.length, before, 'row count must not grow on re-seed');
      const ids = all.map((m) => m.model_id);
      assert.equal(new Set(ids).size, ids.length, 'no duplicate model_ids after re-seed');
    },
  );
});
