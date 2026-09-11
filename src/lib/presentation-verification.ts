/**
 * presentation-verification.ts — PRES-038 (W3 WF12-B) shared verifier cache.
 *
 * The deliverables endpoint must stop labeling a row `verified` from key
 * membership + row existence alone. The verdict comes from ONE shared probe —
 * verifyPresentationBundleDeliverable() (completion-evidence.ts, the FIX 28
 * client-authority semantics: presence, symlink rejection, lstat size floor,
 * leading magic) — whose result is cached per (task, artifact) in
 * presentation_delivery_receipts (migration 141) as a hash-bound receipt.
 *
 * CACHE RULES (fail-closed, never stale-verified):
 *   - HIT: same path + same sha256 + same size + same mtime → return the
 *     stored verdict without touching bytes (100-worker UI fanout safe).
 *   - MISS/STALE: path, hash, size, or mtime differs → re-probe, REPLACE the
 *     receipt, return the fresh verdict. An updated file therefore
 *     invalidates its old receipt by construction.
 *   - PROBE FAIL: store status 'failed' with the probe's reason and return
 *     unavailable — a stale DB row degrades to registered/unavailable, never
 *     to verified.
 *   - NOT bundle-managed names (md size-only keys and non-artifact rows):
 *     no receipt, verdict 'size-only'/'absent' decided by the caller.
 *   - Rollback: PRESENTATION_BUNDLE_REVERIFY=0 (the FIX 28 flag, read live)
 *     disables probing AND receipt writes; the caller falls back to its
 *     pre-PRES-038 semantics verbatim.
 *
 * Pure-ish: only this module touches presentation_delivery_receipts and
 * presentation_ghl_link_checks. Routes pass the db handle + rows through.
 */

import type Database from 'better-sqlite3';
import { createHash } from 'crypto';
import { lstatSync, openSync, readSync, closeSync } from 'fs';
import {
  bundleReverifyEnabled,
  isBundleDeliverablePath,
  verifyPresentationBundleDeliverable,
} from '@/lib/completion-evidence';

export type ReceiptStatus = 'verified' | 'failed';

export interface DeliveryReceipt {
  status: ReceiptStatus;
  /** sha256 the verdict is bound to — the caller matches it to current bytes. */
  sha256: string;
  size_bytes: number;
  detail: string | null;
  checked_at: string;
  /** True when this verdict came from the stored receipt (no byte probe). */
  cached: boolean;
}

export interface CurrentFileIdentity {
  sha256: string;
  size_bytes: number;
  mtime_ms: number;
}

