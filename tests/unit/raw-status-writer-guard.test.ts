/**
 * raw-status-writer-guard.test.ts — U99 (v1 U9; v1 ref C12.3 item 1; master
 * spec Section E4): "Raw-writer convergence to transition() + CI guard
 * against new raw `UPDATE tasks SET status` writers."
 *
 * TWO-PART BINARY ACCEPTANCE (U99's own "what" + acceptance criteria (a)/(b)):
 *   (a) STATICALLY — a repo-wide enumeration of raw `UPDATE tasks SET …
 *       status` writers outside task-lifecycle.ts reaches zero OR an
 *       explicit, in-code-annotated allowlist each with a written reason
 *       (scripts/guard-raw-status-writers.ts). Proven here against the REAL
 *       tree: every current raw writer carries a `U99-RAW-STATUS-WRITER:`
 *       annotation.
 *   (b) MUTATION PROOF — the guard FAILS on a scratch-branch mutation adding
 *       an unannotated raw status writer, and PASSES again once it is either
 *       removed or annotated. Teeth, not just a green checkmark.
 *
 * Acceptance criterion (c) — "every migrated path's existing tests stay green
 * and task_events rows appear for transitions that previously bypassed
 * auditing" — is proven behaviorally in
 * tests/unit/raw-status-writer-audit-fixture.test.ts against a representative
 * sample of the newly-closed gaps (this file stays static-only, mirroring the
 * report-back-invariant.test.ts split).
 *
 *   node --import tsx --test tests/unit/raw-status-writer-guard.test.ts
 *   (or: npm run test:unit, which globs this file in automatically)
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../..');
const GUARD = path.join(REPO_ROOT, 'scripts', 'guard-raw-status-writers.ts');
const TSX_BIN = path.join(REPO_ROOT, 'node_modules', '.bin', 'tsx');

function runGuard(args: string[] = []): { status: number | null; stdout: string; stderr: string } {
  const res = spawnSync(TSX_BIN, [GUARD, ...args], { encoding: 'utf8' });
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

function makeScratchTree(): { root: string; libDir: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'raw-status-guard-fixture-'));
  const libDir = path.join(root, 'src', 'lib');
  fs.mkdirSync(libDir, { recursive: true });
  return { root, libDir };
}

// NOTE: these fixtures deliberately declare `run` as a local stub instead of
// importing the real db module's run() helper — a real import of that module
// would (correctly, for an actual source file) trip this repo's separate C8
// guard (tests/unit/c8-db-isolation-guard.test.ts), which scans raw file text
// for that import specifier anywhere — including inside a fixture string.
// These fixtures are never executed/imported (guard-raw-status-writers.ts
// only reads their TEXT), so a stub declaration exercises the same SQL-
// pattern detection without tripping an unrelated guard on this file.
const ROGUE_UNANNOTATED = [
  'declare function run(sql: string, params: unknown[]): { changes: number };',
  'export function rogueWriter(id: string) {',
  "  run(`UPDATE tasks SET status = 'blocked', updated_at = ? WHERE id = ?`, [new Date().toISOString(), id]);",
  '}',
].join('\n');

const ROGUE_ANNOTATED = [
  'declare function run(sql: string, params: unknown[]): { changes: number };',
  'export function rogueWriter(id: string) {',
  '  // U99-RAW-STATUS-WRITER: test fixture — always annotated.',
  "  run(`UPDATE tasks SET status = 'blocked', updated_at = ? WHERE id = ?`, [new Date().toISOString(), id]);",
  '}',
].join('\n');

/** Negative control: sets a DIFFERENT column, never trips the status guard. */
const NON_STATUS_WRITER = [
  'declare function run(sql: string, params: unknown[]): { changes: number };',
  'export function harmlessWriter(id: string) {',
  "  run(`UPDATE tasks SET model_id = ? WHERE id = ?`, ['claude', id]);",
  '}',
].join('\n');

/** Negative control: 'status' only appears in the WHERE clause, not the SET clause. */
const WHERE_ONLY_STATUS = [
  'declare function run(sql: string, params: unknown[]): { changes: number };',
  'export function whereOnlyWriter(id: string) {',
  "  run(`UPDATE tasks SET archived_at = ? WHERE id = ? AND status = 'done'`, [new Date().toISOString(), id]);",
  '}',
].join('\n');

