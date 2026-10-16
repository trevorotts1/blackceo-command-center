/**
 * provider-capacity-pools-2026-09.test.ts — capacity belongs to the PROVIDER PLAN.
 *
 * v7.6.27 made concurrency a per-agent number (`agents.max_concurrent_executions`,
 * default 1). The unit was wrong. What runs out on a client box is the
 * subscription: Ollama Cloud Pro allows 3 concurrent requests, Max allows 10,
 * DeepSeek Direct documents 2,500, OpenRouter is effectively unbounded. Encoding
 * it per agent meant an upgraded plan raised nothing until every agent row had
 * been edited by hand, and four agents at one job each could together exceed a
 * 3-concurrent plan without any single agent exceeding its own ceiling.
 *
 * The limit is now the pool, keyed by the provider prefix of the RUNTIME model
 * id, counted per box inside the same BEGIN IMMEDIATE the reservation uses. The
 * agent ceiling survives as an OPTIONAL pin. The per-task rule is untouched.
 *
 *   node --import tsx --test tests/unit/provider-capacity-pools-2026-09.test.ts
 */

import './_isolated-db'; // MUST be the first DB-reaching import (C8 guard).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { EXECUTION_SCHEMA_SQL } from '../../src/lib/execution-schema';
import {
  reserveExecution,
  workerConcurrencyLimit,
  recordExecutionUnknown,
  beginExecutionSend,
  latestExecution,
  executionSessionId,
  type DispatchSnapshot,
} from '../../src/lib/execution-attempts';
import {
  providerOf,
  poolLimit,
  poolUsage,
  canonicalProvider,
  providerCoolingUntil,
  isRateLimitError,
  effectiveLimit,
  growProviderPools,
  noteProviderRateLimit,
  probeChain,
  poolPressureSummary,
  DEFAULT_PROVIDER_CONCURRENCY,
  PROVIDER_COOLDOWN_MS,
  PROVIDER_RECOVERY_MS,
} from '../../src/lib/capacity/provider-pools';
import { invalidateCompanyConfigCache } from '../../src/lib/company-config';
import { migrations } from '../../src/lib/db/migrations';

/** Post-migration-150 shape: the agent ceiling is nullable and usually unset. */
function fixture() {
  const db = new Database(':memory:');
  db.exec(`
   CREATE TABLE agents(id TEXT PRIMARY KEY,name TEXT,model TEXT,max_concurrent_executions INTEGER);
   INSERT INTO agents(id,name,model) VALUES
     ('a','Marketing Lead','ollama/deepseek-v4.1-flash:cloud'),
     ('b','Ops Lead','deepseek/deepseek-v4-flash'),
     ('c','Research Lead',NULL);
   CREATE TABLE tasks(id TEXT PRIMARY KEY,assigned_agent_id TEXT,assignment_version INTEGER DEFAULT 0,status TEXT,workspace_id TEXT,department TEXT,source TEXT,killed_at TEXT,archived_at TEXT,description TEXT,updated_at TEXT);
   CREATE TABLE openclaw_sessions(id TEXT PRIMARY KEY,agent_id TEXT,openclaw_session_id TEXT,channel TEXT,status TEXT,task_id TEXT,created_at TEXT,updated_at TEXT);
   CREATE TABLE events(id TEXT,type TEXT,task_id TEXT,agent_id TEXT,message TEXT,created_at TEXT);
   INSERT INTO tasks(id,assigned_agent_id,status,workspace_id,department) VALUES
     ('t1','a','assigned','ws','marketing'),('t2','a','assigned','ws','marketing'),
     ('t3','a','assigned','ws','marketing'),('t4','a','assigned','ws','marketing'),
     ('t5','b','assigned','ws','ops'),('t6','b','assigned','ws','ops'),
     ('t7','c','assigned','ws','research');`);
  db.exec(EXECUTION_SCHEMA_SQL);
  return db;
}

const snap = (db: Database.Database, id: string) =>
  db.prepare('SELECT * FROM tasks WHERE id=?').get(id) as DispatchSnapshot;

/** Reserve `id` on a model chain, or let reserveExecution resolve one.
 * A bare provider name is accepted as a one-model chain for readability. */
const claim = (db: Database.Database, id: string, eid: string, chain?: string | string[]) => {
  const models = chain === undefined ? undefined : Array.isArray(chain) ? chain : [`${chain}/fixture-model`];
  return reserveExecution(
    { ...snap(db, id), ...(models === undefined ? {} : { model_chain: models }) },
    `agent:pool:${executionSessionId(snap(db, id).assigned_agent_id!, eid)}`,
    eid,
    db,
  );
};

const setCeiling = (db: Database.Database, agentId: string, n: number | null) =>
  db.prepare('UPDATE agents SET max_concurrent_executions=? WHERE id=?').run(n, agentId);

