/**
 * The provider resource ledger: balances that are real or null, never guessed.
 *
 * MUST import _isolated-db FIRST (before anything that transitively pulls in
 * '@/lib/db') so getDb() opens a throwaway file, never the real
 * mission-control.db.
 *
 * Every probe here is fed a stub `fetch` AND a stub key resolver. Both matter:
 * the real resolver walks this box's own secret stores, so a test that let it
 * through would read live credentials and could make a billed call against the
 * operator's account. Nothing in this file touches the network.
 */
import './_isolated-db';
import test from 'node:test';
import assert from 'node:assert/strict';
import { getDb } from '@/lib/db';
import {
  BALANCE_PROBES,
  BALANCE_NOT_EXPOSED,
  ensureProviderLedgerTable,
  isBalanceStale,
  priceOverrides,
  probeProviderBalance,
  providerPrice,
  poolSnapshots,
  readResourceLedger,
  refreshProviderBalances,
  storedBalances,
  writeBalance,
  BALANCE_STALE_MS,
} from '@/lib/capacity/resource-ledger';
import type { KeyDetectionResult, LocalEndpointResult } from '@/lib/provider-key-detection';

/** A key resolver that always answers "found", without reading any store. */
const keyFound = (): KeyDetectionResult | LocalEndpointResult => ({
  found: true,
  envVar: 'TEST_KEY',
  source: 'process.env',
  value: 'test-key-value',
});

/** A key resolver that always answers "absent", without reading any store. */
const keyMissing = (): KeyDetectionResult | LocalEndpointResult => ({
  found: false,
  checked: ['OPENROUTER_API_KEY', 'OPENROUTER_KEY'],
});

/** A `fetch` stub that returns one JSON body and records that it was called. */
function stubFetch(body: unknown, init: { ok?: boolean; status?: number } = {}) {
  const calls: string[] = [];
  const impl = (async (url: unknown) => {
    calls.push(String(url));
    return {
      ok: init.ok ?? true,
      status: init.status ?? 200,
      json: async () => body,
    };
  }) as unknown as typeof fetch;
  return { impl, calls };
}

/** A `fetch` stub that FAILS the test if it is ever called. */
const forbiddenFetch = (async (url: unknown) => {
  throw new Error(`no probe should have been attempted, but one hit ${String(url)}`);
}) as unknown as typeof fetch;

function resetLedger() {
  const db = getDb();
  ensureProviderLedgerTable(db);
  db.exec('DELETE FROM provider_ledger');
}

// ── A. OpenRouter — https://openrouter.ai/docs/api-reference/limits ──────────

test('OpenRouter: limit_remaining is read as the remaining balance in USD', async () => {
  const { impl, calls } = stubFetch({ data: { label: 'k', limit: 50, limit_remaining: 12.5, usage: 37.5 } });
  const result = await probeProviderBalance('openrouter', { fetchImpl: impl, resolveKey: keyFound });
  assert.equal(result.balance, 12.5);
  assert.equal(result.currency, 'USD');
  assert.equal(result.error, null);
  assert.deepEqual(calls, ['https://openrouter.ai/api/v1/key']);
});

test('OpenRouter: an UNCAPPED key (limit_remaining null) is not zero and not an error', async () => {
  // The single most dangerous misread in this module. A key with no spending
  // cap reports limit_remaining: null. Treating that as 0 would refuse every
  // job on the one provider the client can always reach.
  const { impl } = stubFetch({ data: { label: 'k', limit: null, limit_remaining: null, usage: 4 } });
  const result = await probeProviderBalance('openrouter', { fetchImpl: impl, resolveKey: keyFound });
  assert.equal(result.balance, null);
  assert.equal(result.currency, null);
  assert.equal(result.error, null, 'no cap declared is an absent number, not a failed probe');
});

test('OpenRouter: a non-2xx answer records the status and yields no balance', async () => {
  const { impl } = stubFetch({}, { ok: false, status: 401 });
  const result = await probeProviderBalance('openrouter', { fetchImpl: impl, resolveKey: keyFound });
  assert.equal(result.balance, null);
  assert.match(String(result.error), /HTTP 401/);
});

test('a provider with no key on this box names what was checked and never calls out', async () => {
  const result = await probeProviderBalance('openrouter', {
    fetchImpl: forbiddenFetch,
    resolveKey: keyMissing,
  });
  assert.equal(result.balance, null);
  assert.match(String(result.error), /no api key/i);
  assert.match(String(result.error), /OPENROUTER_API_KEY/, 'the error must name the candidates it checked');
});

// ── B. DeepSeek — https://api-docs.deepseek.com/api/get-user-balance ─────────

