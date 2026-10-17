/**
 * CWE-037 intent adapter tests (directive Sections 20, 31).
 *
 * The classifier registers the Section 20 front-door phrases against
 * ONE capability identity and never intercepts ordinary questions.
 * Dispatch resolves existing-session controls FIRST through CWE-035's
 * scan queue, reads recorded verdicts and objections from the store,
 * and turns convene/consult/rerun intents into request descriptors
 * only: no dispatch outcome creates a task or a session. Requests
 * originating from the council's own outputs are blocked by the T096
 * recursion guard unless a separately authorized need is on record.
 */
import './_isolated-db';
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.OPENCLAW_ROOT = '/nonexistent/openclaw-root-for-tests';
delete process.env.OPENAI_API_KEY;

import type { CouncilPrincipal } from '../../src/lib/council/auth';
import type {
  CouncilRepositories,
  CouncilStoredSession,
} from '../../src/lib/council/store';
import type { CouncilScanQueue } from '../../src/lib/council/kanban/scan-queue';
import type { CouncilIntentDispatcher } from '../../src/lib/council/intents/dispatch';

type Db = import('better-sqlite3').Database;

let db: Db;
let repositories: CouncilRepositories;
let queue: CouncilScanQueue;
let dispatcher: CouncilIntentDispatcher;
let Intents: typeof import('../../src/lib/council/intents/index');
let envelopeFromScopeFn: typeof import('../../src/lib/council/store').envelopeFromScope;
let canonicalHashFn: typeof import('../../src/lib/council/contracts').canonicalHash;
let fixtures: typeof import('../../src/lib/council/contracts/fixtures/examples');
let closeDbFn: () => void;

const OWNER = 'owner-1';

function principal(subject: string): CouncilPrincipal {
  return {
    subject,
    tenantKind: 'client',
    channel: 'browser',
    supportAccess: false,
    scope: {
      tenant_id: 'tenant-a',
      company_id: 'company-a',
      installation_id: 'inst-a',
      owner_subject: null,
    },
    tenant: {
      tenantId: 'tenant-a',
      companyId: 'company-a',
      clientId: 'client-a',
      kind: 'client',
      subject,
      host: 'council-a.test',
      installationId: 'inst-a',
    },
  } as CouncilPrincipal;
}

function makeStoredSession(sessionId: string): CouncilStoredSession {
  const spec = JSON.parse(JSON.stringify(fixtures.validSessionSpec));
  const brief = JSON.parse(JSON.stringify(fixtures.validBrief));
  spec.session_id = sessionId;
  brief.session_id = sessionId;
  spec.brief_sha256 = canonicalHashFn(brief);
  const stored: CouncilStoredSession = {
    spec,
    brief,
    scope: {
      tenant_id: 'tenant-a',
      company_id: 'company-a',
      installation_id: 'inst-a',
      owner_subject: null,
    },
    state: {
      schema_version: 'wise-elders.session-state/v1',
      session_id: sessionId,
      mode: spec.mode,
      state: 'DRAFT',
      state_version: 0,
      brief_revision: brief.revision,
      resume_phase: null,
      cancel_generation: 0,
      revocation_generation: 0,
      attempt: 1,
      lease_epoch: 0,
      archived: false,
      updated_at: spec.created_at,
    },
    sample: false,
  };
  repositories.createSession(
    envelopeFromScopeFn(stored.scope, OWNER, 'owner', 'write'),
    stored,
  );
  return stored;
}

function totalTasks(): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM tasks`).get() as { n: number }).n;
}

function totalSessions(): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM council_sessions`).get() as { n: number }).n;
}

before(async () => {
  const dbModule = await import('../../src/lib/db');
  db = dbModule.getDb();
  closeDbFn = dbModule.closeDb;
  const store = await import('../../src/lib/council/store');
  repositories = new store.CouncilRepositories();
  envelopeFromScopeFn = store.envelopeFromScope;
  const contracts = await import('../../src/lib/council/contracts');
  canonicalHashFn = contracts.canonicalHash;
  fixtures = await import('../../src/lib/council/contracts/fixtures/examples');
  const scanModule = await import('../../src/lib/council/kanban/scan-queue');
  queue = new scanModule.CouncilScanQueue({ repositories, db });
  Intents = await import('../../src/lib/council/intents/index');
  dispatcher = new Intents.CouncilIntentDispatcher({ repositories, db, scanQueue: queue });

  const now = new Date().toISOString();
  db.prepare(
    `INSERT OR IGNORE INTO companies (id, name, slug, config, created_at, updated_at)
     VALUES ('company-a', 'Company A', 'company-a', '{}', ?, ?)`,
  ).run(now, now);
});

after(() => {
  closeDbFn();
});

