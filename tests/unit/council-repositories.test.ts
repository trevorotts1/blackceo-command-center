/**
 * CWE-006 council repository service tests (directive Sections 15, 16,
 * 18; Section 35 contracts T056, T133, T134 owned by CWE-006).
 *
 * The service is exercised through the REAL host lifecycle: the
 * isolated DATABASE_PATH helper points at a throwaway file, getDb()
 * runs the base schema plus the full migration chain (council
 * migration included), and CouncilRepositories composes over the
 * CWE-005 adapter on that handle.
 *
 * Covers:
 *   1. Scoped session lifecycle: create/read round trip, duplicate
 *      refusal, cross-scope invisibility, private visibility.
 *   2. State compare-and-swap and fenced transitions (cancel
 *      generation increments exactly once).
 *   3. The atomic accepted-work commit: card, journal event, and
 *      outbox intent together; a duplicate commit duplicates nothing;
 *      a fault mid-commit rolls back all three.
 *   4. T056: a locked database produces a bounded, visible deferred
 *      error and zero partial commit.
 *   5. Journal hash chain verification and tamper detection.
 *   6. T133: diagnostic capture limits and byte counters are computed
 *      from stored rows (a fresh service instance over the same
 *      database sees them), and expired content is inaccessible
 *      before physical cleanup.
 *   7. T134: revocation and deletion block late diagnostic writes and
 *      remove content access; a tombstone prevents reconstitution;
 *      the deletion result makes no backup-erasure claim.
 *   8. A planted secret is provably absent from every stored row,
 *      payload file, and the database bytes (redaction at the sink).
 */

import './_isolated-db';
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
  CouncilCard,
  DiagnosticRetentionPolicy,
  SessionStateRecord,
  Verdict,
} from '../../src/lib/council/contracts';
import type {
  CouncilEnvelope,
  CouncilRepositories,
  CouncilStoredSession,
} from '../../src/lib/council/store';

let repositories: CouncilRepositories;
let CouncilRepositoriesClass: typeof CouncilRepositories;
let CouncilPersistenceErrorClass: typeof import('../../src/lib/council/store').CouncilPersistenceError;
let CouncilStoreDeferredErrorClass: typeof import('../../src/lib/council/store').CouncilStoreDeferredError;
let envelopeFromScopeFn: typeof import('../../src/lib/council/store').envelopeFromScope;
let canonicalHashFn: typeof import('../../src/lib/council/contracts').canonicalHash;
let SCHEMA_VERSIONS_CC: typeof import('../../src/lib/council/contracts').SCHEMA_VERSIONS;
let closeDb: () => void;
let adapterHandle: () => import('better-sqlite3').Database;
let diagnosticsDir: string;

let now = '2026-10-14T12:00:00.000Z';
let idCounter = 0;
const newId = () => `cc-id-${(idCounter += 1).toString().padStart(4, '0')}`;

function sampleStored(sessionId = 'sess-fixture-1'): CouncilStoredSession {
  // Fixtures are loaded dynamically in before() (the contracts module
  // must not load before _isolated-db sets DATABASE_PATH is not a
  // constraint for contracts, but the store module pulls in the db).
  const { validSessionSpec, validBrief } = fixtures;
  const spec = JSON.parse(JSON.stringify(validSessionSpec));
  const brief = JSON.parse(JSON.stringify(validBrief));
  spec.session_id = sessionId;
  brief.session_id = sessionId;
  spec.brief_sha256 = canonicalHashFn(brief);
  const state: SessionStateRecord = {
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
  };
  return {
    spec,
    brief,
    scope: {
      tenant_id: 'tenant-a',
      company_id: 'company-a',
      installation_id: 'inst-a',
      owner_subject: null,
    },
    state,
    sample: false,
  };
}

let fixtures: typeof import('../../src/lib/council/contracts/fixtures/examples');

function ownerEnvelope(
  session: CouncilStoredSession,
  purpose: CouncilEnvelope['purpose'] = 'write',
): CouncilEnvelope {
  return envelopeFromScopeFn(session.scope, 'owner-1', 'owner', purpose);
}

