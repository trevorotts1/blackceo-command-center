/**
 * execution-load-evidence.ts — D26 (spec 11.2, first half): execution snapshot
 * and blueprint load evidence.
 *
 * WHAT: at execution start, capture the assigned decision revision/hash plus
 * the required blueprint content versions (catalog version + required
 * sections/appendices per root scope) into `execution_load_evidence`. At
 * completion, verify the producer's load report against THAT capture — which
 * sections/appendices were actually loaded — instead of trusting a
 * self-reported "persona followed" flag alone.
 *
 * READS (never writes): task_persona_bundle, task_persona_bundle_scope,
 * task_executions.persona_bundle_shas (the D23 dispatch snapshot: what THIS
 * execution was handed). WRITES (own table only): execution_load_evidence.
 * Never touches tasks.ts, dispatch, auto-route, or execution-attempts.
 *
 * Acceptance: A39 (selected/stored/dispatched/used hash mismatch detected via
 * the dispatch-snapshot + execution-identity checks), A40 (blueprint load
 * evidence checked, not only identity equality).
 *
 * D24 (producer/dispatch parity) is PENDING: the additive consumer of this
 * table on the dispatch path ships with D24, not here. Until then the capture
 * call site is a test + the documented consumer contract in submission.json.
 *
 * Fail posture mirrors persona-conformance.ts: executions that predate the
 * evidence machinery pass soft (`execution_before_blueprint_evidence`,
 * `no_persona_bundle`) so an upgrade never bricks in-flight work; anything
 * D26-era and inconsistent fails closed.
 *
 * ponytail: section lists are names today (tool/context-pack evidence by
 * reference). Upgrade to content-hash-per-section when the blueprint store
 * versions sections individually; the `required_sections` shape already
 * carries the slot for it.
 */

import { getDb } from '@/lib/db';
import { personaBundleHash } from '@/lib/persona-state';
import { dispatchedPersonaShas } from '@/lib/persona-conformance';
import type Database from 'better-sqlite3';

/** Additive schema. D27 (installer) folds this into migrations/schema; until
 * then `ensureLoadEvidenceTable` creates it idempotently at the call site. */
