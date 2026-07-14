/**
 * Unit tests — backfill-sop-embeddings.ts shipped-asset refusal guard (P4-03 step 3)
 *
 * Proves scripts/backfill-sop-embeddings.ts REFUSES a full `--force` re-embed
 * when the box carries the `sop_embeddings_shipped_asset` marker table
 * (written by shared-utils/sop-embed-once/provision_sop_embeddings.py in the
 * onboarding repo on import) — mirroring
 * embedding_engine.py::_refuse_full_rebuild_if_prebuilt. A normal (delta-only)
 * run and the operator-only `--force-full-rebuild-shipped` override are both
 * still permitted.
 *
 * Spawns the REAL script as a child process against a throwaway sqlite DB
 * (no network — the guard fires and process.exit()s BEFORE any embedding
 * provider is resolved, so no API key is needed to prove the refusal).
 *
 * Run: node --import tsx --test tests/unit/backfill-sop-embeddings-shipped-guard.test.ts
 */

// C8 — DB isolation MUST happen in an IMPORTED module, and this MUST stay the
// first import. This suite drives the app's own getDb() (in a child process, via
// setup.mjs) to build its fixture DB; pointing DATABASE_PATH at a throwaway temp
// file up front guarantees nothing in this file's process ever opens or migrates
// the LIVE mission-control.db. The child processes are always handed an explicit
// per-fixture DATABASE_PATH, which takes precedence over this default.
// Enforced by tests/unit/c8-db-isolation-guard.test.ts.
import './_isolated-db';

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SCRIPT = path.join(REPO_ROOT, 'scripts', 'backfill-sop-embeddings.ts');

/**
 * Initialize a FRESH db file with the app's own full migration chain (the
 * real src/lib/db/migrations.ts, run in-process via the app's getDb()) rather
 * than a hand-rolled partial schema — later migrations assume columns only
 * earlier migrations add, so a hand-rolled `sops`/`sop_embeddings` table pair
 * breaks migration 091+ (proven the hard way while writing this test: a
 * partial schema throws "no such column: updated_at" inside
 * rekeyAndPurgeGhostSops during migration 091 before the guard is ever
 * reached).
 */
function initSchemaViaRealMigrations(dbPath: string): void {
  const setupFile = path.join(path.dirname(dbPath), 'setup.mjs');
  writeFileSync(
    setupFile,
    `import('${path.join(REPO_ROOT, 'src', 'lib', 'db', 'index.ts')}').then(m => { m.getDb(); process.exit(0); }).catch(e => { console.error(e); process.exit(1); });\n`
  );
  const result = spawnSync('npx', ['tsx', setupFile], {
    cwd: REPO_ROOT,
    env: { ...process.env, DATABASE_PATH: dbPath },
    encoding: 'utf-8',
    timeout: 30_000,
  });
  if (result.status !== 0) {
    throw new Error(`fixture DB migration setup failed: ${result.stderr}\n${result.stdout}`);
  }
}

function makeFixtureDb(withShippedMarker: boolean): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'backfill-guard-'));
  const dbPath = path.join(dir, 'mission-control.db');
  initSchemaViaRealMigrations(dbPath);
  const db = new Database(dbPath);
  if (withShippedMarker) {
    db.exec(`
      CREATE TABLE sop_embeddings_shipped_asset (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        release_tag TEXT NOT NULL,
        sop_count INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        imported_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    db.prepare(
      `INSERT INTO sop_embeddings_shipped_asset (id, release_tag, sop_count, sha256, imported_at)
       VALUES (1, 'sop-embeddings-v1.0.0', 2578, 'deadbeef', datetime('now'))`
    ).run();
  }
  db.close();
  return dbPath;
}

function runScript(dbPath: string, args: string[]): { status: number | null; stderr: string; stdout: string } {
  const result = spawnSync('npx', ['tsx', SCRIPT, ...args], {
    cwd: REPO_ROOT,
    env: { ...process.env, DATABASE_PATH: dbPath },
    encoding: 'utf-8',
    timeout: 20_000,
  });
  return { status: result.status, stderr: result.stderr || '', stdout: result.stdout || '' };
}

test('backfill-sop-embeddings --force is REFUSED when the shipped-asset marker is present', () => {
  const dbPath = makeFixtureDb(true);
  try {
    const { status, stderr } = runScript(dbPath, ['--force']);
    assert.equal(status, 3, `expected exit code 3 (refused), got ${status}. stderr:\n${stderr}`);
    assert.match(stderr, /REFUSED/);
    assert.match(stderr, /sop-embeddings-v1\.0\.0/);
    assert.match(stderr, /--force-full-rebuild-shipped/);
  } finally {
    rmSync(path.dirname(dbPath), { recursive: true, force: true });
  }
});

test('backfill-sop-embeddings --force --force-full-rebuild-shipped is NOT refused by the guard (operator override)', () => {
  const dbPath = makeFixtureDb(true);
  try {
    const { status, stderr } = runScript(dbPath, ['--force', '--force-full-rebuild-shipped', '--dry-run']);
    // The guard itself must not fire (no exit code 3 / no "REFUSED"). The
    // script then proceeds to the provider-resolution step, which legitimately
    // exits 1 in this test env (no real API key) — that is a DIFFERENT, later
    // failure than the guard this test targets.
    assert.notEqual(status, 3, `guard must NOT fire with the override flag. stderr:\n${stderr}`);
    assert.doesNotMatch(stderr, /REFUSED/);
  } finally {
    rmSync(path.dirname(dbPath), { recursive: true, force: true });
  }
});

test('backfill-sop-embeddings --force is NOT refused when no shipped-asset marker exists (fresh box)', () => {
  const dbPath = makeFixtureDb(false);
  try {
    const { status, stderr } = runScript(dbPath, ['--force', '--dry-run']);
    assert.notEqual(status, 3, `guard must not fire on a box with no shipped asset ever imported. stderr:\n${stderr}`);
    assert.doesNotMatch(stderr, /REFUSED/);
  } finally {
    rmSync(path.dirname(dbPath), { recursive: true, force: true });
  }
});

test('backfill-sop-embeddings default (non-force) run is NEVER refused by the guard, even with the marker present', () => {
  const dbPath = makeFixtureDb(true);
  try {
    // No --force at all — the guard function is only invoked when forceReEmbed
    // is true, so a normal delta-only run must never hit exit code 3 from this
    // guard (it may still exit non-zero later for other reasons, e.g. no API
    // key in this test env — we only assert the GUARD didn't fire).
    const { stderr } = runScript(dbPath, ['--dry-run']);
    assert.doesNotMatch(stderr, /REFUSED/);
  } finally {
    rmSync(path.dirname(dbPath), { recursive: true, force: true });
  }
});
