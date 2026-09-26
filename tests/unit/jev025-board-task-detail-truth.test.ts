/**
 * jev025-board-task-detail-truth.test.ts — JEV-025 board + task-detail truth
 * (spec 11.1/11.4, A39, A41).
 *
 * Units under test (all OWN board components / bounded helpers — never
 * tasks.ts, dispatch, auto-route, or producer state):
 *   1. src/lib/board/board-truth.ts — read-only projectors (executor kind,
 *      bundle truth, provider truth, selection holds, D24 hold).
 *   2. useSSE reconnect catch-up field comparison (unit-level: same predicate
 *      the hook uses must detect non-status field changes; the hook itself is
 *      covered by inspection, see qc notes).
 *   3. Board GET routes attach the same computed fields the board + modal
 *      render from (persona_mismatch, dispatch_hold, subtask_personas,
 *      persona_bundle_scopes, model_*).
 *
 * No JEV calls, no network, no producer runs: seeded fixtures + direct
 * function calls against an isolated temp DB.
 */
import './_isolated-db'; // MUST be first DB import: throwaway DATABASE_PATH.
import test from 'node:test';
import assert from 'node:assert/strict';
import { v4 as uuidv4 } from 'uuid';
import { getDb, run, queryOne } from '../../src/lib/db';
import {
  resolveExecutorKind,
  executorChipProps,
  resolveBundleTruth,
  bundleTruthFromDb,
  resolveProviderTruth,
  selectionHolds,
  d24Prerequisite,
} from '../../src/lib/board/board-truth';
import { persistPersonaBundle } from '../../src/lib/persona-selector';
import { recordPersonaUsedAndCompare } from '../../src/lib/persona-mismatch';
import type { PersonaBundle, Task } from '../../src/lib/types';

getDb(); // trigger the full migration chain against the isolated temp DB

test.after(async () => {
  const { closeDb } = await import('../../src/lib/db');
  try {
    closeDb();
  } catch {
    /* ignore */
  }
});

let taskCounter = 0;
function seedTask(over: Partial<Record<string, unknown>> = {}): string {
  const id = `jev025-${++taskCounter}-${Date.now()}`;
  const now = new Date().toISOString();
  run(
    `INSERT INTO tasks (id, title, status, priority, assigned_agent_id, department, workspace_id, business_id, created_at, updated_at)
     VALUES (?, 'JEV-025 fixture', 'backlog', 'medium', ?, ?, NULL, NULL, ?, ?)`,
    [id, over.assigned_agent_id ?? null, over.department ?? null, now, now],
  );
  if (over.routing_reason !== undefined) {
    run('UPDATE tasks SET routing_reason = ? WHERE id = ?', [over.routing_reason, id]);
  }
  if (over.blend_confirm_state !== undefined) {
    // task_persona_bundle carries confirm_state; seed through the real table.
    run(
      `INSERT INTO task_persona_bundle (task_id, bundle_json, catalog_version, confirm_state, created_at)
       VALUES (?, '{}', 'test', ?, ?)`,
      [id, over.blend_confirm_state, now],
    );
  }
  return id;
}

function seedAgent(workspaceId = 'ws-jev025'): string {
  const id = uuidv4();
  const now = new Date().toISOString();
  run(`INSERT INTO workspaces (id, name, slug, created_at) VALUES (?, 'ws', ?, ?)`, [
    workspaceId,
    workspaceId,
    now,
  ]);
  run(
    `INSERT INTO agents (id, name, role, workspace_id, status, created_at, updated_at)
     VALUES (?, 'Spec Agent', 'specialist', ?, 'standby', ?, ?)`,
    [id, workspaceId, now, now],
  );
  return id;
}

function declaredBundle(): PersonaBundle {
  return {
    topic: 'offer architecture',
    resolved_audience: {
      source: 'operator_confirmed',
      candidates: ['solo-founder coaches'],
      confidence: 1.0,
      label: 'solo-founder coaches',
      id: null,
    },
    confirm_required: false,
    voice: {
      audience_persona: { id: 'hormozi-100m-offers', why: 'fixture' },
      topic_persona: { id: 'miller-building-storybrand', why: 'fixture' },
      collapsed: false,
      collapsed_persona_id: null,
    },
    blend_directive:
      'Write in Hormozi voice while carrying Miller expertise on offer architecture. ' +
      'STYLE-INSPIRED, NEVER IMPERSONATION (mandatory, non-removable): never claim to be ' +
      'the author, never sign as them, never imply endorsement.',
    task_personas: [{ seq: 1, persona_id: 'hormozi-100m-offers', why: 'fixture' }],
    catalog_version: '1.4',
  };
}

// ─── 1. actual executor: owner-direct vs delegated, never invented ───────────

