/**
 * recover-blocked-deliverables.test.ts — proves the one-time blocked-card
 * recovery sweep's CLASSIFICATION + dry-run ledger without touching any live DB.
 * The sweep must classify the blocked pile (onboarding scaffolds, test/probe
 * cards, a seed burst, re-queue duplicates) and only route genuinely-REAL cards
 * with on-disk evidence to `recover-to-review` — never blanket-redeliver.
 *
 *   node --import tsx --test tests/unit/recover-blocked-deliverables.test.ts
 */

import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyBlocked, rootSubject, resolveClasses, mapAction, buildLedger,
  type BlockedRow,
} from '../../scripts/recover-blocked-deliverables';

function row(partial: Partial<BlockedRow>): BlockedRow {
  return {
    id: partial.id ?? Math.random().toString(36).slice(2),
    title: partial.title ?? '',
    status: 'blocked',
    department: partial.department ?? null,
    workspace_id: partial.workspace_id ?? null,
    created_at: partial.created_at ?? '2026-07-01T00:00:00',
    block_audience: partial.block_audience ?? null,
    blocked_on_human: partial.blocked_on_human ?? null,
  };
}

test('classifyBlocked routes onboarding / test / demo / seed correctly', () => {
  assert.equal(classifyBlocked(row({ title: 'Welcome to BlackCEO' })), 'ONBOARDING');
  assert.equal(classifyBlocked(row({ title: 'e2e routing probe' })), 'TEST');
  assert.equal(classifyBlocked(row({ title: 'Something', department: 'smoke-test-dept' })), 'TEST');
  assert.equal(classifyBlocked(row({ title: 'Sample deck for demo' })), 'DEMO');
  assert.equal(classifyBlocked(row({ title: 'General Task', created_at: '2026-06-16T01:22:00' })), 'SEED');
  assert.equal(classifyBlocked(row({ title: 'General Task', created_at: '2026-07-01T00:00:00' })), 'REAL',
    'a General Task OUTSIDE the seed window is not SEED');
  assert.equal(classifyBlocked(row({ title: 'Build the Q3 investor funnel' })), 'REAL');
});

test('rootSubject strips stacked re-queue prefixes', () => {
  assert.equal(rootSubject('[RE-QUEUED] URGENT: Facebook ad build'), 'facebook ad build');
  assert.equal(rootSubject('ESCALATE: Facebook Ad Build'), 'facebook ad build');
});

test('resolveClasses marks older re-queue siblings DUPLICATE, keeps the newest REAL', () => {
  const rows = [
    row({ id: 'a', title: '[RE-QUEUED] Facebook ad build', created_at: '2026-07-01T10:00:00' }),
    row({ id: 'b', title: 'URGENT: Facebook ad build',     created_at: '2026-07-02T10:00:00' }),
    row({ id: 'c', title: 'ESCALATE: Facebook ad build',   created_at: '2026-07-03T10:00:00' }), // newest
  ];
  const classes = resolveClasses(rows);
  assert.equal(classes.get('c'), 'REAL', 'newest sibling is kept as REAL');
  assert.equal(classes.get('a'), 'DUPLICATE');
  assert.equal(classes.get('b'), 'DUPLICATE');
});

test('mapAction: REAL needs evidence to reach review, else returns to orchestrator', () => {
  assert.equal(mapAction('REAL', true), 'recover-to-review');
  assert.equal(mapAction('REAL', false), 'return-to-orchestrator');
  assert.equal(mapAction('ONBOARDING', true), 'administrative-close');
  assert.equal(mapAction('DUPLICATE', false), 'administrative-close');
});

test('buildLedger (dry-run, seeded temp DB): classifies + only evidenced REAL → recover-to-review', () => {
  // Seed a throwaway DB mirroring the blocked-pile composition.
  const dbFile = path.join(mkdtempSync(path.join(os.tmpdir(), 'cc-recover-db-')), 'mc.db');
  const db = new Database(dbFile);
  db.exec(`
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY, title TEXT, status TEXT, department TEXT, workspace_id TEXT,
      created_at TEXT, block_audience TEXT, blocked_on_human TEXT, archived_at TEXT
    );
    CREATE TABLE task_deliverables (task_id TEXT, path TEXT);
  `);
  const ins = db.prepare(
    `INSERT INTO tasks (id, title, status, department, workspace_id, created_at, block_audience, blocked_on_human, archived_at)
     VALUES (@id, @title, 'blocked', @department, @workspace_id, @created_at, @block_audience, @blocked_on_human, NULL)`,
  );
  const mk = (o: Partial<BlockedRow>) => ins.run({
    id: o.id, title: o.title ?? '', department: o.department ?? null, workspace_id: o.workspace_id ?? null,
    created_at: o.created_at ?? '2026-07-01T00:00:00', block_audience: o.block_audience ?? null,
    blocked_on_human: o.blocked_on_human ?? null,
  });

  mk({ id: 'onb1', title: 'Welcome to Acme Co' });
  mk({ id: 'tst1', title: 'routing probe e2e' });
  mk({ id: 'dem1', title: 'demo sample survey' });
  mk({ id: 'seed1', title: 'General Task', created_at: '2026-06-16T01:22:30' });
  mk({ id: 'real-no', title: 'Build the launch page' });               // REAL, no evidence
  mk({ id: 'real-yes', title: 'Ship the podcast landing site' });      // REAL, has evidence

  // On-disk artifact dir for the evidenced REAL card.
  const projectsBase = mkdtempSync(path.join(os.tmpdir(), 'cc-recover-proj-'));
  const artDir = path.join(projectsBase, 'artifacts', 'real-yes');
  mkdirSync(artDir, { recursive: true });
  writeFileSync(path.join(artDir, 'index.html'), '<html>done</html>');

  const ledger = buildLedger(db, projectsBase);
  db.close();

  const byId = Object.fromEntries(ledger.map((e) => [e.id, e]));
  assert.equal(byId['onb1'].action, 'administrative-close');
  assert.equal(byId['tst1'].class, 'TEST');
  assert.equal(byId['dem1'].class, 'DEMO');
  assert.equal(byId['seed1'].class, 'SEED');
  assert.equal(byId['real-no'].action, 'return-to-orchestrator', 'REAL without evidence is not auto-delivered');
  assert.equal(byId['real-yes'].action, 'recover-to-review', 'REAL with on-disk output recovers to review');
  assert.equal(byId['real-yes'].evidence.artifactDir, artDir);
});
