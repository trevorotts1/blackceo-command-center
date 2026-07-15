/**
 * U57 (E.2 / JM-U53) — Department metric unification + dead CEODashboard
 * branch removal.
 *
 * BINARY acceptance (1): "for the same department/window/data, the grid card
 * grade string equals the detail-hero grade string (automated test, same
 * fixture through both surfaces)."
 *
 * The grid (`DepartmentPerformanceSection.tsx` → `DepartmentCard.tsx`) now
 * sources its headline grade from `GET /api/company-health`'s `departments`
 * array (`computeCompanyHealth()` → `computeDepartmentGrade()`, merged via
 * `mergeDepartmentGrades()`). The detail hero sources its grade from
 * `resolveDepartment()` (also `computeDepartmentGrade()`). Both paths call
 * the SAME underlying function with the SAME default window/weights for the
 * SAME department, so this test seeds one fixture and proves both routes'
 * outputs agree byte-for-byte on `grade` and `score`.
 *
 * Also covers acceptance (3) — "`CEODashboard.tsx` no longer exists in the
 * tree" — and a dangling-reference sweep, as an automated (not one-time
 * manual) check.
 *
 * Isolation: `_isolated-db` (imported FIRST) points DATABASE_PATH at a unique
 * temp file per process.
 *
 * Runs via the Node built-in test runner under tsx (`npm run test:unit`).
 */

import './_isolated-db';

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import { run } from '../../src/lib/db';
import { GET as companyHealthGET } from '../../src/app/api/company-health/route';

const REPO_ROOT = path.join(__dirname, '..', '..');

function seedWorkspace(opts: { id: string; slug: string; name: string }): void {
  run(
    `INSERT INTO workspaces (id, name, slug, description, icon) VALUES (?, ?, ?, ?, ?)`,
    [opts.id, opts.name, opts.slug, `${opts.name} department`, '🏢'],
  );
}

test('[U57] grid grade (via /api/company-health) equals detail-hero grade (via resolveDepartment()) for the same department/window/data', async () => {
  const deptId = `ws-parity-${uuidv4()}`;
  const slug = `parity-dept-${uuidv4().slice(0, 8)}`;
  seedWorkspace({ id: deptId, slug, name: 'Parity Dept' });

  const now = new Date().toISOString();
  // Enough throughput + QC signal for a real (non-null) grade.
  for (let i = 0; i < 5; i++) {
    run(
      `INSERT INTO tasks (id, title, status, workspace_id, created_at, updated_at, completed_at)
       VALUES (?, ?, 'done', ?, ?, ?, ?)`,
      [uuidv4(), `Parity Task ${i}`, deptId, now, now, now],
    );
  }
  for (let i = 0; i < 3; i++) {
    const taskId = uuidv4();
    run(
      `INSERT INTO tasks (id, title, status, workspace_id, created_at, updated_at, completed_at)
       VALUES (?, ?, 'done', ?, ?, ?, ?)`,
      [taskId, `Parity QC Task ${i}`, deptId, now, now, now],
    );
    run(
      `INSERT INTO task_qc_results (id, task_id, workspace_id, department_slug, score, passed, scoring_path, scored_at)
       VALUES (?, ?, ?, ?, ?, ?, 'llm', ?)`,
      [uuidv4(), taskId, deptId, slug, 92, 1, now],
    );
  }

  // Path 1: the detail hero's data source.
  const { resolveDepartment } = await import('../../src/lib/routing/resolve-department');
  const resolved = await resolveDepartment(deptId);
  assert.ok(resolved, 'resolveDepartment must resolve the seeded workspace');

  // Path 2: the grid's data source (same route DepartmentPerformanceSection.tsx fetches).
  const res = await companyHealthGET(new Request('http://localhost/api/company-health'));
  assert.equal(res.status, 200);
  const health = await res.json();
  const gridEntry = (health.departments as Array<{ workspaceId: string; grade: string | null; score: number | null }>)
    .find((d) => d.workspaceId === deptId);
  assert.ok(gridEntry, 'the seeded department must appear in /api/company-health\'s departments array');

  // The parity assertion itself.
  assert.equal(gridEntry!.grade, resolved!.grade, 'grid grade must equal detail-hero grade');
  assert.equal(gridEntry!.score, resolved!.gradeScore, 'grid score must equal detail-hero score');
  assert.notEqual(resolved!.grade, null, 'sanity: this fixture must produce a REAL grade, not an insufficient-data null (a null==null pass would be meaningless)');
});

