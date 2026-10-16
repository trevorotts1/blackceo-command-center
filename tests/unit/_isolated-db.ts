/**
 * _isolated-db.ts — give a test file its OWN throwaway DB.
 *
 * Import this FIRST (before any '@/lib/db' import) in a DB-backed test that
 * mutates shared tables (workspace dedup, task reaper). It points DATABASE_PATH
 * at a unique temp file so the test can seed/dedupe/delete freely WITHOUT
 * corrupting the shared mission-control.db other files use in a bulk
 * `npm run test:unit` run. Honours an explicit DATABASE_PATH set by the runner
 * (single-file invocations) and only overrides the unset / real-db default.
 */
import os from 'os';
import path from 'path';
import fs from 'node:fs';

// Paths THIS process created (never a runner/peer-provided one) — removed on exit.
const ccCreatedPaths: string[] = [];

if (!process.env.CC_TEST_FIXTURE_ROOT) {
  process.env.CC_TEST_FIXTURE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-company-fixture-'));
  ccCreatedPaths.push(process.env.CC_TEST_FIXTURE_ROOT);
}

const current = process.env.DATABASE_PATH ?? '';
if (!current || current.endsWith('mission-control.db')) {
  const unique = `cc-isolated-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
  process.env.DATABASE_PATH = path.join(os.tmpdir(), unique);
  ccCreatedPaths.push(process.env.DATABASE_PATH, `${process.env.DATABASE_PATH}-wal`, `${process.env.DATABASE_PATH}-shm`);
}

process.on('exit', () => {
  for (const ccPath of ccCreatedPaths) {
    try {
      fs.rmSync(ccPath, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup: must never mask the suite's own result.
    }
  }
});
