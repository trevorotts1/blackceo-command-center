/**
 * Role-library bridge — ingest the Skill-23 on-disk SOP library into the
 * Command Center `sops` table.
 *
 * BACKGROUND (audit gaps SOP-1 / SOP-2)
 * -------------------------------------
 * The Command Center carries two SOP layers that historically shared no key:
 *
 *   LAYER 1 — the 23 department-level "starter" SOPs seeded from
 *             src/lib/sops-seed.ts into the `sops` table (department-keyed,
 *             no role). These power the board's Triad Rule out of the box.
 *
 *   LAYER 2 — the per-ROLE on-disk how-to.md files the agents actually run,
 *             emitted by the ZHC build at
 *               <workspace>/departments/<dept>/<NN-role>/how-to.md
 *             (the role folder's full operating procedure, often instantiated
 *             from the pre-written role-library).
 *
 * Nothing synced the two, so an operator browsing the CC SOP library saw 23
 * generic starter SOPs while the agents on disk operated from a different,
 * larger, role-specific set. This module bridges Layer 2 -> Layer 1: it walks
 * a departments tree, parses each role's how-to.md, and UPSERTS it into the
 * `sops` table tagged with `department`, `role`, and `source='role-library'`.
 *
 * SAFETY CONTRACT
 * ---------------
 *   - Stable key: every imported row uses slug `role-library:<dept>/<role>`,
 *     so re-running upserts the SAME row instead of duplicating.
 *   - Never duplicates: idempotent on that slug (UPDATE on hit, INSERT on miss).
 *   - Never deletes user-authored SOPs: only rows with source='role-library'
 *     are ever written/replaced. Starter, hand-authored, and learning-loop
 *     SOPs (source IS NULL) are untouched.
 *   - Pruning is opt-in (pruneMissing) and STILL only soft-deletes rows whose
 *     source='role-library' that no longer exist on disk — never NULL-source.
 *
 * Framework-light: pure functions on top of the db helpers so the API route,
 * the standalone script, and tests can all reuse them.
 */
import { v4 as uuidv4 } from 'uuid';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { queryAll, queryOne, run, transaction } from '@/lib/db';
import type { SOPStep, SOP } from '@/lib/sops';
import { storeEmbeddingForSOP } from '@/lib/sop-embeddings';

export const ROLE_LIBRARY_SOURCE = 'role-library';

/** Default workspace path, same env var the auto-replace module uses. */
const WORKSPACE_BASE = process.env.OPENCLAW_WORKSPACE_PATH || '/data/.openclaw/workspace';

/**
 * Parent roots the Skill-23 floor materializes per-company ZHC folders under,
 * each holding a `<slug>/departments/` tree of role how-to.md files. Coordinated
 * with build-workforce.py (MASTER_FILES_DIR / the canonical zero-human-company
 * roots). Used ONLY to fill the default when nothing explicit is provided.
 */
function zeroHumanCompanyRoots(): string[] {
  const roots: string[] = [];
  const masterFiles = (process.env.MASTER_FILES_DIR || '').trim();
  if (masterFiles) roots.push(path.join(masterFiles, 'zero-human-company'));
  roots.push(
    path.join(os.homedir(), 'Downloads', 'openclaw-master-files', 'zero-human-company'),
    '/data/openclaw-master-files/zero-human-company',
    path.join(os.homedir(), 'clawd', 'zero-human-company')
  );
  return roots;
}

/** Newest <root>/<slug>/departments tree across all ZHC roots, or null. */
function newestZhcDepartmentsTree(): string | null {
  let best: { p: string; mtime: number } | null = null;
  for (const root of zeroHumanCompanyRoots()) {
    let slugs: string[];
    try {
      slugs = fs.readdirSync(root);
    } catch {
      continue;
    }
    for (const slug of slugs) {
      const tree = path.join(root, slug, 'departments');
      if (!isDir(tree)) continue;
      let mtime = 0;
      try {
        mtime = fs.statSync(tree).mtimeMs;
      } catch {
        continue;
      }
      if (!best || mtime > best.mtime) best = { p: tree, mtime };
    }
  }
  return best ? best.p : null;
}

