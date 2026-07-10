/**
 * anthology-assembly-cockpit.test.ts — unit tests for the B12 Assembly cockpit
 * brain (unit U13). Covers the four acceptance surfaces with a MOCK fetch:
 * arm (name match + mismatch), reorder, confirm-order, and sign-off gating —
 * plus status parsing, phase derivation, card resolution, and the "no client-
 * facing AI language" invariant.
 *
 * DB-free and DOM-free by design: the cockpit's logic lives in a framework-free
 * module so it runs under `node --import tsx --test` like the rest of tests/unit.
 *
 *   node --import tsx --test tests/unit/anthology-assembly-cockpit.test.ts
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  resolveAnthologyAssembly,
  parseAssemblyStatus,
  derivePhase,
  signOffEnabled,
  nameMatches,
  readinessLabel,
  reorder,
  moveToFront,
  moveToEnd,
  buildArmBody,
  buildSignOffBody,
  buildConfirmOrderBody,
  pickConfirmOrderAction,
  friendlyDecideError,
  submitArm,
  submitConfirmOrder,
  submitSignOff,
  loadAssemblyStatus,
  type FetchLike,
} from '../../src/components/anthology/assembly-cockpit-logic';
// U12 parsers + the ingest write-side helper — used to prove the anthology_id
// `Ref:` line the ingest now emits resolves via BOTH the U12 and U13 parsers, and
// to prove the double-render precedence (Gate Panel vs cockpit) is mutually
// exclusive by construction.
import {
  isAnthologyTask,
  extractSubject,
  resolveIngestSourceRef,
} from '../../src/components/anthology/anthology-card';

// --------------------------------------------------------------------------- //
// A recording mock fetch. Returns a canned body; captures each call so tests can
// assert the exact request the cockpit made.
// --------------------------------------------------------------------------- //
interface Captured {
  input: string;
  init?: RequestInit;
}
function mockFetch(body: unknown, opts: { status?: number; ok?: boolean } = {}) {
  const calls: Captured[] = [];
  const fn: FetchLike = async (input, init) => {
    calls.push({ input, init });
    return {
      ok: opts.ok ?? true,
      status: opts.status ?? 200,
      json: async () => body,
    };
  };
  return { fn, calls };
}
function lastBody(calls: Captured[]): Record<string, unknown> {
  const raw = calls[calls.length - 1]?.init?.body;
  return JSON.parse(typeof raw === 'string' ? raw : '{}');
}

// --------------------------------------------------------------------------- //
// resolveAnthologyAssembly — which cards are assembly cards, and the aid.
// --------------------------------------------------------------------------- //
test('resolveAnthologyAssembly: assembly card via source_ref idempotency key', () => {
  const ref = resolveAnthologyAssembly({
    source: 'anthology',
    title: 'Anthology assembly — Voices of Resilience',
    description: 'Assembly card for the anthology.',
    source_ref: 'anthology:assembly:anth_abc123',
  });
  assert.ok(ref);
  assert.equal(ref.anthologyId, 'anth_abc123');
  assert.equal(ref.anthologyName, 'Voices of Resilience');
});

test('resolveAnthologyAssembly: aid parsed from an [ingest:...] description marker', () => {
  const ref = resolveAnthologyAssembly({
    source: 'anthology',
    title: 'Anthology assembly — Rise',
    description: 'Source: anthology\n[ingest:anthology:assembly:anth_xy]',
  });
  assert.ok(ref);
  assert.equal(ref.anthologyId, 'anth_xy');
});

test('resolveAnthologyAssembly: assembly card with NO surfaced aid → null aid (gap #3)', () => {
  // The realistic case today: source + title present, but the aid is not on the Task.
  const ref = resolveAnthologyAssembly({
    source: 'anthology',
    title: 'Anthology assembly — Untold',
    description: 'Source: anthology',
  });
  assert.ok(ref);
  assert.equal(ref.anthologyId, null);
  assert.equal(ref.anthologyName, 'Untold');
});

test('resolveAnthologyAssembly: participant chapter card is NOT an assembly card', () => {
  const ref = resolveAnthologyAssembly({
    source: 'anthology',
    title: 'Jane Doe — chapter',
    description: 'Source: anthology\n[ingest:anthology:card:contact1::anth_abc]',
  });
  assert.equal(ref, null);
});

test('resolveAnthologyAssembly: non-anthology card → null', () => {
  assert.equal(
    resolveAnthologyAssembly({ source: 'funnel', title: 'Anthology assembly — X' }),
    null
  );
  assert.equal(resolveAnthologyAssembly(null), null);
  assert.equal(resolveAnthologyAssembly(undefined), null);
});

// --------------------------------------------------------------------------- //
// anthology_id surfacing — the ingest folds the sole-writer subject key into a
// `Ref:` line; BOTH the U13 (resolveAnthologyAssembly) and U12 (extractSubject)
// parsers must resolve the aid from it.
// --------------------------------------------------------------------------- //
test('resolveIngestSourceRef: explicit source_ref wins, else an anthology idempotency key is surfaced', () => {
  // Explicit source_ref always wins.
  assert.equal(
    resolveIngestSourceRef('anthology:assembly:anth_a', 'anthology:assembly:zzz'),
    'anthology:assembly:anth_a'
  );
  // No source_ref → surface the anthology-subject idempotency key (assembly + card).
  assert.equal(resolveIngestSourceRef(undefined, 'anthology:assembly:anth_b'), 'anthology:assembly:anth_b');
  assert.equal(
    resolveIngestSourceRef(null, 'anthology:card:contact1::anth_b'),
    'anthology:card:contact1::anth_b'
  );
  // A non-anthology idempotency key (e.g. a synthesized sha256) is NOT surfaced.
  assert.equal(resolveIngestSourceRef(undefined, 'auto:deadbeef'), undefined);
  assert.equal(resolveIngestSourceRef(undefined, undefined), undefined);
});

test('anthology_id: the ingest `Ref:` line resolves via BOTH the U13 and U12 parsers', () => {
  // Exactly the description the ingest now builds for an assembly card:
  //   Source: anthology\n\n… — Captured via task-ingest —\nRef: anthology:assembly:<aid>
  const sourceRef = resolveIngestSourceRef(undefined, 'anthology:assembly:anth_wired');
  const description = `Source: anthology\n\n— Captured via task-ingest —\nRef: ${sourceRef}`;
  const task = {
    source: 'anthology',
    title: 'Anthology assembly — Voices of Resilience',
    description,
  };

  // U13 — the Assembly cockpit resolves the aid + name.
  const ref = resolveAnthologyAssembly(task);
  assert.ok(ref);
  assert.equal(ref.anthologyId, 'anth_wired');
  assert.equal(ref.anthologyName, 'Voices of Resilience');

  // U12 — the Gate Panel card model resolves the same subject key + kind.
  const subject = extractSubject(description);
  assert.ok(subject);
  assert.equal(subject.subjectKey, 'anth_wired');
  assert.equal(subject.kind, 'anthology');
});

// --------------------------------------------------------------------------- //
// DOUBLE-RENDER precedence (U12/U13). The Assembly card must show ONLY the
// cockpit; a chapter/gate card must show ONLY the Gate Panel. TaskModal gates the
// Gate Panel on `isAnthologyTask(task) && !anthologyAssembly` and the cockpit on
// `anthologyAssembly`, where `anthologyAssembly = resolveAnthologyAssembly(task)`.
// These predicates are the source of truth for both renders, so we prove them
// mutually exclusive for every card class here.
// --------------------------------------------------------------------------- //
test('double-render precedence: assembly card shows cockpit ONLY, chapter card shows gate panel ONLY', () => {
  // Mirror TaskModal's exact render conditions from the two pure predicates.
  const cockpitRenders = (t: unknown) => resolveAnthologyAssembly(t as never) !== null;
  const gatePanelRenders = (t: unknown) =>
    isAnthologyTask(t as never) && resolveAnthologyAssembly(t as never) === null;

  const assemblyCard = {
    source: 'anthology',
    title: 'Anthology assembly — Voices of Resilience',
    description: 'Source: anthology\nRef: anthology:assembly:anth_1',
  };
  const chapterCard = {
    source: 'anthology',
    title: 'Anthology chapter — Jane Doe · anth_1',
    description: 'Source: anthology\nRef: anthology:card:contact1::anth_1',
  };
  const plainCard = { source: 'funnel', title: 'Follow up with the lead' };

  // Assembly card → cockpit only.
  assert.equal(cockpitRenders(assemblyCard), true);
  assert.equal(gatePanelRenders(assemblyCard), false);

  // Chapter/gate card → gate panel only.
  assert.equal(cockpitRenders(chapterCard), false);
  assert.equal(gatePanelRenders(chapterCard), true);

  // Non-anthology card → neither.
  assert.equal(cockpitRenders(plainCard), false);
  assert.equal(gatePanelRenders(plainCard), false);

  // The two surfaces are NEVER both true for the same card (no double-render).
  for (const t of [assemblyCard, chapterCard, plainCard]) {
    assert.ok(!(cockpitRenders(t) && gatePanelRenders(t)), 'gate panel and cockpit must be mutually exclusive');
  }
});

test('double-render precedence: TaskModal source gates the Gate Panel on !anthologyAssembly', () => {
  // Wiring guard (mirrors the middleware-invariant test in the gate-route suite):
  // the JSX must gate the Gate Panel on !anthologyAssembly so it never co-renders
  // with the cockpit on the assembly card.
  const src = fs.readFileSync(
    path.join(process.cwd(), 'src', 'components', 'TaskModal.tsx'),
    'utf8'
  );
  assert.match(
    src,
    /isAnthologyTask\(task\)\s*&&\s*!anthologyAssembly/,
    'the Gate Panel render must be gated on `isAnthologyTask(task) && !anthologyAssembly`'
  );
});

// --------------------------------------------------------------------------- //
// parseAssemblyStatus + derivePhase.
// --------------------------------------------------------------------------- //
test('parseAssemblyStatus: normalizes the board GET response (camelCase)', () => {
  const s = parseAssemblyStatus({
    ok: true,
    subjectKey: 'anth_1',
    openGate: 's9_ready',
    kind: 'anthology',
    actor: 'producer',
    doors: ['board'],
    actions: ['ready_to_assemble'],
  });
  assert.ok(s.ok);
  assert.equal(s.subjectKey, 'anth_1');
  assert.equal(s.openGate, 's9_ready');
  assert.equal(s.kind, 'anthology');
  assert.deepEqual(s.actions, ['ready_to_assemble']);
});

test('parseAssemblyStatus: absorbs an optional U9 ordering passthrough (snake_case)', () => {
  const s = parseAssemblyStatus({
    ok: true,
    subjectKey: 'anth_1',
    open_gate: null,
    assembly_state: 'proposed',
    ordering: {
      order: ['cB::a', 'cA::a'],
      slots: [
        { participant_key: 'cB::a', position: 1, chapter_title: 'T2', contributor_name: 'B', word_count: 2100, tone: 'wry', rationale: 'strong opener' },
        { participant_key: 'cA::a', position: 2, chapter_title: 'T1', contributor_name: 'A', word_count: 3000, tone: 'warm', rationale: 'resonant close' },
      ],
      overall_rationale: 'opener/closer with a wry middle',
    },
  });
  assert.ok(s.ok);
  assert.equal(s.assemblyState, 'proposed');
  assert.ok(s.ordering);
  assert.equal(s.ordering.slots.length, 2);
  assert.equal(s.ordering.slots[0].rationale, 'strong opener');
  assert.equal(s.ordering.slots[0].wordCount, 2100);
  assert.equal(s.ordering.overallRationale, 'opener/closer with a wry middle');
});

test('derivePhase: maps engine gate/state to the cockpit step', () => {
  assert.equal(
    derivePhase(parseAssemblyStatus({ ok: true, openGate: 's9_ready', actions: ['ready_to_assemble'] })),
    'arm'
  );
  assert.equal(
    derivePhase(parseAssemblyStatus({ ok: true, openGate: 's9_producer', actions: ['sign_off'] })),
    'sign_off'
  );
  assert.equal(
    derivePhase(parseAssemblyStatus({ ok: true, open_gate: null, assembly_state: 'ready_confirmed' })),
    'ordering'
  );
  assert.equal(
    derivePhase(parseAssemblyStatus({ ok: true, open_gate: null, assembly_state: 'signed_off' })),
    'delivered'
  );
  assert.equal(derivePhase(parseAssemblyStatus({ ok: false, reason: 'not_ready' })), 'not_ready');
  assert.equal(derivePhase(parseAssemblyStatus({ ok: false, reason: 'unknown_subject' })), 'error');
});

// --------------------------------------------------------------------------- //
// ARM — name match + mismatch (acceptance surface #1).
// --------------------------------------------------------------------------- //
test('nameMatches: exact typed name only', () => {
  assert.equal(nameMatches('Voices of Resilience', 'Voices of Resilience'), true);
  assert.equal(nameMatches('  Voices of Resilience  ', 'Voices of Resilience'), true);
  assert.equal(nameMatches('voices of resilience', 'Voices of Resilience'), false);
  assert.equal(nameMatches('Voices', 'Voices of Resilience'), false);
  assert.equal(nameMatches('', 'Voices of Resilience'), false);
});

test('buildArmBody: sends confirmName, action, subjectKey — and NEVER a producer id', () => {
  const body = buildArmBody('anth_1', '  Voices of Resilience  ') as Record<string, unknown>;
  assert.equal(body.action, 'ready_to_assemble');
  assert.equal(body.subjectKey, 'anth_1');
  assert.equal(body.confirmName, 'Voices of Resilience');
  assert.ok(!('producerId' in body), 'producer id must come from the session, never the body');
});

test('submitArm: exact name → committed decision, request shape correct', async () => {
  const { fn, calls } = mockFetch({ ok: true, committed: true, gate: 's9_ready', decision: 'ready_to_assemble', door: 'dashboard' });
  const res = await submitArm('anth_1', 'Voices of Resilience', fn);
  assert.ok(res.ok);
  assert.equal(res.gate, 's9_ready');
  const sent = lastBody(calls);
  assert.equal(sent.action, 'ready_to_assemble');
  assert.equal(sent.confirmName, 'Voices of Resilience');
  assert.equal(calls[0].init?.method, 'POST');
});

test('submitArm: wrong name → validation_mismatch surfaces a friendly, retryable message', async () => {
  const { fn } = mockFetch({ ok: false, committed: false, reason: 'validation_mismatch', held: false }, { ok: false, status: 422 });
  const res = await submitArm('anth_1', 'Wrong Title', fn);
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.equal(res.reason, 'validation_mismatch');
    assert.equal(res.needsRetry, true);
    assert.match(res.message, /did not match/i);
    assert.doesNotMatch(res.message, /\bAI\b/, 'no client-facing AI language');
  }
});

// --------------------------------------------------------------------------- //
// REORDER (acceptance surface #2).
// --------------------------------------------------------------------------- //
test('reorder: moves an item and is immutable', () => {
  const src = ['a', 'b', 'c', 'd'];
  assert.deepEqual(reorder(src, 0, 2), ['b', 'c', 'a', 'd']);
  assert.deepEqual(reorder(src, 3, 0), ['d', 'a', 'b', 'c']);
  assert.deepEqual(src, ['a', 'b', 'c', 'd'], 'original untouched');
  assert.deepEqual(reorder(src, 9, 0), ['a', 'b', 'c', 'd'], 'out-of-range is a no-op');
});

test('moveToFront / moveToEnd: producer picks the opener and the last co-author', () => {
  const order = ['a', 'b', 'c'];
  assert.deepEqual(moveToFront(order, 'c'), ['c', 'a', 'b']);
  assert.deepEqual(moveToEnd(order, 'a'), ['b', 'c', 'a']);
  assert.deepEqual(moveToFront(order, 'zzz'), ['a', 'b', 'c'], 'unknown key is a no-op');
});

// --------------------------------------------------------------------------- //
// CONFIRM-ORDER (acceptance surface #3).
// --------------------------------------------------------------------------- //
test('buildConfirmOrderBody: carries the finalized order + derived opener/closer (shared contract keys)', () => {
  const body = buildConfirmOrderBody('anth_1', ['c', 'a', 'b']);
  assert.equal(body.subjectKey, 'anth_1');
  assert.equal(body.action, 'confirm_order');
  assert.deepEqual(body.order, ['c', 'a', 'b']);
  // Contract keys are `opener`/`closer` (NOT openerKey/closerKey) — the route's
  // DecideSchema and the engine's confirm_order action consume exactly these.
  assert.equal(body.opener, 'c');
  assert.equal(body.closer, 'b');
  assert.ok(!('openerKey' in body), 'legacy openerKey must not be sent');
  assert.ok(!('closerKey' in body), 'legacy closerKey must not be sent');
});

test('buildConfirmOrderBody: empty order → null opener/closer', () => {
  const body = buildConfirmOrderBody('anth_1', []);
  assert.deepEqual(body.order, []);
  assert.equal(body.opener, null);
  assert.equal(body.closer, null);
});

test('pickConfirmOrderAction: uses an engine-surfaced finalize action, else confirm_order', () => {
  assert.equal(pickConfirmOrderAction(['confirm_order']), 'confirm_order');
  assert.equal(pickConfirmOrderAction(['finalize_order', 'sign_off']), 'finalize_order');
  assert.equal(pickConfirmOrderAction([]), 'confirm_order');
});

test('submitConfirmOrder: posts the finalized order + opener/closer to the gate door', async () => {
  const { fn, calls } = mockFetch({ ok: true, committed: true, gate: 's9_ready', decision: 'confirm_order' });
  const res = await submitConfirmOrder('anth_1', ['b', 'a', 'c'], 'confirm_order', fn);
  assert.ok(res.ok);
  const sent = lastBody(calls);
  assert.equal(sent.subjectKey, 'anth_1');
  assert.equal(sent.action, 'confirm_order');
  assert.deepEqual(sent.order, ['b', 'a', 'c']);
  assert.equal(sent.opener, 'b');
  assert.equal(sent.closer, 'c');
});

// --------------------------------------------------------------------------- //
// SIGN-OFF gating (acceptance surface #4).
// --------------------------------------------------------------------------- //
test('signOffEnabled: only at compiled', () => {
  // Engine surfaces the sign_off action ONLY at compiled (gate s9_producer).
  assert.equal(signOffEnabled(parseAssemblyStatus({ ok: true, openGate: 's9_producer', actions: ['sign_off'] })), true);
  assert.equal(signOffEnabled(parseAssemblyStatus({ ok: true, assembly_state: 'compiled', open_gate: 's9_producer', actions: ['sign_off'] })), true);
  // Not compiled yet.
  assert.equal(signOffEnabled(parseAssemblyStatus({ ok: true, openGate: 's9_ready', actions: ['ready_to_assemble'] })), false);
  assert.equal(signOffEnabled(parseAssemblyStatus({ ok: true, assembly_state: 'armed', open_gate: 's9_ready', actions: ['ready_to_assemble'] })), false);
  assert.equal(signOffEnabled(parseAssemblyStatus({ ok: true, assembly_state: 'ready_confirmed', open_gate: null })), false);
  assert.equal(signOffEnabled(parseAssemblyStatus({ ok: false, reason: 'not_ready' })), false);
});

test('buildSignOffBody + submitSignOff: minimal body, session-sourced producer', async () => {
  assert.deepEqual(buildSignOffBody('anth_1'), { subjectKey: 'anth_1', action: 'sign_off' });
  const { fn, calls } = mockFetch({ ok: true, committed: true, gate: 's9_producer', decision: 'approve' });
  const res = await submitSignOff('anth_1', fn);
  assert.ok(res.ok);
  const sent = lastBody(calls);
  assert.equal(sent.action, 'sign_off');
  assert.ok(!('producerId' in sent));
});

// --------------------------------------------------------------------------- //
// loadAssemblyStatus + readiness + copy-voice invariants.
// --------------------------------------------------------------------------- //
test('loadAssemblyStatus: GETs the gate door for the subject and normalizes', async () => {
  const { fn, calls } = mockFetch({ ok: true, subjectKey: 'anth_1', openGate: 's9_ready', kind: 'anthology', actions: ['ready_to_assemble'] });
  const res = await loadAssemblyStatus('anth 1/x', fn);
  assert.ok(res.ok);
  assert.match(calls[0].input, /^\/api\/anthology\/gate\?subjectKey=anth%201%2Fx$/);
  assert.equal(calls[0].init?.method, 'GET');
});

test('readinessLabel: composes the ticker from counts, else uses the engine label', () => {
  assert.equal(
    readinessLabel(parseAssemblyStatus({ ok: true, readiness: { frozen_chapter_count: 7, active_members: 9, blocking: [{ reason: 'not_approved' }], excluded: 1, min_chapters: 2 } }).ok
      ? parseAssemblyStatus({ ok: true, readiness: { frozen_chapter_count: 7, active_members: 9, blocking: [{ reason: 'not_approved' }], excluded: 1, min_chapters: 2 } }).readiness
      : undefined),
    '7 of 9 chapters finalized; 1 in rewrite; 1 excluded'
  );
  assert.equal(readinessLabel(undefined), null);
});

test('friendlyDecideError: every message is producer-voice with no "AI" language', () => {
  for (const reason of ['validation_mismatch', 'missing_fields', 'gate_not_open', 'not_ready', 'whatever']) {
    const { message } = friendlyDecideError(reason);
    assert.ok(message.length > 0);
    assert.doesNotMatch(message, /\bAI\b/, `"${reason}" must not mention AI`);
    assert.doesNotMatch(message, /\bartificial intelligence\b/i);
  }
});
