/**
 * b-u8-fixture-funnel-offline.test.ts — B-U8/U22 OFFLINE fixture funnel.
 *
 * Master spec `skill6-blended-persona-kanban-MASTER-SPEC-v2-2026-07-13.md`
 * §B-U8/U22, CODE-MERGE tier (spec L892, OPERATOR RULINGS 2026-07-15
 * per-repo/offline doctrine): B-U6's comparator and B-U7's ingest-parity
 * skip-branch are each already proven INDIVIDUALLY (u20-b-u6-persona-
 * mismatch-contract.test.ts, b-u7-ingest-persona-parity.test.ts,
 * a-u7-b-declared-vs-used-seed.test.ts). This file is B-U8's OWN, distinct
 * contribution: it composes BOTH in ONE offline funnel, fed by fixture
 * payload files under tests/fixtures/persona-bundles/ that mirror the exact
 * wire contracts each side of the ONB<->CC boundary uses —
 *
 *   1. INGEST — an ONB emit-shaped fixture (onb-emit-ingest-payload.json,
 *      the identical field vocabulary 06-ghl-install-pages/tools/
 *      cc_board.py::ingest_task() puts on the wire, proven on the ONB side
 *      by tests/test_cc_rail_contract.py) drives createTaskCore's B-U7
 *      producer-pin skip-branch — the card's DECLARED voice is pinned
 *      verbatim, no resolvePersonaAndPin selector spawn.
 *   2. COMPARE — a B-U6 producer-used-report fixture (either divergent or
 *      agreeing) is fed through recordPersonaUsedAndCompare against that
 *      SAME declared bundle — proving the declared side B-U7 just pinned is
 *      exactly what B-U6's comparator reads, not a parallel implementation.
 *
 * This is the OFFLINE half of "the whole unification block" fixture funnel
 * B-U8/U22 owns (spec L889); the LIVE end-to-end operator-box run (a real
 * producer -> real CC ingest handshake) stays explicitly DEFERRED to the
 * live-proof tier (spec L894) — nothing below makes a network call, spawns a
 * browser, or touches a live GHL/Vercel/GitHub resource.
 */
import './_isolated-db'; // MUST be first DB import: throwaway DATABASE_PATH.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { getDb, run, queryOne } from '../../src/lib/db';
import { createTaskCore } from '../../src/lib/tasks';
import { recordPersonaUsedAndCompare, getOpenPersonaMismatch } from '../../src/lib/persona-mismatch';

getDb(); // trigger the full migration chain against the isolated temp DB

const FIXTURES_DIR = path.join(__dirname, '..', 'fixtures', 'persona-bundles');

function loadFixture<T = Record<string, unknown>>(name: string): T {
  const raw = fs.readFileSync(path.join(FIXTURES_DIR, name), 'utf-8');
  return JSON.parse(raw) as T;
}

interface IngestPayloadFixture {
  voice_persona_id: string;
  topic_persona_id?: string | null;
  task_persona_ids?: string[] | null;
  bundle_sha?: string | null;
}

interface UsedReportFixture {
  kind: 'persona_used';
  page?: string | null;
  voice_persona_id?: string | null;
  topic_persona_id?: string | null;
  task_persona_id?: string | null;
  blend_directive_sha?: string | null;
  goal?: string | null;
}

let counter = 0;
const nextId = (p: string) => `${p}-${++counter}-${Date.now()}`;

function insertWorkspace(id: string, slug: string, name: string): void {
  run(
    `INSERT OR IGNORE INTO workspaces (id, name, slug, description, sort_order)
     VALUES (?, ?, ?, ?, ?)`,
    [id, name, slug, 'Test dept', 900 + counter],
  );
}

test.after(async () => {
  const { closeDb } = await import('../../src/lib/db');
  try {
    closeDb();
  } catch {
    /* ignore */
  }
});

function countMismatchEvents(taskId: string): number {
  const row = queryOne<{ c: number }>(
    `SELECT COUNT(*) AS c FROM events WHERE type = 'persona_mismatch' AND task_id = ?`,
    [taskId],
  );
  return row?.c ?? 0;
}

/** Capture every console.log/warn/error line emitted while `fn` runs — same
 * proof strategy as tests/unit/b-u7-ingest-persona-parity.test.ts: absence of
 * a `[resolvePersonaAndPin]`-prefixed line proves the selector never spawned. */
