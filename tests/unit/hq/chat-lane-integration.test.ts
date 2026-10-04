/**
 * Chat-lane integration seat — the REAL seam between B10's route family and B09's
 * service, with no private stub in the path.
 *
 * Why this file exists: B10's routes.test.ts resolves `@/lib/hq/chat` to
 * `_stubs/chat.ts` through its own tsconfig path map, so it proves the routes' own
 * decisions but can never catch the two units disagreeing about the module's real
 * surface. At main tip they did: the routes imported six Hq-prefixed service functions
 * that `src/lib/hq/chat.ts` did not export, and `tsc --noEmit` was red with 9x TS2724.
 * This file imports the same module the SHIPPED routes import, so a future divergence
 * fails here rather than in the merge train.
 *
 * Isolation: `_isolated-db` is imported FIRST (throwaway DB, C8 guard never opens the
 * live board). B01's migration 169 runs on that throwaway DB through the normal
 * `getDb()` path, so the DDL under test is the real landed migration, not a fixture.
 *
 * Scope: the seam's own decisions — binding resolution, the 404/410 ownership gate,
 * the turn page cursor, and the fact that every outcome the routes publish really is
 * an `{ok,status,code,message}` envelope. The state machine's own semantics are B09's
 * 18-test file; this file does not repeat them.
 */

import '../_isolated-db';

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run, queryOne } from '../../../src/lib/db';
import {
  createHqSession,
  getHqSession,
  listHqTurns,
  createHqTurn,
  getHqTurn,
  retryHqTurn,
  createSession,
  type HqChatServiceCtx,
} from '../../../src/lib/hq/chat';

const ctx: HqChatServiceCtx = {
  companyId: 'co-seam',
  ownerSubject: 'owner:seam',
  installationId: 'inst-seam',
};

const otherCtx: HqChatServiceCtx = { ...ctx, companyId: 'co-other' };
const otherOwner: HqChatServiceCtx = { ...ctx, ownerSubject: 'owner:other' };

/**
 * A real OpenClaw runtime root for THIS process, so the binding resolver's own probe
 * (registry entry + runtime directory) can actually succeed. It is never pointed at the
 * live box: the directory holds only the fixture's own runtime ids.
 */
const RUNTIME_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-seam-runtime-'));
const RUNTIME_IDS = ['rt-happy', 'rt-a', 'rt-b', 'rt-page'];

fs.writeFileSync(
  path.join(RUNTIME_ROOT, 'openclaw.json'),
  JSON.stringify({ agents: { entries: Object.fromEntries(RUNTIME_IDS.map((id) => [id, { id }])) } }),
);
for (const id of RUNTIME_IDS) fs.mkdirSync(path.join(RUNTIME_ROOT, 'agents', id), { recursive: true });
process.env.OPENCLAW_ROOT = RUNTIME_ROOT;

