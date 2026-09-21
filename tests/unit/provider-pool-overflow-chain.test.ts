/**
 * provider-pool-overflow-chain.test.ts — the agent's OWN model list, and the
 * migration that lets a pool learn.
 *
 * The provider-capacity pools overflow along the agent's configured model
 * chain: primary first, then the fallbacks its own OpenClaw entry declares. The
 * chain must be read the way the RUNTIME reads it, because the runtime is what
 * actually performs the fallback — `chat.send` rejects a per-run `model`, but
 * the runtime walks this same list itself and counts `rate_limit` as a failover
 * reason. A chain read differently here would debit a pool the run never uses.
 *
 * The rule mirrored (from the installed OpenClaw dist,
 * `resolveSelectedModelFallbacksOverride`): an entry that resolves a PRIMARY
 * owns its fallback list, even when that list is empty or absent — a bare
 * string model means "this model, no fallbacks", not "inherit the defaults".
 * Only an entry with no primary at all falls through to `agents.defaults.model`.
 *
 *   node --import tsx --test tests/unit/provider-pool-overflow-chain.test.ts
 */

import './_isolated-db'; // MUST be the first DB-reaching import (C8 guard).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { resolveRuntimeModelChainFromConfig, resolveRuntimeModelFromConfig } from '../../src/lib/runtime-model';
import { providerOf } from '../../src/lib/capacity/provider-pools';
import { migrations } from '../../src/lib/db/migrations';
import type { Agent } from '../../src/lib/types';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-pool-chain-'));

/** Mirrors the live fleet shape: `agents.entries`, every entry carrying its own
 * `{primary, fallbacks}`, plus a defaults block for entries that carry none. */
