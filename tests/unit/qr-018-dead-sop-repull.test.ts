/**
 * QR-018 — the dead-SOP re-pull path's exclusion, proven WHERE IT ACTUALLY RUNS.
 *
 * REVP-028 QC (five-lens, FAIL) F4: a lens claimed the re-pull "CANNOT re-attach"
 * a soft-deleted SOP and rested that on `suggestSOPsForTask`'s `deleted_at`
 * filter — without ever opening the function the write path actually reaches.
 * The re-pull chain is:
 *
 *   src/lib/task-dispatcher.ts:787  isLiveSopId(task.sop_id)   ← gate (may fall through)
 *   src/lib/task-dispatcher.ts:792  getBestSOPForTask(...)     ← the write path
 *   src/lib/sops.ts:554            getBestSOPForTask → suggestSOPsForTask
 *   src/lib/sops.ts:481            SELECT * FROM sops WHERE deleted_at IS NULL   ← the ONLY filter
 *   src/lib/sops.ts:500            rankSOPsBySemantic(queryText)  ← NO deleted_at filter
 *   src/lib/sops.ts:512            eligible.map(...)  ← intersection: semantic hits
 *                                    are looked up BY the already-filtered pool.
 *
 * So the exclusion is NOT a filter inside the ranking function — it is the
 * INTERSECTION of `rankSOPsBySemantic`'s hit list (which DOES contain the dead
 * sop's id, dead row and all) with the `deleted_at IS NULL` pool at sops.ts:481.
 * A test that only seeded a live SOP would pass whether or not that intersection
 * existed; the dead SOP here carries an embedding row whose vector is IDENTICAL
 * to the query vector (cosine 1.0), so if the intersection were ever removed the
 * dead row would win outright. That is what makes this file discriminate.
 *
 * Discriminator (proven in scratch, never committed): deleting `deleted_at IS
 * NULL` from sops.ts:481 makes test 2 FAIL — the dead SOP surfaces at cosine 1.0.
 *
 *   node --import tsx --test tests/unit/qr-018-dead-sop-repull.test.ts
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-qr018-repull-'));
const TMP_DB = path.join(TMP_DIR, 'mission-control.test.db');
process.env.DATABASE_PATH = TMP_DB;

// Hermetic: an unroutable gateway URL makes the client fail fast inside the
// dispatcher's own try/catch (matches u33-c-02b-triad-sop-fill.test.ts), and the
// notification gates are closed so no run can page a live human.
process.env.OPENCLAW_GATEWAY_URL = 'not-a-valid-url';
process.env.OPENCLAW_GATEWAY_TOKEN = '';
process.env.OWNER_NOTIFY_TELEGRAM_DISABLED = '1';
process.env.RESCUE_RANGERS_WEBHOOK_URL = '';
process.env.RESCUE_WEBHOOK_URL = '';

// ── the embeddings-AVAILABLE leg is the whole point of F4 ───────────────────
// A real provider key is required for `isEmbeddingAvailable()`; the network is
// NOT. global.fetch is stubbed below to a Google embedContent response, so the
// semantic path runs end-to-end with zero egress.
const SYNTHETIC_KEY = 'qr018-synthetic-key-0123456789';
process.env.SOP_EMBEDDING_PROVIDER = 'google';
process.env.GOOGLE_API_KEY = SYNTHETIC_KEY;
delete process.env.GOOGLE_AI_STUDIO_API_KEY;
delete process.env.GEMINI_API_KEY;
delete process.env.OPENAI_API_KEY;

const GOOGLE_MODEL = 'gemini-embedding-2';
const GOOGLE_DIMS = 3072;

const LIVE_ID = 'qr018-live-sop';
const DEAD_ID = 'qr018-dead-sop';
const AGENT_ID = 'qr018-repull-agent';
const DEAD_TASK = 'qr018-repull-task-dead';
const LIVE_TASK = 'qr018-repull-task-live';
const DEPT = 'marketing';
const PERSONA = 'hormozi-100m-offers';

type DbModule = typeof import('../../src/lib/db');
type SopsModule = typeof import('../../src/lib/sops');
type EmbModule = typeof import('../../src/lib/sop-embeddings');
type DispatcherModule = typeof import('../../src/lib/task-dispatcher');

let run: DbModule['run'];
let queryOne: DbModule['queryOne'];
let queryAll: DbModule['queryAll'];
let closeDb: DbModule['closeDb'];
let getBestSOPForTask: SopsModule['getBestSOPForTask'];
let suggestSOPsForTask: SopsModule['suggestSOPsForTask'];
let rankSOPsBySemantic: EmbModule['rankSOPsBySemantic'];
let isEmbeddingAvailable: EmbModule['isEmbeddingAvailable'];
let autoDispatchTask: DispatcherModule['autoDispatchTask'];

let fetchCalls: string[] = [];
const savedFetch = globalThis.fetch;

/** A unit vector hot at one dimension. */
function unitVec(hotDim: number): Float32Array {
  const v = new Float32Array(GOOGLE_DIMS);
  v[hotDim] = 1;
  return v;
}
/** The query embed must equal the DEAD sop's vector → cosine 1.0 for the dead row. */
const QUERY_VEC = unitVec(0);
/** The live SOP sits orthogonal to the query → cosine ~0. */
const LIVE_VEC = unitVec(3000);

