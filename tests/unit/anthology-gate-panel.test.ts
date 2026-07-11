/**
 * Unit tests for the Anthology card face + Gate Panel model (SPEC B11 / U12).
 *
 * These cover the PURE logic the two React views render over — card parsing,
 * stage mapping, the status-driven action set, and the two board-door fetches
 * (mocked). The views are thin wrappers, so proving this logic proves the
 * acceptance: (a) the panel renders EXACTLY the actions `status` returns (never
 * an invented one, never `done`), and (b) Approve POSTs to U11 correctly.
 *
 * Node built-in runner:  node --import tsx --test tests/unit/anthology-gate-panel.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isAnthologyTask,
  parseAnthologyCard,
  extractSubject,
  extractLatestCursor,
  waitingAge,
  extractArtifacts,
  TOTAL_SEGMENTS,
} from '../../src/components/anthology/anthology-card';
import {
  presentAction,
  orderedActions,
  fetchBoardStatus,
  postGateDecision,
  decisionErrorCopy,
  type FetchLike,
} from '../../src/components/anthology/gate-actions';

// --------------------------------------------------------------------------- //
// Fixtures — realistic card descriptions as mc_board.py + the ingest/status
// routes actually produce them.
// --------------------------------------------------------------------------- //

const PARTICIPANT_DESC =
  'Participant chapter card. Mirrors the ledger stage_cursor; producer ' +
  'deliverables land in the review column (the chapter-approval queue). Only ' +
  'the QC scorer at or above 8.5 promotes review to done.\n\n' +
  '— Captured via task-ingest —\n' +
  'Source: anthology\n' +
  'Ref: anthology:card:contact_ABC123::anth_XYZ\n\n' +
  '[status → in_progress @ 2026-07-01T10:00:00Z] stage_cursor=s2_tone\n\n' +
  '[status → review @ 2026-07-07T09:00:00Z] stage_cursor=s2_gate';

const participantTask = {
  id: 'task-1',
  title: 'Anthology chapter — Jordan Rivers · anth_XYZ',
  description: PARTICIPANT_DESC,
  source: 'anthology',
  status: 'review',
  updated_at: '2026-07-07T09:00:00Z',
  created_at: '2026-07-01T10:00:00Z',
};

const assemblyTask = {
  id: 'task-2',
  title: 'Anthology assembly — Voices of Resilience',
  description:
    'Assembly card for the anthology. Mirrors the ledger assembly_state.\n\n' +
    '— Captured via task-ingest —\n' +
    'Source: anthology\n' +
    'Ref: anthology:assembly:anth_XYZ\n\n' +
    '[status → review @ 2026-07-08T09:00:00Z] assembly_state=compiled',
  source: 'anthology',
  status: 'review',
  updated_at: '2026-07-08T09:00:00Z',
  created_at: '2026-07-02T10:00:00Z',
};

const nonAnthologyTask = {
  id: 'task-9',
  title: 'Ship the marketing landing page',
  description: 'A perfectly ordinary task. Source: funnel',
  source: 'funnel',
  status: 'in_progress',
  updated_at: '2026-07-07T09:00:00Z',
  created_at: '2026-07-01T10:00:00Z',
};

// --------------------------------------------------------------------------- //
// isAnthologyTask
// --------------------------------------------------------------------------- //

test('isAnthologyTask: true for stamped source, false for other sources', () => {
  assert.equal(isAnthologyTask(participantTask), true);
  assert.equal(isAnthologyTask(assemblyTask), true);
  assert.equal(isAnthologyTask(nonAnthologyTask), false);
  assert.equal(isAnthologyTask(null), false);
});

test('isAnthologyTask: legacy description marker fallback (no stamped source)', () => {
  assert.equal(
    isAnthologyTask({ description: 'x\n\nSource: anthology', source: null }),
    true
  );
});

// --------------------------------------------------------------------------- //
// Subject + cursor extraction
// --------------------------------------------------------------------------- //

test('extractSubject: reads participant_key from the Ref provenance line', () => {
  const s = extractSubject(PARTICIPANT_DESC);
  assert.deepEqual(s, { subjectKey: 'contact_ABC123::anth_XYZ', kind: 'participant' });
});

test('extractSubject: reads anthology_id for an assembly card', () => {
  const s = extractSubject(assemblyTask.description);
  assert.deepEqual(s, { subjectKey: 'anth_XYZ', kind: 'anthology' });
});

test('extractLatestCursor: the LAST stage_cursor note wins', () => {
  assert.equal(extractLatestCursor(PARTICIPANT_DESC, false), 's2_gate');
});

test('extractLatestCursor: assembly reads assembly_state, not stage_cursor', () => {
  assert.equal(extractLatestCursor(assemblyTask.description, true), 'compiled');
  assert.equal(extractLatestCursor(assemblyTask.description, false), null);
});

// --------------------------------------------------------------------------- //
// parseAnthologyCard
// --------------------------------------------------------------------------- //

test('parseAnthologyCard: participant card face fields', () => {
  const c = parseAnthologyCard(participantTask);
  assert.ok(c);
  assert.equal(c!.kind, 'participant');
  assert.equal(c!.subjectKey, 'contact_ABC123::anth_XYZ');
  assert.equal(c!.displayName, 'Jordan Rivers');
  assert.equal(c!.firstName, 'Jordan');
  assert.equal(c!.bookId, 'anth_XYZ');
  assert.equal(c!.isAssembly, false);
  assert.ok(c!.stage);
  assert.equal(c!.stage!.badge, 'S2 · Tone');
  assert.equal(c!.stage!.index, 2);
  assert.equal(c!.stage!.exceptional, false);
});

test('parseAnthologyCard: assembly card', () => {
  const c = parseAnthologyCard(assemblyTask);
  assert.ok(c);
  assert.equal(c!.kind, 'anthology');
  assert.equal(c!.subjectKey, 'anth_XYZ');
  assert.equal(c!.displayName, 'Voices of Resilience');
  assert.equal(c!.isAssembly, true);
  assert.equal(c!.bookId, 'anth_XYZ');
  assert.ok(c!.stage);
  assert.equal(c!.stage!.index, 9); // assembly lives in S9
});

test('parseAnthologyCard: non-anthology task returns null', () => {
  assert.equal(parseAnthologyCard(nonAnthologyTask), null);
});

test('parseAnthologyCard: held cursor is exceptional, not a stage number', () => {
  const held = {
    ...participantTask,
    description:
      participantTask.description + '\n\n[status → blocked @ 2026-07-08T09:00:00Z] stage_cursor=held',
    status: 'blocked',
  };
  const c = parseAnthologyCard(held);
  assert.ok(c!.stage);
  assert.equal(c!.stage!.exceptional, true);
  assert.equal(c!.stage!.index, null);
  assert.equal(c!.stage!.badge, 'On hold');
});

test('parseAnthologyCard: title clipped to id-only still recovers the book id', () => {
  const c = parseAnthologyCard({
    ...participantTask,
    title: 'anth_XYZ', // degenerate: mc_board dropped the human prefix
  });
  // bookId falls back to the "::"-suffix of the participant_key.
  assert.equal(c!.bookId, 'anth_XYZ');
});

test('TOTAL_SEGMENTS is 9 (S0 → S9)', () => {
  assert.equal(TOTAL_SEGMENTS, 9);
});

// --------------------------------------------------------------------------- //
// waitingAge
// --------------------------------------------------------------------------- //

test('waitingAge: days while in review', () => {
  const now = Date.parse('2026-07-09T09:00:00Z'); // 2 days after updated_at
  assert.equal(waitingAge(participantTask, now), 'waiting on you for 2 days');
});

test('waitingAge: hours, and null when not in review', () => {
  const now = Date.parse('2026-07-07T14:00:00Z'); // 5 hours after
  assert.equal(waitingAge(participantTask, now), 'waiting on you for 5 hours');
  assert.equal(waitingAge({ ...participantTask, status: 'in_progress' }, now), null);
});

// --------------------------------------------------------------------------- //
// Artifact extraction
// --------------------------------------------------------------------------- //

test('extractArtifacts: classifies pdf / doc, dedupes, trims trailing punctuation', () => {
  const text =
    'PDF: https://drive.example.com/chapter.pdf. ' +
    'Doc: https://docs.google.com/document/d/abc/edit ' +
    'again https://drive.example.com/chapter.pdf ' +
    'other https://example.com/thing';
  const arts = extractArtifacts(text);
  assert.equal(arts.length, 3); // deduped
  assert.deepEqual(
    arts.map((a) => a.kind),
    ['pdf', 'doc', 'link']
  );
  assert.equal(arts[0].url, 'https://drive.example.com/chapter.pdf'); // trailing '.' trimmed
});

test('extractArtifacts: empty text yields no artifacts', () => {
  assert.deepEqual(extractArtifacts(''), []);
  assert.deepEqual(extractArtifacts(null), []);
});

// --------------------------------------------------------------------------- //
// Action presentation — producer voice, status-driven, done never shown
// --------------------------------------------------------------------------- //

test('presentAction: producer-voice labels for the current producer gate', () => {
  assert.equal(presentAction('approve').label('Jordan'), 'Approve & Release to Jordan');
  assert.equal(presentAction('approve').tone, 'primary');
  assert.equal(presentAction('hold').label(null), 'Hold');
  assert.equal(presentAction('hold').field, 'reason');
  assert.equal(presentAction('exclude').tone, 'destructive');
  assert.equal(presentAction('escalate').label(null), 'Escalate to me');
});

test('presentAction: unknown action still renders as a humanized generic button', () => {
  const p = presentAction('some_future_action');
  assert.equal(p.label(null), 'Some Future Action');
  assert.equal(p.tone, 'secondary');
  assert.equal(p.field, null);
});

test('select is the S3 title gate today, never dressed up as the cover picker', () => {
  const p = presentAction('select');
  assert.equal(p.field, 'title'); // title selection, requires a title
  assert.equal(p.engineGated, undefined); // NOT flagged as cover — that face is a separate future gate
  const label = p.label('Jordan');
  assert.ok(!/four|cover/i.test(label), `"${label}" must not fake the cover picker`);
});

test('request_rewrite_with_notes is flagged engine-gated (producer rewrite, B9/U9)', () => {
  assert.equal(presentAction('request_rewrite_with_notes').engineGated, 'rewrite');
  assert.equal(presentAction('request_rewrite_with_notes').field, 'notes');
});

test('orderedActions: renders EXACTLY the status-returned actions (no more, no fewer)', () => {
  const returned = ['approve', 'hold', 'exclude', 'escalate']; // the live producer gate
  const rendered = orderedActions(returned).map((p) => p.action);
  assert.deepEqual([...rendered].sort(), [...returned].sort());
  assert.equal(rendered.length, returned.length);
});

test('orderedActions: primary first, then secondary, then destructive', () => {
  const rendered = orderedActions(['exclude', 'hold', 'approve', 'escalate']).map(
    (p) => p.action
  );
  assert.equal(rendered[0], 'approve'); // primary leads
  assert.equal(rendered[rendered.length - 1], 'exclude'); // destructive last
});

test('orderedActions: never renders a done action even if returned', () => {
  const rendered = orderedActions(['approve', 'done']).map((p) => p.action);
  assert.ok(!rendered.includes('done'));
  assert.deepEqual(rendered, ['approve']);
});

test('every rendered label is producer voice: no "AI", no em-dash', () => {
  const all = ['approve', 'approve_as_is', 'sign_off', 'ready_to_assemble', 'select', 'hold', 'escalate', 'request_rewrite_with_notes', 'exclude'];
  for (const a of all) {
    const label = presentAction(a).label('Jordan');
    assert.ok(!/\bAI\b/.test(label), `"${label}" must not say AI`);
    assert.ok(!label.includes('—'), `"${label}" must not contain an em-dash`);
  }
});

// --------------------------------------------------------------------------- //
// fetchBoardStatus — GET /api/anthology/gate (U11)
// --------------------------------------------------------------------------- //

function jsonResponse(status: number, body: unknown): Response {
  return {
    status,
    json: async () => body,
  } as unknown as Response;
}

test('fetchBoardStatus: GETs the correct URL and parses an ok body', async () => {
  let seenUrl = '';
  let seenMethod = '';
  const mock: FetchLike = async (url, init) => {
    seenUrl = String(url);
    seenMethod = (init?.method as string) ?? 'GET';
    return jsonResponse(200, {
      ok: true,
      subjectKey: 'contact_ABC123::anth_XYZ',
      openGate: 's2_producer',
      kind: 'participant',
      actor: 'producer',
      doors: ['producer'],
      actions: ['approve', 'hold', 'exclude', 'escalate'],
    });
  };
  const res = await fetchBoardStatus('contact_ABC123::anth_XYZ', mock);
  assert.equal(seenMethod, 'GET');
  assert.equal(
    seenUrl,
    '/api/anthology/gate?subjectKey=contact_ABC123%3A%3Aanth_XYZ'
  );
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.openGate, 's2_producer');
    assert.deepEqual(res.actions, ['approve', 'hold', 'exclude', 'escalate']);
  }
});

test('fetchBoardStatus: maps a not_ready failure with its http status', async () => {
  const mock: FetchLike = async () => jsonResponse(503, { ok: false, reason: 'not_ready' });
  const res = await fetchBoardStatus('anth_XYZ', mock);
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.equal(res.reason, 'not_ready');
    assert.equal(res.httpStatus, 503);
  }
});

test('fetchBoardStatus: network error is a soft error result, never throws', async () => {
  const mock: FetchLike = async () => {
    throw new Error('offline');
  };
  const res = await fetchBoardStatus('anth_XYZ', mock);
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.reason, 'error');
});

// --------------------------------------------------------------------------- //
// postGateDecision — POST /api/anthology/gate (Approve POSTs correctly)
// --------------------------------------------------------------------------- //

test('postGateDecision: Approve POSTs the right method, URL and JSON body', async () => {
  let seenUrl = '';
  let seenInit: RequestInit | undefined;
  const mock: FetchLike = async (url, init) => {
    seenUrl = String(url);
    seenInit = init;
    return jsonResponse(200, {
      ok: true,
      committed: true,
      gate: 's2_producer',
      decision: 'approve',
      door: 'dashboard',
      approvalId: '42',
      stageCursor: 's3_title',
      queued: false,
      noop: false,
    });
  };

  const res = await postGateDecision('contact_ABC123::anth_XYZ', 'approve', {}, mock);

  assert.equal(seenUrl, '/api/anthology/gate');
  assert.equal(seenInit?.method, 'POST');
  assert.equal(
    (seenInit?.headers as Record<string, string>)['Content-Type'],
    'application/json'
  );
  assert.deepEqual(JSON.parse(seenInit?.body as string), {
    subjectKey: 'contact_ABC123::anth_XYZ',
    action: 'approve',
  });
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.committed, true);
    assert.equal(res.door, 'dashboard'); // board-door provenance
    assert.equal(res.decision, 'approve');
  }
});

test('postGateDecision: only non-empty fields are sent (no empty strings)', async () => {
  let body: Record<string, unknown> = {};
  const mock: FetchLike = async (_url, init) => {
    body = JSON.parse(init?.body as string);
    return jsonResponse(200, { ok: true, committed: true, gate: null, decision: 'hold', door: 'dashboard', approvalId: null, stageCursor: null, queued: false, noop: false });
  };
  await postGateDecision(
    'contact_ABC123::anth_XYZ',
    'hold',
    { reason: '  needs a stronger hook  ', notes: '   ', title: '' },
    mock
  );
  assert.deepEqual(body, {
    subjectKey: 'contact_ABC123::anth_XYZ',
    action: 'hold',
    reason: 'needs a stronger hook', // trimmed; empty notes/title dropped
  });
});

test('postGateDecision: a missing_fields refusal surfaces reason + fields', async () => {
  const mock: FetchLike = async () =>
    jsonResponse(422, {
      ok: false,
      committed: false,
      reason: 'missing_fields',
      held: false,
      fields: ['reason'],
    });
  const res = await postGateDecision('contact_ABC123::anth_XYZ', 'hold', {}, mock);
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.equal(res.reason, 'missing_fields');
    assert.deepEqual(res.fields, ['reason']);
    assert.equal(res.httpStatus, 422);
  }
});

// --------------------------------------------------------------------------- //
// decisionErrorCopy — producer-friendly, no jargon
// --------------------------------------------------------------------------- //

test('decisionErrorCopy: friendly, actionable, no "AI"/em-dash', () => {
  const missing = decisionErrorCopy({ ok: false, committed: false, reason: 'missing_fields', held: false, fields: ['reason'] });
  assert.match(missing, /hold reason/);
  const mismatch = decisionErrorCopy({ ok: false, committed: false, reason: 'validation_mismatch', held: false });
  assert.match(mismatch, /typed name/i);
  const held = decisionErrorCopy({ ok: false, committed: false, reason: 'not_ready', held: true });
  assert.match(held, /not reachable/i);

  for (const copy of [missing, mismatch, held]) {
    assert.ok(!/\bAI\b/.test(copy));
    assert.ok(!copy.includes('—'));
  }
});
