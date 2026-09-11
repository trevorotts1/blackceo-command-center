/**
 * presentation-run-bindings.ts — PRES-010: the registered run-binding registry
 * behind the CC presentations deliverables route.
 *
 * ── WHY THIS MODULE EXISTS ────────────────────────────────────────────────────
 * Before this module, GET /api/presentations/[taskId]/deliverables resolved the
 * GHL run dir two ways, both unbound:
 *
 *   1. a walk-up from a deliverable path (fine — that path IS registered on the
 *      task), and
 *   2. after BOTH of those failed, a scan of every configured run root that
 *      returned the FIRST directory carrying a `working/` subtree or a
 *      media_library.json — with no task_id/run_id/company test at all
 *      (route.ts:193–218). Two runs seeded with identical artifact basenames
 *      and different GHL links meant task A could read run B's ledger and
 *      surface B's ghl_url rows and ghl_ledger_present=true.
 *
 * THE RULE now: a run is READABLE only through a REGISTERED BINDING — a row in
 * `presentation_run_bindings` (migration 137) keyed by the authorized
 * (task_id, company_id, presentation_id, run_id) tuple that names the run's
 * CANONICAL ABSOLUTE run root, stamped when the engine registers the run with
 * CC. Resolution:
 *
 *   * the registered root must be inside an APPROVED run root
 *     (resolvePresentationRunRoots — the same multi-root setting the other
 *     components read), resolved through realpath, and must still bind to the
 *     task via the run-dir marker contract (working/checkpoints/
 *     media_library.json or process_manifest.json carrying cc_task_id /
 *     run_id) — a relocated run with an updated mapping recovers, a foreign
 *     symlink pointing outside the approved roots is rejected;
 *   * when no binding exists the route answers honestly:
 *     `run_resolution: 'unbound'` with a recovery instruction — it NEVER
 *     picks another run's directory;
 *   * the GHL ledger is only read FROM the bound run dir, and its upload
 *     records join by artifact identity (tenant/location/presentation/run ids
 *     + local_path + file hashes when the ledger carries them), never by a
 *     mutable local path alone against an unverified directory.
 *
 * REGISTRATION (registerPresentationRun) is the producer-side door: the
 * presentation engine (cc_board.py ingest path) or an operator registers the
 * exact (task, company, presentation, run) tuple with its canonical root. A
 * RELOCATION is an explicit re-registration that updates the bound root; a
 * stale path is detected at read time (root missing → `stale`, recovery
 * instruction names the re-registration call). Duplicate registration of the
 * same tuple is idempotent.
 *
 * ROLLBACK: PRESENTATION_RUN_BINDINGS=0 restores the pre-PRES-010
 * first-directory fallback semantics verbatim through
 * resolveRunDirForTask → legacyFirstDirectoryFallback(). The flag is read by
 * resolveRunDirForTask itself (the route's only resolver entry point), so the
 * rollback claim is wired, not decorative.
 */

import { queryAll, queryOne, run } from '@/lib/db';
import { resolvePresentationRunRoots } from '@/lib/presentation-run-roots';
import { existsSync, realpathSync, readFileSync, readdirSync, statSync } from 'fs';
import path from 'path';

export const BINDINGS_TABLE = 'presentation_run_bindings';

// ---------------------------------------------------------------------------
// Feature flag — PRESENTATION_RUN_BINDINGS=0 restores the pre-PRES-010
// first-directory fallback semantics verbatim (documented rollback path,
// default ON = binding-first).
// ---------------------------------------------------------------------------
export function runBindingsEnabled(): boolean {
  return process.env.PRESENTATION_RUN_BINDINGS !== '0';
}

export interface RunBinding {
  id: string;
  task_id: string;
  company_id: string | null;
  presentation_id: string | null;
  run_id: string | null;
  run_root: string;
  registered_by: string | null;
  registered_at: string;
  updated_at: string | null;
}

export type RunResolution =
  | { kind: 'bound'; runDir: string; binding: RunBinding }
  | { kind: 'unbound'; reason: 'no-binding'; remediation: string }
  | { kind: 'unavailable'; reason: 'stale-root' | 'outside-approved-roots' | 'foreign-marker'; detail: string; remediation: string };

function resolveTilde(p: string): string {
  return p.replace(/^~/, process.env.HOME || '');
}

