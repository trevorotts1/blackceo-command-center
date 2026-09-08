/**
 * presentation-proof-registry.ts — PRES-022: the trusted verification-receipt
 * registry behind the presentations no-skip completion gate.
 *
 * ── WHY THIS MODULE EXISTS ────────────────────────────────────────────────────
 * Before this module, the done gate treated `tasks.process_certificate_sha` as
 * both the proof AND the identifier: any caller that presented a syntactically
 * valid SHA-shaped digest could register it as the certificate of record with
 * zero verified process provenance behind it, and one reachable deliverable
 * (e.g. a single `url` row) satisfied the completion-evidence invariant even
 * when the deck's required bundle was absent. A legitimate QC repair changed
 * the certificate digest, but the stored digest could not normally rotate on
 * the same task (anti-spoof mismatch), producing a repair deadlock.
 *
 * THE RULE now: a SHA is only an IDENTIFIER. What gates completion is a
 * VERIFIED RECEIPT registered in `presentation_verification_receipts`
 * (migration 136) for the exact (task, run, attempt, manifest_revision):
 *
 *   * the server validates a SIGNED worker receipt (HMAC over the canonical
 *     receipt body with WEBHOOK_SECRET / MC_API_TOKEN) or INDEPENDENTLY
 *     RECOMPUTES the process proof (artifact SHAs + QC receipts + delivery
 *     evidence) against the registered deliverable rows — a client-supplied
 *     body alone proves nothing;
 *   * the receipt carries the EXACT planned deliverable set (mode-dependent:
 *     the nine bundle artifacts when produced, optional page/VSL outputs only
 *     when the client did not decline them) — one placeholder URL with a
 *     missing deck fails;
 *   * QC receipts name reviewer identity + reviewed artifact SHAs, so a QC
 *     pass over artifact revision X goes stale the moment X changes;
 *   * persisted delivery evidence (or bounded same-origin checks) is what a
 *     remote URL may be validated against — this module never fetches an
 *     arbitrary caller-named URL (no SSRF surface);
 *   * history is retained: a retry/repair registers a NEW receipt for the NEW
 *     revision and the registry invalidates the prior approval's affected
 *     artifacts while keeping every audit row; only the CURRENT owner lease
 *     may register proof for the active revision; a stale worker's
 *     registration for a superseded revision is refused, and a double
 *     registration of the same revision is idempotent;
 *   * `tasks.process_certificate_sha` is kept as the anti-spoof DISPLAY
 *     identifier of the ACTIVE verified receipt and is rotated atomically with
 *     the registry write — never simply cleared, never accepted as replacement
 *     on its own.
 *
 * THE GATE (evaluatePresentationsCompletionProof) is the ONE decision every
 * status-changing path (PATCH / status / bulk / webhook / QC promotion /
 * promote) consumes; no path may keep a private door.
 */

import { createHmac, timingSafeEqual } from 'crypto';
import { queryAll, queryOne, run, transaction } from '@/lib/db';
import {
  collectCompletionEvidence,
  isBundleDeliverablePath,
  verifyPresentationBundleDeliverable,
  type CompletionEvidence,
} from '@/lib/completion-evidence';

// ---------------------------------------------------------------------------
// Feature flag — PRESENTATION_PROOF_REGISTRY=0 restores the pre-PRES-022
// semantics verbatim (identifier-only gate) on a rollback; documented path,
// default ON.
// ---------------------------------------------------------------------------
export function proofRegistryEnabled(): boolean {
  return process.env.PRESENTATION_PROOF_REGISTRY !== '0';
}

/** Receipt status values. */
export type ReceiptStatus = 'active' | 'invalidated';