test('DeepSeek: the USD row wins over CNY, and the documented STRING amount parses', async () => {
  const { impl, calls } = stubFetch({
    is_available: true,
    balance_infos: [
      { currency: 'CNY', total_balance: '77.00', granted_balance: '0.00', topped_up_balance: '77.00' },
      { currency: 'USD', total_balance: '3.10', granted_balance: '0.00', topped_up_balance: '3.10' },
    ],
  });
  const result = await probeProviderBalance('deepseek', { fetchImpl: impl, resolveKey: keyFound });
  assert.equal(result.balance, 3.1);
  assert.equal(result.currency, 'USD');
  assert.equal(result.error, null);
  assert.deepEqual(calls, ['https://api.deepseek.com/user/balance']);
});

test('DeepSeek: a CNY-only account reports CNY rather than pretending it is dollars', async () => {
  const { impl } = stubFetch({
    is_available: true,
    balance_infos: [{ currency: 'CNY', total_balance: '77.00' }],
  });
  const result = await probeProviderBalance('deepseek', { fetchImpl: impl, resolveKey: keyFound });
  assert.equal(result.balance, 77);
  assert.equal(result.currency, 'CNY');
});

test('DeepSeek: an empty balance_infos array yields null, not zero', async () => {
  const { impl } = stubFetch({ is_available: false, balance_infos: [] });
  const result = await probeProviderBalance('deepseek', { fetchImpl: impl, resolveKey: keyFound });
  assert.equal(result.balance, null);
  assert.equal(result.error, null);
});

// ── C. Providers that publish no balance are never probed ───────────────────

test('a provider documented as publishing no balance is never called and records no error', async () => {
  for (const provider of Object.keys(BALANCE_NOT_EXPOSED)) {
    const result = await probeProviderBalance(provider, {
      fetchImpl: forbiddenFetch,
      resolveKey: keyFound,
    });
    assert.equal(result.balance, null, `${provider} must report a null balance`);
    assert.equal(result.error, null, `${provider} publishes none — that is not a probe failure`);
  }
});

