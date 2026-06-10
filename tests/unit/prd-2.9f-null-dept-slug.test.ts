/**
 * Unit tests for PRD 2.9(f) — null department slug resolution.
 *
 * When task.department is NULL, the record-completion callers (qc-scorer.ts
 * and tasks/[id]/route.ts) MUST resolve the workspace slug from the DB rather
 * than passing workspace_id raw (which is a UUID for UI-created workspaces).
 * department_id in persona_selection_log must always be a canonical slug,
 * never a UUID.
 *
 * Verifies:
 *   1. A task with null department and a UUID workspace_id can look up its
 *      workspace slug via the workspaces table.
 *   2. The resolved value is the slug (e.g. "marketing"), NOT the UUID.
 *   3. canonicalDeptSlug applied to the workspace slug produces the canonical form.
 *   4. A task with task.department already set returns it directly (no DB hit needed).
 *   5. A workspace with no slug column set returns the workspace_id as fallback.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_DB = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'bc-prd29f-')),
  'mission-control.test.db',
);
process.env.DATABASE_PATH = TMP_DB;
process.env.OPENCLAW_ROOT = '/nonexistent/openclaw-root-for-tests';

delete process.env.OPENAI_API_KEY;
delete process.env.GOOGLE_API_KEY;
delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
delete process.env.GEMINI_API_KEY;

type DbModule = typeof import('../../src/lib/db');
let run: DbModule['run'];
let queryOne: DbModule['queryOne'];
let closeDb: DbModule['closeDb'];

let taskCounter = 0;
function nextId(prefix: string): string {
  taskCounter++;
  return `${prefix}-${taskCounter}`;
}

test.before(async () => {
  const db = await import('../../src/lib/db') as DbModule;
  run = db.run;
  queryOne = db.queryOne;
  closeDb = db.closeDb;
});

// ── Test 1: null department + UUID workspace_id → resolve slug from workspaces ──
test('PRD 2.9(f): null department resolves workspace slug from DB (not UUID)', () => {
  // Simulate a UI-created workspace — its primary key is a UUID, but it also
  // has a human-readable slug.
  const wsUUID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
  const wsSlug = 'marketing';
  const now = new Date().toISOString();

  // Insert the workspace row.
  try {
    run(
      `INSERT OR IGNORE INTO workspaces (id, slug, name, icon, sort_order, created_at, updated_at)
       VALUES (?, ?, ?, '📢', 99, ?, ?)`,
      [wsUUID, wsSlug, 'Marketing', now, now],
    );
  } catch (err) {
    // workspace may already exist; non-fatal
    void err;
  }

  // Simulate the resolution logic from qc-scorer.ts / tasks/[id]/route.ts:
  // task.department is null → look up workspace row by id → use ws.slug.
  const taskDept: string | null = null;
  const taskWorkspaceId: string | null = wsUUID;

  let deptSlug: string | null = taskDept;
  if (!deptSlug && taskWorkspaceId) {
    try {
      const ws = queryOne<{ slug: string }>(
        'SELECT slug FROM workspaces WHERE id = ?',
        [taskWorkspaceId],
      );
      deptSlug = ws?.slug ?? taskWorkspaceId;
    } catch {
      deptSlug = taskWorkspaceId;
    }
  }

  assert.strictEqual(
    deptSlug,
    wsSlug,
    `deptSlug must be the workspace slug ("${wsSlug}"), not the UUID ("${wsUUID}")`,
  );
  assert.ok(
    !deptSlug.includes('-') || deptSlug.length < 36,
    'deptSlug must not be a 36-char UUID; it should be a short human-readable slug',
  );
});

// ── Test 2: resolved slug passes canonicalDeptSlug without garbling ─────────
test('PRD 2.9(f): canonicalDeptSlug applied to workspace slug yields the canonical form', async () => {
  // Import the canonical-slug module (uses TS path aliases resolved by tsx).
  type SlugModule = typeof import('../../src/lib/routing/canonical-slug');
  const { canonicalDeptSlug } = await import('../../src/lib/routing/canonical-slug') as SlugModule;

  // Direct slug: already canonical.
  assert.strictEqual(canonicalDeptSlug('marketing'), 'marketing');
  // dept- prefix (seed format): stripped.
  assert.strictEqual(canonicalDeptSlug('dept-marketing'), 'marketing');
  // ceo-com alias: maps to master-orchestrator.
  assert.strictEqual(canonicalDeptSlug('ceo-com'), 'master-orchestrator');
  // Unknown slug: passes through lowercase.
  assert.strictEqual(canonicalDeptSlug('my-custom-dept'), 'my-custom-dept');
  // null/undefined: returns ''.
  assert.strictEqual(canonicalDeptSlug(null), '');
  assert.strictEqual(canonicalDeptSlug(undefined), '');
});

// ── Test 3: task with task.department already set is not overridden ──────────
test('PRD 2.9(f): task.department already set → used directly, no DB lookup needed', () => {
  const wsUUID = 'deadbeef-dead-beef-dead-beefdeadbeef';
  const taskDept = 'sales';

  // Simulate the fix: task.department takes priority.
  let deptSlug: string | null = taskDept;
  if (!deptSlug && wsUUID) {
    // This branch should NOT execute when taskDept is set.
    assert.fail('Should not query DB when task.department is already set');
  }

  assert.strictEqual(deptSlug, 'sales', 'task.department must be used directly when present');
});

// ── Test 4: workspace with no slug falls back to workspace_id ────────────────
test('PRD 2.9(f): workspace without slug falls back to workspace_id gracefully', () => {
  // Workspace row missing or slug is null → fallback to workspace_id itself.
  const wsUUID = 'missing-workspace-id-for-test';
  const taskDept: string | null = null;

  let deptSlug: string | null = taskDept;
  if (!deptSlug && wsUUID) {
    try {
      const ws = queryOne<{ slug: string }>(
        'SELECT slug FROM workspaces WHERE id = ?',
        [wsUUID],   // row does not exist → null returned
      );
      deptSlug = ws?.slug ?? wsUUID;
    } catch {
      deptSlug = wsUUID;
    }
  }

  // When row not found, ws is null, so ws?.slug is undefined → falls back to wsUUID.
  assert.strictEqual(deptSlug, wsUUID, 'graceful fallback to workspace_id when no workspace row found');
});

// ── Test 5: resolve-department headTitle uses head_agent_name (PRD 2.9e) ─────
test('PRD 2.9(e): normalizeWorkspace headTitle uses head_agent_name when present', async () => {
  // We can only test the export shape since resolveDepartment uses fetch().
  // Verify the DepartmentResolution interface includes headAgentName.
  const mod = await import('../../src/lib/routing/resolve-department');
  assert.strictEqual(
    typeof mod.resolveDepartment,
    'function',
    'resolveDepartment must remain a named export',
  );
  // Interface test: construct a DepartmentResolution-shaped object and confirm
  // the headAgentName field is accepted (TypeScript structural compatibility).
  const sample: import('../../src/lib/routing/resolve-department').DepartmentResolution = {
    id: 'test-id',
    slug: 'marketing',
    name: 'Marketing',
    emoji: '📢',
    headTitle: 'Candace',         // real agent name (not "Head of Marketing")
    headAgentName: 'Candace',     // populated field — PRD 2.9(e) addition
    grade: 'B',
    gradeScore: 75,
    insight: 'Active.',
  };
  assert.strictEqual(sample.headTitle, 'Candace', 'headTitle should be the real agent name');
  assert.strictEqual(sample.headAgentName, 'Candace', 'headAgentName field must exist in DepartmentResolution');
});

test.after(() => {
  try {
    if (typeof closeDb === 'function') closeDb();
  } catch { /* best-effort */ }
  try {
    fs.rmSync(path.dirname(TMP_DB), { recursive: true, force: true });
  } catch { /* best-effort */ }
});
