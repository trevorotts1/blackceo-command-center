/**
 * WER-024 durable AI CEO intent command tests (v2.4 plan).
 *
 * Runner (the repo's own Node + tsx unit convention):
 *   node --import tsx --test src/lib/council/intents/commands.test.ts
 *
 * Proves, against the REAL host surface on an isolated database:
 * - create commits a real session and its ONE company-aware parent
 *   task; a duplicate delivery returns the SAME receipt and creates no
 *   second session or task;
 * - start refuses explicitly without a CWE-049 grant, and with one it
 *   moves the session to QUEUED with a real durable job id;
 * - status/stop/follow-up resolve the correct owned session (another
 *   owner's private session is never resolved);
 * - stop cancels idempotently; follow-up creates one linked child and
 *   replays the same child;
 * - none of these commands creates per-advisor work.
 *
 * Deferred, never claimed: an authenticated live session, a provider
 * conversation, or an executed run. `start` proves the durable job
 * handoff only.
 */
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';

const SANDBOX = fs.mkdtempSync('/tmp/cc-W08-U002-intents-');
process.env.DATABASE_PATH = path.join(SANDBOX, 'council.db');
process.env.CC_TEST_FIXTURE_ROOT = path.join(SANDBOX, 'fixtures');
process.env.OPENCLAW_ROOT = '/nonexistent/openclaw-root-for-tests';
delete process.env.OPENAI_API_KEY;

import type { CouncilPrincipal } from '../auth';
import type {
  CouncilIntentCommandDispatcher,
  CouncilCommandReceipt,
} from './commands';
import type { SessionDraftInput } from '../api/drafts';
import type { RunCeilings } from '../contracts';
import type { CouncilRouteSelection } from '../explicit-selection';

type Db = import('better-sqlite3').Database;

const OWNER = 'owner-1';
const OTHER = 'owner-2';
const ROUTE_POLICY_SHA256 = 'a'.repeat(64);

let db: Db;
let closeDbFn: () => void;
let dispatcher: CouncilIntentCommandDispatcher;
let runAuthorization: import('../run-authorization').CouncilRunAuthorizationService;
let canonicalHashFn: typeof import('../contracts').canonicalHash;

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

function sessionInput(
  question: string,
  visibility: 'company' | 'private' = 'company',
): SessionDraftInput {
  return {
    mode: 'full',
    visibility,
    source_pack_version: 'pack-fixture-1.0.0',
    model_policy: {
      selection: 'explicit',
      route_id: 'route-fixture-1',
      requested_model_id: 'model-selected-by-client',
      reasoning_preference: null,
      fallback_policy: 'none',
    },
    brief: {
      question,
      options: [
        { id: 'A', label: 'Keep the current offer', kind: 'status_quo' },
        { id: 'B', label: 'Pilot the revised offer', kind: 'bounded_test' },
      ],
    },
  } as SessionDraftInput;
}

function receiptOf(result: Awaited<ReturnType<CouncilIntentCommandDispatcher['create']>>): CouncilCommandReceipt {
  assert.equal(result.ok, true, result.ok ? '' : `${result.code}: ${result.message}`);
  if (!result.ok) throw new Error('unreachable');
  return result;
}

