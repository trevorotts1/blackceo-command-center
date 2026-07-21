/**
 * CC-fixture-002 — canned MEDIA, canned BROWSING and canned PERSONA/SOP content
 * must never become a durable artifact the system treats as genuine.
 *
 * THE DEFECT (the same class CC-resear-001 closed for research, found in four
 * more places by sweeping every fixture mechanism in the repo)
 * ---------------------------------------------------------------------------
 *  1. STUDIO_FIXTURE_{IMAGE,VIDEO,AUDIO}_PATH — src/lib/studio/generators.ts
 *     `fs.copyFile()`d the canned binary into
 *     `<vault>/studio/<kind>/YYYY/MM/<slug>.<ext>` and marked the job
 *     `succeeded`. This is the SHARPEST case: a media file carries no citation
 *     to inspect and no provenance to check. `walkVaultSubdir('studio')` in
 *     src/lib/workspaces/buckets.ts enumerates that tree BY PATH into the
 *     "All Images" / "All Videos" buckets — "Every image rendered across
 *     agents, studio, and research". The `provider_used: 'fixture'` label lived
 *     in `<vault>/studio/.jobs/<id>.json`, and the bucket walk reads the FILES,
 *     not the ledger, so no label could ever save the asset.
 *  2. WEB_AGENT_FIXTURE_PATH — src/lib/web-agent/runner.ts wrote the canned
 *     "findings" to a durable `web_agent_sessions.result_markdown` row AND
 *     mirrored them to `<vault>/web-agent/YYYY/MM/*.md`, which Memory's vault
 *     walk ingests (src/lib/operator/memory-search.ts -> readLocalDir in
 *     src/lib/operator/client-fs.ts; `web-agent/` is not in its skip list).
 *     `writeClientFile('vault-root', ...)` can resolve to a CLIENT's pinned
 *     workspace root, so canned findings could be filed into a client vault.
 *  3. PERSONA_FIXTURE_JSON / PERSONA_PLAN_FIXTURE_JSON —
 *     src/lib/persona-selector.ts pinned the canned selection onto
 *     `tasks.persona_id / persona_name / persona_mode / persona_score /
 *     persona_reason`, unlabelled. The comment said "Never set this in
 *     production" but nothing enforced it.
 *  4. None of the six vars above were in `FIXTURE_ENV_VARS`, so
 *     `activeFixtureEnvVars()` — and therefore the deep-health sweep —
 *     reported a box CLEAN while fixtures were live.
 *  5. GEMINI_/TAVILY_FIXTURE_JSON_PATH reach the canonical `sops` table via
 *     src/lib/sop-authoring.ts (auto-authored, NO operator approval, filed with
 *     `source = NULL` so it looks organically produced) and `sop_proposals` via
 *     src/lib/sop-auto-replace.ts. Those two vars WERE guarded in production,
 *     but `assertNoFixtureEnvInProduction()` is a no-op below production and a
 *     `next dev` server writes to the SAME mission-control.db.
 *
 * WHAT THIS FILE LOCKS DOWN
 * -------------------------
 *  A. DETECTION — FIXTURE_ENV_VARS names all six previously-invisible vars, so
 *     a diagnostic sweep can see them and `checkFixtureEnvVars()` reports them.
 *  B. PREVENTION (production) — the SHARED guard (never a second one) fires
 *     from studio, web-agent and persona-selector.
 *  C. PREVENTION (every NODE_ENV) — the studio fixture path writes NOTHING into
 *     the vault, and the SOP durable writes are refused inside the live server
 *     process regardless of NODE_ENV.
 *  D. NO REGRESSION — with no fixture var set, nothing changes.
 *  E. TESTING STILL WORKS — studio fixture mode still drives the real job
 *     lifecycle to `succeeded`, and the offline SOP smoke scripts (which run
 *     OUTSIDE the server process against a throwaway DATABASE_PATH) are
 *     explicitly unaffected.
 *
 * Isolation: `_isolated-db` is imported FIRST (C8 guard), and every vault
 * assertion runs against a throwaway HOME so this suite can never write into
 * the real `~/clawd` vault.
 *
 * Runs via the Node built-in test runner under tsx (`npm run test:unit`).
 */

