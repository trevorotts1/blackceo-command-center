/**
 * cc-agent-count-dedupe-scope.test.ts — 2026-08-04 "WANTED Woman" incident
 * (company_id='wanted-woman'): the Command Center dashboard reported 288
 * agents for a 36-agent, 35-department workforce. Two verified root causes:
 *
 *   DEFECT 1 — /api/performance's `agent_utilization.total` (rendered as
 *   "N total agents") was a bare, unscoped `SELECT COUNT(*) FROM agents` —
 *   no company join, no dept- prefix dedup.
 *
 *   DEFECT 2 — the workspace reseed (reseedWorkspacesFromConfig) was not
 *   idempotent across the `dept-`-prefix boundary for a duplicate pair that
 *   ALREADY existed before a given reseed run (only NEW duplicates were
 *   guarded against, via FM-6/MR-21). The box ended up with BOTH
 *   `dept-marketing` and `marketing` workspace rows for the same real
 *   department, each carrying its own boilerplate agents.
 *
 * This file proves both fixes using DELTAS against the route's own baseline
 * response rather than hard-coded absolute counts — the real reseed pipeline
 * unconditionally seeds its own trio/head agents for EVERY workspace
 * (including fleet-shared engine workspaces created by earlier migrations),
 * so an absolute "total agents == N" assertion would be coupled to that
 * unrelated baseline and break the moment it changes. Measuring the CHANGE
 * in the reported total as each fixture row is added isolates exactly what
 * this fix is responsible for, regardless of baseline noise.
 *
 * Also proves the cross-company guard added to dedupeCanonicalWorkspaces
 * (task-dedup.ts): a shared multi-client box must never merge two DIFFERENT
 * companies' identically-named department into one row, and a second
 * company's agents must never appear in the active company's total.
 *
 * MUST import _isolated-db FIRST so getDb() opens a throwaway DB, never the
 * real mission-control.db (mirrors mr21-reseed-dept-prefix-migration.test.ts).
 */
import './_isolated-db';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { getDb } from '../../src/lib/db';
import { reseedWorkspacesFromConfig } from '../../src/lib/db/migrations';
import { dedupeCanonicalWorkspaces } from '../../src/lib/db/task-dedup';
import { GET as performanceGET } from '../../src/app/api/performance/route';

const ACTIVE = 'wanted-woman-co';
const OTHER = 'other-client-co';
let zhcDir: string;
const savedEnv: Record<string, string | undefined> = {};

// The CC manifest format Cassandra's rebuild actually produces: bare ids, no
// `dept-` prefix (see sync-departments-from-build-state.py's own stripping
// and MR-21's normalizeDeptPrefixedId — both treat this as the canonical
// on-disk shape).
const manifest = [{ id: 'marketing', name: 'Marketing', slug: 'marketing', emoji: '📣' }];

async function totalAgents(): Promise<number> {
  const res = await performanceGET();
  const body = (await res.json()) as { agent_utilization: { total: number } };
  return body.agent_utilization.total;
}

