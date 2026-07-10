/**
 * Unit tests for the Anthology board door (SPEC B10 / Gap G8):
 *   • the bridge functions boardStatus() / decideBoard()
 *     (src/app/participant/_lib/gate-engine.ts)
 *   • the session-gated route GET/POST /api/anthology/gate
 *     (src/app/api/anthology/gate/route.ts)
 *
 * STRATEGY — a FAKE ENGINE, not a mock. The bridge honours two env overrides
 * (ANTHOLOGY_GATE_ENGINE = script path, ANTHOLOGY_PYTHON_BIN = interpreter), so we
 * point them at `node <fake-gate-engine.cjs>`. The fake RECORDS the exact argv it
 * received (proving --door board, --producer-id, --reason presence/absence and
 * secret non-leakage) and emits a canned JSON line + exit code, letting us drive
 * the REAL execFileSync → runGateEngine → exit-code-map path end to end without the
 * deployed Python engine or the live DB. The exit codes mirror gate_engine.py's
 * house convention (0 ok / 2 refuse / 3 gate-held), which is what the bridge maps.
 *
 * The full LIVE integration (real gate_engine.py + real mirror DB writing a ledger
 * row with door=dashboard) is deferred to the U15 operator-box canary — it needs
 * the deployed engine + a seeded mirror, which this unit deliberately does not
 * touch.
 *
 * Runs via the Node built-in test runner under tsx (`npm run test:unit`).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NextRequest } from 'next/server';

import { boardStatus, decideBoard } from '../../src/app/participant/_lib/gate-engine';
import { GET, POST } from '../../src/app/api/anthology/gate/route';

// ── Fake engine harness (set BEFORE any bridge call; read at call-time) ────────
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-anthology-gate-'));
const FAKE_ENGINE = path.join(TMP, 'fake-gate-engine.cjs');
const ARGV_LOG = path.join(TMP, 'argv.json');

const FAKE_SRC = `
const fs = require('fs');
try {
  const log = process.env.FAKE_ENGINE_ARGV_LOG;
  if (log) fs.writeFileSync(log, JSON.stringify(process.argv));
} catch (_) { /* ignore */ }
const out = process.env.FAKE_ENGINE_STDOUT || '';
if (out) process.stdout.write(out + '\\n');
const code = Number.parseInt(process.env.FAKE_ENGINE_EXIT || '0', 10);
process.exit(Number.isNaN(code) ? 0 : code);
`;
fs.writeFileSync(FAKE_ENGINE, FAKE_SRC);

process.env.ANTHOLOGY_GATE_ENGINE = FAKE_ENGINE;
process.env.ANTHOLOGY_PYTHON_BIN = process.execPath;
process.env.FAKE_ENGINE_ARGV_LOG = ARGV_LOG;

/** Program the fake engine's next response and clear the argv log. */
function setEngine(stdoutObj: unknown, exitCode: number): void {
  process.env.FAKE_ENGINE_STDOUT = stdoutObj == null ? '' : JSON.stringify(stdoutObj);
  process.env.FAKE_ENGINE_EXIT = String(exitCode);
  try {
    fs.rmSync(ARGV_LOG, { force: true });
  } catch {
    /* ignore */
  }
}

/** The argv the fake engine was invoked with (throws if it was never shelled). */
function readArgv(): string[] {
  return JSON.parse(fs.readFileSync(ARGV_LOG, 'utf8')) as string[];
}

function valueAfter(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

function postReq(body: unknown, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest('http://localhost/api/anthology/gate', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

function getReq(subjectKey?: string): NextRequest {
  const url =
    subjectKey === undefined
      ? 'http://localhost/api/anthology/gate'
      : `http://localhost/api/anthology/gate?subjectKey=${encodeURIComponent(subjectKey)}`;
  return new NextRequest(url, { method: 'GET' });
}