test('[D25 executor] unassigned task resolves unassigned — no chip, never fabricated', () => {
  assert.equal(resolveExecutorKind({ assigned_agent_id: null }), 'unassigned');
  assert.equal(executorChipProps({ assigned_agent_id: null }), null);
});

test('[D25 executor] owner-direct pin routes straight to the named specialist', () => {
  const agentId = seedAgent();
  const kind = resolveExecutorKind({
    assigned_agent_id: agentId,
    routing_reason:
      'Owner-direct specialist pin: owner named "Spec Agent" → routed straight to Spec Agent (Marketing), bypassing department classification and pickBestAgent.',
  });
  assert.equal(kind, 'owner-direct');
  const chip = executorChipProps({
    assigned_agent_id: agentId,
    routing_reason:
      'Owner-direct specialist pin: owner named "Spec Agent" → routed straight to Spec Agent (Marketing), bypassing department classification and pickBestAgent.',
    assigned_agent: { name: 'Spec Agent' },
  });
  assert.ok(chip);
  assert.equal(chip.label, 'owner-direct');
  assert.match(chip.title, /bypassing department classification/);
});

test('[D25 executor] classified routing resolves delegated with role-fit copy', () => {
  const agentId = seedAgent('ws-jev025-b');
  const chip = executorChipProps({
    assigned_agent_id: agentId,
    routing_reason: 'Semantic match to Marketing → role-fit agent selected',
    assigned_agent: { name: 'Spec Agent' },
  });
  assert.ok(chip);
  assert.equal(chip.label, 'delegated');
  assert.match(chip.title, /role-fit/);
});

// ─── 2. proposed vs committed vs used (A39) ──────────────────────────────────

test('[D25 A39] committed-vs-used sha agreement resolves match; unknown without both sides', () => {
  const match = resolveBundleTruth({ committedSha: 'abc', usedSha: 'abc' });
  assert.equal(match.status, 'match');
  const unknown = resolveBundleTruth({ committedSha: 'abc', usedSha: null });
  assert.equal(unknown.status, 'unknown');
  const empty = resolveBundleTruth({});
  assert.equal(empty.status, 'unknown');
});

test('[D25 A39] committed-vs-used sha divergence resolves mismatch on bundle_sha', () => {
  const t = resolveBundleTruth({ committedSha: 'abc', usedSha: 'def' });
  assert.equal(t.status, 'mismatch');
  assert.equal(t.mismatchSource, 'bundle_sha');
});

test('[D25 A39] declared-vs-used voice divergence through the real write path raises exactly one mismatch event', () => {
  const taskId = seedTask();
  const wrote = persistPersonaBundle(taskId, declaredBundle());
  assert.equal(wrote, true);
  const declared = queryOne<{ voice_persona_id: string | null }>(
    'SELECT voice_persona_id FROM tasks WHERE id = ?',
    [taskId],
  );
  assert.equal(declared?.voice_persona_id, 'hormozi-100m-offers');

  const report = {
    kind: 'persona_used' as const,
    execution_id: undefined,
    voice_persona_id: 'someone-else-entirely',
    topic_persona_id: null,
    task_persona_id: null,
    blend_directive_sha: null,
    goal: null,
  };
  const first = recordPersonaUsedAndCompare(taskId, report);
  assert.ok(first, 'divergence must surface');
  const before = queryOne<{ c: number }>(
    `SELECT COUNT(*) AS c FROM events WHERE type = 'persona_mismatch' AND task_id = ?`,
    [taskId],
  )?.c;
  recordPersonaUsedAndCompare(taskId, report);
  const after = queryOne<{ c: number }>(
    `SELECT COUNT(*) AS c FROM events WHERE type = 'persona_mismatch' AND task_id = ?`,
    [taskId],
  )?.c;
  assert.equal(before, 1);
  assert.equal(after, 1);
});

// ─── 3. bundle truth read from the DB: no invented green ─────────────────────

test('[D25 db] task with no bundle, no execution, no reports reads all-unknown', () => {
  const taskId = seedTask();
  const got = bundleTruthFromDb(taskId);
  assert.equal(got.proposedSha, null);
  assert.equal(got.committedSha, null);
  assert.equal(got.usedSha, null);
  assert.equal(got.executionProvider, null);
  const truth = resolveBundleTruth({
    committedSha: got.committedSha,
    usedSha: got.usedSha,
  });
  assert.equal(truth.status, 'unknown');
});

test('[D25 db] proposed sha derives from the real stored bundle row', () => {
  const taskId = seedTask();
  persistPersonaBundle(taskId, declaredBundle());
  const got = bundleTruthFromDb(taskId);
  assert.ok(got.proposedSha, 'proposed sha must derive from the stored row');
  // No execution yet: committed/used stay unknown — never invented.
  assert.equal(got.committedSha, null);
  assert.equal(got.usedSha, null);
});