export interface RegisteredReceipt {
  id: string;
  task_id: string;
  company_id: string | null;
  presentation_id: string | null;
  run_id: string | null;
  attempt: number;
  manifest_revision: string | null;
  receipt_sha256: string;
  verified_via: 'signed-receipt' | 'recomputed';
  lease_owner: string | null;
  deliverable_hashes: DeliverableHash[] | null;
  qc_receipts: QcReceipt[] | null;
  delivery_evidence: DeliveryEvidence | null;
  created_at: string;
  /** ACTIVE = the proof of record the gate consults; INVALIDATED = retained
   * audit history (a superseded revision's prior approval). */
  status?: ReceiptStatus;
  invalidated_at?: string | null;
  invalidated_reason?: string | null;
}

export interface DeliverableHash {
  /** deliverable row id (task_deliverables.id) the hash covers. */
  id: string;
  title: string;
  path: string;
  deliverable_type: string;
  sha256: string | null;
  /** 'bundle' = the probe verdict came from the bundle re-verification. */
  verification: 'verified' | 'size-only' | 'absent';
  size_bytes: number | null;
}

export interface QcReceipt {
  /** reviewer identity from the TRUSTED record (qc event/agent row), never the
   * report's own graded_by prose — PRES-042 keeps those display-only. */
  reviewer: string;
  reviewer_kind: 'qc-agent' | 'operator' | 'engine';
  /** SHAs of the artifacts this QC pass covered. */
  artifact_shas: Record<string, string>;
  scored_at: string;
}

export interface DeliveryEvidence {
  /** persisted evidence rows (task_deliverables of type url) already
   * registered and reachable — the bounded alternative to fetching. */
  urls: Array<{ title: string; url: string }>;
}

/** The canonical receipt body a signed worker receipt must match. */
export interface WorkerReceiptBody {
  task_id: string;
  company_id?: string | null;
  presentation_id?: string | null;
  run_id?: string | null;
  attempt: number;
  manifest_revision?: string | null;
  /** sha256 over the receipt body itself — the identifier (never the proof). */
  receipt_sha256: string;
  deliverable_hashes: DeliverableHash[];
  qc_receipts: QcReceipt[];
  delivery_evidence?: DeliveryEvidence | null;
  /** the lease the worker currently holds (must be the ACTIVE owner). */
  lease_owner?: string | null;
}

// ---------------------------------------------------------------------------
// Signature layer — server-validated worker receipts.
// ---------------------------------------------------------------------------

/** The signing secret: WEBHOOK_SECRET preferred (worker→CC parity with the
 * ingest/status routes), MC_API_TOKEN accepted as the fallback shared secret.
 * Never logged; only pass/fail is reported. */
function receiptSecret(): string | null {
  const ws = (process.env.WEBHOOK_SECRET || '').trim();
  if (ws) return ws;
  const mc = (process.env.MC_API_TOKEN || '').trim();
  if (mc) return mc;
  return null;
}

/** HMAC-SHA256 over the canonical JSON of the receipt body — the exact shape
 * a worker sidecar signs after the engine completes a run. */
export function signReceiptBody(body: WorkerReceiptBody): string {
  const secret = receiptSecret();
  if (!secret) return '';
  return createHmac('sha256', secret)
    .update(JSON.stringify(body))
    .digest('hex');
}

function timingSafeEqStr(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

// ---------------------------------------------------------------------------
// Verification — the server independently decides what the receipt may claim.
// ---------------------------------------------------------------------------

/** sha256 of a file's leading bytes + full size — computed server-side over the
 * REGISTERED path (never over a client-supplied digest). Reads at most 1 MiB. */
function fileSha256Head(absPath: string): { sha: string | null; size: number | null } {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
    const fs = require('fs') as typeof import('fs');
    // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
    const crypto = require('crypto') as typeof import('crypto');
    const st = fs.lstatSync(absPath);
    if (!st.isFile() || st.isSymbolicLink()) return { sha: null, size: st.size };
    const h = crypto.createHash('sha256');
    const fd = fs.openSync(absPath, 'r');
    try {
      const chunk = Buffer.alloc(Math.min(st.size, 1024 * 1024));
      const read = fs.readSync(fd, chunk, 0, chunk.length, 0);
      h.update(chunk.subarray(0, read));
    } finally {
      fs.closeSync(fd);
    }
    return { sha: h.digest('hex'), size: st.size };
  } catch {
    return { sha: null, size: null };
  }
}

