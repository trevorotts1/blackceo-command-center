/**
 * CWE-035 scan queue tests (directive Section 20).
 *
 * The queue lives in the session's CWE-006 hash-chained journal:
 * ordering is journal order, provenance is the source session on every
 * item, processing creates at most a PROPOSAL record and never a task,
 * and "Stop that council" style board commands resolve the existing
 * session instead of creating work.
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

type Db = import('better-sqlite3').Database;

let db: Db;
let repositories: CouncilRepositories;
let queue: CouncilScanQueue;
let Kanban: typeof import('../../src/lib/council/kanban/index');
let envelopeFromScopeFn: typeof import('../../src/lib/council/store').envelopeFromScope;
let canonicalHashFn: typeof import('../../src/lib/council/contracts').canonicalHash;
let fixtures: typeof import('../../src/lib/council/contracts/fixtures/examples');
let closeDbFn: () => void;

const OWNER = 'owner-1';

function principal(subject: string, companyId = 'company-a'): CouncilPrincipal {
  return {
    subject,
    tenantKind: 'client',
    channel: 'browser',
    supportAccess: false,
    scope: {
      tenant_id: 'tenant-a',
      company_id: companyId,
      installation_id: 'inst-a',
      owner_subject: null,
    },
    tenant: {
      tenantId: 'tenant-a',
      companyId,
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
  Kanban = await import('../../src/lib/council/kanban/index');
  const scanModule = await import('../../src/lib/council/kanban/scan-queue');
  queue = new scanModule.CouncilScanQueue({ repositories, db });

  const now = new Date().toISOString();
  const seedCompany = db.prepare(
    `INSERT OR IGNORE INTO companies (id, name, slug, config, created_at, updated_at)
     VALUES (?, ?, ?, '{}', ?, ?)`,
  );
  seedCompany.run('company-a', 'Company A', 'company-a', now, now);
  seedCompany.run('company-b', 'Company B', 'company-b', now, now);
});

after(() => {
  closeDbFn();
});

test('scan queue: FIFO order, source-session provenance, proposal-only processing', async () => {
  const owner = principal(OWNER);
  const session = makeStoredSession('sess-scan-1');

  const enqueued = await queue.enqueueScanItems(owner, 'sess-scan-1', [
    { summary: 'Check whether the pilot cohort needs a second reminder', evidence_refs: ['ev-1'] },
    { summary: 'Review the retention unknown the council flagged' },
    { summary: 'Consider a follow-up session on pricing', candidate_kind: 'follow_up_session' },
  ]);
  assert.equal(enqueued.length, 3);
  assert.ok(enqueued.every((item) => item.source_session_id === 'sess-scan-1'));
  assert.ok(enqueued.every((item) => item.enqueued_by === OWNER));
  assert.ok(
    enqueued[0].sequence < enqueued[1].sequence &&
      enqueued[1].sequence < enqueued[2].sequence,
  );

  const pending = await queue.listPendingScanItems(owner, 'sess-scan-1');
  assert.deepEqual(
    pending.map((item) => item.summary),
    enqueued.map((item) => item.summary),
  );

  const tasksBefore = totalTasks();
  const first = await queue.processNextScanItem(owner, 'sess-scan-1');
  assert.equal(first.processed, true);
  if (first.processed) {
    assert.equal(first.scan_item_id, enqueued[0].scan_item_id);
    assert.equal(first.proposal.status, 'proposed');
    assert.equal(first.proposal.creates_task, false);
    assert.equal(first.proposal.source_session_id, 'sess-scan-1');
    assert.equal(first.proposal.summary, enqueued[0].summary);
  }
  // Processing creates a proposal record and NO task of any kind.
  assert.equal(totalTasks(), tasksBefore);

  const second = await queue.processNextScanItem(owner, 'sess-scan-1');
  const third = await queue.processNextScanItem(owner, 'sess-scan-1');
  assert.equal(second.processed, true);
  assert.equal(third.processed, true);
  const drained = await queue.processNextScanItem(owner, 'sess-scan-1');
  assert.deepEqual(drained, { processed: false, reason: 'queue_empty' });

  const proposals = await queue.listScanProposals(owner, 'sess-scan-1');
  assert.equal(proposals.length, 3);
  assert.deepEqual(
    proposals.map((p) => p.scan_item_id),
    enqueued.map((item) => item.scan_item_id),
  );
  assert.equal(totalTasks(), tasksBefore);

  const chain = repositories.verifyChain(
    envelopeFromScopeFn(session.scope, OWNER, 'owner', 'read'),
    'sess-scan-1',
  );
  assert.equal(chain.ok, true);
});

test('scan queue bounds: depth cap and item size cap fail visibly', async () => {
  const owner = principal(OWNER);
  makeStoredSession('sess-scan-2');
  const small = new Kanban.CouncilScanQueue({ repositories, db, maxPending: 2 });
  await small.enqueueScanItems(owner, 'sess-scan-2', [{ summary: 'one' }, { summary: 'two' }]);
  await assert.rejects(
    small.enqueueScanItems(owner, 'sess-scan-2', [{ summary: 'three' }]),
    (err: unknown) => err instanceof Kanban.CouncilKanbanError && err.code === 'COUNCIL_SCAN_QUEUE_FULL',
  );
  // Processing frees capacity again.
  const processed = await small.processNextScanItem(owner, 'sess-scan-2');
  assert.equal(processed.processed, true);
  const refilled = await small.enqueueScanItems(owner, 'sess-scan-2', [{ summary: 'three' }]);
  assert.equal(refilled.length, 1);

  const tiny = new Kanban.CouncilScanQueue({ repositories, db, maxItemBytes: 32 });
  await assert.rejects(
    tiny.enqueueScanItems(owner, 'sess-scan-2', [{ summary: 'a summary far over thirty two bytes' }]),
    (err: unknown) => err instanceof Kanban.CouncilKanbanError && err.code === 'COUNCIL_SCAN_ITEM_TOO_LARGE',
  );
  await assert.rejects(
    queue.enqueueScanItems(owner, 'sess-scan-2', [{ summary: '   ' }]),
    (err: unknown) => err instanceof Kanban.CouncilKanbanError && err.code === 'COUNCIL_SCAN_ITEM_INVALID',
  );
});

test('scan queue scope: another company cannot enqueue, read, or process', async () => {
  const foreign = principal(OWNER, 'company-b');
  await assert.rejects(
    queue.enqueueScanItems(foreign, 'sess-scan-1', [{ summary: 'intrusion' }]),
    (err: unknown) => err instanceof Kanban.CouncilKanbanError && err.code === 'COUNCIL_SESSION_NOT_FOUND',
  );
  await assert.rejects(
    queue.listPendingScanItems(foreign, 'sess-scan-1'),
    (err: unknown) => err instanceof Kanban.CouncilKanbanError && err.code === 'COUNCIL_SESSION_NOT_FOUND',
  );
  await assert.rejects(
    queue.processNextScanItem(foreign, 'sess-scan-1'),
    (err: unknown) => err instanceof Kanban.CouncilKanbanError && err.code === 'COUNCIL_SESSION_NOT_FOUND',
  );
});

test('"Stop that council" resolves the existing session and creates nothing', async () => {
  const owner = principal(OWNER);
  const tasksBefore = totalTasks();
  // Both fixture sessions carry the same created_at; make sess-scan-2
  // unambiguously the most recently updated session for resolution.
  db.prepare(`UPDATE council_sessions SET updated_at = '2027-01-01T00:00:00.000Z' WHERE id = 'sess-scan-2'`).run();

  const stopped = await queue.resolveBoardCommand(owner, { text: 'Stop that council' });
  assert.equal(stopped.kind, 'session_command');
  if (stopped.kind === 'session_command') {
    assert.equal(stopped.command, 'stop');
    // Two sessions exist in this file; the most recently updated
    // non-terminal one resolves (sess-scan-2 was touched last).
    assert.equal(stopped.session_id, 'sess-scan-2');
    assert.equal(stopped.creates_task, false);
    assert.equal(stopped.resolution, 'resolve_existing_session_via_trusted_api');
  }
  assert.equal(totalTasks(), tasksBefore);

  const paused = await queue.resolveBoardCommand(owner, {
    text: 'Pause it please',
    session_id: 'sess-scan-1',
  });
  assert.equal(paused.kind, 'session_command');
  if (paused.kind === 'session_command') {
    assert.equal(paused.command, 'pause');
    assert.equal(paused.session_id, 'sess-scan-1');
  }

  // A verb with no council reference and no session does not resolve,
  // and ordinary work requests are not session commands at all.
  const noReference = await queue.resolveBoardCommand(owner, { text: 'Stop by the store later' });
  assert.deepEqual(noReference, {
    kind: 'unresolved',
    reason: 'no_council_reference',
    creates_task: false,
  });
  const notACommand = await queue.resolveBoardCommand(owner, { text: 'Create a task for the council notes' });
  assert.deepEqual(notACommand, {
    kind: 'unresolved',
    reason: 'no_session_command',
    creates_task: false,
  });
  assert.equal(totalTasks(), tasksBefore);

  // The resolution is journaled on the resolved session's chain.
  const entries = Kanban.listKanbanJournalEntries(
    db,
    { tenant_id: 'tenant-a', company_id: 'company-a' },
    'sess-scan-2',
  );
  assert.ok(entries.some((entry) => entry.action === 'board_command_resolved'));
});
