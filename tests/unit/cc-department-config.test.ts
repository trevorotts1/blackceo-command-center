/**
 * CC feature-wiring recovery (2026-10-21) — department-config reader.
 *
 * Proves the "Department Boards → Reads department-config.json" integration:
 * candidate-path precedence/dedup, tolerant JSON coercion (one bad entry
 * never sinks the file; missing sections are empty lists, never fabricated
 * values), and the missing-vs-malformed file distinction that the route
 * surfaces as found:false vs found:true+parseError.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  coerceDepartmentConfig,
  departmentConfigCandidatePaths,
  readDepartmentConfig,
} from '../../src/lib/department-config';

describe('department config — candidate paths', () => {
  it('respects WORKSPACE_BASE_PATH (~ expanded) and dedupes coinciding bases', () => {
    const env = { HOME: '/home/trevor', WORKSPACE_BASE_PATH: '~/.openclaw' };
    const paths = departmentConfigCandidatePaths('marketing', env as NodeJS.ProcessEnv);
    // env base == canonical ~/.openclaw → deduped to two distinct bases (+clawd)
    expect(paths).toEqual([
      '/home/trevor/.openclaw/workspace/departments/marketing/department-config.json',
      '/home/trevor/clawd/workspace/departments/marketing/department-config.json',
    ]);
  });

  it('a distinct WORKSPACE_BASE_PATH ranks first, then the canonical bases', () => {
    const env = { HOME: '/home/trevor', WORKSPACE_BASE_PATH: '/srv/openclaw' };
    const paths = departmentConfigCandidatePaths('sales', env as NodeJS.ProcessEnv);
    expect(paths[0]).toBe('/srv/openclaw/workspace/departments/sales/department-config.json');
    expect(paths[1]).toBe('/home/trevor/.openclaw/workspace/departments/sales/department-config.json');
    expect(paths[2]).toBe('/home/trevor/clawd/workspace/departments/sales/department-config.json');
  });
});

describe('department config — tolerant coercion', () => {
  it('keeps well-formed entries and skips bad ones entry-by-entry', () => {
    const { kpiTargets, assignments, notes } = coerceDepartmentConfig({
      kpi_targets: [
        { name: 'QC pass rate', target: 85, unit: 'percent' },
        { name: 'should be skipped', target: 'not-a-number' }, // bad → skipped
        { no_name: 1 }, // bad → skipped
      ],
      specialist_assignments: [
        { role: 'Code Monitor', agent: 'cm-1' },
        { role: 'QC Agent', agent: 42 }, // bad → skipped
      ],
      notes: '  build 2026-10-21  ',
      unknown_key: 'ignored',
    });
    expect(kpiTargets).toEqual([{ name: 'QC pass rate', target: 85, unit: 'percent' }]);
    expect(assignments).toEqual([{ role: 'Code Monitor', agent: 'cm-1' }]);
    expect(notes).toBe('build 2026-10-21');
  });

  it('never fabricates: absent sections are empty lists, not defaults', () => {
    const { kpiTargets, assignments, notes } = coerceDepartmentConfig({});
    expect(kpiTargets).toEqual([]);
    expect(assignments).toEqual([]);
    expect(notes).toBeUndefined();
  });

  it('tolerates a JSON array at the top level (wrong shape, not a crash)', () => {
    const { kpiTargets } = coerceDepartmentConfig([1, 2, 3]);
    expect(kpiTargets).toEqual([]);
  });
});

describe('department config — file reads', () => {
  let dir: string;
  let savedHome: string | undefined;
  let savedWbp: string | undefined;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dept-config-test-'));
    savedHome = process.env.HOME;
    savedWbp = process.env.WORKSPACE_BASE_PATH;
  });

  afterEach(() => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedWbp === undefined) delete process.env.WORKSPACE_BASE_PATH;
    else process.env.WORKSPACE_BASE_PATH = savedWbp;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('reports found:false with the expected path when no candidate file exists (the NORMAL state today)', () => {
    process.env.HOME = dir;
    delete process.env.WORKSPACE_BASE_PATH;
    const read = readDepartmentConfig('marketing');
    expect(read.found).toBe(false);
    expect(read.expectedPath).toBe(
      path.join(dir, '.openclaw', 'workspace', 'departments', 'marketing', 'department-config.json'),
    );
    expect(read.kpiTargets).toEqual([]);
  });

  it('reads the file when present and coerces its contents', () => {
    process.env.HOME = dir;
    delete process.env.WORKSPACE_BASE_PATH;
    const p = path.join(dir, '.openclaw', 'workspace', 'departments', 'marketing');
    fs.mkdirSync(p, { recursive: true });
    fs.writeFileSync(
      path.join(p, 'department-config.json'),
      JSON.stringify({
        department: 'marketing',
        kpi_targets: [{ name: 'Pipeline velocity', target: 12, unit: 'count' }],
        specialist_assignments: [{ role: 'Code Monitor', agent: 'cm-1' }],
      }),
    );
    const read = readDepartmentConfig('marketing');
    expect(read.found).toBe(true);
    expect(read.sourcePath).toBe(path.join(p, 'department-config.json'));
    expect(read.kpiTargets).toEqual([{ name: 'Pipeline velocity', target: 12, unit: 'count' }]);
    expect(read.assignments).toEqual([{ role: 'Code Monitor', agent: 'cm-1' }]);
  });

  it('reports found:true + parseError for a malformed file — never 500, never silent', () => {
    process.env.HOME = dir;
    delete process.env.WORKSPACE_BASE_PATH;
    const p = path.join(dir, '.openclaw', 'workspace', 'departments', 'sales');
    fs.mkdirSync(p, { recursive: true });
    fs.writeFileSync(path.join(p, 'department-config.json'), '{ not valid json');
    const read = readDepartmentConfig('sales');
    expect(read.found).toBe(true);
    expect(read.parseError).toBeTruthy();
    expect(read.kpiTargets).toEqual([]);
  });
});