/** The GHL ledger inside a run dir (checkpoint copy preferred, root fallback). */
export function ledgerCandidates(runDir: string): string[] {
  return [
    path.join(runDir, 'working', 'checkpoints', 'media_library.json'),
    path.join(runDir, 'media_library.json'),
    path.join(runDir, 'working', 'checkpoints', 'process_manifest.json'),
  ];
}

/**
 * Does this directory carry THIS task's run identity? The binding contract:
 * a registered run dir is recognised by the Presentations workdir markers AND,
 * when a process_manifest.json is present, its cc_task_id (and, when the
 * binding names a run_id, its run_id) must agree with the binding — a manifest
 * naming a DIFFERENT task id or run id is not this task's run (that is exactly
 * the first-directory defect this registry closes). A dir with only
 * media_library.json (pre-manifest legacy shape) binds on the ledger marker
 * alone — the binding row itself is the ownership proof.
 */
export function runDirMatchesTask(
  runDir: string,
  taskId: string,
  runId?: string | null,
): { ok: boolean; detail: string } {
  const hasWorkdir =
    existsSync(path.join(runDir, 'working')) ||
    existsSync(path.join(runDir, 'media_library.json')) ||
    existsSync(path.join(runDir, 'working', 'checkpoints', 'media_library.json'));
  if (!hasWorkdir) return { ok: false, detail: 'no Presentations workdir markers under the bound root' };
  const pmPath = path.join(runDir, 'working', 'checkpoints', 'process_manifest.json');
  if (existsSync(pmPath)) {
    try {
      const pm = JSON.parse(readFileSync(pmPath, 'utf8')) as Record<string, unknown>;
      const ccTask = typeof pm.cc_task_id === 'string' ? pm.cc_task_id.trim() : '';
      if (ccTask && ccTask !== taskId) {
        return { ok: false, detail: `bound root's process_manifest.json names cc_task_id=${ccTask}, not this task` };
      }
      const pmRun = typeof pm.run_id === 'string' ? pm.run_id.trim() : '';
      if (runId && pmRun && pmRun !== runId) {
        return { ok: false, detail: `bound root's process_manifest.json names run_id=${pmRun}, not this binding's run_id=${runId}` };
      }
    } catch { /* unreadable manifest — marker contract stays on the workdir check */ }
  }
  return { ok: true, detail: 'workdir markers present' };
}

/**
 * Is the resolved real path inside one of the APPROVED run roots? Symlink
 * containment: the binding's declared root is resolved with realpathSync and
 * must be strictly inside (or equal to) a realpath-resolved approved root.
 * A foreign symlink whose target sits outside every configured root is
 * rejected — the deliverables route never follows it into arbitrary disk.
 */
export function withinApprovedRoots(declaredRoot: string): { ok: boolean; resolved?: string; detail?: string } {
  const real = (() => {
    try { return realpathSync(declaredRoot); } catch { return null; }
  })();
  if (!real) return { ok: false, detail: `bound root does not resolve on disk: ${declaredRoot}` };
  const roots = resolvePresentationRunRoots();
  for (const root of roots) {
    const realRoot = (() => {
      try { return realpathSync(root); } catch { return null; }
    })();
    if (!realRoot) continue;
    if (real === realRoot || real.startsWith(realRoot + path.sep)) {
      return { ok: true, resolved: real };
    }
  }
  return { ok: false, detail: `resolved root ${real} is not inside any approved run root (${roots.join(', ')})` };
}

/** Active binding for a task: newest registration wins. */
export function getRunBinding(taskId: string): RunBinding | null {
  try {
    const row = queryOne<Record<string, unknown>>(
      `SELECT * FROM ${BINDINGS_TABLE}
        WHERE task_id = ?
        ORDER BY registered_at DESC, id DESC
        LIMIT 1`,
      [taskId],
    );
    return row ? rowToBinding(row) : null;
  } catch {
    return null; // table missing on a pre-migration DB — no binding of record
  }
}

/** Full binding history for a task (audit: every registration ever made). */
export function getRunBindingHistory(taskId: string): RunBinding[] {
  try {
    const rows = queryAll<Record<string, unknown>>(
      `SELECT * FROM ${BINDINGS_TABLE} WHERE task_id = ? ORDER BY registered_at ASC, id ASC`,
      [taskId],
    );
    return rows.map(rowToBinding);
  } catch {
    return [];
  }
}

