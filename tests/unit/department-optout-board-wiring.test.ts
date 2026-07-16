/**
 * department-optout-board-wiring.test.ts — U110 (E5-5, G2d — CC leg; ONB caller-wiring owed): proves the
 * ghost/orphan-column bug is real and that this unit's fix closes it.
 *
 * THE BUG: a client whose real chosen department set is smaller than the
 * 28-department floor — because they explicitly, provably OPTED OUT of some
 * departments via U108's provenance-gated `provisioning/department-optout.json`
 * — kept seeing those opted-out departments as live Kanban columns. Nothing on
 * the CC side ever read that file back (confirmed zero references anywhere in
 * src/ before this unit; CHANGELOG.md's own U108 entry names this gap "CC
 * board-column leg (U110) OWED"). `reseedWorkspacesFromConfig()` is
 * additive-only by design (U109's own invariant) and `syncDeclinedWorkspaceArchive()`
 * only honors build-state declines — NEITHER closes this gap.
 *
 * This test seeds a REAL throwaway SQLite DB with:
 *   - a below-floor departments.json (CEO + general-task catch-all + 3 worker
 *     departments — nowhere near the 28-department floor: a real-world class
 *     of client whose legitimately chosen set is far smaller than the floor)
 *   - stray, already-provisioned workspace rows for departments the client
 *     provably opted OUT of (a real department-optout.json fixture, U108-
 *     shaped) — these are the ghost columns
 *   - one stray row with NO opt-out record at all (ambiguous — only absent
 *     from the manifest) — proves this fix does NOT stray into U109's
 *     territory (never wipe on bare manifest omission)
 *   - an adversarial fixture naming the orchestrator column in the opt-out
 *     file — proves that exemption holds regardless of upstream data
 *   - a matching fixture naming the catch-all (general-task) in the opt-out
 *     file, and a build-state decline of it — proves the OPPOSITE for
 *     general-task: it is declinable (operator ruling, 2026-07-16, U110
 *     send-back D1 — see department-optout.ts's module docstring), and both
 *     the opt-out archive pass and the build-state decline pass now AGREE
 *     with listChosenDepartmentIds, so converge parity holds (200) instead of
 *     the pre-fix 500
 *   - a build-state DECLINE of master-orchestrator (U110 send-back D4-R2) —
 *     proves listChosenDepartmentIds's exemption is now scoped to ONLY the
 *     opt-out-file input set, never the declined-ids set, so a declined
 *     orchestrator agrees with syncDeclinedWorkspaceArchive (which has no
 *     exemption concept) instead of the two sides disagreeing via the union —
 *     the exact mechanism D1's fix left alive, re-derived and closed here
 *
 * NOTE ON D7 (recorded, not required to fix): the `it()` blocks in this file
 * share mutable DB state and MUST run in file order — e.g. the D4-R2 test
 * above depends on master-orchestrator still being on the board from the D1
 * test before it, and un-archives what it declined before the next test runs.
 * vitest runs a file's tests sequentially by default, so this is green today,
 * but `.only`, `--sequence.shuffle`, or extracting a single case would break
 * it non-obviously.
 *
 * and drives the REAL product code end-to-end: reseedWorkspacesFromConfig ->
 * syncDeclinedWorkspaceArchive -> syncDepartmentOptoutArchive -> the exact
 * board query GET /api/workspaces uses (boardWhereClause / displayedSlugs()) ->
 * listChosenDepartmentIds -> assertConvergeParity (the same assertion
 * POST /api/system/converge runs).
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
import {
  syncDeclinedWorkspaceArchive,
  syncDepartmentOptoutArchive,
  readDepartmentOptoutIds,
  DEPARTMENT_OPTOUT_REASON,
  listChosenDepartmentIds,
  listProvisionedWorkspaceIds,
  assertConvergeParity,
} from '../../src/lib/workspaces/archive';
import { listDisplayedWorkspaceIds } from '../../src/lib/workspaces/board-query';
import { resolveActiveCompanyId } from '../../src/lib/company';

const ACTIVE = 'below-floor-co';
let zhcDir: string;
let workspaceDir: string;
let optoutPath: string;
const savedEnv: Record<string, string | undefined> = {};

/**
 * THE REAL board query — not a reimplementation. Calls the exact same
 * `listDisplayedWorkspaceIds()` / `boardWhereClause()` GET /api/workspaces
 * uses, so this test proves what the client's browser actually renders, not a
 * stand-in that could silently drift from it (in every fixture below `id ===
 * slug`, so returned ids double as slugs for readable assertions).
 */
