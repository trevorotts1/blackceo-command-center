/**
 * silent-terminal-stop-guard.test.ts — "no card stops permanently in silence",
 * enforced statically so it cannot rot.
 *
 * ── Why a guard and not just tests ───────────────────────────────────────────
 * The live defect was never one broken function. It was that "does this notify?"
 * was a per-path decision, made independently in eight places, so the answer
 * drifted to "no" wherever nobody was looking. Behavioural tests prove the paths
 * that exist today are correct; they say nothing about the ninth path someone
 * adds next month. This guard is the part that survives the next author.
 *
 * ── TWO-PART BINARY ACCEPTANCE ───────────────────────────────────────────────
 *   (a) STATICALLY — every write that parks a card in `blocked`, repo-wide,
 *       either routes through stopCardPermanently() or carries a written
 *       `SILENT-STOP-EXEMPT:` reason. Proven here against the REAL tree.
 *   (b) MUTATION PROOF — the guard FAILS on a scratch-tree mutation that adds a
 *       silent block, and PASSES again once it is removed, routed through the
 *       chokepoint, or annotated. Teeth, not just a green checkmark.
 *
 * Mirrors tests/unit/raw-status-writer-guard.test.ts, which is this repo's
 * established shape for a static invariant with a mutation proof.
 *
 *   node --import tsx --test tests/unit/silent-terminal-stop-guard.test.ts
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
const GUARD = path.join(REPO_ROOT, 'scripts', 'guard-silent-terminal-stops.ts');
const TSX_BIN = path.join(REPO_ROOT, 'node_modules', '.bin', 'tsx');

function runGuard(args: string[] = []): { status: number | null; stdout: string; stderr: string } {
  const res = spawnSync(TSX_BIN, [GUARD, ...args], { encoding: 'utf8' });
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

function makeScratchTree(): { root: string; libDir: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'silent-stop-guard-fixture-'));
  const libDir = path.join(root, 'src', 'lib');
  fs.mkdirSync(libDir, { recursive: true });
  return { root, libDir };
}

// These fixtures declare local stubs rather than importing the real modules:
// guard-silent-terminal-stops.ts only reads their TEXT, and a real db import
// inside a fixture string would trip this repo's separate C8 isolation guard
// (tests/unit/c8-db-isolation-guard.test.ts), which scans raw file text.

/** The defect: a card parked in blocked, nobody told. */
const SILENT_RAW_BLOCK = [
  'declare function run(sql: string, params: unknown[]): { changes: number };',
  'export function rogueStop(id: string) {',
  "  run(`UPDATE tasks SET status = 'blocked', updated_at = ? WHERE id = ?`, [new Date().toISOString(), id]);",
  '}',
].join('\n');

/** The same defect through the state machine instead of raw SQL. */
const SILENT_TRANSITION_BLOCK = [
  "declare function transition(id: string, to: string, ev: unknown): Promise<void>;",
  'export async function rogueStop(id: string) {',
  "  await transition(id, 'blocked', { actor: 'rogue', reason: 'gave up' });",
  '}',
].join('\n');

/** Heal 1 — route the notice through the chokepoint. */
const HEALED_VIA_CHOKEPOINT = [
  'declare function run(sql: string, params: unknown[]): { changes: number };',
  'declare function stopCardPermanently(p: unknown): Promise<unknown>;',
  'export async function rogueStop(id: string) {',
  "  run(`UPDATE tasks SET status = 'blocked', updated_at = ? WHERE id = ?`, [new Date().toISOString(), id]);",
  '  await stopCardPermanently({ taskId: id, applyBlock: false });',
  '}',
].join('\n');

/** Heal 2 — declare, in code, why silence is correct here. */
const HEALED_VIA_EXEMPTION = [
  'declare function run(sql: string, params: unknown[]): { changes: number };',
  'export function rogueStop(id: string) {',
  '  // SILENT-STOP-EXEMPT: test fixture — never reachable at runtime.',
  "  run(`UPDATE tasks SET status = 'blocked', updated_at = ? WHERE id = ?`, [new Date().toISOString(), id]);",
  '}',
].join('\n');

/** Negative control: blocking is READ, not written. Must never trip. */
const READS_BLOCKED_ONLY = [
  'declare function run(sql: string, params: unknown[]): { changes: number };',
  'export function clearAsk(id: string) {',
  "  run(`UPDATE tasks SET ask = NULL WHERE id = ? AND status = 'blocked'`, [id]);",
  '}',
].join('\n');

/** Negative control: a DIFFERENT terminal status, out of this guard's scope. */
const WRITES_DONE_NOT_BLOCKED = [
  'declare function run(sql: string, params: unknown[]): { changes: number };',
  'export function finish(id: string) {',
  "  run(`UPDATE tasks SET status = 'done' WHERE id = ?`, [id]);",
  '}',
].join('\n');

test('[STATIC] guard PASSES against the real repository tree — every terminal stop notifies or is annotated', () => {
  const { status, stdout, stderr } = runGuard();
  assert.equal(status, 0, `expected PASS against the real tree, got:\n${stdout}${stderr}`);
  assert.match(stdout, /PASS — no silent terminal stop/);
  // Pin the shape of the count line so a SILENT drop of every converted call
  // site (not just a new rogue one) also shows up here.
  assert.match(stdout, /\d+ terminal-stop write\(s\) found/);
});