function writeConfig(body: unknown): string {
  const p = path.join(DIR, `openclaw-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(p, JSON.stringify(body));
  return p;
}

function agent(partial: Partial<Agent> = {}): Agent {
  return {
    id: 'a', name: 'Marketing', role: 'Marketing', avatar_emoji: '🤖', status: 'standby',
    is_master: false, workspace_id: 'marketing',
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    ...partial,
  };
}

const DEFAULTS = {
  primary: 'agnes/agnes-3.0-flash',
  fallbacks: ['ollama/deepseek-v4.1-flash:cloud', 'openrouter/meta/muse-spark-1.3-contributor'],
};

test('the chain is the primary followed by the entry own fallbacks, in order', () => {
  const config = writeConfig({
    agents: {
      defaults: { model: DEFAULTS },
      entries: {
        'dept-marketing': {
          model: {
            primary: 'ollama/deepseek-v4.1-flash:cloud',
            fallbacks: ['agnes/agnes-3.0-flash', 'openrouter/meta/muse-spark-1.3-contributor'],
          },
        },
      },
    },
  });
  const chain = resolveRuntimeModelChainFromConfig(agent(), 'marketing', config);
  assert.deepEqual(chain, [
    'ollama/deepseek-v4.1-flash:cloud',
    'agnes/agnes-3.0-flash',
    'openrouter/meta/muse-spark-1.3-contributor',
  ]);
  assert.deepEqual(chain.map(providerOf), ['ollama', 'agnes', 'openrouter'], 'three distinct pools to overflow through');
  assert.equal(
    resolveRuntimeModelFromConfig(agent(), 'marketing', config)?.model_id,
    chain[0],
    'the existing single-model resolver still answers with the primary',
  );
});

test('an entry with a primary and NO fallbacks key owns an empty list — it does not inherit', () => {
  const config = writeConfig({
    agents: {
      defaults: { model: DEFAULTS },
      entries: { 'dept-marketing': { model: { primary: 'ollama/deepseek-v4.1-flash:cloud' } } },
    },
  });
  assert.deepEqual(
    resolveRuntimeModelChainFromConfig(agent(), 'marketing', config),
    ['ollama/deepseek-v4.1-flash:cloud'],
    'inheriting the defaults here would overflow onto a model the runtime would never pick',
  );
});

test('a BARE STRING model means that model and no fallbacks', () => {
  const config = writeConfig({
    agents: {
      defaults: { model: DEFAULTS },
      entries: { 'dept-marketing': { model: 'ollama/deepseek-v4.1-flash:cloud' } },
    },
  });
  assert.deepEqual(resolveRuntimeModelChainFromConfig(agent(), 'marketing', config), ['ollama/deepseek-v4.1-flash:cloud']);
});

test('an entry with no primary inherits agents.defaults.model whole — primary AND fallbacks', () => {
  const config = writeConfig({
    agents: {
      defaults: { model: DEFAULTS },
      entries: { 'dept-marketing': { name: 'Marketing' } },
    },
  });
  assert.deepEqual(resolveRuntimeModelChainFromConfig(agent(), 'marketing', config), [DEFAULTS.primary, ...DEFAULTS.fallbacks]);
});

test('an agent with no entry at all still inherits the defaults chain', () => {
  const config = writeConfig({ agents: { defaults: { model: DEFAULTS }, entries: { other: { model: { primary: 'x/y' } } } } });
  assert.deepEqual(resolveRuntimeModelChainFromConfig(agent(), 'marketing', config), [DEFAULTS.primary, ...DEFAULTS.fallbacks]);
});

test('a fallback repeating the primary is not a second chance at the same pool', () => {
  const config = writeConfig({
    agents: {
      entries: {
        'dept-marketing': {
          model: { primary: 'ollama/a', fallbacks: ['ollama/a', 'agnes/b', 'agnes/b'] },
        },
      },
    },
  });
  assert.deepEqual(resolveRuntimeModelChainFromConfig(agent(), 'marketing', config), ['ollama/a', 'agnes/b']);
});

test('no config, no chain — the caller falls back to the CC agents.model column', () => {
  assert.deepEqual(resolveRuntimeModelChainFromConfig(agent(), 'marketing', path.join(DIR, 'does-not-exist.json')), []);
  const empty = writeConfig({ agents: { entries: {} } });
  assert.deepEqual(resolveRuntimeModelChainFromConfig(agent(), 'marketing', empty), []);
});

test('openclaw_agent_id pins the entry exactly, ignoring slug derivation', () => {
  const config = writeConfig({
    agents: {
      entries: {
        'dept-marketing': { model: { primary: 'ollama/wrong', fallbacks: [] } },
        'pinned-runtime': { model: { primary: 'agnes/right', fallbacks: ['openrouter/also-right'] } },
      },
    },
  });
  assert.deepEqual(
    resolveRuntimeModelChainFromConfig(agent({ openclaw_agent_id: 'pinned-runtime' }), 'marketing', config),
    ['agnes/right', 'openrouter/also-right'],
  );
});

// ── Migration 152 ────────────────────────────────────────────────────────────

const migration152 = migrations.find((m) => m.id === '152');

test('migration 152 folds provider_cooldowns into provider_pool_state, carrying live cooldowns', () => {
  assert.ok(migration152, 'migration 152 must exist');
  const db = new Database(':memory:');
  try {
    // The exact migration-150 shape, with one pool currently shut.
    db.exec(`CREATE TABLE provider_cooldowns (provider TEXT PRIMARY KEY, until TEXT NOT NULL, updated_at TEXT NOT NULL);
      INSERT INTO provider_cooldowns VALUES('ollama','2999-01-01T00:00:00.000Z','2026-09-21T00:00:00.000Z');`);

    migration152!.up(db);

    assert.equal(
      (db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='provider_cooldowns'").get() as { n: number }).n,
      0,
      'the superseded table is gone, not left to drift',
    );
    const row = db.prepare("SELECT * FROM provider_pool_state WHERE provider='ollama'").get() as {
      effective_limit: number | null; last_429_at: string | null; cooling_until: string | null;
    };
    assert.equal(row.cooling_until, '2999-01-01T00:00:00.000Z', 'a pool that is shut RIGHT NOW stays shut across the upgrade');
    assert.equal(row.effective_limit, null, 'the old table knew no learned limit, and NULL means "use the configured one"');
    assert.equal(row.last_429_at, null);
  } finally {
    db.close();
  }
});

test('migration 152 is idempotent and safe on a box that never had the old table', () => {
  const db = new Database(':memory:');
  try {
    migration152!.up(db);
    migration152!.up(db);
    const columns = (db.prepare('PRAGMA table_info(provider_pool_state)').all() as { name: string }[]).map((c) => c.name);
    assert.deepEqual(columns.sort(), ['cooling_until', 'effective_limit', 'last_429_at', 'provider', 'updated_at']);
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM provider_pool_state').get() as { n: number }).n, 0);
  } finally {
    db.close();
  }
});