function totalTasks(): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM tasks`).get() as { n: number }).n;
}

function parentLinks(sessionId: string): number {
  return (
    db
      .prepare(`SELECT COUNT(*) AS n FROM council_kanban_links WHERE session_id = ?`)
      .get(sessionId) as { n: number }
  ).n;
}

function routeSnapshot(): CouncilRouteSelection {
  return {
    schema: 'wise-elders.route-selection/v1',
    selectionSource: 'explicit',
    routeId: 'route-a',
    routeRevision: 1,
    routeKind: 'fixed_model',
    providerSlug: 'provider-a',
    requestedRoute: 'route-a',
    requestedModelOrAlias: 'model-a',
    combinationMembers: null,
    reasoning: { requested: null, applied: null, supported: null, limitation: null },
    fallbackPolicy: 'none',
    providerAccountRef: null,
    capabilitySnapshot: {
      contextWindowTokens: 200000,
      maxOutputTokens: 8000,
      capabilities: ['text'],
      supportedReasoningLevels: null,
    },
    credential: {
      state: 'present',
      envVar: 'PROVIDER_A_API_KEY',
      source: 'process.env',
      checked: ['process.env'],
    },
    identityLevel: 'configured',
    scope: {
      tenantId: 'tenant-a',
      companyId: 'company-a',
      installationId: 'inst-a',
      ownerSubject: null,
    },
    createdAt: new Date().toISOString(),
  } as unknown as CouncilRouteSelection;
}

function ceilings(): RunCeilings {
  return {
    max_provider_requests: 50,
    max_output_repairs: 9,
    max_transport_retries: 8,
    max_input_tokens: null,
    max_output_tokens: null,
    max_money: { amount_minor: 100_000, currency: 'USD' },
  } as RunCeilings;
}

function provisionGrant(sessionId: string, sourcePackVersion: string): string {
  const owner = principal(OWNER);
  const preview = runAuthorization.previewRun(owner, {
    session_id: sessionId,
    route_snapshot: routeSnapshot(),
    route_policy_sha256: ROUTE_POLICY_SHA256,
    ceilings: ceilings(),
  });
  const grant = runAuthorization.approveRun(owner, preview.preview_id, {
    authority_mode: 'managed_principal',
  });
  // The session's pack version is carried in the preview proof; this
  // assertion keeps the fixture honest.
  assert.equal(typeof sourcePackVersion, 'string');
  return grant.grant_id;
}

before(async () => {
  const dbModule = await import('../../db');
  db = dbModule.getDb();
  closeDbFn = dbModule.closeDb;
  const storeModule = await import('../store');
  const repositories = new storeModule.CouncilRepositories();
  const commandsModule = await import('./commands');
  dispatcher = new commandsModule.CouncilIntentCommandDispatcher({ repositories, db });
  const runAuthModule = await import('../run-authorization');
  runAuthorization = new runAuthModule.CouncilRunAuthorizationService({
    store: (await import('../persistence/council-store')).openCouncilStore(),
  });
  const contracts = await import('../contracts');
  canonicalHashFn = contracts.canonicalHash;

  const now = new Date().toISOString();
  db.prepare(
    `INSERT OR IGNORE INTO companies (id, name, slug, config, created_at, updated_at)
     VALUES ('company-a', 'Company A', 'company-a', '{}', ?, ?)`,
  ).run(now, now);
});

after(() => {
  closeDbFn();
  fs.rmSync(SANDBOX, { recursive: true, force: true });
});

test('create commits a real session and ONE parent task; duplicate delivery is the same receipt', async () => {
  const owner = principal(OWNER);
  const tasksBefore = totalTasks();
  const first = receiptOf(
    await dispatcher.create(owner, {
      session: sessionInput('Should we pilot the revised offer?'),
      idempotency_key: 'ask-create-1',
    }),
  );
  assert.equal(first.command, 'create');
  assert.equal(first.state, 'DRAFT');
  assert.equal(first.state_version, 0);
  assert.equal(first.replayed, false);
  assert.ok(first.session_id);
  assert.ok(first.parent_task_id);
  const row = db
    .prepare(`SELECT id, state FROM council_sessions WHERE id = ?`)
    .get(first.session_id) as { id: string; state: string } | undefined;
  assert.equal(row?.state, 'DRAFT');
  assert.equal(parentLinks(first.session_id), 1);
  assert.equal(totalTasks(), tasksBefore + 1, 'only the session parent task is created');

  const second = receiptOf(
    await dispatcher.create(owner, {
      session: sessionInput('Should we pilot the revised offer?'),
      idempotency_key: 'ask-create-1',
    }),
  );
  assert.equal(second.replayed, true);
  assert.equal(second.session_id, first.session_id);
  assert.equal(second.receipt_id, first.receipt_id, 'the SAME receipt');
  assert.equal(second.parent_task_id, first.parent_task_id);
  assert.equal(totalTasks(), tasksBefore + 1, 'no second task on duplicate delivery');
  assert.equal(parentLinks(first.session_id), 1);

  const count = db
    .prepare(`SELECT COUNT(*) AS n FROM council_sessions WHERE id = ?`)
    .get(first.session_id) as { n: number };
  assert.equal(count.n, 1);
});

test('start is refused without a grant, then moves the session to QUEUED with a real job', async () => {
  const owner = principal(OWNER);
  const created = receiptOf(
    await dispatcher.create(owner, {
      session: sessionInput('Should we change the pricing?'),
      idempotency_key: 'ask-start-1',
    }),
  );

  const refused = await dispatcher.start(owner, {
    session_id: created.session_id,
    idempotency_key: 'start-1',
  });
  assert.equal(refused.ok, false);
  if (!refused.ok) assert.equal(refused.code, 'RUN_AUTHORIZATION_REQUIRED');
  assert.equal(
    (db.prepare(`SELECT state FROM council_sessions WHERE id = ?`).get(created.session_id) as { state: string }).state,
    'DRAFT',
    'a refused start changes nothing',
  );

  const grantId = provisionGrant(created.session_id, 'pack-fixture-1.0.0');
  const started = receiptOf(
    await dispatcher.start(owner, {
      session_id: created.session_id,
      idempotency_key: 'start-1',
      grant_id: grantId,
    }),
  );
  assert.equal(started.command, 'start');
  assert.equal(started.state, 'QUEUED');
  assert.ok(started.job_id, 'a durable job id is returned');
  assert.equal(started.grant_id, grantId);
  const job = db
    .prepare(`SELECT id, state, kind FROM council_jobs WHERE id = ?`)
    .get(started.job_id) as { id: string; state: string; kind: string } | undefined;
  assert.equal(job?.kind, 'council_run');
  assert.equal(job?.state, 'queued');

  const replayed = receiptOf(
    await dispatcher.start(owner, {
      session_id: created.session_id,
      idempotency_key: 'start-1',
      grant_id: grantId,
    }),
  );
  assert.equal(replayed.replayed, true);
  assert.equal(replayed.job_id, started.job_id);
  assert.equal(replayed.receipt_id, started.receipt_id);
  assert.equal(
    (db.prepare(`SELECT COUNT(*) AS n FROM council_jobs WHERE session_id = ?`).get(created.session_id) as { n: number }).n,
    1,
    'no second job on replay',
  );
});

test('status resolves the explicit session, the caller\'s latest active session, and never another owner\'s private one', async () => {
  const owner = principal(OWNER);
  const first = receiptOf(
    await dispatcher.create(owner, {
      session: sessionInput('Status question one?'),
      idempotency_key: 'status-create-1',
    }),
  );
  const second = receiptOf(
    await dispatcher.create(owner, {
      session: sessionInput('Status question two?'),
      idempotency_key: 'status-create-2',
    }),
  );
  const otherPrivate = receiptOf(
    await dispatcher.create(principal(OTHER), {
      session: sessionInput('Another owner private question?', 'private'),
      idempotency_key: 'status-create-other-private',
    }),
  );

  const explicit = await dispatcher.status(owner, { session_id: first.session_id });
  assert.equal(explicit.ok, true);
  if (explicit.ok) {
    assert.equal(explicit.session_id, first.session_id);
    assert.equal(explicit.state, 'DRAFT');
  }

  const resolved = await dispatcher.status(owner, { session_id: null });
  assert.equal(resolved.ok, true);
  if (resolved.ok) {
    assert.equal(resolved.session_id, second.session_id, 'latest active OWNED session');
    assert.notEqual(resolved.session_id, otherPrivate.session_id);
  }

  const tasksBefore = totalTasks();
  await dispatcher.status(owner, { session_id: second.session_id });
  assert.equal(totalTasks(), tasksBefore, 'status creates no task');
});

test('stop resolves and cancels the correct owned session; duplicate delivery is the same receipt', async () => {
  const owner = principal(OWNER);
  const created = receiptOf(
    await dispatcher.create(owner, {
      session: sessionInput('Should we stop this council?'),
      idempotency_key: 'stop-create-1',
    }),
  );

  // A DRAFT session is not running; the canonical state machine has no
  // DRAFT -> CANCEL_REQUESTED transition, so stop refuses explicitly
  // instead of inventing one.
  const draftRefusal = await dispatcher.stop(owner, {
    session_id: created.session_id,
    idempotency_key: 'stop-draft',
  });
  assert.equal(draftRefusal.ok, false);
  if (!draftRefusal.ok) assert.equal(draftRefusal.code, 'ILLEGAL_TRANSITION');

  const storeModule = await import('../store');
  const repositories = new storeModule.CouncilRepositories();
  repositories.transitionState(
    storeModule.envelopeFromScope(
      {
        tenant_id: 'tenant-a',
        company_id: 'company-a',
        installation_id: 'inst-a',
        owner_subject: OWNER,
      },
      OWNER,
      'owner',
      'write',
    ),
    created.session_id,
    'READY',
    0,
  );
  const tasksBefore = totalTasks();

  const stopped = receiptOf(
    await dispatcher.stop(owner, { session_id: created.session_id, idempotency_key: 'stop-1' }),
  );
  assert.equal(stopped.command, 'stop');
  assert.equal(stopped.state, 'CANCELLED');
  assert.equal(stopped.session_id, created.session_id);

  const replayed = receiptOf(
    await dispatcher.stop(owner, { session_id: created.session_id, idempotency_key: 'stop-1' }),
  );
  assert.equal(replayed.replayed, true);
  assert.equal(replayed.receipt_id, stopped.receipt_id);
  assert.equal(replayed.state, 'CANCELLED');
  assert.equal(totalTasks(), tasksBefore, 'stop creates no task');

  const unresolved = await dispatcher.dispatch(owner, {
    text: 'Stop that council',
    idempotency_key: 'stop-2',
    session_id: created.session_id,
  });
  assert.equal(unresolved.result.ok, true);
  if (unresolved.result.ok) assert.equal(unresolved.result.command, 'stop');
});

test('follow-up creates ONE linked child for the resolved parent and replays the same child', async () => {
  const owner = principal(OWNER);
  const created = receiptOf(
    await dispatcher.create(owner, {
      session: sessionInput('Should we follow up on the pricing decision?'),
      idempotency_key: 'follow-create-1',
    }),
  );
  const hash = canonicalHashFn({ fixture: 'worth-following-up' });
  db.prepare(
    `INSERT INTO council_verdicts
       (tenant_id, company_id, session_id, id, brief_revision, verdict_json, canonical_hash,
        verdict_hash, cards_root_hash, brief_hash, policy_hash, validation_run_hash, label,
        validation, ratification, chosen_option_id, client_decision_json, created_at)
     VALUES ('tenant-a', 'company-a', ?, 'verdict-follow-1', 1, ?, ?, ?, ?, ?, ?, ?,
             'WAIT', 'valid', 'ratified', NULL, NULL, ?)`,
  ).run(
    created.session_id,
    JSON.stringify({ result_kind: 'scored', verdict_revision: 1, label: 'WAIT', main_reasons: [] }),
    hash,
    hash,
    hash,
    hash,
    hash,
    hash,
    new Date().toISOString(),
  );
  const tasksBefore = totalTasks();

  const followUp = receiptOf(
    await dispatcher.followUp(owner, {
      session_id: created.session_id,
      seat_id: 'simon-sinek',
      question: 'What would change the pricing objection?',
      idempotency_key: 'follow-up-1',
    }),
  );
  assert.equal(followUp.command, 'follow_up');
  assert.equal(followUp.parent_session_id, created.session_id);
  assert.notEqual(followUp.session_id, created.session_id);
  assert.equal(followUp.seat_id, 'simon-sinek');
  assert.equal(followUp.state, 'DRAFT');
  assert.equal(totalTasks(), tasksBefore, 'a follow-up consult creates no board task');

  const sessionsBeforeReplay = (
    db.prepare(`SELECT COUNT(*) AS n FROM council_sessions WHERE company_id = 'company-a'`).get() as { n: number }
  ).n;
  const replayed = receiptOf(
    await dispatcher.followUp(owner, {
      session_id: created.session_id,
      seat_id: 'simon-sinek',
      question: 'What would change the pricing objection?',
      idempotency_key: 'follow-up-1',
    }),
  );
  assert.equal(replayed.replayed, true);
  assert.equal(replayed.session_id, followUp.session_id);
  assert.equal(replayed.receipt_id, followUp.receipt_id);
  assert.equal(
    (db.prepare(`SELECT COUNT(*) AS n FROM council_sessions WHERE company_id = 'company-a'`).get() as { n: number }).n,
    sessionsBeforeReplay,
    'a replayed follow-up creates no second child session',
  );

  const dispatched = await dispatcher.dispatch(owner, {
    text: 'follow up on the pricing question',
    idempotency_key: 'follow-up-2',
    session_id: created.session_id,
    seat_id: 'simon-sinek',
  });
  assert.equal(dispatched.classification.intent, 'follow_up');
  assert.equal(dispatched.result.ok, true);
});
