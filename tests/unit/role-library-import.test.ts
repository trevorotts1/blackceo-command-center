/**
 * Unit tests for the role-library bridge (src/lib/role-library-import.ts) and
 * the Triad-block auto-draft (src/lib/sop-learning.ts proposeDraftFromTask) —
 * the v4.3.0 SOP-wiring code that previously shipped with NO automated coverage.
 *
 * Runs via the Node built-in test runner under tsx (`npm run test:unit`).
 *
 * Strategy mirrors ceo-ordering-ingest.test.ts / kpi-snapshots-migration.test.ts:
 * point DATABASE_PATH at a throwaway temp file BEFORE `@/lib/db` is loaded (its
 * DB_PATH const is captured at import-evaluation time), then dynamically import
 * the helpers so they bind to the isolated DB and run the real migration chain
 * (including migration 050 add_sops_role_and_source).
 *
 * Each DB-mutating test scopes its assertions to a unique department/role so the
 * suite is deterministic regardless of test-runner ordering.
 *
 * Covers (the gaps the QC report called out):
 *   1. extractStepsFromHowTo: Section-9 parse, the bare-"9 " false-match edge,
 *      and the always-≥1-step (NOT NULL steps) contract.
 *   2. importRoleLibrary: upsert INSERT then UPDATE idempotency + 0 duplicate
 *      slugs across re-runs (version bump on update).
 *   3. clobber-skip: a row whose source IS NULL (user-authored) sharing the slug
 *      is never overwritten.
 *   4. prune: prune_missing soft-deletes ONLY role-library rows gone from disk,
 *      never NULL-source rows.
 *   5. proposeDraftFromTask: creates one draft and dedupes a repeat for the same
 *      task to a single pending proposal.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-role-lib-'));
const TMP_DB = path.join(TMP_DIR, 'mission-control.test.db');
process.env.DATABASE_PATH = TMP_DB;

type DbModule = typeof import('../../src/lib/db');
type RoleLibModule = typeof import('../../src/lib/role-library-import');
type LearningModule = typeof import('../../src/lib/sop-learning');

let getDb: DbModule['getDb'];
let queryOne: DbModule['queryOne'];
let queryAll: DbModule['queryAll'];
let run: DbModule['run'];
let closeDb: DbModule['closeDb'];

let extractStepsFromHowTo: RoleLibModule['extractStepsFromHowTo'];
let importRoleLibrary: RoleLibModule['importRoleLibrary'];
let roleLibrarySlug: RoleLibModule['roleLibrarySlug'];
let ROLE_LIBRARY_SOURCE: RoleLibModule['ROLE_LIBRARY_SOURCE'];

let proposeDraftFromTask: LearningModule['proposeDraftFromTask'];

/** Lay down departments/<dept>/<NN-role>/how-to.md files; return the root. */
function makeDepartmentsTree(spec: Record<string, Record<string, string>>): string {
  const root = fs.mkdtempSync(path.join(TMP_DIR, 'departments-'));
  for (const [dept, roles] of Object.entries(spec)) {
    for (const [roleDir, markdown] of Object.entries(roles)) {
      const dir = path.join(root, dept, roleDir);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'how-to.md'), markdown);
    }
  }
  return root;
}

test.before(async () => {
  const db = await import('../../src/lib/db');
  getDb = db.getDb;
  queryOne = db.queryOne;
  queryAll = db.queryAll;
  run = db.run;
  closeDb = db.closeDb;

  const roleLib = await import('../../src/lib/role-library-import');
  extractStepsFromHowTo = roleLib.extractStepsFromHowTo;
  importRoleLibrary = roleLib.importRoleLibrary;
  roleLibrarySlug = roleLib.roleLibrarySlug;
  ROLE_LIBRARY_SOURCE = roleLib.ROLE_LIBRARY_SOURCE;

  const learning = await import('../../src/lib/sop-learning');
  proposeDraftFromTask = learning.proposeDraftFromTask;

  // getDb() runs the full migration chain (incl. 050 add_sops_role_and_source)
  // against the temp DB, proving role/source exist for the importer to use.
  getDb();
});

