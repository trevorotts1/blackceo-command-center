/**
 * tests/unit/u45-c14-board-truth-regression.test.ts
 *
 * U45 / C-14 — Board-truth regression pack: pin the six-column projection
 * and label single-source. A small, locked-in test pack preventing silent
 * drift of four things this codebase's own comments already claim to be
 * true — each assertion below is failable (verified red against a
 * deliberately-broken tree during development, green at HEAD):
 *
 *   (a) the `todo` synthetic board column maps EXACTLY the four statuses
 *       {inbox, planning, assigned, pending_dispatch} (src/lib/board-projection.ts,
 *       extracted verbatim from src/components/MissionQueue.tsx:117-122 pre-U45),
 *       and the inverse mapping (a To-Do drop / "+" seed) writes 'assigned'.
 *   (b) BACKLOG_COLUMN_LABEL / TODO_COLUMN_LABEL (src/lib/board-labels.ts) are
 *       the ONLY place their literal values are defined — no string-literal
 *       duplicate of either label exists anywhere else under src/ (comments
 *       referencing the label text are fine; a hardcoded VALUE is not), and
 *       MissionQueue.tsx's column config consumes the imported constants,
 *       never a literal.
 *   (c) the 10-status TaskStatus manifest stays in lockstep across
 *       src/lib/types.ts (canonical), src/lib/validation.ts (the Zod request
 *       gate), and src/lib/task-lifecycle.ts (LifecycleState + the
 *       LEGAL_TRANSITIONS key set) — the file headers already demand this
 *       (types.ts:5-8); this test makes the demand executable.
 *   (d) task-dispatcher.ts carries no dead status-set 'archived' reference
 *       (DISP-12, named drift-prone at types.ts:9-19) — archival exclusion
 *       is via `archived_at IS NULL` only. A raw grep would also flag the
 *       DISP-12 explainer comment itself (which legitimately quotes
 *       'archived' in prose); this test strips comments first so only a
 *       real status-set reintroduction can fail it.
 *
 * Runs via the Node built-in test runner under tsx (`npm run test:unit`) —
 * plain fs source-scans + one pure-module import, no DB, no React render,
 * so it never needs vitest.config.ts / vitest.component.config.ts wiring.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { taskToColumnId, columnIdToStatus, TODO_BUCKET_STATUSES, REVIEW_BUCKET_STATUSES } from '../../src/lib/board-projection';
import { TaskStatus as ValidationTaskStatusEnum } from '../../src/lib/validation';
import { BACKLOG_COLUMN_LABEL, TODO_COLUMN_LABEL } from '../../src/lib/board-labels';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SRC = path.join(REPO_ROOT, 'src');

/** Recursively list files under `dir` matching `exts`, skipping node_modules/.next. */
function listFiles(dir: string, exts: string[]): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.next') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listFiles(full, exts));
    } else if (exts.some((ext) => entry.name.endsWith(ext))) {
      out.push(full);
    }
  }
  return out;
}

/** Strip line comments and block comments (test-only, best-effort — good
 *  enough for this codebase's straightforward comment style; a string
 *  literal containing `//` inside quotes is not a concern for the specific
 *  label/status literals this file checks). */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => {
      const idx = line.indexOf('//');
      return idx === -1 ? line : line.slice(0, idx);
    })
    .join('\n');
}

function read(relPath: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, relPath), 'utf8');
}

// ── (a) todo bucket mapping: EXACT set + the inverse write target ───────────

test('U45(a): TODO_BUCKET_STATUSES is EXACTLY {inbox, planning, assigned, pending_dispatch}', () => {
  assert.deepEqual(
    new Set(TODO_BUCKET_STATUSES),
    new Set(['inbox', 'planning', 'assigned', 'pending_dispatch']),
  );
});

test('U45(a): every status in the todo bucket maps to column "todo"', () => {
  for (const status of TODO_BUCKET_STATUSES) {
    assert.equal(taskToColumnId({ status }), 'todo', `status "${status}" must bucket into "todo"`);
  }
});