test('the probe table only contains providers that have a documented endpoint', () => {
  assert.deepEqual(Object.keys(BALANCE_PROBES).sort(), ['deepseek', 'openrouter']);
  for (const spec of Object.values(BALANCE_PROBES)) {
    assert.match(spec.url, /^https:\/\//, 'a probe URL must be the vendor https endpoint');
  }
  for (const provider of Object.keys(BALANCE_NOT_EXPOSED)) {
    assert.ok(!(provider in BALANCE_PROBES), `${provider} cannot be both probed and not exposed`);
  }
});

// ── D. Price precedence: env override > model catalog > null ────────────────

test('price override parsing rejects malformed entries instead of guessing', () => {
  const parsed = priceOverrides('ollama-cloud=0/0,agnes=0/0,broken,bad=x/y,neg=-1/2');
  assert.deepEqual(parsed, { 'ollama-cloud': { in: 0, out: 0 }, agnes: { in: 0, out: 0 } });
});

test('an env override outranks the model catalog, and the catalog outranks nothing', () => {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS model_registry (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      model_id TEXT UNIQUE NOT NULL,
      label TEXT NOT NULL,
      provider TEXT NOT NULL,
      family TEXT,
      context_window INTEGER,
      input_cost_per_million REAL,
      output_cost_per_million REAL,
      pricing_model TEXT DEFAULT 'per_token',
      pricing_source TEXT DEFAULT 'auto',
      capabilities TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'active',
      added_at TEXT, last_seen_at TEXT, raw_metadata TEXT DEFAULT '{}'
    )
  `);
  db.exec("DELETE FROM model_registry WHERE provider IN ('ledger-test','ollama-cloud','ledger-dead')");
  db.prepare(
    `INSERT INTO model_registry (model_id,label,provider,input_cost_per_million,output_cost_per_million,status)
     VALUES (?,?,?,?,?,'active')`,
  ).run('ledger-test/expensive', 'expensive', 'ledger-test', 9.0, 30.0);
  db.prepare(
    `INSERT INTO model_registry (model_id,label,provider,input_cost_per_million,output_cost_per_million,status)
     VALUES (?,?,?,?,?,'active')`,
  ).run('ledger-test/cheap', 'cheap', 'ledger-test', 0.25, 1.5);

  // No override: the CHEAPEST active row is the provider's price floor.
  assert.deepEqual(providerPrice('ledger-test', {}), { in: 0.25, out: 1.5 });

  // A registry spelling and its pool key are ONE subscription, so a price filed
  // under `ollama-cloud` is found when the ledger asks for `ollama`.
  db.prepare(
    `INSERT INTO model_registry (model_id,label,provider,input_cost_per_million,output_cost_per_million,status)
     VALUES (?,?,?,?,?,'active')`,
  ).run('ollama-cloud/flash', 'flash', 'ollama-cloud', 0.4, 0.9);
  assert.deepEqual(providerPrice('ollama', {}), { in: 0.4, out: 0.9 });

  // Override wins — this is how a subscription (which bills nothing per token)
  // is expressed, since no catalog can know it.
  assert.deepEqual(providerPrice('ledger-test', { 'ledger-test': { in: 0, out: 0 } }), { in: 0, out: 0 });

  // Neither source knows: null, never zero.
  assert.deepEqual(providerPrice('provider-with-no-rows', {}), { in: null, out: null });
});

test('a deprecated catalog row is not a price', () => {
  const db = getDb();
  db.exec("DELETE FROM model_registry WHERE provider = 'ledger-dead'");
  db.prepare(
    `INSERT INTO model_registry (model_id,label,provider,input_cost_per_million,output_cost_per_million,status)
     VALUES (?,?,?,?,?,'deprecated')`,
  ).run('ledger-dead/gone', 'gone', 'ledger-dead', 0.1, 0.2);
  assert.deepEqual(providerPrice('ledger-dead', {}), { in: null, out: null });
});

// ── E. Freshness ────────────────────────────────────────────────────────────

test('staleness: never read is stale, just read is fresh, past the window is stale', () => {
  const now = Date.parse('2026-09-21T12:00:00.000Z');
  assert.equal(isBalanceStale(null, now), true, 'a balance never read is stale');
  assert.equal(isBalanceStale('not-a-date', now), true, 'an unparseable stamp is stale');
  assert.equal(isBalanceStale(new Date(now - 1_000).toISOString(), now), false);
  assert.equal(isBalanceStale(new Date(now - BALANCE_STALE_MS).toISOString(), now), true);
  assert.equal(isBalanceStale(new Date(now - BALANCE_STALE_MS - 1).toISOString(), now), true);
});

// ── F. Ledger assembly + persistence ────────────────────────────────────────

test('a written balance round-trips; a null balance carries no as-of stamp', () => {
  resetLedger();
  writeBalance('openrouter', { balance: 12.5, currency: 'USD', error: null }, '2026-09-21T12:00:00.000Z');
  writeBalance('deepseek', { balance: null, currency: null, error: 'HTTP 401 from probe' }, '2026-09-21T12:00:00.000Z');

  const stored = storedBalances();
  assert.equal(stored.get('openrouter')?.balance, 12.5);
  assert.equal(stored.get('openrouter')?.balance_as_of, '2026-09-21T12:00:00.000Z');
  assert.equal(stored.get('deepseek')?.balance, null);
  assert.equal(
    stored.get('deepseek')?.balance_as_of,
    null,
    'an as-of stamp on a null balance would make "never read" look like "read as empty"',
  );
  assert.match(String(stored.get('deepseek')?.last_probe_error), /HTTP 401/);
});

test('the ledger merges pool state, stored balance and price into one row per provider', () => {
  resetLedger();
  writeBalance('openrouter', { balance: 12.5, currency: 'USD', error: null }, '2026-09-21T12:00:00.000Z');

  const pools = (provider: string) =>
    provider === 'openrouter'
      ? { slotsFree: 17, slotsLimit: 20, effectiveLimit: 20, coolingUntil: null }
      : { slotsFree: null, slotsLimit: null, effectiveLimit: null, coolingUntil: null };

  const ledger = readResourceLedger(pools);
  const openrouter = ledger.find((e) => e.provider === 'openrouter');
  assert.ok(openrouter, 'openrouter has a documented probe so it is always in the ledger');
  assert.equal(openrouter.slotsFree, 17);
  assert.equal(openrouter.slotsLimit, 20);
  assert.equal(openrouter.balance, 12.5);
  assert.equal(openrouter.balanceCurrency, 'USD');

  // Every provider documented as publishing no balance is present and null.
  for (const provider of Object.keys(BALANCE_NOT_EXPOSED)) {
    const row = ledger.find((e) => e.provider === provider);
    assert.ok(row, `${provider} must appear in the ledger`);
    assert.equal(row.balance, null);
    assert.equal(row.lastProbeError, null);
  }

  // Pool state is absent, not invented, when the pools do not know a provider.
  const unknownPool = ledger.find((e) => e.provider !== 'openrouter');
  assert.equal(unknownPool?.slotsFree, null);
});

test('refresh probes only stale providers and stamps the no-balance providers once', async () => {
  resetLedger();
  const fresh = new Date().toISOString();
  writeBalance('openrouter', { balance: 40, currency: 'USD', error: null }, fresh);

  const { impl, calls } = stubFetch({ balance_infos: [{ currency: 'USD', total_balance: '3.10' }] });
  const result = await refreshProviderBalances({ fetchImpl: impl, resolveKey: keyFound });

  assert.equal(result.skipped, 1, 'the fresh openrouter row must not be re-probed');
  assert.equal(result.probed, 1, 'only the stale deepseek row is probed');
  assert.deepEqual(calls, ['https://api.deepseek.com/user/balance']);
  assert.equal(result.withBalance, 1);

  const stored = storedBalances();
  assert.equal(stored.get('openrouter')?.balance, 40, 'the fresh value is untouched');
  assert.equal(stored.get('deepseek')?.balance, 3.1);
  for (const provider of Object.keys(BALANCE_NOT_EXPOSED)) {
    assert.ok(stored.has(provider), `${provider} gets a row so the API can say "not exposed" from data`);
    assert.equal(stored.get(provider)?.balance, null);
  }
});

test('force re-probes a fresh row', async () => {
  resetLedger();
  writeBalance('openrouter', { balance: 40, currency: 'USD', error: null }, new Date().toISOString());
  const { impl, calls } = stubFetch({ data: { limit_remaining: 11 } });
  const result = await refreshProviderBalances({ force: true, fetchImpl: impl, resolveKey: keyFound });
  assert.equal(result.skipped, 0);
  assert.ok(calls.includes('https://openrouter.ai/api/v1/key'));
  assert.equal(storedBalances().get('openrouter')?.balance, 11);
});

// ── G. The ledger reports the POOLS' own numbers, never its own count ───────

test('pool slots come from the capacity pools, and a cooldown is carried through', () => {
  const db = getDb();
  resetLedger();
  db.exec("DELETE FROM task_executions WHERE id LIKE 'ledger-exec-%'");
  db.exec("DELETE FROM provider_pool_state WHERE provider = 'ollama'");

  const agent = db.prepare('SELECT id FROM agents LIMIT 1').get() as { id: string };
  assert.ok(agent, 'the fixture seeds agents; without one this case would pass vacuously');
  // A task row of our own, so this case can never silently skip on an empty fixture.
  db.exec("DELETE FROM tasks WHERE id = 'ledger-task-1'");
  const workspace = db.prepare('SELECT id FROM workspaces LIMIT 1').get() as { id: string };
  assert.ok(workspace, 'the fixture seeds workspaces');
  db.prepare('INSERT INTO tasks (id,title,workspace_id) VALUES (?,?,?)').run(
    'ledger-task-1',
    'ledger pool fixture',
    workspace.id,
  );
  const taskRow = { id: 'ledger-task-1' };

  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO task_executions
      (id,task_id,assignment_version,agent_id,workspace_id,generation,worker_context,session_key,session_id,
       state,lease_owner,lease_expires_at,idempotency_key,provider,created_at,updated_at)
     VALUES (?,?,0,?,NULL,900,'[]',?,?,'running','o',?,?,'ollama',?,?)`,
  ).run('ledger-exec-1', taskRow.id, agent.id, 'ledger-sk-1', 'ledger-sid-1', now, 'ledger-idem-1', now, now);

  const until = new Date(Date.now() + 60_000).toISOString();
  // provider_pool_state supersedes provider_cooldowns (migration 152); the
  // cooldown is its `cooling_until` column. effective_limit stays NULL so this
  // case still measures the CONFIGURED limit, as it always did.
  db.prepare(
    'INSERT OR REPLACE INTO provider_pool_state (provider,effective_limit,last_429_at,cooling_until,updated_at) VALUES (?,NULL,NULL,?,?)',
  ).run('ollama', until, now);

  const snapshot = poolSnapshots()('ollama-cloud'); // the REGISTRY spelling resolves to the ollama pool
  assert.equal(typeof snapshot.slotsLimit, 'number');
  assert.equal(
    snapshot.slotsFree,
    Math.max(0, (snapshot.effectiveLimit ?? 0) - 1),
    'one running execution must show as one slot consumed',
  );
  assert.equal(snapshot.coolingUntil, until, 'a shut pool must say so through the ledger too');

  db.exec("DELETE FROM task_executions WHERE id LIKE 'ledger-exec-%'");
  db.exec("DELETE FROM provider_pool_state WHERE provider = 'ollama'");
  db.exec("DELETE FROM tasks WHERE id = 'ledger-task-1'");
});

test('an unknown provider gets nulls from the pools, never an invented ceiling', () => {
  const snapshot = poolSnapshots()('a-provider-no-pool-knows');
  assert.equal(snapshot.slotsFree, null);
  assert.equal(snapshot.slotsLimit, null);
  assert.equal(snapshot.effectiveLimit, null);
  assert.equal(snapshot.coolingUntil, null);
});