test.after(() => {
  try { closeDb(); } catch { /* ignore */ }
  try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ---------- 1. extractStepsFromHowTo ----------

test('extractStepsFromHowTo: parses a Section-9 SOP block into ordered steps', () => {
  const md = [
    '# Appointment Setter How-To',
    '',
    'Intro paragraph describing the role.',
    '',
    '## 9. SOPs',
    '',
    '### SOP 9.1 Qualify the lead',
    'Confirm budget, authority, need, timeline.',
    '',
    '### SOP 9.2 Book the appointment',
    'Offer two concrete time slots.',
  ].join('\n');

  const steps = extractStepsFromHowTo(md, 'appointment-setter');
  assert.ok(steps.length >= 2, 'both Section-9 SOP subheadings become steps');
  assert.match(steps[0].name, /Qualify the lead/i);
  assert.match(steps[1].name, /Book the appointment/i);
  // Numbered prefix added; the "SOP 9.1" marker stripped.
  assert.match(steps[0].name, /^1\. /);
  assert.equal(steps[0].success_criteria, 'Confirm budget, authority, need, timeline.');
});

test('extractStepsFromHowTo: a heading starting with "9 " is NOT hijacked as the Section-9 anchor', () => {
  // Regression for the tightened anchor regex (QC defect #4): "## 9 things to
  // know" must not be treated as the SOP section, which would silently drop the
  // first real step. With the fix, ALL body headings become steps.
  const md = [
    '# Onboarding How-To',
    '',
    'Lead paragraph.',
    '',
    '## 9 things to know',
    'First thing to know.',
    '',
    '## Set up the workstation',
    'Provision the laptop.',
    '',
    '## Grant access',
    'Least-privilege only.',
  ].join('\n');

  const steps = extractStepsFromHowTo(md, 'onboarding');
  const names = steps.map((s) => s.name);
  // The "9 things to know" heading must survive as a step (not be the anchor
  // that excludes itself + everything above the deeper headings).
  assert.ok(
    names.some((n) => /9 things to know/i.test(n)),
    'the "9 things to know" heading must remain a step, proving it was not treated as the anchor',
  );
  assert.ok(names.some((n) => /Set up the workstation/i.test(n)));
  assert.ok(names.some((n) => /Grant access/i.test(n)));
});

test('extractStepsFromHowTo: always returns at least one step (NOT NULL steps contract)', () => {
  const steps = extractStepsFromHowTo('# Title only\n\nNo headings at all, just prose.', 'lonely-role');
  assert.ok(steps.length >= 1, 'must never return an empty step set');
  assert.match(steps[0].name, /Follow lonely-role how-to/i);
});

// ---------- 2. importRoleLibrary upsert idempotency + 0 dup slugs ----------

test('importRoleLibrary: INSERT then UPDATE is idempotent with zero duplicate slugs + version bump', () => {
  const root = makeDepartmentsTree({
    'sales-dept': {
      '03-appointment-setter': '# Appointment Setter\n\nBook qualified calls.\n\n## Qualify\nBANT.\n\n## Book\nTwo slots.',
    },
    'support-dept': {
      '01-tier-1-agent': '# Tier 1 Agent\n\nFirst response.\n\n## Triage\nSeverity P1-P3.',
    },
  });

  const first = importRoleLibrary({ departmentsPath: root });
  assert.equal(first.scanned_roles, 2, 'two role how-tos discovered');
  assert.equal(first.inserted, 2, 'first run INSERTs both rows');
  assert.equal(first.updated, 0);

  const slugSetter = roleLibrarySlug('sales', 'appointment-setter');
  const rowAfterInsert = queryOne<{ version: number; role: string; source: string }>(
    'SELECT version, role, source FROM sops WHERE slug = ?',
    [slugSetter],
  );
  assert.equal(rowAfterInsert?.version, 1, 'fresh insert is version 1');
  assert.equal(rowAfterInsert?.role, 'appointment-setter', 'role column populated');
  assert.equal(rowAfterInsert?.source, ROLE_LIBRARY_SOURCE, 'source tagged role-library');

  // Re-run: must UPDATE the SAME rows, never duplicate, and bump version.
  const second = importRoleLibrary({ departmentsPath: root });
  assert.equal(second.inserted, 0, 'second run INSERTs nothing');
  assert.equal(second.updated, 2, 'second run UPDATEs both rows in place');

  const dupCount = queryOne<{ c: number }>(
    'SELECT COUNT(*) AS c FROM sops WHERE slug = ?',
    [slugSetter],
  );
  assert.equal(dupCount?.c, 1, 'exactly one row per slug after re-run (zero duplicates)');

  const rowAfterUpdate = queryOne<{ version: number }>(
    'SELECT version FROM sops WHERE slug = ?',
    [slugSetter],
  );
  assert.equal(rowAfterUpdate?.version, 2, 'update bumps version 1 -> 2');
});

// ---------- 3. clobber-skip on source IS NULL ----------

test('importRoleLibrary: never clobbers a user-authored (source IS NULL) row sharing the slug', () => {
  const dept = 'finance';
  const role = 'controller';
  const slug = roleLibrarySlug(dept, role);

  // Pre-seed a user-authored SOP that happens to occupy the same slug, source NULL.
  run(
    `INSERT INTO sops (id, name, slug, description, version, department, role, source, task_keywords, steps, created_at, updated_at)
     VALUES (?, ?, ?, ?, 7, ?, NULL, NULL, ?, ?, ?, ?)`,
    [
      'user-authored-controller',
      'HAND-AUTHORED Controller SOP',
      slug,
      'Do not overwrite me',
      dept,
      'finance,controller',
      JSON.stringify([{ name: 'Manual step' }]),
      new Date().toISOString(),
      new Date().toISOString(),
    ],
  );

  const root = makeDepartmentsTree({
    'finance-dept': {
      '02-controller': '# Controller\n\nClose the books.\n\n## Reconcile\nTie out accounts.',
    },
  });

  const result = importRoleLibrary({ departmentsPath: root });
  const skipped = result.items.find((i) => i.slug === slug);
  assert.equal(skipped?.action, 'skipped', 'the colliding slug must be skipped, not overwritten');
  assert.match(skipped?.reason || '', /non-role-library|source=null/i);

  const row = queryOne<{ id: string; name: string; version: number; source: string | null }>(
    'SELECT id, name, version, source FROM sops WHERE slug = ?',
    [slug],
  );
  assert.equal(row?.id, 'user-authored-controller', 'original row id untouched');
  assert.equal(row?.name, 'HAND-AUTHORED Controller SOP', 'name not overwritten');
  assert.equal(row?.version, 7, 'version not bumped');
  assert.equal(row?.source, null, 'source stays NULL (still user-authored)');
});

// ---------- 4. prune touches ONLY role-library rows ----------

test('importRoleLibrary: prune_missing soft-deletes only role-library rows gone from disk', () => {
  // Build a tree with two roles, import them (both role-library rows).
  const rootFull = makeDepartmentsTree({
    'ops-dept': {
      '01-dispatcher': '# Dispatcher\n\nRoute jobs.\n\n## Assign\nNearest tech.',
      '02-coordinator': '# Coordinator\n\nSchedule.\n\n## Plan\nWeekly grid.',
    },
  });
  importRoleLibrary({ departmentsPath: rootFull });

  // A user-authored row in the same department (source NULL) must be immune to prune.
  const userSlug = 'user:ops/handbook';
  run(
    `INSERT INTO sops (id, name, slug, description, version, department, role, source, task_keywords, steps, created_at, updated_at)
     VALUES (?, ?, ?, ?, 1, ?, NULL, NULL, ?, ?, ?, ?)`,
    [
      'ops-handbook',
      'Ops Handbook',
      userSlug,
      'user authored',
      'ops',
      'ops,handbook',
      JSON.stringify([{ name: 'Read the handbook' }]),
      new Date().toISOString(),
      new Date().toISOString(),
    ],
  );

  const slugCoordinator = roleLibrarySlug('ops', 'coordinator');
  const slugDispatcher = roleLibrarySlug('ops', 'dispatcher');

  // Now scan a SMALLER tree (coordinator removed from disk) with prune on.
  const rootPartial = makeDepartmentsTree({
    'ops-dept': {
      '01-dispatcher': '# Dispatcher\n\nRoute jobs.\n\n## Assign\nNearest tech.',
    },
  });
  const result = importRoleLibrary({ departmentsPath: rootPartial, pruneMissing: true });
  // At least the coordinator (removed from THIS tree) is pruned. The exact count
  // can be higher because other tests' role-library rows share this isolated DB
  // and are also "missing" from this partial scan — the per-row asserts below
  // pin the actual contract (only role-library rows gone from disk; never NULL).
  assert.ok(result.pruned >= 1, 'at least the missing role-library row is pruned');

  const coordinator = queryOne<{ deleted_at: string | null }>(
    'SELECT deleted_at FROM sops WHERE slug = ?',
    [slugCoordinator],
  );
  assert.ok(coordinator?.deleted_at, 'the on-disk-removed role-library row is soft-deleted');

  const dispatcher = queryOne<{ deleted_at: string | null }>(
    'SELECT deleted_at FROM sops WHERE slug = ?',
    [slugDispatcher],
  );
  assert.equal(dispatcher?.deleted_at, null, 'a still-present role-library row is NOT pruned');

  const userRow = queryOne<{ deleted_at: string | null }>(
    'SELECT deleted_at FROM sops WHERE slug = ?',
    [userSlug],
  );
  assert.equal(userRow?.deleted_at, null, 'a user-authored (source NULL) row is NEVER pruned');
});

// ---------- 5. proposeDraftFromTask create + dedupe ----------

test('proposeDraftFromTask: creates one draft then dedupes a repeat for the same task', () => {
  const taskId = `task-${Date.now()}-triad`;
  const input = {
    task_id: taskId,
    title: 'Refund a duplicate Stripe charge for an annoyed customer',
    description: 'Customer was double-billed; locate both charges and refund the duplicate.',
    department: 'support',
    persona_id: 'tier-1-agent',
  };

  const first = proposeDraftFromTask(input);
  assert.equal(first.created, true, 'first call creates a draft proposal');
  assert.ok(first.proposal_id, 'returns the new proposal id');

  const created = queryOne<{ id: string; status: string; proposed_department: string | null }>(
    'SELECT id, status, proposed_department FROM sop_proposals WHERE id = ?',
    [first.proposal_id!],
  );
  assert.equal(created?.status, 'pending', 'draft is inserted as pending for the review queue');
  assert.equal(created?.proposed_department, 'support');

  // A second call for the SAME task must dedupe to the existing draft.
  const second = proposeDraftFromTask(input);
  assert.equal(second.created, false, 'repeat for the same task does not create a duplicate');
  assert.equal(second.proposal_id, first.proposal_id, 'dedupe returns the existing draft id');

  const count = queryOne<{ c: number }>(
    `SELECT COUNT(*) AS c FROM sop_proposals
       WHERE status = 'pending' AND based_on_task_ids LIKE ?`,
    [`%${taskId}%`],
  );
  assert.equal(count?.c, 1, 'exactly one pending Triad-block draft exists for the task');
});

test('proposeDraftFromTask: a titleless task yields no draft', () => {
  const res = proposeDraftFromTask({ task_id: 'no-title-task', title: '   ' });
  assert.equal(res.created, false, 'a blank title cannot seed a draft');
  assert.equal(res.proposal_id, null);
});