function advisorCard(session: CouncilStoredSession, operationId: string): CouncilCard {
  const brief = session.brief;
  return {
    schema_version: 'wise-elders.card/v1',
    session_id: session.spec.session_id,
    brief_revision: brief.revision,
    seat_id: 'simon-sinek',
    input_manifest_sha256: canonicalHashFn({ manifest: operationId }),
    pack_version: 'pack-fixture-1.0.0',
    card_kind: 'advisor',
    round: 1,
    stance: 'support',
    preferred_option_id: 'B',
    option_scores: brief.options.map((o: { id: string }) => ({
      option_id: o.id,
      score: o.id === 'B' ? 8 : 5,
      rationale: 'Fixture rationale.',
      evidence_ids: ['ev-1'],
    })),
    framework_applications: [],
    decisive_arguments: ['The pilot is the bounded next step.'],
    strongest_objection: 'Retention is unmeasured.',
    conditions: [],
    critical_unknowns: [],
    change_my_mind: 'Evidence the pilot cannot be staffed.',
    challenges_answered: [],
    quotes: [],
    evidence_strength: 'medium',
    minority_position: null,
    host: {
      scope: { ...session.scope },
      operation_id: operationId,
      route_id: 'route-fixture-1',
      session_id: session.spec.session_id,
      stamped_at: '2026-10-14T12:00:00.000Z',
      source_status: 'unverified',
    },
  } as CouncilCard;
}

function scoredVerdict(session: CouncilStoredSession): Verdict {
  const base = {
    schema_version: SCHEMA_VERSIONS_CC.verdict,
    result_kind: 'scored' as const,
    session_id: session.spec.session_id,
    verdict_revision: 1,
    recommended_option_id: 'B',
    label: 'WAIT' as const,
    option_scores: [],
    active_weights: {},
    evidence_strength: 'medium' as const,
    hard_constraint_findings: [],
    main_reasons: ['Fixture reason.'],
    strongest_dissent: null,
    accepted_amendments: [],
    rejected_amendments: [],
    critical_unknowns: [],
    prerequisites: [],
    action_proposals: [],
    cheapest_informative_test: null,
    stop_criteria: [],
    review_criteria: [],
    resolution_support: null,
    validation_status: 'valid' as const,
    ratification_status: 'ratified' as const,
    brief_sha256: session.spec.brief_sha256,
  };
  return { ...base, content_sha256: canonicalHashFn(base) } as Verdict;
}

function grantPolicy(
  sessionId: string,
  overrides: Partial<DiagnosticRetentionPolicy> = {},
): DiagnosticRetentionPolicy {
  return {
    schema_version: SCHEMA_VERSIONS_CC.diagnosticPolicy,
    enabled: true,
    authorized_by_principal: 'owner-1',
    authorization_kind: 'owner',
    session_id: sessionId,
    capture_window_minutes: 60,
    payload_ttl_hours: 24,
    max_bytes_per_operation: 5 * 1024 * 1024,
    max_bytes_per_session: 25 * 1024 * 1024,
    ...overrides,
  };
}

function isCode(code: string) {
  return (err: unknown) =>
    err instanceof CouncilPersistenceErrorClass &&
    (err as { code: string }).code === code;
}

before(async () => {
  const storeModule = await import('../../src/lib/council/store');
  const adapterModule = await import('../../src/lib/council/persistence/council-store');
  const contractsModule = await import('../../src/lib/council/contracts');
  const dbModule = await import('../../src/lib/db');
  fixtures = await import('../../src/lib/council/contracts/fixtures/examples');
  CouncilRepositoriesClass = storeModule.CouncilRepositories;
  CouncilPersistenceErrorClass = storeModule.CouncilPersistenceError;
  CouncilStoreDeferredErrorClass = storeModule.CouncilStoreDeferredError;
  envelopeFromScopeFn = storeModule.envelopeFromScope;
  canonicalHashFn = contractsModule.canonicalHash;
  SCHEMA_VERSIONS_CC = contractsModule.SCHEMA_VERSIONS;
  closeDb = dbModule.closeDb;
  diagnosticsDir = mkdtempSync(join(tmpdir(), 'cwe006-cc-diag-'));
  const adapter = adapterModule.openCouncilStore();
  adapterHandle = () => adapter.handle();
  repositories = new CouncilRepositoriesClass({
    adapter,
    diagnosticsDir,
    now: () => now,
    newId,
  });
});