// ── The pool key ─────────────────────────────────────────────────────────────

test('the pool key is the provider prefix, with fleet spellings folded together', () => {
  assert.equal(providerOf('ollama/deepseek-v4.1-flash:cloud'), 'ollama');
  assert.equal(providerOf('ollama-cloud/mistral-large-3:675b'), 'ollama', 'registry and runtime spell ONE subscription');
  assert.equal(providerOf('9router/opus-chain'), '9router');
  assert.equal(providerOf('agnes/agnes-2.5-flash'), 'agnes');
  // The WRAPPER rate-limits the call, so a namespaced id belongs to the wrapper.
  assert.equal(providerOf('openrouter/deepseek/deepseek-v4-flash-vision-exp'), 'openrouter');
  assert.equal(canonicalProvider('openrouter.ai'), 'openrouter');
  // A bare id records no provider at all, and an absent one cannot be guessed.
  assert.equal(providerOf('deepseek-v4-flash'), 'default');
  assert.equal(providerOf(null), 'default');
  assert.equal(providerOf(''), 'default');
});

// ── The pool is the limit ────────────────────────────────────────────────────

test('a pool admits up to its limit and refuses beyond it, naming the pool and the depth', () => {
  const db = fixture();
  try {
    assert.equal(poolLimit('ollama'), 3, 'Ollama Cloud Pro: 3 concurrent');
    assert.ok(claim(db, 't1', 'e1', 'ollama').execution, 'slot 1');
    assert.ok(claim(db, 't2', 'e2', 'ollama').execution, 'slot 2');
    assert.ok(claim(db, 't3', 'e3', 'ollama').execution, 'slot 3 — three agents-worth of work on one agent');
    const refused = claim(db, 't4', 'e4', 'ollama');
    assert.equal(refused.execution, undefined);
    assert.equal(refused.reason, 'provider_at_capacity');
    assert.equal(refused.provider, 'ollama');
    assert.equal(refused.running, 3);
    assert.equal(refused.limit, 3);
    assert.equal(refused.summary, 'Ollama Cloud 3/3 full; this agent declares no fallback');
  } finally {
    db.close();
  }
});

test('the provider is persisted on the execution row, so the count never re-reads a config', () => {
  const db = fixture();
  try {
    assert.ok(claim(db, 't1', 'e1', ['ollama-cloud/mistral-large-3:675b']).execution);
    assert.equal(latestExecution('t1', db)!.provider, 'ollama', 'stored canonicalised, not verbatim');
  } finally {
    db.close();
  }
});

test('with no provider supplied, the agent model column is the fallback pool', () => {
  const db = fixture();
  try {
    assert.ok(claim(db, 't1', 'e1').execution);
    assert.equal(latestExecution('t1', db)!.provider, 'ollama', "resolved from agents.model");
    assert.ok(claim(db, 't5', 'e5').execution);
    assert.equal(latestExecution('t5', db)!.provider, 'deepseek');
    // An agent with no model at all still lands in a pool rather than none.
    assert.ok(claim(db, 't7', 'e7').execution);
    assert.equal(latestExecution('t7', db)!.provider, 'default');
  } finally {
    db.close();
  }
});

test('two providers are independent: a full Ollama pool does not touch DeepSeek', () => {
  const db = fixture();
  try {
    for (const [taskId, eid] of [['t1', 'e1'], ['t2', 'e2'], ['t3', 'e3']]) {
      assert.ok(claim(db, taskId, eid, 'ollama').execution);
    }
    assert.equal(claim(db, 't4', 'e4', 'ollama').reason, 'provider_at_capacity');
    assert.ok(claim(db, 't5', 'e5', 'deepseek').execution, 'DeepSeek Direct has its own, far larger plan');
    assert.ok(claim(db, 't6', 'e6', 'deepseek').execution);
  } finally {
    db.close();
  }
});

// ── The agent ceiling is optional ────────────────────────────────────────────

test('an unset agent ceiling is NO ceiling — the agent takes the whole pool', () => {
  const db = fixture();
  try {
    assert.equal(workerConcurrencyLimit('a', db), null, 'NULL means the pool is the limit');
    assert.ok(claim(db, 't1', 'e1', 'ollama').execution);
    assert.ok(claim(db, 't2', 'e2', 'ollama').execution, 'ONE agent, two live jobs — impossible under v7.6.27');
    assert.ok(claim(db, 't3', 'e3', 'ollama').execution);
    assert.equal(claim(db, 't4', 'e4', 'ollama').reason, 'provider_at_capacity', 'the pool, not the agent, is what stops it');
  } finally {
    db.close();
  }
});

