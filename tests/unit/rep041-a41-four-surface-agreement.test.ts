/**
 * rep041-a41-four-surface-agreement.test.ts — A41 (spec 16.2): "UI live update,
 * refresh, reconnect, task detail agree about preparation/execution state
 * provider provenance."
 *
 * WHAT THIS FILE MEASURES — the four surfaces, all against ONE seeded row:
 *
 *   1. refresh      the REAL board GET   (src/app/api/tasks/route.ts)
 *   2. task detail  the REAL detail GET  (src/app/api/tasks/[id]/route.ts)
 *   3. live update  the REAL choke point: registerClient() + broadcast() with a
 *                   MINIMAL payload (`{ id, status }` — exactly what
 *                   src/lib/jobs/stale-task-sweep.ts:523 ships), then the SSE
 *                   frame the browser actually receives, fed through the real
 *                   Zustand updateTask semantics (wholesale card replacement).
 *   4. reconnect    the REAL predicate (src/lib/board/a41-row-fields.ts
 *                   boardStateDisagrees), the one both catch-up call sites use.
 *
 * ANTI-VACUITY — agreement is only meaningful if the fields carry real values,
 * so the assertions below require provider provenance, the persona mismatch and
 * the dispatch hold to be PRESENT and CORRECT on every surface, not merely
 * absent-everywhere. The comparator itself gets a control test (two different
 * payloads MUST report a difference) because QC will exercise the comparator,
 * not just the fixtures.
 *
 * No network, no provider keys, no client box, no producer runs: seeded
 * fixtures + real routes + the real broadcaster on an isolated temp DB.
 */
import './_isolated-db'; // MUST be first DB import: throwaway DATABASE_PATH.
import test from 'node:test';
import assert from 'node:assert/strict';
import { v4 as uuidv4 } from 'uuid';
import { getDb, run, queryOne } from '../../src/lib/db';
import { persistPersonaBundle } from '../../src/lib/persona-selector';
import { recordPersonaUsedAndCompare } from '../../src/lib/persona-mismatch';
import { A41_ROW_FIELDS, a41DifferingFields, boardStateDisagrees, taskRowDisagrees } from '../../src/lib/board/a41-row-fields';
import { TASK_ROW_SELECT_FIELDS } from '../../src/lib/board/task-row-projection';
import * as events from '../../src/lib/events';
import type { PersonaBundle, Task } from '../../src/lib/types';

getDb(); // trigger the full migration chain against the isolated temp DB

test.after(async () => {
  const { closeDb } = await import('../../src/lib/db');
  try {
    closeDb();
  } catch {
    /* already closed */
  }
});

// ─── fixture ─────────────────────────────────────────────────────────────────

const WS_ID = 'rep041-ws';
let TASK_ID = '';

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
    blend_directive: 'STYLE-INSPIRED, NEVER IMPERSONATION (mandatory, non-removable).',
    task_personas: [{ seq: 1, persona_id: 'hormozi-100m-offers', why: 'fixture' }],
    catalog_version: '1.4',
  };
}