function displayedSlugs(): string[] {
  const db = getDb();
  const active = resolveActiveCompanyId(db);
  return listDisplayedWorkspaceIds(db, active);
}

/** Build a `department-optout.json`-shaped fixture (U108's real schema) naming
 * exactly the given dept ids as confirmed, provenance-gated opt-outs. */
function optoutFile(ids: string[]) {
  const optedOut: Record<string, unknown> = {};
  for (const id of ids) {
    optedOut[id] = {
      optedOut: true,
      lossWarningShown: true,
      lossWarningText: `You will lose ${id} functionality.`,
      floorStatus: 'floor-confirmed',
      decidedAt: new Date().toISOString(),
      decidedBy: 'owner',
      source: 'interview',
      reversible: true,
    };
  }
  return { generatedAt: new Date().toISOString(), source: 'test-fixture', optedOut, unconfirmed: [] };
}

// A genuinely below-floor chosen set: CEO + general-task (catch-all) + 3 worker
// departments. Nowhere near the 28-department floor.
const belowFloorManifest = [
  { id: 'master-orchestrator', name: 'CEO', slug: 'master-orchestrator', emoji: '🧠' },
  { id: 'general-task', name: 'General Task', slug: 'general-task', emoji: '📁' },
  { id: 'marketing', name: 'Marketing', slug: 'marketing', emoji: '📣' },
  { id: 'sales', name: 'Sales', slug: 'sales', emoji: '💰' },
  { id: 'billing', name: 'Billing', slug: 'billing', emoji: '💳' },
];

beforeAll(() => {
  savedEnv.COMPANY_SLUG = process.env.COMPANY_SLUG;
  savedEnv.COMPANY_NAME = process.env.COMPANY_NAME;
  savedEnv.ZERO_HUMAN_COMPANY_DIR = process.env.ZERO_HUMAN_COMPANY_DIR;
  savedEnv.OPENCLAW_WORKSPACE_PATH = process.env.OPENCLAW_WORKSPACE_PATH;
  process.env.COMPANY_SLUG = ACTIVE;
  delete process.env.COMPANY_NAME;

  zhcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'u110-zhc-'));
  fs.writeFileSync(path.join(zhcDir, 'departments.json'), JSON.stringify(belowFloorManifest), 'utf8');
  process.env.ZERO_HUMAN_COMPANY_DIR = zhcDir;

  // A SEPARATE workspace-root tree for department-optout.json, exactly
  // mirroring where department-optout-sync.py writes it (OPENCLAW_WORKSPACE_PATH
  // root, NOT a sibling of departments.json — see department-optout.ts's own
  // docstring for why the two roots are deliberately distinct).
  workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'u110-workspace-'));
  fs.mkdirSync(path.join(workspaceDir, 'provisioning'), { recursive: true });
  process.env.OPENCLAW_WORKSPACE_PATH = workspaceDir;
  optoutPath = path.join(workspaceDir, 'provisioning', 'department-optout.json');

  const db = getDb();
  db.prepare(
    "INSERT OR IGNORE INTO companies (id, name, slug, industry, config) VALUES (?, 'Below Floor Co', ?, 'Software', '{}')",
  ).run(ACTIVE, ACTIVE);
});

