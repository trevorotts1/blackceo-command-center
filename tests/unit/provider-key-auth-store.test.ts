/**
 * v5.16.2 — FIX 4: Command Center must read OpenClaw's SQLite auth-profile store.
 *
 * THE BUG THIS EXISTS TO PREVENT
 * ------------------------------
 * OpenClaw keeps a provider key for Ollama Cloud in NEITHER an env file NOR
 * openclaw.json — it keeps it in its SQLite auth store:
 *
 *   <openclaw-dir>/agents/<agent>/agent/openclaw-agent.sqlite
 *     table auth_profile_store, row store_key='primary',
 *     store_json.profiles["ollama:default"] = {type:'api_key', provider:'ollama', key:<secret>}
 *
 * The gateway resolves the key from THAT store at runtime and sends it as a
 * Bearer to https://ollama.com. Command Center scanned only process.env, the
 * .env files and openclaw.json — so it reported `configured=false` for a key
 * that demonstrably exists and works, and ZERO models registered on every box
 * whose sovereign provider is Ollama Cloud.
 *
 * INVARIANTS asserted here:
 *   1. A key present ONLY in the SQLite store is found.
 *   2. env still WINS (no regression for boxes that carry the key in env).
 *   3. The key VALUE is never printed to any console channel.
 *   4. The store is never mutated (read-only).
 *   5. The agent dir is not hardcoded to `main`.
 *
 * Vitest (not the tsx --test glob): the module's dep tree uses '@/...' aliases,
 * which only vitest resolves. Registered in vitest.config.ts `include`.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import Database from 'better-sqlite3';

/** A fake key that is obviously not real, and long enough to look like one. */
const FAKE_STORE_KEY = 'sk-fake-authstore-key-for-tests-0000000000000000000000';
const FAKE_ENV_KEY = 'sk-fake-env-key-for-tests-1111111111111111111111111111';

let tmpRoot: string;
let openclawDir: string;
let storePath: string;

/**
 * Build a throwaway OpenClaw layout:
 *   <tmp>/.openclaw/openclaw.json                                  (no key inside)
 *   <tmp>/.openclaw/agents/<agentName>/agent/openclaw-agent.sqlite (the key lives here)
 * `agentName` defaults to something OTHER than "main" to prove the agent dir is
 * discovered, not hardcoded.
 */
function buildOpenClawLayout(agentName = 'dept-research'): void {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-authstore-'));
  openclawDir = path.join(tmpRoot, '.openclaw');
  const agentDir = path.join(openclawDir, 'agents', agentName, 'agent');
  fs.mkdirSync(agentDir, { recursive: true });

  // openclaw.json carries mode/provider but NO inline key — exactly like the field.
  fs.writeFileSync(
    path.join(openclawDir, 'openclaw.json'),
    JSON.stringify({ models: { providers: { 'ollama-cloud': { mode: 'cloud', provider: 'ollama' } } } }),
    'utf8',
  );

  storePath = path.join(agentDir, 'openclaw-agent.sqlite');
  const db = new Database(storePath);
  db.exec('CREATE TABLE auth_profile_store (store_key TEXT PRIMARY KEY, store_json TEXT NOT NULL)');
  db.prepare('INSERT INTO auth_profile_store (store_key, store_json) VALUES (?, ?)').run(
    'primary',
    JSON.stringify({
      profiles: {
        'ollama:default': { type: 'api_key', provider: 'ollama', key: FAKE_STORE_KEY },
        'anthropic:default': { type: 'api_key', provider: 'anthropic', key: 'sk-other-provider-key' },
      },
    }),
  );
  db.close();
}

