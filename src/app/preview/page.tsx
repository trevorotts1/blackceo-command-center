/**
 * /preview — the READ-ONLY company preview (AI Workforce standard-first
 * redesign, Option L1).
 *
 * THE DOCTRINE THIS PAGE EXISTS TO SERVE
 * ---------------------------------------
 * The interview shell-lock is RATIFIED (WG-9 / OQ-1): while the interview is
 * incomplete the dashboard stays the closeout reveal — every non-exempt page
 * 302s to /interview. Standard-first onboarding adds a THIRD state: the box is
 * standard-prebuilt (canonical floor materialized from the role library, chosen
 * artifact written, board seeded) WHILE the interview is still incomplete. The
 * day-one interview link must be able to show the owner that their company's
 * foundation already exists — without loosening the ratified lock.
 *
 * Option L1's answer: keep the lock exactly as ratified and add THIS page to
 * the exemption list (src/middleware.ts isInterviewGateExempt) as a READ-ONLY
 * company view. The interview stays the action surface; the preview is the
 * motivation surface.
 *
 * READ-ONLY GUARANTEE (binding — the E2E asserts it, interview-lock.spec.ts
 * SF-5): this page is a pure server-rendered read. It renders ZERO forms, ZERO
 * buttons, ZERO links — no mutation route is reachable from it. It reads the
 * chosen-departments artifact (departments.json, via the shared resolver) and
 * the seeded workspaces rows, and nothing else. It NEVER writes state: not
 * interviewComplete, not standardPrebuild, not a decision — the seam doctrine
 * (src/lib/interview/seam.ts) says those writes belong exclusively to the
 * Skill-23 scripts, and this page honors that by writing nothing at all.
 *
 * STATE SEMANTICS
 * ---------------
 *   • standardReady (build-state standardPrebuild.status === "done") drives the
 *     "your standard foundation is in place" framing.
 *   • interviewComplete stays the ONLY unlock signal — this page never reads
 *     or derives completion, and its exemption never admits any other route.
 *   • A box with no chosen artifact yet renders a "not ready" placeholder —
 *     never a demo/template department list (never fabricate a company).
 *
 * The count of departments is NEVER hardcoded here (live artifact only — the
 * floor is version-dependent; read from the artifact the prebuild wrote).
 */

import { loadCompanyConfig } from '@/lib/company-config';
import { readBuildState } from '@/lib/interview/seam';
import { resolveDepartmentsConfigPath } from '@/lib/db/migrations';
import fs from 'fs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

/** One department as the chosen artifact + board seed it. */
interface PreviewDepartment {
  id: string;
  name: string;
  emoji?: string;
}

/** Shape of the standardPrebuild build-state block (PHASE 1 schema). */
interface StandardPrebuildRecord {
  status?: string;
  standardReadyAt?: string;
  [k: string]: unknown;
}

/** Derive a human display name from a slug (mirrors seed-workspaces.py's
 *  derivation: strip dept- affixes, hyphens/underscores → spaces, title-case). */
function displayNameFromSlug(slug: string): string {
  const base = slug.replace(/^dept-/, '').replace(/-dept$/, '');
  const display = base.replace(/[-_]/g, ' ').trim();
  if (!display) return slug;
  return display.replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Normalize a parsed departments.json payload into PreviewDepartment[].
 * Mirrors seed-workspaces.py `_normalize_departments`: the artifact comes in
 * three shapes in the wild (canonical array-of-objects, bare-string list,
 * dict-of-dicts keyed by slug); all three must render. Anything that cannot
 * name a department is dropped — the preview never invents one.
 */
function normalizeDepartments(data: unknown): PreviewDepartment[] {
  let items: unknown[] = [];

  if (Array.isArray(data)) {
    items = data;
  } else if (data && typeof data === 'object') {
    // Dict-of-dicts keyed by slug: fold the key in as the id.
    items = Object.entries(data as Record<string, unknown>).map(([slug, value]) =>
      value && typeof value === 'object' ? { ...(value as object), id: slug } : { id: slug },
    );
  } else {
    return [];
  }

  const out: PreviewDepartment[] = [];
  for (const raw of items) {
    if (typeof raw === 'string') {
      const slug = raw.trim();
      if (!slug) continue;
      out.push({ id: slug, name: displayNameFromSlug(slug) });
      continue;
    }
    if (raw && typeof raw === 'object') {
      const entry = raw as Record<string, unknown>;
      const id =
        typeof entry.id === 'string' && entry.id.trim()
          ? entry.id.trim()
          : typeof entry.slug === 'string' && entry.slug.trim()
            ? entry.slug.trim()
            : typeof entry.dept === 'string' && entry.dept.trim()
              ? entry.dept.trim()
              : typeof entry.key === 'string' && entry.key.trim()
                ? entry.key.trim()
                : '';
      if (!id) continue;
      const name =
        typeof entry.name === 'string' && entry.name.trim()
          ? entry.name.trim()
          : displayNameFromSlug(id);
      const emoji = typeof entry.emoji === 'string' && entry.emoji.trim() ? entry.emoji : undefined;
      out.push({ id, name, emoji });
    }
    // Anything else (null, number, nested list) cannot name a department — drop.
  }
  return out;
}

/** Read + parse the resolved chosen-departments artifact. Never throws. */
function readChosenDepartments(): { departments: PreviewDepartment[]; resolved: boolean } {
  const configPath = resolveDepartmentsConfigPath();
  if (!configPath) return { departments: [], resolved: false };
  try {
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    return { departments: normalizeDepartments(raw), resolved: true };
  } catch {
    return { departments: [], resolved: false };
  }
}

/** READ-ONLY: count the seeded board lanes (workspaces rows). Never throws — a
 *  DB the board seed has not reached yet degrades to zero lanes, and the page
 *  still renders the chosen artifact. */
function readSeededLaneCount(): number {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getDb } = require('@/lib/db') as typeof import('@/lib/db');
    const db = getDb();
    const row = db
      .prepare('SELECT COUNT(*) AS c FROM workspaces WHERE archived_at IS NULL')
      .get() as { c: number } | undefined;
    return row?.c ?? 0;
  } catch {
    return 0;
  }
}

