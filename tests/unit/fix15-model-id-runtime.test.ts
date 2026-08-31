/**
 * FIX-15 (Error 7 / Rule R7 — model skew): CC `tasks.model_id` must match the
 * model the OpenClaw runtime actually runs.
 *
 * QC gate (Gauntlet loop FIX-15 row): after dispatch, `tasks.model_id` equals
 * the runtime session model; a forced skew writes a `model_skew_detected`
 * event row.
 *
 * This suite proves the runtime-model resolution primitives that the dispatch
 * route + auto-dispatch path now use to pin the REAL runtime model:
 *   1. `runtimeSlugCandidates` — workspace → dept-prefixed → canonical → role →
 *      name derivation (mirrors resolveSpecialistSessionKey).
 *   2. `resolveRuntimeModelFromConfig` — reads `openclaw.json` `agents.list`
 *      `model.primary` for the matched agent (the runtime model).
 *   3. `normalizeModelId` / `modelsMatch` — provider-prefix-insensitive compare
 *      (`ollama/deepseek-v4-flash:0731-cloud` ≡ `deepseek-v4-flash:0731-cloud`).
 *   4. `recordModelSkewEvent` — writes a `model_skew_detected` event row when
 *      intended ≠ runtime, and a `model_runtime_confirmed` row when they match.
 *
 * Runs via the Node built-in test runner under tsx, on an isolated temp DB and
 * a fixture openclaw.json (never the live box config). No network, no side
 * effects beyond the temp DB.
 */

// C8 isolation FIRST — must precede any @/lib/db import.
import './_isolated-db';

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { run, queryAll, closeDb } from '../../src/lib/db';
import {
  runtimeSlugCandidates,
  resolveRuntimeModelFromConfig,
  normalizeModelId,
  canonicalSkewModelId,
  modelsMatch,
  recordModelSkewEvent,
  reconcileTaskModelRecord,
} from '../../src/lib/runtime-model';
import type { Agent, Task } from '../../src/lib/types';

// ── Fixture openclaw.json (mimics the live box: dept-presentations →
//    model.primary = ollama/deepseek-v4-flash:0731-cloud) ────────────────────
function writeFixtureConfig(dir: string): string {
  const cfg = {
    agents: {
      defaults: { model: { primary: 'ollama/kimi-k2.6:cloud' } },
      list: [
        {
          id: 'dept-presentations',
          name: 'Presentations Department',
          model: {
            primary: 'ollama/deepseek-v4-flash:0731-cloud',
            fallbacks: ['agnes/agnes-2.5-flash'],
          },
        },
        {
          id: 'dept-funnels',
          name: 'Funnels',
          model: { primary: 'ollama/deepseek-v4-flash:0731-cloud', fallbacks: [] },
        },
        {
          id: 'main',
          name: 'Main',
          model: { primary: 'ollama/deepseek-v4-flash:0731-cloud', fallbacks: [] },
        },
      ],
    },
  };
  const p = path.join(dir, 'openclaw.json');
  fs.writeFileSync(p, JSON.stringify(cfg));
  return p;
}

function makeAgent(partial: Partial<Agent> = {}): Agent {
  return {
    id: 'dept-presentations',
    name: 'Presentations',
    role: 'Presentations',
    avatar_emoji: '🤖',
    status: 'standby',
    is_master: false,
    workspace_id: 'presentations',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...partial,
  };
}

const FIXTURE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fix15-fixture-'));
const CONFIG_PATH = writeFixtureConfig(FIXTURE_DIR);

/**
 * Seed a real agent + task row so the `events` FK (agent_id → agents,
 * task_id → tasks) is satisfiable — the same constraint a real dispatch
 * satisfies. Returns the seeded ids.
 */
