/**
 * c8-db-hard-fail-guard.test.ts
 *
 * REGRESSION GUARD for the C8 fix in src/lib/db/index.ts + src/instrumentation.ts.
 *
 * The old `DB_PATH = process.env.DATABASE_PATH || path.join(process.cwd(), 'mission-control.db')`
 * SILENTLY fell back to the live database for any process — a bare test run, a
 * maintenance one-liner, `npx tsx some-script.ts` from the app directory —
 * that reached src/lib/db without DATABASE_PATH set. That is exactly how test
 * fixtures leaked into a production Kanban board (see
 * tests/unit/c8-db-isolation-guard.test.ts for the full story).
 *
 * The fix adds a THIRD resolution branch: a real Next.js server process is
 * identified by an in-process marker (`globalThis.__CC_SERVER_ENTRYPOINT__`)
 * set as the first statement of src/instrumentation.ts's boot hook — NOT by
 * an env var a hand-edited ecosystem/pm2 file would have to carry. Anything
 * else that reaches the module without DATABASE_PATH now hard-fails instead
 * of silently opening the live file.
 *
 * These tests prove BOTH halves of that contract by spawning REAL child
 * processes (so each gets its own frozen module-eval state for the
 * `DB_PATH` constant, exactly like the real server boot / a real bare
 * script invocation) rather than re-importing the module in-process:
 *
 *   (a) the marker-bearing fixture resolves to the same default the server
 *       has always used, and actually opens/writes/reads the database — the
 *       server's own boot path is unaffected by this change.
 *   (b) the marker-less, DATABASE_PATH-less fixture — the same shape as the
 *       historical offending scripts — exits non-zero with a clear,
 *       actionable error naming DATABASE_PATH, and creates NO database file
 *       at all (proving it never got as far as opening one).
 *
 * Both fixtures run with `cwd` pointed at a fresh empty temp directory, so
 * even the "successful" server-path run never comes near a real
 * mission-control.db — this test cannot touch live data either way.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SERVER_FIXTURE = path.join(REPO_ROOT, 'tests', 'fixtures', 'c8-hard-fail', 'server-entrypoint-sim.ts');
const SCRIPT_FIXTURE = path.join(REPO_ROOT, 'tests', 'fixtures', 'c8-hard-fail', 'plain-script-sim.ts');

/**
 * A fresh, empty cwd — so a "default path" resolution never lands near a real
 * db. Resolved through fs.realpathSync: on macOS os.tmpdir() returns a
 * `/var/...` path but the CHILD process's own `process.cwd()` reports the
 * symlink-resolved `/private/var/...` form, so comparing an unresolved
 * parent-side path against the child's self-reported cwd would spuriously
 * mismatch even though both refer to the same directory.
 */
function freshCwd(): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cc-c8-hardfail-')));
}

/** Run a fixture with an ENV THAT DOES NOT CARRY DATABASE_PATH, regardless of the parent's. */
function runFixture(fixture: string, cwd: string) {
  const { DATABASE_PATH: _drop, ...envWithoutDbPath } = process.env;
  // `cwd` is a throwaway temp dir (so the "default path" branch never lands
  // near this repo's own files) but the fixture still needs the REPO's
  // tsconfig so tsx can resolve the project's `@/...` path aliases — hence
  // `--tsconfig` pointed explicitly at the repo, independent of `cwd`.
  return spawnSync('npx', ['tsx', '--tsconfig', path.join(REPO_ROOT, 'tsconfig.json'), fixture], {
    cwd,
    env: envWithoutDbPath,
    encoding: 'utf-8',
    timeout: 60_000,
  });
}

test('C8 hard-fail guard — server marker present: resolution opens the live-shaped default DB (server unaffected)', () => {
  const cwd = freshCwd();
  const expectedPath = path.join(cwd, 'mission-control.db');

  const r = runFixture(SERVER_FIXTURE, cwd);

  assert.equal(r.status, 0, `expected the server-marker fixture to succeed. stderr:\n${r.stderr}\nstdout:\n${r.stdout}`);
  assert.match(
    r.stdout,
    new RegExp(`DB_PATH=${expectedPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
    'server marker must resolve DB_PATH to the SAME default (cwd/mission-control.db) the server has always used — no box-local config required',
  );
  assert.match(
    r.stdout,
    /PROBE_ROW=server-path-ok/,
    'server marker must actually be able to open, write to, and read from the resolved database — not just compute a path string',
  );
  assert.ok(
    fs.existsSync(expectedPath),
    'the server-marker fixture must have created a real database file at the resolved default path',
  );
});

test('C8 hard-fail guard — no marker, no DATABASE_PATH: HARD-FAILS with an actionable error naming DATABASE_PATH', () => {
  const cwd = freshCwd();
  const wouldBeLivePath = path.join(cwd, 'mission-control.db');

  const r = runFixture(SCRIPT_FIXTURE, cwd);

  assert.notEqual(r.status, 0, `expected the un-isolated script fixture to fail. stdout:\n${r.stdout}`);
  assert.doesNotMatch(
    r.stdout,
    /UNEXPECTED SUCCESS/,
    'the script fixture must NEVER reach its own console.log — the guard must throw at module-evaluation time',
  );
  assert.match(
    r.stderr,
    /DATABASE_PATH/,
    'the failure must name DATABASE_PATH so the actionable remedy is obvious from the error alone',
  );
  assert.match(
    r.stderr,
    /C8 GUARD/,
    'the failure must be traceable to this specific guard, not a generic/opaque crash',
  );
  assert.ok(
    !fs.existsSync(wouldBeLivePath),
    'REGRESSION: the un-isolated script created a database file — it must hard-fail BEFORE ever opening one',
  );
});