test('an explicitly pinned agent ceiling is still honoured, under the pool limit', () => {
  const db = fixture();
  try {
    setCeiling(db, 'a', 1);
    assert.equal(workerConcurrencyLimit('a', db), 1);
    assert.ok(claim(db, 't1', 'e1', 'ollama').execution);
    const refused = claim(db, 't2', 'e2', 'ollama');
    assert.equal(refused.reason, 'worker_at_capacity', 'the pin bites before the pool is anywhere near full');
    assert.equal(refused.limit, 1);
    setCeiling(db, 'a', null);
    assert.ok(claim(db, 't2', 'e2b', 'ollama').execution, 'clearing the pin restores pool-bounded throughput');
  } finally {
    db.close();
  }
});

test('WORKER_MAX_CONCURRENT_DEFAULT is unset by default and is only a fallback for the pin', () => {
  const db = fixture();
  try {
    assert.equal(workerConcurrencyLimit('a', db), null);
    process.env.WORKER_MAX_CONCURRENT_DEFAULT = '2';
    try {
      assert.equal(workerConcurrencyLimit('a', db), 2, 'box-wide fallback');
      setCeiling(db, 'a', 5);
      assert.equal(workerConcurrencyLimit('a', db), 5, 'the agent row outranks the box fallback');
    } finally {
      delete process.env.WORKER_MAX_CONCURRENT_DEFAULT;
    }
    setCeiling(db, 'a', null);
    assert.equal(workerConcurrencyLimit('a', db), null, 'unset → no ceiling again');
  } finally {
    db.close();
  }
});

// ── The per-task rule is untouched ───────────────────────────────────────────

test('one live execution per card, whatever the pool allows', () => {
  const db = fixture();
  try {
    assert.ok(claim(db, 't1', 'e1', 'deepseek').execution);
    const second = claim(db, 't1', 'e2', 'deepseek');
    assert.equal(second.execution, undefined);
    assert.equal(second.reason, 'execution_or_worker_busy');
    assert.equal(
      (db.prepare("SELECT COUNT(*) AS n FROM task_executions WHERE task_id='t1'").get() as { n: number }).n,
      1,
    );
  } finally {
    db.close();
  }
});

// ── Rate-limit backoff ───────────────────────────────────────────────────────

test('a 429 from the gateway shuts the whole pool, and it reopens on its own', () => {
  const db = fixture();
  try {
    const execution = claim(db, 't1', 'e1', 'ollama').execution!;
    assert.equal(beginExecutionSend(execution, db), true);
    recordExecutionUnknown(execution, db, new Error('gateway: 429 Too Many Requests'));

    const until = providerCoolingUntil('ollama', db);
    assert.ok(until, 'the pool is shut');
    assert.ok(
      Date.parse(until!) - Date.now() <= PROVIDER_COOLDOWN_MS + 5_000,
      'the cooldown is PROVIDER_COOLDOWN_MS, not open-ended',
    );
    assert.equal(
      (db.prepare("SELECT COUNT(*) AS n FROM events WHERE type='provider_rate_limited'").get() as { n: number }).n,
      1,
      'the shut pool is on the event trail, never silent',
    );

    const refused = claim(db, 't2', 'e2', 'ollama');
    assert.equal(refused.reason, 'provider_at_capacity');
    assert.equal(refused.provider, 'ollama');
    assert.match(refused.summary!, /cooling/, 'the card says the pool is cooling, not merely busy');
    // A DIFFERENT pool is untouched by one provider's refusal.
    assert.ok(claim(db, 't5', 'e5', 'deepseek').execution);

    db.prepare("UPDATE provider_pool_state SET cooling_until='2000-01-01T00:00:00.000Z' WHERE provider='ollama'").run();
    assert.equal(providerCoolingUntil('ollama', db), null, 'a past cooldown is an open pool');
    assert.ok(claim(db, 't2', 'e2b', 'ollama').execution, 'the pool admits again once the cooldown elapses');
  } finally {
    db.close();
  }
});

test('an ordinary send failure is not a rate limit and shuts nothing', () => {
  const db = fixture();
  try {
    assert.equal(isRateLimitError('429 Too Many Requests'), true);
    assert.equal(isRateLimitError('rate limit exceeded'), true);
    assert.equal(isRateLimitError('RateLimited'), true);
    assert.equal(isRateLimitError('ECONNREFUSED'), false);
    const execution = claim(db, 't1', 'e1', 'ollama').execution!;
    assert.equal(beginExecutionSend(execution, db), true);
    recordExecutionUnknown(execution, db, new Error('socket hang up'));
    assert.equal(providerCoolingUntil('ollama', db), null);
    assert.equal(
      (db.prepare("SELECT COUNT(*) AS n FROM provider_pool_state").get() as { n: number }).n,
      0,
    );
  } finally {
    db.close();
  }
});