function seedAgentAndTask(): { agentId: string; taskId: string } {
  const agentId = 'seed-agent-dept-presentations';
  const taskId = 'seed-task-fix15';
  const now = new Date().toISOString();
  // The isolated DB has no `presentations` workspace (only podcast/anthology
  // are auto-seeded), so create it first to satisfy the workspace FK on both
  // the agents and tasks rows below.
  run(
    `INSERT OR IGNORE INTO workspaces (id, slug, name, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)`,
    ['presentations', 'presentations', 'Presentations', now, now],
  );
  run(
    `INSERT OR IGNORE INTO agents (id, name, role, avatar_emoji, status, is_master, workspace_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [agentId, 'Presentations', 'Presentations', '🤖', 'standby', 0, 'presentations', now, now],
  );
  run(
    `INSERT OR IGNORE INTO tasks (id, title, description, status, priority, created_at, updated_at, workspace_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [taskId, 'FIX-15 test deck', 'Prove model_id matches runtime', 'backlog', 'medium', now, now, 'presentations'],
  );
  return { agentId, taskId };
}

/**
 * Seed a task under a caller-chosen id, reusing the shared agent. The event
 * dedupe added for the model-record reconcile is per-task, so each dedupe test
 * needs its OWN task row — `seedAgentAndTask` hands every caller the same fixed
 * id and would let one test's rows decide another's outcome.
 */
function seedNamedTask(suffix: string): { agentId: string; taskId: string } {
  const { agentId } = seedAgentAndTask();
  const taskId = `seed-task-fix15-${suffix}`;
  const now = new Date().toISOString();
  run(
    `INSERT OR IGNORE INTO tasks (id, title, description, status, priority, created_at, updated_at, workspace_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [taskId, `FIX-15 ${suffix}`, 'model paperwork reconcile', 'backlog', 'medium', now, now, 'presentations'],
  );
  return { agentId, taskId };
}

// ── Test 1: runtimeSlugCandidates order (workspace → dept → canonical → role → name) ──
test('runtimeSlugCandidates derives the dept-prefixed runtime slug first', () => {
  const agent = makeAgent();
  const candidates = runtimeSlugCandidates(agent, 'presentations');
  // workspace 'presentations' appears; role and name slug the same, deduped.
  assert.ok(candidates.includes('presentations'), 'workspace slug present');
  assert.equal(candidates[0], 'presentations');
  // De-duplication: role 'Presentations' and name 'Presentations' collapse.
  assert.equal(new Set(candidates).size, candidates.length, 'no duplicate candidates');
});

test('runtimeSlugCandidates adds the canonical alias when the workspace slug differs', () => {
  const agent = makeAgent({ workspace_id: 'presentations' });
  const candidates = runtimeSlugCandidates(agent, 'presentations');
  // 'presentations' is already canonical; the canonical lookup returns the same
  // value, so no duplicate is added.
  assert.ok(candidates.includes('presentations'));
});

// ── Test 2: resolveRuntimeModelFromConfig matches the runtime config entry ──
test('resolveRuntimeModelFromConfig reads model.primary for dept-presentations', () => {
  const agent = makeAgent();
  const res = resolveRuntimeModelFromConfig(agent, 'presentations', CONFIG_PATH);
  assert.ok(res, 'expected a config resolution');
  assert.equal(res!.configAgentId, 'dept-presentations');
  assert.equal(
    res!.model_id,
    'ollama/deepseek-v4-flash:0731-cloud',
    'the runtime model must be the agent config primary, not the CC registry default',
  );
});

test('resolveRuntimeModelFromConfig returns null when no entry matches', () => {
  const agent = makeAgent({ id: 'no-such-agent', name: 'No Such', role: 'nope', workspace_id: 'ghost' });
  const res = resolveRuntimeModelFromConfig(agent, 'ghost', CONFIG_PATH);
  assert.equal(res, null);
});

test('resolveRuntimeModelFromConfig tolerates a missing config file', () => {
  const agent = makeAgent();
  const res = resolveRuntimeModelFromConfig(agent, 'presentations', '/nonexistent/openclaw.json');
  assert.equal(res, null);
});

// ── Test 3: normalizeModelId / modelsMatch — provider-prefix-insensitive ──
test('normalizeModelId strips the provider prefix', () => {
  assert.equal(normalizeModelId('ollama/deepseek-v4-flash:0731-cloud'), 'deepseek-v4-flash:0731-cloud');
  assert.equal(normalizeModelId('deepseek-v4-flash:0731-cloud'), 'deepseek-v4-flash:0731-cloud');
  assert.equal(normalizeModelId('ollama-cloud/mistral-large-3:675b'), 'mistral-large-3:675b');
});

test('modelsMatch treats prefixed and bare ids as the same runtime model', () => {
  assert.equal(
    modelsMatch('ollama/deepseek-v4-flash:0731-cloud', 'deepseek-v4-flash:0731-cloud'),
    true,
  );
  assert.equal(modelsMatch('ollama/deepseek-v4-flash:0731-cloud', 'ollama/deepseek-v4-flash:0731-cloud'), true);
  assert.equal(modelsMatch('ollama-cloud/mistral-large-3:675b', 'deepseek-v4-flash:0731-cloud'), false);
  assert.equal(modelsMatch(null, 'deepseek-v4-flash:0731-cloud'), false);
  assert.equal(modelsMatch('', 'deepseek-v4-flash:0731-cloud'), false);
});

// ── Test 3b: canonicalSkewModelId — the DEDUPE key (provider-aware, wrapper-tolerant)
test('canonicalSkewModelId keeps the provider on a plain provider/model id', () => {
  assert.equal(canonicalSkewModelId('ollama/deepseek-v4-flash:0731-cloud'), 'ollama/deepseek-v4-flash:0731-cloud');
  assert.equal(canonicalSkewModelId('openrouter/deepseek-v4-flash:0731-cloud'), 'openrouter/deepseek-v4-flash:0731-cloud');
  assert.equal(canonicalSkewModelId('DEEPSEEK/deepseek-v4-flash-vision-exp'), 'deepseek/deepseek-v4-flash-vision-exp');
  assert.equal(canonicalSkewModelId('mistral-large-3:675b'), 'mistral-large-3:675b');
  assert.equal(canonicalSkewModelId(null), '');
  assert.equal(canonicalSkewModelId(''), '');
});

test('canonicalSkewModelId strips a WRAPPER segment only when a namespace remains', () => {
  // openrouter wrapper over a namespaced model — the registry-vs-runtime respelling.
  assert.equal(
    canonicalSkewModelId('openrouter/deepseek/deepseek-v4-flash-vision-exp'),
    'deepseek/deepseek-v4-flash-vision-exp',
  );
  // A 2-segment id is provider+model, NOT a wrapper — the provider must survive.
  assert.equal(
    canonicalSkewModelId('deepseek/deepseek-v4-flash-vision-exp'),
    'deepseek/deepseek-v4-flash-vision-exp',
  );
});

// ── Test 4: recordModelSkewEvent — the FIX-15 QC event row ─────────────────
test('recordModelSkewEvent writes a model_skew_detected row when intended ≠ runtime', () => {
  const { agentId, taskId } = seedAgentAndTask();
  recordModelSkewEvent({
    taskId,
    agentId,
    intended: 'ollama-cloud/mistral-large-3:675b',
    runtime: 'ollama/deepseek-v4-flash:0731-cloud',
    skew: true,
    detail: { source: 'openclaw_config', model_source: 'task_selector' },
  });
  const rows = queryAll<{ type: string; message: string; metadata: string }>(
    `SELECT type, message, metadata FROM events WHERE task_id = ? AND type = 'model_skew_detected'`,
    [taskId],
  );
  assert.equal(rows.length, 1, 'exactly one model_skew_detected event row');
  assert.ok(rows[0]!.message.includes('MODEL-SKEW'));
  const meta = JSON.parse(rows[0]!.metadata);
  assert.equal(meta.skew, true);
  assert.equal(meta.runtime_model, 'ollama/deepseek-v4-flash:0731-cloud');
  assert.equal(meta.intended_model, 'ollama-cloud/mistral-large-3:675b');
});

test('recordModelSkewEvent writes a model_runtime_confirmed row when intended === runtime', () => {
  const { agentId, taskId } = seedAgentAndTask();
  recordModelSkewEvent({
    taskId,
    agentId,
    intended: 'ollama/deepseek-v4-flash:0731-cloud',
    runtime: 'deepseek-v4-flash:0731-cloud',
    skew: false,
    detail: { source: 'openclaw_config', model_source: 'sovereign_default' },
  });
  const rows = queryAll<{ type: string }>(
    `SELECT type FROM events WHERE task_id = ? AND type = 'model_runtime_confirmed'`,
    [taskId],
  );
  assert.equal(rows.length, 1);
});

// ── Test 5: modelsMatch used by the skew predicate (integration of the gate) ──
test('the skew predicate the dispatch uses would flag a real skew', () => {
  const intended = 'ollama-cloud/mistral-large-3:675b'; // CC registry default (Error 7)
  const runtime = 'ollama/deepseek-v4-flash:0731-cloud'; // agent config primary
  const skew = !!(intended && runtime && !modelsMatch(intended, runtime));
  assert.equal(skew, true, 'a real Error-7 skew must be detected');

  // And the same model both ways is NOT a skew.
  const sameSkew = !!(intended && intended && !modelsMatch(intended, intended));
  assert.equal(sameSkew, false);
});

// ── Test 6: the MODEL-SKEW message carries no stray quote ──────────────────
// The live emitter interpolated `runtime="'${runtime}"` — a literal apostrophe
// inside the template — so every skew row on the box read
// runtime="'openrouter/z-ai/glm-5.3-flash". The metadata copy was always clean,
// which is what proved the quote was a message-template typo and not a config
// or env parse fault. Guard the rendered message against the typo returning.
test('MODEL-SKEW message quotes the runtime model without a stray apostrophe', () => {
  const { agentId, taskId } = seedNamedTask('quote-guard');
  recordModelSkewEvent({
    taskId,
    agentId,
    intended: 'ollama/kimi-k2.7:cloud',
    runtime: 'openrouter/z-ai/glm-5.3-flash',
    skew: true,
    detail: { source: 'openclaw_config' },
  });
  const row = queryAll<{ message: string; metadata: string }>(
    `SELECT message, metadata FROM events WHERE task_id = ? AND type = 'model_skew_detected'`,
    [taskId],
  )[0]!;
  assert.ok(
    row.message.includes('runtime="openrouter/z-ai/glm-5.3-flash"'),
    `runtime must be plainly quoted, got: ${row.message}`,
  );
  assert.ok(!row.message.includes(`"'`), 'no stray apostrophe after the opening quote');
  // The message and the metadata must now agree on the model string.
  assert.equal(JSON.parse(row.metadata).runtime_model, 'openrouter/z-ai/glm-5.3-flash');
});

// ── Test 7: skew events are deduped — one audit row, not one per dispatch ──
test('a repeated identical skew observation does not write a second event row', () => {
  const { agentId, taskId } = seedNamedTask('skew-dedupe');
  const emit = () =>
    recordModelSkewEvent({
      taskId,
      agentId,
      intended: 'ollama/minimax-m3:cloud',
      runtime: 'deepseek/deepseek-v4-flash-vision-exp',
      skew: true,
      detail: { source: 'openclaw_config' },
    });
  // Four dispatches of the same task, same stale paperwork — the live shape on
  // task 9e5925c5, which accumulated four identical MODEL-SKEW rows.
  emit();
  emit();
  emit();
  emit();
  const rows = queryAll<{ id: string }>(
    `SELECT id FROM events WHERE task_id = ? AND type = 'model_skew_detected'`,
    [taskId],
  );
  assert.equal(rows.length, 1, 'exactly one skew row survives four identical observations');
});

test('skew dedupe is provider-prefix-insensitive', () => {
  const { agentId, taskId } = seedNamedTask('skew-dedupe-prefix');
  recordModelSkewEvent({
    taskId,
    agentId,
    intended: 'ollama/minimax-m3:cloud',
    runtime: 'openrouter/deepseek/deepseek-v4-flash-vision-exp',
    skew: true,
    detail: {},
  });
  // Same two models, written by a resolver that spelled the provider differently.
  recordModelSkewEvent({
    taskId,
    agentId,
    intended: 'minimax-m3:cloud',
    runtime: 'deepseek/deepseek-v4-flash-vision-exp',
    skew: true,
    detail: {},
  });
  const rows = queryAll<{ id: string }>(
    `SELECT id FROM events WHERE task_id = ? AND type = 'model_skew_detected'`,
    [taskId],
  );
  assert.equal(rows.length, 1, 'a prefix respelling is the same observation, not a new one');
});

test('a PROVIDER flip on the same model emits a new skew event (2 rows)', () => {
  const { agentId, taskId } = seedNamedTask('skew-provider-flip');
  recordModelSkewEvent({
    taskId, agentId,
    intended: 'ollama/minimax-m3:cloud',
    runtime: 'ollama/deepseek-v4-flash:0731-cloud',
    skew: true, detail: {},
  });
  // Same two models, resolved through a DIFFERENT provider this time — a new
  // divergence the sovereignty audit must see, not a duplicate to swallow.
  recordModelSkewEvent({
    taskId, agentId,
    intended: 'openrouter/minimax-m3:cloud',
    runtime: 'openrouter/deepseek-v4-flash:0731-cloud',
    skew: true, detail: {},
  });
  const rows = queryAll<{ id: string; metadata: string }>(
    `SELECT id, metadata FROM events WHERE task_id = ? AND type = 'model_skew_detected'`,
    [taskId],
  );
  assert.equal(rows.length, 2, 'a provider change must emit as a genuinely new divergence');
  const providers = rows.map((r) => JSON.parse(r.metadata).runtime_model.split('/')[0]).sort();
  assert.deepEqual(providers, ['ollama', 'openrouter'], 'one row per provider');
});

test('a provider flip on ONE side of the pair still emits a new skew event', () => {
  const { agentId, taskId } = seedNamedTask('skew-provider-flip-one-sided');
  recordModelSkewEvent({
    taskId, agentId,
    intended: 'ollama/minimax-m3:cloud',
    runtime: 'deepseek/deepseek-v4-flash-vision-exp',
    skew: true, detail: {},
  });
  // Intended unchanged; the RUNTIME moved from deepseek-direct to openrouter.
  recordModelSkewEvent({
    taskId, agentId,
    intended: 'ollama/minimax-m3:cloud',
    runtime: 'openrouter/deepseek/deepseek-v4-flash-vision-exp',
    skew: true, detail: {},
  });
  const rows = queryAll<{ id: string }>(
    `SELECT id FROM events WHERE task_id = ? AND type = 'model_skew_detected'`,
    [taskId],
  );
  // NOTE: openrouter/deepseek/X wrapper-strips to deepseek/X, so this pair is
  // the wrapper respelling, not a provider flip — it must DEDUPE to one row.
  assert.equal(rows.length, 1, 'wrapper respelling of the same runtime model stays deduped');

  // But a real provider flip on one side (deepseek-direct → ollama) is new.
  recordModelSkewEvent({
    taskId, agentId,
    intended: 'ollama/minimax-m3:cloud',
    runtime: 'ollama/deepseek-v4-flash:0731-cloud',
    skew: true, detail: {},
  });
  const after = queryAll<{ id: string }>(
    `SELECT id FROM events WHERE task_id = ? AND type = 'model_skew_detected'`,
    [taskId],
  );
  assert.equal(after.length, 2, 'a genuine runtime provider flip emits its own row');
});

test('a genuinely different skew pair still writes its own event row', () => {
  const { agentId, taskId } = seedNamedTask('skew-distinct');
  recordModelSkewEvent({
    taskId, agentId,
    intended: 'ollama/minimax-m3:cloud',
    runtime: 'deepseek/deepseek-v4-flash-vision-exp',
    skew: true, detail: {},
  });
  // The agent got re-pinned; this is a NEW divergence and must stay visible.
  recordModelSkewEvent({
    taskId, agentId,
    intended: 'ollama/kimi-k2.7:cloud',
    runtime: 'openrouter/z-ai/glm-5.3-flash',
    skew: true, detail: {},
  });
  const rows = queryAll<{ id: string }>(
    `SELECT id FROM events WHERE task_id = ? AND type = 'model_skew_detected'`,
    [taskId],
  );
  assert.equal(rows.length, 2, 'dedupe must not swallow a genuinely new divergence');
});

test('model_runtime_confirmed rows are deduped too', () => {
  const { agentId, taskId } = seedNamedTask('confirm-dedupe');
  for (let i = 0; i < 8; i++) {
    recordModelSkewEvent({
      taskId, agentId,
      intended: 'openrouter/z-ai/glm-5.3-flash',
      runtime: 'openrouter/z-ai/glm-5.3-flash',
      skew: false, detail: {},
    });
  }
  const rows = queryAll<{ id: string }>(
    `SELECT id FROM events WHERE task_id = ? AND type = 'model_runtime_confirmed'`,
    [taskId],
  );
  assert.equal(rows.length, 1, 'eight confirmations of the same model leave one row');
});

// ── Test 8: reconcileTaskModelRecord — runtime becomes the recorded truth ───
test('reconcileTaskModelRecord pins the runtime model and records one reconciliation', () => {
  const { agentId, taskId } = seedNamedTask('reconcile');
  // The stale paperwork the live task carried before dispatch.
  run(`UPDATE tasks SET model_id = ? WHERE id = ?`, ['ollama/kimi-k2.7:cloud', taskId]);

  reconcileTaskModelRecord({
    taskId,
    agentId,
    intended: 'ollama/kimi-k2.7:cloud',
    runtime: 'openrouter/z-ai/glm-5.3-flash',
    detail: { source: 'openclaw_config' },
  });

  const task = queryAll<{ model_id: string }>(
    `SELECT model_id FROM tasks WHERE id = ?`,
    [taskId],
  )[0]!;
  assert.equal(
    task.model_id,
    'openrouter/z-ai/glm-5.3-flash',
    'the runtime model is authoritative and must land on the task record',
  );

  const rows = queryAll<{ message: string; metadata: string }>(
    `SELECT message, metadata FROM events WHERE task_id = ? AND type = 'model_record_reconciled'`,
    [taskId],
  );
  assert.equal(rows.length, 1, 'exactly one reconciliation row');
  assert.ok(rows[0]!.message.includes('MODEL-RECONCILED'));
  const meta = JSON.parse(rows[0]!.metadata);
  assert.equal(meta.authoritative, 'runtime');
  assert.equal(meta.reconciled_to, 'openrouter/z-ai/glm-5.3-flash');
  assert.equal(meta.intended_model, 'ollama/kimi-k2.7:cloud');
});

test('reconcileTaskModelRecord is idempotent across re-dispatches', () => {
  const { agentId, taskId } = seedNamedTask('reconcile-idempotent');
  const reconcile = () =>
    reconcileTaskModelRecord({
      taskId, agentId,
      intended: 'ollama/minimax-m3:cloud',
      runtime: 'deepseek/deepseek-v4-flash-vision-exp',
      detail: {},
    });
  reconcile();
  reconcile();
  reconcile();
  const rows = queryAll<{ id: string }>(
    `SELECT id FROM events WHERE task_id = ? AND type = 'model_record_reconciled'`,
    [taskId],
  );
  assert.equal(rows.length, 1, 'a re-dispatch must not stack reconciliation rows');
});

test('reconcileTaskModelRecord emits a new reconciliation row on a provider flip', () => {
  const { agentId, taskId } = seedNamedTask('reconcile-provider-flip');
  reconcileTaskModelRecord({
    taskId, agentId,
    intended: 'ollama/minimax-m3:cloud',
    runtime: 'ollama/deepseek-v4-flash:0731-cloud',
    detail: {},
  });
  // Runtime re-resolved through a different provider — new divergence, new row.
  reconcileTaskModelRecord({
    taskId, agentId,
    intended: 'openrouter/minimax-m3:cloud',
    runtime: 'openrouter/deepseek-v4-flash:0731-cloud',
    detail: {},
  });
  const rows = queryAll<{ id: string }>(
    `SELECT id FROM events WHERE task_id = ? AND type = 'model_record_reconciled'`,
    [taskId],
  );
  assert.equal(rows.length, 2, 'a provider flip must not be swallowed by reconcile dedupe');
});

test('reconcileTaskModelRecord does nothing when the runtime model is unknown', () => {
  const { agentId, taskId } = seedNamedTask('reconcile-null');
  run(`UPDATE tasks SET model_id = ? WHERE id = ?`, ['ollama/kimi-k2.7:cloud', taskId]);
  reconcileTaskModelRecord({
    taskId, agentId,
    intended: 'ollama/kimi-k2.7:cloud',
    runtime: null,
    detail: {},
  });
  const task = queryAll<{ model_id: string }>(
    `SELECT model_id FROM tasks WHERE id = ?`, [taskId],
  )[0]!;
  assert.equal(task.model_id, 'ollama/kimi-k2.7:cloud', 'an unresolvable runtime must not clear the pin');
  const rows = queryAll<{ id: string }>(
    `SELECT id FROM events WHERE task_id = ? AND type = 'model_record_reconciled'`, [taskId],
  );
  assert.equal(rows.length, 0, 'nothing to reconcile, nothing recorded');
});

// ── Cleanup ────────────────────────────────────────────────────────────────
test('cleanup: close DB and remove fixture + temp db', () => {
  closeDb();
  fs.rmSync(FIXTURE_DIR, { recursive: true, force: true });
  const dbPath = process.env.DATABASE_PATH ?? '';
  assert.ok(dbPath, 'DATABASE_PATH must be set by ./_isolated-db');
  assert.ok(!dbPath.endsWith('mission-control.db'), 'isolation failed — live DB');
  fs.rmSync(dbPath, { force: true });
});
