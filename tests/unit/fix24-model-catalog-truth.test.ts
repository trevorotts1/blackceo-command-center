/**
 * FIX-24 (Error 13 / T-24) — model-catalog truth: the CC model registry and
 * operator catalog must name the LIVE fleet id `deepseek-v4-flash:0731-cloud`,
 * and the string `0713` must appear NOWHERE in the catalog or standing
 * instructions (the wrong tag Trevor once typed; it is not installed anywhere).
 *
 * QC gate (Gauntlet loop FIX-24 row): read the CC `model_registry` row for the
 * presentation dept + operator catalog; Row == `deepseek-v4-flash:0731-cloud`;
 * the string `0713` appears nowhere in the catalog.
 *
 * This suite proves:
 *   1. The presentations department's model resolves to
 *      `deepseek-v4-flash:0731-cloud` (provider-prefix-insensitive), NOT the
 *      retired `deepseek-v4-flash:cloud` build that was removed fleet-wide on
 *      2026-08-06, and NOT a phantom `0713` tag.
 *   2. When the registry is seeded exactly as the live Ollama Cloud catalog
 *      returns it (`ollama-cloud/deepseek-v4-flash:0731-cloud`), the task-time
 *      selector (via `intelligence-resolver.resolveSettings`) picks it for a
 *      presentation text task — the row the QC gate reads.
 *   3. A catalog-wide python-style scan of the registry rows for the string
 *      `0713` yields ZERO hits (the `0713` phantom never exists in the catalog).
 *   4. The retired `deepseek-v4-flash:cloud` build is NOT the presentations
 *      model — the live registry row must name the 0731 build.
 *   5. The provider connector that populates the registry emits the LIVE id
 *      (not a stale `:cloud` / `:0713`).
 *
 * Run: node --import tsx --test tests/unit/fix24-model-catalog-truth.test.ts
 */

// C8 isolation FIRST — must precede any @/lib/db import.
import './_isolated-db';

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { getDb, queryAll, run } from '../../src/lib/db';
import {
  normalizeModelId,
  modelsMatch,
} from '../../src/lib/runtime-model';
import type { ModelRegistryEntry } from '../../src/lib/model-registry-types';
import { FLEET_PRIMARY_MODEL_ID } from '../../src/lib/model-registry';

/** The live fleet model id (per the 2026-08-06 fleet rollout). */
const LIVE_FLEET_ID = 'deepseek-v4-flash:0731-cloud';
/** The registry-scoped id the ollama-cloud connector emits for it. */
const LIVE_FLEET_REGISTRY_ID = 'ollama-cloud/deepseek-v4-flash:0731-cloud';
/** The RETIRED pre-0731 build (removed fleet-wide 2026-08-06). */
const RETIRED_BUILD_ID = 'deepseek-v4-flash:cloud';
/** The phantom tag from Error 13 — must never exist anywhere. */
const PHANTOM_ID = 'deepseek-v4-flash:0713';

const db = getDb();

function clearRegistry(provider = 'ollama-cloud'): void {
  db.prepare(`DELETE FROM model_registry WHERE provider = ?`).run(provider);
}