import './_isolated-db';

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  FIXTURE_ENV_VARS,
  MEDIA_FIXTURE_ENV_VARS,
  PERSONA_FIXTURE_ENV_VARS,
  activeFixtureEnvVars,
  assertNoFixtureEnvInProduction,
  assertNoFixtureDerivedServerWrite,
} from '../../src/lib/fixture-guard';
import { checkFixtureEnvVars } from '../../src/lib/health/deep-checks';

/** Restore every env var this suite touches, whatever a test did to it. */
async function withEnvAsync<T>(
  patch: Record<string, string | undefined>,
  fn: () => Promise<T>,
): Promise<T> {
  const saved = new Map<string, string | undefined>();
  for (const k of Object.keys(patch)) saved.set(k, process.env[k]);
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

function withEnv<T>(patch: Record<string, string | undefined>, fn: () => T): T {
  const saved = new Map<string, string | undefined>();
  for (const k of Object.keys(patch)) saved.set(k, process.env[k]);
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

// ── A canned "generated" image. Two bytes of PNG header is enough: the point
// is that it is a BINARY with no citation, no provenance and no tell. ────────
const CANNED_PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
]);
const FIXTURE_IMAGE = path.join(
  os.tmpdir(),
  `cc-fixture-002-canned-${process.pid}-${Date.now()}.png`,
);
fs.writeFileSync(FIXTURE_IMAGE, CANNED_PNG);

// ───────────────────────────────────────────────────────────────────────────
// A. DETECTION — the sweep can no longer call a fixture-running box "clean"
// ───────────────────────────────────────────────────────────────────────────

test('A1: FIXTURE_ENV_VARS names the media/agent fixture vars', () => {
  for (const name of [
    'STUDIO_FIXTURE_IMAGE_PATH',
    'STUDIO_FIXTURE_VIDEO_PATH',
    'STUDIO_FIXTURE_AUDIO_PATH',
    'WEB_AGENT_FIXTURE_PATH',
  ]) {
    assert.ok(
      (FIXTURE_ENV_VARS as readonly string[]).includes(name),
      `${name} substitutes canned MEDIA for a live call and must be visible to ` +
        `activeFixtureEnvVars() — otherwise a diagnostic sweep reports a box clean ` +
        `while a canned asset is being served as produced work.`,
    );
    assert.ok(
      (MEDIA_FIXTURE_ENV_VARS as readonly string[]).includes(name),
      `${name} must be in the MEDIA_FIXTURE_ENV_VARS group.`,
    );
  }
});

test('A2: FIXTURE_ENV_VARS names the persona fixture vars', () => {
  for (const name of ['PERSONA_FIXTURE_JSON', 'PERSONA_PLAN_FIXTURE_JSON']) {
    assert.ok(
      (FIXTURE_ENV_VARS as readonly string[]).includes(name),
      `${name} steers which persona is pinned durably onto tasks.persona_* and ` +
        `must be visible to a diagnostic sweep.`,
    );
    assert.ok(
      (PERSONA_FIXTURE_ENV_VARS as readonly string[]).includes(name),
      `${name} must be in the PERSONA_FIXTURE_ENV_VARS group.`,
    );
  }
});

test('A3: deep-health REPORTS an active media fixture — never "clean"', async () => {
  await withEnvAsync({ STUDIO_FIXTURE_IMAGE_PATH: FIXTURE_IMAGE }, async () => {
    assert.ok(
      activeFixtureEnvVars().includes('STUDIO_FIXTURE_IMAGE_PATH'),
      'activeFixtureEnvVars() must surface an active studio media fixture',
    );
    const check = checkFixtureEnvVars();
    assert.equal(
      check.pass,
      false,
      'deep-health must NOT report OK while a studio media fixture is active',
    );
    assert.ok(
      check.detail.includes('STUDIO_FIXTURE_IMAGE_PATH') &&
        check.active_fixture_env_vars.includes('STUDIO_FIXTURE_IMAGE_PATH'),
      `deep-health detail must NAME the active var; got: ${check.detail}`,
    );
  });
});