// ── Raising the plan is ONE setting ──────────────────────────────────────────

test('PROVIDER_CONCURRENCY_<PROVIDER> beats the default table — a plan upgrade is one variable', () => {
  const db = fixture();
  try {
    assert.equal(poolLimit('ollama'), DEFAULT_PROVIDER_CONCURRENCY.ollama);
    process.env.PROVIDER_CONCURRENCY_OLLAMA = '8'; // Ollama Cloud Max, operator ceiling.
    try {
      assert.equal(poolLimit('ollama'), 8, 'no agent row was edited to get here');
      for (const [taskId, eid] of [['t1', 'e1'], ['t2', 'e2'], ['t3', 'e3'], ['t4', 'e4']]) {
        assert.ok(claim(db, taskId, eid, 'ollama').execution, `${taskId} admitted past the Pro limit of 3`);
      }
    } finally {
      delete process.env.PROVIDER_CONCURRENCY_OLLAMA;
    }
    assert.equal(poolLimit('ollama'), 3, 'removing the variable restores the Pro default');
    // A non-numeric or non-positive value is ignored rather than zeroing a pool.
    for (const bad of ['0', '-4', 'many', '']) {
      process.env.PROVIDER_CONCURRENCY_OLLAMA = bad;
      assert.equal(poolLimit('ollama'), 3, `"${bad}" must not become a limit`);
    }
    delete process.env.PROVIDER_CONCURRENCY_OLLAMA;
    // A provider nobody has named falls to the default pool's own limit.
    assert.equal(poolLimit('some-provider-nobody-listed'), DEFAULT_PROVIDER_CONCURRENCY.default);
  } finally {
    db.close();
  }
});

test('company-config.json provider_concurrency beats the default table, and the env beats it', () => {
  const cwd = process.cwd();
  const box = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-pool-config-'));
  fs.mkdirSync(path.join(box, 'config'), { recursive: true });
  fs.writeFileSync(
    path.join(box, 'config', 'company-config.json'),
    JSON.stringify({ companyName: 'Fixture', provider_concurrency: { 'ollama-cloud': 10, openrouter: 40 } }),
  );
  process.chdir(box);
  invalidateCompanyConfigCache();
  try {
    assert.equal(poolLimit('ollama'), 10, 'the config key is canonicalised, so ollama-cloud raises the ollama pool');
    assert.equal(poolLimit('openrouter'), 40);
    assert.equal(poolLimit('deepseek'), DEFAULT_PROVIDER_CONCURRENCY.deepseek, 'unnamed providers keep the default');
    process.env.PROVIDER_CONCURRENCY_OLLAMA = '2';
    try {
      assert.equal(poolLimit('ollama'), 2, 'the environment outranks the file');
    } finally {
      delete process.env.PROVIDER_CONCURRENCY_OLLAMA;
    }
  } finally {
    process.chdir(cwd);
    invalidateCompanyConfigCache();
  }
});

// ── Observability ────────────────────────────────────────────────────────────

test('poolUsage reports live occupancy per pool for /api/health', () => {
  const db = fixture();
  try {
    assert.ok(claim(db, 't1', 'e1', 'ollama').execution);
    assert.ok(claim(db, 't2', 'e2', 'ollama').execution);
    assert.ok(claim(db, 't5', 'e5', 'deepseek').execution);
    db.prepare("INSERT INTO provider_pool_state(provider,effective_limit,last_429_at,cooling_until,updated_at) VALUES('agnes',NULL,NULL,'2999-01-01T00:00:00.000Z','2026-09-21T00:00:00.000Z')").run();

    const pools = poolUsage(db);
    assert.deepEqual(pools.ollama, { running: 2, configured_limit: 3, limit: 3, cooling_until: null, last_429_at: null });
    assert.equal(pools.deepseek.running, 1);
    assert.equal(pools.deepseek.limit, DEFAULT_PROVIDER_CONCURRENCY.deepseek);
    assert.equal(pools.agnes.running, 0);
    assert.equal(pools.agnes.cooling_until, '2999-01-01T00:00:00.000Z');
    assert.equal(pools.openrouter.running, 0, 'a pool with no traffic is still reported');
    assert.equal(pools.openrouter.limit, 100);
  } finally {
    db.close();
  }
});

// ── Migration 150 ────────────────────────────────────────────────────────────

