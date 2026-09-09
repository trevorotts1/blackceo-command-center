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
  guideFloorForTask,
  resolveFilename,
} from '@/lib/presentation-deliverables';
import {
  identifyFile,
  latestQcRevision,
  readGhlLinkCheck,
  verifyWithReceipt,
} from '@/lib/presentation-verification';
import { resolveActiveCompanyId } from '@/lib/company';
import { tenantTaskWhere } from '@/lib/presentation-tenant-scope';
import { resolvePresentationRunRoots } from '@/lib/presentation-run-roots';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

type Verification = 'verified' | 'size-only' | 'absent';
type SizeSource = 'db' | 'stat' | 'unknown';

// PRES-038 — per-status lifecycle. Each flag is an independent fact with
// its own evidence; the UI renders them separately instead of collapsing to
// one `verified` badge:
//   registered — a task_deliverables row names this artifact (claim exists).
//   produced   — bytes on disk pass the shared bundle probe NOW (or size
//                floor for size-only keys). A deleted/corrupt file flips this
//                to false while registered stays true: registered/unavailable.
//   qc_verified — a task_qc_results PASS exists AND the shared probe passes
//                on the CURRENT bytes (revision + hash-bound, not row-bound).
//   uploaded   — the GHL ledger names a URL for this artifact's path.
//   reachable  — the last GHL readback for the CURRENT hash succeeded.
//   delivered  — uploaded && reachable-current && produced. Only this state
//                renders the green delivered link; uploaded-but-unconfirmed
//                renders an actionable retry instead of a false delivered.
interface DeliveryStatus {
  registered: boolean;
  produced: boolean;
  qc_verified: boolean;
  uploaded: boolean;
  reachable: boolean;
  delivered: boolean;
  /** Machine-readable reason for the produced/qc/delivered negatives. */
  detail: string | null;
}

interface QcInfo {
  score: number | null;
  passed: boolean;
  scoring_path: string;
  attempt: number | null;
  scored_at: string;
}

interface GhlInfo {
  url: string | null;
  /** Last readback state for the CURRENT hash: true/false/null (never checked). */
  reachable: boolean | null;
  checked_at: string | null;
}

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
  ghl_delivered_url: string | null;
  status: DeliveryStatus;
  qc: QcInfo | null;
  ghl: GhlInfo;
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

// PRES-038 (W3 WF12-B) — legacy key-membership verdict. Kept ONLY for the
// PRESENTATION_BUNDLE_REVERIFY=0 rollback path and for non-bundle names.
// The live path derives verification from the shared hash-bound receipt
// (verifyWithReceipt) so a stale/missing/corrupt file can never read
// `verified`. Same truth table as before, called only where no probe runs.
function computeVerificationLegacy(key: string, present: boolean): Verification {
  if (!present) return 'absent';
  if (SIZE_ONLY_SET.has(key)) return 'size-only';
  if (MAGIC_VERIFIED_SET.has(key)) return 'verified';
  return 'size-only';
}

function expandTilde(p: string): string {
  return p.replace(/^~/, process.env.HOME || '');
}

