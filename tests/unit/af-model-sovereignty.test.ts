/**
 * Unit tests — AF-MODEL-SOVEREIGNTY gate + Intelligent Model Selector
 *
 * Proves that:
 *   1. REJECTED_FREE_DEFAULT constant is 'openrouter/free' (named, never returned).
 *   2. When no model is configured (empty inventory, no agent_settings),
 *      resolveSettings returns model = 'needs_owner_input' — FAIL LOUD, never
 *      silently substituting openrouter/free.
 *   3. When a valid model is set in agent_settings (the "box primary"), resolveSettings
 *      returns that model — the client's explicitly chosen model wins.
 *   4. When agent_settings row has value='openrouter/free', it is REJECTED and the
 *      resolver continues to needs_owner_input (not silently allowed).
 *   5. checkModelSovereignty blocks openrouter/free — returns 'free_default' violation.
 *   6. checkModelSovereignty blocks needs_owner_input — returns 'needs_owner_input' violation.
 *   7. checkModelSovereignty blocks null — returns 'null_model' violation.
 *   8. checkModelSovereignty passes a valid, non-free, non-Anthropic model_id.
 *   9. checkModelSovereignty blocks Anthropic model ids (forbidden_prefix).
 *  10. The box primary model (e.g. ollama/kimi:cloud) passes sovereignty when
 *      it is in the inventory.
 *
 * Runs via the Node built-in test runner under tsx (`npm run test:unit`).
 * Uses a temp SQLite DB (process.env.DATABASE_PATH) — no network, no side effects.
 */

// ── Temp DB isolation ──────────────────────────────────────────────────────
// C8 FIX — this MUST be the first import, and it MUST be an import.
//
// This file used to do:
//     const TMP_DB = path.join(TMP_DIR, 'sovereignty-test.db');
//     process.env.DATABASE_PATH = TMP_DB;          // ← in the module BODY
//     import { run, closeDb } from '../../src/lib/db';
//
// with a comment asserting the env was "set BEFORE the first @/lib/db import".
// It was not. ES `import` declarations are HOISTED: '../../src/lib/db' was
// evaluated — freezing `export const DB_PATH = process.env.DATABASE_PATH ||
// <cwd>/mission-control.db` from the un-isolated env — BEFORE the assignment
// ever ran. The isolation silently did nothing and this suite opened, migrated
// and wrote the LIVE mission-control.db. Proven: deleting mission-control.db
// and running this file alone re-created it in the repo root.
//
// Setting the env var inside an IMPORTED module is the fix — imports are
// evaluated in order, so this runs before '../../src/lib/db' below.
// tests/unit/c8-db-isolation-guard.test.ts fails the build if this regresses.
import './_isolated-db';

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  REJECTED_FREE_DEFAULT,
  NEEDS_OWNER_INPUT_SENTINEL,
  resolveSettings,
} from '../../src/lib/intelligence-resolver';

import {
  NEEDS_OWNER_INPUT,
  checkModelSovereignty,
} from '../../src/lib/model-selector';

import { run, closeDb } from '../../src/lib/db';
import type { ModelRegistryEntry } from '../../src/lib/model-registry-types';

// ── Fixtures ────────────────────────────────────────────────────────────────

const DEPT_ID = 'dept-test-sovereignty';
const AGENT_ID = 'agent-test-sovereignty';

/** A minimal ModelRegistryEntry for a valid Ollama Cloud model (box primary). */
function makeEntry(model_id: string, extra: Partial<ModelRegistryEntry> = {}): ModelRegistryEntry {
  return {
    id: 1,
    model_id,
    label: model_id,
    provider: model_id.startsWith('ollama/') ? 'ollama' : 'openrouter',
    family: null,
    context_window: 131072,
    input_cost_per_million: 0,
    output_cost_per_million: 0,
    pricing_model: 'free',
    pricing_source: 'auto',
    capabilities: ['text', 'streaming'],
    status: 'active',
    added_at: new Date().toISOString(),
    last_seen_at: new Date().toISOString(),
    raw_metadata: {},
    ...extra,
  };
}

// ── Test 1: REJECTED_FREE_DEFAULT is the literal 'openrouter/free' ────────
test('REJECTED_FREE_DEFAULT is "openrouter/free"', () => {
  assert.equal(REJECTED_FREE_DEFAULT, 'openrouter/free');
});