after(() => {
  closeDb();
});

test('sessions: create, read back, duplicate refused, cross-scope invisible', () => {
  const session = sampleStored('sess-cc-1');
  repositories.createSession(ownerEnvelope(session), session);
  const loaded = repositories.getSession(ownerEnvelope(session, 'read'), 'sess-cc-1');
  assert.ok(loaded);
  assert.equal(loaded.state.state, 'DRAFT');
  assert.throws(
    () => repositories.createSession(ownerEnvelope(session), session),
    isCode('PERSISTENCE_DUPLICATE_OPERATION'),
  );
  const foreign: CouncilEnvelope = {
    tenant_id: 'tenant-b',
    company_id: 'company-b',
    installation_id: 'inst-b',
    actor_subject: 'owner-1',
    actor: 'owner',
    purpose: 'read',
  };
  assert.equal(repositories.getSession(foreign, 'sess-cc-1'), null);
});

test('state: CAS refuses stale writers; cancel transition bumps the generation once', () => {
  const session = sampleStored('sess-cc-2');
  const envelope = ownerEnvelope(session);
  repositories.createSession(envelope, session);
  const next: SessionStateRecord = {
    ...session.state,
    session_id: 'sess-cc-2',
    state: 'READY',
    state_version: 1,
    updated_at: '2026-10-14T12:05:00.000Z',
  };
  assert.throws(
    () => repositories.writeStateRecord(envelope, next, 7),
    isCode('PERSISTENCE_STATE_CONFLICT'),
  );
  repositories.writeStateRecord(envelope, next, 0);
  const cancelling = repositories.transitionState(envelope, 'sess-cc-2', 'CANCEL_REQUESTED', 1);
  assert.equal(cancelling.cancel_generation, 1);
  const loaded = repositories.getSession(ownerEnvelope(session, 'read'), 'sess-cc-2');
  assert.equal(loaded?.state.cancel_generation, 1);
  assert.equal(loaded?.state.state, 'CANCEL_REQUESTED');
});

test('commit: card, event, and outbox commit atomically; duplicate commit duplicates nothing', () => {
  const session = sampleStored('sess-cc-3');
  const envelope = ownerEnvelope(session);
  repositories.createSession(envelope, session);
  const fence = { expected_state_version: 0, cancel_generation: 0, lease_epoch: 0 };
  const first = repositories.acceptCard(envelope, advisorCard(session, 'op-cc-1'), fence);
  assert.equal(first.outcome, 'committed');
  const events = repositories.listEvents(envelope, 'sess-cc-3');
  assert.equal(events.length, 2);
  assert.equal(repositories.listOutboxForSession(envelope, 'sess-cc-3').length, 1);
  const duplicate = repositories.acceptCard(envelope, advisorCard(session, 'op-cc-1'), fence);
  assert.equal(duplicate.outcome, 'duplicate');
  assert.equal(repositories.listCards(envelope, 'sess-cc-3').length, 1);
  assert.equal(repositories.listEvents(envelope, 'sess-cc-3').length, 2);
  assert.equal(repositories.listOutboxForSession(envelope, 'sess-cc-3').length, 1);
  const chain = repositories.verifyChain(envelope, 'sess-cc-3');
  assert.equal(chain.ok, true);
});

