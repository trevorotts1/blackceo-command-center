/**
 * FIX 34 (spec REV 3, Phase D data lane) — autodeploy DB backup must be a REAL
 * backup. Spec PROOF: "next backup is ~135MB and restores to a working DB."
 *
 * Two properties under test, both driven against the REAL
 * scripts/atomic-deploy.sh source (never a copy — the extractor below reads
 * the actual file the deploy runs):
 *
 *   1. WAL-aware backup: the deploy checkpoints the WAL (PRAGMA
 *      wal_checkpoint(TRUNCATE)) before copying the LIVEDB, so the `cp`
 *      snapshot cannot lag committed pages.
 *   2. FIX 34b restore-verification: the backup file ITSELF is read back
 *      (SQLite magic header + PRAGMA integrity_check) BEFORE the deploy
 *      proceeds; a poison backup aborts the deploy with the FIX 34b abort
 *      receipt and is kept on disk for forensics.
 *
 * The python verifier body is extracted verbatim from the deploy script and
 * executed (as the deploy does) against four fixture backups: a good backup,
 * a corrupted image, a 0-byte decoy, and a header-less garbage file. The
 * zero-byte false-pass trap is the reason the magic-header check exists:
 * integrity_check on an empty file returns "ok" without any tables.
 *
 * NO destructive action: the deploy script is never EXECUTED here — only
 * parsed, and the verifier run against throwaway fixture files in a temp dir.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';

const DEPLOY = path.join(process.cwd(), 'scripts', 'atomic-deploy.sh');
const deploySource = readFileSync(DEPLOY, 'utf8');

/** Extract the python verifier body between <<'PYRESTORE' and PYRESTORE. */
function extractVerifier(): string {
  const open = deploySource.indexOf("<<'PYRESTORE'");
  expect(open).toBeGreaterThan(0); // FIX 34b block must exist
  const bodyStart = deploySource.indexOf('\n', open) + 1;
  const end = deploySource.indexOf('\nPYRESTORE\n', bodyStart);
  expect(end).toBeGreaterThan(bodyStart);
  return deploySource.slice(bodyStart, end + 1); // include trailing newline
}

let fixtureDir: string;
let verifierPath: string;

/** Run the extracted verifier exactly as atomic-deploy.sh does. */
function runVerifier(file: string): number {
  try {
    execFileSync('python3', [verifierPath, file], { encoding: 'utf8', timeout: 30_000 });
    return 0;
  } catch (err: unknown) {
    const e = err as { status?: number };
    return e.status ?? 1;
  }
}

function makeGoodBackup(name: string): string {
  const db = path.join(fixtureDir, name);
  // Build via sqlite3 CLI? Not guaranteed present — use python3 stdlib.
  execFileSync('python3', ['-c', [
    'import sqlite3, sys',
    `con = sqlite3.connect(${JSON.stringify(db)})`,
    'con.execute("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)")',
    'con.executemany("INSERT INTO t (v) VALUES (?)", [("x%d" % i,) for i in range(500)])',
    'con.commit()',
    'con.execute("PRAGMA wal_checkpoint(TRUNCATE)")',
    'con.close()',
  ].join('; ')]);
  return db;
}

beforeAll(() => {
  fixtureDir = mkdtempSync(path.join(os.tmpdir(), 'fix34-test-'));
  verifierPath = path.join(fixtureDir, 'pyrestore-extracted.py');
  writeFileSync(verifierPath, extractVerifier());
});

afterAll(() => {
  try { rmSync(fixtureDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('FIX 34 — atomic-deploy DB backup is WAL-aware and restore-verified', () => {
  it('deploy script checkpoints the WAL before copying the DB (backup cannot lag committed pages)', () => {
    expect(deploySource).toContain('PRAGMA wal_checkpoint(TRUNCATE)');
    // The copy happens only after the checkpoint block.
    const cpIdx = deploySource.indexOf('cp "$DB_FILE" "$DB_BACKUP"');
    const chkIdx = deploySource.indexOf('PRAGMA wal_checkpoint(TRUNCATE)');
    expect(chkIdx).toBeGreaterThan(-1);
    expect(cpIdx).toBeGreaterThan(chkIdx);
  });

  it('FIX 34b verifier aborts the deploy (exit 2) with the FIX 34b abort receipt on a bad backup', () => {
    // The bash side: verifier rc != 0 ⇒ abort receipt naming FIX 34b, exit 2,
    // backup KEPT on disk for forensics.
    expect(deploySource).toContain('DB_BACKUP_VERIFY_RC=0');
    expect(deploySource).toContain('|| DB_BACKUP_VERIFY_RC=$?'); // heredoc rc captured, never lost
    expect(deploySource).toContain('_preflight_abort_receipt "FIX 34b: DB backup at ${DB_BACKUP} FAILED restore-verification');
    const receiptIdx = deploySource.indexOf('_preflight_abort_receipt "FIX 34b:');
    const exitIdx = deploySource.indexOf('exit 2', receiptIdx);
    expect(exitIdx).toBeGreaterThan(receiptIdx);
    expect(exitIdx - receiptIdx).toBeLessThan(300); // the abort exits, nothing runs between
    expect(deploySource).not.toContain('rm -f "$DB_BACKUP"\n    exit 2\n  fi\n  # RETENTION'); // backup kept
  });

  it('verifier PASSES (rc 0) on a good backup: magic header + integrity_check ok', () => {
    const good = makeGoodBackup('good.db');
    expect(statSync(good).size).toBeGreaterThan(0);
    expect(runVerifier(good)).toBe(0);
  });

  it('verifier REFUSES (rc 9) a corrupted image — pages unreadable, not a rollback source', () => {
    const corrupt = makeGoodBackup('corrupt.db');
    // Corrupt pages deep in the file, past the header: sqlite still reads the
    // header fine but integrity_check / page reads blow up.
    const buf = readFileSync(corrupt);
    buf[buf.length - 200] = 0xde;
    buf[buf.length - 199] = 0xad;
    writeFileSync(corrupt, buf);
    expect(runVerifier(corrupt)).not.toBe(0);
  });

  it('verifier REFUSES (rc 9) a 0-byte backup — the decoy that silently passes as "backed up"', () => {
    const zero = path.join(fixtureDir, 'zero.db');
    writeFileSync(zero, Buffer.alloc(0));
    expect(statSync(zero).size).toBe(0);
    expect(runVerifier(zero)).not.toBe(0);
  });

  it('verifier REFUSES (rc 9) a header-less garbage file (no SQLite magic header)', () => {
    const garbage = path.join(fixtureDir, 'garbage.db');
    writeFileSync(garbage, Buffer.alloc(4096, 0x5a));
    expect(runVerifier(garbage)).not.toBe(0);
  });
});