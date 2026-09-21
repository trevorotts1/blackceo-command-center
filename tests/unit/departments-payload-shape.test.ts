/**
 * departments-payload-shape.test.ts
 *
 * `departments.json` ships in TWO legitimate top-level shapes — a bare array,
 * and an object wrapping that array under a `departments` key (the retirement
 * script's `{removedWithProvenance, departments}` audit trail, and the build's
 * `{company, total_departments, total_roles, departments}` envelope). Every
 * reader handled the second one wrong:
 *
 *   - `reseedWorkspacesFromConfig()` gated on `Array.isArray` and called a
 *     perfectly valid wrapped artifact `malformed`, so a healthy box rendered
 *     NO department columns.
 *   - `preview/page.tsx` folded ANY object's KEYS in as department ids, so the
 *     envelope rendered four phantom departments named Company, Total
 *     Departments, Total Roles and Departments — the same defect that seeded
 *     four bogus workspaces onto a client board on 2026-08-07.
 *
 * These pin the envelope rules, rule for rule with `shared-utils/
 * departments_payload.py`, plus the per-job scheduler lease that keeps
 * qc-review-sweep from being killed mid-tick.
 *
 *   node --import tsx --test tests/unit/departments-payload-shape.test.ts
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  normalizeDepartmentsPayload,
  departmentsOrEmpty,
} from '../../src/lib/departments-payload';

const DEPTS = [
  { id: 'dept-marketing', name: 'Marketing' },
  { id: 'dept-sales', name: 'Sales' },
];
const ENVELOPE = { company: 'Acme', total_departments: 2, total_roles: 18, departments: DEPTS };
const METADATA_ONLY = { company: 'Acme', total_departments: 34, total_roles: 416 };
// The shape verified on a client box: the `departments` KEY holds an object of
// department objects keyed by slug, not an array.
const KEYED_ENVELOPE = {
  company: 'Acme',
  total_departments: 2,
  total_roles: 18,
  departments: {
    'account-management-dept': { name: 'Account Management' },
    'app-development-dept': { name: 'App Development' },
  },
};

// ── the three shapes ───────────────────────────────────────────────────────

test('a bare array passes through untouched', () => {
  const result = normalizeDepartmentsPayload(DEPTS);
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.departments, DEPTS);
});

test('an object wrapping a departments array is unwrapped', () => {
  for (const wrapped of [ENVELOPE, { removedWithProvenance: [{ slug: 'legal' }], departments: DEPTS }]) {
    const result = normalizeDepartmentsPayload(wrapped);
    assert.equal(result.ok, true);
    assert.deepEqual(result.ok && result.departments, DEPTS);
  }
});

test('an object with NO departments list is refused, naming the path and the type', () => {
  const result = normalizeDepartmentsPayload(METADATA_ONLY, '/tmp/departments.json');
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.reason, /\/tmp\/departments\.json/);
  assert.match(result.reason, /object with keys/);
  // the metadata keys must never become departments
  assert.match(result.reason, /"company"/);
});

test('a dict-of-dicts keyed by slug is folded, with the key as the id', () => {
  const result = normalizeDepartmentsPayload({ marketing: { name: 'Marketing' } });
  assert.equal(result.ok, true);
  assert.deepEqual(result.ok && result.departments, [
    { name: 'Marketing', id: 'marketing', slug: 'marketing' },
  ]);
});

test("a 'departments' key holding a dict-of-dicts is folded the same way", () => {
  // The shape a real client box ships. v7.6.29 refused it with "'departments'
  // key holds dict, expected a list" and failed Phase 6c of the sync.
  const result = normalizeDepartmentsPayload(KEYED_ENVELOPE);
  assert.equal(result.ok, true);
  assert.deepEqual(result.ok && result.departments, [
    { name: 'Account Management', id: 'account-management-dept', slug: 'account-management-dept' },
    { name: 'App Development', id: 'app-development-dept', slug: 'app-development-dept' },
  ]);
});

test("folding keeps an entry's own id and only fills what is missing", () => {
  const withId = normalizeDepartmentsPayload({
    departments: { marketing: { id: 'dept-marketing', name: 'Marketing' } },
  });
  assert.deepEqual(withId.ok && withId.departments, [
    { id: 'dept-marketing', name: 'Marketing', slug: 'marketing' },
  ]);
  const withBoth = normalizeDepartmentsPayload({
    departments: { marketing: { id: 'dept-marketing', slug: 'mktg' } },
  });
  assert.deepEqual(withBoth.ok && withBoth.departments, [{ id: 'dept-marketing', slug: 'mktg' }]);
});

test('an empty object is refused — the shipped empty default is [], never {}', () => {
  assert.equal(normalizeDepartmentsPayload({}).ok, false);
  assert.equal(normalizeDepartmentsPayload([]).ok, true);
});

test("a 'departments' key holding something that is neither an array nor a department map is refused", () => {
  for (const wrapped of [
    { marketing: 'yes' }, // a value that is not an object
    { marketing: ['a'] }, // an array is not a department object
    {}, // empty is not a department map
    42,
    'marketing',
  ]) {
    const result = normalizeDepartmentsPayload({ departments: wrapped }, '/tmp/departments.json');
    assert.equal(result.ok, false, `expected a refusal for ${JSON.stringify(wrapped)}`);
    assert.match(!result.ok ? result.reason : '', /'departments' key holds/);
  }
});

test('non-object, non-array payloads are refused', () => {
  for (const bad of ['marketing', 42, null, true]) {
    assert.equal(normalizeDepartmentsPayload(bad).ok, false, `expected a refusal for ${String(bad)}`);
  }
});

// ── the lenient wrapper ────────────────────────────────────────────────────

test('departmentsOrEmpty yields [] for a metadata envelope and never throws', () => {
  const errors: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => void errors.push(args.join(' '));
  try {
    assert.deepEqual(departmentsOrEmpty(METADATA_ONLY, '/tmp/departments.json'), []);
    assert.deepEqual(departmentsOrEmpty(ENVELOPE), DEPTS);
  } finally {
    console.error = original;
  }
  assert.equal(errors.length, 1, 'the refusal is logged loudly, exactly once');
  assert.match(errors[0], /MALFORMED/);
});

// ── the two readers actually route through it ──────────────────────────────

function source(rel: string): string {
  return fs.readFileSync(path.join(process.cwd(), rel), 'utf8');
}

test('reseedWorkspacesFromConfig unwraps before its Array.isArray gate', () => {
  const src = source('src/lib/db/migrations.ts');
  assert.match(src, /import \{ normalizeDepartmentsPayload \} from '\.\.\/departments-payload';/);
  const unwrap = src.indexOf('const shape = normalizeDepartmentsPayload(depts, configPath)');
  const gate = src.indexOf('if (!Array.isArray(depts)) {');
  assert.ok(unwrap > 0, 'the reseed path calls the normalizer');
  assert.ok(gate > unwrap, 'it unwraps BEFORE the array gate, or a valid envelope still reads as malformed');
});

test('the preview page no longer folds an object’s keys in as departments', () => {
  const src = source('src/app/preview/page.tsx');
  assert.match(src, /departmentsOrEmpty/);
  assert.ok(
    !/Object\.entries\(data as Record<string, unknown>\)/.test(src),
    'the raw key-folding branch is gone — that is what rendered Company / Total Departments / Total Roles / Departments',
  );
});

// ── the scheduler lease ────────────────────────────────────────────────────

test('qc-review-sweep runs under a lease long enough to judge a tick of cards', () => {
  const src = source('src/lib/jobs/scheduler.ts');
  const job = src.slice(src.indexOf("name: 'qc-review-sweep'"));
  const declared = /timeoutMs:\s*([0-9_]+)/.exec(job.slice(0, 400));
  assert.ok(declared, 'qc-review-sweep declares an explicit timeoutMs');
  const ms = Number(declared![1].replace(/_/g, ''));
  assert.equal(ms, 600_000);
  assert.ok(ms > 90_000, 'it must exceed runLeasedJob’s 90s default, which is what killed it mid-tick');
});

test('the per-job lease is threaded into wrap(), not just declared', () => {
  const src = source('src/lib/jobs/scheduler.ts');
  assert.match(src, /wrap\(job\.name, job\.fn, job\.timeoutMs\)/);
});
