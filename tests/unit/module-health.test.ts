/**
 * Unit tests for the Operator Console per-module vault-write health
 * (Feature 2 — src/lib/operator/module-health.ts).
 *
 * Runs via the Node built-in test runner under tsx (`npm run test:unit`).
 *
 * Strategy: force the Mac platform and isolate HOME to a throwaway temp dir so
 * `vaultRoot()` resolves to `<tmpHome>/clawd/`. We exercise ONLY the vault
 * dimension + status derivation here (recordVaultWrite / recordVaultWriteError /
 * resolveVaultHealth via getModuleHealth). The DB dimension is intentionally
 * not asserted green: with no SQLite file present, getModuleHealth degrades the
 * DB dimension honestly, so we assert the documented honesty contract instead
 * of a fabricated green.
 *
 * Covers:
 *   - recordVaultWrite(path) → later getModuleHealth reports live + the path.
 *   - recordVaultWrite(null) → recorded as a failed write (NOT false-green).
 *   - recordVaultWriteError() → recorded as an error state.
 *   - A module with no writes and no disk evidence is `unknown`, never `live`.
 *   - getModuleHealth + getAllModuleHealth never throw.
 */

// C8 — DB isolation MUST happen in an IMPORTED module, and this MUST stay the
// first import. Assigning process.env.DATABASE_PATH in this file's BODY does not
// work: ES `import` declarations are HOISTED, so any statically-imported project
// module that transitively reaches '@/lib/db' is evaluated FIRST — freezing
// `export const DB_PATH = process.env.DATABASE_PATH || <cwd>/mission-control.db`
// from the un-isolated env. This suite did exactly that and silently opened,
// migrated and wrote the LIVE mission-control.db. Proven by deleting the file and
// re-running this suite alone: it came back.
// Enforced by tests/unit/c8-db-isolation-guard.test.ts.
import './_isolated-db';

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Force Mac platform + isolated HOME BEFORE importing the module under test so
// vaultRoot() (read at call time) points at our throwaway tree.
const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_PLATFORM = process.env.OPENCLAW_PLATFORM;
const ISOLATED_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'bcc-mh-home-'));
process.env.HOME = ISOLATED_HOME;
process.env.OPENCLAW_PLATFORM = 'mac-mini';
// Keep the DB dimension off the repo's real mission-control.db: point it at a
// throwaway file under the isolated home so getModuleHealth's DB probe has a
// real (empty, migrated) database to count against without polluting cwd.
const ORIGINAL_DB = process.env.DATABASE_PATH;
process.env.DATABASE_PATH = path.join(ISOLATED_HOME, 'mh-test.db');
process.on('exit', () => {
  if (ORIGINAL_HOME === undefined) delete process.env.HOME;
  else process.env.HOME = ORIGINAL_HOME;
  if (ORIGINAL_PLATFORM === undefined) delete process.env.OPENCLAW_PLATFORM;
  else process.env.OPENCLAW_PLATFORM = ORIGINAL_PLATFORM;
  if (ORIGINAL_DB === undefined) delete process.env.DATABASE_PATH;
  else process.env.DATABASE_PATH = ORIGINAL_DB;
});

import {
  recordVaultWrite,
  recordVaultWriteError,
  getModuleHealth,
  getAllModuleHealth,
} from '../../src/lib/operator/module-health';

const VAULT = path.join(ISOLATED_HOME, 'clawd');

test('recordVaultWrite(path) makes the module report a live vault write', async () => {
  const written = path.join(VAULT, 'goals', 'work.md');
  await recordVaultWrite('goals', written);

  const health = await getModuleHealth('goals');
  assert.equal(health.module, 'goals');
  assert.equal(health.vault.ok, true);
  assert.equal(health.vault.lastWritePath, written);
  assert.equal(health.vault.source, 'recorded');
  // Vault confirmed → status is the green family regardless of DB presence.
  assert.equal(health.status, 'live');
  assert.match(health.message, /vault/i);
});

test('recordVaultWrite(null) is recorded as a failed write, never false-green', async () => {
  await recordVaultWrite('journal', null);

  const health = await getModuleHealth('journal');
  assert.equal(health.vault.ok, false);
  assert.equal(health.vault.source, 'error');
  // A mirror that produced no file must NOT show as green.
  assert.notEqual(health.status, 'live');
  assert.equal(health.status, 'offline');
});

test('recordVaultWriteError() surfaces an error vault state', async () => {
  await recordVaultWriteError('journal', new Error('disk full'));

  const health = await getModuleHealth('journal');
  assert.equal(health.vault.ok, false);
  assert.equal(health.vault.source, 'error');
  assert.match(String(health.vault.error), /disk full/);
  assert.equal(health.status, 'offline');
});

test('a module with no writes and no disk evidence is unknown (never green)', async () => {
  // Research has no recorded sidecar and (in this fresh temp vault) no files.
  const health = await getModuleHealth('research');
  assert.equal(health.vault.ok, null);
  assert.equal(health.vault.source, 'none');
  assert.notEqual(health.status, 'live');
  // Honest: unknown or busy (DB-saved) — but NOT a fabricated green.
  assert.ok(['unknown', 'busy', 'offline'].includes(health.status));
});

test('notebook reports vault as not-applicable (DB is the source of truth)', async () => {
  const health = await getModuleHealth('notebook');
  assert.equal(health.vault.notApplicable, true);
  assert.equal(health.vault.source, 'not_applicable');
  // Never crashes; status is one of the known states.
  assert.ok(['live', 'unknown', 'offline', 'busy'].includes(health.status));
});

test('getAllModuleHealth returns every module and never throws', async () => {
  const all = await getAllModuleHealth();
  const ids = all.map((m) => m.module).sort();
  assert.deepEqual(ids, ['goals', 'journal', 'notebook', 'research', 'studio']);
  for (const m of all) {
    assert.ok(typeof m.message === 'string' && m.message.length > 0);
    assert.ok(['live', 'working', 'busy', 'degraded', 'offline', 'unknown'].includes(m.status));
  }
});

test('discovers an existing vault file even with no recorded sidecar', async () => {
  // Write a research markdown file directly, no recordVaultWrite — the probe
  // should DISCOVER it on disk and report live with source=discovered.
  const dir = path.join(VAULT, 'research', '2026', '05');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '2026-05-30-test.md'), '# hi', 'utf8');

  const health = await getModuleHealth('research');
  assert.equal(health.vault.ok, true);
  assert.equal(health.vault.source, 'discovered');
  assert.equal(health.status, 'live');
});