function seed(): string {
  const taskId = `rep041-task-${Date.now()}`;
  const agentId = uuidv4();
  const execId = `exec-${taskId}`;
  const now = new Date().toISOString();

  run(`INSERT INTO workspaces (id, name, slug, created_at) VALUES (?, 'ws', ?, ?)`, [WS_ID, WS_ID, now]);
  run(
    `INSERT INTO agents (id, name, role, workspace_id, status, created_at, updated_at)
     VALUES (?, 'A41 Agent', 'specialist', ?, 'standby', ?, ?)`,
    [agentId, WS_ID, now, now],
  );
  run(
    `INSERT INTO model_registry (model_id, label, provider, input_cost_per_million, output_cost_per_million)
     VALUES ('model-a41', 'A41 Model', '9ROUTER', 1.5, 6.0)`,
  );
  run(
    `INSERT INTO tasks (id, title, status, priority, assigned_agent_id, workspace_id, model_id, voice_persona_id, created_at, updated_at)
     VALUES (?, 'A41 fixture', 'in_progress', 'medium', ?, ?, 'model-a41', 'hormozi-100m-offers', ?, ?)`,
    [taskId, agentId, WS_ID, now, now],
  );
  // The bundle is written through the REAL write path (it stamps voice_persona_id
  // and the catalog version), then flipped to `pending` the way the audience
  // confirm flow does, so refresh/detail/live all have a real blend_confirm_state.
  persistPersonaBundle(taskId, declaredBundle());
  run(`UPDATE task_persona_bundle SET confirm_state = 'pending' WHERE task_id = ?`, [taskId]);
  run(
    `INSERT INTO task_subtask_persona (task_id, seq, subtask_text, persona_id, persona_name, score, department, task_category, slot)
     VALUES (?, 1, 'write the offer', 'hormozi-100m-offers', 'Hormozi', 0.9, 'marketing', 'copy', 'voice')`,
    [taskId],
  );
  // PREPARATION/EXECUTION STATE: an ACTUAL runtime execution on a DIFFERENT
  // provider than the intended model registry row (9ROUTER intended, OLLAMA
  // actual). This is the class A41 names; it exists nowhere else on the row.
  run(
    `INSERT INTO task_executions
       (id, task_id, assignment_version, agent_id, workspace_id, generation, worker_context,
        session_key, session_id, state, lease_owner, lease_expires_at, idempotency_key,
        provider, created_at, updated_at)
     VALUES (?, ?, 1, ?, ?, 1, '[]', ?, ?, 'running', 'rep041-test', ?, ?, 'OLLAMA', ?, ?)`,
    [execId, taskId, agentId, WS_ID, `sk-${taskId}`, `sid-${taskId}`, now, `idem-${taskId}`, now, now],
  );
  // B-U6/U20 mismatch: lands as an `events` row and does NOT move tasks.updated_at.
  // The execution_id is bound to the live execution: the read path
  // (getOpenPersonaMismatch) filters every mismatch by the task's LATEST
  // execution, so a report stamped with no execution would never be surfaced.
  recordPersonaUsedAndCompare(taskId, {
    kind: 'persona_used',
    execution_id: execId,
    voice_persona_id: 'someone-else-entirely',
    topic_persona_id: null,
    task_persona_id: null,
    blend_directive_sha: null,
    goal: null,
  });
  // U37 class-b hold: the latest activity row is a routed-but-not-dispatched hold.
  run(
    `INSERT INTO task_activities (id, task_id, activity_type, message, metadata, created_at)
     VALUES (?, ?, 'routed_but_not_dispatched', ?, ?, ?)`,
    [
      uuidv4(),
      taskId,
      'Routed to A41 Agent but no OpenClaw runtime on this box. Wire the department runtime to release.',
      JSON.stringify({ reason: 'no_specialist_runtime', workspace_id: WS_ID, role: 'specialist' }),
      now,
    ],
  );
  return taskId;
}

// ─── capture helper: the REAL broadcaster, one registered client ─────────────

function fakeController(sink: string[]) {
  return {
    get desiredSize() {
      return 1024;
    },
    enqueue(chunk: Uint8Array) {
      sink.push(new TextDecoder().decode(chunk));
    },
    close() {
      /* test double */
    },
  } as unknown as ReadableStreamDefaultController;
}

/** One SSE frame -> the payload a browser's EventSource would hand the store. */
function livePayloadFromBroadcast(taskId: string): Record<string, unknown> {
  const frames: string[] = [];
  const ctrl = fakeController(frames);
  events.registerClient(ctrl, null); // operator session: unscoped, sees everything
  try {
    // The MINIMAL payload shape a real emit site ships — no projection, no
    // joins, exactly src/lib/jobs/stale-task-sweep.ts:523.
    events.broadcast({ type: 'task_updated', payload: { id: taskId, status: 'in_progress' } });
  } finally {
    events.unregisterClient(ctrl);
  }
  assert.equal(frames.length, 1, 'the broadcast must reach the registered client');
  const raw = frames[0].replace(/^data: /, '').trim();
  const parsed = JSON.parse(raw) as { type: string; payload: Record<string, unknown> };
  assert.equal(parsed.type, 'task_updated');
  return parsed.payload;
}

/** src/lib/store.ts updateTask: `task.id === updatedTask.id ? updatedTask : task`. */
function applyStoreUpdate(current: Record<string, unknown>, incoming: Record<string, unknown>) {
  return { ...current, ...incoming };
}

// ─── the measurement ─────────────────────────────────────────────────────────