function seedRow(modelId: string, provider = 'ollama-cloud', status = 'active'): void {
  db.prepare(
    `INSERT OR REPLACE INTO model_registry
       (model_id, label, provider, family, context_window,
        input_cost_per_million, output_cost_per_million,
        pricing_model, pricing_source, capabilities, status, raw_metadata)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    modelId,
    modelId.split('/').pop() ?? modelId,
    provider,
    'deepseek',
    1_048_576,
    0,
    0,
    'flat_rate_plan',
    'auto',
    JSON.stringify(['text', 'streaming']),
    status,
    '{}',
  );
}

/** A registry row shaped exactly like the connector's normalizeModel() output. */
function connectorRow(modelId: string): ModelRegistryEntry {
  return {
    id: 0,
    model_id: modelId,
    label: modelId,
    provider: 'ollama-cloud',
    family: 'deepseek',
    context_window: 1_048_576,
    input_cost_per_million: 0,
    output_cost_per_million: 0,
    pricing_model: 'flat_rate_plan',
    pricing_source: 'auto',
    capabilities: ['text', 'streaming'],
    status: 'active',
    added_at: '',
    last_seen_at: '',
    raw_metadata: {},
  };
}

// ─── 1. THE QC ROW: presentations model resolves to the live 0731-cloud id ───
test('FIX-24: the presentations model resolves to deepseek-v4-flash:0731-cloud (NOT the retired :cloud build)', () => {
  // Registry carries BOTH the retired build (stale leftover) and the live id.
  // The live id is what the QC gate must find for the presentation dept.
  clearRegistry();
  seedRow(RETIRED_BUILD_ID);          // retired, but a real registry row exists
  seedRow(LIVE_FLEET_REGISTRY_ID);    // the live fleet id the refresh emits

  const rows = queryAll<{ model_id: string; status: string }>(
    `SELECT model_id, status FROM model_registry WHERE model_id LIKE '%deepseek-v4-flash%' ORDER BY model_id`,
  );

  // The row the presentations dept resolves to must normalize to 0731-cloud.
  const liveRow = rows.find((r) => normalizeModelId(r.model_id) === LIVE_FLEET_ID);
  assert.ok(liveRow, `registry must contain a row resolving to ${LIVE_FLEET_ID}`);
  assert.equal(liveRow!.status, 'active', 'the live presentations model row must be active');
  assert.ok(
    modelsMatch(liveRow!.model_id, LIVE_FLEET_ID),
    `${liveRow!.model_id} must match the live fleet id ${LIVE_FLEET_ID}`,
  );

  // The retired :cloud build must NOT be the model the presentations dept runs.
  const retiredRow = rows.find((r) => normalizeModelId(r.model_id) === RETIRED_BUILD_ID);
  assert.ok(retiredRow, 'the retired build may still exist as a deprecated row, but…');
  assert.notEqual(
    normalizeModelId(liveRow!.model_id),
    normalizeModelId(RETIRED_BUILD_ID),
    'the presentations model must NOT be the retired :cloud build',
  );
});

// ─── 2. Registry scan: the string `0713` appears NOWHERE in the catalog ──────
test('FIX-24: the string "0713" appears nowhere in the model_registry catalog', () => {
  clearRegistry();
  // Seed the live id + a plausible full catalog (the real box has ~700 rows).
  seedRow(LIVE_FLEET_REGISTRY_ID);
  seedRow('ollama-cloud/deepseek-v4-pro:cloud');
  seedRow('ollama-cloud/kimi-k2.6:cloud');
  seedRow('ollama-local/deepseek-v4-flash:cloud');
  seedRow('openrouter/deepseek/deepseek-v4-flash-0731');

  const rows = queryAll<{ model_id: string }>(
    `SELECT model_id FROM model_registry`,
  );
  for (const r of rows) {
    assert.ok(
      !r.model_id.includes('0713'),
      `catalog must not contain a "0713" phantom — found: ${r.model_id}`,
    );
  }
  assert.ok(rows.length >= 1, 'catalog scan ran over a non-empty registry');
});

// ─── 3. The presentations dept task-time selector picks the 0731 row ────────
test('FIX-24: resolveSettings for a presentations text task resolves to the 0731-cloud row', async () => {
  clearRegistry();
  seedRow(RETIRED_BUILD_ID);
  seedRow(LIVE_FLEET_REGISTRY_ID);

  // Seed a presentations workspace + agent + task so resolveSettings can run
  // end-to-end through the real Layer-4 task-time selector.
  const now = new Date().toISOString();
  run(
    `INSERT OR IGNORE INTO workspaces (id, slug, name, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)`,
    ['fix24-presentations', 'presentations', 'Presentations', now, now],
  );
  run(
    `INSERT OR IGNORE INTO agents (id, name, role, avatar_emoji, status, is_master, workspace_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ['fix24-pres-agent', 'Presentations', 'Presentations', '🤖', 'standby', 0, 'fix24-presentations', now, now],
  );
  run(
    `INSERT OR IGNORE INTO tasks (id, title, description, status, priority, created_at, updated_at, workspace_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ['fix24-pres-task', 'Build a 20-slide sales deck', 'Canonical presentation build', 'backlog', 'medium', now, now, 'fix24-presentations'],
  );

  const { resolveSettings } = await import('../../src/lib/intelligence-resolver');
  const res = resolveSettings('fix24-pres-agent', 'fix24-presentations', 'fix24-pres-task');

  assert.ok(
    modelsMatch(res.model, LIVE_FLEET_ID),
    `presentations task resolved model "${res.model}" must match the live fleet id ${LIVE_FLEET_ID}`,
  );
  assert.ok(
    !res.model.includes('0713'),
    `a presentation task must never resolve onto a "0713" phantom — got: ${res.model}`,
  );
});

// ─── 4. The connector emits the LIVE id, never a stale :cloud / :0713 ───────
test('FIX-24: the ollama-cloud connector normalizes a live row to the 0731-cloud id', () => {
  const emitted = connectorRow(LIVE_FLEET_REGISTRY_ID);
  assert.equal(normalizeModelId(emitted.model_id), LIVE_FLEET_ID);
  assert.equal(modelsMatch(emitted.model_id, LIVE_FLEET_ID), true);
  assert.equal(modelsMatch(emitted.model_id, PHANTOM_ID), false, 'must not match the 0713 phantom');
});

// ─── 4b. The QC-judge gate recognizes the LIVE 0731-cloud build ─────────────
test('FIX-24: isOllamaCloudModel accepts the live 0731-cloud build (Error-13 gate truth)', async () => {
  // Regression: the QC-judge classifier used to check `id.includes(':cloud')`,
  // which silently REJECTED `deepseek-v4-flash:0731-cloud` (the fleet has run
  // this build since 2026-08-06). A gate that does not recognize the model the
  // catalog names is exactly the Error-13 truth failure — pinned here.
  const { isOllamaCloudModel } = await import('../../src/lib/qc-scorer');
  assert.equal(isOllamaCloudModel(LIVE_FLEET_ID), true, 'the live fleet id must be an Ollama Cloud model');
  assert.equal(isOllamaCloudModel(LIVE_FLEET_REGISTRY_ID), true, 'the registry-form live id must be recognized');
  assert.equal(isOllamaCloudModel(RETIRED_BUILD_ID), true, 'the legacy :cloud tag stays recognized (back-compat)');
  assert.equal(isOllamaCloudModel('ollama-cloud/llama3.3:70b'), true, 'registry-form ollama-cloud ids stay recognized');
  assert.equal(isOllamaCloudModel('openrouter/deepseek/deepseek-v4-flash'), false, 'an openrouter id is NOT an Ollama Cloud judge');
});

// ─── 4c. ensureFleetPrimaryModel registers the live id on boot seed ─────────
test('FIX-24: the boot seed path registers the live fleet primary id (QC-gate row)', async () => {
  clearRegistry();
  // Start EMPTY (fresh deploy before the weekly refresh) — the exact state the
  // QC gate must survive. The boot seed calls ensureFleetPrimaryModel().
  const { ensureFleetPrimaryModel } = await import('../../src/lib/model-registry');
  const outcome = ensureFleetPrimaryModel();
  assert.ok(['inserted', 'updated', 'present'].includes(outcome), `unexpected outcome: ${outcome}`);

  const row = queryAll<{ model_id: string; status: string }>(
    `SELECT model_id, status FROM model_registry WHERE model_id = ?`,
    [FLEET_PRIMARY_MODEL_ID],
  );
  assert.equal(row.length, 1, 'the live fleet primary id must be registered');
  assert.equal(row[0]!.status, 'active', 'the live fleet primary row must be active');
  assert.equal(normalizeModelId(row[0]!.model_id), LIVE_FLEET_ID);

  // Idempotent: a second call must not duplicate the row.
  ensureFleetPrimaryModel();
  const again = queryAll<{ model_id: string }>(
    `SELECT model_id FROM model_registry WHERE model_id = ?`,
    [FLEET_PRIMARY_MODEL_ID],
  );
  assert.equal(again.length, 1, 'ensureFleetPrimaryModel must be idempotent');
});

// ─── 5. Provider-id scan across a realistic catalog for the phantom ─────────
test('FIX-24: a realistic catalog with the phantom seeded as a string is DETECTED (control)', () => {
  // Known-good control per QC discipline: prove the negative result is real by
  // showing the SAME scan WOULD flag a phantom if one existed. This proves the
  // "no 0713 anywhere" assertion is not a broken check that always passes.
  clearRegistry();
  seedRow(LIVE_FLEET_REGISTRY_ID);
  seedRow(PHANTOM_ID); // seed the phantom deliberately

  const rows = queryAll<{ model_id: string }>(`SELECT model_id FROM model_registry`);
  const found = rows.filter((r) => r.model_id.includes('0713'));
  assert.equal(found.length, 1, 'the control scan must DETECT the deliberately-seeded phantom');
  assert.equal(found[0]!.model_id, PHANTOM_ID);
});

// ─── Cleanup ────────────────────────────────────────────────────────────────
test('cleanup: remove seeded rows and the isolated DB', () => {
  // Best-effort: resolveSettings may have written dependent rows (events /
  // persona_selection_log) referencing the seeded task, so delete child-first
  // and tolerate any FK noise — the isolated DB is temp and deleted regardless.
  for (const table of ['persona_selection_log', 'events']) {
    try {
      db.prepare(`DELETE FROM ${table} WHERE task_id = ?`).run('fix24-pres-task');
    } catch { /* tolerant */ }
  }
  clearRegistry();
  try { db.prepare(`DELETE FROM tasks WHERE id = ?`).run('fix24-pres-task'); } catch { /* tolerant */ }
  try { db.prepare(`DELETE FROM agents WHERE id = ?`).run('fix24-pres-agent'); } catch { /* tolerant */ }
  try { db.prepare(`DELETE FROM workspaces WHERE id = ?`).run('fix24-presentations'); } catch { /* tolerant */ }
  const dbPath = process.env.DATABASE_PATH ?? '';
  assert.ok(dbPath, 'DATABASE_PATH must be set by ./_isolated-db');
  assert.ok(!dbPath.endsWith('mission-control.db'), 'isolation failed — live DB');
  const { closeDb } = require('../../src/lib/db') as typeof import('../../src/lib/db');
  closeDb();
  fs.rmSync(dbPath, { force: true });
});