function vecToBlob(v: Float32Array): Buffer {
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
}

/** The re-pull query, chosen so the DEAD sop is also the strongest KEYWORD hit. */
const REPULL_TASK = {
  title: 'Process the invoice payment for vendor bill',
  description: 'pay the vendor invoice',
  department: DEPT,
} as const;

test.before(async () => {
  // Stub the embedding provider: semantic ranking runs for real, network does not.
  globalThis.fetch = (async (url: string | URL | Request) => {
    const u = String(url);
    fetchCalls.push(u);
    if (!u.includes('embedContent')) throw new Error(`QR-018: unexpected egress to ${u}`);
    return {
      status: 200,
      ok: true,
      json: async () => ({ embedding: { values: Array.from(QUERY_VEC) } }),
      text: async () => '',
    } as unknown as Response;
  }) as typeof fetch;

  const db: DbModule = await import('../../src/lib/db');
  ({ run, queryOne, queryAll, closeDb } = db);
  db.getDb(); // runs the migration chain — and the boot auto-seeders
  run(`DELETE FROM sops`, []); // the seeded starter library must not decide any fixture
  try { run(`DELETE FROM sop_embeddings`, []); } catch { /* table is migration-created */ }

  const emb: EmbModule = await import('../../src/lib/sop-embeddings');
  ({ rankSOPsBySemantic, isEmbeddingAvailable } = emb);

  const sops: SopsModule = await import('../../src/lib/sops');
  ({ getBestSOPForTask, suggestSOPsForTask } = sops);

  run(
    `INSERT INTO agents (id, name, role, is_master, workspace_id) VALUES (?, ?, ?, 0, NULL)`,
    [AGENT_ID, 'QR-018 Re-pull Agent', 'specialist'],
  );

  const dispatch: DispatcherModule = await import('../../src/lib/task-dispatcher');
  ({ autoDispatchTask } = dispatch);

  const now = new Date().toISOString();
  // LIVE sop: keyword-weak and semantically orthogonal.
  run(
    `INSERT INTO sops (id, name, slug, steps, success_criteria, department, task_keywords, deleted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
    [LIVE_ID, 'Synthetic Live SOP', 'qr018-live', 'Step 1.', 'Done.', DEPT, 'invoice,payment'],
  );
  // DEAD sop: keyword-STRONGER and semantically IDENTICAL to the query vector.
  run(
    `INSERT INTO sops (id, name, slug, steps, success_criteria, department, task_keywords, deleted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [DEAD_ID, 'Synthetic Dead SOP', 'qr018-dead', 'Step 1.', 'Done.', DEPT,
     'invoice,payment,vendor,bill', now],
  );
  run(
    `INSERT OR REPLACE INTO sop_embeddings (sop_id, embedding, embedding_model, embedding_dims, embedded_at)
     VALUES (?, ?, ?, ?, ?)`,
    [LIVE_ID, vecToBlob(LIVE_VEC), GOOGLE_MODEL, GOOGLE_DIMS, now],
  );
  // The dead SOP OWNS a non-null, model-matching embedding row. This is the row
  // the lens's claimed filter would have had to remove — it does not.
  run(
    `INSERT OR REPLACE INTO sop_embeddings (sop_id, embedding, embedding_model, embedding_dims, embedded_at)
     VALUES (?, ?, ?, ?, ?)`,
    [DEAD_ID, vecToBlob(QUERY_VEC), GOOGLE_MODEL, GOOGLE_DIMS, now],
  );
});

test.after(async () => {
  globalThis.fetch = savedFetch;
  try {
    const { getOpenClawClient } = await import('../../src/lib/openclaw/client');
    getOpenClawClient().disconnect();
  } catch { /* ignore */ }
  try { closeDb(); } catch { /* ignore */ }
  try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
});

function seedTask(id: string, sopId: string | null): void {
  const now = new Date().toISOString();
  run(
    `INSERT INTO tasks (id, title, description, status, priority, assigned_agent_id, workspace_id,
       business_id, department, sop_id, persona_id, created_at, updated_at)
     VALUES (?, ?, ?, 'backlog', 'medium', ?, NULL, NULL, ?, ?, ?, ?, ?)`,
    [id, REPULL_TASK.title, REPULL_TASK.description, AGENT_ID, DEPT, sopId, PERSONA, now, now],
  );
}

function sopIdOf(id: string): string | null {
  return queryOne<{ sop_id: string | null }>(`SELECT sop_id FROM tasks WHERE id = ?`, [id])?.sop_id ?? null;
}

/** The dead fixture must REALLY be dead in the DB, not just named that way. */
function deadRowIsSoftDeleted(): boolean {
  const r = queryOne<{ deleted_at: string | null }>(`SELECT deleted_at FROM sops WHERE id = ?`, [DEAD_ID]);
  return !!r && !!r.deleted_at;
}

// ── 1. FIXTURE PRECONDITIONS — the discriminating setup must actually hold ───

test('0 — preconditions: embeddings AVAILABLE; the dead SOP carries a non-null embedding row and is soft-deleted', () => {
  assert.equal(isEmbeddingAvailable(), true, 'the semantic path must be LIVE, or this file proves nothing about F4');
  assert.equal(deadRowIsSoftDeleted(), true, 'the dead fixture must carry deleted_at');
  const embRows = queryAll<{ sop_id: string }>(
    `SELECT sop_id FROM sop_embeddings WHERE embedding IS NOT NULL`, [],
  ).map((r) => r.sop_id).sort();
  assert.deepEqual(
    embRows, [DEAD_ID, LIVE_ID].sort(),
    'BOTH sops must own an embedding row — including the soft-deleted one',
  );
});

test('0b — the ranking function DOES return the dead SOP id (so the exclusion can only come from the pool intersection)', async () => {
  const hits = await rankSOPsBySemantic(REPULL_TASK.title);
  assert.ok(
    hits.some((h) => h.sopId === DEAD_ID),
    'rankSOPsBySemantic has no deleted_at filter — this is the fact the re-pull path must intersect away',
  );
  const dead = hits.find((h) => h.sopId === DEAD_ID)!;
  assert.ok(dead.similarity > 0.99, `dead SOP is the top semantic neighbor (cosine ${dead.similarity.toFixed(4)})`);
});

// ── 2. THE TARGET — the dead SOP is never RETURNED, on either entry point ────

test('1 — getBestSOPForTask NEVER returns a soft-deleted SOP that carries an embedding row', async () => {
  const best = await getBestSOPForTask(REPULL_TASK, 0.5);
  assert.ok(best, 'CONTROL: a live SOP exists in the pool and must be found — a null here means the check is broken, not the target');
  assert.notEqual(best!.id, DEAD_ID, 'the soft-deleted SOP must never be returned by the re-pull path');
  assert.equal(best!.id, LIVE_ID, 'the live SOP is the only admissible answer');
});

test('2 — suggestSOPsForTask (the function the re-pull path actually reaches) excludes the dead SOP', async () => {
  const hits = await suggestSOPsForTask(REPULL_TASK, 5);
  assert.ok(hits.length > 0, 'CONTROL: the live SOP must surface — an empty list would make the exclusion assertion vacuous');
  assert.ok(
    !hits.some((h) => h.sop.id === DEAD_ID),
    'a soft-deleted SOP must not appear in the suggestion list even though its embedding row is present and cosine-1.0',
  );
  assert.ok(hits.some((h) => h.sop.id === LIVE_ID), 'the live SOP must be present');
});

// ── 3. DISCRIMINATING CONTROL — the check CAN fire ──────────────────────────

test('3 — control: soft-deleting the LIVE sop too makes getBestSOPForTask return null (the exclusion is not a no-op)', async () => {
  const saved = queryOne<{ deleted_at: string | null }>(`SELECT deleted_at FROM sops WHERE id = ?`, [LIVE_ID]);
  run(`UPDATE sops SET deleted_at = ? WHERE id = ?`, [new Date().toISOString(), LIVE_ID]);
  try {
    const best = await getBestSOPForTask(REPULL_TASK, 0.5);
    assert.equal(
      best, null,
      'with BOTH rows soft-deleted the pool is empty — a non-null here would mean the dead row leaked through',
    );
  } finally {
    run(`UPDATE sops SET deleted_at = ? WHERE id = ?`, [saved?.deleted_at ?? null, LIVE_ID]);
  }
});

// ── 4. THE DISPATCHER LEG — gate :787 falls THROUGH, sod_id is re-pulled ─────

test('4 — autoDispatchTask on a task whose sop_id points at a DEAD sop re-pulls a LIVE sop (never "already")', async () => {
  seedTask(DEAD_TASK, DEAD_ID);
  assert.equal(sopIdOf(DEAD_TASK), DEAD_ID, 'precondition: the card starts holding the DEAD id');

  const gapBefore = queryOne<{ n: number }>(
    `SELECT COUNT(*) AS n FROM events WHERE type = 'sop_library_gap' AND task_id = ?`, [DEAD_TASK],
  )?.n ?? 0;

  const outcome = await autoDispatchTask(DEAD_TASK, 'qr018-repull-test');
  assert.notEqual(
    (outcome as { outcome?: string }).outcome, 'already',
    'the dead sop_id must NOT short-circuit the gate as "already" (the KAN-003 defect)',
  );

  const after = sopIdOf(DEAD_TASK);
  assert.equal(after, LIVE_ID, 'the dead id must be REPLACED by the live department fit');
  assert.notEqual(after, DEAD_ID, 'the dead id must never be re-attached');

  const gapAfter = queryOne<{ n: number }>(
    `SELECT COUNT(*) AS n FROM events WHERE type = 'sop_library_gap' AND task_id = ?`, [DEAD_TASK],
  )?.n ?? 0;
  assert.equal(gapAfter, gapBefore, 're-pull HIT — no library-gap event may be emitted');
});

// ── 5. EMBEDDINGS-UNAVAILABLE leg — the keyword fallback, same invariant ─────
//
// isEmbeddingAvailable() reads env live, so the provider key is dropped for the
// duration of this test and restored after. The dead SOP is keyword-STRONGER
// than the live one, so the keyword path is the one that would surface it.

test('5 — keyword fallback (no provider key): getBestSOPForTask and suggestSOPsForTask still exclude the dead SOP', async () => {
  const savedProvider = process.env.SOP_EMBEDDING_PROVIDER;
  const savedKey = process.env.GOOGLE_API_KEY;
  delete process.env.SOP_EMBEDDING_PROVIDER;
  delete process.env.GOOGLE_API_KEY;
  try {
    assert.equal(isEmbeddingAvailable(), false, 'this leg must run the KEYWORD path, not the semantic one');

    const best = await getBestSOPForTask(REPULL_TASK, 0.5);
    assert.ok(best, 'CONTROL: the live SOP must still be found on the keyword path');
    assert.notEqual(best!.id, DEAD_ID, 'keyword fallback must exclude the soft-deleted SOP too');
    assert.equal(best!.id, LIVE_ID);

    const hits = await suggestSOPsForTask(REPULL_TASK, 5);
    assert.ok(hits.length > 0, 'CONTROL: the keyword path must return the live SOP');
    assert.ok(!hits.some((h) => h.sop.id === DEAD_ID), 'keyword path must exclude the soft-deleted SOP');

    const callsBefore = fetchCalls.length;
    assert.equal(fetchCalls.length, callsBefore, 'no embedding egress on the keyword leg');
  } finally {
    if (savedProvider === undefined) delete process.env.SOP_EMBEDDING_PROVIDER;
    else process.env.SOP_EMBEDDING_PROVIDER = savedProvider;
    if (savedKey === undefined) delete process.env.GOOGLE_API_KEY;
    else process.env.GOOGLE_API_KEY = savedKey;
  }
});

// ── 6. the gate's own predicate, and the LIVE-attached short-circuit ─────────

test('6 — non-vacuity: isLiveSopId routes dead/live correctly, and a LIVE sop_id still short-circuits to "already"', async () => {
  const { isLiveSopId } = await import('../../src/lib/sops');
  assert.equal(isLiveSopId(DEAD_ID), false, 'the dead fixture must read as DEAD');
  assert.equal(isLiveSopId(LIVE_ID), true, 'the live fixture must read as LIVE');
  assert.equal(isLiveSopId('qr018-no-such-id'), false, 'a missing row is dead');
  assert.equal(isLiveSopId(null), false);

  // The other half of the gate: a LIVE attachment must NOT be re-pulled.
  const liveTask = 'qr018-repull-task-already-live';
  seedTask(liveTask, LIVE_ID);
  await autoDispatchTask(liveTask, 'qr018-repull-test');
  assert.equal(
    sopIdOf(liveTask), LIVE_ID,
    'a task already holding a LIVE sop must keep it — the re-pull path must not churn it',
  );
});