test('U45(a): the full 10-status → column projection is pinned exactly (no silent drift)', () => {
  const expected: Record<string, string> = {
    backlog: 'backlog',
    inbox: 'todo',
    planning: 'todo',
    assigned: 'todo',
    pending_dispatch: 'todo',
    review: 'review',
    testing: 'review',
    in_progress: 'in_progress',
    blocked: 'blocked',
    done: 'done',
  };
  // Exhaustiveness: the table above must cover every status the request-
  // validation gate (the runtime source of truth) actually accepts — if the
  // manifest grows, this fails loudly instead of silently under-covering.
  assert.deepEqual(
    new Set(Object.keys(expected)),
    new Set(ValidationTaskStatusEnum.options),
    'expected-projection table is out of sync with validation.ts TaskStatus — update BOTH the table above and src/lib/board-projection.ts',
  );
  for (const [status, column] of Object.entries(expected)) {
    assert.equal(taskToColumnId({ status: status as never }), column, `status "${status}" must project to column "${column}"`);
  }
});

test('U45(a): a To-Do drop / "+"-seed writes status "assigned" (columnIdToStatus inverse)', () => {
  assert.equal(columnIdToStatus('todo'), 'assigned');
});

test('U45(a): non-synthetic column ids pass through columnIdToStatus 1:1', () => {
  for (const id of ['backlog', 'in_progress', 'review', 'blocked', 'done']) {
    assert.equal(columnIdToStatus(id), id);
  }
});

test('U45(a): REVIEW_BUCKET_STATUSES is exactly {review, testing}, unaffected by the todo-bucket regression', () => {
  assert.deepEqual(new Set(REVIEW_BUCKET_STATUSES), new Set(['review', 'testing']));
});

// ── (b) label single-source: no duplicate literal outside board-labels.ts ──

test('U45(b): BACKLOG_COLUMN_LABEL / TODO_COLUMN_LABEL literal VALUES are exactly "Being Prepared" / "Ready to Start"', () => {
  assert.equal(BACKLOG_COLUMN_LABEL, 'Being Prepared');
  assert.equal(TODO_COLUMN_LABEL, 'Ready to Start');
});

test('U45(b): no OTHER file under src/ hardcodes the label literal as a value (comments excluded)', () => {
  const boardLabelsPath = path.join(SRC, 'lib', 'board-labels.ts');
  const offenders: string[] = [];
  for (const file of listFiles(SRC, ['.ts', '.tsx'])) {
    if (file === boardLabelsPath) continue; // the single source of truth itself
    const stripped = stripComments(fs.readFileSync(file, 'utf8'));
    if (stripped.includes(BACKLOG_COLUMN_LABEL) || stripped.includes(TODO_COLUMN_LABEL)) {
      offenders.push(path.relative(REPO_ROOT, file));
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `label literal duplicated outside board-labels.ts (import the constant instead) in: ${offenders.join(', ')}`,
  );
});

test('U45(b): MissionQueue.tsx imports the labels from board-labels.ts and consumes them (not literals) in the column config', () => {
  const src = read('src/components/MissionQueue.tsx');
  assert.match(
    src,
    /import\s*\{[^}]*BACKLOG_COLUMN_LABEL[^}]*TODO_COLUMN_LABEL[^}]*\}\s*from\s*'@\/lib\/board-labels'/s,
    'MissionQueue.tsx must import BACKLOG_COLUMN_LABEL and TODO_COLUMN_LABEL from @/lib/board-labels',
  );
  assert.match(src, /id:\s*'backlog',\s*label:\s*BACKLOG_COLUMN_LABEL/, "the 'backlog' column must use the imported constant, not a literal");
  assert.match(src, /id:\s*'todo',\s*label:\s*TODO_COLUMN_LABEL/, "the 'todo' column must use the imported constant, not a literal");
});

// ── (c) 10-status manifest lockstep across types.ts / validation.ts / task-lifecycle.ts ──

/** Pull the quoted string-literal members out of a TS union-type declaration's
 *  own source line(s), e.g. `export type X = 'a' | 'b' | 'c';`. */
