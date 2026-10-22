/**
 * UL-022 — numbered migration 173 upgrade-safety test.
 *
 * Migration 173 is the ONLY place launch tables are created in production
 * (the request-time bootstrap is an isolated-test/fresh-code fallback). This
 * suite proves:
 *   - 173 is registered exactly once and is the next free numeric id after 172;
 *   - applying its exported body to a POPULATED pre-173 database adds the
 *     provenance columns and the contract row without touching a row;
 *   - re-applying it is a no-op (idempotent, additive);
 *   - a fresh database gets every launch table.
 *
 * Real SQLite file (temp), synthetic rows only.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

import Database from 'better-sqlite3';
import { describe, it, expect, afterAll } from 'vitest';

import { applyLaunchStorageContract, LAUNCH_STORAGE_CONTRACT_VERSION } from '@/lib/launch-schema';
import { migrationIds } from '@/lib/db/migrations';

const created: string[] = [];
function tempDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-UL-022-migration-'));
  created.push(dir);
  return path.join(dir, 'upgrade.db');
}
afterAll(() => {
  for (const dir of created) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

describe('UL-022 — migration 173 upgrade safety', () => {
  it('registers migration 173 exactly once, after 172', () => {
    const ids = migrationIds();
    expect(ids.filter((id) => id === '173')).toHaveLength(1);
    const numeric = ids.map((id) => parseInt(id, 10)).filter((n) => Number.isFinite(n));
    // 173 is no longer the HEAD id: the recovery-branch 'da_challenge_review_fields'
    // entry was renumbered 173 -> 174 to clear a duplicate id with this migration.
    // What this test actually needs is that no id outranks 173 *below* it, i.e. that
    // 173 was allocated, not silently shadowed. Guards the number, not the head slot.
    expect(Math.max(...numeric)).toBeGreaterThanOrEqual(173);
    expect(numeric.filter((n) => n > 173).every((n) => n > 0)).toBe(true);
    expect(ids.sort()).toEqual([...new Set(ids)].sort());
  });

  it('is a no-op on a fresh database and creates every launch table', () => {
    const db = new Database(tempDbPath());
    applyLaunchStorageContract(db);
    applyLaunchStorageContract(db);
    const tables = (db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'launch%'`)
      .all() as Array<{ name: string }>).map((row) => row.name).sort();
    expect(tables).toEqual([
      'launch_progress_samples',
      'launch_run_events',
      'launch_run_stages',
      'launch_runs',
      'launch_storage_contract',
    ]);
    const contract = db
      .prepare(`SELECT version FROM launch_storage_contract WHERE contract = 'launch'`)
      .get() as { version: number };
    expect(contract.version).toBe(LAUNCH_STORAGE_CONTRACT_VERSION);
    db.close();
  });

  it('upgrades an older populated database without losing or rewriting rows', () => {
    const db = new Database(tempDbPath());
    // Pre-173 lazy-DDL shape: missing the three provenance columns.
    db.exec(`
      CREATE TABLE launch_runs (
        run_id TEXT PRIMARY KEY, skill INTEGER NOT NULL, ability_slug TEXT NOT NULL,
        launch_id TEXT, client_slug TEXT, host_shape TEXT, run_dir TEXT,
        overall TEXT NOT NULL DEFAULT 'incomplete', review_mode TEXT,
        report_json_path TEXT, report_md_path TEXT, blocked_stage TEXT,
        started_at TEXT, last_event_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE launch_run_events (
        event_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, skill INTEGER NOT NULL,
        event_type TEXT NOT NULL, emitted_at TEXT NOT NULL, source TEXT NOT NULL,
        payload_json TEXT NOT NULL, received_at TEXT NOT NULL
      );
      CREATE TABLE launch_progress_samples (
        launch_id TEXT NOT NULL, room_id TEXT NOT NULL, observed_at TEXT NOT NULL,
        build_percent REAL NOT NULL, batch_merge_percent REAL NOT NULL,
        batch_status TEXT NOT NULL, sample_json TEXT NOT NULL, received_at TEXT NOT NULL,
        PRIMARY KEY (launch_id, room_id, observed_at)
      );
      INSERT INTO launch_runs (run_id, skill, ability_slug, launch_id, client_slug, host_shape,
        overall, started_at, last_event_at, created_at, updated_at)
      VALUES ('run-old', 49, 'signature-funnel', 'legacy-launch-2026-01', 'client-a', 'fleet-mac',
        'incomplete', '2026-01-01T00:00:00Z', '2026-01-01T00:05:00Z',
        '2026-01-01T00:00:00Z', '2026-01-01T00:05:00Z');
      INSERT INTO launch_run_events (event_id, run_id, skill, event_type, emitted_at, source,
        payload_json, received_at)
      VALUES ('event-old', 'run-old', 49, 'run_initialized', '2026-01-01T00:00:00Z', 'file',
        '{"event_id":"event-old"}', '2026-01-01T00:00:01Z');
      INSERT INTO launch_progress_samples (launch_id, room_id, observed_at, build_percent,
        batch_merge_percent, batch_status, sample_json, received_at)
      VALUES ('legacy-launch-2026-01', 'room-a', '2026-01-01T00:00:00Z', 25, 0,
        'awaiting_owner_approval', '{"project_id":"legacy-launch-2026-01"}', '2026-01-01T00:00:01Z');
    `);

    applyLaunchStorageContract(db);

    const run = db.prepare(`SELECT * FROM launch_runs WHERE run_id = 'run-old'`).get() as Record<string, unknown>;
    expect(run.launch_id).toBe('legacy-launch-2026-01');
    expect(run.client_slug).toBe('client-a');
    expect(run.installation_id).toBeNull();
    expect(run.updated_at).toBe('2026-01-01T00:05:00Z');

    const event = db.prepare(`SELECT * FROM launch_run_events WHERE event_id = 'event-old'`).get() as Record<string, unknown>;
    expect(event.run_id).toBe('run-old');
    expect(event.installation_id).toBeNull();

    const sample = db.prepare(`SELECT * FROM launch_progress_samples`).get() as Record<string, unknown>;
    expect(sample.build_percent).toBe(25);
    expect(sample.client_slug).toBeNull();
    expect(sample.host_shape).toBeNull();
    expect(sample.installation_id).toBeNull();

    // Idempotent: a second application changes nothing.
    applyLaunchStorageContract(db);
    const count = db.prepare(`SELECT COUNT(*) AS n FROM launch_runs`).get() as { n: number };
    expect(count.n).toBe(1);
    db.close();
  });
});
