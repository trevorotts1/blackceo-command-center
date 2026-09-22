/**
 * A WRONG COMPANY ROW SILENTLY BLANKED A CLIENT'S ENTIRE BOARD.
 *
 * Measured on a client box. `companies` rowid 1 carried id `default` — the
 * un-branded seed sentinel — but its slug had been renamed to a real-looking
 * value. `isPlaceholderCompany` was a denylist of three slugs (`default`,
 * `command-center`, `acme-*`), the renamed slug was on none of them, so the
 * sentinel row won `resolveSeedingCompanyId`. The board then scoped to company
 * `default`, which kept only unattributed rows, and every one of the client's
 * 40 active workspaces and 40 departments was filtered out. `/api/workspaces`
 * returned 0 of 40 rows that were present and active in the database while the
 * client sat fully logged in, staring at an empty board. Nothing went red.
 *
 * Two independent defects produced it, and this file locks both shut:
 *
 *   1. IDENTITY WAS NEVER CONSULTED. The box's own tenant identity
 *      (MC_COMPANY_ID — the same value tenantRegistration() hands every verified
 *      request as TenantContext.companyId) was available the whole time. The
 *      resolver ignored it and picked by ROW ORDER instead. Identity is now
 *      authoritative and terminal: whoever sits at rowid 1 cannot overrule it.
 *
 *   2. A DENYLIST CANNOT ENUMERATE EVERY WRONG VALUE. The renamed slug proves
 *      it. The predicate now asks what the row IS — a sentinel ID is a
 *      placeholder whatever it was renamed to — instead of listing names it
 *      must not have.
 *
 * And the backstop, because a resolver can still be wrong in a way nobody
 * predicted: a board that would render ZERO rows while the database holds rows
 * it would otherwise show now RAISES. An empty 200 is the failure mode that
 * cost a client a session, and it is the one outcome this code must never
 * produce silently.
 *
 * Generic fixture ids throughout — no client or roster names.
 *
 * Run: node --import tsx --test tests/unit/company-resolver-identity-authority.test.ts
 */
import './_isolated-db'; // MUST be first: points DATABASE_PATH at a throwaway DB.
import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { NextRequest } from 'next/server';

import {
  resolveSeedingCompanyId,
  isPlaceholderCompany,
  isSentinelCompanyId,
  installedCompanyIdentity,
} from '../../src/lib/db/branding-seed';
import {
  boardWhereClause,
  assertBoardNotSilentlyEmpty,
  listDisplayedWorkspaceIds,
  BoardScopeError,
} from '../../src/lib/workspaces/board-query';
import { getDb } from '../../src/lib/db';
import { GET as workspacesGET } from '../../src/app/api/workspaces/route';

/* ─────────────────────────────── fixtures ─────────────────────────────────── */

/** The renamed sentinel: the seed's `default` id, wearing a real-looking slug. */
const RENAMED_SENTINEL = { id: 'default', name: 'Riverside Media', slug: 'riverside' };
/** The company the tenant's rows are actually attributed to. */
const REAL_COMPANY = { id: 'riverside-media', name: 'Riverside Media', slug: 'riverside-media' };