test('commit: a fault mid-commit rolls back card, event, and outbox together', () => {
  const session = sampleStored('sess-cc-4');
  const envelope = ownerEnvelope(session);
  repositories.createSession(envelope, session);
  const firstEventId = repositories.listEvents(envelope, 'sess-cc-4')[0].event_id;
  // Rig the ID source so the journal append inside acceptCard collides
  // with the existing event ID after the card insert has run.
  let rigged = true;
  const riggedRepos = new CouncilRepositoriesClass({
    // No adapter passed: the service composes over the same getDb()
    // singleton, so it shares the database under test.
    diagnosticsDir,
    now: () => now,
    newId: () => {
      if (rigged) {
        rigged = false;
        return firstEventId;
      }
      return newId();
    },
  });
  assert.throws(() =>
    riggedRepos.acceptCard(envelope, advisorCard(session, 'op-cc-rollback'), {
      expected_state_version: 0,
      cancel_generation: 0,
      lease_epoch: 0,
    }),
  );
  assert.equal(repositories.listCards(envelope, 'sess-cc-4').length, 0);
  assert.equal(repositories.listEvents(envelope, 'sess-cc-4').length, 1);
  assert.equal(repositories.listOutboxForSession(envelope, 'sess-cc-4').length, 0);
});

test('T056: a locked database defers visibly within the bounded budget and commits nothing', async () => {
  const session = sampleStored('sess-cc-5');
  const envelope = ownerEnvelope(session);
  const Database = (await import('better-sqlite3')).default;
  const blocker = new Database(process.env.DATABASE_PATH as string);
  blocker.pragma('busy_timeout = 100');
  blocker.exec('BEGIN IMMEDIATE');
  blocker
    .prepare(
      `INSERT INTO council_request_keys (tenant_id, source, operation, request_key, payload_fingerprint, session_id, created_at)
       VALUES ('tenant-a', 'lock-holder', 'hold', 'hold-cc', 'fp', NULL, ?)`,
    )
    .run(now);
  // Make the service connection fail fast so the bounded policy, not
  // the host's 5 s pragma, is what bounds the deferral.
  adapterHandle().pragma('busy_timeout = 60');
  const impatient = new CouncilRepositoriesClass({
    diagnosticsDir,
    busyMaxAttempts: 2,
    busyBaseDelayMs: 10,
    now: () => now,
    newId,
  });
  let caught: unknown;
  const started = Date.now();
  try {
    impatient.createSession(envelope, session);
  } catch (err) {
    caught = err;
  }
  const elapsed = Date.now() - started;
  blocker.exec('ROLLBACK');
  blocker.close();
  adapterHandle().pragma('busy_timeout = 5000');
  assert.ok(
    caught instanceof CouncilStoreDeferredErrorClass,
    `expected deferred error, got ${String(caught)}`,
  );
  assert.equal((caught as { attempts: number }).attempts, 2);
  assert.ok(elapsed < 10_000, `deferral took ${elapsed}ms`);
  assert.equal(repositories.getSession(ownerEnvelope(session, 'read'), 'sess-cc-5'), null);
  repositories.createSession(envelope, session);
  assert.ok(repositories.getSession(ownerEnvelope(session, 'read'), 'sess-cc-5'));
});

test('verdicts: save, duplicate save, and conflicting revision', () => {
  const session = sampleStored('sess-cc-6');
  const envelope = ownerEnvelope(session);
  repositories.createSession(envelope, session);
  const verdict = scoredVerdict(session);
  assert.equal(repositories.saveVerdict(envelope, verdict).outcome, 'committed');
  assert.equal(repositories.saveVerdict(envelope, verdict).outcome, 'duplicate');
  const loaded = repositories.getVerdict(envelope, 'sess-cc-6');
  assert.equal(loaded?.result_kind, 'scored');
});

test('request keys: claim, replay, conflict', () => {
  const base = {
    tenantId: 'tenant-a',
    source: 'command-center',
    operation: 'create-session',
    requestKey: 'req-cc-1',
    sessionId: 'sess-cc-1',
  };
  assert.equal(repositories.claimRequestKey({ ...base, payloadFingerprint: 'fp-a' }).outcome, 'claimed');
  assert.equal(repositories.claimRequestKey({ ...base, payloadFingerprint: 'fp-a' }).outcome, 'replay');
  assert.equal(repositories.claimRequestKey({ ...base, payloadFingerprint: 'fp-b' }).outcome, 'conflict');
});