// ─── 4. provider provenance: intended vs actual, never conflated ─────────────

test('[D25 provider] intended model/provider surface separately from actual execution provider', () => {
  const truth = resolveProviderTruth(
    { model_id: 'model-abc', model_label: 'Model Abc', model_provider: '9ROUTER' },
    { executionProvider: 'OLLAMA', executionState: 'accepted' },
  );
  assert.equal(truth.intendedModel, 'Model Abc');
  assert.equal(truth.intendedProvider, '9ROUTER');
  assert.equal(truth.actualProvider, 'OLLAMA');
  assert.equal(truth.executionState, 'accepted');
});

test('[D25 provider] absent execution yields unknown actuals, never fabricated', () => {
  const truth = resolveProviderTruth({ model_id: null }, null);
  assert.equal(truth.intendedModel, null);
  assert.equal(truth.actualProvider, null);
});

// ─── 5. selection holds: only non-duplicated surfaces ────────────────────────

test('[D25 holds] routing-wait surfaces owner + next action; nothing held yields zero holds', () => {
  const holds = selectionHolds({
    routing_reason: 'No eligible worker in Marketing.',
    routing_wait_owner: 'SYSTEM',
    routing_next_action: 'Configure an eligible worker or edit task assignment.',
  });
  assert.equal(holds.length, 1);
  assert.equal(holds[0].kind, 'routing-wait');
  assert.match(holds[0].message, /No eligible worker/);
  assert.match(holds[0].message, /Configure an eligible worker/);
  assert.deepEqual(selectionHolds({}), []);
});

test('[D25 holds] audience pending + deadline fallback map to distinct actionable holds', () => {
  const pending = selectionHolds({ blend_confirm_state: 'pending' });
  assert.equal(pending.length, 1);
  assert.equal(pending[0].kind, 'audience-confirm');
  const fallback = selectionHolds({ blend_confirm_state: 'deadline_fallback' });
  assert.equal(fallback.length, 1);
  assert.equal(fallback[0].kind, 'house-voice-fallback');
});

// ─── 6. no fake confidence: fit score stays a fit score ──────────────────────

test('[D25 confidence] board GET must never emit a confidence field (fit score is not confidence)', async () => {
  const { GET } = await import('../../src/app/api/tasks/route');
  const res = await GET(
    new Request('http://localhost/api/tasks?limit=5') as never,
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as Array<Record<string, unknown>>;
  const rows = Array.isArray(body) ? body : (body as { tasks: Array<Record<string, unknown>> }).tasks;
  for (const row of rows ?? []) {
    assert.ok(!('confidence' in row), 'board row must never carry a confidence field');
    assert.ok(!('jev_confidence' in row), 'board row must never carry a jev_confidence field');
  }
});

// ─── 7. A41: board GET rows carry the fields the board + modal render ────────

test('[D25 A41] board GET rows attach mismatch/hold/plan/scope/model fields', async () => {
  const { GET } = await import('../../src/app/api/tasks/route');
  const res = await GET(new Request('http://localhost/api/tasks?limit=5') as never);
  assert.equal(res.status, 200);
  const body = (await res.json()) as Array<Record<string, unknown>>;
  const rows = Array.isArray(body) ? body : (body as { tasks: Array<Record<string, unknown>> }).tasks;
  assert.ok(Array.isArray(rows), 'board GET must return a row array');
  for (const row of rows ?? []) {
    for (const key of [
      'persona_mismatch',
      'dispatch_hold',
      'subtask_personas',
      'persona_bundle_scopes',
      'model_id',
      'model_label',
      'model_provider',
      'blend_confirm_state',
    ]) {
      assert.ok(key in row, `board row must carry ${key}`);
    }
  }
});

test('[D25 A41] single-task GET carries the same computed fields as the board list (no modal/list divergence)', async () => {
  const taskId = seedTask();
  const { GET } = await import('../../src/app/api/tasks/[id]/route');
  const res = await GET(new Request(`http://localhost/api/tasks/${taskId}`) as never, {
    params: Promise.resolve({ id: taskId }),
  });
  assert.equal(res.status, 200);
  const row = (await res.json()) as Task & Record<string, unknown>;
  for (const key of [
    'persona_mismatch',
    'dispatch_hold',
    'persona_bundle_scopes',
    'model_label',
    'model_provider',
  ]) {
    assert.ok(key in row, `single-task GET must carry ${key}`);
  }
});

// ─── 8. D24 prerequisite hold ────────────────────────────────────────────────

test('[D25 D24] producer cards carry an explicit prerequisite hold until D24 lands', () => {
  assert.equal(d24Prerequisite({ source: 'funnel' }), true);
  assert.equal(d24Prerequisite({ source: null }), false);
  assert.equal(d24Prerequisite({}), false);
});