/** The exact shape migration 149 left behind: NOT NULL, DEFAULT 1. */
function legacy149Agents(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE agents(id TEXT PRIMARY KEY,name TEXT,max_concurrent_executions INTEGER NOT NULL DEFAULT 1);
   INSERT INTO agents(id,name) VALUES('a','Default ceiling'),('b','Also default');
   INSERT INTO agents(id,name,max_concurrent_executions) VALUES('c','Pinned to four',4),('d','Pinned to one on purpose',1);`);
  db.exec(`CREATE TABLE tasks(id TEXT PRIMARY KEY);`);
  return db;
}

const migration150 = migrations.find((m) => m.id === '150');

test('migration 150 nulls the v7.6.27 default of 1 and preserves every other ceiling', () => {
  assert.ok(migration150, 'migration 150 must exist');
  const db = legacy149Agents();
  try {
    // The legacy column really does forbid NULL — this is why it is rebuilt.
    assert.throws(() => db.prepare('UPDATE agents SET max_concurrent_executions=NULL WHERE id=?').run('a'), /NOT NULL/i);

    migration150!.up(db);

    const rows = db.prepare('SELECT id,max_concurrent_executions AS n FROM agents ORDER BY id').all() as { id: string; n: number | null }[];
    assert.deepEqual(rows, [
      { id: 'a', n: null },
      { id: 'b', n: null },
      { id: 'c', n: 4 },
      { id: 'd', n: null },
    ], 'exactly-1 rows carried the old unit of capacity, not a decision; 4 was a decision');

    const column = (db.prepare('PRAGMA table_info(agents)').all() as { name: string; notnull: number; dflt_value: unknown }[])
      .find((c) => c.name === 'max_concurrent_executions')!;
    assert.equal(column.notnull, 0, 'the ceiling is optional now');
    assert.equal(column.dflt_value, null, 'a NEW agent gets no ceiling, so it is bounded only by its pool');
    db.prepare("INSERT INTO agents(id,name) VALUES('e','Hired after the migration')").run();
    assert.equal(workerConcurrencyLimit('e', db), null);
  } finally {
    db.close();
  }
});

test('migration 150 adds the provider column and is idempotent', () => {
  const db = legacy149Agents();
  try {
    db.exec(`CREATE TABLE task_executions(id TEXT PRIMARY KEY, state TEXT, agent_id TEXT);`);
    migration150!.up(db);
    migration150!.up(db); // running twice must not throw or undo anything

    const columns = (db.prepare('PRAGMA table_info(task_executions)').all() as { name: string }[]).map((c) => c.name);
    assert.ok(columns.includes('provider'));
    assert.equal(
      (db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='index' AND name='idx_task_executions_provider_state'").get() as { n: number }).n,
      1,
    );
    const rows = db.prepare('SELECT id,max_concurrent_executions AS n FROM agents ORDER BY id').all() as { id: string; n: number | null }[];
    assert.deepEqual(rows.map((r) => r.n), [null, null, 4, null], 'the second run preserves what the first decided');
  } finally {
    db.close();
  }
});

test('a pre-migration database still dispatches — it is bounded by nothing new, not broken', () => {
  const db = new Database(':memory:');
  try {
    db.exec(`
     CREATE TABLE agents(id TEXT PRIMARY KEY,name TEXT);
     INSERT INTO agents(id,name) VALUES('a','Legacy');
     CREATE TABLE tasks(id TEXT PRIMARY KEY,assigned_agent_id TEXT,assignment_version INTEGER DEFAULT 0,status TEXT,workspace_id TEXT,department TEXT,source TEXT,killed_at TEXT,archived_at TEXT,description TEXT,updated_at TEXT);
     CREATE TABLE openclaw_sessions(id TEXT PRIMARY KEY,agent_id TEXT,openclaw_session_id TEXT,channel TEXT,status TEXT,task_id TEXT,created_at TEXT,updated_at TEXT);
     CREATE TABLE events(id TEXT,type TEXT,task_id TEXT,agent_id TEXT,message TEXT,created_at TEXT);
     INSERT INTO tasks(id,assigned_agent_id,status,workspace_id,department) VALUES ('t1','a','assigned','ws','marketing'),('t2','a','assigned','ws','marketing');`);
    // The pre-150 execution table: no provider column, no provider index, no
    // cooldown table — the shape migration 149 left on every box.
    db.exec(
      EXECUTION_SCHEMA_SQL
        .replace(/^ provider TEXT,$/m, '')
        .replace(/^CREATE INDEX IF NOT EXISTS idx_task_executions_provider_state .*$/m, '')
        .replace(/CREATE TABLE IF NOT EXISTS provider_pool_state \([\s\S]*?\);/, ''),
    );
    assert.equal(
      (db.prepare("SELECT COUNT(*) AS n FROM pragma_table_info('task_executions') WHERE name='provider'").get() as { n: number }).n,
      0,
      'the fixture really is pre-150',
    );
    assert.ok(claim(db, 't1', 'e1', 'ollama').execution);
    assert.ok(claim(db, 't2', 'e2', 'ollama').execution, 'no pool is enforced where no pool can be counted');
    assert.deepEqual(
      poolUsage(db).ollama,
      { running: 0, configured_limit: 3, limit: 3, cooling_until: null, last_429_at: null },
      'health reports zero, not a crash',
    );
  } finally {
    db.close();
  }
});

// ── Plan tiers (v7.6.37 A) ───────────────────────────────────────────────────

test('a PLAN TIER is the friendly spelling of an upgrade, and a raw number still wins', () => {
  assert.equal(poolLimit('ollama'), 3, 'Pro is the default');
  process.env.PROVIDER_PLAN_OLLAMA = 'max';
  try {
    assert.equal(poolLimit('ollama'), 8, 'Max maps to the operator ceiling of 8, under the documented 10');
    process.env.PROVIDER_PLAN_OLLAMA = 'MAX';
    assert.equal(poolLimit('ollama'), 8, 'plan names are case-insensitive');
    process.env.PROVIDER_PLAN_OLLAMA = 'pro';
    assert.equal(poolLimit('ollama'), 3);
    // A box that really wants all 10 says so as a number and owns it.
    process.env.PROVIDER_CONCURRENCY_OLLAMA = '10';
    try {
      assert.equal(poolLimit('ollama'), 10, 'the raw number outranks the tier');
    } finally {
      delete process.env.PROVIDER_CONCURRENCY_OLLAMA;
    }
    // An unknown plan name must not silently become some other number.
    process.env.PROVIDER_PLAN_OLLAMA = 'ultra-platinum';
    assert.equal(poolLimit('ollama'), 3, 'an unknown plan falls back to the default, never to a guess');
    // A provider with no tier table at all is unaffected by a plan name.
    process.env.PROVIDER_PLAN_DEEPSEEK = 'max';
    assert.equal(poolLimit('deepseek'), DEFAULT_PROVIDER_CONCURRENCY.deepseek);
  } finally {
    delete process.env.PROVIDER_PLAN_OLLAMA;
    delete process.env.PROVIDER_PLAN_DEEPSEEK;
  }
  assert.equal(poolLimit('ollama'), 3);
});

test('Agnes is 50 flat — every Agnes client runs agnes-3.0-flash, so there is no tier to pick', () => {
  assert.equal(DEFAULT_PROVIDER_CONCURRENCY.agnes, 50);
  assert.equal(poolLimit('agnes'), 50);
  process.env.PROVIDER_CONCURRENCY_AGNES = '12';
  try {
    assert.equal(poolLimit('agnes'), 12, 'the raw override still works');
  } finally {
    delete process.env.PROVIDER_CONCURRENCY_AGNES;
  }
});

test('company-config provider_plans works too, and provider_concurrency outranks it', () => {
  const cwd = process.cwd();
  const box = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-pool-plans-'));
  fs.mkdirSync(path.join(box, 'config'), { recursive: true });
  const write = (body: unknown) => {
    fs.writeFileSync(path.join(box, 'config', 'company-config.json'), JSON.stringify(body));
    invalidateCompanyConfigCache();
  };
  process.chdir(box);
  try {
    write({ companyName: 'Fixture', provider_plans: { 'ollama-cloud': 'max' } });
    assert.equal(poolLimit('ollama'), 8, 'the plan key is canonicalised like every other');
    write({ companyName: 'Fixture', provider_plans: { ollama: 'max' }, provider_concurrency: { ollama: 5 } });
    assert.equal(poolLimit('ollama'), 5, 'a raw number in the file outranks a plan in the file');
    process.env.PROVIDER_PLAN_OLLAMA = 'pro';
    try {
      assert.equal(poolLimit('ollama'), 3, 'the environment outranks the whole file');
    } finally {
      delete process.env.PROVIDER_PLAN_OLLAMA;
    }
  } finally {
    process.chdir(cwd);
    invalidateCompanyConfigCache();
  }
});

// ── Self-calibration (v7.6.37 B) ─────────────────────────────────────────────

test('a 429 lowers the pool limit as well as shutting it, and the floor is 1', () => {
  const db = fixture();
  try {
    assert.equal(effectiveLimit('ollama', db), 3, 'nothing learned yet, so the configured limit stands');
    for (let i = 3; i >= 1; i -= 1) {
      const noted = noteProviderRateLimit('ollama', db)!;
      assert.equal(noted.effective_limit, Math.max(1, i - 1));
      assert.equal(effectiveLimit('ollama', db), Math.max(1, i - 1));
    }
    noteProviderRateLimit('ollama', db);
    assert.equal(effectiveLimit('ollama', db), 1, 'a pool can never calibrate itself shut');
    assert.equal(effectiveLimit('deepseek', db), DEFAULT_PROVIDER_CONCURRENCY.deepseek, 'one pool learning teaches the others nothing');
  } finally {
    db.close();
  }
});

test('the learned limit is what reserveExecution enforces', () => {
  const db = fixture();
  try {
    noteProviderRateLimit('ollama', db); // 3 -> 2
    db.prepare("UPDATE provider_pool_state SET cooling_until='2000-01-01T00:00:00.000Z' WHERE provider='ollama'").run();
    assert.equal(effectiveLimit('ollama', db), 2);
    assert.ok(claim(db, 't1', 'e1', 'ollama').execution);
    assert.ok(claim(db, 't2', 'e2', 'ollama').execution);
    const refused = claim(db, 't3', 'e3', 'ollama');
    assert.equal(refused.reason, 'provider_at_capacity');
    assert.equal(refused.limit, 2, 'the LEARNED limit is what bites, not the brochure one');
    assert.match(refused.summary!, /^Ollama Cloud 2\/2 full/);
  } finally {
    db.close();
  }
});

test('a quiet provider grows its pool back one step per pass, and the row is dropped at the top', () => {
  const db = fixture();
  try {
    noteProviderRateLimit('ollama', db);
    noteProviderRateLimit('ollama', db); // 3 -> 1
    assert.equal(effectiveLimit('ollama', db), 1);

    // Still inside the quiet window: growth must NOT happen yet.
    assert.equal(growProviderPools(db), 0, 'a provider that just refused is not quiet');
    assert.equal(effectiveLimit('ollama', db), 1);

    // Age the last refusal past the recovery window.
    const quiet = new Date(Date.now() - PROVIDER_RECOVERY_MS - 60_000).toISOString();
    db.prepare('UPDATE provider_pool_state SET last_429_at=?,cooling_until=? WHERE provider=?').run(quiet, quiet, 'ollama');

    assert.equal(growProviderPools(db), 1);
    assert.equal(effectiveLimit('ollama', db), 2, 'one step per pass — the shrink is evidence, the growth is a guess');
    assert.equal(growProviderPools(db), 1);
    assert.equal(effectiveLimit('ollama', db), 3, 'back to the configured limit');
    assert.equal(growProviderPools(db), 0, 'nothing left to grow');
    assert.equal(
      (db.prepare("SELECT COUNT(*) AS n FROM provider_pool_state WHERE provider='ollama'").get() as { n: number }).n,
      0,
      'a pool with nothing to say holds no row',
    );
  } finally {
    db.close();
  }
});

test('lowering the configured plan takes effect at once, without waiting for a 429', () => {
  const db = fixture();
  try {
    process.env.PROVIDER_CONCURRENCY_OLLAMA = '8';
    try {
      assert.equal(effectiveLimit('ollama', db), 8);
      db.prepare("INSERT INTO provider_pool_state(provider,effective_limit,updated_at) VALUES('ollama',8,'2026-09-21T00:00:00.000Z')").run();
      assert.equal(effectiveLimit('ollama', db), 8);
    } finally {
      delete process.env.PROVIDER_CONCURRENCY_OLLAMA;
    }
    assert.equal(effectiveLimit('ollama', db), 3, 'the learned limit is clamped to the configured one');
  } finally {
    db.close();
  }
});

// ── The accounting stays on the PRIMARY (v7.6.40 correction) ────────────────
//
// An earlier draft let a full primary pool "overflow": it debited the first
// fallback pool with room and dispatched anyway, betting the runtime would land
// the run there. The runtime does not work that way. It advances its fallback
// chain only on `candidate_failed` / `skip_candidate` — after an attempt FAILS
// — and knows nothing about this box's pools, so every run attempts the primary
// first. Debiting a fallback while the run hits the primary under-counts the one
// subscription the pool protects, and errs in the UNSAFE direction.

const CHAIN = ['ollama/deepseek-v4.1-flash:cloud', 'agnes/agnes-3.0-flash', 'openrouter/meta/muse-spark-1.3-contributor'];

test('a reserve always debits the PRIMARY pool, never a fallback', () => {
  const db = fixture();
  try {
    const reserved = claim(db, 't1', 'e1', CHAIN);
    assert.ok(reserved.execution);
    assert.equal(reserved.provider, 'ollama', 'the primary is what the run will attempt');
    assert.equal(latestExecution('t1', db)!.provider, 'ollama');
    assert.equal(
      (db.prepare("SELECT COUNT(*) AS n FROM task_executions WHERE provider='agnes'").get() as { n: number }).n,
      0,
      'a fallback pool is never debited for a run that has not failed over to it',
    );
  } finally {
    db.close();
  }
});

test('a full PRIMARY refuses even when a fallback has room — and says where the room is', () => {
  const db = fixture();
  try {
    for (const [taskId, eid] of [['t1', 'e1'], ['t2', 'e2'], ['t3', 'e3']]) {
      assert.ok(claim(db, taskId, eid, 'ollama').execution);
    }
    const refused = claim(db, 't4', 'e4', CHAIN);
    assert.equal(refused.execution, undefined, 'dispatching here would put a 4th run on a 3-slot plan');
    assert.equal(refused.reason, 'provider_at_capacity');
    assert.equal(refused.provider, 'ollama');
    assert.equal(refused.running, 3);
    assert.equal(refused.limit, 3);
    assert.deepEqual(refused.fallbacksWithRoom, ['agnes', 'openrouter'], 'the owner-ask layer reads this');
    assert.equal(refused.summary, 'Ollama Cloud 3/3 full; Agnes AI 0/50 and OpenRouter 0/100 have room');
    assert.equal(
      (db.prepare("SELECT COUNT(*) AS n FROM task_executions WHERE task_id='t4'").get() as { n: number }).n,
      0,
      'nothing was reserved anywhere',
    );
  } finally {
    db.close();
  }
});

test('the refusal reports a fallback that is ALSO full as having no room', () => {
  const db = fixture();
  try {
    process.env.PROVIDER_CONCURRENCY_AGNES = '1';
    process.env.PROVIDER_CONCURRENCY_OPENROUTER = '1';
    try {
      for (const [taskId, eid] of [['t1', 'e1'], ['t2', 'e2'], ['t3', 'e3']]) {
        assert.ok(claim(db, taskId, eid, 'ollama').execution);
      }
      assert.ok(claim(db, 't5', 'e5', 'agnes').execution);
      assert.ok(claim(db, 't6', 'e6', 'openrouter').execution);
      const refused = claim(db, 't4', 'e4', CHAIN);
      assert.equal(refused.reason, 'provider_at_capacity');
      assert.deepEqual(refused.fallbacksWithRoom, []);
      assert.equal(refused.summary, 'Ollama Cloud 3/3 full; no fallback has room (Agnes AI 1/1, OpenRouter 1/1)');
    } finally {
      delete process.env.PROVIDER_CONCURRENCY_AGNES;
      delete process.env.PROVIDER_CONCURRENCY_OPENROUTER;
    }
  } finally {
    db.close();
  }
});

test('an agent with no fallback says so, rather than implying one exists', () => {
  const db = fixture();
  try {
    for (const [taskId, eid] of [['t1', 'e1'], ['t2', 'e2'], ['t3', 'e3']]) {
      assert.ok(claim(db, taskId, eid, 'ollama').execution);
    }
    const refused = claim(db, 't4', 'e4', ['ollama/deepseek-v4.1-flash:cloud']);
    assert.equal(refused.reason, 'provider_at_capacity');
    assert.deepEqual(refused.fallbacksWithRoom, []);
    assert.equal(refused.summary, 'Ollama Cloud 3/3 full; this agent declares no fallback');
  } finally {
    db.close();
  }
});

test('a COOLING primary refuses too, and the summary says cooling rather than full', () => {
  const db = fixture();
  try {
    noteProviderRateLimit('ollama', db);
    const refused = claim(db, 't1', 'e1', CHAIN);
    assert.equal(refused.execution, undefined);
    assert.equal(refused.reason, 'provider_at_capacity');
    assert.match(refused.summary!, /^Ollama Cloud 0\/2 \(cooling\); /);
    assert.deepEqual(refused.fallbacksWithRoom, ['agnes', 'openrouter']);
  } finally {
    db.close();
  }
});

test('probeChain reads the whole list but selects nothing', () => {
  const db = fixture();
  try {
    const { primary, fallbacks } = probeChain(CHAIN, db);
    assert.equal(primary.provider, 'ollama');
    assert.deepEqual(fallbacks.map((p) => p.provider), ['agnes', 'openrouter']);
    assert.equal(
      poolPressureSummary(primary, fallbacks),
      'Ollama Cloud 0/3 full; Agnes AI 0/50 and OpenRouter 0/100 have room',
    );
  } finally {
    db.close();
  }
});

test('sovereignty: the refusal never names a provider outside the agent own list', () => {
  const db = fixture();
  try {
    for (const [taskId, eid] of [['t1', 'e1'], ['t2', 'e2'], ['t3', 'e3']]) {
      assert.ok(claim(db, taskId, eid, 'ollama').execution);
    }
    const refused = claim(db, 't4', 'e4', ['ollama/x', 'agnes/y']);
    assert.deepEqual(refused.fallbacks!.map((p) => p.provider), ['agnes']);
    assert.ok(!refused.summary!.includes('DeepSeek'), 'a provider the agent never declared is never suggested');
  } finally {
    db.close();
  }
});
