// FIX 34/35 (Phase D data lane) — presentation-db-hygiene.py proof suite.
//
// Local fixtures only: every DB here is a throwaway SQLite file in a temp dir.
// The real LIVEDB is never touched. The destructive purge is exercised against
// fixtures ONLY, always behind the PRESENTATION_CONFIRM_DESTRUCTIVE gate.
//
// Run: npx vitest run --config vitest.fix20.config.ts   (from the CC repo root)
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

const SCRIPT = path.resolve(__dirname, '../../scripts/presentation-db-hygiene.py');

let tmpDir: string;
let dbPath: string;
let outDir: string;

const CONFIRM_ENV = 'PRESENTATION_CONFIRM_DESTRUCTIVE';
const CONFIRM_VALUE = 'PURGE-SYNTHETIC-DONE-ROWS';

function runScript(args: string[], extraEnv: Record<string, string> = {}) {
  return spawnSync('python3', [SCRIPT, '--db', dbPath, '--out-dir', outDir, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...extraEnv },
  });
}

function makeDb(): void {
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      title TEXT,
      status TEXT NOT NULL DEFAULT 'backlog',
      completed_at TEXT,
      archived_at TEXT,
      updated_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE task_events (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      from_status TEXT NOT NULL,
      to_status TEXT NOT NULL,
      actor TEXT,
      reason TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    INSERT INTO tasks (id, title, status) VALUES
      ('syn-1', 'ZZZ-SYNTHETIC-TEST 1', 'done'),
      ('syn-2', 'ZZZ-SYNTHETIC-TEST 2', 'done'),
      ('syn-3', 'ZZZ-SYNTHETIC-TEST 3', 'done'),
      ('real-1', 'Real deck task (no audit)', 'done'),
      ('aborted-1', 'Aborted run leftover (no audit)', 'done'),
      ('real-2', 'Real deck task (has audit)', 'done'),
      ('active-1', 'Still on the board', 'in_progress');
    UPDATE tasks SET completed_at = '2026-08-30T10:00:00Z' WHERE id IN ('real-1', 'real-2');
    INSERT INTO task_events (id, task_id, from_status, to_status, actor, reason, created_at)
      VALUES ('ev-seed', 'real-2', 'review', 'done', 'agent:test', 'seeded', '2026-08-30T10:00:00Z');
  `);
  db.close();
}

function openDb() {
  return new Database(dbPath);
}

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fix20-hygiene-'));
  dbPath = path.join(tmpDir, 'mission-control.db');
  outDir = path.join(tmpDir, 'backups');
  makeDb();
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('FIX 34 — backup + verify-restore', () => {
  it('backup produces a NON-ZERO file, integrity-ok receipt, and a sidecar receipt', () => {
    const r = runScript(['backup']);
    expect(r.status).toBe(0);
    const files = fs.readdirSync(outDir)
      .filter((f) => f.includes('.presentation-fix34.') && !f.endsWith('.receipt.json'))
      .sort();
    expect(files.length).toBe(1);
    const backupPath = path.join(outDir, files[0]);
    const size = fs.statSync(backupPath).size;
    expect(size).toBeGreaterThan(0); // FIX 34 core proof: never a 0-byte decoy backup
    const receiptPath = backupPath + '.receipt.json';
    expect(fs.existsSync(receiptPath)).toBe(true);
    const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
    expect(receipt.integrity_check).toBe('ok');
    expect(receipt.backup_size_bytes).toBe(size);
    expect(receipt.backup_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(receipt.row_counts_backup.tasks).toBe(7);
    expect(receipt.row_counts_source.tasks).toBe(7);
    expect(receipt.schema_user_version).toBe(0);
  });

  it('verify-restore restores into a NEW file (never over the source) and it works', () => {
    const files = fs.readdirSync(outDir).filter((f) => f.includes('.presentation-fix34.'));
    const backupPath = path.join(outDir, files[0]);
    const r = runScript(['verify-restore', '--backup', backupPath]);
    expect(r.status).toBe(0);
    const restoredPath = backupPath + '.restored';
    expect(fs.existsSync(restoredPath)).toBe(true);
    expect(restoredPath).not.toBe(dbPath);
    const receipt = JSON.parse(fs.readFileSync(restoredPath + '.restore-receipt.json', 'utf8'));
    expect(receipt.integrity_check).toBe('ok');
    expect(receipt.row_counts_match_original_backup).toBe(true);
    // restored DB actually opens and queries
    const db = new Database(restoredPath, { readonly: true });
    const n = db.prepare('SELECT COUNT(*) AS n FROM tasks').get() as { n: number };
    db.close();
    expect(n.n).toBe(7);
    // source untouched (still has live synthetic rows)
    const src = openDb();
    const live = src.prepare("SELECT COUNT(*) AS n FROM tasks WHERE title LIKE '%ZZZ-SYNTHETIC%' AND archived_at IS NULL").get() as { n: number };
    src.close();
    expect(live.n).toBe(3);
  });

  it('verify-restore REFUSES an existing target (a restore never overwrites)', () => {
    const files = fs.readdirSync(outDir).filter((f) => f.includes('.presentation-fix34.'));
    const backupPath = path.join(outDir, files[0]);
    const occupied = path.join(tmpDir, 'occupied.db');
    fs.writeFileSync(occupied, 'x');
    const r = runScript(['verify-restore', '--backup', backupPath, '--target', occupied]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('NEVER overwrites');
  });

  it('refuses a 0-byte decoy DB everywhere (the FIX 34 decoy lesson)', () => {
    const decoy = path.join(tmpDir, 'decoy.db');
    fs.writeFileSync(decoy, '');
    const r = runScript(['backup'], {});
    expect(r.status).not.toBe(0);
    const r2 = spawnSync('python3', [SCRIPT, '--db', decoy, '--out-dir', outDir, 'backup'], {
      encoding: 'utf8',
    });
    expect(r2.status).toBe(2);
    expect(r2.stderr).toContain('0-byte');
  });
});

describe('FIX 35 — board-check / purge gate / purge / rollback', () => {
  it('board-check is read-only proof: finds synthetic rows + the audit gap', () => {
    const before = fs.statSync(dbPath).mtimeMs;
    const r = runScript(['board-check']);
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.synthetic_live).toEqual(['syn-1', 'syn-2', 'syn-3']);
    expect(out.done_missing_todone_audit).toEqual(['real-1', 'aborted-1']);
    expect(out.provenance_real_completed_run).toEqual(['real-1']);
    expect(out.provenance_synthetic_or_aborted).toEqual(['aborted-1']);
    expect(fs.statSync(dbPath).mtimeMs).toBe(before); // read-only: DB untouched
  });

  it('purge without --apply is a dry-run: plans, writes NOTHING', () => {
    const r = runScript(['purge']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('DRY-RUN');
    expect(r.stdout).toContain('[dry-run] no writes performed.');
    const db = openDb();
    const live = db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE title LIKE '%ZZZ-SYNTHETIC%' AND archived_at IS NULL").get() as { n: number };
    const events = db.prepare("SELECT COUNT(*) AS n FROM task_events WHERE actor='cc:fix35-hygiene-backfill'").get() as { n: number };
    db.close();
    expect(live.n).toBe(3);
    expect(events.n).toBe(0);
  });

  it('purge --apply WITHOUT the confirmation env var is REFUSED (fail-closed, exit 3)', () => {
    const r = runScript(['purge', '--apply']);
    expect(r.status).toBe(3);
    expect(r.stderr).toContain('REFUSED');
    const db = openDb();
    const live = db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE title LIKE '%ZZZ-SYNTHETIC%' AND archived_at IS NULL").get() as { n: number };
    db.close();
    expect(live.n).toBe(3); // nothing happened
  });

  it('purge --apply with a WRONG confirmation value is REFUSED', () => {
    const r = runScript(['purge', '--apply'], { [CONFIRM_ENV]: 'yes' });
    expect(r.status).toBe(3);
    expect(r.stderr).toContain('a different value');
  });

  it('purge --apply WITH the literal confirmation: soft-archive + backfill, NO DELETE', () => {
    const r = runScript(['purge', '--apply'], { [CONFIRM_ENV]: CONFIRM_VALUE });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('BACKUP FIRST');
    const db = openDb();
    // synthetic rows are OFF the board (archived), not deleted
    const live = db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE title LIKE '%ZZZ-SYNTHETIC%' AND archived_at IS NULL").get() as { n: number };
    const deleted = db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE title LIKE '%ZZZ-SYNTHETIC%'").get() as { n: number };
    expect(live.n).toBe(0);
    expect(deleted.n).toBe(3); // titled synthetic rows all still exist, soft-archived
    // aborted-1 (synthetic/aborted CLASS: done, no completed_at, no audit) is
    // also soft-archived and still exists — never a DELETE
    const aborted = db.prepare("SELECT archived_at, status FROM tasks WHERE id='aborted-1'").get() as { archived_at: string | null; status: string };
    expect(aborted.status).toBe('done');
    expect(aborted.archived_at).not.toBeNull();
    // to-done audit backfilled for the REAL row only; idempotent for real-2
    const backfill = db.prepare("SELECT task_id, to_status, actor FROM task_events WHERE actor='cc:fix35-hygiene-backfill'").all() as Array<{ task_id: string; to_status: string; actor: string }>;
    expect(backfill.map((e) => e.task_id).sort()).toEqual(['real-1']);
    expect(backfill[0].to_status).toBe('done');
    // active non-done row untouched
    const active = db.prepare("SELECT archived_at FROM tasks WHERE id='active-1'").get() as { archived_at: string | null };
    expect(active.archived_at).toBeNull();
    db.close();
    // receipt exists and lists the archived ids
    const receipts = fs.readdirSync(outDir).filter((f) => f.startsWith('fix35-purge-receipt.'));
    expect(receipts.length).toBe(1);
    const rec = JSON.parse(fs.readFileSync(path.join(outDir, receipts[0]), 'utf8'));
    expect(rec.archived_ids.sort()).toEqual(['aborted-1', 'syn-1', 'syn-2', 'syn-3']);
    expect(rec.archived_ids.length).toBe(4);
    expect(rec.backfilled_todone_ids).toEqual(['real-1']);
    expect(rec.deletes).toBe(0);
    // pre-purge backup exists and is non-zero (backup-first is structural)
    expect(fs.statSync(rec.backup).size).toBeGreaterThan(0);
  });

  it('rollback (gated) un-archives exactly the receipt rows', () => {
    const receipts = fs.readdirSync(outDir).filter((f) => f.startsWith('fix35-purge-receipt.'));
    const receiptPath = path.join(outDir, receipts[0]);
    const refused = runScript(['purge', '--rollback', '--receipt', receiptPath]);
    expect(refused.status).toBe(3); // rollback is itself gated
    const r = runScript(['purge', '--rollback', '--receipt', receiptPath], { [CONFIRM_ENV]: CONFIRM_VALUE });
    expect(r.status).toBe(0);
    const db = openDb();
    const liveAgain = db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE archived_at IS NULL AND status='done'").get() as { n: number };
    db.close();
    expect(liveAgain.n).toBe(6); // 3 synthetic + aborted-1 un-archived, + real-1/real-2 never archived
  });

  it('is idempotent: a re-run of the gated purge re-archives cleanly (no dup events)', () => {
    const receipts = fs.readdirSync(outDir).filter((f) => f.startsWith('fix35-purge-receipt.'));
    const receiptPath = path.join(outDir, receipts[0]);
    runScript(['purge', '--rollback', '--receipt', receiptPath], { [CONFIRM_ENV]: CONFIRM_VALUE });
    const r = runScript(['purge', '--apply'], { [CONFIRM_ENV]: CONFIRM_VALUE });
    expect(r.status).toBe(0);
    const db = openDb();
    const live = db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE title LIKE '%ZZZ-SYNTHETIC%' AND archived_at IS NULL").get() as { n: number };
    const events = db.prepare("SELECT COUNT(*) AS n FROM task_events WHERE task_id='real-1' AND to_status='done'").get() as { n: number };
    db.close();
    expect(live.n).toBe(0);
    expect(events.n).toBe(1); // never double-written
  });
});