test('[A41] live update, refresh, task detail and reconnect agree on preparation/execution state + provider provenance', async () => {
  TASK_ID = seed();
  const frozen = queryOne<{ updated_at: string }>('SELECT updated_at FROM tasks WHERE id = ?', [TASK_ID])?.updated_at;

  // ── 1. refresh: the real board GET ────────────────────────────────────────
  const { GET: boardGET } = await import('../../src/app/api/tasks/route');
  const boardRes = await boardGET(new Request('http://localhost/api/tasks?limit=200') as never);
  assert.equal(boardRes.status, 200);
  const boardBody = (await boardRes.json()) as { tasks: Array<Record<string, unknown>> };
  const refreshRow = (boardBody.tasks ?? []).find((t) => t.id === TASK_ID);
  assert.ok(refreshRow, 'board GET must return the seeded task');

  // ── 2. task detail: the real single-task GET ──────────────────────────────
  const { GET: detailGET } = await import('../../src/app/api/tasks/[id]/route');
  const detailRes = await detailGET(new Request(`http://localhost/api/tasks/${TASK_ID}`) as never, {
    params: Promise.resolve({ id: TASK_ID }),
  });
  assert.equal(detailRes.status, 200);
  const detailRow = (await detailRes.json()) as Record<string, unknown>;

  // ── 3. live update: real broadcast -> real wire payload -> real store rule ─
  const liveRow = livePayloadFromBroadcast(TASK_ID);
  const storeRow = applyStoreUpdate(refreshRow, liveRow);

  // ── ANTI-VACUITY: the classes must CARRY REAL VALUES on every surface ─────
  const truthBySurface: Array<[string, Record<string, unknown>]> = [
    ['refresh', refreshRow],
    ['detail', detailRow],
    ['live', liveRow],
  ];
  for (const [name, r] of truthBySurface) {
    const truth = r.provider_truth as { intendedModel?: unknown; intendedProvider?: unknown; actualProvider?: unknown; executionState?: unknown } | undefined;
    assert.ok(truth, `${name}: provider_truth must be present`);
    assert.equal(truth.intendedModel, 'A41 Model', `${name}: intended model resolved via the model_registry join`);
    assert.equal(truth.intendedProvider, '9ROUTER', `${name}: intended provider is the registry provider`);
    assert.equal(truth.actualProvider, 'OLLAMA', `${name}: ACTUAL provider is the execution row, never the intended one`);
    assert.equal(truth.executionState, 'running', `${name}: execution state comes from task_executions`);
    assert.ok(r.provider_truth !== undefined, `${name}: provider_truth key present`);

    assert.ok(r.persona_mismatch, `${name}: persona_mismatch must be open (declared hormozi vs used someone-else-entirely)`);
    assert.ok(r.dispatch_hold, `${name}: dispatch_hold must be open (routed_but_not_dispatched is the latest activity)`);
    assert.equal((r.dispatch_hold as { reason?: unknown }).reason, 'no_specialist_runtime', `${name}: hold reason travels`);
    assert.equal(r.blend_confirm_state, 'pending', `${name}: blend confirm state travels`);
    assert.equal(r.model_label, 'A41 Model', `${name}: model label travels`);
    assert.equal(r.model_provider, '9ROUTER', `${name}: model provider travels`);
    assert.ok(Array.isArray(r.subtask_personas) && (r.subtask_personas as unknown[]).length === 1, `${name}: plan rows travel`);
    assert.ok(Array.isArray(r.persona_bundle_scopes), `${name}: scoped bundle rows travel`);
  }

  // The legacy INTEGER column must never masquerade as the hold object.
  assert.equal(typeof liveRow.dispatch_hold, 'object', 'live payload must not ship the raw tasks.dispatch_hold INTEGER');

  // ── AGREEMENT: one comparator, four surfaces, zero differing fields ───────
  console.log('\n=== REP-041 A41 FOUR-SURFACE TABLE (branch HEAD) ===');
  console.log(`task=${TASK_ID}  tasks.updated_at=${frozen} (never moved by the mismatch write)`);
  for (const [name, r] of [...truthBySurface, ['refresh->live store row', storeRow] as [string, Record<string, unknown>]]) {
    const cells = A41_ROW_FIELDS.map((f) => {
      const present = Object.prototype.hasOwnProperty.call(r, f);
      const v = r[f];
      const shown = v === null ? 'null' : Array.isArray(v) ? `[${v.length}]` : typeof v === 'object' ? 'object' : String(v);
      return `${f}=${present ? shown : 'ABSENT'}`;
    });
    console.log(`  ${name.padEnd(24)} ${cells.join(' | ')}`);
  }

  assert.deepEqual(a41DifferingFields(refreshRow, detailRow), [], 'refresh vs task detail must agree on every A41 field');
  assert.deepEqual(a41DifferingFields(refreshRow, liveRow), [], 'refresh vs live update must agree on every A41 field');
  assert.deepEqual(a41DifferingFields(refreshRow, storeRow), [], 'the store row after a minimal live payload must still agree');

  for (const f of A41_ROW_FIELDS) {
    assert.ok(f in refreshRow, `refresh row must carry ${f}`);
    assert.ok(f in detailRow, `task-detail row must carry ${f}`);
    assert.ok(f in liveRow, `live payload must carry ${f}`);
  }

  // ── 4. reconnect: the real predicate ──────────────────────────────────────
  const freshBoard = (boardBody.tasks ?? []) as unknown[];
  assert.equal(boardStateDisagrees(freshBoard, [storeRow]), false, 'an agreed board must not churn the store on reconnect');

  // The A41 failure mode: a change that moves NEITHER status NOR updated_at.
  run(`UPDATE task_executions SET provider = 'FIREWORKS' WHERE task_id = ?`, [TASK_ID]);
  const { GET: boardGET2 } = await import('../../src/app/api/tasks/route');
  const boardRes2 = await boardGET2(new Request('http://localhost/api/tasks?limit=200') as never);
  const boardBody2 = (await boardRes2.json()) as { tasks: Array<Record<string, unknown>> };
  const fresh2 = (boardBody2.tasks ?? []) as Array<Record<string, unknown>>;
  const movedRow = fresh2.find((t) => t.id === TASK_ID)!;
  const stillFrozen = queryOne<{ updated_at: string }>('SELECT updated_at FROM tasks WHERE id = ?', [TASK_ID])?.updated_at;
  assert.equal(stillFrozen, frozen, 'the provider change must not have touched tasks.updated_at');
  assert.equal(movedRow.status, storeRow.status, 'the provider change must not have moved status');

  assert.equal(
    boardStateDisagrees(fresh2, [storeRow]),
    true,
    'reconnect MUST reconcile a provider-provenance change that moved neither status nor updated_at',
  );
  // And the inverse control: the same board against itself does not churn.
  assert.equal(boardStateDisagrees(fresh2, fresh2), false, 'identical fresh boards must not report a difference');
});