process.on('exit', () => {
  try {
    fs.rmSync(RUNTIME_ROOT, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

/** Insert a real agents + workspaces row so the binding resolver has something to read. */
function seedHead(companyId: string, headAgentId: string, openclawAgentId: string | null): string {
  const wsId = `ws-${headAgentId}`;
  // workspaces.company_id REFERENCES companies(id) — the company row is the FK parent.
  run(`INSERT OR IGNORE INTO companies (id, name, slug) VALUES (?, ?, ?)`, [
    companyId,
    `Company ${companyId}`,
    `co-${companyId}`,
  ]);
  run(`INSERT OR REPLACE INTO workspaces (id, name, slug, company_id) VALUES (?, ?, ?, ?)`, [
    wsId,
    `Workspace ${headAgentId}`,
    `ws-${headAgentId}`,
    companyId,
  ]);
  run(
    `INSERT OR REPLACE INTO agents (id, name, role, avatar_emoji, status, is_master, workspace_id, openclaw_agent_id)
     VALUES (?, ?, ?, '🧪', 'standby', 0, ?, ?)`,
    [headAgentId, `Agent ${headAgentId}`, 'seam-role', wsId, openclawAgentId],
  );
  return wsId;
}

test('seam: a head with no runtime binding is 409 runtime_unavailable, never a session row', async () => {
  seedHead(ctx.companyId, 'head-unbound', null);
  const result = await createHqSession(ctx, 'head-unbound');

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.status, 409);
  assert.equal(result.code, 'runtime_unavailable');
  const rows = queryOne<{ n: number }>(`SELECT COUNT(*) AS n FROM hq_chat_sessions WHERE head_agent_id = ?`, [
    'head-unbound',
  ]);
  assert.equal(rows?.n, 0, 'a refused create must not leave a session row');
});

test('seam: a head from ANOTHER company is refused, not resolved', async () => {
  seedHead('co-different', 'head-foreign', null);
  const result = await createHqSession(ctx, 'head-foreign');

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.status, 409);
  assert.equal(result.code, 'runtime_unavailable');
});

test('seam: the ownership gate answers 404 foreign, 410 closed, and both are envelopes', async () => {
  // A session owned by someone else in the same company: not found, never readable.
  const foreign = createSession(
    { companyId: ctx.companyId, ownerSubject: 'owner:someone-else', installationId: ctx.installationId },
    { headAgentId: 'head-seam', runtimeAgentId: 'rt-seam' },
  );

  const missing = await getHqSession(ctx, 'no-such-session');
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.equal(missing.status, 404);

  const notMine = await getHqSession(ctx, foreign.id);
  assert.equal(notMine.ok, false);
  if (!notMine.ok) {
    assert.equal(notMine.status, 404);
    assert.equal(notMine.message, missing.ok ? '' : missing.message, 'foreign and unknown are one shape');
  }

  // A closed (expired) session owned by the caller: 410, distinguishable by the route.
  run(`UPDATE hq_chat_sessions SET closed_at = ? WHERE id = ?`, ['2026-01-01T00:00:00.000Z', foreign.id]);
  const closed = await getHqSession(
    { companyId: ctx.companyId, ownerSubject: 'owner:someone-else', installationId: ctx.installationId },
    foreign.id,
  );
  assert.equal(closed.ok, false);
  if (!closed.ok) assert.equal(closed.status, 410);
});

test('seam: createHqTurn refuses a foreign session BEFORE any dedupe path', async () => {
  const foreign = createSession(
    { companyId: ctx.companyId, ownerSubject: 'owner:not-me', installationId: ctx.installationId },
    { headAgentId: 'head-seam', runtimeAgentId: 'rt-seam' },
  );

  const result = await createHqTurn(ctx, foreign.id, { clientRequestId: 'req-seam-1', message: 'hello' });

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.status, 404);
  // The foreign turn must not exist even as a queued row.
  const turns = queryOne<{ n: number }>(`SELECT COUNT(*) AS n FROM hq_chat_turns WHERE session_id = ?`, [foreign.id]);
  assert.equal(turns?.n, 0);
});

test('seam: the full happy path — create, send, read, and every reply is an envelope', async () => {
  seedHead(ctx.companyId, 'head-happy', 'rt-happy');

  // Creation resolves the head's runtime from the registry + runtime dir.
  const created = await createHqSession(ctx, 'head-happy');
  assert.equal(created.ok, true);
  if (!created.ok) return;
  const sessionId = created.session.id;
  assert.equal(created.session.headAgentId, 'head-happy');

  const gate = await getHqSession(ctx, sessionId);
  assert.equal(gate.ok, true);
  if (!gate.ok) return;
  assert.equal(gate.session.id, sessionId);

  // Same head, same binding → the turn is accepted and queued.
  const turn = await createHqTurn(ctx, sessionId, { clientRequestId: 'req-happy-1', message: 'first' });
  assert.equal(turn.ok, true);
  if (!turn.ok) return;
  assert.equal(turn.duplicate, false);
  assert.equal(turn.turn.state, 'queued');

  // An identical re-send is the same turn, not a second one.
  const again = await createHqTurn(ctx, sessionId, { clientRequestId: 'req-happy-1', message: 'first' });
  assert.equal(again.ok, true);
  if (!again.ok) return;
  assert.equal(again.duplicate, true);
  assert.equal(again.turn.id, turn.turn.id);

  // The turn reads back through the page reader and the single-turn reader.
  const page = await listHqTurns(ctx, sessionId, { limit: 50 });
  assert.equal(page.ok, true);
  if (!page.ok) return;
  assert.deepEqual(
    page.turns.map((t) => t.id),
    [turn.turn.id],
  );

  const read = await getHqTurn(ctx, sessionId, turn.turn.id);
  assert.equal(read.ok, true);
  if (!read.ok) return;
  assert.equal(read.turn.message, 'first');
  assert.equal(read.turn.state, 'queued');

  // Changed content under the same request key is a conflict, not a new turn.
  const conflict = await createHqTurn(ctx, sessionId, { clientRequestId: 'req-happy-1', message: 'different' });
  assert.equal(conflict.ok, false);
  if (!conflict.ok) assert.equal(conflict.code, 'request_conflict');

  // A retry of a turn that was never positively-unsent is refused by the state machine.
  const retry = await retryHqTurn(ctx, sessionId, turn.turn.id);
  assert.equal(retry.ok, false);
  if (!retry.ok) assert.equal(retry.status, 409);

  // Unknown ids are 404 in the same shape, never a throw.
  const noTurn = await getHqTurn(ctx, sessionId, 'no-such-turn');
  assert.equal(noTurn.ok, false);
  if (!noTurn.ok) assert.equal(noTurn.status, 404);

  const noRetry = await retryHqTurn(ctx, sessionId, 'no-such-turn');
  assert.equal(noRetry.ok, false);
  if (!noRetry.ok) assert.equal(noRetry.status, 404);
});

test('seam: a turn is never readable through a session that does not own it', async () => {
  const a = createSession(
    { companyId: ctx.companyId, ownerSubject: ctx.ownerSubject, installationId: ctx.installationId },
    { headAgentId: 'head-a', runtimeAgentId: 'rt-a' },
  );
  const b = createSession(
    { companyId: ctx.companyId, ownerSubject: ctx.ownerSubject, installationId: ctx.installationId },
    { headAgentId: 'head-b', runtimeAgentId: 'rt-b' },
  );

  // A queued turn that genuinely belongs to A.
  run(
    `INSERT INTO hq_chat_turns
       (id, company_id, session_id, owner_subject, client_request_id, payload_hash, message_text, state,
        attempts, created_at, updated_at)
     VALUES ('turn-a', ?, ?, ?, 'req-a', 'hash-a', 'secret', 'queued', 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
    [ctx.companyId, a.id, ctx.ownerSubject],
  );

  const ownRead = await getHqTurn(ctx, a.id, 'turn-a');
  assert.equal(ownRead.ok, true);

  // Same owner, same company, WRONG session: the turn id alone must not open it.
  const leaked = await getHqTurn(ctx, b.id, 'turn-a');
  assert.equal(leaked.ok, false);
  if (!leaked.ok) assert.equal(leaked.status, 404);

  // And the wrong owner in the right company cannot reach either session.
  const otherOwnerGate = await getHqSession(otherOwner, a.id);
  assert.equal(otherOwnerGate.ok, false);
  if (!otherOwnerGate.ok) assert.equal(otherOwnerGate.status, 404);

  // Another company is likewise not a reader.
  const otherCompanyGate = await getHqSession(otherCtx, a.id);
  assert.equal(otherCompanyGate.ok, false);
  if (!otherCompanyGate.ok) assert.equal(otherCompanyGate.status, 404);
});

test('seam: the turn page pages newest-first with a working before cursor', async () => {
  const s = createSession(
    { companyId: ctx.companyId, ownerSubject: ctx.ownerSubject, installationId: ctx.installationId },
    { headAgentId: 'head-page', runtimeAgentId: 'rt-page' },
  );

  // Terminal states: the partial unique index allows exactly one NONTERMINAL turn per
  // session (S6), so a multi-turn page is built from settled turns.
  for (const [i, id] of ['t1', 't2', 't3'].entries()) {
    run(
      `INSERT INTO hq_chat_turns
         (id, company_id, session_id, owner_subject, client_request_id, payload_hash, message_text, state,
          attempts, created_at, updated_at, terminal_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'replied', 1, ?, ?, ?)`,
      [
        id,
        ctx.companyId,
        s.id,
        ctx.ownerSubject,
        `req-${id}`,
        `hash-${id}`,
        `msg ${i}`,
        `2026-01-0${i + 1}T00:00:00.000Z`,
        `2026-01-0${i + 1}T00:00:00.000Z`,
        `2026-01-0${i + 1}T00:00:01.000Z`,
      ],
    );
  }

  const first = await listHqTurns(ctx, s.id, { limit: 2 });
  assert.equal(first.ok, true);
  if (!first.ok) return;
  assert.deepEqual(
    first.turns.map((t) => t.id),
    ['t3', 't2'],
    'newest first',
  );
  assert.equal(first.hasMore, true);
  assert.equal(first.nextBefore, 't2');

  const second = await listHqTurns(ctx, s.id, { limit: 2, before: first.nextBefore ?? undefined });
  assert.equal(second.ok, true);
  if (!second.ok) return;
  assert.deepEqual(
    second.turns.map((t) => t.id),
    ['t1'],
    'the cursor is exclusive',
  );
  assert.equal(second.hasMore, false);

  // A foreign/unknown cursor id cannot move the page outside this session: it is a miss,
  // and the page still answers with the caller's own newest rows.
  const bogus = await listHqTurns(ctx, s.id, { limit: 2, before: 'turn-of-someone-else' });
  assert.equal(bogus.ok, true);
  if (!bogus.ok) return;
  assert.deepEqual(
    bogus.turns.map((t) => t.id),
    ['t3', 't2'],
  );
});
