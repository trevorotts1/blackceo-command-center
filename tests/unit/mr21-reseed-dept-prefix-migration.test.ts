/**
 * mr21-reseed-dept-prefix-migration.test.ts — MR-21 (fix2): a box seeded BEFORE
 * MR-21 carries workspace rows whose ids still hold the Skill-23 `dept-` prefix
 * (e.g. "dept-marketing"). MR-21's reseed now keys every workspace row on the
 * bare canonical id ("marketing"). Without a migration branch, the reseed would
 * INSERT a SECOND "marketing" row and strand the old "dept-marketing" row — and
 * every task/agent still pointing at it — on an orphan the sidebar/routing (now
 * matching the bare canonical id) never displays again.
 *
 * This drives the REAL reseedWorkspacesFromConfig() on a throwaway DB and proves
 * the reseed MIGRATES the pre-MR-21 row in place: the row is re-keyed to the
 * canonical id, its tasks/agents are re-homed, and NO duplicate row is minted.
 *
 * MUST import _isolated-db FIRST so getDb() opens a throwaway DB, never the
 * real mission-control.db.
 */
import './_isolated-db';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { getDb } from '../../src/lib/db';
import { reseedWorkspacesFromConfig } from '../../src/lib/db/migrations';

const ACTIVE = 'mr21-rehome-co';
let zhcDir: string;
const savedEnv: Record<string, string | undefined> = {};

// A Skill-23-shaped manifest: ids carry the `dept-` prefix MR-21 normalizes.
const deptPrefixedManifest = [
  { id: 'dept-marketing', name: 'Marketing', slug: 'dept-marketing', emoji: '📣' },
  { id: 'dept-sales', name: 'Sales', slug: 'dept-sales', emoji: '💰' },
];

beforeAll(() => {
  savedEnv.COMPANY_SLUG = process.env.COMPANY_SLUG;
  savedEnv.COMPANY_NAME = process.env.COMPANY_NAME;
  savedEnv.ZERO_HUMAN_COMPANY_DIR = process.env.ZERO_HUMAN_COMPANY_DIR;
  process.env.COMPANY_SLUG = ACTIVE;
  delete process.env.COMPANY_NAME;

  zhcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mr21-rehome-zhc-'));
  fs.writeFileSync(path.join(zhcDir, 'departments.json'), JSON.stringify(deptPrefixedManifest), 'utf8');
  process.env.ZERO_HUMAN_COMPANY_DIR = zhcDir;

  const db = getDb();
  db.prepare(
    "INSERT OR IGNORE INTO companies (id, name, slug, industry, config) VALUES (?, 'MR21 Rehome Co', ?, 'Software', '{}')",
  ).run(ACTIVE, ACTIVE);

  // Simulate the PRE-MR-21 state: workspaces were seeded with the raw
  // `dept-`-prefixed ids, and tasks/agents already point at those rows.
  const insertWs = db.prepare(
    'INSERT INTO workspaces (id, name, slug, description, icon, company_id, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  insertWs.run('dept-marketing', 'Marketing', 'dept-marketing', 'Marketing department workspace', '📣', ACTIVE, 1000);
  insertWs.run('dept-sales', 'Sales', 'dept-sales', 'Sales department workspace', '💰', ACTIVE, 1000);
  db.prepare('INSERT INTO tasks (id, title, workspace_id) VALUES (?, ?, ?)').run('task-mkt-1', 'Pre-MR-21 task', 'dept-marketing');
  db.prepare("INSERT INTO agents (id, name, role, workspace_id) VALUES (?, ?, ?, ?)").run('agent-mkt-1', 'Marketer', 'specialist', 'dept-marketing');
});

afterAll(() => {
  for (const k of ['COMPANY_SLUG', 'COMPANY_NAME', 'ZERO_HUMAN_COMPANY_DIR']) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  try {
    if (zhcDir) fs.rmSync(zhcDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe('MR-21 (fix2): reseed migrates pre-MR-21 dept-prefixed workspace rows instead of orphaning them', () => {
  it('re-keys the dept-prefixed row to the bare canonical id, re-homes its tasks/agents, and mints no duplicate', () => {
    reseedWorkspacesFromConfig(getDb(), { force: true });

    const db = getDb();
    const ids = (db.prepare('SELECT id FROM workspaces ORDER BY id').all() as { id: string }[])
      .map((r) => r.id);

    // The canonical rows exist...
    expect(ids).toContain('marketing');
    expect(ids).toContain('sales');
    // ...and the old dept-prefixed rows are GONE (re-keyed, not duplicated).
    expect(ids).not.toContain('dept-marketing');
    expect(ids).not.toContain('dept-sales');

    // Exactly one marketing row — no orphaned duplicate was minted.
    const marketingCount = (db.prepare("SELECT COUNT(*) AS n FROM workspaces WHERE id IN ('marketing','dept-marketing')").get() as { n: number }).n;
    expect(marketingCount).toBe(1);

    // The pre-existing task and agent were re-homed to the canonical id — not
    // stranded on the old dept-prefixed row.
    const task = db.prepare('SELECT workspace_id FROM tasks WHERE id = ?').get('task-mkt-1') as { workspace_id: string };
    expect(task.workspace_id).toBe('marketing');
    const agent = db.prepare('SELECT workspace_id FROM agents WHERE id = ?').get('agent-mkt-1') as { workspace_id: string };
    expect(agent.workspace_id).toBe('marketing');
  });
});
