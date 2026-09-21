/**
 * Real placement: the pool debited is the pool the run was PINNED to, and a
 * refused pin is never answered with a substitute.
 *
 * MUST import _isolated-db FIRST so getDb() opens a throwaway file.
 *
 * Nothing here touches a gateway. The placement decision is proven at the two
 * seams that carry it: `OpenClawClient.createSession` (what it SENDS) and
 * `reserveExecution` (which pool it DEBITS once a pin exists).
 */
import './_isolated-db';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { getDb } from '@/lib/db';
import { OpenClawClient } from '@/lib/openclaw/client';
import { reserveExecution, executionSessionId } from '@/lib/execution-attempts';
import { poolUsage } from '@/lib/capacity/provider-pools';

/** Capture what createSession puts on the wire, without a socket. */
function wireCapture() {
  const sent: { method: string; params: unknown }[] = [];
  const client = new OpenClawClient();
  (client as unknown as { call: (m: string, p?: unknown) => Promise<unknown> }).call = async (method, params) => {
    sent.push({ method, params });
    return { ok: true, key: (params as { key?: string })?.key };
  };
  return { client, sent };
}

// ── A. The client seam: what sessions.create actually carries ──────────────

test('createSession sends the model, so a run can be pinned before it starts', async () => {
  const { client, sent } = wireCapture();
  await client.createSession('mission-control', undefined, {
    key: 'agent:dept-x:mission-control-a-1',
    model: 'agnes/agnes-3.0-flash',
  });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].method, 'sessions.create');
  assert.deepEqual(sent[0].params, {
    key: 'agent:dept-x:mission-control-a-1',
    model: 'agnes/agnes-3.0-flash',
  });
});

test('createSession without placement options is byte-identical to the old call', async () => {
  const { client, sent } = wireCapture();
  await client.createSession('mission-control', 'someone');
  assert.deepEqual(sent[0].params, { label: 'someone' }, 'an unpinned create must not grow new fields');
  const bare = wireCapture();
  await bare.client.createSession('mission-control');
  assert.deepEqual(bare.sent[0].params, {}, 'and a bare create stays bare');
});

test('a model is only ever sent when the caller asked for one', async () => {
  const { client, sent } = wireCapture();
  await client.createSession('mission-control', undefined, { key: 'agent:a:b' });
  assert.equal((sent[0].params as Record<string, unknown>).model, undefined);
});

// ── B. The reserve seam: which pool a pinned run debits ────────────────────

function seedAgentAndTask(suffix: string): { agentId: string; taskId: string } {
  const db = getDb();
  const agent = db.prepare('SELECT id FROM agents LIMIT 1').get() as { id: string };
  const workspace = db.prepare('SELECT id, slug FROM workspaces LIMIT 1').get() as { id: string };
  const taskId = `place-task-${suffix}`;
  db.exec(`DELETE FROM task_executions WHERE task_id = '${taskId}'`);
  db.exec(`DELETE FROM tasks WHERE id = '${taskId}'`);
  db.prepare(
    "INSERT INTO tasks (id,title,workspace_id,status,assigned_agent_id,assignment_version) VALUES (?,?,?,'assigned',?,0)",
  ).run(taskId, `placement ${suffix}`, workspace.id, agent.id);
  return { agentId: agent.id, taskId };
}

function snapshotFor(taskId: string, agentId: string) {
  const db = getDb();
  return db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as Record<string, unknown> & {
    id: string;
    status: string;
    assigned_agent_id: string;
  };
}

/** Fill a provider's pool to its configured limit with live executions. */
function saturate(provider: string, agentId: string): string[] {
  const db = getDb();
  const limit = poolUsage()[provider]?.limit ?? 3;
  const ids: string[] = [];
  const workspace = db.prepare('SELECT id FROM workspaces LIMIT 1').get() as { id: string };
  const now = new Date().toISOString();
  for (let i = 0; i < limit; i++) {
    const tid = `place-filler-${provider}-${i}`;
    const eid = `place-fill-exec-${provider}-${i}`;
    db.exec(`DELETE FROM task_executions WHERE id = '${eid}'`);
    db.exec(`DELETE FROM tasks WHERE id = '${tid}'`);
    db.prepare('INSERT INTO tasks (id,title,workspace_id) VALUES (?,?,?)').run(tid, 'filler', workspace.id);
    db.prepare(
      `INSERT INTO task_executions
        (id,task_id,assignment_version,agent_id,workspace_id,generation,worker_context,session_key,session_id,
         state,lease_owner,lease_expires_at,idempotency_key,provider,created_at,updated_at)
       VALUES (?,?,0,?,NULL,?,'[]',?,?,'running','o','x',?,?,?,?)`,
    ).run(eid, tid, agentId, 700 + i, `place-sk-${provider}-${i}`, `place-sid-${provider}-${i}`,
      `place-idem-${provider}-${i}`, provider, now, now);
    ids.push(eid);
  }
  return ids;
}

