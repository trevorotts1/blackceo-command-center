/**
 * UL-022 — launch storage contract tests.
 *
 * Proves the adapter's contract side without a database:
 *   - the canonical plan hash matches the producer's `plan_hash()`
 *     (shared-utils/signature_launch/progress.py: sorted keys, compact
 *     separators, sha256:<hex>), independent of key order;
 *   - typed discovery labels plan/progress files before parsing;
 *   - plan/progress validation is fail-closed (size, schema, ids, waits_for);
 *   - the disk-vs-database relationship is explicit and never invents a match.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, it, expect } from 'vitest';

import {
  canonicalPlanJson,
  discoverLaunchFiles,
  planHash,
  relateLaunchViews,
  validateLaunchPlan,
  validateLaunchProgress,
} from '@/lib/launch-storage';

const FIXTURES = path.join(process.cwd(), 'tests', 'fixtures', 'launch-runs');
const PLAN = JSON.parse(
  fs.readFileSync(path.join(FIXTURES, 'sample-launch.plan.json'), 'utf8'),
) as Record<string, unknown>;
const PROGRESS = JSON.parse(
  fs.readFileSync(path.join(FIXTURES, 'sample-launch.progress.json'), 'utf8'),
) as Record<string, unknown>;

const created: string[] = [];
function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-UL-022-storage-'));
  created.push(dir);
  return dir;
}
process.on('exit', () => {
  for (const dir of created) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

describe('UL-022 — launch storage contract', () => {
  it('matches the producer plan hash (Python _canonical + sha256)', () => {
    // Value computed by the producer's own algorithm:
    // python3 -c "import json,hashlib; ... json.dumps(sort_keys=True,separators=(',',':'))"
    expect(planHash(PLAN)).toBe(
      'sha256:56c28b6b2e34357f41f3919d990aed5d6bb4d370a3b701f4cea251b758c0d5eb',
    );
    expect(planHash(PLAN)).toBe(PROGRESS.plan_hash);
  });

  it('is key-order independent and preserves array order', () => {
    const reordered = Object.fromEntries(Object.entries(PLAN).reverse());
    expect(planHash(reordered)).toBe(planHash(PLAN));
    const arrayReordered = { ...PLAN, pages: [...(PLAN.pages as unknown[])].reverse() };
    expect(planHash(arrayReordered)).not.toBe(planHash(PLAN));
    expect(canonicalPlanJson({ b: 1, a: [true, null, 'x'] })).toBe('{"a":[true,null,"x"],"b":1}');
  });

  it('validates the real producer plan and progress shapes', () => {
    const plan = validateLaunchPlan(PLAN);
    expect(plan.ok).toBe(true);
    if (plan.ok) expect(plan.manifest.pages).toHaveLength(4);

    const progress = validateLaunchProgress(PROGRESS);
    expect(progress.ok).toBe(true);
    if (progress.ok) expect(progress.manifest.units.page_landing.state).toBe('done');
  });

  it('rejects non-objects, arrays, wrong schema versions and foreign ids', () => {
    expect(validateLaunchPlan(null)).toMatchObject({ ok: false, code: 'not_an_object' });
    expect(validateLaunchPlan([])).toMatchObject({ ok: false, code: 'not_an_object' });
    expect(validateLaunchPlan({ ...PLAN, schema_version: '2.0.0' }))
      .toMatchObject({ ok: false, code: 'unsupported_schema' });
    expect(validateLaunchPlan({ ...PLAN, launch_id: 'Not A Slug' }))
      .toMatchObject({ ok: false, code: 'invalid_manifest' });
    expect(validateLaunchProgress({ ...PROGRESS, schema_version: '1.0.0' }))
      .toMatchObject({ ok: false, code: 'unsupported_schema' });
    expect(validateLaunchProgress({ ...PROGRESS, plan_hash: 'sha256:short' }))
      .toMatchObject({ ok: false, code: 'invalid_manifest' });
    expect(validateLaunchProgress({
      ...PROGRESS,
      units: { a: { kind: 'page', waits_for: ['missing'], state: 'done' } },
    })).toMatchObject({ ok: false, code: 'invalid_manifest' });
  });

  it('discovers plan and progress files by type, and reports an absent directory as unavailable', () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'a.plan.json'), '{}');
    fs.writeFileSync(path.join(dir, 'a.progress.json'), '{}');
    fs.writeFileSync(path.join(dir, 'legacy.json'), '{}');
    fs.writeFileSync(path.join(dir, 'progress-sample-launch.json'), '{}');
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'ignored');

    const discovery = discoverLaunchFiles(dir);
    expect(discovery.availability).toBe('ok');
    expect(discovery.files.map((file) => [file.name, file.kind, file.legacyPlan])).toEqual([
      ['a.plan.json', 'plan', false],
      ['a.progress.json', 'progress', false],
      ['legacy.json', 'plan', true],
      ['progress-sample-launch.json', 'progress', false],
    ]);

    const missing = discoverLaunchFiles(path.join(os.tmpdir(), 'cc-UL-022-no-such-dir'));
    expect(missing.availability).toBe('unavailable');
    expect(missing.errors[0].code).toBe('unreadable_directory');
  });

  it('states the disk-versus-database relationship without inventing matches', () => {
    const relation = relateLaunchViews(['launch-a', 'launch-b'], ['launch-b', 'launch-c']);
    expect(relation.diskOnly).toEqual(['launch-a']);
    expect(relation.databaseOnly).toEqual(['launch-c']);
    expect(relation.both).toEqual(['launch-b']);
    expect(relation.note).toMatch(/Neither overrides the other/);
  });
});