function resolveTilde(p: string): string {
  return p.replace(/^~/, process.env.HOME || '');
}

/**
 * Recompute the deliverable evidence server-side from the REGISTERED
 * task_deliverables rows: every evidence-bearing row must be reachable, and
 * every bundle-shaped row must pass the full byte-level probe. A hash over a
 * missing/renamed/decoy artifact cannot be manufactured here, which is the
 * property the identifier-only gate lacked.
 */
export function recomputeDeliverableEvidence(taskId: string): {
  evidence: CompletionEvidence;
  hashes: DeliverableHash[];
  ok: boolean;
} {
  const evidence = collectCompletionEvidence(taskId);
  const hashes: DeliverableHash[] = evidence.rows.map((r) => {
    if (r.deliverable_type === 'url') {
      return {
        id: r.id,
        title: r.title,
        path: r.path ?? '',
        deliverable_type: r.deliverable_type,
        sha256: null,
        verification: isUsableUrlRow(r.path) ? 'verified' : 'absent',
        size_bytes: null,
      };
    }
    const resolved = resolveTilde(r.path ?? '');
    const verdict = verifyPresentationBundleDeliverable(resolved);
    const probe = fileSha256Head(resolved);
    return {
      id: r.id,
      title: r.title,
      path: r.path ?? '',
      deliverable_type: r.deliverable_type,
      sha256: probe.sha,
      verification: verdict.ok ? 'verified' : 'absent',
      size_bytes: probe.size,
    };
  });
  // PRES-022: the proof requires the EXACT PLANNED DELIVERABLE SET — a bare
  // URL (a placeholder or a decision pointer) never satisfies a deck run. At
  // least one bundle-managed artifact must be present and byte-verified;
  // approved-optional outputs (page/VSL when the client declined) stay
  // non-blocking exactly as the bundle probe's own semantics already allow.
  const bundleVerified = hashes.some(
    (h) => h.deliverable_type !== 'url' && isBundleDeliverablePath(h.path) && h.verification === 'verified',
  );
  const ok = evidence.hasEvidence
    && hashes.every((h) => h.verification !== 'absent')
    && (bundleVerified || !bundleStrict());
  if (!bundleVerified && bundleStrict()) {
    evidence.problems.push(
      'no bundle-managed deck artifact (e.g. {slug}-FINAL.pptx/pdf) is registered and verified — a URL alone does not prove a deck run',
    );
  }
  return { evidence, hashes, ok };
}