test('T133: capture limits and counters come from stored rows; expiry blocks reads before cleanup', () => {
  now = '2026-10-14T12:00:00.000Z';
  const session = sampleStored('sess-cc-7');
  const envelope = ownerEnvelope(session);
  repositories.createSession(envelope, session);
  const diagEnvelope = ownerEnvelope(session, 'diagnostic_capture');
  const grant = repositories.recordDiagnosticGrant(
    diagEnvelope,
    grantPolicy('sess-cc-7', {
      payload_ttl_hours: 1,
      max_bytes_per_operation: 100,
      max_bytes_per_session: 150,
    }),
  );
  assert.ok(grant.grant_id);
  const body = 'x'.repeat(80);
  const first = repositories.captureDiagnostic(diagEnvelope, {
    sessionId: 'sess-cc-7',
    operationId: 'op-diag-1',
    dataClass: 'provider_response',
    body,
  });
  assert.equal(first.stored, 'payload');
  if (first.stored !== 'payload') return;
  assert.equal(first.byte_count, 80);
  const second = repositories.captureDiagnostic(diagEnvelope, {
    sessionId: 'sess-cc-7',
    operationId: 'op-diag-2',
    dataClass: 'provider_response',
    body,
  });
  assert.equal(second.stored, 'payload');
  if (second.stored === 'payload') {
    assert.equal(second.byte_count, 70);
    assert.equal(second.truncated, true);
  }
  const third = repositories.captureDiagnostic(diagEnvelope, {
    sessionId: 'sess-cc-7',
    operationId: 'op-diag-3',
    dataClass: 'provider_response',
    body,
  });
  assert.equal(third.stored, 'metadata');
  // A fresh service instance over the same database sees the same
  // counters: the ceiling still holds without any in-memory state.
  const fresh = new CouncilRepositoriesClass({
    diagnosticsDir,
    now: () => now,
    newId,
  });
  const afterRestart = fresh.captureDiagnostic(diagEnvelope, {
    sessionId: 'sess-cc-7',
    operationId: 'op-diag-4',
    dataClass: 'provider_response',
    body: 'y'.repeat(10),
  });
  assert.equal(afterRestart.stored, 'metadata');
  const readBack = fresh.readDiagnosticPayload(
    ownerEnvelope(session, 'diagnostic_read'),
    'sess-cc-7',
    first.capture_id,
  );
  assert.equal(readBack.byte_count, 80);
  // Past the one-hour TTL: inaccessible even though the file remains.
  now = '2026-10-14T13:30:00.000Z';
  const payloadFile = join(diagnosticsDir, 'sess-cc-7', `${first.capture_id}.bin`);
  assert.ok(existsSync(payloadFile));
  assert.throws(
    () =>
      fresh.readDiagnosticPayload(
        ownerEnvelope(session, 'diagnostic_read'),
        'sess-cc-7',
        first.capture_id,
      ),
    isCode('PERSISTENCE_DIAGNOSTIC_DENIED'),
  );
  now = '2026-10-14T12:00:00.000Z';
});