function cleanupFillers(): void {
  const db = getDb();
  db.exec("DELETE FROM task_executions WHERE id LIKE 'place-fill-exec-%'");
  db.exec("DELETE FROM tasks WHERE id LIKE 'place-filler-%'");
}

test('with NO pin, a full primary still refuses — placement changes nothing on its own', () => {
  const db = getDb();
  cleanupFillers();
  const { agentId, taskId } = seedAgentAndTask('nopin');
  saturate('ollama', agentId);
  try {
    const res = reserveExecution(
      { ...snapshotFor(taskId, agentId), model_chain: ['ollama/flash', 'agnes/agnes-3.0-flash'] },
      `agent:x:${executionSessionId(agentId, 'e-nopin')}`,
      randomUUID(),
      db,
    );
    assert.equal(res.reason, 'provider_at_capacity');
    assert.equal(res.provider, 'ollama');
    assert.ok(res.fallbacksWithRoom?.includes('agnes'), 'the refusal still names where there is room');
  } finally {
    cleanupFillers();
  }
});

test('with a pin, the debit follows the PINNED model and the run is allowed through', () => {
  const db = getDb();
  cleanupFillers();
  const { agentId, taskId } = seedAgentAndTask('pinned');
  saturate('ollama', agentId);
  try {
    const res = reserveExecution(
      {
        ...snapshotFor(taskId, agentId),
        model_chain: ['ollama/flash', 'agnes/agnes-3.0-flash'],
        placed_model: 'agnes/agnes-3.0-flash',
      },
      `agent:x:${executionSessionId(agentId, 'e-pinned')}`,
      'place-exec-pinned',
      db,
    );
    assert.ok(res.execution, 'a saturated primary must not block a run pinned elsewhere');
    assert.equal(res.provider, 'agnes', 'the debit lands on the pool the run will actually attempt');
    assert.equal(res.placedModel, 'agnes/agnes-3.0-flash');
    const row = db.prepare('SELECT provider, placed_model FROM task_executions WHERE id=?').get('place-exec-pinned') as {
      provider: string;
      placed_model: string | null;
    };
    assert.equal(row.provider, 'agnes');
    assert.equal(row.placed_model, 'agnes/agnes-3.0-flash', 'the row carries the model that justifies the debit');
  } finally {
    db.exec("DELETE FROM task_executions WHERE id = 'place-exec-pinned'");
    cleanupFillers();
  }
});

test('a pin the agent does not declare is IGNORED — sovereignty is not negotiable', () => {
  const db = getDb();
  cleanupFillers();
  const { agentId, taskId } = seedAgentAndTask('undeclared');
  saturate('ollama', agentId);
  try {
    const res = reserveExecution(
      {
        ...snapshotFor(taskId, agentId),
        model_chain: ['ollama/flash', 'agnes/agnes-3.0-flash'],
        // Not in the chain. A caller cannot smuggle a model the client never declared.
        placed_model: 'openai/gpt-5.5',
      },
      `agent:x:${executionSessionId(agentId, 'e-undeclared')}`,
      randomUUID(),
      db,
    );
    assert.equal(res.reason, 'provider_at_capacity', 'it falls back to the primary rule, not to the smuggled model');
    assert.equal(res.provider, 'ollama');
    assert.equal(res.placedModel, undefined);
  } finally {
    cleanupFillers();
  }
});

test('a pinned pool that is ALSO full still refuses — a pin is not a bypass', () => {
  const db = getDb();
  cleanupFillers();
  const { agentId, taskId } = seedAgentAndTask('bothfull');
  saturate('ollama', agentId);
  saturate('agnes', agentId);
  try {
    const res = reserveExecution(
      {
        ...snapshotFor(taskId, agentId),
        model_chain: ['ollama/flash', 'agnes/agnes-3.0-flash'],
        placed_model: 'agnes/agnes-3.0-flash',
      },
      `agent:x:${executionSessionId(agentId, 'e-bothfull')}`,
      randomUUID(),
      db,
    );
    assert.equal(res.reason, 'provider_at_capacity');
    assert.equal(res.provider, 'agnes', 'the refusal names the pool that was actually asked for');
  } finally {
    cleanupFillers();
  }
});

test('migration 157 shipped the placement columns', () => {
  const columns = new Set(
    (getDb().prepare('PRAGMA table_info(task_executions)').all() as { name: string }[]).map((c) => c.name),
  );
  assert.ok(columns.has('placed_model'));
  assert.ok(columns.has('placement_confirmed'));
});