/** Hash + size + mtime of the file at `rawPath`, or null when unreadable. */
export function identifyFile(rawPath: string): CurrentFileIdentity | null {
  try {
    const resolved = rawPath.replace(/^~/, process.env.HOME || '');
    const st = lstatSync(resolved);
    if (!st.isFile() || st.isSymbolicLink()) return null;
    const fd = openSync(resolved, 'r');
    try {
      const hash = createHash('sha256');
      const buf = Buffer.alloc(64 * 1024);
      let n: number;
      do {
        n = readSync(fd, buf, 0, buf.length, null);
        if (n > 0) hash.update(buf.subarray(0, n));
      } while (n > 0);
      return { sha256: hash.digest('hex'), size_bytes: st.size, mtime_ms: Math.floor(st.mtimeMs) };
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
}

function tableExists(db: Database.Database, name: string): boolean {
  try {
    return (
      db.prepare(`SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name=?`).get(name) as { n: number }
    ).n > 0;
  } catch {
    return false;
  }
}

/**
 * Shared cached verdict for ONE (task, artifactKey, path) triple.
 * Returns null when the caller must fall back (rollback flag off, non-bundle
 * name, unreadable file with no usable prior receipt context).
 */
export function verifyWithReceipt(
  db: Database.Database,
  taskId: string,
  artifactKey: string,
  rawPath: string,
  slideCount?: number | null,
): DeliveryReceipt | null {
  if (!bundleReverifyEnabled()) return null;
  if (!isBundleDeliverablePath(rawPath)) return null;
  if (!tableExists(db, 'presentation_delivery_receipts')) {
    const verdict = verifyPresentationBundleDeliverable(rawPath, slideCount);
    if (verdict.ok) {
      const id = identifyFile(rawPath);
      if (!id) return null;
      return { status: 'verified', sha256: id.sha256, size_bytes: id.size_bytes, detail: verdict.reason ?? 'verified', checked_at: new Date().toISOString(), cached: false };
    }
    return { status: 'failed', sha256: '', size_bytes: verdict.sizeBytes ?? 0, detail: verdict.reason ?? 'probe failed', checked_at: new Date().toISOString(), cached: false };
  }

  const prior = db
    .prepare(
      `SELECT path, sha256, size_bytes, mtime_ms, status, detail, checked_at
         FROM presentation_delivery_receipts WHERE task_id = ? AND artifact_key = ?`,
    )
    .get(taskId, artifactKey) as
    | { path: string; sha256: string; size_bytes: number; mtime_ms: number; status: string; detail: string | null; checked_at: string }
    | undefined;

  const current = identifyFile(rawPath);
  if (!current) {
    // File gone/unreadable: keep the stored receipt as the failure record
    // (refresh its detail only if the path itself moved), never verified.
    if (prior && prior.path === rawPath) {
      return { status: 'failed', sha256: prior.sha256, size_bytes: prior.size_bytes, detail: `unreachable: registered path no longer readable (${rawPath})`, checked_at: prior.checked_at, cached: true };
    }
    if (prior) {
      db.prepare(
        `UPDATE presentation_delivery_receipts SET path = ?, status = 'failed',
           detail = ?, checked_at = datetime('now') WHERE task_id = ? AND artifact_key = ?`,
      ).run(rawPath, `unreachable: registered path no longer readable (${rawPath})`, taskId, artifactKey);
    } else {
      try {
        db.prepare(
          `INSERT INTO presentation_delivery_receipts
             (task_id, artifact_key, path, sha256, size_bytes, mtime_ms, status, verifier, detail, checked_at)
           VALUES (?,?,?,?,?,?, 'failed', 'bundle-probe', ?, datetime('now'))`,
        ).run(taskId, artifactKey, rawPath, '', 0, 0, `unreachable: registered path no longer readable (${rawPath})`);
      } catch { /* receipt write is best-effort */ }
    }
    return { status: 'failed', sha256: prior?.sha256 ?? '', size_bytes: prior?.size_bytes ?? 0, detail: `unreachable: registered path no longer readable (${rawPath})`, checked_at: new Date().toISOString(), cached: false };
  }

  if (
    prior &&
    prior.path === rawPath &&
    prior.sha256 === current.sha256 &&
    prior.size_bytes === current.size_bytes &&
    prior.mtime_ms === current.mtime_ms
  ) {
    return {
      status: prior.status === 'verified' ? 'verified' : 'failed',
      sha256: prior.sha256,
      size_bytes: prior.size_bytes,
      detail: prior.detail,
      checked_at: prior.checked_at,
      cached: true,
    };
  }

  const verdict = verifyPresentationBundleDeliverable(rawPath, slideCount);
  const status: ReceiptStatus = verdict.ok ? 'verified' : 'failed';
  const detail = verdict.reason ?? (verdict.ok ? 'verified' : 'probe failed');
  try {
    db.prepare(
      `INSERT INTO presentation_delivery_receipts
         (task_id, artifact_key, path, sha256, size_bytes, mtime_ms, status, verifier, detail, checked_at)
       VALUES (?,?,?,?,?,?, ?, 'bundle-probe', ?, datetime('now'))
       ON CONFLICT (task_id, artifact_key)
       DO UPDATE SET path = excluded.path, sha256 = excluded.sha256, size_bytes = excluded.size_bytes,
         mtime_ms = excluded.mtime_ms, status = excluded.status, verifier = 'bundle-probe',
         detail = excluded.detail, checked_at = datetime('now')`,
    ).run(taskId, artifactKey, rawPath, current.sha256, current.size_bytes, current.mtime_ms, status, detail);
  } catch { /* receipt write is best-effort; the verdict itself still returns */ }
  return { status, sha256: current.sha256, size_bytes: current.size_bytes, detail, checked_at: new Date().toISOString(), cached: false };
}

export interface GhlLinkCheck {
  url: string;
  ok: boolean;
  /** True when the check ran against the artifact's CURRENT hash. */
  current: boolean;
  checked_at: string | null;
  detail: string | null;
}

/**
 * Last GHL link check for (task, artifact), bound to the artifact's current
 * hash. A check only counts when its artifact_sha256 equals the CURRENT file
 * hash — an upload verified against an older revision reports current:false
 * so the UI retries instead of showing a false delivered link.
 */
export function readGhlLinkCheck(
  db: Database.Database,
  taskId: string,
  artifactKey: string,
  currentSha256: string | null,
): GhlLinkCheck | null {
  if (!tableExists(db, 'presentation_ghl_link_checks')) return null;
  const row = db
    .prepare(
      `SELECT url, artifact_sha256, ok, checked_at, detail
         FROM presentation_ghl_link_checks WHERE task_id = ? AND artifact_key = ?`,
    )
    .get(taskId, artifactKey) as
    | { url: string; artifact_sha256: string; ok: number; checked_at: string; detail: string | null }
    | undefined;
  if (!row) return null;
  return {
    url: row.url,
    ok: row.ok === 1,
    current: !!currentSha256 && row.artifact_sha256 === currentSha256,
    checked_at: row.checked_at,
    detail: row.detail,
  };
}

/** Record a GHL readback result. Best-effort; never throws. */
export function writeGhlLinkCheck(
  db: Database.Database,
  taskId: string,
  artifactKey: string,
  url: string,
  artifactSha256: string,
  ok: boolean,
  detail?: string | null,
): void {
  try {
    if (!tableExists(db, 'presentation_ghl_link_checks')) return;
    db.prepare(
      `INSERT INTO presentation_ghl_link_checks (task_id, artifact_key, url, artifact_sha256, ok, detail, checked_at)
       VALUES (?,?,?,?,?,?, datetime('now'))
       ON CONFLICT (task_id, artifact_key)
       DO UPDATE SET url = excluded.url, artifact_sha256 = excluded.artifact_sha256,
         ok = excluded.ok, detail = excluded.detail, checked_at = datetime('now')`,
    ).run(taskId, artifactKey, url, artifactSha256, ok ? 1 : 0, detail ?? null);
  } catch { /* best-effort */ }
}

/**
 * Latest QC revision for a task from task_qc_results (score/pass/path/attempt
 * stamp). The deliverables endpoint surfaces it as provenance; a verdict only
 * renders QC-verified when a row exists AND its evidence still matches the
 * artifact's current hash (matched by the caller via qcEvidenceFor()).
 */
export interface QcRevision {
  score: number | null;
  passed: boolean;
  scoring_path: string;
  attempt: number | null;
  scored_at: string;
}

export function latestQcRevision(db: Database.Database, taskId: string): QcRevision | null {
  try {
    const row = db
      .prepare(
        `SELECT score, passed, scoring_path, attempt, scored_at FROM task_qc_results
          WHERE task_id = ? ORDER BY scored_at DESC LIMIT 1`,
      )
      .get(taskId) as
      | { score: number | null; passed: number | null; scoring_path: string; attempt: number | null; scored_at: string }
      | undefined;
    if (!row) return null;
    return {
      score: typeof row.score === 'number' ? row.score : null,
      passed: row.passed === 1,
      scoring_path: row.scoring_path,
      attempt: typeof row.attempt === 'number' ? row.attempt : null,
      scored_at: row.scored_at,
    };
  } catch {
    return null;
  }
}