test('classifier: front-door phrases register against the one capability; ordinary questions do not', () => {
  const classify = Intents.classifyCouncilIntent;
  assert.equal(Intents.COUNCIL_CAPABILITY_ID, 'council-of-wise-elders');
  assert.ok(Intents.COUNCIL_INTENT_REGISTRY.every((entry) => entry.capability_id === 'council-of-wise-elders'));

  assert.equal(classify('Ask my Council of Wise Elders').intent, 'convene_council');
  assert.equal(classify('Take this decision to the council').intent, 'convene_council');
  assert.equal(classify('Review this plan with the council').intent, 'convene_council');
  assert.equal(classify('/council').intent, 'convene_council');

  const seat = classify('Ask the Tiffany Aliche seat');
  assert.equal(seat.intent, 'consult_seat');
  assert.equal(seat.seat_id, 'tiffany-aliche');

  assert.equal(classify('What did they decide?').intent, 'read_result');

  const retrieval = classify("Explain Russell's objection");
  assert.equal(retrieval.intent, 'explain_objection');
  assert.equal(retrieval.seat_id, 'russell-brunson');
  assert.equal(retrieval.requires_inference, false);

  const inference = classify('Explain why Russell would object to the new pricing');
  assert.equal(inference.intent, 'explain_objection');
  assert.equal(inference.requires_inference, true);

  // Ordinary conversation is never intercepted (Section 20.2).
  assert.equal(classify('Should I launch in March?').intent, 'none');
  assert.equal(classify('What should we have for the team lunch?').intent, 'none');
  assert.equal(classify('Create a task for the council notes').intent, 'none');
});

test('dispatch: "Stop that council" resolves the existing session and creates nothing', async () => {
  const owner = principal(OWNER);
  makeStoredSession('sess-intent-1');
  const tasksBefore = totalTasks();
  const sessionsBefore = totalSessions();

  const outcome = await dispatcher.dispatch(owner, { text: 'Stop that council' });
  assert.equal(outcome.kind, 'session_command');
  if (outcome.kind === 'session_command') {
    assert.equal(outcome.command, 'stop');
    assert.equal(outcome.session_id, 'sess-intent-1');
    assert.equal(outcome.creates_task, false);
    assert.equal(outcome.creates_session, false);
  }
  assert.equal(totalTasks(), tasksBefore);
  assert.equal(totalSessions(), sessionsBefore);
  // A control also enqueues no scan work.
  assert.deepEqual(await queue.listPendingScanItems(owner, 'sess-intent-1'), []);
});

test('dispatch: verdict and objection reads come from the recorded store', async () => {
  const owner = principal(OWNER);
  const hash = 'a'.repeat(64);
  db.prepare(
    `INSERT INTO council_verdicts
       (tenant_id, company_id, session_id, id, brief_revision, verdict_json, canonical_hash,
        verdict_hash, cards_root_hash, brief_hash, policy_hash, validation_run_hash, label,
        validation, ratification, chosen_option_id, client_decision_json, created_at)
     VALUES ('tenant-a', 'company-a', 'sess-intent-1', 'verdict-intent-1', 1, ?, ?, ?, ?, ?, ?, ?,
             'GO_WITH_CONDITIONS', 'valid', 'not_required', NULL, NULL, '2026-10-14T10:00:00.000Z')`,
  ).run(
    JSON.stringify({
      result_kind: 'scored',
      verdict_revision: 1,
      label: 'GO_WITH_CONDITIONS',
      main_reasons: ['The pilot cohort is ready', 'Unit economics hold at the lower price'],
      strongest_dissent: 'The pricing objection stands until churn data lands.',
    }),
    hash, hash, hash, hash, hash, hash,
  );
  db.prepare(
    `INSERT INTO council_cards
       (tenant_id, company_id, session_id, id, kind, seat_id, round, brief_revision, operation_id,
        payload_fingerprint, card_json, canonical_hash, model_receipt_json, validation, created_at)
     VALUES ('tenant-a', 'company-a', 'sess-intent-1', 'card-intent-1', 'advisor', 'russell-brunson', 2, 1,
             'op-intent-1', ?, ?, ?, NULL, 'valid', '2026-10-14T09:00:00.000Z')`,
  ).run(
    hash,
    JSON.stringify({ strongest_objection: 'The funnel math assumes a conversion rate nobody has measured.' }),
    hash,
  );

  const tasksBefore = totalTasks();
  const read = await dispatcher.dispatch(owner, { text: 'What did they decide?', session_id: 'sess-intent-1' });
  assert.equal(read.kind, 'verdict_read');
  if (read.kind === 'verdict_read') {
    assert.equal(read.label, 'GO_WITH_CONDITIONS');
    assert.equal(read.verdict_revision, 1);
    assert.deepEqual(read.main_reasons, ['The pilot cohort is ready', 'Unit economics hold at the lower price']);
  }

  const objection = await dispatcher.dispatch(owner, {
    text: "Explain Russell's objection",
    session_id: 'sess-intent-1',
  });
  assert.equal(objection.kind, 'objection_read');
  if (objection.kind === 'objection_read') {
    assert.equal(objection.seat_id, 'russell-brunson');
    assert.equal(objection.objection, 'The funnel math assumes a conversion rate nobody has measured.');
    assert.equal(objection.source, 'advisor_card');
  }
  assert.equal(totalTasks(), tasksBefore);

  // The read resolutions are journaled on the session.
  const Kanban = await import('../../src/lib/council/kanban/index');
  const entries = Kanban.listKanbanJournalEntries(
    db,
    { tenant_id: 'tenant-a', company_id: 'company-a' },
    'sess-intent-1',
  );
  assert.ok(entries.some((entry) => entry.action === 'intent_resolved' && entry.payload.outcome === 'verdict_read'));
  assert.ok(entries.some((entry) => entry.action === 'intent_resolved' && entry.payload.outcome === 'objection_read'));
});