// PRES-038 — live disk identity wins over the stored row: the row's
// file_size_bytes/sha256 describe the bytes AT REGISTRATION, while the
// receipt must bind to the bytes ON DISK NOW. Trusting the stale row here
// is exactly how a deleted-then-replaced file kept a verified badge.
function getHonestSize(
  del: DbDeliverable | null,
  expandedPath: string | null,
): { size_bytes: number | null; size_source: SizeSource; mime_type: string | null; sha256: string | null } {
  // PRES-038 keeps the legacy precedence byte-identical (db row first, stat
  // fallback): freshness is enforced by the hash-bound RECEIPT (which always
  // probes live bytes), never by changing what size_source reports. A caller
  // that needs live identity uses identifyFile() directly.
  if (del?.file_size_bytes != null) {
    return { size_bytes: del.file_size_bytes, size_source: 'db', mime_type: del?.mime_type ?? null, sha256: del?.sha256 ?? null };
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

    // ── Company scope (PRES-009: ingest-grade ownership predicate) ────────
    // Ownership is proven by the SAME predicate the ingest front door uses
    // (src/lib/presentation-tenant-scope.ts): a durably attributed workspace
    // resolving to the active company, OR a durable task_request_keys creation
    // identity. A NULL workspace alone is NOT proof — the old
    // `workspace_id IS NULL` arm showed an unattributed task (and its extra[]
    // paths + GHL ledger) to EVERY active company. This gate runs BEFORE any
    // deliverable row, filesystem path, or ledger is touched. An out-of-scope
    // or ambiguous task is 404, never distinguishing "exists but not yours"
    // from "doesn't exist".
    const activeCompanyId = resolveActiveCompanyId(db);
    const own = tenantTaskWhere(activeCompanyId);

    const task = db
      .prepare(
        `SELECT id FROM tasks t
          WHERE t.id = ? AND ${own.sql}`,
      )
      .get(taskId, ...own.params) as { id: string } | undefined;

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

    // Deck slide count for the scaled guide floor (migration 130).
    let slideCount: number | null = null;
    try {
      const t = db.prepare('SELECT slide_count FROM tasks WHERE id = ?').get(taskId) as { slide_count: number | null } | undefined;
      if (typeof t?.slide_count === 'number') slideCount = t.slide_count;
    } catch { /* pre-migration box: scaled floor degrades to the legacy flat floor */ }
    const guideFloor = guideFloorForTask(slideCount ?? undefined);

    const qcRevision = latestQcRevision(db, taskId);

    // Build the nine rows
    const rows: DeliveryRow[] = [];
    const matchedPaths = new Set<string>();
    for (const art of PRESENTATION_ARTIFACTS) {
      const del = byKey.get(art.key) || null;
      const present = del !== null;
      const concrete = resolveFilename(art, deckSlug);
      const expanded = del?.path ? expandTilde(del.path) : null;
      const { size_bytes, size_source, mime_type, sha256 } = getHonestSize(del, expanded);

      const floor = art.key === 'guide_pdf' ? guideFloor : art.min_bytes;
      const below_floor: boolean | null = size_source !== 'unknown' && size_bytes !== null ? size_bytes < floor : null;

      let ghlUrl: string | null = null;
      if (del?.path) {
        const ep = expandTilde(del.path);
        if (ghlByLocalPath.has(ep)) ghlUrl = ghlByLocalPath.get(ep) || null;
      }

      // PRES-038 — receipt-backed verdict. verifyWithReceipt returns null on
      // the rollback path or for non-bundle names; there the legacy
      // key-membership verdict applies unchanged (byte-identical response).
      const receipt = del?.path ? verifyWithReceipt(db, taskId, art.key, del.path, slideCount) : null;
      let verification: Verification;
      let produced: boolean;
      let producedDetail: string | null = null;
      if (receipt) {
        produced = receipt.status === 'verified';
        producedDetail = receipt.detail;
        // Size-only keys never reach the receipt (no probe runs for them):
        // `produced` for them is floor-only, decided below. Magic keys bind
        // `verified` to the receipt's CURRENT-bytes pass.
        verification = art.key && SIZE_ONLY_SET.has(art.key) && !present
          ? 'absent'
          : receipt.status === 'verified'
            ? (MAGIC_VERIFIED_SET.has(art.key) ? 'verified' : 'size-only')
            : (present ? 'size-only' : 'absent');
        if (receipt.status !== 'verified') verification = present ? 'size-only' : 'absent';
      } else {
        verification = computeVerificationLegacy(art.key, present);
        produced = present && below_floor === false;
        if (present && below_floor !== false) producedDetail = below_floor === true ? `below floor (${size_bytes} < ${floor})` : 'unmeasurable: no bytes available';
      }
      if (SIZE_ONLY_SET.has(art.key)) {
        produced = present && below_floor === false;
        if (present && below_floor !== false) producedDetail = below_floor === true ? `below floor (${size_bytes} < ${floor})` : 'unmeasurable: no bytes available';
        verification = present ? 'size-only' : 'absent';
      }
      if (!present) {
        produced = false;
        producedDetail = producedDetail ?? 'not registered';
      }

      // QC-verified binds the PASS to the CURRENT bytes: the revision must
      // exist, must have passed, and the shared probe must pass on what is
      // on disk now (receipt.status). A good receipt from an older revision
      // that the file has since outgrown re-probes above, so this cannot go
      // stale.
      const qcVerified = !!qcRevision && qcRevision.passed && produced && receipt?.status === 'verified';
      // PRES-038 — bind the link check to the CURRENT bytes (receipt hash),
      // never the row's registration-time sha256: seeded/legacy rows carry a
      // stale sha while the receipt always reflects live disk identity. When
      // no receipt ran (rollback path), fall back to the row sha.
      const liveSha = receipt?.sha256 ?? sha256;
      const ghlCheck = readGhlLinkCheck(db, taskId, art.key, liveSha);
      const uploaded = ghlUrl !== null;
      const reachableCurrent = ghlCheck && ghlCheck.current ? ghlCheck.ok : null;
      const reachable = reachableCurrent === true;
      const delivered = uploaded && reachable && produced;
      // The green link renders ONLY on delivered (uploaded + readback-ok on
      // the current hash + produced) via the NEW ghl_delivered_url field. An
      // upload whose readback failed (or was never checked) keeps its URL in
      // ghl.url for the retry affordance but ghl_delivered_url stays null so
      // the UI cannot render a false delivered. ghl_url keeps its legacy
      // ledger-join meaning byte-identical for existing consumers.
      const deliveredUrl = delivered ? ghlUrl : null;

      rows.push({
        key: art.key, filename: concrete, label: art.label, min_bytes: art.min_bytes,
        present, produced_at: del?.created_at ?? null, size_bytes, size_source,
        below_floor, mime_type, sha256,
        verification,
        ghl_delivered_url: deliveredUrl,
        status: {
          registered: present,
          produced,
          qc_verified: qcVerified,
          uploaded,
          reachable,
          delivered,
          detail: produced ? (qcRevision && !qcRevision.passed ? `QC ${qcRevision.scoring_path} did not pass (attempt ${qcRevision.attempt ?? '?'})` : null) : producedDetail,
        },
        qc: qcRevision
          ? { score: qcRevision.score, passed: qcRevision.passed, scoring_path: qcRevision.scoring_path, attempt: qcRevision.attempt, scored_at: qcRevision.scored_at }
          : null,
        ghl: { url: ghlUrl, reachable: reachableCurrent, checked_at: ghlCheck?.checked_at ?? null },
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
