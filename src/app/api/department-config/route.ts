import { NextRequest, NextResponse } from 'next/server';
import {
  type DepartmentConfigAssignment,
  type DepartmentConfigKpiTarget,
  readDepartmentConfig,
} from '@/lib/department-config';
import { resolveDepartment } from '@/lib/routing/resolve-department';

// Runtime route — opt out of static prerender (reads the request's department
// param and per-department config files from disk).
export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * GET /api/department-config?department=<slug-or-id>
 *
 * Closes the CHECKLIST.md "Department Boards → Data → Reads
 * department-config.json" gap (2026-10-19: "no code under src reads that
 * file; it is not yet decided where per-department settings live").
 *
 * DECISION (the file contract lives in src/lib/department-config.ts):
 * per-department settings live in the Skill 23 convention location
 * ($WORKSPACE_BASE_PATH/workspace/departments/<slug>/department-config.json;
 * SKILL.md §515 names the ~/.openclaw form). The file is OPTIONAL — 0 of 74
 * department folders ship one today, so a missing file is a NORMAL state:
 * the route reports { found: false, expectedPath }, never a 500, and never
 * fabricated KPIs/assignments (the checklist's "no synthetic data" rule).
 *
 * File shape (tolerant parse — see coerceDepartmentConfig):
 * {
 *   "department": "project-architecture-office",
 *   "kpi_targets": [ { "name": "QC pass rate", "target": 85, "unit": "percent" } ],
 *   "specialist_assignments": [ { "role": "Code Monitor", "agent": "agent-name-or-id" } ],
 *   "notes": "free text, optional"
 * }
 */

export interface DepartmentConfigResponse {
  found: boolean;
  parseError?: string;
  sourcePath?: string;
  expectedPath?: string;
  department?: { slug: string; name: string };
  kpiTargets?: DepartmentConfigKpiTarget[];
  assignments?: DepartmentConfigAssignment[];
  notes?: string;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const param = request.nextUrl.searchParams.get('department');
  if (!param) {
    return NextResponse.json({ error: 'department query parameter is required' }, { status: 400 });
  }

  const resolved = await resolveDepartment(param);
  // No-match is NOT an error: the caller may probe a department that does not
  // exist yet; report found:false with the raw param as the slug.
  const slug = resolved?.slug ?? param;
  const deptInfo = resolved ? { slug: resolved.slug, name: resolved.name } : { slug, name: param };

  const read = readDepartmentConfig(slug);
  return NextResponse.json<DepartmentConfigResponse>({
    found: read.found,
    parseError: read.parseError,
    sourcePath: read.sourcePath,
    expectedPath: read.expectedPath,
    department: deptInfo,
    kpiTargets: read.kpiTargets,
    assignments: read.assignments,
    notes: read.notes,
  });
}
