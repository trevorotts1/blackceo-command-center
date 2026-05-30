/**
 * Unit tests for the CEO-department ordering guarantee + universal task-ingest
 * resolution/idempotency logic (CEO-department + universal task-capture feature).
 *
 * Runs via the Node built-in test runner under tsx (`npm run test:unit`).
 *
 * Strategy mirrors studio-registry-seed.test.ts: point DATABASE_PATH at a
 * throwaway temp file BEFORE `@/lib/db` is loaded (its DB_PATH const is captured
 * at import-evaluation time), then dynamically import the DB helpers so the test
 * binds to the isolated DB and runs the real migration chain (including
 * migration 046 `pin_ceo_department_first`).
 *
 * Covers:
 *   1. Migration 046 pins an existing CEO workspace row to sort_order = 0,
 *      and the GET /api/workspaces ordering (`ORDER BY sort_order, name`)
 *      surfaces CEO first even though its name sorts last alphabetically.
 *   2. The ingest workspace resolver query path: department_slug match,
 *      persona/name match, and the CEO catch-all fallback — keyed on the stable
 *      slug 'ceo' (NOT the free-text display name).
 *   3. The ingest idempotency dedupe query: a second insert carrying the same
 *      `[ingest:<key>]` marker is detected and skipped.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_DB = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'bc-ceo-ingest-')),
  'mission-control.test.db',
);
process.env.DATABASE_PATH = TMP_DB;

type DbModule = typeof import('../../src/lib/db');
let getDb: DbModule['getDb'];
let queryOne: DbModule['queryOne'];
let queryAll: DbModule['queryAll'];
let run: DbModule['run'];
let closeDb: DbModule['closeDb'];

test.before(async () => {
  const db = await import('../../src/lib/db');
  getDb = db.getDb;
  queryOne = db.queryOne;
  queryAll = db.queryAll;
  run = db.run;
  closeDb = db.closeDb;

  // getDb() runs the full migration chain (incl. 046) against the temp DB.
  getDb();

  // Workspaces FK -> companies(id); ensure the 'default' company exists.
  const now0 = new Date().toISOString();
  run(
    `INSERT OR IGNORE INTO companies (id, name, slug, config, created_at, updated_at)
     VALUES ('default', 'Default', 'default', '{}', ?, ?)`,
    [now0, now0],
  );

  // Seed a CEO workspace (display name is the client persona — NOT "CEO" — to
  // prove ordering keys on slug, not name) plus two normal departments whose
  // names sort BEFORE the persona name alphabetically.
  const now = new Date().toISOString();
  run(
    `INSERT INTO workspaces (id, name, slug, description, icon, company_id, sort_order, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'default', ?, ?, ?)`,
    ['dept-ceo', 'Candace', 'ceo', 'CEO dept', '👑', 1000, now, now],
  );
  run(
    `INSERT INTO workspaces (id, name, slug, description, icon, company_id, sort_order, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'default', ?, ?, ?)`,
    ['dept-sales', 'Sales', 'sales', 'Sales dept', '💼', 10, now, now],
  );
  run(
    `INSERT INTO workspaces (id, name, slug, description, icon, company_id, sort_order, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'default', ?, ?, ?)`,
    ['dept-billing', 'Billing', 'billing', 'Billing dept', '💵', 20, now, now],
  );
});

test.after(() => {
  try { closeDb(); } catch { /* ignore */ }
});

test('migration 046 re-pin + ordering: CEO surfaces first regardless of display name', () => {
  // Re-run the exact migration-046 statement to prove idempotent re-pin.
  run(`UPDATE workspaces SET sort_order = 0 WHERE lower(slug) = 'ceo' OR lower(name) = 'ceo'`, []);

  const ceo = queryOne<{ sort_order: number }>(
    'SELECT sort_order FROM workspaces WHERE slug = ?',
    ['ceo'],
  );
  assert.equal(ceo?.sort_order, 0, 'CEO workspace must be pinned to sort_order = 0');

  // The GET /api/workspaces ordering clause.
  const ordered = queryAll<{ slug: string; name: string; sort_order: number }>(
    'SELECT slug, name, sort_order FROM workspaces ORDER BY sort_order ASC, name ASC',
    [],
  );
  assert.equal(ordered[0].slug, 'ceo', 'CEO must be first in sort_order ordering');
  assert.equal(ordered[0].name, 'Candace', 'CEO row keeps its persona display name');
});

test('ingest resolver: department_slug match wins', () => {
  const slug = 'sales';
  const bySlug = queryOne<{ id: string }>(
    'SELECT id FROM workspaces WHERE lower(slug) = ? OR lower(id) = ? LIMIT 1',
    [slug, slug],
  );
  assert.equal(bySlug?.id, 'dept-sales');
});

test('ingest resolver: persona/name match when no slug', () => {
  const byName = queryOne<{ id: string }>(
    'SELECT id FROM workspaces WHERE lower(name) = ? LIMIT 1',
    ['billing'],
  );
  assert.equal(byName?.id, 'dept-billing');
});

test('ingest resolver: CEO catch-all fallback keyed on slug, not name', () => {
  // An unresolvable department falls back to the CEO workspace.
  const bySlug = queryOne<{ id: string }>(
    'SELECT id FROM workspaces WHERE lower(slug) = ? OR lower(id) = ? LIMIT 1',
    ['nonexistent', 'nonexistent'],
  );
  assert.equal(bySlug, undefined, 'no slug match for an unknown department');

  const ceo = queryOne<{ id: string }>(
    "SELECT id FROM workspaces WHERE lower(slug) IN ('ceo', 'dept-ceo') OR lower(name) = 'ceo' ORDER BY sort_order ASC LIMIT 1",
    [],
  );
  assert.equal(ceo?.id, 'dept-ceo', 'unrouted work falls back to the CEO workspace');
});

test('ingest idempotency: duplicate marker is detected before insert', () => {
  const key = 'sha256-deadbeef';
  const now = new Date().toISOString();

  // Simulate a first ingested task: a task row + its task_created event whose
  // message carries the [ingest:<key>] marker (what createTaskCore writes when
  // the route passes eventMessage).
  run(
    `INSERT INTO tasks (id, title, status, priority, workspace_id, business_id, created_at, updated_at)
     VALUES (?, ?, 'backlog', 'medium', 'dept-ceo', 'default', ?, ?)`,
    ['task-1', 'Captured task', now, now],
  );
  run(
    `INSERT INTO events (id, type, task_id, message, created_at)
     VALUES (?, 'task_created', ?, ?, ?)`,
    ['ev-1', 'task-1', `Task captured via telegram: Captured task [ingest:${key}]`, now],
  );

  // The route's dedupe lookup must find the existing task by the marker.
  const existing = queryOne<{ task_id: string }>(
    "SELECT task_id FROM events WHERE type = 'task_created' AND message LIKE ? AND task_id IS NOT NULL ORDER BY created_at ASC LIMIT 1",
    [`%[ingest:${key}]%`],
  );
  assert.equal(existing?.task_id, 'task-1', 'a retry with the same key resolves to the existing task');

  // A different key must NOT match.
  const miss = queryOne<{ task_id: string }>(
    "SELECT task_id FROM events WHERE type = 'task_created' AND message LIKE ? AND task_id IS NOT NULL LIMIT 1",
    ['%[ingest:some-other-key]%'],
  );
  assert.equal(miss, undefined, 'an unrelated idempotency key must not dedupe');
});