beforeAll(() => {
  savedEnv.COMPANY_SLUG = process.env.COMPANY_SLUG;
  savedEnv.COMPANY_NAME = process.env.COMPANY_NAME;
  savedEnv.ZERO_HUMAN_COMPANY_DIR = process.env.ZERO_HUMAN_COMPANY_DIR;
  process.env.COMPANY_SLUG = ACTIVE;
  delete process.env.COMPANY_NAME;

  zhcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wanted-woman-zhc-'));
  fs.writeFileSync(path.join(zhcDir, 'departments.json'), JSON.stringify(manifest), 'utf8');
  process.env.ZERO_HUMAN_COMPANY_DIR = zhcDir;

  const db = getDb();
  db.prepare(
    "INSERT OR IGNORE INTO companies (id, name, slug, industry, config) VALUES (?, 'WANTED Woman', ?, 'Retail', '{}')",
  ).run(ACTIVE, ACTIVE);
  db.prepare(
    "INSERT OR IGNORE INTO companies (id, name, slug, industry, config) VALUES (?, 'Other Client Co', ?, 'Retail', '{}')",
  ).run(OTHER, OTHER);

  // Materialize the NORMAL, single "marketing" workspace (+ its own trio/head)
  // for the active company from the manifest — this is the clean, healthy
  // steady state every measurement below is a DELTA against.
  reseedWorkspacesFromConfig(db, { force: true });
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

describe('DEFECT 1: /api/performance dedups on read — a stray dept- duplicate does not inflate the total', () => {
  it('adding a legacy "dept-marketing" duplicate (with its own agents) does not change agent_utilization.total', async () => {
    const before = await totalAgents();

    const db = getDb();
    db.prepare(
      "INSERT INTO workspaces (id, name, slug, description, icon, company_id, sort_order) VALUES ('dept-marketing', 'Marketing', 'dept-marketing', 'Legacy marketing workspace', '📣', ?, 1000)",
    ).run(ACTIVE);
    db.prepare("INSERT INTO agents (id, name, role, workspace_id) VALUES ('agent-mkt-legacy-1', 'Legacy Marketer 1', 'specialist', 'dept-marketing')").run();
    db.prepare("INSERT INTO agents (id, name, role, workspace_id) VALUES ('agent-mkt-legacy-2', 'Legacy Marketer 2', 'specialist', 'dept-marketing')").run();

    const after = await totalAgents();

    // "marketing" (the row whose slug is ALREADY the canonical slug) is
    // always the keeper over "dept-marketing", regardless of insertion
    // order or agent counts — so the 2 legacy agents on the loser workspace
    // must be EXCLUDED from the total until the data is actually healed.
    expect(after).toBe(before);
  });

  it('a second company\'s own department (same slug) is never counted in the active company\'s total', async () => {
    const before = await totalAgents();

    const db = getDb();
    db.prepare(
      "INSERT INTO workspaces (id, name, slug, description, icon, company_id, sort_order) VALUES ('other-marketing', 'Marketing', 'marketing-other-co', 'Other Co marketing workspace', '📣', ?, 1000)",
    ).run(OTHER);
    db.prepare("INSERT INTO agents (id, name, role, workspace_id) VALUES ('agent-other-mkt-1', 'Other Co Marketer', 'specialist', 'other-marketing')").run();

    const after = await totalAgents();
    expect(after).toBe(before);
  });
});

describe('DEFECT 2: reseedWorkspacesFromConfig heals the pre-existing duplicate pair and stays idempotent', () => {
  it('merges "dept-marketing" into "marketing" on the next reseed, re-homing its tasks/agents', () => {
    const db = getDb();
    // A task on the loser row, to prove re-homing (not just agent reassignment).
    db.prepare("INSERT INTO tasks (id, title, workspace_id) VALUES ('task-mkt-legacy-1', 'Legacy task', 'dept-marketing')").run();

    reseedWorkspacesFromConfig(db, { force: true });

    const marketingRows = db
      .prepare("SELECT id FROM workspaces WHERE id IN ('marketing', 'dept-marketing')")
      .all() as { id: string }[];
    expect(marketingRows).toEqual([{ id: 'marketing' }]);

    // The two legacy agents and the legacy task were re-homed onto the
    // keeper, not deleted.
    const legacyAgent1 = db.prepare('SELECT workspace_id FROM agents WHERE id = ?').get('agent-mkt-legacy-1') as
      | { workspace_id: string }
      | undefined;
    expect(legacyAgent1?.workspace_id).toBe('marketing');
    const legacyTask = db.prepare('SELECT workspace_id FROM tasks WHERE id = ?').get('task-mkt-legacy-1') as
      | { workspace_id: string }
      | undefined;
    expect(legacyTask?.workspace_id).toBe('marketing');
  });

  it('now reports the previously-excluded legacy agents once the data is healed', async () => {
    // Once the loser row is gone, the 2 legacy agents live under the same
    // keeper workspace as everything else, so a plain per-workspace COUNT
    // includes them — no more dedup collision to resolve.
    const db = getDb();
    const keeperAgentCount = (
      db.prepare("SELECT COUNT(*) AS n FROM agents WHERE workspace_id = 'marketing' AND id IN ('agent-mkt-legacy-1','agent-mkt-legacy-2')").get() as { n: number }
    ).n;
    expect(keeperAgentCount).toBe(2);
  });

  it('does not grow the workspace count on a second, third run (idempotent)', () => {
    const db = getDb();
    const afterFirstHeal = (db.prepare('SELECT COUNT(*) AS n FROM workspaces').get() as { n: number }).n;

    reseedWorkspacesFromConfig(db, { force: true });
    reseedWorkspacesFromConfig(db, { force: true });

    const afterRepeatRuns = (db.prepare('SELECT COUNT(*) AS n FROM workspaces').get() as { n: number }).n;
    expect(afterRepeatRuns).toBe(afterFirstHeal);
  });

  it('the healing pass never touches a different company\'s identically-named department (cross-company guard)', () => {
    const db = getDb();
    const otherRow = db.prepare('SELECT id, company_id FROM workspaces WHERE id = ?').get('other-marketing') as
      | { id: string; company_id: string }
      | undefined;
    expect(otherRow).toBeDefined();
    expect(otherRow!.company_id).toBe(OTHER);

    const otherAgent = db.prepare('SELECT workspace_id FROM agents WHERE id = ?').get('agent-other-mkt-1') as
      | { workspace_id: string }
      | undefined;
    expect(otherAgent?.workspace_id).toBe('other-marketing');
  });

  it('dedupeCanonicalWorkspaces alone is a true no-op on an already-healed board', () => {
    const db = getDb();
    const result = dedupeCanonicalWorkspaces(db);
    expect(result.groups_merged).toBe(0);
    expect(result.rows_deleted).toBe(0);
  });

  it('a GENUINE cross-company canonical-slug collision (dept- prefixed vs bare, different companies) is never merged', () => {
    // 'other-marketing' above deliberately used a non-colliding slug, so the
    // guard above never actually got exercised against a real collision.
    // This is the real hazard shape: two DIFFERENT companies each hold a row
    // that canonicalizes to "sales" — one dept-prefixed (a pre-MR-21 legacy
    // row), one bare — sharing the same box. workspaces.slug is globally
    // UNIQUE, so the two rows must use DIFFERENT literal slugs (schema-valid)
    // that nonetheless canonicalize to the SAME department.
    const db = getDb();
    db.prepare(
      "INSERT INTO workspaces (id, name, slug, description, icon, company_id, sort_order) VALUES ('sales', 'Sales', 'sales', 'Sales workspace', '💰', ?, 1000)",
    ).run(ACTIVE);
    db.prepare(
      "INSERT INTO workspaces (id, name, slug, description, icon, company_id, sort_order) VALUES ('dept-sales-other', 'Sales', 'dept-sales', 'Other Co sales workspace', '💰', ?, 1000)",
    ).run(OTHER);
    db.prepare("INSERT INTO agents (id, name, role, workspace_id) VALUES ('agent-ww-sales-1', 'WW Salesperson', 'specialist', 'sales')").run();
    db.prepare("INSERT INTO agents (id, name, role, workspace_id) VALUES ('agent-other-sales-1', 'Other Co Salesperson', 'specialist', 'dept-sales-other')").run();

    const result = dedupeCanonicalWorkspaces(db);

    // Both rows canonicalize to "sales" — but they belong to DIFFERENT real
    // companies, so they must NOT be counted as one mergeable group.
    expect(result.merges.some((m) => m.canonical === 'sales')).toBe(false);

    const salesRows = db.prepare("SELECT id, company_id FROM workspaces WHERE id IN ('sales', 'dept-sales-other')").all() as
      { id: string; company_id: string }[];
    expect(salesRows.length).toBe(2);
    const otherCoRow = salesRows.find((r) => r.id === 'dept-sales-other');
    expect(otherCoRow?.company_id).toBe(OTHER);
    expect(db.prepare("SELECT workspace_id FROM agents WHERE id = 'agent-other-sales-1'").get()).toEqual({
      workspace_id: 'dept-sales-other',
    });
  });
});
