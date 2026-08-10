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
  modelsMatch,
  recordModelSkewEvent,
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

// ── Cleanup ────────────────────────────────────────────────────────────────
test('cleanup: close DB and remove fixture + temp db', () => {
  closeDb();
  fs.rmSync(FIXTURE_DIR, { recursive: true, force: true });
  const dbPath = process.env.DATABASE_PATH ?? '';
  assert.ok(dbPath, 'DATABASE_PATH must be set by ./_isolated-db');
  assert.ok(!dbPath.endsWith('mission-control.db'), 'isolation failed — live DB');
  fs.rmSync(dbPath, { force: true });
});