export default function PreviewPage() {
  const config = loadCompanyConfig();
  const buildState = readBuildState();
  const standardPrebuild = (buildState?.standardPrebuild ?? null) as StandardPrebuildRecord | null;
  const standardReady = standardPrebuild?.status === 'done';
  const interviewComplete = buildState?.interviewComplete === true;

  const { departments, resolved } = readChosenDepartments();
  const laneCount = readSeededLaneCount();

  // NO chosen artifact yet → the standard foundation is not written. Render the
  // honest placeholder — never a demo department list (no fabricated company).
  if (!resolved || departments.length === 0) {
    return (
      <main className="iv-root p-8">
        <div className="max-w-3xl mx-auto text-center">
          <h1 className="text-3xl font-bold text-gray-900 mb-2">
            {config.companyName || 'Your company'}
          </h1>
          <p data-testid="preview-not-ready" className="text-gray-600 mt-4">
            Your company&apos;s standard foundation is not ready to preview yet. Complete the
            interview to tailor it to your business.
          </p>
          <p className="text-sm text-gray-500 mt-6">
            This page is a read-only preview. It contains no actions.
          </p>
        </div>
      </main>
    );
  }

  return (
    <main className="iv-root p-8">
      <div className="max-w-3xl mx-auto">
        <div className="text-center mb-8">
          <h1 className="text-3xl font-bold text-gray-900 mb-2">
            {config.companyName || 'Your company'}
          </h1>
          {standardReady && !interviewComplete && (
            <p data-testid="preview-standard-ready" className="text-gray-600">
              Your company&apos;s standard foundation is in place — {departments.length}{' '}
              department{departments.length === 1 ? '' : 's'}, pre-built and ready. The interview
              tailors it to your business.
            </p>
          )}
          {standardReady && interviewComplete && (
            <p data-testid="preview-standard-ready-complete" className="text-gray-600">
              Your company&apos;s standard foundation is in place and your interview is complete —{' '}
              {departments.length} department{departments.length === 1 ? '' : 's'}.
            </p>
          )}
          {!standardReady && interviewComplete && (
            <p className="text-gray-600">
              Your company — {departments.length} department{departments.length === 1 ? '' : 's'}.
            </p>
          )}
          {!standardReady && !interviewComplete && (
            <p className="text-gray-600">
              {departments.length} department{departments.length === 1 ? '' : 's'} on the board.
            </p>
          )}
        </div>

        <div className="bg-white rounded-2xl shadow-sm border p-6 mb-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm font-semibold text-gray-700 uppercase tracking-wide">
              Departments
            </h2>
            <span data-testid="preview-department-count" className="text-sm text-gray-500">
              {departments.length} total
            </span>
          </div>
          <ul className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {departments.map((dept) => (
              <li
                key={dept.id}
                className="flex items-center gap-3 rounded-xl border border-gray-100 bg-gray-50 px-4 py-3"
              >
                <span aria-hidden="true" className="text-xl">
                  {dept.emoji ?? '🏢'}
                </span>
                <span className="flex flex-col min-w-0">
                  <span className="text-sm font-medium text-gray-900 truncate">{dept.name}</span>
                  {/* The slug renders as VISIBLE text (not just a key) so the
                      lock E2E can prove this view was driven by the fixture's
                      chosen artifact, not by a demo/template manifest. */}
                  <span className="text-xs text-gray-500 truncate">{dept.id}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>

        {laneCount > 0 && (
          <p data-testid="preview-lane-count" className="text-sm text-gray-500 text-center mb-4">
            {laneCount} board lane{laneCount === 1 ? '' : 's'} seeded.
          </p>
        )}

        <p className="text-sm text-gray-500 text-center">
          This page is a read-only preview — no tasks, no chat, no actions. Finish the interview to
          open the full Command Center.
        </p>
      </div>
    </main>
  );
}
