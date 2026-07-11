/**
 * demo-seed-sandbox-guard.test.ts
 *
 * REGRESSION GUARD for the C8 class ("test residue in client surfaces"), in its
 * most destructive form.
 *
 * scripts/demo/seed-demo.ts is a DESTRUCTIVE seeder: it DELETEs from 14 tables
 * (tasks, agents, workspaces, companies, messages, conversations, kpi_snapshots,
 * campaigns, dept_memory, ...) and then re-brands the `clients` 'self' row to the
 * fictional demo company.
 *
 * It previously resolved its target DB as:
 *     const dbPath = arg('db') || process.env.DATABASE_PATH;
 *
 * That `|| process.env.DATABASE_PATH` was FAIL-OPEN. On every client box
 * DATABASE_PATH points at the LIVE Command Center database (that is how
 * src/lib/db/index.ts locates it), so a bare
 *     npx tsx scripts/demo/seed-demo.ts --profile dashboard
 * run in any shell that had sourced the box's env would have wiped that real
 * client's Command Center and re-branded it to the demo company.
 *
 * These tests pin the two refusals that close that hole. They assert on the
 * PROCESS BOUNDARY (exit code + stderr) and, critically, that the would-be
 * victim database is left byte-for-byte untouched.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SEEDER = path.join(REPO_ROOT, 'scripts', 'demo', 'seed-demo.ts');

/** Run the seeder with the given argv/env; never let it run longer than 60s. */
function runSeeder(args: string[], env: NodeJS.ProcessEnv) {
  return spawnSync('npx', ['tsx', SEEDER, ...args], {
    cwd: REPO_ROOT,
    env: { ...process.env, ...env },
    encoding: 'utf-8',
    timeout: 60_000,
  });
}

/** A stand-in for a real client's live DB, with recognisable contents. */
function makeFakeLiveDb(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-live-db-'));
  const p = path.join(dir, 'mission-control.db');
  fs.writeFileSync(p, 'REAL-CLIENT-DATA-DO-NOT-TOUCH');
  return p;
}

test('C8: bare invocation with DATABASE_PATH set REFUSES (no --db) and does not touch the live DB', () => {
  const liveDb = makeFakeLiveDb();
  const before = fs.readFileSync(liveDb);

  // The exact historical footgun: no --db, but the box's env is loaded.
  const r = runSeeder(['--profile', 'dashboard'], { DATABASE_PATH: liveDb });

  assert.equal(r.status, 2, `expected refusal exit 2, got ${r.status}. stderr:\n${r.stderr}`);
  assert.match(r.stderr, /--db is REQUIRED/i);
  // The whole point: the live database must be untouched.
  assert.deepEqual(
    fs.readFileSync(liveDb),
    before,
    'FAIL-OPEN REGRESSION: the seeder touched the live DATABASE_PATH database',
  );
});

test('C8: an explicit --db pointing at the live DATABASE_PATH is REFUSED', () => {
  const liveDb = makeFakeLiveDb();
  const before = fs.readFileSync(liveDb);

  // Realistic accident: operator pastes the live path in by hand.
  const r = runSeeder(['--profile', 'dashboard', '--db', liveDb], { DATABASE_PATH: liveDb });

  assert.equal(r.status, 2, `expected refusal exit 2, got ${r.status}. stderr:\n${r.stderr}`);
  assert.match(r.stderr, /REFUSING to seed/i);
  assert.deepEqual(
    fs.readFileSync(liveDb),
    before,
    'FAIL-OPEN REGRESSION: the seeder touched the live database',
  );
});

test('C8: the seeder source carries NO DATABASE_PATH fallback for its target DB', () => {
  const src = fs.readFileSync(SEEDER, 'utf-8');
  // Pin the exact fail-open shape so it cannot silently return.
  assert.doesNotMatch(
    src,
    /const\s+dbPath\s*=\s*arg\(['"]db['"]\)\s*\|\|\s*process\.env\.DATABASE_PATH/,
    'FAIL-OPEN REGRESSION: `arg("db") || process.env.DATABASE_PATH` is back in seed-demo.ts',
  );
  assert.match(src, /const\s+dbPath\s*=\s*arg\(['"]db['"]\)\s*;/);
});
