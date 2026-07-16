/**
 * floor-department-invariant.test.ts — the AUTHORITATIVE behavioral proof of the
 * Command Center floor invariant (2026-07-08):
 *
 *   For the active client company, the Kanban board displays EXACTLY the client's
 *   chosen departments.json manifest MINUS any explicitly opted-out department —
 *   with no first-boot staleness, no destructive slug collapse (App Development
 *   and Engineering are distinct lanes), no foreign-company leakage, and no silent
 *   cap.
 *
 * This exercises the REAL product code end-to-end on a throwaway, fully-migrated
 * SQLite DB:
 *   • reseedWorkspacesFromConfig  (the every-boot / converge idempotent upsert)
 *   • seedCompanyGuarded          (fail-closed company attribution)
 *   • resolveActiveCompanyId      (shared active-company resolver)
 *   • the exact scoped board query used by GET /api/workspaces
 *
 * Runs under vitest (wired into vitest.config.ts `include`) so CI's deep-health
 * job gates every push on it. A regression in ANY of the four fixes flips it red.
 *
 * MUST import _isolated-db FIRST so getDb() opens a throwaway DB, never the real
 * mission-control.db.
 */
import './_isolated-db';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { getDb, run } from '../../src/lib/db';
import { reseedWorkspacesFromConfig, isDepartmentOptedOut } from '../../src/lib/db/migrations';
import { resolveActiveCompanyId } from '../../src/lib/company';

const FIXTURE_DIR = path.join(process.cwd(), 'tests', 'fixtures', 'floor-invariant');
const manifest = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, 'manifest.json'), 'utf8')) as Array<
  Record<string, unknown>
>;
const expectedDisplayed = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, 'expected-displayed.json'), 'utf8'),
) as string[];

const ACTIVE = 'acme-inc';
let zhcDir: string;
const savedEnv: Record<string, string | undefined> = {};

/** Replicate the EXACT company-scoped board query used by GET /api/workspaces. */
function displayedSlugs(): string[] {
  const db = getDb();
  const active = resolveActiveCompanyId(db);
  const scope = active
    ? `WHERE (w.company_id = ? OR w.company_id = 'default' OR w.company_id IS NULL OR w.company_id = '')`
    : '';
  const params = active ? [active] : [];
  const rows = db
    .prepare(
      `SELECT w.slug
         FROM workspaces w
         LEFT JOIN agents a ON a.id = w.head_agent_id
         ${scope}
         ORDER BY w.sort_order ASC, w.name ASC`,
    )
    .all(...params) as { slug: string }[];
  return rows.map((r) => r.slug);
}

beforeAll(() => {
  // Deterministic active company (independent of companies-table row order).
  savedEnv.COMPANY_SLUG = process.env.COMPANY_SLUG;
  savedEnv.COMPANY_NAME = process.env.COMPANY_NAME;
  savedEnv.ZERO_HUMAN_COMPANY_DIR = process.env.ZERO_HUMAN_COMPANY_DIR;
  process.env.COMPANY_SLUG = ACTIVE;
  delete process.env.COMPANY_NAME;

  // A ZHC company folder holding the client's real chosen manifest — the highest
  // priority source in resolveDepartmentsConfigPath().
  zhcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'floor-zhc-'));
  fs.writeFileSync(path.join(zhcDir, 'departments.json'), JSON.stringify(manifest), 'utf8');
  process.env.ZERO_HUMAN_COMPANY_DIR = zhcDir;

  // The real active company must already exist so seedCompanyGuarded attributes
  // departments to it (never a fallback/template company).
  const db = getDb();
  db.prepare(
    "INSERT OR IGNORE INTO companies (id, name, slug, industry, config) VALUES (?, 'Acme Incorporated', ?, 'Software', '{}')",
  ).run(ACTIVE, ACTIVE);
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