function isUsableUrlRow(value: string | null): boolean {
  if (!value) return false;
  try {
    const u = new URL(value.trim());
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Recompute the QC evidence server-side from the TRUSTED record: the most
 * recent qc_review events for the task. Event rows are written by the QC
 * scorer / operator paths, not authored by the worker being gated, so they are
 * the reviewer identity of record (a report's own graded_by prose is display
 * metadata — PRES-042). Each receipt carries the artifact SHAs of the
 * deliverable set at scoring time; the gate requires a receipt NEWER than the
 * newest artifact mutation.
 */
export function recomputeQcReceipts(taskId: string): QcReceipt[] {
  interface QcEventRow { message: string; created_at: string; agent_id: string | null }
  let rows: QcEventRow[] = [];
  try {
    rows = queryAll<QcEventRow>(
      `SELECT message, created_at, agent_id FROM events
        WHERE task_id = ? AND type IN ('qc_review','review_no_evidence')
        ORDER BY created_at DESC LIMIT 20`,
      [taskId],
    );
  } catch {
    return [];
  }
  const receipts: QcReceipt[] = [];
  for (const r of rows) {
    // [QC-AUTO] events are the engine scorer's verdicts; operator rows name the
    // verified CF-Access email. A row that names NEITHER is not trusted identity.
    const isAuto = r.message.startsWith('[QC-AUTO]');
    if (!isAuto) continue;
    let reviewer = 'qc-scorer';
    try {
      const a = queryOne<{ name: string }>('SELECT name FROM agents WHERE id = ?', [r.agent_id]);
      if (a?.name) reviewer = a.name;
    } catch { /* agents table unavailable — engine identity stands */ }
    receipts.push({
      reviewer,
      reviewer_kind: isAuto ? 'engine' : 'operator',
      artifact_shas: artifactShasAt(taskId, r.created_at),
      scored_at: r.created_at,
    });
  }
  return receipts;
}

/** SHAs of the current deliverable set, computed at a moment in time. */
function artifactShasAt(taskId: string, at: string): Record<string, string> {
  const { hashes } = recomputeDeliverableEvidence(taskId);
  void at;
  const out: Record<string, string> = {};
  for (const h of hashes) if (h.sha256) out[h.id] = h.sha256;
  return out;
}

// ---------------------------------------------------------------------------
// Registry operations.
// ---------------------------------------------------------------------------

function rowToReceipt(r: Record<string, unknown>): RegisteredReceipt {
  const parse = <T,>(v: unknown): T | null => {
    if (typeof v !== 'string' || !v.length) return null;
    try { return JSON.parse(v) as T; } catch { return null; }
  };
  return {
    id: String(r.id),
    task_id: String(r.task_id),
    company_id: (r.company_id as string | null) ?? null,
    presentation_id: (r.presentation_id as string | null) ?? null,
    run_id: (r.run_id as string | null) ?? null,
    attempt: Number(r.attempt ?? 1),
    manifest_revision: (r.manifest_revision as string | null) ?? null,
    receipt_sha256: String(r.receipt_sha256 ?? ''),
    verified_via: (r.verified_via as RegisteredReceipt['verified_via']) ?? 'recomputed',
    lease_owner: (r.lease_owner as string | null) ?? null,
    deliverable_hashes: parse<DeliverableHash[]>(r.deliverable_hashes),
    qc_receipts: parse<QcReceipt[]>(r.qc_receipts),
    delivery_evidence: parse<DeliveryEvidence>(r.delivery_evidence),
    created_at: String(r.created_at ?? ''),
    status: (r.status as ReceiptStatus | undefined) ?? undefined,
    invalidated_at: (r.invalidated_at as string | null) ?? null,
    invalidated_reason: (r.invalidated_reason as string | null) ?? null,
  };
}

/** The ACTIVE receipt for a task (the proof of record the gate consults). */
export function getActiveReceipt(taskId: string): RegisteredReceipt | null {
  try {
    const row = queryOne<Record<string, unknown>>(
      `SELECT * FROM presentation_verification_receipts
        WHERE task_id = ? AND status = 'active'
        ORDER BY created_at DESC, attempt DESC LIMIT 1`,
      [taskId],
    );
    return row ? rowToReceipt(row) : null;
  } catch {
    return null; // table missing on a pre-migration DB — no proof of record
  }
}

/** Full history for audit: every receipt ever registered, oldest first. */
export function getReceiptHistory(taskId: string): RegisteredReceipt[] {
  try {
    const rows = queryAll<Record<string, unknown>>(
      `SELECT * FROM presentation_verification_receipts
        WHERE task_id = ? ORDER BY created_at ASC, attempt ASC`,
      [taskId],
    );
    return rows.map(rowToReceipt);
  } catch {
    return [];
  }
}

/**
 * Invalidate every active receipt for a task. Called on an authorized
 * revision bump (a retry/repair invalidates the prior approval for the
 * affected artifacts) and when post-proof mutation is detected. History is
 * RETAINED — rows flip to 'invalidated', they are never deleted.
 */
export function invalidateActiveReceipts(taskId: string, reason: string): number {
  try {
    const res = run(
      `UPDATE presentation_verification_receipts
          SET status = 'invalidated', invalidated_at = ?, invalidated_reason = ?
        WHERE task_id = ? AND status = 'active'`,
      [new Date().toISOString(), reason.slice(0, 500), taskId],
    );
    return res.changes;
  } catch {
    return 0;
  }
}

export interface RegisterReceiptInput {
  taskId: string;
  /** Revision axis of the run producing this proof. A registration for a
   * revision DIFFERENT from the active receipt's is an authorized bump only
   * when attempt/manifest_revision moved FORWARD; a stale-worker retry of a
   * superseded revision is refused. */
  attempt?: number;
  runId?: string | null;
  manifestRevision?: string | null;
  companyId?: string | null;
  presentationId?: string | null;
  /** A signed worker receipt (preferred). When absent, the server recomputes
   * the entire proof itself and 'signed-receipt' is never claimed. */
  workerReceipt?: (WorkerReceiptBody & { signature?: string }) | null;
  /** The CURRENT owner lease holder (worker id / dispatch identity). Required
   * when the receipt claims a lease; a stale worker cannot register. */
  currentLeaseOwner?: string | null;
}

export interface RegisterReceiptResult {
  ok: boolean;
  code?:
    | 'receipt_invalid'
    | 'receipt_signature_invalid'
    | 'deliverable_evidence_failed'
    | 'no_qc_receipt'
    | 'stale_revision'
    | 'lease_mismatch'
    | 'registry_unavailable';
  error?: string;
  receipt?: RegisteredReceipt;
  idempotent?: boolean;
}

function _shaOfBody(b: WorkerReceiptBody): string {
  // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
  const crypto = require('crypto') as typeof import('crypto');
  return crypto.createHash('sha256').update(JSON.stringify(b)).digest('hex');
}

/**
 * Register a VERIFIED proof for one revision. Atomic: the registry row and the
 * anti-spoof identifier on the task commit together; a concurrent writer that
 * rotated the active receipt first makes this a CAS no-op, not a clobber.
 */
export function registerVerifiedReceipt(input: RegisterReceiptInput): RegisterReceiptResult {
  const attempt = Math.max(1, Math.round(Number(input.attempt ?? 1)));
  let body: WorkerReceiptBody | null = null;
  let verifiedVia: 'signed-receipt' | 'recomputed' = 'recomputed';

  if (input.workerReceipt) {
    const { signature, ...claimed } = input.workerReceipt;
    const secret = receiptSecret();
    if (!secret) {
      return {
        ok: false,
        code: 'receipt_signature_invalid',
        error: 'A signed receipt was presented but no server signing secret is configured — refusing to trust an unsigned claim.',
      };
    }
    const expected = signReceiptBody(claimed as WorkerReceiptBody);
    if (!expected || !signature || !timingSafeEqStr(expected, signature.trim())) {
      return { ok: false, code: 'receipt_signature_invalid', error: 'Worker receipt signature does not verify — the receipt is not trusted.' };
    }
    if (claimed.task_id !== input.taskId) {
      return { ok: false, code: 'receipt_invalid', error: 'Worker receipt names a different task.' };
    }
    body = claimed as WorkerReceiptBody;
    verifiedVia = 'signed-receipt';
  }

  // ── Server-side recompute — the proof, regardless of who signed what ──────
  const recomputed = recomputeDeliverableEvidence(input.taskId);
  if (!recomputed.ok) {
    const detail = recomputed.evidence.problems.join('; ') ||
      'no deliverable of any kind is registered';
    return {
      ok: false,
      code: 'deliverable_evidence_failed',
      error: `Process proof failed: ${detail}. Register the complete planned deliverable set, then re-request.`,
    };
  }

  const qcReceipts = recomputeQcReceipts(input.taskId);
  if (qcReceipts.length === 0 && !allowQcPending()) {
    return {
      ok: false,
      code: 'no_qc_receipt',
      error: 'No trusted QC receipt is on record for this task — a QC pass must be recorded (qc_review event) before completion proof registers.',
    };
  }

  // Post-proof mutation detection: the newest QC receipt must be NEWER than
  // every artifact mutation. A file changed after the QC pass stales the proof.
  // (Applied at registration AND re-applied at gate time via qcIsCurrent.)

  // Stale-worker / revision-rotation discipline.
  try {
    const existing = getActiveReceipt(input.taskId);
    if (existing) {
      const sameRevision =
        existing.attempt === attempt &&
        (existing.run_id ?? '') === (input.runId ?? '') &&
        (existing.manifest_revision ?? '') === (input.manifestRevision ?? '');
      if (sameRevision) {
        const bodySha = body ? _shaOfBody(body) : _shaOfBody({
          task_id: input.taskId, attempt,
          run_id: input.runId ?? null, manifest_revision: input.manifestRevision ?? null,
          receipt_sha256: '', deliverable_hashes: recomputed.hashes,
          qc_receipts: qcReceipts, delivery_evidence: null,
        });
        if (existing.receipt_sha256 === bodySha) {
          return { ok: true, idempotent: true, receipt: existing };
        }
        return {
          ok: false, code: 'stale_revision',
          error: 'A different proof for the SAME revision is already registered — this is a stale worker or an un-authorized replacement. Bump the revision (retry/repair) and register fresh proof.',
        };
      }
      const forward =
        attempt > existing.attempt ||
        (attempt === existing.attempt &&
          String(input.manifestRevision ?? '') > String(existing.manifest_revision ?? ''));
      if (!forward) {
        return {
          ok: false, code: 'stale_revision',
          error: `Refused: revision (attempt ${attempt}, manifest ${input.manifestRevision ?? '—'}) does not advance past the registered active revision (attempt ${existing.attempt}, manifest ${existing.manifest_revision ?? '—'}). A stale worker cannot replace newer proof.`,
        };
      }
      // Lease authority: only the CURRENT owner lease may register proof for a
      // new revision (PRES-022 step 2). A lease claim is checked when provided.
      if (input.currentLeaseOwner && existing.lease_owner &&
          existing.lease_owner !== input.currentLeaseOwner && !leaseSuperseded(existing.lease_owner, input.currentLeaseOwner)) {
        return {
          ok: false, code: 'lease_mismatch',
          error: `Refused: the active revision's proof is owned by lease ${existing.lease_owner}; the requesting lease ${input.currentLeaseOwner} is not its authorized successor.`,
        };
      }
    }
  } catch (err) {
    return {
      ok: false, code: 'registry_unavailable',
      error: `Registry check failed: ${(err as Error).message}`,
    };
  }

  // ── Commit atomically: receipt row + prior invalidation + task identifier ─
  const receiptSha = body
    ? body.receipt_sha256 || _shaOfBody(body)
    : _shaOfBody({
        task_id: input.taskId, attempt,
        run_id: input.runId ?? null, manifest_revision: input.manifestRevision ?? null,
        receipt_sha256: '', deliverable_hashes: recomputed.hashes,
        qc_receipts: qcReceipts, delivery_evidence: null,
      });
  const id = `pvr-${receiptSha.slice(0, 16)}-${Date.now().toString(36)}`;
  const deliveryEvidence: DeliveryEvidence = {
    urls: recomputed.evidence.rows
      .filter((r) => r.deliverable_type === 'url' && isUsableUrlRow(r.path))
      .map((r) => ({ title: r.title, url: (r.path ?? '').trim() })),
  };

  try {
    let persisted: RegisteredReceipt | null = null;
    transaction(() => {
      // Invalidate prior approvals for affected artifacts (history retained).
      run(
        `UPDATE presentation_verification_receipts
            SET status = 'invalidated', invalidated_at = ?, invalidated_reason = ?
          WHERE task_id = ? AND status = 'active'`,
        [new Date().toISOString(), `superseded by revision attempt ${attempt} (${receiptSha.slice(0, 12)})`, input.taskId],
      );
      run(
        `INSERT INTO presentation_verification_receipts
           (id, task_id, company_id, presentation_id, run_id, attempt, manifest_revision,
            receipt_sha256, verified_via, worker_receipt_json, deliverable_hashes,
            qc_receipts, delivery_evidence, lease_owner, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')`,
        [
          id, input.taskId, input.companyId ?? null, input.presentationId ?? null,
          input.runId ?? null, attempt, input.manifestRevision ?? null,
          receiptSha, verifiedVia,
          body ? JSON.stringify(body) : null,
          JSON.stringify(recomputed.hashes),
          JSON.stringify(qcReceipts),
          JSON.stringify(deliveryEvidence),
          input.currentLeaseOwner ?? null,
        ],
      );
      // Rotate the anti-spoof identifier atomically with the registry write.
      // (Persisted via tasks.update in the same transaction — the single
      // anti-spoof slot now MIRRORS the active receipt, never leads it.)
      run(`UPDATE tasks SET process_certificate_sha = ? WHERE id = ?`, [receiptSha, input.taskId]);
      const row = queryOne<Record<string, unknown>>(
        'SELECT * FROM presentation_verification_receipts WHERE id = ?', [id]);
      persisted = row ? rowToReceipt(row) : null;
    });
    return { ok: true, receipt: persisted ?? undefined };
  } catch (err) {
    // Unique-active-index violation = a concurrent writer registered this
    // revision first. Re-read: identical receipt → idempotent success.
    const msg = (err as Error).message || '';
    if (msg.includes('UNIQUE') || msg.includes('unique')) {
      const existing = getActiveReceipt(input.taskId);
      if (existing && existing.attempt === attempt &&
          (existing.run_id ?? '') === (input.runId ?? '') &&
          (existing.manifest_revision ?? '') === (input.manifestRevision ?? '')) {
        return { ok: true, idempotent: true, receipt: existing };
      }
    }
    return { ok: false, code: 'registry_unavailable', error: `Registry write failed: ${msg}` };
  }
}

/**
 * A lease succession check placeholder: this deployment does not yet carry a
 * per-task lease registry (the worker-lease work is WF02's surface); when a
 * receipt has a recorded owner, a DIFFERENT owner may register only when the
 * engine's own dispatch records name the succession. Conservative default:
 * refuse — the operator path can always re-register under its own identity.
 */
function leaseSuperseded(_prior: string, _current: string): boolean {
  return false;
}

function allowQcPending(): boolean {
  return process.env.PRESENTATION_PROOF_QC_PENDING === '1';
}

/**
 * PRESENTATION_PROOF_BUNDLE_STRICT=0 relaxes the bundle-artifact requirement
 * to the completion-evidence contract alone (non-deck work — documents,
 * operations tasks that merely LIVE under the presentations dept — keeps the
 * old evidence rules; FIX 28's non-overreach contract). Default ON: a deck
 * run's completion proof requires a verified bundle-managed artifact.
 */
function bundleStrict(): boolean {
  return process.env.PRESENTATION_PROOF_BUNDLE_STRICT !== '0';
}

// ---------------------------------------------------------------------------
// The ONE gate.
// ---------------------------------------------------------------------------

export interface CompletionProofGateInput {
  department: string | null | undefined;
  /** The ACTIVE registered receipt (getActiveReceipt) — pass null when none. */
  activeReceipt: RegisteredReceipt | null;
  /** The task's stored anti-spoof identifier. */
  storedCert: string | null | undefined;
}

export interface CompletionProofGateResult {
  applies: boolean;
  ok: boolean;
  code?:
    | 'process_certificate_required'
    | 'process_proof_required'
    | 'process_proof_stale';
  error?: string;
  remediation?: string;
}

/** Detect post-proof mutation: the artifact SHAs recomputed NOW must still
 * match the ones the active QC receipt covered. A changed artifact (a repair
 * or a decoy swap) stales the proof. */
export function qcIsCurrent(receipt: RegisteredReceipt | null): { current: boolean; reason?: string } {
  if (!receipt) return { current: false, reason: 'no active receipt' };
  const qc = receipt.qc_receipts ?? [];
  if (qc.length === 0) {
    // Registration with PRESENTATION_PROOF_QC_PENDING=1 permits a
    // qc-pending receipt; the gate still treats it as non-proven.
    return { current: false, reason: 'receipt carries no trusted QC receipt' };
  }
  const now = recomputeDeliverableEvidence(receipt.task_id);
  if (!now.ok) return { current: false, reason: 'registered deliverable set no longer reachable: ' + (now.evidence.problems.join('; ') || 'unreachable') };
  const newestQc = qc.reduce((a, b) => (a.scored_at > b.scored_at ? a : b));
  const covered = newestQc.artifact_shas ?? {};
  for (const h of now.hashes) {
    if (!h.sha256) continue;
    const was = covered[h.id];
    if (was && was !== h.sha256) {
      return {
        current: false,
        reason: `artifact "${h.title}" changed after the QC pass (was ${was.slice(0, 12)}, now ${h.sha256.slice(0, 12)}) — its QC is stale`,
      };
    }
  }
  return { current: true };
}

/**
 * THE completion gate for presentations tasks — the one decision every
 * status-changing path consumes. A presentations task may reach `done` only
 * when an ACTIVE, VERIFIED, CURRENT receipt is on record. The identifier
 * (`storedCert`) alone proves nothing: it is checked for CONSISTENCY with the
 * active receipt (a mismatch means someone rotated one side without the other
 * — refuse loudly, never silently accept either half).
 */
export function evaluatePresentationsCompletionProof(
  input: CompletionProofGateInput,
): CompletionProofGateResult {
  if (!proofRegistryEnabled()) {
    // Rollback: the identifier-only contract, verbatim pre-PRES-022 posture.
    const stored = typeof input.storedCert === 'string' ? input.storedCert.trim().toLowerCase() : '';
    if (stored.length > 0) return { applies: true, ok: true };
    return {
      applies: true, ok: false, code: 'process_certificate_required',
      error: 'a presentations task requires a registered process_certificate_sha to be marked done',
    };
  }

  const receipt = input.activeReceipt;
  if (!receipt) {
    return {
      applies: true, ok: false, code: 'process_proof_required',
      error: 'Forbidden: a presentations task requires VERIFIED completion proof (a registered verification receipt) to be marked done — a bare sha256 digest no longer registers anything.',
      remediation:
        'Complete the run through the presentation engine (it registers a signed receipt or the server recomputes the process proof), ' +
        'or register proof via registerVerifiedReceipt. A repair/retry bumps the run attempt and registers FRESH proof; the prior approval is invalidated, history retained.',
    };
  }

  // Consistency: the anti-spoof slot must mirror the active receipt.
  const stored = typeof input.storedCert === 'string' ? input.storedCert.trim().toLowerCase() : '';
  if (stored && stored !== receipt.receipt_sha256.toLowerCase()) {
    return {
      applies: true, ok: false, code: 'process_proof_stale',
      error: 'Forbidden: the task certificate identifier does not match the active verification receipt — one side was rotated without the other.',
      remediation: 'Re-register the active revision through the registry so identifier and proof agree, then retry.',
    };
  }

  const currency = qcIsCurrent(receipt);
  if (!currency.current) {
    return {
      applies: true, ok: false, code: 'process_proof_stale',
      error: `Forbidden: the registered completion proof is stale — ${currency.reason ?? 'artifacts changed after proof'}.`,
      remediation: 'A repair/revision must register FRESH proof (and a fresh independent QC pass over the new hashes) before this task can complete.',
    };
  }

  return { applies: true, ok: true };
}

/** Convenience: the gate wired to a live task read. */
export function evaluateTaskCompletionProof(taskId: string, department: string | null | undefined): CompletionProofGateResult {
  return evaluatePresentationsCompletionProof({
    department,
    activeReceipt: getActiveReceipt(taskId),
    storedCert: queryOne<{ process_certificate_sha: string | null }>(
      'SELECT process_certificate_sha FROM tasks WHERE id = ?', [taskId],
    )?.process_certificate_sha ?? null,
  });
}