// ── Test 2: NEEDS_OWNER_INPUT_SENTINEL matches NEEDS_OWNER_INPUT ──────────
test('NEEDS_OWNER_INPUT_SENTINEL matches model-selector NEEDS_OWNER_INPUT', () => {
  assert.equal(NEEDS_OWNER_INPUT_SENTINEL, NEEDS_OWNER_INPUT);
  assert.equal(NEEDS_OWNER_INPUT_SENTINEL, 'needs_owner_input');
});

// ── Test 3: Empty config → resolveSettings returns needs_owner_input (FAIL LOUD) ──
test('resolveSettings returns needs_owner_input when no model is configured — never openrouter/free', () => {
  // No agent_settings rows, no model_registry entries, no task context.
  const settings = resolveSettings(AGENT_ID, DEPT_ID);

  // Must be needs_owner_input — never openrouter/free
  assert.equal(
    settings.model,
    NEEDS_OWNER_INPUT,
    `Expected needs_owner_input, got "${settings.model}" — resolver silently fell back to free model`,
  );
  assert.equal(settings.modelSource, 'needs_owner_input');

  // Explicitly not openrouter/free
  assert.notEqual(settings.model, 'openrouter/free',
    'resolveSettings MUST NOT return openrouter/free as a default');
});

// ── Test 4: Box primary model in agent_settings → resolveSettings returns it ──
test('resolveSettings resolves to the box-configured primary model from agent_settings', () => {
  const BOX_PRIMARY = 'ollama/kimi:cloud';

  // Insert a dept-level agent_settings row (simulates `agents.defaults.model.primary`
  // stored via the Command Center settings UI or repair-model-defaults.ts).
  run(
    `INSERT OR REPLACE INTO agent_settings (id, department_id, role_id, setting_type, value)
     VALUES (?, ?, NULL, 'model', ?)`,
    ['setting-box-primary-' + DEPT_ID, DEPT_ID, BOX_PRIMARY],
  );

  const settings = resolveSettings(AGENT_ID, DEPT_ID);

  assert.equal(
    settings.model,
    BOX_PRIMARY,
    `Expected box primary "${BOX_PRIMARY}", got "${settings.model}"`,
  );
  assert.equal(settings.modelSource, 'department_default');
  assert.notEqual(settings.model, 'openrouter/free');
  assert.notEqual(settings.model, NEEDS_OWNER_INPUT);

  // Clean up
  run(`DELETE FROM agent_settings WHERE id = ?`, ['setting-box-primary-' + DEPT_ID]);
});

// ── Test 5: agent_settings with openrouter/free is rejected → needs_owner_input ──
test('agent_settings value of openrouter/free is rejected — resolver continues to needs_owner_input', () => {
  // Insert a dept-level row with the rejected free default
  run(
    `INSERT OR REPLACE INTO agent_settings (id, department_id, role_id, setting_type, value)
     VALUES (?, ?, NULL, 'model', ?)`,
    ['setting-bad-free-' + DEPT_ID, DEPT_ID, 'openrouter/free'],
  );

  const settings = resolveSettings(AGENT_ID, DEPT_ID);

  assert.equal(
    settings.model,
    NEEDS_OWNER_INPUT,
    `openrouter/free in agent_settings should be rejected; got "${settings.model}"`,
  );
  assert.notEqual(settings.model, 'openrouter/free',
    'resolver MUST NOT return openrouter/free even when it is stored in agent_settings');

  // Clean up
  run(`DELETE FROM agent_settings WHERE id = ?`, ['setting-bad-free-' + DEPT_ID]);
});

// ── Test 6: Role-level override with valid model wins over dept default ─────
test('role-level agent_settings override wins over dept-level default', () => {
  const DEPT_DEFAULT = 'openrouter/deepseek/deepseek-chat';
  const ROLE_PRIMARY = 'ollama/deepseek-r1:cloud';

  run(
    `INSERT OR REPLACE INTO agent_settings (id, department_id, role_id, setting_type, value)
     VALUES (?, ?, NULL, 'model', ?)`,
    ['setting-dept-' + DEPT_ID, DEPT_ID, DEPT_DEFAULT],
  );
  run(
    `INSERT OR REPLACE INTO agent_settings (id, department_id, role_id, setting_type, value)
     VALUES (?, ?, ?, 'model', ?)`,
    ['setting-role-' + AGENT_ID, DEPT_ID, AGENT_ID, ROLE_PRIMARY],
  );

  const settings = resolveSettings(AGENT_ID, DEPT_ID);

  assert.equal(settings.model, ROLE_PRIMARY);
  assert.equal(settings.modelSource, 'role_override');
  assert.notEqual(settings.model, 'openrouter/free');

  // Clean up
  run(`DELETE FROM agent_settings WHERE id IN (?, ?)`, [
    'setting-dept-' + DEPT_ID,
    'setting-role-' + AGENT_ID,
  ]);
});

