/**
 * tavily-key-resolution.test.ts
 *
 * THE DEFECT (live, client Mac, 2026-09-21): `src/lib/tavily.ts` read
 * `process.env.TAVILY_API_KEY` and nothing else. The key on that box lives in
 * `~/.openclaw/secrets/.env`, never in the Command Center's `.env.local`, so
 * every dispatch-time SOP authoring pass threw
 * "[sop-authoring] Unexpected error ... TAVILY_API_KEY is not set" and left its
 * "Author SOP" card parked `in_progress` with no visible cause.
 *
 * Proven here:
 *   1. POSITIVE — a key present ONLY in an OpenClaw secret store (and absent
 *      from `process.env`) resolves.
 *   2. NEGATIVE CONTROL — same instrument, every store emptied: resolution
 *      returns null. Without this the positive could pass on a stray real key.
 *   3. `process.env` still wins over the stores (authoritative, never clobbered).
 *   4. VISIBILITY — when authoring throws (the live failure: no Tavily key
 *      anywhere), the authoring card is BLOCKED with block_reason
 *      `sop_authoring_failed` / audience SYSTEM and carries an activity row
 *      naming the error. It never sits silently in_progress.
 *
 * No network: every path here fails key resolution before any fetch, or reads
 * a temp file. Run:
 *   node --import tsx --test tests/unit/tavily-key-resolution.test.ts
 */

import './_isolated-db'; // MUST be first: points DATABASE_PATH at a throwaway DB.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { v4 as uuidv4 } from 'uuid';

import { getDb, run, queryOne, autoSeedTrioAgents } from '../../src/lib/db';
import { resolveTavilyApiKey } from '../../src/lib/tavily';
import { authorSOPForTask } from '../../src/lib/sop-authoring';

/**
 * Run `fn` with every OpenClaw secret store the resolver probes pointed at a
 * scratch directory, so the developer's REAL `~/.openclaw` files can neither
 * satisfy the positive case nor poison the negative control. `contents` seeds
 * files under that fake home / project dir.
 */