describe('floor invariant: displayed == manifest − opt-outs (active company)', () => {
  it('fixture golden equals the manifest minus explicitly opted-out entries (arithmetic contract)', () => {
    const derived = manifest
      .filter((d) => !isDepartmentOptedOut(d))
      .map((d) => String(d.id))
      .sort();
    expect(derived).toEqual([...expectedDisplayed].sort());
    // The fixture MUST exercise a real opt-out, or it proves nothing.
    expect(manifest.some((d) => isDepartmentOptedOut(d))).toBe(true);
  });

  it('reseed seeds exactly the chosen manifest minus opt-outs, all under the active company', () => {
    const r = reseedWorkspacesFromConfig(getDb(), { force: true });
    expect(r.created).toBe(expectedDisplayed.length); // opted-out dept was NOT created

    const displayed = displayedSlugs().sort();
    expect(displayed).toEqual([...expectedDisplayed].sort());

    // Opted-out department (podcast) never got a lane.
    expect(displayed).not.toContain('podcast');

    // Every seeded workspace is attributed to the active company.
    const foreignCount = (
      getDb()
        .prepare("SELECT COUNT(*) AS c FROM workspaces WHERE company_id != ?")
        .get(ACTIVE) as { c: number }
    ).c;
    expect(foreignCount).toBe(0);
  });

  it('App Development and Engineering are DISTINCT lanes (no destructive collapse)', () => {
    const displayed = displayedSlugs();
    expect(displayed).toContain('app-development');
    expect(displayed).toContain('engineering');
    // Two separate rows, not one merged row.
    const rows = getDb()
      .prepare("SELECT id FROM workspaces WHERE slug IN ('app-development','engineering')")
      .all() as { id: string }[];
    expect(rows.length).toBe(2);
  });

  it('is idempotent — re-running reseed neither grows nor shrinks the board', () => {
    const before = displayedSlugs().sort();
    const r2 = reseedWorkspacesFromConfig(getDb(), { force: true });
    expect(r2.created).toBe(0); // nothing new created on the second pass
    const after = displayedSlugs().sort();
    expect(after).toEqual(before);
  });

  it('a FOREIGN company’s workspace never leaks onto the active board', () => {
    const db = getDb();
    // A different company with its own department row.
    db.prepare(
      "INSERT OR IGNORE INTO companies (id, name, slug, config) VALUES ('rival-co', 'Rival Co', 'rival-co', '{}')",
    ).run();
    run(
      "INSERT INTO workspaces (id, name, slug, description, icon, company_id, sort_order) VALUES ('rival-secret', 'Rival Secret Lab', 'rival-secret', 'x', '🔒', 'rival-co', 1000)",
    );

    const displayed = displayedSlugs();
    expect(displayed).not.toContain('rival-secret');
    // The active board is still exactly the chosen manifest minus opt-outs.
    expect(displayed.sort()).toEqual([...expectedDisplayed].sort());
  });

  // ── U109 (E5-4, closes G2c) — the CC-side leg of the floor-wipe guard ────────
  // The ONB writer (build-workforce.write_chosen_departments_artifact) now
  // merges rather than replaces the durable chosen-list on a partial/aborted
  // re-run — but that fix only matters if the CC READ/INGEST side does not
  // itself amplify a manifest that shrank for some OTHER reason (a stale
  // partial write, a hand-edited config, a bad sync) into lost departments.
  // This proves the CC leg of the SAME invariant: reseedWorkspacesFromConfig
  // is additive-only (upsert, never delete) — a SECOND converge run against a
  // SMALLER departments.json must never remove a department that a PRIOR,
  // larger manifest already provisioned onto the board.
  it('U109: a SHRUNK departments.json on a later reseed never wipes previously-provisioned departments', () => {
    // Sanity precondition: the full board from the earlier tests is up.
    const before = displayedSlugs().sort();
    expect(before).toEqual([...expectedDisplayed].sort());

    // Simulate the exact failure class U109 closes: a second provisioning
    // pass (re-run / partial interview / late edit) that writes a SMALLER
    // manifest — here, only the CEO column and one department survive the
    // rewrite. This is the WIPE scenario reproduced offline, at the CC
    // ingest boundary rather than the ONB write boundary.
    const shrunkManifest = [
      { id: 'master-orchestrator', name: 'CEO', slug: 'master-orchestrator', emoji: '🧠' },
      { id: 'marketing', name: 'Marketing', slug: 'marketing', emoji: '📣' },
    ];
    fs.writeFileSync(path.join(zhcDir, 'departments.json'), JSON.stringify(shrunkManifest), 'utf8');

    const r = reseedWorkspacesFromConfig(getDb(), { force: true });
    // Additive contract: nothing NEW is created (both depts already existed),
    // and — the load-bearing assertion — nothing is REMOVED.
    expect(r.created).toBe(0);

    const after = displayedSlugs().sort();
    expect(after).toEqual(before);
    // Explicitly name the departments that were NOT in the shrunk manifest —
    // they must still be on the board (sales, app-development, engineering,
    // general-task were all present before and absent from shrunkManifest).
    for (const slug of ['sales', 'app-development', 'engineering', 'general-task']) {
      expect(after).toContain(slug);
    }
  });
});