// ── Tests 7-13: checkModelSovereignty gate ────────────────────────────────

test('checkModelSovereignty: null model_id → null_model violation', () => {
  const result = checkModelSovereignty(null, []);
  assert.ok(result !== null, 'Expected a sovereignty violation for null model');
  assert.equal(result!.reason, 'null_model');
});

test('checkModelSovereignty: undefined model_id → null_model violation', () => {
  const result = checkModelSovereignty(undefined, []);
  assert.ok(result !== null, 'Expected a sovereignty violation for undefined model');
  assert.equal(result!.reason, 'null_model');
});

test('checkModelSovereignty: "openrouter/free" → free_default violation', () => {
  const result = checkModelSovereignty('openrouter/free', []);
  assert.ok(result !== null, 'Expected a sovereignty violation for openrouter/free');
  assert.equal(result!.reason, 'free_default');
  assert.equal(result!.model_id, 'openrouter/free');
});

test('checkModelSovereignty: model ending in :free → free_default violation', () => {
  const result = checkModelSovereignty('openrouter/meta-llama/llama-3.1-8b-instruct:free', []);
  assert.ok(result !== null, 'Expected a sovereignty violation for :free suffix');
  assert.equal(result!.reason, 'free_default');
});

test('checkModelSovereignty: "needs_owner_input" → needs_owner_input violation', () => {
  const result = checkModelSovereignty(NEEDS_OWNER_INPUT, []);
  assert.ok(result !== null, 'Expected a sovereignty violation for needs_owner_input');
  assert.equal(result!.reason, 'needs_owner_input');
});

test('checkModelSovereignty: Anthropic model id → forbidden_prefix violation', () => {
  const result = checkModelSovereignty('anthropic/claude-3-5-sonnet-20241022', []);
  assert.ok(result !== null, 'Expected a sovereignty violation for Anthropic model');
  assert.equal(result!.reason, 'forbidden_prefix');
});

test('checkModelSovereignty: valid box primary (ollama cloud) → passes (null = no violation)', () => {
  const BOX_PRIMARY = 'ollama/kimi:cloud';
  const inventory: ModelRegistryEntry[] = [makeEntry(BOX_PRIMARY, { pricing_model: 'per_token' })];
  const result = checkModelSovereignty(BOX_PRIMARY, inventory);
  assert.equal(result, null,
    `Expected no sovereignty violation for box primary "${BOX_PRIMARY}", got: ${JSON.stringify(result)}`);
});

test('checkModelSovereignty: valid OpenRouter OSS model → passes', () => {
  const MODEL = 'openrouter/deepseek/deepseek-chat';
  const inventory: ModelRegistryEntry[] = [makeEntry(MODEL, { pricing_model: 'per_token' })];
  const result = checkModelSovereignty(MODEL, inventory);
  assert.equal(result, null,
    `Expected no sovereignty violation for "${MODEL}", got: ${JSON.stringify(result)}`);
});

// ── Cleanup ────────────────────────────────────────────────────────────────
test('cleanup: close DB and remove the isolated temp database', () => {
  closeDb();
  // Remove the FILE only — never rmSync its parent directory. The isolated path
  // comes from './_isolated-db' (or an explicit DATABASE_PATH the runner set),
  // and its parent may be a shared temp root; recursively deleting that would
  // blow away far more than this suite owns.
  const dbPath = process.env.DATABASE_PATH ?? '';
  assert.ok(dbPath, 'DATABASE_PATH must be set by ./_isolated-db — otherwise this suite is on the LIVE DB');
  assert.ok(
    !dbPath.endsWith('mission-control.db'),
    `isolation failed: this suite is pointed at the live DB (${dbPath})`,
  );
  fs.rmSync(dbPath, { force: true });
  assert.ok(!fs.existsSync(dbPath), 'Temp DB should be removed after cleanup');
});