test('[STATIC] the real tree still HAS terminal-stop writes — the guard is not passing because it found nothing', () => {
  const { stdout } = runGuard();
  const count = Number(/(\d+) terminal-stop write\(s\) found/.exec(stdout)?.[1] ?? '0');
  assert.ok(
    count >= 5,
    `the converted paths must still be visible to the guard (found ${count}). A guard that passes ` +
      'because its detector stopped matching is the failure mode this assertion exists to catch.',
  );
  // Name the paths that MUST remain covered. If one is deleted or renamed, this
  // fails loudly rather than quietly shrinking the guard's coverage.
  for (const expected of [
    'src/lib/qc-scorer.ts',
    'src/lib/task-dispatcher.ts',
    'src/lib/jobs/stuck-in-progress-sweep.ts',
  ]) {
    assert.match(stdout, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      `${expected} must still be enumerated by the guard`);
  }
});

test('[STATIC][MUTATION PROOF] the guard FAILS on a planted silent raw block, and PASSES once it is removed', () => {
  const { root, libDir } = makeScratchTree();
  try {
    const baseline = runGuard(['--root', root]);
    assert.equal(baseline.status, 0, `expected baseline PASS (empty tree), got:\n${baseline.stdout}${baseline.stderr}`);

    const roguePath = path.join(libDir, 'rogue.ts');
    fs.writeFileSync(roguePath, SILENT_RAW_BLOCK, 'utf8');

    const mutated = runGuard(['--root', root]);
    assert.equal(
      mutated.status,
      1,
      `expected FAIL on the planted silent block, got exit ${mutated.status}:\n${mutated.stdout}${mutated.stderr}`,
    );
    assert.match(mutated.stderr, /INVARIANT VIOLATED/);
    assert.match(mutated.stderr, /rogue\.ts/, 'the violation report must name the offending file');
    assert.match(mutated.stderr, /should not be silent/, 'the report must state the rule it enforces');

    fs.rmSync(roguePath);
    const healed = runGuard(['--root', root]);
    assert.equal(healed.status, 0, `expected PASS after removing it, got:\n${healed.stdout}${healed.stderr}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('[STATIC][MUTATION PROOF] a silent block through transition() is caught too — raw SQL is not the only way in', () => {
  const { root, libDir } = makeScratchTree();
  try {
    fs.writeFileSync(path.join(libDir, 'rogue.ts'), SILENT_TRANSITION_BLOCK, 'utf8');
    const mutated = runGuard(['--root', root]);
    assert.equal(mutated.status, 1, `expected FAIL on transition(…, 'blocked'), got:\n${mutated.stdout}${mutated.stderr}`);
    assert.match(mutated.stderr, /\[transition\]/, 'the report must identify it as a transition-shaped stop');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('[STATIC][HEAL] routing the planted stop through stopCardPermanently makes the guard PASS', () => {
  const { root, libDir } = makeScratchTree();
  try {
    const roguePath = path.join(libDir, 'rogue.ts');
    fs.writeFileSync(roguePath, SILENT_RAW_BLOCK, 'utf8');
    assert.equal(runGuard(['--root', root]).status, 1, 'sanity: the silent block must fail first');

    fs.writeFileSync(roguePath, HEALED_VIA_CHOKEPOINT, 'utf8');
    const healed = runGuard(['--root', root]);
    assert.equal(
      healed.status,
      0,
      `expected PASS once routed through the chokepoint, got:\n${healed.stdout}${healed.stderr}`,
    );
    assert.match(healed.stdout, /rogue\.ts/, 'the clean hit list should name the now-compliant file');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('[STATIC][HEAL] a written SILENT-STOP-EXEMPT reason also makes the guard PASS — silence stays possible, but reviewed', () => {
  const { root, libDir } = makeScratchTree();
  try {
    const roguePath = path.join(libDir, 'rogue.ts');
    fs.writeFileSync(roguePath, SILENT_RAW_BLOCK, 'utf8');
    assert.equal(runGuard(['--root', root]).status, 1, 'sanity: the silent block must fail first');

    fs.writeFileSync(roguePath, HEALED_VIA_EXEMPTION, 'utf8');
    const healed = runGuard(['--root', root]);
    assert.equal(healed.status, 0, `expected PASS after annotating it, got:\n${healed.stdout}${healed.stderr}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('[STATIC] negative controls — reading blocked, and writing a different terminal status, never trip the guard', () => {
  const { root, libDir } = makeScratchTree();
  try {
    fs.writeFileSync(path.join(libDir, 'reads-only.ts'), READS_BLOCKED_ONLY, 'utf8');
    fs.writeFileSync(path.join(libDir, 'writes-done.ts'), WRITES_DONE_NOT_BLOCKED, 'utf8');

    const result = runGuard(['--root', root]);
    assert.equal(
      result.status,
      0,
      `a WHERE-clause read and a non-blocked status write must never trip the guard, got:\n${result.stdout}${result.stderr}`,
    );
    assert.match(result.stdout, /0 terminal-stop write\(s\) found/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('[STATIC] categorical exclusions — the state machine and DDL files are never scanned', () => {
  const { root } = makeScratchTree();
  try {
    const dbDir = path.join(root, 'src', 'lib', 'db');
    fs.mkdirSync(dbDir, { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'lib', 'task-lifecycle.ts'), SILENT_RAW_BLOCK, 'utf8');
    fs.writeFileSync(path.join(root, 'src', 'lib', 'stop-card.ts'), SILENT_RAW_BLOCK, 'utf8');
    fs.writeFileSync(path.join(dbDir, 'migrations.ts'), SILENT_RAW_BLOCK, 'utf8');
    fs.writeFileSync(path.join(dbDir, 'schema.ts'), SILENT_RAW_BLOCK, 'utf8');

    const result = runGuard(['--root', root]);
    assert.equal(
      result.status,
      0,
      `excluded files must never be scanned even when they contain a silent block, got:\n${result.stdout}${result.stderr}`,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