test('dispatch: consult and convene produce request descriptors only, preserving source references', async () => {
  const owner = principal(OWNER);
  const sessionsBefore = totalSessions();
  const tasksBefore = totalTasks();

  const consult = await dispatcher.dispatch(owner, {
    text: 'Ask the Tiffany Aliche seat about the runway math',
    session_id: 'sess-intent-1',
  });
  assert.equal(consult.kind, 'consult_request');
  if (consult.kind === 'consult_request') {
    assert.equal(consult.consult.seat_id, 'tiffany-aliche');
    assert.equal(consult.consult.purpose, 'follow_up');
    assert.equal(consult.consult.source_session_id, 'sess-intent-1');
    assert.ok(consult.consult.requires.some((line) => line.includes('CWE-049')));
  }

  const convene = await dispatcher.dispatch(owner, {
    text: 'Take this decision to the council',
    origin: {
      kind: 'department',
      source_department_id: 'dept-marketing',
      source_task_id: 'task-4471',
    },
  });
  assert.equal(convene.kind, 'convene_request');
  if (convene.kind === 'convene_request') {
    // Source department and task references survive routing (Section 31).
    assert.equal(convene.request.source_department_id, 'dept-marketing');
    assert.equal(convene.request.source_task_id, 'task-4471');
    assert.equal(convene.request.separately_authorized_need, false);
  }

  // Inference-flavored objection asks become consults, not reads.
  const inference = await dispatcher.dispatch(owner, {
    text: 'Explain why Russell would object to the new pricing',
    session_id: 'sess-intent-1',
  });
  assert.equal(inference.kind, 'consult_request');

  assert.equal(totalSessions(), sessionsBefore);
  assert.equal(totalTasks(), tasksBefore);
});

test('T096 guard: council-generated material cannot invoke a new council without a separately authorized need', async () => {
  const owner = principal(OWNER);

  const fromDraft = await dispatcher.dispatch(owner, {
    text: 'Ask my Council of Wise Elders',
    origin: { kind: 'council_generated', source_session_id: 'sess-intent-1', artifact_kind: 'draft' },
  });
  assert.equal(fromDraft.kind, 'blocked');
  if (fromDraft.kind === 'blocked') {
    assert.equal(fromDraft.reason, 'recursive_council_requires_separate_authorization');
    assert.equal(fromDraft.creates_session, false);
  }

  const fromReminder = await dispatcher.dispatch(owner, {
    text: 'Take this decision to the council',
    origin: { kind: 'outcome_reminder', source_session_id: 'sess-intent-1' },
  });
  assert.equal(fromReminder.kind, 'blocked');

  const fromScanProposal = await dispatcher.dispatch(owner, {
    text: 'Run it again',
    session_id: 'sess-intent-1',
    origin: { kind: 'scan_proposal', source_session_id: 'sess-intent-1' },
  });
  assert.equal(fromScanProposal.kind, 'blocked');

  // A separately authorized need, with its evidence reference, is the
  // only way through, and the request stays a request.
  const authorized = await dispatcher.dispatch(owner, {
    text: 'Ask my Council of Wise Elders',
    origin: {
      kind: 'council_generated',
      source_session_id: 'sess-intent-1',
      separately_authorized_need: true,
      authorization_evidence_ref: 'owner-approval-2026-10-14',
    },
  });
  assert.equal(authorized.kind, 'convene_request');
  if (authorized.kind === 'convene_request') {
    assert.equal(authorized.request.separately_authorized_need, true);
    assert.equal(authorized.request.source_session_id, 'sess-intent-1');
  }
});

test('dispatch: a rerun names its source session and never inherits approval', async () => {
  const owner = principal(OWNER);
  const rerun = await dispatcher.dispatch(owner, {
    text: 'Run that council again',
    session_id: 'sess-intent-1',
  });
  assert.equal(rerun.kind, 'rerun_request');
  if (rerun.kind === 'rerun_request') {
    assert.equal(rerun.request.source_session_id, 'sess-intent-1');
    assert.ok(rerun.request.requires.some((line) => line.includes('never carries over')));
  }
  await assert.rejects(
    dispatcher.dispatch(owner, { text: 'Run that council again' }),
    (err: unknown) => err instanceof Intents.CouncilIntentError && err.code === 'COUNCIL_INTENT_SESSION_REQUIRED',
  );
});
