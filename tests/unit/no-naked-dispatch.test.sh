#!/usr/bin/env bash
#
# no-naked-dispatch.test.sh — the F3.1 no-naked-tasks CONTRACT test (FDN-2).
#
# The invariant under test: NO task is ever dispatched with a NULL persona, across
# every enumerable persona-less path (A1-A7 from the Persona-Matching analysis).
# This is an enforced invariant, not hope — it drives the real CC code
# (resolvePersonaAndPin, ensurePersonaForDispatch, resolveSettings) against a
# throwaway fixture DB, using the built-in PERSONA_FIXTURE_JSON escape hatch to
# simulate each selector outcome without spawning Python.
#
# Paths exercised:
#   A1  empty persona universe    (selector returns nothing)  -> fallback pin, NOT naked
#   A3  selector spawn failure    (null result)               -> fallback pin, NOT naked
#   A4  create-time fire-and-forget miss / legacy backlog card -> backfill/gate heal
#   A2  mechanical no_persona_required                         -> NULL by design + governance pointer
#   A5  dispatch reads task.persona_id (delivered, not decoration)
#   A6/A7 subtask/doctrine variants of A1/A2 -> same CC guarantee via the fallback chain
#
# PASS iff: exit 0 and 0 non-mechanical tasks remain persona-less.
#
# Wireable into CI (qc-cc): `bash tests/unit/no-naked-dispatch.test.sh`.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/no-naked-dispatch.XXXXXX")"
DRIVER="$TMP_DIR/driver.mts"

cleanup() { rm -rf "$TMP_DIR"; }
trap cleanup EXIT

export DATABASE_PATH="$TMP_DIR/no-naked.test.db"
export REPO_ROOT
# Never let a stale fixture from the caller's shell leak in.
unset PERSONA_FIXTURE_JSON || true

cat > "$DRIVER" <<'TS'
import test from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

const ROOT = process.env.REPO_ROOT as string;
const imp = (rel: string) => import(pathToFileURL(join(ROOT, rel)).href);

type DbMod = typeof import('../../src/lib/db');
type TasksMod = typeof import('../../src/lib/tasks');
type ResolverMod = typeof import('../../src/lib/intelligence-resolver');

let db: DbMod;
let tasks: TasksMod;
let resolver: ResolverMod;

let n = 0;
const nextId = (p: string) => `${p}-${++n}`;