export const EXECUTION_LOAD_EVIDENCE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS execution_load_evidence (
 execution_id TEXT PRIMARY KEY,
 task_id TEXT NOT NULL,
 revision_sha TEXT NOT NULL,
 catalog_version TEXT,
 expected_json TEXT NOT NULL,
 required_json TEXT NOT NULL,
 captured_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_execution_load_evidence_task ON execution_load_evidence(task_id);
`;

/** One blueprint contract: the root bundle plus each persisted scope bundle. */
export interface BlueprintLoadEntry {
  scope: string | null;
  catalog_version: string | null;
  required_sections: string[];
}

export interface CapturedLoadEvidence {
  execution_id: string;
  revision_sha: string;
  catalog_version: string | null;
  entries: BlueprintLoadEntry[];
  captured_at: string;
  status: 'captured' | 'execution_before_evidence' | 'no_persona_bundle';
}

export interface BlueprintLoadReport {
  execution_id?: string | null;
  bundle_sha?: string | null;
  /** Root sections/appendices actually loaded (Section-4 A-D, 7B, appendix). */
  loaded_sections?: string[] | null;
  /** Per-scope loaded sections, keyed by scope. */
  scopes?: Record<string, string[]> | null;
}

export interface LoadEvidenceVerdict {
  pass: boolean;
  reason: string;
  missing?: string[];
}

/** The blueprint contract a bundle declares. Additive/optional: bundles
 * persisted before D26 carry nothing here and verify soft (see below). */
function requiredSectionsOf(bundle: unknown): string[] {
  if (!bundle || typeof bundle !== 'object') return [];
  const required = (bundle as { blueprintSections?: { required?: unknown } })
    .blueprintSections?.required;
  if (!Array.isArray(required)) return [];
  return required.filter(
    (s): s is string => typeof s === 'string' && s.trim() !== '',
  );
}

function tableExists(db: Database.Database, name: string): boolean {
  try {
    return !!db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
      .get(name);
  } catch {
    return false;
  }
}

function ensureLoadEvidenceTable(db: Database.Database): void {
  db.exec(EXECUTION_LOAD_EVIDENCE_SCHEMA_SQL);
}

/**
 * Capture the load contract at execution start. Fails closed on unknown
 * executions (never record evidence for a ghost); soft on pre-evidence
 * executions and bundle-less tasks.
 */
export function captureExecutionLoadEvidence(
  taskId: string,
  executionId: string,
  db: Database.Database = getDb(),
): CapturedLoadEvidence {
  const captured_at = new Date().toISOString();
  if (!tableExists(db, 'task_executions'))
    return {
      execution_id: executionId,
      revision_sha: '',
      catalog_version: null,
      entries: [],
      captured_at,
      status: 'execution_before_evidence',
    };
  const exec = db
    .prepare('SELECT id FROM task_executions WHERE id=?')
    .get(executionId) as { id: string } | undefined;
  if (!exec) throw new Error('execution_unknown');
  const row = tableExists(db, 'task_persona_bundle')
    ? (db
        .prepare(
          'SELECT bundle_json, catalog_version FROM task_persona_bundle WHERE task_id=?',
        )
        .get(taskId) as
        | { bundle_json: string; catalog_version: string | null }
        | undefined)
    : undefined;
  if (!row)
    return {
      execution_id: executionId,
      revision_sha: '',
      catalog_version: null,
      entries: [],
      captured_at,
      status: 'no_persona_bundle',
    };
  const bundle = JSON.parse(row.bundle_json) as Record<string, unknown>;
  const revision_sha = personaBundleHash(bundle);
  const catalog_version =
    row.catalog_version ??
    (typeof bundle.catalog_version === 'string' ? bundle.catalog_version : null);
  const entries: BlueprintLoadEntry[] = [
    {
      scope: null,
      catalog_version,
      required_sections: requiredSectionsOf(bundle),
    },
  ];
  if (tableExists(db, 'task_persona_bundle_scope')) {
    const scopes = db
      .prepare(
        'SELECT scope, bundle_json, catalog_version FROM task_persona_bundle_scope WHERE task_id=?',
      )
      .all(taskId) as {
      scope: string;
      bundle_json: string;
      catalog_version: string | null;
    }[];
    for (const s of scopes) {
      const scoped = JSON.parse(s.bundle_json) as Record<string, unknown>;
      entries.push({
        scope: s.scope,
        catalog_version:
          s.catalog_version ??
          (typeof scoped.catalog_version === 'string'
            ? scoped.catalog_version
            : null),
        required_sections: requiredSectionsOf(scoped),
      });
    }
  }
  ensureLoadEvidenceTable(db);
  db.prepare(
    `INSERT INTO execution_load_evidence
       (execution_id, task_id, revision_sha, catalog_version, expected_json, required_json, captured_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(execution_id) DO UPDATE SET
       task_id=excluded.task_id, revision_sha=excluded.revision_sha,
       catalog_version=excluded.catalog_version, expected_json=excluded.expected_json,
       required_json=excluded.required_json, captured_at=excluded.captured_at`,
  ).run(
    executionId,
    taskId,
    revision_sha,
    catalog_version,
    JSON.stringify(entries),
    JSON.stringify(entries.map((e) => e.required_sections)),
    captured_at,
  );
  return {
    execution_id: executionId,
    revision_sha,
    catalog_version,
    entries,
    captured_at,
    status: 'captured',
  };
}

/**
 * Verify a producer's load report against the capture. Identity equality
 * (bundle sha) is necessary but NOT sufficient: every required section must
 * be named as loaded. Same sha + missing section still fails (A40).
 */
export function verifyExecutionLoadEvidence(
  taskId: string,
  executionId: string,
  report: BlueprintLoadReport,
  db: Database.Database = getDb(),
): LoadEvidenceVerdict {
  try {
    if (!tableExists(db, 'task_executions'))
      return { pass: true, reason: 'execution_before_blueprint_evidence' };
    const ev = tableExists(db, 'execution_load_evidence')
      ? (db
          .prepare(
            'SELECT task_id, revision_sha, required_json FROM execution_load_evidence WHERE execution_id=?',
          )
          .get(executionId) as
          | { task_id: string; revision_sha: string; required_json: string }
          | undefined)
      : undefined;
    const dispatched = dispatchedPersonaShas(executionId, db);
    if (!ev) {
      // No capture. D26-era dispatch (a dispatch snapshot exists) without a
      // capture is a hard gap; pre-evidence executions skip like the
      // persona-conformance dispatch-snapshot rule does.
      if (dispatched) return { pass: false, reason: 'blueprint_load_evidence_missing' };
      return { pass: true, reason: 'execution_before_blueprint_evidence' };
    }
    if (ev.revision_sha === '' )
      return { pass: true, reason: 'no_persona_bundle' };
    if (ev.task_id !== taskId)
      return { pass: false, reason: 'execution_identity_mismatch' };
    if ((report.execution_id ?? null) !== executionId)
      return { pass: false, reason: 'execution_identity_mismatch' };
    if (
      dispatched?.root &&
      report.bundle_sha &&
      report.bundle_sha !== dispatched.root
    )
      return { pass: false, reason: 'execution_bundle_revision_mismatch' };
    if (dispatched?.root && ev.revision_sha !== dispatched.root)
      return { pass: false, reason: 'captured_revision_not_dispatched' };
    // A40: required sections actually loaded — root and every captured scope.
    const required = JSON.parse(ev.required_json) as string[][];
    const scopes = JSON.parse(
      (db
        .prepare(
          'SELECT expected_json FROM execution_load_evidence WHERE execution_id=?',
        )
        .get(executionId) as { expected_json: string }).expected_json,
    ) as BlueprintLoadEntry[];
    void taskId;
    const missing: string[] = [];
    const loadedRoot = Array.isArray(report.loaded_sections)
      ? report.loaded_sections
      : [];
    for (const section of required[0] ?? []) {
      if (!loadedRoot.includes(section)) missing.push(`root:${section}`);
    }
    const reportedScopes =
      report.scopes && typeof report.scopes === 'object' ? report.scopes : {};
    scopes.slice(1).forEach((entry, i) => {
      const loaded = Array.isArray(reportedScopes[entry.scope ?? ''])
        ? reportedScopes[entry.scope ?? '']
        : [];
      for (const section of required[i + 1] ?? []) {
        if (!loaded.includes(section))
          missing.push(`${entry.scope}:${section}`);
      }
      const dispatchedScope = dispatched?.scopes?.[entry.scope ?? ''];
      void dispatchedScope;
    });
    if (missing.length)
      return {
        pass: false,
        reason: 'blueprint_required_sections_unloaded',
        missing,
      };
    return { pass: true, reason: 'blueprint_load_evidence_verified' };
  } catch {
    return { pass: false, reason: 'blueprint_load_evidence_unavailable' };
  }
}