// ─── comparator self-control (QC will test the comparator, not the fixture) ──

test('[A41 comparator] two DIFFERENT payloads report a difference; identical payloads do not', () => {
  const base = {
    id: 'x',
    status: 'in_progress',
    updated_at: '2026-01-01T00:00:00.000Z',
    model_id: 'model-a41',
    model_label: 'A41 Model',
    model_provider: '9ROUTER',
    provider_truth: { intendedModel: 'A41 Model', intendedProvider: '9ROUTER', actualProvider: 'OLLAMA', executionState: 'running' },
    subtask_personas: [{ seq: 1, persona_id: 'p1' }],
    persona_bundle_scopes: [],
    blend_confirm_state: 'pending',
    persona_mismatch: { reason: 'voice_persona_used_mismatch' },
    dispatch_hold: { reason: 'no_specialist_runtime' },
  };
  const clone = () => JSON.parse(JSON.stringify(base)) as typeof base;

  assert.deepEqual(a41DifferingFields(base, clone()), [], 'identical payloads must agree');
  assert.equal(taskRowDisagrees(clone(), base), false, 'identical rows must not disagree');
  assert.equal(boardStateDisagrees([clone()], [base]), false, 'identical boards must not disagree');

  // Key-ORDER must not matter (rows are built by different code paths).
  const reordered = clone();
  const shuffled = Object.fromEntries(Object.entries(reordered).reverse()) as unknown as typeof base;
  assert.deepEqual(a41DifferingFields(base, shuffled), [], 'property order is not a difference');

  for (const f of A41_ROW_FIELDS) {
    const changed = clone() as unknown as Record<string, unknown>;
    changed[f] = f === 'subtask_personas' || f === 'persona_bundle_scopes' ? [{ diff: true }] : '__DIFFERENT__';
    assert.deepEqual(
      a41DifferingFields(base, changed),
      [f],
      `a change to ${f} must be reported (and only ${f})`,
    );
    assert.equal(taskRowDisagrees(changed, base), true, `a change to ${f} must reconcile`);
    assert.equal(boardStateDisagrees([changed], [base]), true, `a change to ${f} must reconcile the board`);
  }

  // A row the store does not hold at all, and a vanished row, are differences.
  assert.equal(taskRowDisagrees(base, undefined), true, 'an unknown card is a difference');
  assert.equal(boardStateDisagrees([base, clone()], [base]), true, 'a length change is a difference');
});

// ─── the shared field list is the ONLY field list (no second copy) ───────────

test('[A41] the projection SQL owns model_label/model_provider and the routes keep no private copy', async () => {
  for (const col of ['mr.label as model_label', 'mr.provider as model_provider']) {
    assert.ok(TASK_ROW_SELECT_FIELDS.includes(col), `the one SELECT list must carry ${col}`);
  }
  const fs = await import('node:fs');
  for (const file of ['src/app/api/tasks/route.ts', 'src/app/api/tasks/[id]/route.ts']) {
    const src = fs.readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8');
    assert.ok(
      !/mr\.label as model_label/.test(src),
      `${file} must not carry its own copy of the model_registry field list`,
    );
  }
});