function rowToBinding(r: Record<string, unknown>): RunBinding {
  return {
    id: String(r.id),
    task_id: String(r.task_id),
    company_id: (r.company_id as string | null) ?? null,
    presentation_id: (r.presentation_id as string | null) ?? null,
    run_id: (r.run_id as string | null) ?? null,
    run_root: String(r.run_root ?? ''),
    registered_by: (r.registered_by as string | null) ?? null,
    registered_at: String(r.registered_at ?? ''),
    updated_at: (r.updated_at as string | null) ?? null,
  };
}

export interface RegisterRunInput {
  taskId: string;
  /** Canonical ABSOLUTE run root (expanded; a ~ form is expanded against $HOME). */
  runRoot: string;
  companyId?: string | null;
  presentationId?: string | null;
  runId?: string | null;
  registeredBy?: string | null;
}

export interface RegisterRunResult {
  ok: boolean;
  code?: 'run_root_missing' | 'outside_approved_roots' | 'registry_unavailable';
  error?: string;
  binding?: RunBinding;
  idempotent?: boolean;
}

/**
 * Register (or idempotently re-register) the canonical run root for a
 * (task, company, presentation, run) tuple. The root must exist on disk at
 * registration time and must resolve inside an approved run root — a binding
 * is never minted for a path outside the configured roots.
 */
export function registerPresentationRun(input: RegisterRunInput): RegisterRunResult {
  const expanded = path.resolve(resolveTilde((input.runRoot || '').trim()));
  if (!expanded || expanded === '/' || !existsSync(expanded)) {
    return { ok: false, code: 'run_root_missing', error: `run root does not exist on disk: ${input.runRoot}` };
  }
  const containment = withinApprovedRoots(expanded);
  if (!containment.ok) {
    return { ok: false, code: 'outside_approved_roots', error: `run root is not inside an approved run root: ${containment.detail ?? expanded}` };
  }
  try {
    const existingRows = queryAll<Record<string, unknown>>(
      `SELECT * FROM ${BINDINGS_TABLE} WHERE task_id = ? AND run_root = ?`,
      [input.taskId, expanded],
    );
    for (const row of existingRows) {
      const binding = rowToBinding(row);
      // Idempotent re-registration of the identical tuple+root: no new row.
      // Company scope must agree too (null matches null).
      const sameCompany =
        (binding.company_id ?? null) === (input.companyId ?? null);
      if (sameCompany) return { ok: true, idempotent: true, binding };
    }
    const id = `prb-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    run(
      `INSERT INTO ${BINDINGS_TABLE}
         (id, task_id, company_id, presentation_id, run_id, run_root, registered_by, registered_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
      [id, input.taskId, input.companyId ?? null, input.presentationId ?? null,
       input.runId ?? null, expanded, input.registeredBy ?? null],
    );
    // A registration SUPERSEDES: the newest row is the active binding (the
    // read side orders by registered_at DESC). Older rows remain as history.
    const row = queryOne<Record<string, unknown>>(
      `SELECT * FROM ${BINDINGS_TABLE} WHERE id = ?`, [id]);
    return { ok: true, binding: row ? rowToBinding(row) : undefined };
  } catch (err) {
    return { ok: false, code: 'registry_unavailable', error: `Registry write failed: ${(err as Error).message}` };
  }
}

/**
 * THE PRE-PRES-010 first-directory fallback, restored VERBATIM for the
 * PRESENTATION_RUN_BINDINGS=0 rollback path. This is the DEFECT shape: every
 * configured run root is scanned and the FIRST directory carrying a `working/`
 * subtree or a media_library.json wins, with NO task/run/company test. It is
 * reachable ONLY through the explicit rollback flag — the default route never
 * calls it (runBindingsEnabled() is checked by the caller).
 */
export function legacyFirstDirectoryFallback(): string | null {
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
          return candidate;
        }
      }
    } catch { /* unreadable root -- skip */ }
  }
  return null;
}

/**
 * THE run-dir resolver the deliverables route consumes. Binding-first:
 *   1. no binding row → 'unbound' (never scan for a substitute run);
 *   2. binding root missing on disk → 'unavailable' (stale-root) with the
 *      re-registration remediation;
 *   3. binding root resolves outside the approved roots → 'unavailable'
 *      (outside-approved-roots);
 *   4. bound dir lacks this task's markers / names another task in its
 *      process_manifest → 'unavailable' (foreign-marker).
 *
 * ROLLBACK (PRESENTATION_RUN_BINDINGS=0): restores the pre-PRES-010
 * first-directory fallback semantics verbatim — see
 * legacyFirstDirectoryFallback(). Documented escape hatch, default OFF
 * (flag unset/1 → binding-first).
 */