function insertBacklog(id: string) {
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO tasks (id, title, description, status, priority, workspace_id, business_id, department, created_at, updated_at)
     VALUES (?, ?, ?, 'backlog', 'medium', NULL, NULL, 'marketing', ?, ?)`,
    [id, `Naked-path task ${id}`, 'A deliverable that needs a persona', now, now],
  );
}

test.before(async () => {
  db = (await imp('src/lib/db/index.ts')) as DbMod;
  db.getDb(); // run the migration chain (persona columns, persona_fallback, etc.)
  tasks = (await imp('src/lib/tasks.ts')) as TasksMod;
  resolver = (await imp('src/lib/intelligence-resolver.ts')) as ResolverMod;
});

test.after(() => {
  delete process.env.PERSONA_FIXTURE_JSON;
  try { db.closeDb(); } catch { /* ignore */ }
});

// ── A1 / A3 / A4: selector yields nothing → deterministic fallback pin ────────
test('[A1/A3/A4] persona-less selection result heals to a non-null persona (never naked)', async () => {
  process.env.PERSONA_FIXTURE_JSON = '{}'; // empty universe / spawn failure / null
  const id = nextId('naked');
  insertBacklog(id);

  const pinned = await tasks.resolvePersonaAndPin(id, 'Marketing launch email', 'marketing');
  delete process.env.PERSONA_FIXTURE_JSON;

  assert.ok(pinned, 'resolvePersonaAndPin must return a non-null persona on selector failure');
  const row = db.queryOne<{ persona_id: string | null; persona_fallback: number | null }>(
    'SELECT persona_id, persona_fallback FROM tasks WHERE id = ?',
    [id],
  );
  assert.ok(row?.persona_id, 'task.persona_id must be pinned (not naked)');
  assert.equal(row?.persona_fallback, 1, 'fallback pin must be flagged for audit');
});

// ── A2: mechanical no_persona_required stays NULL by design + governance pointer ─
test('[A2] no_persona_required stays personaless by design and records a governance pointer', async () => {
  process.env.PERSONA_FIXTURE_JSON = JSON.stringify({ no_persona_required: true });
  const id = nextId('mech');
  insertBacklog(id);

  const pinned = await tasks.resolvePersonaAndPin(id, 'chmod +x deploy.sh', 'engineering');
  delete process.env.PERSONA_FIXTURE_JSON;

  assert.equal(pinned, null, 'no_persona_required must return null (intentional)');
  const row = db.queryOne<{ persona_id: string | null }>('SELECT persona_id FROM tasks WHERE id = ?', [id]);
  assert.equal(row?.persona_id, null, 'mechanical task persona_id stays NULL by design');

  const gov = db.queryOne<{ message: string }>(
    `SELECT message FROM events WHERE task_id = ? AND type = 'persona_governance' LIMIT 1`,
    [id],
  );
  assert.ok(gov, 'a governance oversight pointer must be recorded for the mechanical task');
  assert.ok(gov.message.includes('[PERSONA-GOVERNANCE]'), 'governance event must carry the marker');
});

// ── A4: synchronous dispatch gate heals a naked task (heal, not stall) ────────
test('[A4] ensurePersonaForDispatch heals a naked task at dispatch time', () => {
  const id = nextId('gate');
  insertBacklog(id); // no persona pinned

  const healed = tasks.ensurePersonaForDispatch(id, 'marketing');
  assert.ok(healed.persona_id, 'dispatch gate must resolve a persona');
  assert.equal(healed.healed, true, 'a naked task must be reported as healed');

  const row = db.queryOne<{ persona_id: string | null }>('SELECT persona_id FROM tasks WHERE id = ?', [id]);
  assert.equal(row?.persona_id, healed.persona_id, 'the gate must persist the healed persona onto the task');
});

// ── A5: dispatch delivers task.persona_id (already-pinned persona, not 'auto') ─
test('[A5] a pinned persona is delivered to dispatch (not the AUTO-SELECT decoration)', async () => {
  process.env.PERSONA_FIXTURE_JSON = JSON.stringify({
    persona_id: 'hormozi-100m-offers',
    persona_name: 'Alex Hormozi',
    score: 0.91,
    interaction_mode: 'leadership',
  });
  const id = nextId('pinned');
  insertBacklog(id);
  await tasks.resolvePersonaAndPin(id, 'Write a $100M offer', 'marketing');
  delete process.env.PERSONA_FIXTURE_JSON;

  const row = db.queryOne<{ persona_id: string | null }>('SELECT persona_id FROM tasks WHERE id = ?', [id]);
  assert.equal(row?.persona_id, 'hormozi-100m-offers', 'matched persona must be pinned on the task');

  // resolveSettings (what the dispatcher reads) must surface the pinned persona,
  // NEVER the 'auto' self-select sentinel. This proves the F4.1 delivery contract:
  // the doer receives task.persona_id, not a self-select decoration.
  const settings = resolver.resolveSettings('agent-does-not-exist', 'marketing', id);
  assert.equal(settings.persona, 'Alex Hormozi', 'dispatch must deliver the pinned persona');
  assert.notEqual(settings.persona, 'auto', 'dispatch must NOT fall back to AUTO-SELECT for a pinned task');

  // The gate is a no-op for an already-pinned task.
  const gate = tasks.ensurePersonaForDispatch(id, 'marketing');
  assert.equal(gate.healed, false, 'already-pinned task must not be re-healed');
  assert.equal(gate.persona_id, 'hormozi-100m-offers', 'gate returns the existing pin unchanged');
});

// ── GLOBAL INVARIANT: zero non-mechanical tasks remain persona-less ───────────
test('[INVARIANT] no non-mechanical task is left persona-less', () => {
  // Every task that is NOT explicitly mechanical (no persona_governance event)
  // must carry a persona. Mechanical tasks are excluded — they are NULL by design.
  const naked = db.queryAll<{ id: string }>(
    `SELECT t.id AS id
       FROM tasks t
      WHERE (t.persona_id IS NULL OR t.persona_id = '')
        AND NOT EXISTS (
          SELECT 1 FROM events e WHERE e.task_id = t.id AND e.type = 'persona_governance'
        )`,
    [],
  );
  assert.equal(naked.length, 0, `expected 0 naked non-mechanical tasks, found ${naked.length}: ${naked.map((r) => r.id).join(', ')}`);
});
TS

echo "[no-naked-dispatch] driving A1-A7 CC persona invariant against fixture DB at $DATABASE_PATH"
cd "$REPO_ROOT"
node --import tsx --test "$DRIVER"
echo "[no-naked-dispatch] PASS — no naked-dispatch path found"