/**
 * Resolve the departments/ tree to scan. Order of precedence:
 *   1. explicit `departmentsPath` argument           (honored verbatim)
 *   2. ROLE_LIBRARY_PATH env var                      (honored verbatim)
 *   3. existence-aware default — the FIRST tree that actually exists among:
 *        a. $ZERO_HUMAN_COMPANY_DIR/departments       (explicit company folder)
 *        b. <OPENCLAW_WORKSPACE_PATH>/departments      (the historic default —
 *           keeps every box that already works untouched)
 *        c. the newest zero-human-company/<slug>/departments the floor wrote
 *   4. else the historic default string verbatim, so the reported path and the
 *      tolerant "missing dir → []" behavior are unchanged.
 *
 * Branches 1 and 2 are returned verbatim WITHOUT an existence check (tests and
 * operator overrides may legitimately point at a not-yet-populated path). Only
 * the DEFAULT is existence-aware, and only via NEW candidates that are unset on
 * existing boxes — so this is additive and cannot regress a working install.
 */
export function resolveDepartmentsPath(departmentsPath?: string | null): string {
  if (departmentsPath && departmentsPath.trim()) return departmentsPath.trim();
  if (process.env.ROLE_LIBRARY_PATH && process.env.ROLE_LIBRARY_PATH.trim()) {
    return process.env.ROLE_LIBRARY_PATH.trim();
  }

  const workspaceDefault = path.join(WORKSPACE_BASE, 'departments');
  const candidates: string[] = [];
  const explicitCompany = (process.env.ZERO_HUMAN_COMPANY_DIR || '').trim();
  if (explicitCompany) candidates.push(path.join(explicitCompany, 'departments'));
  candidates.push(workspaceDefault);
  const newest = newestZhcDepartmentsTree();
  if (newest) candidates.push(newest);

  for (const cand of candidates) {
    if (isDir(cand)) return cand;
  }
  return workspaceDefault;
}

export interface RoleHowTo {
  department: string; // dept folder slug
  role: string; // role folder slug (numeric prefix stripped)
  roleDirName: string; // raw folder name e.g. "03-appointment-setter"
  filePath: string;
  markdown: string;
}

export interface ImportedSOPSummary {
  slug: string;
  department: string;
  role: string;
  name: string;
  action: 'inserted' | 'updated' | 'skipped';
  reason?: string;
}

export interface ImportResult {
  departments_path: string;
  scanned_roles: number;
  inserted: number;
  updated: number;
  skipped: number;
  pruned: number;
  items: ImportedSOPSummary[];
}

// ---------- discovery ----------

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Strip a leading "NN-" numeric prefix from a role folder name. */
function normalizeRoleSlug(folderName: string): string {
  return folderName.replace(/^\d+[-_]/, '').trim();
}

/**
 * Walk <departmentsPath>/<dept>/<NN-role>/how-to.md and collect every role's
 * how-to. Tolerant of missing folders / files — a role with no how-to.md is
 * simply skipped (not an error).
 */
export function discoverRoleHowTos(departmentsPath: string): RoleHowTo[] {
  const out: RoleHowTo[] = [];
  if (!isDir(departmentsPath)) return out;

  for (const deptName of fs.readdirSync(departmentsPath)) {
    const deptDir = path.join(departmentsPath, deptName);
    if (!isDir(deptDir)) continue;
    const department = deptName.replace(/-dept$/, '');

    for (const roleDirName of fs.readdirSync(deptDir)) {
      const roleDir = path.join(deptDir, roleDirName);
      if (!isDir(roleDir)) continue;
      const howToPath = path.join(roleDir, 'how-to.md');
      let markdown = '';
      try {
        markdown = fs.readFileSync(howToPath, 'utf8');
      } catch {
        continue; // no how-to.md in this role folder
      }
      if (!markdown.trim()) continue;
      out.push({
        department,
        role: normalizeRoleSlug(roleDirName),
        roleDirName,
        filePath: howToPath,
        markdown,
      });
    }
  }
  return out;
}