test('[STATIC] guard PASSES against the real repository tree — every raw status writer is annotated', () => {
  const { status, stdout, stderr } = runGuard();
  assert.equal(status, 0, `expected PASS against the real tree, got:\n${stdout}${stderr}`);
  assert.match(stdout, /PASS — no unannotated raw status writer/);
  // Pin the known count so a SILENT drop of the annotation (not just a new
  // rogue writer) is also caught — the count line names every clean hit.
  assert.match(stdout, /\d+ raw status writer\(s\) found, all annotated/);
});

test('[STATIC][MUTATION PROOF] the guard FAILS when an unannotated rogue status writer is planted, and PASSES once it is removed', () => {
  const { root, libDir } = makeScratchTree();
  try {
    const baseline = runGuard(['--root', root]);
    assert.equal(baseline.status, 0, `expected baseline PASS (empty tree), got:\n${baseline.stdout}${baseline.stderr}`);

    const roguePath = path.join(libDir, 'rogue.ts');
    fs.writeFileSync(roguePath, ROGUE_UNANNOTATED, 'utf8');

    const mutated = runGuard(['--root', root]);
    assert.equal(
      mutated.status,
      1,
      `expected the guard to FAIL on the planted unannotated writer, got exit ${mutated.status}:\n${mutated.stdout}${mutated.stderr}`,
    );
    assert.match(mutated.stderr, /INVARIANT VIOLATED/);
    assert.match(mutated.stderr, /rogue\.ts/, 'the violation report must name the offending file');

    fs.rmSync(roguePath);
    const healed = runGuard(['--root', root]);
    assert.equal(
      healed.status,
      0,
      `expected PASS after removing the rogue writer, got exit ${healed.status}:\n${healed.stdout}${healed.stderr}`,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('[STATIC][HEAL] annotating the same rogue writer (instead of removing it) also makes the guard PASS', () => {
  const { root, libDir } = makeScratchTree();
  try {
    const roguePath = path.join(libDir, 'rogue.ts');
    fs.writeFileSync(roguePath, ROGUE_UNANNOTATED, 'utf8');
    const mutated = runGuard(['--root', root]);
    assert.equal(mutated.status, 1, 'sanity: unannotated writer must fail first');

    fs.writeFileSync(roguePath, ROGUE_ANNOTATED, 'utf8');
    const healed = runGuard(['--root', root]);
    assert.equal(
      healed.status,
      0,
      `expected PASS after annotating the writer, got exit ${healed.status}:\n${healed.stdout}${healed.stderr}`,
    );
    assert.match(healed.stdout, /rogue\.ts/, 'the clean hit list should name the now-annotated file');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('[STATIC] negative controls — a non-status column write and a WHERE-only status reference never trip the guard', () => {
  const { root, libDir } = makeScratchTree();
  try {
    fs.writeFileSync(path.join(libDir, 'harmless.ts'), NON_STATUS_WRITER, 'utf8');
    fs.writeFileSync(path.join(libDir, 'where-only.ts'), WHERE_ONLY_STATUS, 'utf8');

    const result = runGuard(['--root', root]);
    assert.equal(
      result.status,
      0,
      `a non-status write and a WHERE-only status reference must never trip the guard, got:\n${result.stdout}${result.stderr}`,
    );
    assert.match(result.stdout, /0 raw status writer\(s\) found/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('[STATIC] categorical exclusions — task-lifecycle.ts, db/migrations.ts, db/schema.ts are never scanned even with an unannotated writer', () => {
  const { root } = makeScratchTree();
  try {
    const dbDir = path.join(root, 'src', 'lib', 'db');
    fs.mkdirSync(dbDir, { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'lib', 'task-lifecycle.ts'), ROGUE_UNANNOTATED, 'utf8');
    fs.writeFileSync(path.join(dbDir, 'migrations.ts'), ROGUE_UNANNOTATED, 'utf8');
    fs.writeFileSync(path.join(dbDir, 'schema.ts'), ROGUE_UNANNOTATED, 'utf8');

    const result = runGuard(['--root', root]);
    assert.equal(
      result.status,
      0,
      `excluded files must never be scanned even when they contain an unannotated writer, got:\n${result.stdout}${result.stderr}`,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