const PARTICIPANT_KEY = 'contactSYN0001::ANTHsyn0001';
const ANTHOLOGY_ID = 'ANTHsyn0001';

// ─────────────────────────────────────────────────────────────────────────────
// boardStatus() — read-only, authoritative action set.
// ─────────────────────────────────────────────────────────────────────────────

test('boardStatus: producer gate → open gate + authoritative action set (door only)', () => {
  setEngine(
    {
      ok: true,
      action: 'status',
      subject_key: PARTICIPANT_KEY,
      kind: 'participant',
      open_gate: 's1_producer',
      actor: 'producer',
      doors: ['board'],
      actions: ['approve', 'hold', 'exclude', 'escalate'],
    },
    0,
  );
  const s = boardStatus(PARTICIPANT_KEY);
  assert.equal(s.ok, true);
  if (!s.ok) return;
  assert.equal(s.openGate, 's1_producer');
  assert.equal(s.kind, 'participant');
  assert.deepEqual(s.actions, ['approve', 'hold', 'exclude', 'escalate']);
  assert.deepEqual(s.doors, ['board']);
  // shelled `status --json --subject-key <k>`, no decision args.
  const argv = readArgv();
  assert.ok(argv.includes('status'));
  assert.equal(valueAfter(argv, '--subject-key'), PARTICIPANT_KEY);
  assert.ok(!argv.includes('--door'));
});

test('boardStatus: unknown subject (exit 3 + reason) → unknown_subject', () => {
  setEngine(
    { ok: false, action: 'status', subject_key: 'nope', open_gate: null, reason: 'unknown_subject' },
    3,
  );
  const s = boardStatus('nope');
  assert.equal(s.ok, false);
  if (s.ok) return;
  assert.equal(s.reason, 'unknown_subject');
});

test('boardStatus: engine held / no JSON (exit 3, empty stdout) → not_ready', () => {
  setEngine(null, 3);
  const s = boardStatus(ANTHOLOGY_ID);
  assert.equal(s.ok, false);
  if (s.ok) return;
  assert.equal(s.reason, 'not_ready');
});

// ─────────────────────────────────────────────────────────────────────────────
// decideBoard() — the second door: --door board, exit-code map, secret hygiene.
// ─────────────────────────────────────────────────────────────────────────────

test('decideBoard: producer approve → committed:true, door=dashboard; argv carries --door board', () => {
  setEngine(
    {
      action: 'decide',
      subject_key: PARTICIPANT_KEY,
      door: 'dashboard',
      gate: 's1_producer',
      decision: 'approve',
      ok: true,
      committed: true,
      approval_id: 'appr_123',
      stage_cursor: 's2_gate',
      noop: false,
    },
    0,
  );
  const r = decideBoard(PARTICIPANT_KEY, 'approve', {});
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.committed, true);
  assert.equal(r.door, 'dashboard');
  assert.equal(r.gate, 's1_producer');
  assert.equal(r.decision, 'approve');
  assert.equal(r.approvalId, 'appr_123');
  assert.equal(r.stageCursor, 's2_gate');

  const argv = readArgv();
  assert.equal(valueAfter(argv, '--door'), 'board');
  assert.equal(valueAfter(argv, '--action'), 'approve');
  assert.equal(valueAfter(argv, '--subject-key'), PARTICIPANT_KEY);
  assert.ok(argv.includes('decide'));
});

test('decideBoard: exit-code map — EX_REFUSE(2)=refused/not-held, EX_GATE(3)=held', () => {
  setEngine({ ok: false, action: 'decide', reason: 'missing_fields', fields: ['reason'] }, 2);
  const refuse = decideBoard(PARTICIPANT_KEY, 'hold', {});
  assert.equal(refuse.ok, false);
  if (refuse.ok) return;
  assert.equal(refuse.reason, 'missing_fields');
  assert.equal(refuse.held, false);
  assert.deepEqual(refuse.fields, ['reason']);

  setEngine({ ok: false, action: 'decide', reason: 'no_open_gate' }, 3);
  const held = decideBoard(PARTICIPANT_KEY, 'approve', {});
  assert.equal(held.ok, false);
  if (held.ok) return;
  assert.equal(held.reason, 'no_open_gate');
  assert.equal(held.held, true);
});