function extractUnionLiterals(src: string, declStart: RegExp): string[] {
  const startIdx = src.search(declStart);
  assert.notEqual(startIdx, -1, `declaration matching ${declStart} not found`);
  const endIdx = src.indexOf(';', startIdx);
  assert.notEqual(endIdx, -1, 'declaration is not terminated with a semicolon');
  const decl = src.slice(startIdx, endIdx);
  const literals = [...decl.matchAll(/'([a-zA-Z_]+)'/g)].map((m) => m[1]);
  assert.ok(literals.length > 0, `no quoted literals extracted from: ${decl}`);
  return literals;
}

/** Pull the object keys out of the LEGAL_TRANSITIONS record literal in
 *  task-lifecycle.ts (keys are bare identifiers followed by a colon, one per
 *  line, inside the `{ ... }` block). */
function extractLegalTransitionsKeys(src: string): string[] {
  const startMarker = 'const LEGAL_TRANSITIONS: Record<LifecycleState, Set<LifecycleState>> = {';
  const startIdx = src.indexOf(startMarker);
  assert.notEqual(startIdx, -1, 'LEGAL_TRANSITIONS declaration not found in task-lifecycle.ts');
  const bodyStart = startIdx + startMarker.length;
  const endIdx = src.indexOf('\n};', bodyStart);
  assert.notEqual(endIdx, -1, 'LEGAL_TRANSITIONS closing brace not found');
  const body = src.slice(bodyStart, endIdx);
  const keys = [...body.matchAll(/^\s*([a-zA-Z_]+):\s*new Set/gm)].map((m) => m[1]);
  assert.ok(keys.length > 0, 'no keys extracted from LEGAL_TRANSITIONS body');
  return keys;
}

test('U45(c): validation.ts TaskStatus (runtime) has exactly 10 members', () => {
  assert.equal(ValidationTaskStatusEnum.options.length, 10);
});

test('U45(c): types.ts TaskStatus union is in EXACT lockstep with validation.ts TaskStatus', () => {
  const typesSrc = read('src/lib/types.ts');
  const typesLiterals = extractUnionLiterals(typesSrc, /export type TaskStatus =/);
  assert.deepEqual(
    new Set(typesLiterals),
    new Set(ValidationTaskStatusEnum.options),
    'types.ts TaskStatus and validation.ts TaskStatus have drifted apart — update BOTH manifests together',
  );
});

test('U45(c): task-lifecycle.ts LifecycleState union is in EXACT lockstep with validation.ts TaskStatus', () => {
  const lifecycleSrc = read('src/lib/task-lifecycle.ts');
  const lifecycleLiterals = extractUnionLiterals(lifecycleSrc, /export type LifecycleState =/);
  assert.deepEqual(
    new Set(lifecycleLiterals),
    new Set(ValidationTaskStatusEnum.options),
    'task-lifecycle.ts LifecycleState and validation.ts TaskStatus have drifted apart — update BOTH manifests together',
  );
});

test('U45(c): task-lifecycle.ts LEGAL_TRANSITIONS has exactly one entry per canonical status (no orphan/missing state)', () => {
  const lifecycleSrc = read('src/lib/task-lifecycle.ts');
  const keys = extractLegalTransitionsKeys(lifecycleSrc);
  assert.deepEqual(
    new Set(keys),
    new Set(ValidationTaskStatusEnum.options),
    'LEGAL_TRANSITIONS key set has drifted from the canonical TaskStatus manifest',
  );
});

// ── (d) task-dispatcher.ts: no dead status-set 'archived' reference (DISP-12) ──

test('U45(d): task-dispatcher.ts has zero status-set \'archived\' references (comment-stripped)', () => {
  const raw = read('src/lib/task-dispatcher.ts');
  const stripped = stripComments(raw);
  assert.ok(
    !stripped.includes("'archived'"),
    "task-dispatcher.ts must not contain a live 'archived' status-set literal — archival exclusion is archived_at IS NULL only (DISP-12)",
  );
});

test('U45(d): task-dispatcher.ts filters archived tasks via archived_at IS NULL, not a status value', () => {
  const src = read('src/lib/task-dispatcher.ts');
  assert.match(src, /archived_at IS NULL/, 'the block WHERE-clause must filter archived tasks via archived_at IS NULL');
});