// ---------- parsing ----------

/** First markdown H1/H2 as the doc title, else the role slug humanized. */
function extractTitle(markdown: string, fallback: string): string {
  const h1 = markdown.match(/^#\s+(.+)$/m);
  if (h1) return h1[1].trim();
  const h2 = markdown.match(/^##\s+(.+)$/m);
  if (h2) return h2[1].trim();
  return fallback
    .split(/[-_]/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/**
 * Extract SOP steps from a how-to.md. Strategy, in order:
 *   1. If a "Section 9" / "## 9" / "SOPs" heading exists, treat every `### SOP
 *      9.x` (or `### <title>`) subheading under it as one step.
 *   2. Otherwise, use the document's `##`/`###` headings (excluding the title)
 *      as steps.
 *   3. Otherwise, fall back to a single "Follow how-to.md" step.
 *
 * The first non-empty paragraph under each heading becomes that step's
 * success_criteria hint. Always returns at least one step so the row passes the
 * sops table's NOT NULL `steps` and the parseAndValidateSteps contract.
 */
export function extractStepsFromHowTo(markdown: string, roleName: string): SOPStep[] {
  const lines = markdown.split('\n');

  // Find a Section-9 / SOPs anchor. The "9" alternatives are deliberately
  // tight: a heading is only treated as the SOP section anchor when the 9 is a
  // genuine SECTION NUMBER — i.e. "9" followed by a section delimiter (".", ":",
  // ")", "-") and/or an SOP-ish word — never a heading that merely *starts* with
  // "9 " (e.g. "## 9 things to know"), which would silently hijack the parse and
  // drop the real first step. Recognized forms:
  //   "Section 9", "Section 9: SOPs"
  //   "9. ...", "9: ...", "9) ...", "9 - SOPs", "9 SOP(s)", "9 Standard Operating..."
  //   "SOP" / "SOPs" / "Standard Operating Procedure(s)" headings
  const SOP_SECTION_ANCHOR =
    /^#{1,3}\s+(section\s*9\b|9\s*[.:)]|9\s+[-–—]\s|9\s+(sops?\b|standard\s+operating)|sops?\b|standard\s+operating\s+procedures?\b)/i;
  let sopSectionStart = -1;
  for (let i = 0; i < lines.length; i++) {
    if (SOP_SECTION_ANCHOR.test(lines[i])) {
      sopSectionStart = i;
      break;
    }
  }

  const headings: { level: number; text: string; lineIdx: number }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(#{2,4})\s+(.+)$/);
    if (m) headings.push({ level: m[1].length, text: m[2].trim(), lineIdx: i });
  }

  // Pick the heading set to turn into steps.
  let stepHeadings: { text: string; lineIdx: number }[];
  if (sopSectionStart >= 0) {
    // headings strictly after the Section-9 anchor that are deeper than it
    const anchorLevel = (lines[sopSectionStart].match(/^(#{1,3})/) || ['', '##'])[1].length;
    stepHeadings = headings
      .filter((h) => h.lineIdx > sopSectionStart && h.level > anchorLevel)
      .map((h) => ({ text: h.text, lineIdx: h.lineIdx }));
    if (stepHeadings.length === 0) {
      // Section 9 with no subheadings — fall back to all body headings.
      stepHeadings = headings.filter((h) => h.lineIdx !== 0).map((h) => ({ text: h.text, lineIdx: h.lineIdx }));
    }
  } else {
    stepHeadings = headings.map((h) => ({ text: h.text, lineIdx: h.lineIdx }));
  }

  // Drop a heading that duplicates the doc title (first H1).
  const titleText = extractTitle(markdown, roleName).toLowerCase();
  stepHeadings = stepHeadings.filter((h) => h.text.toLowerCase() !== titleText);

  if (stepHeadings.length === 0) {
    return [
      {
        name: `Follow ${roleName} how-to`,
        success_criteria: 'Read and follow the role how-to.md before executing the task.',
      },
    ];
  }

  return stepHeadings.slice(0, 25).map((h, idx) => {
    // First non-empty, non-heading line after this heading = a hint.
    let hint = '';
    for (let j = h.lineIdx + 1; j < lines.length; j++) {
      const l = lines[j].trim();
      if (!l) continue;
      if (/^#{1,6}\s/.test(l)) break;
      hint = l.replace(/^[-*]\s+/, '').slice(0, 200);
      break;
    }
    return {
      name: `${idx + 1}. ${h.text.replace(/^sop\s*\d+(\.\d+)?\s*[:.-]?\s*/i, '').slice(0, 120)}`,
      success_criteria: hint || undefined,
    };
  });
}

function extractDescription(markdown: string): string {
  // First non-empty paragraph that isn't a heading.
  const lines = markdown.split('\n');
  for (const raw of lines) {
    const l = raw.trim();
    if (!l || l.startsWith('#') || l.startsWith('>')) continue;
    return l.replace(/^[-*]\s+/, '').slice(0, 280);
  }
  return '';
}

export interface ParsedRoleSOP {
  slug: string;
  name: string;
  description: string;
  department: string;
  role: string;
  task_keywords: string;
  steps: SOPStep[];
}

/** Stable, collision-proof slug for an imported role SOP. */
export function roleLibrarySlug(department: string, role: string): string {
  return `${ROLE_LIBRARY_SOURCE}:${department}/${role}`;
}

export function parseRoleHowTo(howto: RoleHowTo): ParsedRoleSOP {
  const name = extractTitle(howto.markdown, howto.role);
  const steps = extractStepsFromHowTo(howto.markdown, howto.role);
  const keywords = Array.from(
    new Set(
      [howto.role, howto.department, ...howto.role.split(/[-_]/)]
        .map((k) => k.toLowerCase().trim())
        .filter((k) => k.length >= 3)
    )
  ).join(',');
  return {
    slug: roleLibrarySlug(howto.department, howto.role),
    name,
    description: extractDescription(howto.markdown) || `Role library SOP for ${howto.role} (${howto.department}).`,
    department: howto.department,
    role: howto.role,
    task_keywords: keywords,
    steps,
  };
}

// ---------- upsert ----------

interface ExistingSopRow {
  id: string;
  source: string | null;
  version: number;
}

function upsertRoleSOP(parsed: ParsedRoleSOP): ImportedSOPSummary {
  const now = new Date().toISOString();
  const existing = queryOne<ExistingSopRow>(
    'SELECT id, source, version FROM sops WHERE slug = ?',
    [parsed.slug]
  );

  if (existing) {
    // Refuse to clobber a user-authored row that happens to share the slug.
    if (existing.source !== ROLE_LIBRARY_SOURCE) {
      return {
        slug: parsed.slug,
        department: parsed.department,
        role: parsed.role,
        name: parsed.name,
        action: 'skipped',
        reason: `slug owned by a non-role-library SOP (source=${existing.source ?? 'null'}); not overwriting`,
      };
    }
    run(
      `UPDATE sops
         SET name = ?, description = ?, department = ?, role = ?, source = ?,
             task_keywords = ?, steps = ?, version = version + 1, updated_at = ?,
             deleted_at = NULL
       WHERE id = ?`,
      [
        parsed.name,
        parsed.description,
        parsed.department,
        parsed.role,
        ROLE_LIBRARY_SOURCE,
        parsed.task_keywords,
        JSON.stringify(parsed.steps),
        now,
        existing.id,
      ]
    );
    return {
      slug: parsed.slug,
      department: parsed.department,
      role: parsed.role,
      name: parsed.name,
      action: 'updated',
    };
  }

  run(
    `INSERT INTO sops
       (id, name, slug, description, version, department, role, source, task_keywords, steps, created_at, updated_at)
     VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)`,
    [
      uuidv4(),
      parsed.name,
      parsed.slug,
      parsed.description,
      parsed.department,
      parsed.role,
      ROLE_LIBRARY_SOURCE,
      parsed.task_keywords,
      JSON.stringify(parsed.steps),
      now,
      now,
    ]
  );
  return {
    slug: parsed.slug,
    department: parsed.department,
    role: parsed.role,
    name: parsed.name,
    action: 'inserted',
  };
}

export interface ImportOptions {
  /** Path to the departments/ tree. Defaults via resolveDepartmentsPath(). */
  departmentsPath?: string | null;
  /**
   * Soft-delete role-library SOPs that are no longer present on disk. ONLY ever
   * touches rows with source='role-library'. Default false (additive-only).
   */
  pruneMissing?: boolean;
}

/**
 * Import (upsert) every role how-to.md under the departments tree into `sops`.
 * Returns a per-row summary. Wrapped in a single transaction so a partial
 * failure rolls back cleanly.
 *
 * After the transaction, asynchronously queues embedding computation for all
 * inserted/updated rows (fire-and-forget; errors are swallowed per the
 * storeEmbeddingForSOP contract — a missing key never breaks imports).
 */
export function importRoleLibrary(opts: ImportOptions = {}): ImportResult {
  const departmentsPath = resolveDepartmentsPath(opts.departmentsPath);
  const howtos = discoverRoleHowTos(departmentsPath);

  const result = transaction((): ImportResult & { _insertedOrUpdatedSlugs: string[] } => {
    const items: ImportedSOPSummary[] = [];
    const seenSlugs = new Set<string>();
    const insertedOrUpdatedSlugs: string[] = [];

    for (const howto of howtos) {
      const parsed = parseRoleHowTo(howto);
      seenSlugs.add(parsed.slug);
      const summary = upsertRoleSOP(parsed);
      items.push(summary);
      if (summary.action === 'inserted' || summary.action === 'updated') {
        insertedOrUpdatedSlugs.push(parsed.slug);
      }
    }

    let pruned = 0;
    if (opts.pruneMissing) {
      const existingLib = queryAll<{ id: string; slug: string }>(
        `SELECT id, slug FROM sops WHERE source = ? AND deleted_at IS NULL`,
        [ROLE_LIBRARY_SOURCE]
      );
      const now = new Date().toISOString();
      for (const row of existingLib) {
        if (!seenSlugs.has(row.slug)) {
          run('UPDATE sops SET deleted_at = ? WHERE id = ?', [now, row.id]);
          pruned++;
        }
      }
    }

    return {
      departments_path: departmentsPath,
      scanned_roles: howtos.length,
      inserted: items.filter((i) => i.action === 'inserted').length,
      updated: items.filter((i) => i.action === 'updated').length,
      skipped: items.filter((i) => i.action === 'skipped').length,
      pruned,
      items,
      _insertedOrUpdatedSlugs: insertedOrUpdatedSlugs,
    };
  });

  // Fire-and-forget embedding for all rows that were written this run.
  // The transaction is done; reads here are safe. Errors are swallowed.
  if (result._insertedOrUpdatedSlugs.length > 0) {
    for (const slug of result._insertedOrUpdatedSlugs) {
      const sop = queryOne<SOP>(`SELECT * FROM sops WHERE slug = ? AND deleted_at IS NULL`, [slug]);
      if (sop) {
        storeEmbeddingForSOP(sop).catch(() => {/* logged inside */});
      }
    }
  }

  // Strip internal field before returning
  const { _insertedOrUpdatedSlugs: _dropped, ...publicResult } = result;
  return publicResult;
}