test('A4: deep-health REPORTS an active persona fixture — never "clean"', async () => {
  await withEnvAsync({ PERSONA_FIXTURE_JSON: '{"persona_id":"canned"}' }, async () => {
    const check = checkFixtureEnvVars();
    assert.equal(check.pass, false, 'deep-health must NOT report OK with a persona fixture active');
    assert.ok(
      check.detail.includes('PERSONA_FIXTURE_JSON') &&
        check.active_fixture_env_vars.includes('PERSONA_FIXTURE_JSON'),
      `deep-health detail must NAME the active var; got: ${check.detail}`,
    );
  });
});

// ───────────────────────────────────────────────────────────────────────────
// B. PREVENTION (production) — the shared guard covers the new vars
// ───────────────────────────────────────────────────────────────────────────

test('B1: the shared guard hard-fails a media fixture in production', () => {
  withEnv({ NODE_ENV: 'production', STUDIO_FIXTURE_IMAGE_PATH: FIXTURE_IMAGE }, () => {
    assert.throws(
      () => assertNoFixtureEnvInProduction(),
      /STUDIO_FIXTURE_IMAGE_PATH/,
      'a canned media asset must never be served on a live box',
    );
  });
});

test('B2: the shared guard hard-fails a web-agent fixture in production', () => {
  withEnv({ NODE_ENV: 'production', WEB_AGENT_FIXTURE_PATH: FIXTURE_IMAGE }, () => {
    assert.throws(() => assertNoFixtureEnvInProduction(), /WEB_AGENT_FIXTURE_PATH/);
  });
});

test('B3: the shared guard hard-fails a persona fixture in production', () => {
  withEnv({ NODE_ENV: 'production', PERSONA_FIXTURE_JSON: '{"persona_id":"canned"}' }, () => {
    assert.throws(() => assertNoFixtureEnvInProduction(), /PERSONA_FIXTURE_JSON/);
  });
});

test('B4: persona-selector actually CALLS the guard (wired, not just listed)', async () => {
  const { selectPersonaForTask } = await import('../../src/lib/persona-selector');
  await withEnvAsync(
    {
      NODE_ENV: 'production',
      PERSONA_FIXTURE_JSON: JSON.stringify({ persona_id: 'canned-persona', score: 9.9 }),
    },
    async () => {
      await assert.rejects(
        async () => selectPersonaForTask('any task', null),
        /Fixture\/simulate bypass env var/,
        'selectPersonaForTask must refuse a canned persona on a live box — the ' +
          'selection is pinned durably onto tasks.persona_* with no fixture column',
      );
    },
  );
});

// ───────────────────────────────────────────────────────────────────────────
// C. PREVENTION (every NODE_ENV) — no canned asset enters the vault
// ───────────────────────────────────────────────────────────────────────────

test('C1: a studio fixture job writes NOTHING into <vault>/studio/<kind>/', async () => {
  // Throwaway HOME so vaultRoot() cannot resolve to the real ~/clawd vault.
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-fixture-002-home-'));

  await withEnvAsync(
    {
      HOME: fakeHome,
      NODE_ENV: 'test',
      STUDIO_FIXTURE_IMAGE_PATH: FIXTURE_IMAGE,
      OPENAI_API_KEY: 'test-key-not-used-fixture-short-circuits',
    },
    async () => {
      const { upsertModel } = await import('../../src/lib/model-registry');
      const { createJob, loadJob } = await import('../../src/lib/studio/generators');

      upsertModel({
        model_id: 'gpt-image-1',
        label: 'Test Image Model',
        provider: 'openai',
        capabilities: ['image_generation'],
        status: 'active',
      });

      const job = await createJob({ kind: 'image', prompt: 'cc fixture 002 probe' });

      // Poll the real lifecycle to a terminal state.
      let settled = null;
      for (let i = 0; i < 60; i += 1) {
        await new Promise((r) => setTimeout(r, 50));
        const j = await loadJob(job.id);
        if (j && (j.status === 'succeeded' || j.status === 'failed')) {
          settled = j;
          break;
        }
      }
      assert.ok(settled, 'studio job never reached a terminal state');

      // E. Fixture mode still drives the real lifecycle — offline testing works.
      assert.equal(
        settled.status,
        'succeeded',
        `fixture mode must remain usable offline; job error was: ${settled.error}`,
      );
      assert.equal(
        settled.metadata.vault_write_refused,
        true,
        'the job must record that the durable vault write was refused',
      );
      assert.equal(
        settled.result_path,
        FIXTURE_IMAGE,
        "result_path must reference the operator's own fixture file in place, not a vault copy",
      );

      // C. THE INVARIANT: nothing was copied into the media tree that
      // walkVaultSubdir('studio') enumerates into All Images / All Videos.
      const mediaTree = path.join(fakeHome, 'clawd', 'studio', 'image');
      let copied: string[] = [];
      if (fs.existsSync(mediaTree)) {
        const walk = (dir: string): void => {
          for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, ent.name);
            if (ent.isDirectory()) walk(full);
            else copied.push(full);
          }
        };
        walk(mediaTree);
      }
      assert.deepEqual(
        copied,
        [],
        `a canned image was copied into the vault media tree (${copied.join(', ')}). ` +
          `buckets.ts walks that tree BY PATH into "All Images" and the media file ` +
          `carries no fixture label, so it becomes indistinguishable from produced work.`,
      );
    },
  );

  fs.rmSync(fakeHome, { recursive: true, force: true });
});