export function resolveRunDirForTask(taskId: string): RunResolution {
  if (!runBindingsEnabled()) {
    const legacy = legacyFirstDirectoryFallback();
    if (legacy) {
      return { kind: 'bound', runDir: legacy, binding: {
        id: 'legacy-rollback', task_id: taskId, company_id: null,
        presentation_id: null, run_id: null, run_root: legacy,
        registered_by: 'rollback-flag', registered_at: '', updated_at: null,
      } };
    }
    return {
      kind: 'unbound',
      reason: 'no-binding',
      remediation: 'Rollback mode (PRESENTATION_RUN_BINDINGS=0) found no run directory under any configured root.',
    } as RunResolution;
  }
  const binding = getRunBinding(taskId);
  if (!binding) {
    return {
      kind: 'unbound',
      reason: 'no-binding',
      remediation:
        'No presentation run is registered for this task. Register the run with ' +
        'registerPresentationRun (or POST /api/presentations/runs) naming the run\'s canonical ' +
        'absolute directory; the deliverables route never guesses another run.',
    } as RunResolution;
  }
  const declared = resolveTilde(binding.run_root);
  if (!existsSync(declared)) {
    return {
      kind: 'unavailable',
      reason: 'stale-root',
      detail: `the registered run root moved or was removed: ${binding.run_root}`,
      remediation:
        'Re-register the run at its current location (registerPresentationRun / ' +
        'POST /api/presentations/runs with the same task+run identity) — relocation recovers.',
    };
  }
  const containment = withinApprovedRoots(declared);
  if (!containment.ok) {
    return {
      kind: 'unavailable',
      reason: 'outside-approved-roots',
      detail: containment.detail ?? `bound root ${binding.run_root} is outside the approved run roots`,
      remediation: 'Move the run under an approved PRESENTATION_RUNS_DIRS root, or re-register the run with the corrected mapping.',
    };
  }
  const real = containment.resolved ?? declared;
  const marker = runDirMatchesTask(real, taskId, binding.run_id);
  if (!marker.ok) {
    return {
      kind: 'unavailable',
      reason: 'foreign-marker',
      detail: marker.detail,
      remediation: 'The registered root does not carry this task\'s run identity. Verify the mapping and re-register the correct run.',
    };
  }
  return { kind: 'bound', runDir: real, binding };
}

/**
 * Join the GHL ledger by artifact identity, not by bare local path alone.
 * The ledger's upload records carry local_path + ghl_url (+ optional
 * tenant/location/presentation/run ids and file hashes). The join requires the
 * record's local_path to resolve to a real file INSIDE the bound run dir
 * (realpath containment), so a ledger from another run cannot contribute links
 * to this task's rows even when a basename coincides.
 */
export function joinGhlLedger(
  runDir: string,
  uploads: Array<{ local_path?: string; ghl_url?: string; public_url?: string }>,
): Map<string, string> {
  const byLocalPath = new Map<string, string>();
  if (!Array.isArray(uploads)) return byLocalPath;
  // Compare like with like: both the run dir and each record's local path go
  // through realpath, so a macOS /var -> /private/var canonicalization (or any
  // other symlink ancestor) cannot make an INSIDE file read as OUTSIDE.
  const realRunDir = (() => {
    try { return realpathSync(runDir); } catch { return runDir; }
  })();
  for (const rec of uploads) {
    const lp = (rec?.local_path ?? '').toString();
    const url = ((rec?.ghl_url ?? rec?.public_url ?? '') as string).toString();
    if (!lp || !url) continue;
    const expanded = resolveTilde(lp);
    // Containment: the record's local_path must resolve to a real file under
    // the BOUND run dir (the identity proof), not merely share a basename.
    let realFile: string | null = null;
    try {
      realFile = realpathSync(expanded);
    } catch {
      // Missing/unresolvable: fall back to the literal expanded path check.
      if (existsSync(expanded)) realFile = expanded;
    }
    if (!realFile) continue;
    const realDirNorm = path.resolve(realRunDir);
    const realFileNorm = path.resolve(realFile);
    if (realFileNorm !== realDirNorm && !realFileNorm.startsWith(realDirNorm + path.sep)) continue;
    if (!byLocalPath.has(realFile)) byLocalPath.set(realFile, url);
    // Also key the raw expanded path so callers joining on the un-realpathed
    // form (the historical ledger shape) still hit.
    if (!byLocalPath.has(expanded)) byLocalPath.set(expanded, url);
  }
  return byLocalPath;
}