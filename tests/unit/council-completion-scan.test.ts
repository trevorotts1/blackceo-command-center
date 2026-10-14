/**
 * CWE-037 completion-scan tests, including T096 (directive Sections
 * 20, 20.4, 35.9).
 *
 * T096: "A council-generated action cannot recursively trigger
 * another council without a separately authorized need." The scan
 * side of that contract: when a session completes, the trigger reads
 * the REAL recorded state (the verdict row, the plan rows, the
 * journal's condition-verification records, and the CWE-036 release
 * decisions recorded through the release-outcome hook) and enqueues
 * proposal candidates whose narration carries that state verbatim,
 * including the per-task refusal reasons. Enqueueing and processing
 * create proposals only, never tasks. Re-running the trigger is
 * deduplicated by candidate key, and the outcome-review candidate is
 * deduplicated by decision and review period, so a completed session
 * cannot flood or retrigger itself.
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
import type { TaskReleaseOutcome } from '../../src/lib/council/kanban/action-execution';
import type { CouncilCompletionScanner } from '../../src/lib/council/intents/completion-scan';

type Db = import('better-sqlite3').Database;

let db: Db;
let repositories: CouncilRepositories;
let queue: CouncilScanQueue;
let scanner: CouncilCompletionScanner;
let Intents: typeof import('../../src/lib/council/intents/index');
let Kanban: typeof import('../../src/lib/council/kanban/index');
let envelopeFromScopeFn: typeof import('../../src/lib/council/store').envelopeFromScope;
let canonicalHashFn: typeof import('../../src/lib/council/contracts').canonicalHash;
let fixtures: typeof import('../../src/lib/council/contracts/fixtures/examples');
let closeDbFn: () => void;

const OWNER = 'owner-1';
const HASH = 'b'.repeat(64);
const REFUSAL_REASON =
  'No standing execution grant is active for this session (status: missing); ' +
  'plan approval alone never authorizes execution, so the task stays held.';
const FIXED_NOW = '2026-10-14T15:00:00.000Z';

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

function makeStoredSession(sessionId: string, state: string): CouncilStoredSession {
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
      state: state as CouncilStoredSession['state']['state'],
      state_version: 3,
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

function refusedOutcome(): TaskReleaseOutcome {
  return {
    action_id: 'act-1',
    task_id: 'task-refused-1',
    released: false,
    already_released: false,
    decision: {
      plan_id: 'plan-scan-1',
      plan_hash: 'plan-hash-scan-1',
      action_id: 'act-1',
      task_id: 'task-refused-1',
      operation_id: 'op-scan-1',
      releasable: false,
      already_released: false,
      grant_ref: null,
      grant_status: 'missing',
      checks: {
        plan_current: true,
        approval_complete: true,
        link_matches_plan: true,
        handler_supported: true,
        grant_active: false,
        operation_admitted: false,
        dependencies_satisfied: true,
        prerequisites_verified: true,
      },
      reasons: [REFUSAL_REASON],
      dependencies: [],
      conditions: [],
      evaluated_at: '2026-10-14T14:00:00.000Z',
    },
  };
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
  Kanban = await import('../../src/lib/council/kanban/index');
  Intents = await import('../../src/lib/council/intents/index');
  scanner = new Intents.CouncilCompletionScanner({
    repositories,
    db,
    scanQueue: queue,
    now: () => FIXED_NOW,
  });

  const now = new Date().toISOString();
  db.prepare(
    `INSERT OR IGNORE INTO companies (id, name, slug, config, created_at, updated_at)
     VALUES ('company-a', 'Company A', 'company-a', '{}', ?, ?)`,
  ).run(now, now);
  db.prepare(
    `INSERT OR IGNORE INTO workspaces (id, name, slug, company_id, created_at, updated_at)
     VALUES ('default', 'Default', 'default', 'company-a', ?, ?)`,
  ).run(now, now);
});

after(() => {
  closeDbFn();
});

test('T096 setup: the release-outcome hook records CWE-036 refusal decisions verbatim, idempotently', async () => {
  const owner = principal(OWNER);
  makeStoredSession('sess-scan-037', 'COMPLETED');
  db.prepare(`INSERT INTO tasks (id, title, status) VALUES ('task-refused-1', 'Send the pilot recap email', 'backlog')`).run();

  const first = await scanner.recordReleaseOutcomes(owner, 'sess-scan-037', [
    refusedOutcome(),
    { ...refusedOutcome(), action_id: 'act-9', task_id: 'task-released-9', released: true },
  ]);
  assert.deepEqual(first, { recorded: 1, skipped: 1 });

  const again = await scanner.recordReleaseOutcomes(owner, 'sess-scan-037', [refusedOutcome()]);
  assert.deepEqual(again, { recorded: 0, skipped: 1 });

  const entries = Kanban.listKanbanJournalEntries(
    db,
    { tenant_id: 'tenant-a', company_id: 'company-a' },
    'sess-scan-037',
  );
  const recorded = entries.filter((entry) => entry.action === 'release_outcome_recorded');
  assert.equal(recorded.length, 1);
  assert.deepEqual(recorded[0].payload.reasons, [REFUSAL_REASON]);
});

test('T096: a completed session produces scan proposals whose narration reads the real recorded state', async () => {
  const owner = principal(OWNER);
  const sessionId = 'sess-scan-037';

  // Recorded verdict: two proposed actions, review criteria on record.
  db.prepare(
    `INSERT INTO council_verdicts
       (tenant_id, company_id, session_id, id, brief_revision, verdict_json, canonical_hash,
        verdict_hash, cards_root_hash, brief_hash, policy_hash, validation_run_hash, label,
        validation, ratification, chosen_option_id, client_decision_json, created_at)
     VALUES ('tenant-a', 'company-a', ?, 'verdict-scan-1', 1, ?, ?, ?, ?, ?, ?, ?,
             'GO_WITH_CONDITIONS', 'valid', 'not_required', NULL, NULL, '2026-10-14T12:00:00.000Z')`,
  ).run(
    sessionId,
    JSON.stringify({
      result_kind: 'scored',
      verdict_revision: 1,
      label: 'GO_WITH_CONDITIONS',
      action_proposals: [
        { action_id: 'act-1', title: 'Send the pilot recap email', rationale: 'Close the loop with the pilot cohort.', source_condition_ids: ['cond-1', 'cond-2'] },
        { action_id: 'act-2', title: 'Draft the pricing follow-up brief', rationale: 'The pricing unknown needs a bounded next look.', source_condition_ids: [] },
      ],
      review_criteria: ['Pilot reply rate above 20 percent by the November review'],
    }),
    HASH, HASH, HASH, HASH, HASH, HASH,
  );

  // Recorded plan: only act-1 was ever placed in a plan.
  db.prepare(
    `INSERT INTO council_action_proposals
       (tenant_id, company_id, session_id, id, verdict_id, plan_hash, actions_json, risk_class, status, supersedes_id, created_at)
     VALUES ('tenant-a', 'company-a', ?, 'plan-scan-1', 'verdict-scan-1', 'plan-hash-scan-1', ?, 'low', 'approved', NULL, '2026-10-14T13:00:00.000Z')`,
  ).run(
    sessionId,
    JSON.stringify([
      { action_id: 'act-1', title: 'Send the pilot recap email', source_condition_ids: ['cond-1', 'cond-2'] },
    ]),
  );

  // Recorded advisor card carrying both conditions' descriptions.
  db.prepare(
    `INSERT INTO council_cards
       (tenant_id, company_id, session_id, id, kind, seat_id, round, brief_revision, operation_id,
        payload_fingerprint, card_json, canonical_hash, model_receipt_json, validation, created_at)
     VALUES ('tenant-a', 'company-a', ?, 'card-scan-1', 'advisor', 'tiffany-aliche', 1, 1, 'op-card-scan-1',
             ?, ?, ?, NULL, 'valid', '2026-10-14T11:00:00.000Z')`,
  ).run(
    sessionId,
    HASH,
    JSON.stringify({
      conditions: [
        { id: 'cond-1', description: 'Confirm the pilot list is final', verification_method: 'Owner confirms the exported list' },
        { id: 'cond-2', description: 'Verify the sender domain is authenticated', verification_method: 'DNS record check' },
      ],
    }),
    HASH,
  );

  // cond-1 carries committed verification evidence; cond-2 does not.
  const journal = await import('../../src/lib/council/kanban/journal');
  db.transaction(() => {
    journal.appendKanbanJournalEvent(
      db,
      { tenant_id: 'tenant-a', company_id: 'company-a' },
      sessionId,
      {
        eventId: 'evt-cond-1',
        actorSubject: OWNER,
        action: 'condition_verified',
        createdAt: '2026-10-14T13:30:00.000Z',
        data: {
          condition_id: 'cond-1',
          status: 'satisfied',
          verification_method: 'Owner confirms the exported list',
          evidence_refs: ['evidence:pilot-list-export'],
          authorization: { permission: 'execute' },
        },
      },
    );
  }).immediate();

  const tasksBefore = totalTasks();
  const result = await scanner.runCompletionScan(owner, sessionId, { trigger: 'completion' });

  const kinds = result.enqueued.map((item) => item.candidate_kind);
  assert.deepEqual(kinds, ['task_not_released', 'unplanned_action', 'unverified_condition', 'outcome_review']);
  assert.ok(result.enqueued.every((item) => item.source_session_id === sessionId));
  assert.equal(result.verdict_label, 'GO_WITH_CONDITIONS');
  assert.equal(result.creates_task, false);

  const refusal = result.enqueued[0];
  // The narration reads the recorded refusal reasons verbatim.
  assert.ok(refusal.summary.includes('Send the pilot recap email'));
  assert.ok(refusal.summary.includes(REFUSAL_REASON));

  const unplanned = result.enqueued[1];
  assert.ok(unplanned.summary.includes('Draft the pricing follow-up brief'));
  assert.ok(unplanned.summary.includes('never placed in an action plan'));

  const condition = result.enqueued[2];
  assert.ok(condition.summary.includes('cond-2'));
  assert.ok(condition.summary.includes('Verify the sender domain is authenticated'));
  assert.ok(condition.summary.includes('DNS record check'));

  const review = result.enqueued[3];
  assert.ok(review.summary.includes('GO_WITH_CONDITIONS'));
  assert.ok(review.summary.includes('Pilot reply rate above 20 percent by the November review'));

  assert.ok(result.narration.includes('GO_WITH_CONDITIONS'));
  assert.ok(result.narration.includes(REFUSAL_REASON));

  // Processing the oldest item records a PROPOSAL carrying that same
  // narration, and still creates no task.
  const processed = await queue.processNextScanItem(owner, sessionId);
  assert.equal(processed.processed, true);
  if (processed.processed) {
    assert.equal(processed.proposal.status, 'proposed');
    assert.equal(processed.proposal.creates_task, false);
    assert.equal(processed.proposal.summary, refusal.summary);
  }
  assert.equal(totalTasks(), tasksBefore);

  const chain = repositories.verifyChain(
    envelopeFromScopeFn(
      { tenant_id: 'tenant-a', company_id: 'company-a', installation_id: 'inst-a', owner_subject: null },
      OWNER,
      'owner',
      'read',
    ),
    sessionId,
  );
  assert.equal(chain.ok, true);
});

test('T096 dedup: re-running the trigger enqueues nothing twice; a new review period re-arms only the review', async () => {
  const owner = principal(OWNER);
  const sessionId = 'sess-scan-037';

  const rerun = await scanner.runCompletionScan(owner, sessionId, { trigger: 'completion' });
  assert.equal(rerun.enqueued.length, 0);
  assert.equal(rerun.skipped.length, 4);
  assert.ok(rerun.skipped.every((entry) => entry.dedupe_key.length > 0));

  const entries = Kanban.listKanbanJournalEntries(
    db,
    { tenant_id: 'tenant-a', company_id: 'company-a' },
    sessionId,
  );
  const scans = entries.filter((entry) => entry.action === 'completion_scan_recorded');
  assert.equal(scans.length, 2);
  assert.deepEqual(scans[1].payload.enqueued_scan_item_ids, []);

  // Next review period: only the outcome-review candidate is re-armed
  // (deduplicated by decision and review period, Section 20.4).
  const november = new Intents.CouncilCompletionScanner({
    repositories,
    db,
    scanQueue: queue,
    now: () => '2026-11-03T09:00:00.000Z',
  });
  const nextPeriod = await november.runCompletionScan(owner, sessionId, { trigger: 'scheduled_review' });
  assert.equal(nextPeriod.enqueued.length, 1);
  assert.equal(nextPeriod.enqueued[0].candidate_kind, 'outcome_review');
  assert.equal(nextPeriod.skipped.length, 3);
});

test('the scan fails visibly on a session whose work has not completed', async () => {
  const owner = principal(OWNER);
  makeStoredSession('sess-scan-open', 'ROUND_2');
  await assert.rejects(
    scanner.runCompletionScan(owner, 'sess-scan-open', { trigger: 'completion' }),
    (err: unknown) => err instanceof Intents.CouncilIntentError && err.code === 'COUNCIL_SESSION_NOT_COMPLETED',
  );
  assert.deepEqual(await queue.listPendingScanItems(owner, 'sess-scan-open'), []);
});