function sha256(file: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/**
 * Import the module under test with `openclawConfigPath()` pointed at our temp
 * layout and the .env-file / openclaw.json env scanners stubbed empty, so the
 * ONLY place a key can come from is process.env or the SQLite store.
 */
async function loadModule() {
  vi.doMock('@/lib/platform', () => ({
    openclawConfigPath: () => path.join(openclawDir, 'openclaw.json'),
    resolveClientPath: (p: string) => p,
  }));
  vi.doMock('@/lib/studio/provider-discovery', () => ({
    candidateEnvFiles: () => [] as string[],
    parseDotEnv: () => ({}) as Record<string, string>,
    extractOpenclawEnv: () => ({}) as Record<string, string>,
    extractOpenclawProviderKeys: () => ({}) as Record<string, string>,
  }));
  return await import('@/lib/provider-key-detection');
}

/** The Ollama Cloud provider as the resolver sees it. */
const OLLAMA_CLOUD_PROVIDER = {
  slug: 'ollama-cloud',
  displayName: 'Ollama Cloud',
  authType: 'api_key',
  envCandidates: ['OLLAMA_CLOUD_API_KEY', 'OLLAMA_API_KEY'],
} as never;

describe('FIX 4 — resolveProviderApiKey reads OpenClaw’s SQLite auth_profile_store', () => {
  beforeEach(() => {
    vi.resetModules();
    delete process.env.OLLAMA_CLOUD_API_KEY;
    delete process.env.OLLAMA_API_KEY;
    buildOpenClawLayout();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.OLLAMA_CLOUD_API_KEY;
    delete process.env.OLLAMA_API_KEY;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  test('key present ONLY in the SQLite auth store is found (this is the whole bug)', async () => {
    const { resolveProviderApiKey } = await loadModule();

    const res = resolveProviderApiKey(OLLAMA_CLOUD_PROVIDER);

    expect('found' in res && res.found).toBe(true);
    if (!('found' in res) || !res.found) throw new Error('unreachable');
    expect(res.source).toBe('openclaw_auth_store');
    expect(res.value).toBe(FAKE_STORE_KEY);
    // The CC slug is `ollama-cloud`; OpenClaw stores it under provider `ollama`.
    // Resolving across that rename is the point.
  });

  test('the agent directory is NOT hardcoded to "main" (a differently-named agent still resolves)', async () => {
    // buildOpenClawLayout() used a non-"main" agent dir on purpose.
    expect(fs.existsSync(path.join(openclawDir, 'agents', 'main'))).toBe(false);
    const { resolveProviderApiKey } = await loadModule();

    const res = resolveProviderApiKey(OLLAMA_CLOUD_PROVIDER);
    expect('found' in res && res.found).toBe(true);
  });

  test('env still WINS over the auth store (no regression for boxes with the key in env)', async () => {
    process.env.OLLAMA_CLOUD_API_KEY = FAKE_ENV_KEY;
    const { resolveProviderApiKey } = await loadModule();

    const res = resolveProviderApiKey(OLLAMA_CLOUD_PROVIDER);

    expect('found' in res && res.found).toBe(true);
    if (!('found' in res) || !res.found) throw new Error('unreachable');
    expect(res.source).toBe('process.env');
    expect(res.value).toBe(FAKE_ENV_KEY);
    expect(res.value).not.toBe(FAKE_STORE_KEY);
  });

  test('the key VALUE is never written to any console channel', async () => {
    const spies = [
      vi.spyOn(console, 'log').mockImplementation(() => {}),
      vi.spyOn(console, 'warn').mockImplementation(() => {}),
      vi.spyOn(console, 'error').mockImplementation(() => {}),
      vi.spyOn(console, 'info').mockImplementation(() => {}),
      vi.spyOn(console, 'debug').mockImplementation(() => {}),
    ];

    const { resolveProviderApiKey } = await loadModule();
    const res = resolveProviderApiKey(OLLAMA_CLOUD_PROVIDER);
    expect('found' in res && res.found).toBe(true);

    for (const spy of spies) {
      for (const call of spy.mock.calls) {
        const line = call.map((a) => (typeof a === 'string' ? a : JSON.stringify(a ?? ''))).join(' ');
        expect(line).not.toContain(FAKE_STORE_KEY);
      }
    }
  });

  test('the auth store is READ-ONLY — Command Center never mutates OpenClaw’s key store', async () => {
    const before = sha256(storePath);
    const { resolveProviderApiKey } = await loadModule();

    resolveProviderApiKey(OLLAMA_CLOUD_PROVIDER);

    expect(sha256(storePath)).toBe(before);
  });

  test('a provider with no profile in the store is still reported not-found (no false positives)', async () => {
    const { resolveProviderApiKey } = await loadModule();

    const res = resolveProviderApiKey({
      slug: 'openrouter',
      displayName: 'OpenRouter',
      authType: 'api_key',
      envCandidates: ['OPENROUTER_API_KEY'],
    } as never);

    expect('found' in res && res.found).toBe(false);
  });
});