test('decideBoard: hold WITHOUT reason never fabricates --reason (engine enforces missing_fields)', () => {
  setEngine({ ok: false, action: 'decide', reason: 'missing_fields', fields: ['reason'] }, 2);
  decideBoard(PARTICIPANT_KEY, 'hold', {});
  const argv = readArgv();
  assert.ok(!argv.includes('--reason'), 'route must not synthesise a --reason it was not given');
});

test('decideBoard: S9 ready_to_assemble carries --confirm-name and --producer-id', () => {
  setEngine(
    {
      action: 'decide',
      subject_key: ANTHOLOGY_ID,
      door: 'dashboard',
      gate: 's9_ready',
      decision: 'ready_to_assemble',
      ok: true,
      committed: true,
    },
    0,
  );
  const r = decideBoard(ANTHOLOGY_ID, 'ready_to_assemble', {
    confirmName: 'Voices of Resilience',
    producerId: 'producer@example.com',
  });
  assert.equal(r.ok, true);
  const argv = readArgv();
  assert.equal(valueAfter(argv, '--confirm-name'), 'Voices of Resilience');
  assert.equal(valueAfter(argv, '--producer-id'), 'producer@example.com');
});

test('decideBoard: NEVER puts ANTHOLOGY_GATE_TOKEN_SECRET on the argv', () => {
  const SECRET = 'SUPER-SECRET-NEVER-LEAK-abc123';
  const prev = process.env.ANTHOLOGY_GATE_TOKEN_SECRET;
  process.env.ANTHOLOGY_GATE_TOKEN_SECRET = SECRET;
  try {
    setEngine(
      { action: 'decide', ok: true, committed: true, door: 'dashboard', gate: 's1_producer', decision: 'approve' },
      0,
    );
    decideBoard(PARTICIPANT_KEY, 'approve', { producerId: 'p@x.com' });
    const raw = fs.readFileSync(ARGV_LOG, 'utf8');
    assert.ok(!raw.includes(SECRET), 'the gate-token secret must never appear on the engine argv');
  } finally {
    if (prev === undefined) delete process.env.ANTHOLOGY_GATE_TOKEN_SECRET;
    else process.env.ANTHOLOGY_GATE_TOKEN_SECRET = prev;
  }
});

test('decideBoard: never surfaces the engine raw `detail` plumbing', () => {
  setEngine(
    {
      action: 'decide',
      ok: false,
      committed: false,
      reason: 'validation_mismatch',
      detail: '/data/.openclaw/skills/59-anthology-engine/state/mirror.sqlite typed-name mismatch',
    },
    2,
  );
  const r = decideBoard(ANTHOLOGY_ID, 'ready_to_assemble', { confirmName: 'wrong', producerId: 'p@x.com' });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.reason, 'validation_mismatch');
  assert.ok(!('detail' in r), 'the engine `detail` (may echo a file path) must not cross back');
});

// ─────────────────────────────────────────────────────────────────────────────
// Route: POST/GET /api/anthology/gate.
// ─────────────────────────────────────────────────────────────────────────────

test('POST: valid producer approve → 200 committed:true, door=dashboard', async () => {
  setEngine(
    {
      action: 'decide',
      subject_key: PARTICIPANT_KEY,
      door: 'dashboard',
      gate: 's1_producer',
      decision: 'approve',
      ok: true,
      committed: true,
      approval_id: 'appr_777',
    },
    0,
  );
  const res = await POST(postReq({ subjectKey: PARTICIPANT_KEY, action: 'approve' }));
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.ok, true);
  assert.equal(json.committed, true);
  assert.equal(json.door, 'dashboard');
});

