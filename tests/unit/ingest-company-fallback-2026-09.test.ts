/**
 * The ingest catch-all survives a company-id split (2026-09-21, client box).
 *
 * MC_COMPANY_ID said `default` while `general-task` and 31 of 40 active
 * workspaces sat under `wakeuphappysis`, so every `mc-route.sh general-task …`
 * resolved to `unrecognized-slug->unrouted` and the catch-all silently died.
 * When the configured company owns NO catch-all, resolution falls back to the
 * company owning the most active workspaces, loudly. When it DOES own one,
 * nothing changes.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_DB = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'bc-company-fallback-')),
  'mission-control.test.db',
);
process.env.DATABASE_PATH = TMP_DB;
process.env.OPENCLAW_ROOT = '/nonexistent/openclaw-root-for-tests';

let getDb: typeof import('../../src/lib/db')['getDb'];
let resolveWorkspaceId: typeof import('../../src/lib/company-scope')['resolveWorkspaceId'];
let companyScope: typeof import('../../src/lib/company-scope')['companyScope'];

const CONFIGURED = 'default';
const MAJORITY = 'zz-majority-co';

function company(id: string, name: string) {
  getDb().prepare('INSERT OR IGNORE INTO companies (id,name,slug) VALUES (?,?,?)').run(id, name, id);
}

function workspace(id: string, slug: string, name: string, companyId: string) {
  getDb()
    .prepare('INSERT INTO workspaces (id,name,slug,description,icon,company_id) VALUES (?,?,?,?,?,?)')
    .run(id, name, slug, '', '\u{1F4C1}', companyId);
}

/**
 * Start each case from an empty BOARD without touching the rows themselves.
 * The migration chain seeds workspaces that agents and tasks reference, so a
 * DELETE trips a foreign key; archiving is what every reader here already
 * skips, and it is the same soft-retire the sync script uses.
 */
function retireSeededBoard() {
  // Once, in before(). The migration chain seeds workspaces that agents and
  // tasks reference, so a DELETE trips a foreign key: archive them instead —
  // which is exactly what every reader here skips — and move their slugs out of
  // the way, because slug is UNIQUE across archived rows too.
  getDb().prepare("UPDATE workspaces SET archived_at=?, slug='zz-seeded-'||id WHERE archived_at IS NULL")
    .run(new Date().toISOString());
}

/** Clear only the rows THIS file created; they have no dependents. */
function blankBoard() {
  getDb().prepare("DELETE FROM workspaces WHERE id LIKE 'cfg-%' OR id LIKE 'maj-%'").run();
}

test.before(async () => {
  ({ getDb } = await import('../../src/lib/db'));
  getDb(); // full migration chain
  ({ resolveWorkspaceId, companyScope } = await import('../../src/lib/company-scope'));
  company(CONFIGURED, 'Acme');
  company(MAJORITY, 'Acme');
  retireSeededBoard();
});


test('a split board routes to the majority company and says so', () => {
  blankBoard();
  // The configured company owns one unrelated workspace and NO catch-all.
  workspace('cfg-hr', 'hr', 'HR', CONFIGURED);
  // The majority company owns the catch-all and most of the board.
  workspace('maj-general', 'general-task', 'General Task', MAJORITY);
  workspace('maj-sales', 'sales', 'Sales', MAJORITY);
  workspace('maj-marketing', 'marketing', 'Marketing', MAJORITY);

  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (...a: unknown[]) => void warnings.push(a.join(' '));
  let out;
  try {
    out = resolveWorkspaceId('general-task', undefined, CONFIGURED);
  } finally {
    console.warn = original;
  }

  assert.equal(out.workspaceId, 'maj-general', 'the catch-all under the majority company wins');
  assert.ok(out.resolvedBy.startsWith(`company-fallback:${MAJORITY}:`), out.resolvedBy);
  assert.equal(warnings.length, 1, 'exactly one loud warning');
  assert.match(warnings[0], new RegExp(`'${CONFIGURED}'`), 'names the configured company');
  assert.match(warnings[0], new RegExp(`'${MAJORITY}'`), 'names the majority company');
  assert.match(warnings[0], /"zz-majority-co":3/, 'carries the count split');
});

test('an unknown slug still reaches the majority catch-all rather than unrouted', () => {
  blankBoard();
  workspace('cfg-hr', 'hr', 'HR', CONFIGURED);
  workspace('maj-general', 'general-task', 'General Task', MAJORITY);
  workspace('maj-sales', 'sales', 'Sales', MAJORITY);

  const original = console.warn;
  console.warn = () => {};
  try {
    const out = resolveWorkspaceId('no-such-department', undefined, CONFIGURED);
    assert.equal(out.workspaceId, 'maj-general');
    assert.ok(out.resolvedBy.endsWith('unrecognized-slug->general'), out.resolvedBy);
  } finally {
    console.warn = original;
  }
});

test('a single-company board is untouched — no fallback, no warning, no prefix', () => {
  blankBoard();
  workspace('cfg-general', 'general-task', 'General Task', CONFIGURED);
  workspace('cfg-sales', 'sales', 'Sales', CONFIGURED);
  // Another company owns MORE workspaces, and must still not win.
  workspace('maj-a', 'maj-a', 'A', MAJORITY);
  workspace('maj-b', 'maj-b', 'B', MAJORITY);
  workspace('maj-c', 'maj-c', 'C', MAJORITY);

  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (...a: unknown[]) => void warnings.push(a.join(' '));
  try {
    const bySlug = resolveWorkspaceId('sales', undefined, CONFIGURED);
    assert.equal(bySlug.workspaceId, 'cfg-sales');
    assert.equal(bySlug.resolvedBy, 'department_slug:sales', 'no fallback prefix');
    const bare = resolveWorkspaceId(undefined, undefined, CONFIGURED);
    assert.equal(bare.workspaceId, 'cfg-general');
    assert.equal(bare.resolvedBy, 'general-task-fallback');
  } finally {
    console.warn = original;
  }
  assert.equal(warnings.length, 0, 'a healthy box logs nothing');
});

test('the company split is readable, and /api/health reports it', () => {
  blankBoard();
  workspace('cfg-hr', 'hr', 'HR', CONFIGURED);
  workspace('maj-general', 'general-task', 'General Task', MAJORITY);
  workspace('maj-sales', 'sales', 'Sales', MAJORITY);

  const scope = companyScope(getDb(), CONFIGURED);
  assert.equal(scope.configured, CONFIGURED);
  assert.equal(scope.majority, MAJORITY);
  assert.equal(scope.activeWorkspacesByCompany[CONFIGURED], 1);
  assert.equal(scope.activeWorkspacesByCompany[MAJORITY], 2);

  const src = fs.readFileSync(path.join(process.cwd(), 'src/app/api/health/route.ts'), 'utf8');
  assert.match(src, /company: companyScope\(db, process\.env\.MC_COMPANY_ID\)/);
});

test('an archived workspace does not count toward the majority', () => {
  blankBoard();
  workspace('cfg-general', 'general-task', 'General Task', CONFIGURED);
  workspace('maj-a', 'maj-a', 'A', MAJORITY);
  workspace('maj-b', 'maj-b', 'B', MAJORITY);
  getDb().prepare("UPDATE workspaces SET archived_at=? WHERE id IN ('maj-a','maj-b')")
    .run(new Date().toISOString());

  const scope = companyScope(getDb(), CONFIGURED);
  assert.equal(scope.majority, CONFIGURED);
  assert.equal(scope.activeWorkspacesByCompany[MAJORITY], undefined);
});
