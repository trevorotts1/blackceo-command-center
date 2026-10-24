/**
 * Department config reader — the Skill 23 `department-config.json` convention.
 *
 * CHECKLIST.md "Department Boards → Data → Reads department-config.json" was
 * the open gap this closes: no code under src/ read the file the PRD §2 lists
 * as a Department Boards data source. DECISION (see the route's docstring):
 * per-department settings live at
 *   $WORKSPACE_BASE_PATH/workspace/departments/<slug>/department-config.json
 * (WORKSPACE_BASE_PATH is ~-expanded; the Skill 23 doc at
 * 23-ai-workforce-blueprint/SKILL.md §515 names the ~/.openclaw form).
 *
 * The file is OPTIONAL — 0 of 74 department folders ship one today, so a
 * missing file is a NORMAL state, reported as found:false. Malformed JSON is
 * reported as found:true + parseError, never silently dropped, never a 500.
 */
import os from 'os';
import path from 'path';
import { safeReadFileUtf8 } from '@/lib/fs/safe-fs';

export interface DepartmentConfigKpiTarget {
  name: string;
  target: number;
  unit?: string;
}

export interface DepartmentConfigAssignment {
  role: string;
  agent: string;
}

export interface DepartmentConfigRead {
  found: boolean;
  /** True when the file exists but is not valid JSON (malformed, not missing). */
  parseError?: string;
  /** The candidate path that was read (found=true) or the first expected path (found=false). */
  sourcePath?: string;
  /** The canonical expected location the operator should create the file at. */
  expectedPath?: string;
  kpiTargets: DepartmentConfigKpiTarget[];
  assignments: DepartmentConfigAssignment[];
  notes?: string;
}

/**
 * Candidate file locations for a department's department-config.json, in
 * precedence order. Deduped: with WORKSPACE_BASE_PATH unset, the env-derived
 * base and the canonical ~/.openclaw base coincide.
 *
 * Pure (reads only process.env + os at call time) so tests can drive the
 * candidate list by monkey-patching env without touching the filesystem.
 */
export function departmentConfigCandidatePaths(slug: string, env?: NodeJS.ProcessEnv): string[] {
  const e = env ?? process.env;
  const homedir = e.HOME || e.USERPROFILE || os.homedir();
  const envBase = e.WORKSPACE_BASE_PATH;
  const bases = [
    envBase ? path.resolve(envBase.replace(/^~/, homedir)) : path.join(homedir, '.openclaw'),
    path.join(homedir, '.openclaw'),
    path.join(homedir, 'clawd'),
  ];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const b of bases) {
    if (seen.has(b)) continue;
    seen.add(b);
    out.push(path.join(b, 'workspace', 'departments', slug, 'department-config.json'));
  }
  return out;
}

/**
 * Tolerant coercion of parsed JSON into the board's shape. Unknown keys are
 * ignored; malformed entries (wrong types) are skipped entry-by-entry so one
 * bad KPI row never sinks the whole file. NEVER invents entries: a missing
 * section is an empty list, not a fabricated default.
 */
export function coerceDepartmentConfig(raw: unknown): {
  kpiTargets: DepartmentConfigKpiTarget[];
  assignments: DepartmentConfigAssignment[];
  notes?: string;
} {
  const obj = (raw ?? {}) as Record<string, unknown>;
  const kpiTargets: DepartmentConfigKpiTarget[] = [];
  if (Array.isArray(obj.kpi_targets)) {
    for (const item of obj.kpi_targets) {
      const t = item as Record<string, unknown>;
      if (typeof t?.name === 'string' && typeof t?.target === 'number') {
        kpiTargets.push({
          name: t.name,
          target: t.target,
          unit: typeof t.unit === 'string' ? t.unit : undefined,
        });
      }
    }
  }
  const assignments: DepartmentConfigAssignment[] = [];
  if (Array.isArray(obj.specialist_assignments)) {
    for (const item of obj.specialist_assignments) {
      const a = item as Record<string, unknown>;
      if (typeof a?.role === 'string' && typeof a?.agent === 'string') {
        assignments.push({ role: a.role, agent: a.agent });
      }
    }
  }
  const notes = typeof obj.notes === 'string' && obj.notes.trim() ? obj.notes.trim() : undefined;
  return { kpiTargets, assignments, notes };
}

/**
 * Read the first existing candidate. safeReadFileUtf8 keeps this TCC-safe on
 * macOS (a raw readFileSync under ~/Downloads etc. would hang the caller).
 */
export function readDepartmentConfig(slug: string, env?: NodeJS.ProcessEnv): DepartmentConfigRead {
  const candidates = departmentConfigCandidatePaths(slug, env);
  for (const p of candidates) {
    const raw = safeReadFileUtf8(p);
    if (raw == null) continue;
    try {
      const parsed: unknown = JSON.parse(raw);
      const coerced = coerceDepartmentConfig(parsed);
      return {
        found: true,
        sourcePath: p,
        expectedPath: p,
        ...coerced,
      };
    } catch (e) {
      return {
        found: true,
        sourcePath: p,
        expectedPath: p,
        parseError: e instanceof Error ? e.message : String(e),
        kpiTargets: [],
        assignments: [],
      };
    }
  }
  return {
    found: false,
    expectedPath: candidates[0],
    kpiTargets: [],
    assignments: [],
  };
}