afterAll(() => {
  for (const k of ['COMPANY_SLUG', 'COMPANY_NAME', 'ZERO_HUMAN_COMPANY_DIR', 'OPENCLAW_WORKSPACE_PATH']) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  try {
    if (zhcDir) fs.rmSync(zhcDir, { recursive: true, force: true });
    if (workspaceDir) fs.rmSync(workspaceDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe('U110: below-floor department set wires exactly onto the board (no ghost columns; orchestrator column exempt, catch-all declinable)', () => {
  it('reproduces the bug: an opted-out department stays a ghost column through reseed + the pre-U110 declined-archive path alone', () => {
    // Seed the below-floor board.
    reseedWorkspacesFromConfig(getDb(), { force: true });

    // Simulate the ghost columns: extra, already-provisioned workspace rows for
    // departments NOT in the below-floor manifest — e.g. left over from an
    // earlier, larger provisioning pass. This is the exact class of stray row a
    // real box can carry.
    const db = getDb();
    db.prepare(
      'INSERT INTO workspaces (id, name, slug, description, icon, company_id, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run('support', 'Support', 'support', 'Support department workspace', '🛟', ACTIVE, 1000);
    db.prepare(
      'INSERT INTO workspaces (id, name, slug, description, icon, company_id, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run('hr', 'HR', 'hr', 'HR department workspace', '👥', ACTIVE, 1000);
    // A row with NO opt-out record — ambiguous, U109's territory. Must NEVER be
    // touched by this unit's fix (asserted in the next test).
    db.prepare(
      'INSERT INTO workspaces (id, name, slug, description, icon, company_id, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run('legal', 'Legal', 'legal', 'Legal department workspace', '⚖️', ACTIVE, 1000);

    // The owner PROVABLY opted OUT of 'support' and 'hr' via U108's
    // provenance-gated channel (functionality-loss warning shown + acked).
    // 'legal' carries NO record at all (ambiguous omission, not this unit's job).
    fs.writeFileSync(optoutPath, JSON.stringify(optoutFile(['support', 'hr'])), 'utf8');

    // THE PRE-U110 PIPELINE: reseed + the ALREADY-EXISTING declined-archive
    // step only (no department-optout.json consumer). This is exactly what
    // POST /api/system/converge did before this unit.
    reseedWorkspacesFromConfig(db, { force: true });
    syncDeclinedWorkspaceArchive(db, []); // no build-state declines in this fixture

    // THE BUG, reproduced: 'support' and 'hr' are opted out, yet still rendered.
    const displayed = displayedSlugs();
    expect(displayed).toContain('support'); // ghost column #1 — pre-fix
    expect(displayed).toContain('hr'); // ghost column #2 — pre-fix
  });

  it('U110 fix: syncDepartmentOptoutArchive removes exactly the opted-out ghost columns, leaves the ambiguous row alone, and honors the catch-all', () => {
    const db = getDb();
    const optedOut = readDepartmentOptoutIds();
    expect(optedOut.sort()).toEqual(['hr', 'support']);

    const result = syncDepartmentOptoutArchive(db, optedOut);
    expect(result.archived.sort()).toEqual(['hr', 'support']);

    const displayed = displayedSlugs();

    // THE FIX: no more ghost columns for the opted-out departments.
    expect(displayed).not.toContain('support');
    expect(displayed).not.toContain('hr');

    // The board is EXACTLY the below-floor chosen set PLUS 'legal' — which
    // carries no opt-out record at all and must stay untouched (U109's
    // territory: bare manifest omission alone is never a hide signal). This
    // fix removes ONLY what was explicitly, provenance-gated opted out.
    expect(displayed.sort()).toEqual(
      ['master-orchestrator', 'general-task', 'marketing', 'sales', 'billing', 'legal'].sort(),
    );

    // U109's territory respected: 'legal' has NO opt-out record and is merely
    // absent from the manifest — this unit must never touch it.
    expect(displayed).toContain('legal');
    const legalRow = db.prepare('SELECT archived_at FROM workspaces WHERE id = ?').get('legal') as
      | { archived_at: string | null }
      | undefined;
    expect(legalRow?.archived_at ?? null).toBeNull();

    // Soft-archive, never hard-delete — the row still exists.
    const supportRow = db
      .prepare('SELECT archived_at, archived_reason FROM workspaces WHERE id = ?')
      .get('support') as { archived_at: string | null; archived_reason: string | null };
    expect(supportRow.archived_at).not.toBeNull();
    expect(supportRow.archived_reason).toBe(DEPARTMENT_OPTOUT_REASON);
  });

  it('orchestrator column protected: master-orchestrator is NEVER archived even if adversarially named in the opt-out file', () => {
    const db = getDb();
    // Adversarial fixture: someone/something (bug, corrupt state, bad merge)
    // names the CEO/orchestrator column in optedOut{} ALONGSIDE the still-
    // legitimately opted-out 'support'/'hr' from the previous test — so this
    // test proves the exemption in isolation WITHOUT disturbing their archived
    // state (which a later test depends on for its own, separate reversal
    // proof). Unlike 'general-task' (see the next two tests), ONB's own
    // naming map does not model the orchestrator column as declinable at all
    // (no loss_warning, no floor status) — its protection rests entirely on
    // this CC-side exemption, and it is unconditional.
    fs.writeFileSync(
      optoutPath,
      JSON.stringify(optoutFile(['support', 'hr', 'master-orchestrator'])),
      'utf8',
    );

    const optedOut = readDepartmentOptoutIds();
    expect(optedOut.sort()).toEqual(['hr', 'master-orchestrator', 'support']);

    const result = syncDepartmentOptoutArchive(db, optedOut);
    // The orchestrator column is NEVER in the archived set, however it was named.
    expect(result.archived).toEqual([]);
    // support/hr stay archived (already archived by the previous test — this
    // call is a no-op for them, proving idempotency too).
    expect(result.alreadyArchived.sort()).toEqual(['hr', 'support']);

    const displayed = displayedSlugs();
    expect(displayed).toContain('master-orchestrator');
    expect(displayed).not.toContain('support');
    expect(displayed).not.toContain('hr');
  });

  it("general-task is declinable (operator ruling, U110 send-back D1): a valid, provenance-gated opt-out of the catch-all IS honored — it is no longer exempt", () => {
    const db = getDb();
    // ONB's department-naming-map.json authors a loss_warning specifically for
    // declining general-task — an explicit, informed-consent decline, not a
    // bare omission. The ruling: that signal must be honored here exactly like
    // any other department's opt-out, not silently overridden by a hard
    // exemption. Named alongside the already-archived support/hr so this test
    // does not disturb their state.
    fs.writeFileSync(
      optoutPath,
      JSON.stringify(optoutFile(['support', 'hr', 'general-task'])),
      'utf8',
    );

    const optedOut = readDepartmentOptoutIds();
    expect(optedOut.sort()).toEqual(['general-task', 'hr', 'support']);

    const result = syncDepartmentOptoutArchive(db, optedOut);
    // The catch-all IS now archived — the fix.
    expect(result.archived).toEqual(['general-task']);
    expect(result.alreadyArchived.sort()).toEqual(['hr', 'support']);

    const displayed = displayedSlugs();
    expect(displayed).not.toContain('general-task');
    expect(displayed).not.toContain('support');
    expect(displayed).not.toContain('hr');
    // master-orchestrator is unaffected — still on the board.
    expect(displayed).toContain('master-orchestrator');

    // Restore general-task before the next test (support/hr stay archived —
    // the following 'reversible' test asserts specifically on 'support').
    const restore = syncDepartmentOptoutArchive(db, ['support', 'hr']);
    expect(restore.unarchived).toEqual(['general-task']);
    expect(displayedSlugs()).toContain('general-task');
  });

  it('D1 fix proof: a build-state decline of general-task and listChosenDepartmentIds now AGREE — converge parity holds (200), not the pre-fix 500', () => {
    const db = getDb();
    // The documented steady state (archive.ts:16-19): general-task is one of
    // the 22 mandatory departments (U44, seeded fleet-wide), so a shrunk
    // departments.json never drops it — the below-floor fixture manifest here
    // still lists it too, with no manifest opt-out flag. The decline lives in
    // build-state instead, exactly as readHonoredDeclinedIds() would surface
    // it. syncDeclinedWorkspaceArchive() has no exemption concept at all (by
    // design — it only ever sees the honored declined set), so it archives
    // whatever it is told, general-task included.
    const declineResult = syncDeclinedWorkspaceArchive(db, ['general-task']);
    expect(declineResult.archived).toEqual(['general-task']);
    expect(displayedSlugs()).not.toContain('general-task');

    // PRE-FIX: listChosenDepartmentIds's exemption check unconditionally kept
    // general-task in `chosen` regardless of the decline, so `chosen` and
    // `provisioned` disagreed and assertConvergeParity failed (missingFromProvisioned
    // = ['general-task']) — the exact 500 the QC judge proved counterfactually.
    // POST-FIX: general-task is no longer in DEPARTMENT_OPTOUT_EXEMPT_IDS, so
    // listChosenDepartmentIds excludes it here exactly like syncDeclinedWorkspaceArchive
    // archived it — both sides agree.
    const chosen = listChosenDepartmentIds(['general-task'], []);
    expect(chosen).not.toBeNull();
    expect(chosen).not.toContain('general-task');

    const parity = assertConvergeParity({
      chosen: chosen as string[],
      provisioned: listProvisionedWorkspaceIds(db),
      displayed: displayedSlugs(),
    });
    // THE D1 PROOF: general-task no longer appears on EITHER side of a
    // mismatch — pre-fix it was the sole entry in missingFromProvisioned
    // (chosen kept it via the exemption while the decline had already
    // archived it out of provisioned/displayed), which is exactly what made
    // assertConvergeParity.ok false and POST /api/system/converge return 500.
    expect(parity.missingFromProvisioned).toEqual([]);
    expect(parity.unexpectedlyProvisioned).not.toContain('general-task');
    // 'legal' is the FIRST test's deliberately ambiguous stray row (no opt-out
    // record, absent from the manifest, U109's territory — never archived by
    // this unit) persisting in the shared DB; it is expected to keep showing
    // as unexpectedlyProvisioned here regardless of the D1 fix, so parity.ok
    // is correctly still false overall. Asserting the array precisely (rather
    // than ignoring it) proves 'legal' is the ONLY remaining discrepancy —
    // general-task's mismatch is gone.
    expect(parity.unexpectedlyProvisioned).toEqual(['legal']);

    // Reverse the decline (owner flips NO -> YES) — syncDeclinedWorkspaceArchive's
    // own reversal logic un-archives whatever it archived that is no longer in
    // the passed-in declined set, restoring general-task before the next test.
    const reversal = syncDeclinedWorkspaceArchive(db, []);
    expect(reversal.unarchived).toEqual(['general-task']);
    expect(displayedSlugs()).toContain('general-task');
  });

  it('D4-R2 fix proof: a build-state DECLINE of master-orchestrator no longer reproduces D1\'s 500 — the exemption is no longer applied to the union', () => {
    const db = getDb();
    // THE EXACT MECHANISM QC's round-2 A/B probe pinned. PROBE B (this test):
    // master-orchestrator declined via BUILD-STATE (not the opt-out file).
    // PRE-FIX: `excludedNorm` was the UNION of declinedIds and optedOutFileIds,
    // so `isDepartmentOptoutExempt('master-orchestrator')` (true) protected it
    // from the decline-side subtraction too — even though
    // syncDeclinedWorkspaceArchive has NO exemption concept at all and archives
    // it unconditionally. chosen kept it, provisioned/displayed lost it:
    // missingFromProvisioned=['master-orchestrator'] -> assertConvergeParity.ok
    // = false -> POST /api/system/converge 500. This was NOT reachable through
    // any designed ONB flow (the naming map never models the orchestrator
    // column), but canonical_decline.analyze() honors any provenanced 'no'
    // with no allowlist — a hand-edited or corrupt build-state reaches it, so
    // the guard rail was ONB's data happening not to ask, not the code.
    const declineResult = syncDeclinedWorkspaceArchive(db, ['master-orchestrator']);
    expect(declineResult.archived).toEqual(['master-orchestrator']);
    expect(displayedSlugs()).not.toContain('master-orchestrator');

    // POST-FIX: listChosenDepartmentIds's decline-side set (`declinedNorm`) is
    // now SEPARATE from the opt-out-side set (`optoutNorm`) and carries NO
    // exemption — it mirrors syncDeclinedWorkspaceArchive exactly, so a
    // declined master-orchestrator is excluded from `chosen` just like it was
    // excluded from `provisioned`. Both sides agree.
    const chosen = listChosenDepartmentIds(['master-orchestrator'], []);
    expect(chosen).not.toBeNull();
    expect(chosen).not.toContain('master-orchestrator');

    const parity = assertConvergeParity({
      chosen: chosen as string[],
      provisioned: listProvisionedWorkspaceIds(db),
      displayed: displayedSlugs(),
    });
    // THE D4-R2 PROOF: master-orchestrator no longer appears on either side of
    // a mismatch. 'legal' (the first test's deliberately ambiguous stray row)
    // is the only remaining, expected discrepancy — same as the D1 proof above
    // — so asserting the array precisely proves master-orchestrator's mismatch
    // never occurs, not merely that SOME test happens to still pass.
    expect(parity.missingFromProvisioned).toEqual([]);
    expect(parity.unexpectedlyProvisioned).toEqual(['legal']);

    // Reverse the decline before the next test.
    const reversal = syncDeclinedWorkspaceArchive(db, []);
    expect(reversal.unarchived).toEqual(['master-orchestrator']);
    expect(displayedSlugs()).toContain('master-orchestrator');

    // PROBE A (the OTHER half of QC's A/B pair, re-asserted here so the split
    // is proven symmetric, not merely that the decline side was patched):
    // master-orchestrator named in the OPT-OUT FILE instead of build-state
    // must STILL be exempt — `optoutNorm` is the ONLY branch that consults
    // isDepartmentOptoutExempt(), and it must keep doing so. If this branch
    // ever lost the exemption too, the opt-out-file path (proven correct
    // pre-fix by the earlier 'orchestrator column protected' test) would
    // regress into the opposite failure: unexpectedlyProvisioned.
    const chosenViaOptout = listChosenDepartmentIds([], ['master-orchestrator']);
    expect(chosenViaOptout).not.toBeNull();
    expect(chosenViaOptout).toContain('master-orchestrator');
  });

  it('reversible: re-opting IN un-archives the row (never a stuck ghost-of-the-fix)', () => {
    const db = getDb();
    // Owner reverses the 'support' decision — no longer in the opted-out file.
    // ('hr' and 'general-task' are ALSO absent now — 'hr' un-archives too, as
    // asserted by the count below; 'general-task' was never archived to begin
    // with, so its absence here is a no-op.)
    fs.writeFileSync(optoutPath, JSON.stringify(optoutFile([])), 'utf8');

    const optedOut = readDepartmentOptoutIds();
    expect(optedOut).toEqual([]);

    const result = syncDepartmentOptoutArchive(db, optedOut);
    expect(result.unarchived).toContain('support');

    const supportRow = db.prepare('SELECT archived_at FROM workspaces WHERE id = ?').get('support') as {
      archived_at: string | null;
    };
    expect(supportRow.archived_at).toBeNull();
  });
});