test('POST: hold without reason → 422 missing_fields (engine authoritative)', async () => {
  setEngine({ ok: false, action: 'decide', reason: 'missing_fields', fields: ['reason'] }, 2);
  const res = await POST(postReq({ subjectKey: PARTICIPANT_KEY, action: 'hold' }));
  assert.equal(res.status, 422);
  const json = await res.json();
  assert.equal(json.ok, false);
  assert.equal(json.reason, 'missing_fields');
  assert.deepEqual(json.fields, ['reason']);
});

test('POST: action=done → 403, engine NEVER shelled', async () => {
  setEngine(null, 0);
  const res = await POST(postReq({ subjectKey: PARTICIPANT_KEY, action: 'done' }));
  assert.equal(res.status, 403);
  assert.ok(!fs.existsSync(ARGV_LOG), 'the gate engine must not be shelled for a forbidden action');
});

test('POST: S9 gate sources --producer-id from x-operator-email, NOT the body', async () => {
  setEngine(
    { action: 'decide', ok: true, committed: true, door: 'dashboard', gate: 's9_ready', decision: 'ready_to_assemble' },
    0,
  );
  const res = await POST(
    postReq(
      {
        subjectKey: ANTHOLOGY_ID,
        action: 'ready_to_assemble',
        confirmName: 'Voices of Resilience',
        // A forged body producerId must be ignored — identity comes from the session.
        producerId: 'attacker@evil.com',
      },
      { 'x-operator-email': 'real.producer@example.com' },
    ),
  );
  assert.equal(res.status, 200);
  const argv = readArgv();
  assert.equal(valueAfter(argv, '--producer-id'), 'real.producer@example.com');
  assert.equal(valueAfter(argv, '--confirm-name'), 'Voices of Resilience');
  assert.ok(!JSON.stringify(argv).includes('attacker@evil.com'));
});

test('POST: no_open_gate (exit 3) → 409 held', async () => {
  setEngine({ ok: false, action: 'decide', reason: 'no_open_gate' }, 3);
  const res = await POST(postReq({ subjectKey: PARTICIPANT_KEY, action: 'approve' }));
  assert.equal(res.status, 409);
  const json = await res.json();
  assert.equal(json.held, true);
});

test('POST: sole_writer_held (exit 3) → 503 held', async () => {
  setEngine({ ok: false, action: 'decide', reason: 'sole_writer_held', committed: false }, 3);
  const res = await POST(postReq({ subjectKey: PARTICIPANT_KEY, action: 'approve' }));
  assert.equal(res.status, 503);
});

test('POST: malformed body → 400 (no engine shell)', async () => {
  setEngine(null, 0);
  const res = await POST(postReq({ action: 'approve' })); // missing subjectKey
  assert.equal(res.status, 400);
  assert.ok(!fs.existsSync(ARGV_LOG));
});

test('GET: status for an open gate → 200 with actions', async () => {
  setEngine(
    {
      ok: true,
      action: 'status',
      subject_key: PARTICIPANT_KEY,
      kind: 'participant',
      open_gate: 's5_participant',
      actor: 'participant',
      doors: ['token', 'board'],
      actions: ['approve_as_is', 'request_rewrite_with_notes'],
    },
    0,
  );
  const res = await GET(getReq(PARTICIPANT_KEY));
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.ok, true);
  assert.deepEqual(json.actions, ['approve_as_is', 'request_rewrite_with_notes']);
  assert.equal(json.openGate, 's5_participant');
});

test('GET: unknown subject → 404', async () => {
  setEngine({ ok: false, action: 'status', reason: 'unknown_subject', open_gate: null }, 3);
  const res = await GET(getReq('no-such-subject'));
  assert.equal(res.status, 404);
});

test('GET: missing subjectKey → 400', async () => {
  const res = await GET(getReq());
  assert.equal(res.status, 400);
});