async function captureConsole<T>(fn: () => Promise<T>): Promise<{ result: T; lines: string[] }> {
  const lines: string[] = [];
  const origLog = console.log;
  const origWarn = console.warn;
  const origError = console.error;
  const record = (...args: unknown[]) => {
    lines.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  };
  console.log = ((...args: unknown[]) => { record(...args); }) as typeof console.log;
  console.warn = ((...args: unknown[]) => { record(...args); }) as typeof console.warn;
  console.error = ((...args: unknown[]) => { record(...args); }) as typeof console.error;
  try {
    const result = await fn();
    return { result, lines };
  } finally {
    console.log = origLog;
    console.warn = origWarn;
    console.error = origError;
  }
}

// ─── the fixture files themselves stay well-formed (catches bit-rot
//     independently of any test that merely consumes them) ──────────────────

test('[B-U8 fixtures] onb-emit-ingest-payload.json carries the full B-U7 field vocabulary', () => {
  const payload = loadFixture<IngestPayloadFixture>('onb-emit-ingest-payload.json');
  assert.ok(payload.voice_persona_id, 'fixture must carry voice_persona_id');
  assert.ok(payload.topic_persona_id, 'fixture must carry topic_persona_id');
  assert.ok(Array.isArray(payload.task_persona_ids) && payload.task_persona_ids.length > 0);
  assert.ok(payload.bundle_sha, 'fixture must carry bundle_sha');
});

test('[B-U8 fixtures] producer-used-report fixtures carry the kind=persona_used discriminator', () => {
  const divergent = loadFixture<UsedReportFixture>('producer-used-report-divergent.json');
  const agreeing = loadFixture<UsedReportFixture>('producer-used-report-agreeing.json');
  assert.equal(divergent.kind, 'persona_used');
  assert.equal(agreeing.kind, 'persona_used');
  assert.notEqual(divergent.voice_persona_id, agreeing.voice_persona_id, 'the two report fixtures must actually differ in voice for the funnel below to be meaningful');
});

// ─── THE FUNNEL — B-U7 ingest-pin (from a fixture) feeds B-U6's comparator
//     (from a fixture), end to end, offline ─────────────────────────────────

test('[B-U8 funnel] B-U7 ingest (fixture payload) -> declared bundle -> B-U6 comparator (fixture divergent report) -> exactly ONE persona_mismatch event', async () => {
  const wsId = nextId('ws-bu8-funnel-diverge');
  insertWorkspace(wsId, 'funnels', 'Funnels Department');
  const ingestPayload = loadFixture<IngestPayloadFixture>('onb-emit-ingest-payload.json');

  // Step 1 — B-U7: ingest carries the producer's personas verbatim, exactly
  // as cc_board.ingest_task() would emit them onto the wire (createTaskCore
  // is the in-process equivalent of the route the wire payload lands on).
  // Poison the selector fixture: if the skip-branch regressed and the code
  // fell through to resolvePersonaAndPin anyway, THIS id would land instead
  // of the fixture's — a value match against the fixture is itself proof the
  // selector was never consulted (same double-signal strategy as
  // b-u7-ingest-persona-parity.test.ts).
  process.env.PERSONA_FIXTURE_JSON = JSON.stringify({
    persona_id: 'poison-should-never-be-used', persona_name: 'Poison Persona',
    interaction_mode: 'leadership', score: 9,
  });
  const { result, lines } = await captureConsole(() =>
    createTaskCore({
      title: 'B-U8 funnel: funnel build from ONB emit fixture',
      workspace_id: wsId,
      department: 'funnels',
      skipWindowDedup: true,
      voice_persona_id: ingestPayload.voice_persona_id,
      topic_persona_id: ingestPayload.topic_persona_id,
      task_persona_ids: ingestPayload.task_persona_ids,
      bundle_sha: ingestPayload.bundle_sha,
    }),
  );
  delete process.env.PERSONA_FIXTURE_JSON;
  assert.ok(result, 'createTaskCore must return a result for the B-U7 producer-pin path');
  const taskId = result!.task.id;

  const selectorLines = lines.filter((l) => l.includes('[resolvePersonaAndPin]'));
  assert.deepEqual(selectorLines, [], `resolvePersonaAndPin must never spawn on the fixture-driven producer-pin path — got: ${JSON.stringify(selectorLines)}`);

  const declaredRow = queryOne<{ voice_persona_id: string | null }>(
    'SELECT voice_persona_id FROM tasks WHERE id = ?',
    [taskId],
  );
  assert.equal(
    declaredRow?.voice_persona_id,
    ingestPayload.voice_persona_id,
    'the DECLARED voice on the card must equal the fixture ingest payload verbatim (B-U7 pin)',
  );
  assert.notEqual(declaredRow?.voice_persona_id, 'poison-should-never-be-used', 'the poisoned selector fixture id must NEVER land — proof the skip-branch, not the selector, pinned this row');

  // Step 2 — B-U6: the producer reports what it ACTUALLY used, from a
  // fixture that diverges from the declared voice pinned in step 1.
  const usedReport = loadFixture<UsedReportFixture>('producer-used-report-divergent.json');
  const cmp = recordPersonaUsedAndCompare(taskId, usedReport);

  assert.ok(cmp, 'a genuine divergence between the fixture-pinned declared voice and the fixture-reported used voice must be detected');
  assert.equal(cmp?.declared_voice_persona_id, ingestPayload.voice_persona_id);
  assert.equal(cmp?.used_voice_persona_id, usedReport.voice_persona_id);
  assert.equal(countMismatchEvents(taskId), 1, 'exactly ONE persona_mismatch event from the fixture-driven funnel');

  const chip = getOpenPersonaMismatch(taskId);
  assert.ok(chip, 'the declared-vs-used chip must be present after the fixture funnel');
  assert.equal(chip?.page, usedReport.page);
});

