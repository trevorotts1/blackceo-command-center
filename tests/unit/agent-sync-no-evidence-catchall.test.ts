/**
 * Agent-sync no-evidence parking fix (2026-10-12): resolveAgentDeptWorkspace
 * used to fall back to the literal workspace id 'default', which only
 * db:seed creates (seed.ts structural row). On a box that never ran seed —
 * like this installation — every boot skipped 24 gateway agents with
 * "FOREIGN KEY constraint failed" (agents.workspace_id → workspaces(id)):
 * log "Ingested 0 new + updated 56 … 24 agent(s) skipped", recurring daily
 * until fixed in commit 23f66331.
 *
 * Contract pinned here:
 *   1. A bare agent id that IS an existing workspace resolves there as
 *      CONFIRMED id evidence (same tier as dept-/head-agent- prefixes).
 *   2. A dept-<slug> agent whose slug matches NO workspace has NO id
 *      evidence: it must NOT be filed into a guessed workspace — it parks
 *      in the LIVE general-task catch-all (dept stays null).
 *   3. A no-evidence id (personal name lanes like 'trevor') parks in the
 *      live general-task catch-all, never 'default'.
 *   4. Legacy parity: with no live general-task workspace (all archived),
 *      the resolver keeps its pre-fix 'default' fallback.
 */
import './_isolated-db';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-agent-sync-catchall-'));
Object.assign(process.env, {
  DATABASE_PATH: path.join(root, 'fixture.db'), CC_TEST_FIXTURE_ROOT: root,
  OPENCLAW_ROOT: path.join(root, 'openclaw'), OPENCLAW_COMPANY_ROOT: path.join(root, 'company'),
  WORKSPACE_BASE_PATH: root, OPENCLAW_WORKSPACE_ROOT: root,
  BCC_DEVICE_IDENTITY_DIR: path.join(root, 'identity'),
  OPENCLAW_CLI_BIN: '/usr/bin/false', DISABLE_CRON: '1', DISABLE_BRIDGE_BOOTSTRAP: '1',
  OWNER_NOTIFY_TELEGRAM_DISABLED: '1', SOP_EMBEDDING_PROVIDER: 'openai', OPENAI_API_KEY: '',
  MC_INSTALLATION_ID: 'agent-sync-catchall-fixture',
});
delete process.env.MC_COMPANY_ID;
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error('agent-sync-catchall fixture forbids network'); };

let db: typeof import('../../src/lib/db');
let resolveAgentDeptWorkspace: typeof import('../../src/lib/openclaw/agent-sync')['resolveAgentDeptWorkspace'];

test.before(async () => {
  db = await import('../../src/lib/db');
  db.getDb(); // full migration chain against the temp DB

  ({ resolveAgentDeptWorkspace } = await import('../../src/lib/openclaw/agent-sync'));

  fs.mkdirSync(path.join(root, 'openclaw', 'agents', 'main'), { recursive: true });
  fs.writeFileSync(path.join(root, 'openclaw', 'openclaw.json'), JSON.stringify({ agents: { list: [{ id: 'main' }] } }));

  // The un-seeded-box shape: NO structural 'default' workspace row (seed.ts
  // never ran). This fixture has no company anchor, so migration 166 skipped
  // its catch-all insert (it needs a non-default company_id); the live box
  // HAS that row (company-anchored, see migration 166). Reproduce it here —
  // this is the LIVE general-task catch-all the fix parks agents into.
  db.run(
    `INSERT INTO workspaces (id, name, slug, description, icon, company_id, sort_order, created_at, updated_at)
     VALUES ('general-task', 'General Task', 'general-task', 'Catch-all lane: work that fits no other department', '🗂️', 'default', 99999, ?, ?)`,
    [new Date().toISOString(), new Date().toISOString()],
  );

  const noDefault = db
    .getDb()
    .prepare("SELECT 1 FROM workspaces WHERE id = 'default'")
    .get() as { id: string } | undefined;
  assert.equal(noDefault, undefined, 'fixture must mirror an un-seeded box: no structural default row');

  // A real department workspace reachable ONLY via bare-id confirmation.
  db.run(
    `INSERT INTO workspaces (id, name, slug, description, company_id, sort_order, created_at, updated_at)
     VALUES ('delivery', 'Delivery', 'delivery', 'bare-id fixture department', 'default', 424242, ?, ?)`,
    [new Date().toISOString(), new Date().toISOString()],
  );
});

test.after(() => {
  globalThis.fetch = originalFetch;
  db?.closeDb();
  fs.rmSync(root, { recursive: true, force: true });
});

test('a bare agent id that IS an existing workspace resolves there as confirmed evidence', () => {
  const r = resolveAgentDeptWorkspace(db.getDb(), 'delivery', 'Agent delivery');
  assert.equal(r.workspaceId, 'delivery');
  assert.equal(r.dept, 'delivery');
  // And it must exist in the table, not just be a guessed slug.
  assert.ok(
    db.getDb().prepare('SELECT 1 FROM workspaces WHERE id = ?').get(r.workspaceId),
    'resolved workspace must be a real row (the FK guarantee this fix restores)',
  );
});

test('a dept-<slug> agent with no matching workspace parks in the live catch-all, not a guessed row', () => {
  const r = resolveAgentDeptWorkspace(db.getDb(), 'dept-hr-people', 'Agent dept-hr-');
  assert.notEqual(r.workspaceId, 'hr-people', 'never trust an unconfirmed slug as a workspace id');
  assert.equal(r.workspaceId, 'general-task');
  assert.equal(r.dept, null, 'no confirmed department → dept stays null');
  assert.ok(
    db.getDb().prepare('SELECT 1 FROM workspaces WHERE id = ?').get(r.workspaceId),
    'catch-all parking must satisfy the FK too',
  );
});

test('a no-evidence agent id parks in the live general-task catch-all, never the structural default', () => {
  const r = resolveAgentDeptWorkspace(db.getDb(), 'trevor', 'Agent trevor');
  assert.equal(r.workspaceId, 'general-task');
  assert.notEqual(r.workspaceId, 'default');
  assert.ok(db.getDb().prepare('SELECT 1 FROM workspaces WHERE id = ?').get(r.workspaceId));
});

test('legacy parity: with no LIVE general-task workspace the resolver keeps its pre-fix default fallback', () => {
  const raw = db.getDb();
  raw.prepare("UPDATE workspaces SET archived_at = ? WHERE lower(id) = 'general-task'")
    .run(new Date().toISOString());
  try {
    const r = resolveAgentDeptWorkspace(raw, 'trevor', 'Agent trevor');
    assert.equal(r.workspaceId, 'default', 'pre-fix behavior preserved only when no live catch-all exists');
  } finally {
    raw.prepare("UPDATE workspaces SET archived_at = NULL WHERE lower(id) = 'general-task'").run();
  }
});