test('C2: the live server refuses a fixture-derived SOP write at ANY NODE_ENV', () => {
  withEnv({ NODE_ENV: 'development', GEMINI_FIXTURE_JSON_PATH: FIXTURE_IMAGE }, () => {
    const saved = globalThis.__CC_SERVER_ENTRYPOINT__;
    try {
      // Inside the real Next server process (the marker only src/instrumentation.ts sets).
      globalThis.__CC_SERVER_ENTRYPOINT__ = true;
      assert.throws(
        () => assertNoFixtureDerivedServerWrite('a sops row (auto-authored SOP)'),
        /GEMINI_FIXTURE_JSON_PATH/,
        'a dev server writes to the SAME mission-control.db as production — a canned ' +
          'SOP must not reach the canonical sops table just because NODE_ENV != production',
      );
    } finally {
      globalThis.__CC_SERVER_ENTRYPOINT__ = saved;
    }
  });
});

test('C3: offline SOP smoke tooling still works (outside the server process)', () => {
  withEnv({ NODE_ENV: 'test', GEMINI_FIXTURE_JSON_PATH: FIXTURE_IMAGE }, () => {
    const saved = globalThis.__CC_SERVER_ENTRYPOINT__;
    try {
      // A smoke script runs WITHOUT the server marker, against its own
      // throwaway DATABASE_PATH. Fixture mode must stay fully usable there.
      delete globalThis.__CC_SERVER_ENTRYPOINT__;
      assert.doesNotThrow(
        () => assertNoFixtureDerivedServerWrite('a sops row (auto-authored SOP)'),
        'scripts/smoke-test-sop-authoring.ts must keep working — the guard targets ' +
          'the live server process, not legitimate offline testing',
      );
    } finally {
      globalThis.__CC_SERVER_ENTRYPOINT__ = saved;
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
// D. NO REGRESSION — with no fixture var set, nothing changes
// ───────────────────────────────────────────────────────────────────────────

test('D1: with no fixture var set the box reports clean and nothing is refused', async () => {
  const clearAll: Record<string, string | undefined> = { NODE_ENV: 'test' };
  for (const name of FIXTURE_ENV_VARS) clearAll[name] = undefined;

  await withEnvAsync(clearAll, async () => {
    assert.deepEqual(activeFixtureEnvVars(), [], 'no fixture var should be active');
    assert.doesNotThrow(() => assertNoFixtureEnvInProduction());

    const saved = globalThis.__CC_SERVER_ENTRYPOINT__;
    try {
      globalThis.__CC_SERVER_ENTRYPOINT__ = true;
      assert.doesNotThrow(
        () => assertNoFixtureDerivedServerWrite('a sops row (auto-authored SOP)'),
        'the live path must be completely untouched when no fixture is active',
      );
    } finally {
      globalThis.__CC_SERVER_ENTRYPOINT__ = saved;
    }

    const check = checkFixtureEnvVars();
    assert.equal(check.pass, true, `a clean box must report ok; got: ${check.detail}`);
  });
});