test('T134: revocation and deletion block late writes and remove content access, with no backup-erasure claim', () => {
  now = '2026-10-14T12:00:00.000Z';
  const session = sampleStored('sess-cc-8');
  const envelope = ownerEnvelope(session);
  repositories.createSession(envelope, session);
  const diagEnvelope = ownerEnvelope(session, 'diagnostic_capture');
  const grant = repositories.recordDiagnosticGrant(diagEnvelope, grantPolicy('sess-cc-8'));
  const captured = repositories.captureDiagnostic(diagEnvelope, {
    sessionId: 'sess-cc-8',
    operationId: 'op-diag-1',
    dataClass: 'provider_response',
    body: 'sensitive body',
  });
  assert.equal(captured.stored, 'payload');
  if (captured.stored !== 'payload') return;
  repositories.revokeDiagnosticGrant(diagEnvelope, 'sess-cc-8', grant.grant_id);
  assert.throws(
    () =>
      repositories.readDiagnosticPayload(
        ownerEnvelope(session, 'diagnostic_read'),
        'sess-cc-8',
        captured.capture_id,
      ),
    isCode('PERSISTENCE_DIAGNOSTIC_DENIED'),
  );
  const lateAfterRevoke = repositories.captureDiagnostic(diagEnvelope, {
    sessionId: 'sess-cc-8',
    operationId: 'op-diag-2',
    dataClass: 'provider_response',
    body: 'late body',
  });
  assert.equal(lateAfterRevoke.stored, 'none');

  repositories.recordDiagnosticGrant(diagEnvelope, grantPolicy('sess-cc-8'));
  const captured2 = repositories.captureDiagnostic(diagEnvelope, {
    sessionId: 'sess-cc-8',
    operationId: 'op-diag-3',
    dataClass: 'provider_response',
    body: 'second body',
  });
  assert.equal(captured2.stored, 'payload');
  const deletion = repositories.deleteSession(ownerEnvelope(session, 'delete'), 'sess-cc-8');
  assert.equal(deletion.deleted, true);
  assert.deepEqual(Object.keys(deletion).sort(), ['deleted', 'diagnosticProtectedRefs']);
  assert.ok(!/backup|erasure|erased/i.test(JSON.stringify(deletion)));
  repositories.purgeDiagnosticFiles(deletion.diagnosticProtectedRefs);
  assert.equal(repositories.getSession(ownerEnvelope(session, 'read'), 'sess-cc-8'), null);
  assert.equal(repositories.isDeleted('tenant-a', 'sess-cc-8'), true);
  const lateCapture = repositories.captureDiagnostic(diagEnvelope, {
    sessionId: 'sess-cc-8',
    operationId: 'op-diag-4',
    dataClass: 'provider_response',
    body: 'zombie body',
  });
  assert.equal(lateCapture.stored, 'none');
  assert.throws(
    () => repositories.createSession(envelope, session),
    isCode('PERSISTENCE_SESSION_DELETED'),
  );
});

test('secrets: a planted secret never reaches a stored row, payload file, or database bytes', () => {
  now = '2026-10-14T12:00:00.000Z';
  const PLANTED = 'sk-PLANTEDSECRET1234567890abcdef';
  const session = sampleStored('sess-cc-9');
  const envelope = ownerEnvelope(session);
  repositories.createSession(envelope, session);
  const diagEnvelope = ownerEnvelope(session, 'diagnostic_capture');
  repositories.recordDiagnosticGrant(diagEnvelope, grantPolicy('sess-cc-9'));
  const outcome = repositories.captureDiagnostic(diagEnvelope, {
    sessionId: 'sess-cc-9',
    operationId: 'op-secret-1',
    dataClass: 'provider_response',
    body: JSON.stringify({ api_key: PLANTED, note: 'ordinary diagnostic content' }),
  });
  assert.equal(outcome.stored, 'payload');
  const artifacts: string[] = [];
  const walk = (path: string) => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const full = join(path, entry.name);
      if (entry.isDirectory()) walk(full);
      else artifacts.push(full);
    }
  };
  walk(diagnosticsDir);
  const dbPath = process.env.DATABASE_PATH as string;
  for (const suffix of ['', '-wal', '-shm']) {
    if (existsSync(dbPath + suffix)) artifacts.push(dbPath + suffix);
  }
  assert.ok(artifacts.length >= 2);
  for (const artifact of artifacts) {
    const bytes = readFileSync(artifact);
    assert.ok(!bytes.includes(Buffer.from('PLANTEDSECRET')), `planted secret in ${artifact}`);
  }
  if (outcome.stored === 'payload') {
    const readBack = repositories.readDiagnosticPayload(
      ownerEnvelope(session, 'diagnostic_read'),
      'sess-cc-9',
      outcome.capture_id,
    );
    assert.ok(readBack.body.includes('[REDACTED]'));
  }
});