test('[B-U8 funnel] B-U7 ingest (fixture payload) -> declared bundle -> B-U6 comparator (fixture agreeing report) -> zero persona_mismatch events', async () => {
  const wsId = nextId('ws-bu8-funnel-agree');
  insertWorkspace(wsId, 'funnels', 'Funnels Department');
  const ingestPayload = loadFixture<IngestPayloadFixture>('onb-emit-ingest-payload.json');

  const result = await createTaskCore({
    title: 'B-U8 funnel: agreeing voice from ONB emit fixture',
    workspace_id: wsId,
    department: 'funnels',
    skipWindowDedup: true,
    voice_persona_id: ingestPayload.voice_persona_id,
    topic_persona_id: ingestPayload.topic_persona_id,
    task_persona_ids: ingestPayload.task_persona_ids,
    bundle_sha: ingestPayload.bundle_sha,
  });
  const taskId = result!.task.id;

  const usedReport = loadFixture<UsedReportFixture>('producer-used-report-agreeing.json');
  assert.equal(usedReport.voice_persona_id, ingestPayload.voice_persona_id, 'the agreeing fixture must actually agree with the ingest fixture for this control case to be meaningful');

  const cmp = recordPersonaUsedAndCompare(taskId, usedReport);
  assert.equal(cmp, null, 'agreement must return null (no mismatch)');
  assert.equal(countMismatchEvents(taskId), 0, 'zero persona_mismatch events on agreement');
  assert.equal(getOpenPersonaMismatch(taskId), null, 'no chip on agreement');
});

test('[B-U8 funnel] legacy ingest (no persona fields) never produces a declared voice for the comparator to compare against', async () => {
  const wsId = nextId('ws-bu8-funnel-legacy');
  insertWorkspace(wsId, 'operations', 'Operations Department');

  // No producer persona fields — the legacy/absent path (B-U7 acceptance b)
  // falls through to the async selector pin. PERSONA_FIXTURE_JSON pins that
  // background resolution to a deterministic fixture value (never a live
  // provider/network call) — this test does not wait on it (matching
  // b-u7-ingest-persona-parity.test.ts's own established pattern), so the
  // comparator below runs BEFORE it lands, proving the declared side is
  // still NULL synchronously right after ingest.
  process.env.PERSONA_FIXTURE_JSON = JSON.stringify({
    persona_id: 'generic-leader',
    persona_name: 'Generic Leader',
    interaction_mode: 'leadership',
    score: 5,
  });
  const result = await createTaskCore({
    title: 'B-U8 funnel: legacy ingest, no bundle',
    workspace_id: wsId,
    department: 'operations',
    skipWindowDedup: true,
  });
  delete process.env.PERSONA_FIXTURE_JSON;
  const taskId = result!.task.id;

  const usedReport = loadFixture<UsedReportFixture>('producer-used-report-divergent.json');
  const cmp = recordPersonaUsedAndCompare(taskId, usedReport);
  assert.equal(cmp, null, 'no declared voice (legacy ingest never pinned one synchronously) -> comparator has nothing to compare, never fabricates a mismatch');
  assert.equal(countMismatchEvents(taskId), 0);
});
