/**
 * GET /api/presentations/[taskId]/deliverables
 *
 * U063: Returns exactly nine rows in PRESENTATION_ARTIFACTS order, plus
 * `extra[]` for registered deliverables matching none of the nine, plus
 * a top-level `ghl_ledger_present: boolean`.
 *
 * Rules:
 * - Nine rows always.
 * - ghl_url is joined from uploaded[].local_path, never from normalized
 *   projections (pptx_ghl_media_id / slides[]).
 * - Returns no identifier: no ghl_media_id, file_id, ghl_folder_id, location id.
 * - Missing media_library.json → ghl_ledger_present: false, every ghl_url: null.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { existsSync, lstatSync, readdirSync, statSync } from 'fs';
import { readFileSync } from 'fs';
import path from 'path';
import {
  PRESENTATION_ARTIFACTS,
  MAGIC_VERIFIED_SET,
  SIZE_ONLY_SET,
  resolveFilename,
} from '@/lib/presentation-deliverables';
import { resolveActiveCompanyId } from '@/lib/company';
import { boardWhereClause } from '@/lib/workspaces/board-query';
import { resolvePresentationRunRoots } from '@/lib/presentation-run-roots';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

type Verification = 'verified' | 'size-only' | 'absent';
type SizeSource = 'db' | 'stat' | 'unknown';

interface DeliveryRow {
  key: string;
  filename: string;
  label: string;
  min_bytes: number;
  present: boolean;
  produced_at: string | null;
  size_bytes: number | null;
  size_source: SizeSource;
  below_floor: boolean | null;
  mime_type: string | null;
  sha256: string | null;
  verification: Verification;
  ghl_url: string | null;
}

interface GhlUploadRecord {
  local_path: string;
  ghl_url?: string;
  public_url?: string;
  kind?: string;
  [key: string]: unknown;
}

interface GhlLedger {
  uploaded?: GhlUploadRecord[];
  pptx_ghl_media_id?: string;
  pptx_ghl_url?: string;
  slides?: GhlUploadRecord[];
  [key: string]: unknown;
}

interface DbDeliverable {
  id: string;
  task_id: string;
  deliverable_type: string;
  title: string;
  path: string | null;
  mime_type: string | null;
  file_size_bytes: number | null;
  sha256: string | null;
  created_at: string;
}

function findRunDir(filePath: string): string | null {
  let dir = path.dirname(path.resolve(filePath));
  for (let hops = 0; hops < 6; hops++) {
    try {
      if (
        existsSync(path.join(dir, 'working')) ||
        existsSync(path.join(dir, 'media_library.json')) ||
        existsSync(path.join(dir, 'working', 'checkpoints', 'media_library.json'))
      ) return dir;
    } catch { /* ignore */ }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function readGhlLedger(runDir: string): GhlLedger | null {
  const candidates = [
    path.join(runDir, 'working', 'checkpoints', 'media_library.json'),
    path.join(runDir, 'media_library.json'),
  ];
  for (const c of candidates) {
    try {
      if (!existsSync(c)) continue;
      return JSON.parse(readFileSync(c, 'utf8')) as GhlLedger;
    } catch { /* try next */ }
  }
  return null;
}

function computeVerification(key: string, present: boolean): Verification {
  if (!present) return 'absent';
  if (SIZE_ONLY_SET.has(key)) return 'size-only';
  if (MAGIC_VERIFIED_SET.has(key)) return 'verified';
  return 'size-only';
}

function expandTilde(p: string): string {
  return p.replace(/^~/, process.env.HOME || '');
}

function getHonestSize(
  del: DbDeliverable | null,
  expandedPath: string | null,
): { size_bytes: number | null; size_source: SizeSource; mime_type: string | null; sha256: string | null } {
  if (del?.file_size_bytes != null) {
    return { size_bytes: del.file_size_bytes, size_source: 'db', mime_type: del.mime_type ?? null, sha256: del.sha256 ?? null };
  }
  if (expandedPath && existsSync(expandedPath)) {
    try {
      const stat = lstatSync(expandedPath);
      if (stat.isSymbolicLink()) {
        return { size_bytes: null, size_source: 'unknown', mime_type: del?.mime_type ?? null, sha256: del?.sha256 ?? null };
      }
      if (stat.isFile()) {
        return { size_bytes: stat.size, size_source: 'stat', mime_type: del?.mime_type ?? null, sha256: del?.sha256 ?? null };
      }
    } catch { /* stat failed */ }
  }
  return { size_bytes: null, size_source: 'unknown', mime_type: del?.mime_type ?? null, sha256: del?.sha256 ?? null };
}