/** Minimal companies + workspaces tables mirroring the production schema. */
function makeTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE companies (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE,
      industry TEXT, logo_url TEXT, config TEXT DEFAULT '{}'
    );
    CREATE TABLE workspaces (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL,
      icon TEXT DEFAULT '📁', company_id TEXT, sort_order INTEGER DEFAULT 100,
      archived_at TEXT
    );
  `);
  return db;
}

function addCompany(db: Database.Database, c: { id: string; name: string; slug: string }): void {
  db.prepare('INSERT INTO companies (id, name, slug, config) VALUES (?, ?, ?, ?)')
    .run(c.id, c.name, c.slug, '{}');
}

/** `count` active departments, all owned by `companyId` — the client's real board. */
function addWorkspaces(db: Database.Database, companyId: string, count: number): void {
  const ins = db.prepare(
    'INSERT INTO workspaces (id, name, slug, company_id, sort_order) VALUES (?, ?, ?, ?, ?)',
  );
  for (let i = 1; i <= count; i++) ins.run(`dept-${i}`, `Department ${i}`, `dept-${i}`, companyId, i);
}

/** What the board actually renders for this company — the route's own query shape. */
function renderBoard(db: Database.Database, activeCompanyId: string | null): string[] {
  const scope = boardWhereClause(activeCompanyId, { includeArchived: false });
  return (
    db
      .prepare(`SELECT w.id FROM workspaces w ${scope.sql} ORDER BY w.sort_order ASC`)
      .all(...scope.params) as { id: string }[]
  ).map((r) => r.id);
}

/** Run with a chosen env snapshot; every key is restored, set or not. */
function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/** No identity, no operator override — the box that must fall back to rows. */
function withNoIdentity<T>(fn: () => T): T {
  return withEnv({ MC_COMPANY_ID: undefined, COMPANY_SLUG: undefined, COMPANY_NAME: undefined }, fn);
}

/* ───────────────────────── 1. the renamed sentinel ────────────────────────── */

test('a company row keeping the `default` id is a placeholder however its slug was renamed', () => {
  assert.strictEqual(
    isPlaceholderCompany(RENAMED_SENTINEL),
    true,
    'id `default` with a renamed slug is the exact row that blanked a client board — a slug denylist never sees it',
  );
  assert.strictEqual(isPlaceholderCompany({ id: 'command-center', name: 'Riverside Media', slug: 'riverside' }), true);
  // Unchanged for every row that was already handled correctly.
  assert.strictEqual(isPlaceholderCompany({ id: 'default', name: 'Default', slug: 'default' }), true);
  assert.strictEqual(isPlaceholderCompany({ name: 'Command Center', slug: 'whatever' }), true);
  assert.strictEqual(isPlaceholderCompany({ name: 'Acme Corp', slug: 'acme-corp' }), true);
  assert.strictEqual(isPlaceholderCompany({ id: 'riverside-media', name: 'Riverside Media', slug: 'riverside-media' }), false);
});

test('a sentinel id names the ABSENCE of a company, in both directions', () => {
  assert.strictEqual(isSentinelCompanyId('default'), true);
  assert.strictEqual(isSentinelCompanyId('Command-Center'), true, 'case-insensitive');
  assert.strictEqual(isSentinelCompanyId('  '), true, 'blank is not an identity');
  assert.strictEqual(isSentinelCompanyId(null), true);
  assert.strictEqual(isSentinelCompanyId(undefined), true);
  assert.strictEqual(isSentinelCompanyId('riverside-media'), false);
});

test('the renamed sentinel never wins the resolver over the real company row', () => {
  const db = makeTestDb();
  try {
    addCompany(db, RENAMED_SENTINEL); // rowid 1
    addCompany(db, REAL_COMPANY); // rowid 2
    withNoIdentity(() => {
      assert.strictEqual(resolveSeedingCompanyId(db), REAL_COMPANY.id);
      assert.notStrictEqual(resolveSeedingCompanyId(db), 'default', 'must NEVER resolve to the sentinel id');
    });
  } finally {
    db.close();
  }
});

/* ──── 2. THE REGRESSION CASE: the exact shape, asserted on the board ───────── */

test('REGRESSION: sentinel row at rowid 1 + 40 active workspaces → the board is NOT emptied', () => {
  const db = makeTestDb();
  try {
    addCompany(db, RENAMED_SENTINEL); // rowid 1 — id `default`, slug NOT on any denylist
    addCompany(db, REAL_COMPANY); // rowid 2 — the client's real brand
    addWorkspaces(db, REAL_COMPANY.id, 40); // 40 active rows, present in the database

    withNoIdentity(() => {
      const active = resolveSeedingCompanyId(db);
      assert.strictEqual(active, REAL_COMPANY.id);

      const rendered = renderBoard(db, active);
      assert.strictEqual(
        rendered.length,
        40,
        'all 40 active workspaces must render; this returned 0 of 40 on a live client box',
      );
      assert.doesNotThrow(() => assertBoardNotSilentlyEmpty(db, active, rendered.length));
    });
  } finally {
    db.close();
  }
});

/* ───────────────────── 3. identity is authoritative ───────────────────────── */

test('the tenant identity resolves the company even with NO matching companies row', () => {
  const db = makeTestDb();
  try {
    addCompany(db, RENAMED_SENTINEL); // the only row on the box — and it is the sentinel
    addWorkspaces(db, REAL_COMPANY.id, 40); // rows attributed to an id with no row of its own

    withEnv({ MC_COMPANY_ID: REAL_COMPANY.id, COMPANY_SLUG: undefined, COMPANY_NAME: undefined }, () => {
      assert.strictEqual(installedCompanyIdentity(), REAL_COMPANY.id);
      const active = resolveSeedingCompanyId(db);
      assert.strictEqual(active, REAL_COMPANY.id, 'the row is branding; the identity is ownership');
      assert.strictEqual(renderBoard(db, active).length, 40);
    });
  } finally {
    db.close();
  }
});

test('identity beats row order — rowid 1 can never decide whose data a client sees', () => {
  const db = makeTestDb();
  try {
    addCompany(db, { id: 'other-co', name: 'Other Co', slug: 'other-co' }); // rowid 1, looks real
    addCompany(db, REAL_COMPANY); // rowid 2 — the tenant
    withEnv({ MC_COMPANY_ID: REAL_COMPANY.id, COMPANY_SLUG: undefined, COMPANY_NAME: undefined }, () => {
      assert.strictEqual(resolveSeedingCompanyId(db), REAL_COMPANY.id);
    });
    // Same table, no identity: the positional heuristic is the LAST resort, not the first.
    withNoIdentity(() => {
      assert.strictEqual(resolveSeedingCompanyId(db), 'other-co');
    });
  } finally {
    db.close();
  }
});

test('an explicitly passed identity overrides the installed one', () => {
  const db = makeTestDb();
  try {
    addCompany(db, RENAMED_SENTINEL);
    withEnv({ MC_COMPANY_ID: 'stale-id', COMPANY_SLUG: undefined, COMPANY_NAME: undefined }, () => {
      assert.strictEqual(resolveSeedingCompanyId(db, REAL_COMPANY.id), REAL_COMPANY.id);
    });
  } finally {
    db.close();
  }
});

test('a SENTINEL identity is not an identity — six hosts carried `companyId: default`', () => {
  const db = makeTestDb();
  try {
    addCompany(db, RENAMED_SENTINEL); // rowid 1
    addCompany(db, REAL_COMPANY); // rowid 2
    withEnv({ MC_COMPANY_ID: 'default', COMPANY_SLUG: undefined, COMPANY_NAME: undefined }, () => {
      assert.strictEqual(installedCompanyIdentity(), null, '`default` names the absence of an identity');
      assert.strictEqual(
        resolveSeedingCompanyId(db),
        REAL_COMPANY.id,
        'scoping the board to the sentinel is what emptied it — never do it on identity either',
      );
    });
  } finally {
    db.close();
  }
});

test('an explicit COMPANY_SLUG operator override still wins over the identity', () => {
  const db = makeTestDb();
  try {
    addCompany(db, RENAMED_SENTINEL);
    addCompany(db, { id: 'acme-inc', name: 'Acme Inc', slug: 'acme-inc' });
    withEnv({ MC_COMPANY_ID: REAL_COMPANY.id, COMPANY_SLUG: 'acme-inc', COMPANY_NAME: undefined }, () => {
      assert.strictEqual(resolveSeedingCompanyId(db), 'acme-inc');
    });
  } finally {
    db.close();
  }
});

test('an un-branded box with no identity still fails OPEN (null), never to a sentinel id', () => {
  const db = makeTestDb();
  try {
    addCompany(db, { id: 'default', name: 'Default', slug: 'default' });
    addCompany(db, { id: 'command-center', name: 'Command Center', slug: 'command-center' });
    withNoIdentity(() => {
      assert.strictEqual(resolveSeedingCompanyId(db), null);
      assert.strictEqual(renderBoard(db, null).length, 0, 'no rows on the box at all — nothing to show');
    });
  } finally {
    db.close();
  }
});

/* ──────────────────── 4. the guard: never silently empty ──────────────────── */

test('a board scoped to a company that owns nothing RAISES instead of rendering empty', () => {
  const db = makeTestDb();
  try {
    addCompany(db, REAL_COMPANY);
    addWorkspaces(db, REAL_COMPANY.id, 40);

    const rendered = renderBoard(db, 'stale-id'); // the wrong company, however it was resolved
    assert.strictEqual(rendered.length, 0, 'precondition: this scope renders nothing');

    let error: BoardScopeError | null = null;
    try {
      assertBoardNotSilentlyEmpty(db, 'stale-id', rendered.length);
    } catch (err) {
      error = err as BoardScopeError;
    }
    assert.ok(error instanceof BoardScopeError, 'must raise BoardScopeError, not return an empty board');
    assert.strictEqual(error.activeCompanyId, 'stale-id');
    assert.strictEqual(error.hiddenCount, 40);
    assert.strictEqual(error.activeWorkspacesByCompany[REAL_COMPANY.id], 40, 'the log names who actually owns them');
  } finally {
    db.close();
  }
});

test('listDisplayedWorkspaceIds raises rather than handing converge a wrongly-empty set', () => {
  const db = makeTestDb();
  try {
    addCompany(db, REAL_COMPANY);
    addWorkspaces(db, REAL_COMPANY.id, 40);
    assert.throws(() => listDisplayedWorkspaceIds(db, 'stale-id'), BoardScopeError);
    assert.strictEqual(listDisplayedWorkspaceIds(db, REAL_COMPANY.id).length, 40);
  } finally {
    db.close();
  }
});

test('the guard stays silent on every board that is legitimately empty', () => {
  const db = makeTestDb();
  try {
    // (a) a box with no workspaces at all — an empty board is the truth.
    assert.doesNotThrow(() => assertBoardNotSilentlyEmpty(db, REAL_COMPANY.id, 0));

    // (b) no company filter applied — nothing was scoped out.
    addWorkspaces(db, REAL_COMPANY.id, 3);
    assert.doesNotThrow(() => assertBoardNotSilentlyEmpty(db, null, 0));

    // (c) every row archived, and the caller asked to hide archived rows.
    db.prepare("UPDATE workspaces SET archived_at = '2026-09-22T00:00:00Z'").run();
    assert.strictEqual(renderBoard(db, REAL_COMPANY.id).length, 0);
    assert.doesNotThrow(() =>
      assertBoardNotSilentlyEmpty(db, REAL_COMPANY.id, 0, { includeArchived: false }),
    );
    // …but the same box DOES raise when archived rows were asked for and hidden anyway.
    assert.throws(
      () => assertBoardNotSilentlyEmpty(db, 'stale-id', 0, { includeArchived: true }),
      BoardScopeError,
    );

    // (d) rows the board still shows (unattributed) — renderedCount > 0.
    db.prepare("UPDATE workspaces SET archived_at = NULL, company_id = 'default'").run();
    const rendered = renderBoard(db, REAL_COMPANY.id);
    assert.strictEqual(rendered.length, 3, 'unattributed rows are the box OWN rows and stay visible');
    assert.doesNotThrow(() => assertBoardNotSilentlyEmpty(db, REAL_COMPANY.id, rendered.length));
  } finally {
    db.close();
  }
});

/* ─────────── 5. the client-visible surface: /api/workspaces itself ────────── */

/** Wipe the auto-seeded board and give this tenant `count` rows under `companyId`. */
function reseedLiveBoard(companyId: string, count: number): void {
  const db = getDb();
  db.pragma('foreign_keys = OFF');
  db.prepare('DELETE FROM tasks').run();
  db.prepare('DELETE FROM agents').run();
  db.prepare('DELETE FROM workspaces').run();
  const ins = db.prepare(
    `INSERT INTO workspaces (id, name, slug, description, icon, company_id, sort_order)
     VALUES (?, ?, ?, ?, '📁', ?, ?)`,
  );
  for (let i = 1; i <= count; i++) {
    ins.run(`dept-${i}`, `Department ${i}`, `dept-${i}`, `Department ${i}`, companyId, i);
  }
  db.pragma('foreign_keys = ON');
}

test('/api/workspaces refuses to answer 200 with an empty board while the rows are right there', async () => {
  reseedLiveBoard(REAL_COMPANY.id, 40);

  // The tenant identity names a company that owns NONE of the rows — whatever
  // the cause, this is the state that served a client an empty board.
  const refused = await withEnv(
    { MC_COMPANY_ID: 'stale-id', COMPANY_SLUG: undefined, COMPANY_NAME: undefined },
    () => workspacesGET(new NextRequest('http://localhost/api/workspaces')),
  );
  assert.strictEqual(refused.status, 500, 'an empty 200 is the defect; a loud 500 is the fix');
  const body = await refused.json();
  assert.strictEqual(body.error, 'board_company_scope_owns_no_workspaces');
  assert.strictEqual(body.activeCompanyId, 'stale-id');
  assert.strictEqual(body.activeWorkspacesByCompany[REAL_COMPANY.id], 40);

  // …and the same box with the right identity serves all 40.
  const ok = await withEnv(
    { MC_COMPANY_ID: REAL_COMPANY.id, COMPANY_SLUG: undefined, COMPANY_NAME: undefined },
    () => workspacesGET(new NextRequest('http://localhost/api/workspaces')),
  );
  assert.strictEqual(ok.status, 200);
  assert.strictEqual(((await ok.json()) as unknown[]).length, 40);
});