test('[U57] grid grade equals detail-hero grade even when insufficient data (both honestly null, never a fabricated letter)', async () => {
  const deptId = `ws-parity-nodata-${uuidv4()}`;
  const slug = `parity-nodata-${uuidv4().slice(0, 8)}`;
  seedWorkspace({ id: deptId, slug, name: 'No Data Dept' });
  // Zero tasks — every input stays null, sufficientData=false.

  const { resolveDepartment } = await import('../../src/lib/routing/resolve-department');
  const resolved = await resolveDepartment(deptId);
  assert.ok(resolved);
  assert.equal(resolved!.grade, null);

  const res = await companyHealthGET(new Request('http://localhost/api/company-health'));
  const health = await res.json();
  const gridEntry = (health.departments as Array<{ workspaceId: string; grade: string | null }>)
    .find((d) => d.workspaceId === deptId);
  assert.ok(gridEntry);
  assert.equal(gridEntry!.grade, null, 'grid must render insufficient-data honestly, not fall back to a fabricated letter');
  assert.equal(gridEntry!.grade, resolved!.grade);
});

test('[U57] CEODashboard.tsx no longer exists in the tree', () => {
  const componentPath = path.join(REPO_ROOT, 'src', 'components', 'CEODashboard.tsx');
  assert.equal(fs.existsSync(componentPath), false, 'src/components/CEODashboard.tsx must be deleted');
});

test('[U57] no remaining import of CEODashboard anywhere under src/ (no dangling references)', () => {
  const srcDir = path.join(REPO_ROOT, 'src');
  const offenders: string[] = [];

  function walk(dir: string) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (/\.(ts|tsx)$/.test(entry.name)) {
        const content = fs.readFileSync(full, 'utf-8');
        // A dangling reference is an actual import/JSX usage, not a doc
        // comment that explains the deletion (this test file's own comments,
        // and the U57 ripple comments in workspace/[slug]/page.tsx and
        // api/performance/route.ts, legitimately mention the deleted name).
        if (/from ['"]@\/components\/CEODashboard['"]/.test(content) || /<CEODashboard[\s/>]/.test(content)) {
          offenders.push(path.relative(REPO_ROOT, full));
        }
      }
    }
  }
  walk(srcDir);

  assert.deepEqual(offenders, [], `dangling CEODashboard import/usage found in: ${offenders.join(', ')}`);
});

test('[U57] the dead ternary branch is gone: workspace/[slug]/page.tsx unconditionally renders MissionQueue, no showTaskBoard flag', () => {
  const pagePath = path.join(REPO_ROOT, 'src', 'app', 'workspace', '[slug]', 'page.tsx');
  const content = fs.readFileSync(pagePath, 'utf-8');
  // Match the actual declaration/usage, not this unit's own explanatory
  // ripple comment (which legitimately names the removed constant, same
  // "comment mentions the deletion" carve-out as the dangling-import test above).
  assert.equal(
    /\bconst\s+showTaskBoard\b|\bshowTaskBoard\s*\?/.test(content),
    false,
    'showTaskBoard constant/conditional must be removed',
  );
  assert.ok(/<MissionQueue/.test(content), 'MissionQueue must still render');
  assert.equal(/<CEODashboard/.test(content), false, 'CEODashboard JSX usage must be gone');
});