// ─────────────────────────────────────────────────────────────────────────────
// Middleware wiring invariant (SPEC B10): the route is DELIBERATELY absent from
// WEBHOOK_SECRET_ROUTES, so the same-origin session passthrough gates it.
// ─────────────────────────────────────────────────────────────────────────────

test('middleware: /api/anthology/gate is NOT registered as a webhook-secret route', () => {
  // `npm run test:unit` runs from the app root, so cwd/src/middleware.ts resolves.
  const middlewareSrc = fs.readFileSync(
    path.join(process.cwd(), 'src', 'middleware.ts'),
    'utf8',
  );
  assert.ok(
    !middlewareSrc.includes('/api/anthology/gate'),
    'the board door must not join WEBHOOK_SECRET_ROUTES — it is session-gated via the same-origin passthrough',
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// CONFIRM-ORDER (U9/U13) — the board action that carries the producer's finalized
// running order + opener + last co-author to the engine, and the STATUS RELAY of
// the assembly passthrough (assembly_state / readiness / ordering) back out.
// ─────────────────────────────────────────────────────────────────────────────

const ORDER = ['cB::a', 'cA::a', 'cC::a'];

test('decideBoard: confirm_order carries --order (JSON) + --opener + --closer', () => {
  setEngine(
    { action: 'decide', ok: true, committed: true, door: 'dashboard', gate: null, decision: 'confirm_order' },
    0,
  );
  const r = decideBoard(ANTHOLOGY_ID, 'confirm_order', {
    order: ORDER,
    opener: 'cB::a',
    closer: 'cC::a',
    producerId: 'p@x.com',
  });
  assert.equal(r.ok, true);
  const argv = readArgv();
  assert.equal(valueAfter(argv, '--action'), 'confirm_order');
  // The whole sequence rides a single JSON argv token, not one flag per id.
  assert.deepEqual(JSON.parse(valueAfter(argv, '--order') ?? 'null'), ORDER);
  assert.equal(valueAfter(argv, '--opener'), 'cB::a');
  assert.equal(valueAfter(argv, '--closer'), 'cC::a');
});

test('decideBoard: confirm_order with no order never fabricates --order/--opener/--closer', () => {
  setEngine({ action: 'decide', ok: true, committed: true, door: 'dashboard', decision: 'confirm_order' }, 0);
  decideBoard(ANTHOLOGY_ID, 'confirm_order', {});
  const argv = readArgv();
  assert.ok(!argv.includes('--order'));
  assert.ok(!argv.includes('--opener'));
  assert.ok(!argv.includes('--closer'));
});

test('POST: confirm_order relays order/opener/closer from the body to the engine argv', async () => {
  setEngine(
    { action: 'decide', ok: true, committed: true, door: 'dashboard', gate: null, decision: 'confirm_order' },
    0,
  );
  const res = await POST(
    postReq(
      { subjectKey: ANTHOLOGY_ID, action: 'confirm_order', order: ORDER, opener: 'cB::a', closer: 'cC::a' },
      { 'x-operator-email': 'real.producer@example.com' },
    ),
  );
  assert.equal(res.status, 200);
  const argv = readArgv();
  assert.equal(valueAfter(argv, '--door'), 'board');
  assert.equal(valueAfter(argv, '--action'), 'confirm_order');
  assert.deepEqual(JSON.parse(valueAfter(argv, '--order') ?? 'null'), ORDER);
  assert.equal(valueAfter(argv, '--opener'), 'cB::a');
  assert.equal(valueAfter(argv, '--closer'), 'cC::a');
  // Producer identity still comes from the session, never the body.
  assert.equal(valueAfter(argv, '--producer-id'), 'real.producer@example.com');
});

test('POST: order/opener/closer are IGNORED for a non-confirm_order action (never leak onto the argv)', async () => {
  setEngine(
    { action: 'decide', ok: true, committed: true, door: 'dashboard', gate: 's1_producer', decision: 'approve' },
    0,
  );
  const res = await POST(
    postReq({ subjectKey: PARTICIPANT_KEY, action: 'approve', order: ORDER, opener: 'cB::a', closer: 'cC::a' }),
  );
  assert.equal(res.status, 200);
  const argv = readArgv();
  assert.ok(!argv.includes('--order'), 'order args must never ride a non-confirm_order decision');
  assert.ok(!argv.includes('--opener'));
  assert.ok(!argv.includes('--closer'));
});

test('boardStatus: RELAYS assembly_state + readiness + ordering verbatim (never stripped)', () => {
  const readiness = { frozen_chapter_count: 7, active_members: 9, blocking: [{ reason: 'not_approved' }], excluded: 1, min_chapters: 2 };
  const ordering = {
    order: ['cB::a', 'cA::a'],
    slots: [
      { participant_key: 'cB::a', position: 1, chapter_title: 'T2', contributor_name: 'B', word_count: 2100, tone: 'wry', rationale: 'strong opener' },
      { participant_key: 'cA::a', position: 2, chapter_title: 'T1', contributor_name: 'A', word_count: 3000, tone: 'warm', rationale: 'resonant close' },
    ],
    overall_rationale: 'opener/closer with a wry middle',
  };
  setEngine(
    {
      ok: true,
      action: 'status',
      subject_key: ANTHOLOGY_ID,
      kind: 'anthology',
      open_gate: null,
      actor: 'producer',
      doors: ['board'],
      actions: [],
      assembly_state: 'proposed',
      readiness,
      ordering,
    },
    0,
  );
  const s = boardStatus(ANTHOLOGY_ID);
  assert.equal(s.ok, true);
  if (!s.ok) return;
  assert.equal(s.assemblyState, 'proposed');
  assert.deepEqual(s.readiness, readiness);
  assert.deepEqual(s.ordering, ordering);
});

test('boardStatus: also accepts U9 `cockpit_view` as the ordering alias', () => {
  const ordering = { order: ['x'], slots: [{ participant_key: 'x', chapter_title: 'X' }], overall_rationale: '' };
  setEngine(
    { ok: true, action: 'status', subject_key: ANTHOLOGY_ID, kind: 'anthology', open_gate: null, actions: [], cockpit_view: ordering },
    0,
  );
  const s = boardStatus(ANTHOLOGY_ID);
  assert.equal(s.ok, true);
  if (!s.ok) return;
  assert.deepEqual(s.ordering, ordering);
});

test('boardStatus: a plain participant status carries NO assembly passthrough keys', () => {
  setEngine(
    { ok: true, action: 'status', subject_key: PARTICIPANT_KEY, kind: 'participant', open_gate: 's5_participant', actions: ['approve_as_is'] },
    0,
  );
  const s = boardStatus(PARTICIPANT_KEY);
  assert.equal(s.ok, true);
  if (!s.ok) return;
  assert.equal(s.assemblyState, undefined);
  assert.equal(s.readiness, undefined);
  assert.equal(s.ordering, undefined);
});

test('GET: relays the assembly passthrough (ordering) through to the client JSON', async () => {
  const ordering = {
    order: ['cB::a', 'cA::a'],
    slots: [{ participant_key: 'cB::a', chapter_title: 'T2', contributor_name: 'B', word_count: 2100, tone: 'wry', rationale: 'strong opener' }],
    overall_rationale: 'wry opener',
  };
  setEngine(
    { ok: true, action: 'status', subject_key: ANTHOLOGY_ID, kind: 'anthology', open_gate: null, actions: [], assembly_state: 'proposed', ordering },
    0,
  );
  const res = await GET(getReq(ANTHOLOGY_ID));
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.ok, true);
  assert.equal(json.assemblyState, 'proposed');
  assert.deepEqual(json.ordering, ordering);
});