async function withIsolatedStores(
  contents: { projectEnv?: string; homeEnv?: string; secretsEnv?: string; openclawJson?: string },
  fn: () => void | Promise<void>,
): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tavily-stores-'));
  const home = path.join(root, 'home');
  const projectDir = path.join(root, 'project');
  fs.mkdirSync(path.join(home, '.openclaw', 'secrets'), { recursive: true });
  fs.mkdirSync(projectDir, { recursive: true });
  if (contents.projectEnv !== undefined) fs.writeFileSync(path.join(projectDir, '.env'), contents.projectEnv);
  if (contents.homeEnv !== undefined) fs.writeFileSync(path.join(home, '.openclaw', '.env'), contents.homeEnv);
  if (contents.secretsEnv !== undefined) {
    fs.writeFileSync(path.join(home, '.openclaw', 'secrets', '.env'), contents.secretsEnv);
  }
  if (contents.openclawJson !== undefined) {
    fs.writeFileSync(path.join(home, '.openclaw', 'openclaw.json'), contents.openclawJson);
  }

  const saved: Record<string, string | undefined> = {
    HOME: process.env.HOME,
    OPENCLAW_PLATFORM: process.env.OPENCLAW_PLATFORM,
    OPENCLAW_PROJECT_DIR: process.env.OPENCLAW_PROJECT_DIR,
    TAVILY_API_KEY: process.env.TAVILY_API_KEY,
    TAVILY_FIXTURE_JSON_PATH: process.env.TAVILY_FIXTURE_JSON_PATH,
  };
  process.env.HOME = home;
  // mac-mini keeps the resolver off the Docker /data paths, which this fake
  // home cannot stand in for.
  process.env.OPENCLAW_PLATFORM = 'mac-mini';
  if (contents.projectEnv !== undefined) process.env.OPENCLAW_PROJECT_DIR = projectDir;
  else delete process.env.OPENCLAW_PROJECT_DIR;
  delete process.env.TAVILY_API_KEY;
  delete process.env.TAVILY_FIXTURE_JSON_PATH;
  try {
    await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// ── 1. POSITIVE: key lives only in ~/.openclaw/secrets/.env ─────────────────

test('resolveTavilyApiKey() finds a key present only in ~/.openclaw/secrets/.env', async () => {
  await withIsolatedStores({ secretsEnv: 'TAVILY_API_KEY=tvly-from-secrets-store\n' }, () => {
    assert.equal(process.env.TAVILY_API_KEY, undefined, 'precondition: process.env is empty');
    assert.equal(resolveTavilyApiKey(), 'tvly-from-secrets-store');
  });
});

test('resolveTavilyApiKey() finds a key present only in openclaw.json env', async () => {
  await withIsolatedStores({ openclawJson: JSON.stringify({ env: { TAVILY_API_KEY: 'tvly-from-json' } }) }, () => {
    assert.equal(resolveTavilyApiKey(), 'tvly-from-json');
  });
});

// ── 2. NEGATIVE CONTROL: same instrument, no key anywhere ───────────────────

test('resolveTavilyApiKey() returns null when no store holds the key (control)', async () => {
  await withIsolatedStores({}, () => {
    assert.equal(resolveTavilyApiKey(), null, 'a bare environment must NOT produce a key');
  });
});

// ── 3. process.env stays authoritative ──────────────────────────────────────

test('resolveTavilyApiKey() prefers process.env over the stores', async () => {
  await withIsolatedStores({ secretsEnv: 'TAVILY_API_KEY=tvly-from-store\n' }, () => {
    process.env.TAVILY_API_KEY = 'tvly-from-process-env';
    assert.equal(resolveTavilyApiKey(), 'tvly-from-process-env');
  });
});

// ── 4. A failed authoring run parks its card instead of stranding it ────────

test('authorSOPForTask blocks its authoring card when research fails (no silent in_progress)', async () => {
  const db = getDb();
  const dept = 'widget-forging-custom'; // custom (non-canonical) dept
  const wsId = `${dept}-${uuidv4()}`;
  run('INSERT INTO workspaces (id, name, slug, sort_order) VALUES (?, ?, ?, 1010)', [wsId, 'Widget Forging', dept]);
  autoSeedTrioAgents(db);

  const orig = uuidv4();
  run('INSERT INTO tasks (id, title, workspace_id, status) VALUES (?, ?, ?, ?)', [
    orig, 'Forge a custom widget', wsId, 'backlog',
  ]);

  // No key in ANY store → tavilySearch throws → the outer catch must park the card.
  let result: Awaited<ReturnType<typeof authorSOPForTask>> | undefined;
  await withIsolatedStores({}, async () => {
    result = await authorSOPForTask({
      originalTaskId: orig,
      title: 'Forge a custom widget',
      description: null,
      department: dept,
      agentRoleSlug: null,
      workspaceId: wsId,
    });
  });

  assert.equal(result!.status, 'error', 'the run failed (no research key anywhere)');

  const card = queryOne<{ id: string; status: string; block_reason: string | null; block_audience: string | null; ask: string | null }>(
    `SELECT id, status, block_reason, block_audience, ask FROM tasks WHERE sop_authoring_for_task_id = ?`,
    [orig],
  );
  assert.ok(card, 'the authoring card exists');
  assert.notEqual(card!.status, 'in_progress', 'the card must NOT be left running');
  assert.equal(card!.status, 'blocked');
  assert.equal(card!.block_reason, 'sop_authoring_failed');
  assert.equal(card!.block_audience, 'SYSTEM');
  assert.ok((card!.ask ?? '').length > 0, 'a blocked card must carry an answerable ask');

  const activity = queryOne<{ message: string }>(
    `SELECT message FROM task_activities WHERE task_id = ? AND activity_type = 'error' ORDER BY created_at DESC LIMIT 1`,
    [card!.id],
  );
  assert.ok(activity, 'the failure is visible on the card Activity tab');
  assert.match(activity!.message, /TAVILY_API_KEY is not set/);
});