export async function GET(_request: NextRequest, props: { params: Promise<{ taskId: string }> }): Promise<NextResponse> {
  const params = await props.params;
  try {
    const taskId = params.taskId;
    const db = getDb();

    // ── Company scope (closes cross-company read) ────────────────────────
    // Same convention as the sibling phases/children routes: tasks carry no
    // direct company_id — only workspaces.company_id does — so ownership is
    // checked by joining through workspaces and applying the SAME
    // boardWhereClause the Kanban board itself uses. This gate runs BEFORE any
    // deliverable row, filesystem path, or GHL ledger is touched, because the
    // response body exposes `extra[].path` and `ghl_url` — an out-of-scope
    // task id must leak neither. A NULL workspace_id is the box's own
    // unattributed data and stays visible (matches boardWhereClause's posture);
    // an out-of-scope workspace is treated as not found, never distinguishing
    // "exists but not yours" from "doesn't exist".
    const activeCompanyId = resolveActiveCompanyId(db);
    const scope = boardWhereClause(activeCompanyId);
    const scopedWorkspaceIds = (
      db.prepare(`SELECT w.id FROM workspaces w ${scope.sql}`).all(...scope.params) as { id: string }[]
    ).map((w) => w.id);
    const scopeIdList = scopedWorkspaceIds.length > 0 ? scopedWorkspaceIds : ['__no_workspace__'];
    const scopePlaceholders = scopeIdList.map(() => '?').join(',');

    const task = db
      .prepare(
        `SELECT id FROM tasks
          WHERE id = ? AND (workspace_id IS NULL OR workspace_id IN (${scopePlaceholders}))`,
      )
      .get(taskId, ...scopeIdList) as { id: string } | undefined;

    if (!task) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }

    const deliverables = db.prepare(
      `SELECT * FROM task_deliverables WHERE task_id = ? ORDER BY created_at ASC`
    ).all(taskId) as DbDeliverable[];

    // Find run directory for GHL ledger
    let runDir: string | null = null;
    for (const del of deliverables) {
      if (del.path) { runDir = findRunDir(expandTilde(del.path)); if (runDir) break; }
    }
    if (!runDir) {
      const projectsPath = (process.env.PROJECTS_PATH || '~/Documents/Shared/projects').replace(/^~/, process.env.HOME || '');
      runDir = findRunDir(path.join(projectsPath, 'artifacts', taskId));
    }
    // Run-root-agnostic fallback (2026-08-27): the run may live under any
    // configured run root (PRESENTATION_RUNS_DIRS, e.g. ~/webinar-decks),
    // not only beside the artifact/PROJECTS_PATH. Probe each configured root
    // for a working/ subtree keyed to this task; first hit wins.
    if (!runDir) {
      for (const root of resolvePresentationRunRoots()) {
        if (!existsSync(root)) continue; // unreadable/missing root: skip, never a verdict
        try {
          const entries = readdirSync(root);
          for (const entry of entries) {
            const candidate = path.join(root, entry);
            try {
              if (!statSync(candidate).isDirectory()) continue;
            } catch { continue; }
            if (
              existsSync(path.join(candidate, 'working')) ||
              existsSync(path.join(candidate, 'media_library.json')) ||
              existsSync(path.join(candidate, 'working', 'checkpoints', 'media_library.json'))
            ) {
              runDir = candidate;
              break;
            }
          }
        } catch { /* unreadable root -- skip */ }
        if (runDir) break;
      }
    }

    // Read GHL ledger
    let ledger: GhlLedger | null = null;
    let ghlLedgerPresent = false;
    if (runDir) { ledger = readGhlLedger(runDir); ghlLedgerPresent = ledger !== null; }

    // Extract deck slug from any deliverable matching the pattern
    let deckSlug: string | null = null;
    for (const del of deliverables) {
      if (del.path) {
        const m = path.basename(del.path).match(/^(.+)-FINAL\.(pptx|pdf)$/i);
        if (m) { deckSlug = m[1]; break; }
      }
    }

    // Build filename -> deliverable lookup
    const byKey = new Map<string, DbDeliverable>();
    for (const art of PRESENTATION_ARTIFACTS) {
      const concrete = resolveFilename(art, deckSlug);
      for (const del of deliverables) {
        if (del.path && path.basename(del.path) === concrete) {
          byKey.set(art.key, del); break;
        }
      }
    }

    // Build GHL URL lookup from uploaded[].local_path
    const ghlByLocalPath = new Map<string, string>();
    if (ledger?.uploaded) {
      for (const rec of ledger.uploaded) {
        if (rec.local_path && (rec.ghl_url || rec.public_url)) {
          ghlByLocalPath.set(rec.local_path, rec.ghl_url || rec.public_url || '');
        }
      }
    }

    // Build the nine rows
    const rows: DeliveryRow[] = [];
    const matchedPaths = new Set<string>();
    for (const art of PRESENTATION_ARTIFACTS) {
      const del = byKey.get(art.key) || null;
      const present = del !== null;
      const concrete = resolveFilename(art, deckSlug);
      const { size_bytes, size_source, mime_type, sha256 } = getHonestSize(del, del?.path ? expandTilde(del.path) : null);

      const below_floor: boolean | null = size_source !== 'unknown' && size_bytes !== null ? size_bytes < art.min_bytes : null;

      let ghlUrl: string | null = null;
      if (del?.path) {
        const ep = expandTilde(del.path);
        if (ghlByLocalPath.has(ep)) ghlUrl = ghlByLocalPath.get(ep) || null;
      }

      rows.push({
        key: art.key, filename: concrete, label: art.label, min_bytes: art.min_bytes,
        present, produced_at: del?.created_at ?? null, size_bytes, size_source,
        below_floor, mime_type, sha256,
        verification: computeVerification(art.key, present),
        ghl_url: ghlUrl,
      });
      if (del?.path) matchedPaths.add(del.path);
    }

    // Extra deliverables matching none of the nine
    const extras = deliverables
      .filter((d) => d.path && !matchedPaths.has(d.path))
      .map((d) => ({ id: d.id, deliverable_type: d.deliverable_type, title: d.title, path: d.path, created_at: d.created_at }));

    return NextResponse.json({ rows, extra: extras, ghl_ledger_present: ghlLedgerPresent });
  } catch (error) {
    console.error('Error fetching presentation deliverables:', error);
    return NextResponse.json({ error: 'Failed to fetch presentation deliverables' }, { status: 500 });
  }
}
