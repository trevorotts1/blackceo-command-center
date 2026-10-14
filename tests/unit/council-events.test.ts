/**
 * council-events.test.ts — CWE-030 realtime event contracts,
 * projections, cache invalidation, and history over the CWE-006
 * durable journal (directive Sections 16, 17.2, 18.1-18.4, 28.2;
 * binding B07; Section 35 contracts T057, T070, T080, T102).
 *
 * Two layers are exercised against the REAL store on an isolated
 * database:
 *   - The service layer (src/lib/council/events/**): scoped
 *     delivery, the journal fold projection, the outbox pump and
 *     subscription registry, the client reducer contract, and the
 *     SSE stream framing.
 *   - The route layer (GET /api/council/sessions/:id/events):
 *     handler invocation with real signed tenant grants, the
 *     CWE-007 authorization rule, and the stream mode.
 *
 * The B07 properties proven here: a subscriber outside the scope
 * receives NOTHING (empty, not redacted); private session content
 * reaches the owner only, with support receiving at most the
 * non-sensitive invalidation signal; council history comes only
 * from the durable journal, which no code in this layer deletes;
 * replay is gapless and duplicate-free; projections rebuild from
 * the journal alone byte for byte.
 *
 *   node --import tsx --import ./tests/setup/no-owner-telegram.ts \
 *     --test tests/unit/council-events.test.ts
 */

import './_isolated-db';
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { NextRequest } from 'next/server';
import { signTenantGrant } from '../../src/lib/auth/tenant-context';
import { signCsrfToken } from '../../src/lib/csrf-protection';

import type {
  CouncilCard,
  SessionStateRecord,
  Verdict,
} from '../../src/lib/council/contracts';
import type {
  CouncilEnvelope,
  CouncilRepositories,
  CouncilStoredSession,
} from '../../src/lib/council/store';
import type {
  CouncilEventAccess,
  CouncilEventDelivery,
} from '../../src/lib/council/events/delivery';
import type { CouncilWireEvent } from '../../src/lib/council/events/types';

let repositories: CouncilRepositories;
let CouncilRepositoriesClass: typeof CouncilRepositories;
let envelopeFromScopeFn: typeof import('../../src/lib/council/store').envelopeFromScope;
let canonicalHashFn: typeof import('../../src/lib/council/contracts').canonicalHash;
let canonicalStringifyFn: typeof import('../../src/lib/council/contracts').canonicalStringify;
let SCHEMA_VERSIONS_CC: typeof import('../../src/lib/council/contracts').SCHEMA_VERSIONS;
let fixtures: typeof import('../../src/lib/council/contracts/fixtures/examples');
let closeDb: () => void;
let delivery: CouncilEventDelivery;
let eventsModule: typeof import('../../src/lib/council/events');
let storeAdapter: import('../../src/lib/council/persistence/council-store').CouncilStore;

const now = '2026-10-14T12:00:00.000Z';
let idCounter = 0;
const newId = () => `cc030-id-${(idCounter += 1).toString().padStart(4, '0')}`;

const SCOPE_A = {
  tenant_id: 'tenant-a',
  company_id: 'company-a',
  installation_id: 'inst-a',
  owner_subject: null as string | null,
};

function makeStored(
  sessionId: string,
  opts: {
    scope?: typeof SCOPE_A;
    visibility?: 'private' | 'company';
    owner?: string | null;
  } = {},
): CouncilStoredSession {
  const spec = JSON.parse(JSON.stringify(fixtures.validSessionSpec));
  const brief = JSON.parse(JSON.stringify(fixtures.validBrief));
  spec.session_id = sessionId;
  brief.session_id = sessionId;
  spec.visibility = opts.visibility ?? 'company';
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
    scope: { ...(opts.scope ?? SCOPE_A), owner_subject: opts.owner ?? null },
    state,
    sample: false,
  };
}

function envFor(
  stored: CouncilStoredSession,
  subject: string,
  actor: CouncilEnvelope['actor'] = 'owner',
  purpose: CouncilEnvelope['purpose'] = 'read',
): CouncilEnvelope {
  return envelopeFromScopeFn(stored.scope, subject, actor, purpose);
}

function accessFor(
  stored: CouncilStoredSession,
  accessVia: CouncilEventAccess['accessVia'],
  envelope: CouncilEnvelope,
): CouncilEventAccess {
  return {
    envelope,
    accessVia,
    session: {
      id: stored.spec.session_id,
      tenant_id: stored.scope.tenant_id,
      company_id: stored.scope.company_id,
      installation_id: stored.scope.installation_id,
      owner_subject: stored.scope.owner_subject,
      visibility: stored.spec.visibility,
      state: stored.state.state,
      state_version: stored.state.state_version,
    },
  };
}

function advisorCard(
  session: CouncilStoredSession,
  operationId: string,
  seatId = 'simon-sinek',
): CouncilCard {
  const brief = session.brief;
  return {
    schema_version: 'wise-elders.card/v1',
    session_id: session.spec.session_id,
    brief_revision: brief.revision,
    seat_id: seatId,
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

const FENCE = { expected_state_version: 0, cancel_generation: 0, lease_epoch: 0 };

/** Create a session with one card and one verdict committed (3 events). */
function richSession(sessionId: string, opts: Parameters<typeof makeStored>[1] = {}) {
  const stored = makeStored(sessionId, opts);
  const write = envFor(stored, stored.scope.owner_subject ?? 'owner-1', 'owner', 'write');
  repositories.createSession(write, stored);
  const card = repositories.acceptCard(write, advisorCard(stored, `op-${sessionId}`), FENCE);
  assert.equal(card.outcome, 'committed');
  const verdict = repositories.saveVerdict(write, scoredVerdict(stored));
  assert.equal(verdict.outcome, 'committed');
  return stored;
}

before(async () => {
  const storeModule = await import('../../src/lib/council/store');
  const adapterModule = await import('../../src/lib/council/persistence/council-store');
  const contractsModule = await import('../../src/lib/council/contracts');
  const dbModule = await import('../../src/lib/db');
  fixtures = await import('../../src/lib/council/contracts/fixtures/examples');
  eventsModule = await import('../../src/lib/council/events');
  CouncilRepositoriesClass = storeModule.CouncilRepositories;
  envelopeFromScopeFn = storeModule.envelopeFromScope;
  canonicalHashFn = contractsModule.canonicalHash;
  canonicalStringifyFn = contractsModule.canonicalStringify;
  SCHEMA_VERSIONS_CC = contractsModule.SCHEMA_VERSIONS;
  closeDb = dbModule.closeDb;
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  storeAdapter = adapterModule.openCouncilStore();
  repositories = new CouncilRepositoriesClass({
    adapter: storeAdapter,
    diagnosticsDir: mkdtempSync(join(tmpdir(), 'cwe030-diag-')),
    now: () => now,
    newId,
  });
  delivery = new eventsModule.CouncilEventDelivery({
    repositories,
    store: storeAdapter,
  });
});

after(() => {
  closeDb();
});

// ------------------------------------------------------------ delivery

test('delivery: the owner page is gapless, fully scoped, and timestamped from the journal (T070)', () => {
  const stored = richSession('sess-ev-1');
  const access = accessFor(stored, 'owner', envFor(stored, 'owner-1'));
  const result = delivery.page(access, 0);
  assert.equal(result.kind, 'events');
  if (result.kind !== 'events') return;
  assert.deepEqual(result.events.map((e) => e.sequence), [1, 2, 3]);
  assert.deepEqual(
    result.events.map((e) => e.type),
    ['session_created', 'card_accepted', 'verdict_validated'],
  );
  assert.equal(result.last_sequence, 3);
  assert.equal(result.has_more, false);
  const journal = repositories.listEvents(envFor(stored, 'owner-1'), 'sess-ev-1');
  for (const [index, event] of result.events.entries()) {
    // T070: the wire timestamp IS the journal's committed timestamp,
    // never a fabricated progress value.
    assert.equal(event.occurred_at, journal[index].created_at);
    assert.equal(event.event_id, journal[index].event_id);
    assert.equal(event.scope.tenant_id, 'tenant-a');
    assert.equal(event.scope.company_id, 'company-a');
    assert.equal(event.scope.installation_id, 'inst-a');
    assert.equal(event.scope.session_id, 'sess-ev-1');
    assert.equal(event.scope.visibility, 'company');
    assert.equal(event.origin, 'journal');
  }
  // A mid-journal cursor returns exactly the missed tail.
  const tail = delivery.page(access, 1);
  assert.equal(tail.kind, 'events');
  if (tail.kind === 'events') {
    assert.deepEqual(tail.events.map((e) => e.sequence), [2, 3]);
  }
});

test('delivery: private content reaches the owner only; support and company readers get at most the signal (T080)', () => {
  const stored = richSession('sess-ev-2', { visibility: 'private', owner: 'owner-1' });

  const ownerAccess = accessFor(stored, 'owner', envFor(stored, 'owner-1'));
  const ownerPage = delivery.page(ownerAccess, 0);
  assert.equal(ownerPage.kind, 'events');
  if (ownerPage.kind === 'events') assert.equal(ownerPage.events.length, 3);

  // The audited support read (foundation seam: envelope carries the
  // owner subject with actor 'system') gets the signal, never rows.
  const supportAccess = accessFor(
    stored,
    'support',
    envFor(stored, 'owner-1', 'system'),
  );
  const supportPage = delivery.page(supportAccess, 0);
  assert.equal(supportPage.kind, 'invalidation');
  if (supportPage.kind === 'invalidation') {
    assert.equal(supportPage.signal.kind, 'council.session.invalidated');
    assert.equal(supportPage.signal.session_id, 'sess-ev-2');
    assert.equal(supportPage.signal.last_sequence, 3);
    const serialized = JSON.stringify(supportPage.signal);
    assert.ok(!serialized.includes('payload'), 'signal carries no payload');
    assert.ok(!serialized.includes('card_accepted'), 'signal carries no event types');
    assert.ok(!serialized.includes('verdict_validated'), 'signal carries no event types');
    assert.ok(!serialized.includes('actor_subject'), 'signal carries no actors');
  }
  const supportCatchUp = delivery.catchUp(supportAccess, 0);
  assert.equal(supportCatchUp.kind, 'invalidation');

  // A same-company non-owner never gets private content on this
  // surface either (CWE-007 denies the read outright at the route;
  // the service independently refuses content for via != owner).
  const companyAccess = accessFor(stored, 'company', envFor(stored, 'owner-2'));
  assert.equal(delivery.page(companyAccess, 0).kind, 'invalidation');
});

test('delivery: foreign scopes read nothing at all (empty, not redacted)', () => {
  const stored = richSession('sess-ev-3');
  const foreignTenant = envelopeFromScopeFn(
    { tenant_id: 'tenant-b', company_id: 'company-b', installation_id: 'inst-b', owner_subject: null },
    'owner-9',
    'owner',
    'read',
  );
  const foreignAccess = accessFor(stored, 'owner', foreignTenant);
  const page = delivery.page(foreignAccess, 0);
  assert.equal(page.kind, 'events');
  if (page.kind === 'events') {
    assert.equal(page.events.length, 0, 'no redacted rows, no signal: nothing');
    assert.equal(page.last_sequence, 0);
  }
  const foreignCompany = envelopeFromScopeFn(
    { tenant_id: 'tenant-a', company_id: 'company-other', installation_id: 'inst-a', owner_subject: null },
    'owner-9',
    'owner',
    'read',
  );
  const list = delivery.listProjection({ envelope: foreignCompany });
  assert.ok(!list.some((entry) => entry.session_id === 'sess-ev-3'));
});

test('delivery: catch-up is exact from a usable cursor and resyncs by snapshot from an unusable one', () => {
  const stored = richSession('sess-ev-4');
  const access = accessFor(stored, 'owner', envFor(stored, 'owner-1'));

  const exact = delivery.catchUp(access, 2);
  assert.equal(exact.kind, 'page');
  if (exact.kind === 'page') {
    assert.deepEqual(exact.page.events.map((e) => e.sequence), [3]);
  }

  const ahead = delivery.catchUp(access, 999);
  assert.equal(ahead.kind, 'snapshot');
  if (ahead.kind === 'snapshot') {
    assert.equal(ahead.snapshot.last_sequence, 3);
    assert.equal(ahead.snapshot.projection.activity.completed_cards, 1);
    assert.equal(ahead.snapshot.projection.verdict?.verdict_revision, 1);
  }

  const negative = delivery.catchUp(access, -5);
  assert.equal(negative.kind, 'snapshot', 'never a silently partial history');
});

test('delivery: the session list projection is journal-folded and visibility filtered', () => {
  const shared = richSession('sess-ev-5a');
  const mine = richSession('sess-ev-5b', { visibility: 'private', owner: 'owner-1' });

  const aliceList = delivery.listProjection({ envelope: envFor(shared, 'owner-1') });
  const aliceIds = aliceList.map((entry) => entry.session_id);
  assert.ok(aliceIds.includes('sess-ev-5a'));
  assert.ok(aliceIds.includes('sess-ev-5b'), 'the owner sees her private session');

  const bobList = delivery.listProjection({ envelope: envFor(shared, 'owner-2') });
  const bobIds = bobList.map((entry) => entry.session_id);
  assert.ok(bobIds.includes('sess-ev-5a'), 'company session visible to company members');
  assert.ok(!bobIds.includes('sess-ev-5b'), 'private session hidden from other members');

  const entry = aliceList.find((e) => e.session_id === 'sess-ev-5a');
  assert.equal(entry?.last_event_sequence, 3);
  assert.equal(entry?.state, 'DRAFT');
  assert.equal(mine.spec.session_id, 'sess-ev-5b');
});

// ---------------------------------------------------------- projection

test('projection: rebuilding from the journal alone matches the live fold byte for byte', () => {
  const stored = richSession('sess-ev-6');
  const envelope = envFor(stored, 'owner-1');
  const journal = repositories.listEvents(envelope, 'sess-ev-6');
  const scope = {
    tenant_id: 'tenant-a',
    company_id: 'company-a',
    installation_id: 'inst-a',
    session_id: 'sess-ev-6',
    visibility: 'company' as const,
    owner_subject: null,
  };
  const live = eventsModule.projectSession(scope, journal);
  // Simulate a restart: a fresh fold from a fresh journal read.
  const rebuilt = eventsModule.projectSession(
    scope,
    repositories.listEvents(envelope, 'sess-ev-6'),
  );
  assert.equal(canonicalStringifyFn(live), canonicalStringifyFn(rebuilt));

  // Out-of-order arrival plus exact duplicates fold identically:
  // the fold is sequence-driven, not arrival-driven.
  const shuffled = [journal[2], journal[0], journal[1], journal[1], journal[2]];
  const folded = eventsModule.projectSession(scope, shuffled);
  assert.equal(canonicalStringifyFn(folded), canonicalStringifyFn(live));
});

test('projection: seat activity is honest: QUEUED until a committed card, never "thinking" (Section 18.4)', () => {
  const stored = makeStored('sess-ev-7');
  const write = envFor(stored, 'owner-1', 'owner', 'write');
  repositories.createSession(write, stored);
  const scope = {
    tenant_id: 'tenant-a',
    company_id: 'company-a',
    installation_id: 'inst-a',
    session_id: 'sess-ev-7',
    visibility: 'company' as const,
    owner_subject: null,
  };
  const fresh = eventsModule.projectSession(
    scope,
    repositories.listEvents(envFor(stored, 'owner-1'), 'sess-ev-7'),
  );
  assert.ok(fresh);
  assert.equal(fresh.activity.completed_cards, 0);
  assert.ok(fresh.seats.every((seat) => seat.status === 'queued'));
  assert.ok(!JSON.stringify(fresh).includes('thinking'), 'no fabricated thinking state');

  repositories.acceptCard(write, advisorCard(stored, 'op-ev-7', 'brene-brown'), FENCE);
  const after = eventsModule.projectSession(
    scope,
    repositories.listEvents(envFor(stored, 'owner-1'), 'sess-ev-7'),
  );
  assert.ok(after);
  assert.equal(after.activity.completed_cards, 1);
  const brene = after.seats.find((seat) => seat.seat_id === 'brene-brown');
  assert.equal(brene?.status, 'completed');
  assert.equal(brene?.last_card?.round, 1);
  assert.ok(
    after.seats.filter((seat) => seat.seat_id !== 'brene-brown').every((s) => s.status === 'queued'),
    'uncommitted seats stay queued, not thinking',
  );
});

// ------------------------------------------------------------- reducer

test('reducer: duplicates drop by ID and sequence, stale events never revert, gaps demand resync', () => {
  const stored = richSession('sess-ev-8');
  const access = accessFor(stored, 'owner', envFor(stored, 'owner-1'));
  const page = delivery.page(access, 0);
  assert.equal(page.kind, 'events');
  if (page.kind !== 'events') return;
  const [created, card, verdict] = page.events;

  const reducer = new eventsModule.CouncilClientReducer('sess-ev-8');
  assert.equal(reducer.applyEvent(card), 'gap', 'a card before creation is a gap, not a guess');
  assert.equal(reducer.needsResync, true);

  reducer.applySnapshot({
    kind: 'snapshot',
    session_id: 'sess-ev-8',
    projection: eventsModule.projectSession(created.scope, [
      ...repositories.listEvents(envFor(stored, 'owner-1'), 'sess-ev-8'),
    ])!,
    last_sequence: 3,
  });
  assert.equal(reducer.cursor, 3);
  assert.equal(reducer.needsResync, false);
  assert.equal(reducer.currentProjection?.activity.completed_cards, 1);

  // Replayed history after a snapshot resync is at or below the
  // cursor, so the sequence gate drops it as stale: the snapshot is
  // the authority and nothing double-counts (T102's guard). Event
  // IDs the reducer has never applied cannot resurrect old state
  // either, even under a forged ID.
  assert.equal(reducer.applyEvent(created), 'stale');
  assert.equal(reducer.applyEvent(card), 'stale');
  assert.equal(reducer.applyEvent(verdict), 'stale');
  const forgedStale: CouncilWireEvent = { ...verdict, event_id: 'forged-id', sequence: 2 };
  assert.equal(reducer.applyEvent(forgedStale), 'stale');
  assert.equal(reducer.currentProjection?.activity.completed_cards, 1);
  assert.equal(reducer.currentProjection?.verdict?.verdict_revision, 1);

  // New commits after the resync apply once, then dedup by ID.
  const write = envFor(stored, 'owner-1', 'owner', 'write');
  repositories.acceptCard(write, advisorCard(stored, 'op-ev-8b', 'brene-brown'), FENCE);
  const tail = delivery.page(access, reducer.cursor);
  assert.equal(tail.kind, 'events');
  if (tail.kind === 'events') {
    assert.equal(tail.events.length, 1);
    assert.equal(reducer.applyEvent(tail.events[0]), 'applied');
    assert.equal(reducer.applyEvent(tail.events[0]), 'duplicate');
  }
  assert.equal(reducer.currentProjection?.activity.completed_cards, 2);
});

test('reducer + delivery: disconnect and reconnect catches up with no double votes or false completion (T102)', () => {
  const stored = makeStored('sess-ev-9');
  const write = envFor(stored, 'owner-1', 'owner', 'write');
  repositories.createSession(write, stored);
  const access = accessFor(stored, 'owner', envFor(stored, 'owner-1'));
  const reducer = new eventsModule.CouncilClientReducer('sess-ev-9');

  const first = delivery.page(access, 0);
  assert.equal(first.kind, 'events');
  if (first.kind === 'events') {
    assert.deepEqual(reducer.applyPage(first.events), ['applied']);
  }
  assert.equal(reducer.cursor, 1);

  // Work commits while the client is disconnected.
  repositories.acceptCard(write, advisorCard(stored, 'op-ev-9a', 'simon-sinek'), FENCE);
  repositories.acceptCard(write, advisorCard(stored, 'op-ev-9b', 'brene-brown'), FENCE);
  repositories.saveVerdict(write, scoredVerdict(stored));

  // Reconnect with the persisted cursor: exact gapless catch-up.
  const catchUp = delivery.catchUp(access, reducer.cursor);
  assert.equal(catchUp.kind, 'page');
  if (catchUp.kind !== 'page') return;
  assert.deepEqual(catchUp.page.events.map((e) => e.sequence), [2, 3, 4]);
  assert.deepEqual(reducer.applyPage(catchUp.page.events), ['applied', 'applied', 'applied']);
  assert.equal(reducer.cursor, 4);

  // A transport duplicate of the same catch-up changes nothing.
  assert.deepEqual(
    reducer.applyPage(catchUp.page.events),
    ['duplicate', 'duplicate', 'duplicate'],
  );
  const projection = reducer.currentProjection;
  assert.ok(projection);
  assert.equal(projection.activity.completed_cards, 2, 'cards counted once each');
  assert.equal(projection.verdict?.verdict_revision, 1);
  assert.equal(
    projection.state,
    'DRAFT',
    'no falsely completed session: the journal never moved the state',
  );
});

// -------------------------------------------------------------- fanout

test('fanout: the registry never crosses scope and private content is owner-only', () => {
  const stored = richSession('sess-ev-10', { visibility: 'private', owner: 'owner-1' });
  const access = accessFor(stored, 'owner', envFor(stored, 'owner-1'));
  const page = delivery.page(access, 0);
  assert.equal(page.kind, 'events');
  if (page.kind !== 'events') return;
  const event = page.events[1]; // card_accepted on a private session
  assert.equal(event.type, 'card_accepted');

  const registry = new eventsModule.CouncilEventSubscriptions();
  const received = { owner: [] as unknown[], bob: [] as unknown[], foreign: [] as unknown[], support: [] as unknown[] };
  registry.subscribe({
    scope: event.scope,
    contentAccess: true,
    send: (m) => received.owner.push(m),
  });
  registry.subscribe({
    // Same session, but the subscription's owner dimension is a
    // different subject: content must NOT flow, signal only.
    scope: { ...event.scope, owner_subject: 'owner-2' },
    contentAccess: true,
    send: (m) => received.bob.push(m),
  });
  registry.subscribe({
    scope: { ...event.scope, tenant_id: 'tenant-b', company_id: 'company-b' },
    contentAccess: true,
    send: (m) => received.foreign.push(m),
  });
  registry.subscribe({
    scope: event.scope,
    contentAccess: false,
    send: (m) => received.support.push(m),
  });

  const deliveries = registry.publish(event);
  assert.equal(received.owner.length, 1, 'the owner receives the event');
  assert.equal(received.foreign.length, 0, 'a foreign scope receives nothing at all');
  assert.equal(received.bob.length, 1, 'a non-owner receives only the signal');
  assert.equal((received.bob[0] as { kind: string }).kind, 'council.session.invalidated');
  assert.ok(!JSON.stringify(received.bob[0]).includes('card_accepted'));
  assert.equal(received.support.length, 1);
  assert.equal((received.support[0] as { kind: string }).kind, 'council.session.invalidated');
  assert.ok(deliveries >= 3);

  // A duplicate publish of the same committed event delivers once.
  registry.publish(event);
  assert.equal(received.owner.length, 1, 'transport duplicates are suppressed per subscription');
});

test('fanout pump: outbox replay after a restart delivers each semantic event once despite duplicates (T057)', () => {
  const pumpScope = {
    tenant_id: 'tenant-a',
    company_id: 'company-pump',
    installation_id: 'inst-a',
    owner_subject: null as string | null,
  };
  const stored = makeStored('sess-ev-11', { scope: pumpScope });
  const write = envFor(stored, 'owner-1', 'owner', 'write');
  repositories.createSession(write, stored);
  repositories.acceptCard(write, advisorCard(stored, 'op-ev-11'), FENCE);
  repositories.saveVerdict(write, scoredVerdict(stored));

  // "Restart": brand-new registry and pump-side state over the same
  // durable store. Nothing was delivered before the restart.
  const registry = new eventsModule.CouncilEventSubscriptions();
  const delivered: CouncilWireEvent[] = [];
  const journal = repositories.listEvents(envFor(stored, 'owner-1'), 'sess-ev-11');
  const scope = {
    tenant_id: 'tenant-a',
    company_id: 'company-pump',
    installation_id: 'inst-a',
    session_id: 'sess-ev-11',
    visibility: 'company' as const,
    owner_subject: null,
  };
  assert.equal(journal.length, 3);
  registry.subscribe({
    scope,
    contentAccess: true,
    send: (m) => {
      if ('event_id' in m) delivered.push(m);
    },
  });
  const pumpEnvelope = envelopeFromScopeFn(pumpScope, 'council-events-pump', 'system', 'admin');
  const first = eventsModule.drainCouncilEventOutbox(
    { repositories, store: storeAdapter, subscriptions: registry },
    pumpEnvelope,
  );
  assert.equal(first.claimed, 2, 'one intent per card and verdict');
  assert.equal(first.marked_delivered, 2);
  assert.equal(first.marked_failed, 0);
  assert.deepEqual(delivered.map((e) => e.type), ['card_accepted', 'verdict_validated']);

  // Feed the deliveries into a fresh reducer TWICE (transport
  // duplication): the semantic events land exactly once (T057).
  const reducer = new eventsModule.CouncilClientReducer('sess-ev-11');
  const created = delivery.page(
    accessFor(stored, 'owner', envFor(stored, 'owner-1')),
    0,
  );
  assert.equal(created.kind, 'events');
  if (created.kind === 'events') {
    assert.equal(reducer.applyEvent(created.events[0]).valueOf(), 'applied');
  }
  for (const event of [...delivered, ...delivered]) reducer.applyEvent(event);
  assert.equal(reducer.cursor, 3);
  assert.equal(reducer.currentProjection?.activity.completed_cards, 1);
  assert.equal(reducer.currentProjection?.verdict?.verdict_revision, 1);

  // A second drain finds nothing due: intents stay delivered.
  const second = eventsModule.drainCouncilEventOutbox(
    { repositories, store: storeAdapter, subscriptions: registry },
    pumpEnvelope,
  );
  assert.equal(second.claimed, 0);
});

// -------------------------------------------------- invalidation keys

test('cache invalidation keys are scope-qualified and disjoint across scopes', () => {
  const scopeA = {
    tenant_id: 'tenant-a',
    company_id: 'company-a',
    installation_id: 'inst-a',
    session_id: 'sess-ev-1',
    visibility: 'company' as const,
    owner_subject: null,
  };
  const scopeB = { ...scopeA, company_id: 'company-b', session_id: 'sess-ev-other' };
  const keysA = eventsModule.invalidationKeysForEvent(scopeA);
  const keysB = eventsModule.invalidationKeysForEvent(scopeB);
  assert.equal(keysA.length, 3);
  for (const key of keysA) {
    assert.ok(key.includes('tenant-a') && key.includes('company-a'), key);
    assert.ok(!keysB.includes(key), `key ${key} must not collide across scopes`);
  }
  const otherSession = eventsModule.invalidationKeysForEvent({ ...scopeA, session_id: 'sess-ev-2' });
  assert.ok(
    !otherSession.includes(keysA[0]) && !otherSession.includes(keysA[1]),
    'session and room keys are per-session',
  );
  assert.equal(otherSession[2], keysA[2], 'the list key is shared only within the same company scope');
});

// --------------------------------------------------------------- stream

class FrameCollector {
  text = '';
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private decoder = new TextDecoder();

  async start(stream: ReadableStream<Uint8Array>): Promise<void> {
    this.reader = stream.getReader();
    void (async () => {
      try {
        for (;;) {
          const { done, value } = await this.reader!.read();
          if (done) break;
          this.text += this.decoder.decode(value, { stream: true });
        }
      } catch {
        // Cancelled.
      }
    })();
  }

  async waitFor(predicate: (text: string) => boolean, timeoutMs = 3000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (predicate(this.text)) return true;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return predicate(this.text);
  }

  async stop(): Promise<void> {
    try {
      await this.reader?.cancel();
    } catch {
      // Already closed.
    }
  }
}

test('stream: a late subscriber receives nothing predating its cursor, then only new commits', async () => {
  const stored = richSession('sess-ev-12');
  const access = accessFor(stored, 'owner', envFor(stored, 'owner-1'));
  // The late subscriber connects at the current head (sequence 3):
  // history before its authorization point is never pushed.
  const stream = eventsModule.createCouncilEventStream(
    { delivery, access, afterSequence: 3 },
    { pollMs: 40, heartbeatMs: 60_000 },
  );
  const collector = new FrameCollector();
  await collector.start(stream);
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.ok(collector.text.includes('council-events connected'));
  assert.ok(!collector.text.includes('session_created'), 'no pre-cursor history is pushed');
  assert.ok(!collector.text.includes('card_accepted'), 'no pre-cursor history is pushed');

  const write = envFor(stored, 'owner-1', 'owner', 'write');
  repositories.acceptCard(write, advisorCard(stored, 'op-ev-12', 'brene-brown'), FENCE);
  const sawNew = await collector.waitFor((text) => text.includes('card_accepted'));
  assert.ok(sawNew, `expected the new commit to stream; got: ${collector.text}`);
  assert.ok(collector.text.includes('id: 4'));
  await collector.stop();
});

test('stream: the opening catch-up replays the committed journal in order', async () => {
  const stored = richSession('sess-ev-13');
  const access = accessFor(stored, 'owner', envFor(stored, 'owner-1'));
  const stream = eventsModule.createCouncilEventStream(
    { delivery, access, afterSequence: 0 },
    { pollMs: 40, heartbeatMs: 60_000 },
  );
  const collector = new FrameCollector();
  await collector.start(stream);
  const complete = await collector.waitFor(
    (text) =>
      text.includes('event: session_created') &&
      text.includes('event: card_accepted') &&
      text.includes('event: verdict_validated'),
  );
  assert.ok(complete, `expected a full catch-up; got: ${collector.text}`);
  const order = ['session_created', 'card_accepted', 'verdict_validated'].map((type) =>
    collector.text.indexOf(`event: ${type}`),
  );
  assert.ok(order[0] < order[1] && order[1] < order[2], 'frames arrive in sequence order');
  await collector.stop();
});

// ------------------------------------------------------------ route layer
//
// The events route with real signed grants (the CWE-029 fixture
// pattern): authorization is decided by CWE-007 before any event is
// read, and the B07 properties hold at the HTTP surface.

const ROUTE_ENV_KEYS = [
  'MC_TENANT_REGISTRY_JSON',
  'MC_TENANT_SESSION_SECRET',
  'MC_INTERVIEW_COOKIE_SECRET',
  'MC_API_TOKEN',
  'MC_CSRF_COOKIE_SECRET',
  'MC_COUNCIL_SUPPORT_SUBJECTS',
] as const;
const savedRouteEnv: Record<string, string | undefined> = {};
for (const key of ROUTE_ENV_KEYS) savedRouteEnv[key] = process.env[key];

const ROUTE_HOSTS = {
  'council-a.test': { tenantId: 'tenant-a', companyId: 'company-a', installationId: 'install-a' },
  'council-a2.test': { tenantId: 'tenant-a', companyId: 'company-a2', installationId: 'install-a' },
  'council-b.test': { tenantId: 'tenant-b', companyId: 'company-b', installationId: 'install-b' },
} as const;
type RouteHost = keyof typeof ROUTE_HOSTS;

function installRouteEnv(): void {
  process.env.MC_TENANT_REGISTRY_JSON = JSON.stringify({
    'council-a.test': { tenantId: 'tenant-a', companyId: 'company-a', kind: 'self', installationId: 'install-a' },
    'council-a2.test': { tenantId: 'tenant-a', companyId: 'company-a2', kind: 'self', installationId: 'install-a' },
    'council-b.test': { tenantId: 'tenant-b', companyId: 'company-b', kind: 'self', installationId: 'install-b' },
  });
  process.env.MC_TENANT_SESSION_SECRET = 'cwe030-fixture-session-secret';
  process.env.MC_API_TOKEN = 'cwe030-fixture-operator-token';
  process.env.MC_CSRF_COOKIE_SECRET = 'cwe030-fixture-csrf-secret';
  delete process.env.MC_INTERVIEW_COOKIE_SECRET;
  process.env.MC_COUNCIL_SUPPORT_SUBJECTS = 'support:root';
}

after(() => {
  for (const key of ROUTE_ENV_KEYS) {
    if (savedRouteEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedRouteEnv[key];
  }
});

let sessionsRoute: { POST: (request: NextRequest) => Promise<Response> };
let eventsRoute: {
  GET: (request: NextRequest, ctx?: unknown) => Promise<Response>;
};

before(async () => {
  sessionsRoute = await import('../../src/app/api/council/sessions/route');
  eventsRoute = await import('../../src/app/api/council/sessions/[id]/events/route');
});

async function routeRequest(
  host: RouteHost,
  subject: string | null,
  path: string,
  options: { method?: string; body?: unknown; csrf?: boolean; idempotencyKey?: string } = {},
): Promise<NextRequest> {
  const headers: Record<string, string> = { host };
  const cookies: string[] = [];
  if (subject !== null) {
    const reg = ROUTE_HOSTS[host];
    const token = await signTenantGrant({
      purpose: 'session',
      tenantId: reg.tenantId,
      companyId: reg.companyId,
      subject,
      host,
      installationId: reg.installationId,
      exp: Math.floor(Date.now() / 1000) + 3600,
      nonce: `cwe030-${subject}-${Math.random()}`,
    });
    cookies.push(`mc_tenant_session=${token}`);
  }
  if (options.csrf) {
    const { value } = await signCsrfToken();
    cookies.push(`mc_csrf_token=${value}`);
  }
  if (cookies.length > 0) headers.cookie = cookies.join('; ');
  if (options.idempotencyKey) headers['idempotency-key'] = options.idempotencyKey;
  return new NextRequest(`https://${host}${path}`, {
    method: options.method ?? 'GET',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
}

function routeDraftBody(visibility: 'private' | 'company'): Record<string, unknown> {
  return {
    mode: 'selected',
    visibility,
    seat_ids: ['simon-sinek', 'brene-brown'],
    source_pack_version: 'pack-fixture-1.0.0',
    model_policy: {
      selection: 'explicit',
      route_id: 'route-fixture-1',
      requested_model_id: 'model-selected-by-client',
      reasoning_preference: null,
      fallback_policy: 'none',
    },
    brief: {
      question: 'Should we pilot the revised offer before a broad launch?',
      options: [
        { id: 'A', label: 'Keep the current offer', kind: 'status_quo' },
        { id: 'B', label: 'Pilot the revised offer', kind: 'bounded_test' },
      ],
      facts: [],
      assumptions: [],
      unknowns: [],
      constraints: [],
      relevance_weights: { 'simon-sinek': 2, 'brene-brown': 3 },
      critical_domains: [],
      evidence_manifest: [],
      private_preference_ref: null,
      display_timezone: 'America/New_York',
    },
  };
}

async function createRouteDraft(visibility: 'private' | 'company'): Promise<string> {
  installRouteEnv();
  const response = await sessionsRoute.POST(
    await routeRequest('council-a.test', 'owner:alice', '/api/council/sessions', {
      method: 'POST',
      csrf: true,
      idempotencyKey: `cwe030-create-${Math.random()}`,
      body: routeDraftBody(visibility),
    }),
  );
  const body = await response.json();
  assert.equal(response.status, 201, JSON.stringify(body));
  return body.data.spec.session_id as string;
}

async function getEvents(
  id: string,
  subject: string | null = 'owner:alice',
  host: RouteHost = 'council-a.test',
  suffix = '',
): Promise<{ status: number; body: any }> {
  installRouteEnv();
  const response = await eventsRoute.GET(
    await routeRequest(host, subject, `/api/council/sessions/${id}/events${suffix}`),
    { params: Promise.resolve({ id }) },
  );
  return { status: response.status, body: await response.json() };
}

test('route: the owner reads the committed journal through the events endpoint, fully scoped', async () => {
  const id = await createRouteDraft('private');
  const { status, body } = await getEvents(id);
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.meta.access_via, 'owner');
  assert.equal(body.data.kind, 'page');
  assert.equal(body.data.page.events.length, 1);
  const event = body.data.page.events[0];
  assert.equal(event.type, 'session_created');
  assert.equal(event.sequence, 1);
  assert.equal(event.scope.tenant_id, 'tenant-a');
  assert.equal(event.scope.company_id, 'company-a');
  assert.equal(event.scope.installation_id, 'install-a');
  assert.equal(event.scope.session_id, id);
  assert.equal(event.scope.visibility, 'private');
  assert.equal(event.scope.owner_subject, 'owner:alice');
  assert.equal(event.origin, 'journal');

  const snapshot = await getEvents(id, 'owner:alice', 'council-a.test', '?snapshot=1');
  assert.equal(snapshot.status, 200);
  assert.equal(snapshot.body.data.kind, 'snapshot');
  assert.equal(snapshot.body.data.projection.session_id, id);
  assert.equal(snapshot.body.data.projection.activity.completed_cards, 0);
  assert.ok(
    snapshot.body.data.projection.seats.every(
      (seat: { status: string }) => seat.status === 'queued',
    ),
  );
});

test('route: private events deny the non-owner, signal-only for support, not-found across scopes (T080, Section 28.2)', async () => {
  const id = await createRouteDraft('private');

  const bob = await getEvents(id, 'owner:bob');
  assert.equal(bob.status, 403, JSON.stringify(bob.body));
  assert.equal(bob.body.error.code, 'COUNCIL_PRIVATE_OWNER_REQUIRED');

  const support = await getEvents(id, 'support:root');
  assert.equal(support.status, 200, JSON.stringify(support.body));
  assert.equal(support.body.meta.access_via, 'support');
  assert.equal(support.body.data.kind, 'invalidation');
  assert.equal(support.body.data.signal.kind, 'council.session.invalidated');
  const serialized = JSON.stringify(support.body);
  assert.ok(!serialized.includes('session_created'), 'no event content reaches support');
  assert.ok(!serialized.includes('payload'), 'no payload reaches support');

  // Cross-tenant and cross-company readers, and guessed IDs, get
  // the typed not-found: nothing about the session leaks.
  const crossTenant = await getEvents(id, 'owner:alice', 'council-b.test');
  assert.equal(crossTenant.status, 404);
  assert.equal(crossTenant.body.error.code, 'PERSISTENCE_SESSION_NOT_FOUND');
  const crossCompany = await getEvents(id, 'owner:alice', 'council-a2.test');
  assert.equal(crossCompany.status, 404);
  assert.equal(crossCompany.body.error.code, 'PERSISTENCE_SESSION_NOT_FOUND');
  const guessed = await getEvents('00000000-0000-4000-8000-000000000000');
  assert.equal(guessed.status, 404);
  assert.equal(guessed.body.error.code, 'PERSISTENCE_SESSION_NOT_FOUND');

  const unauthenticated = await getEvents(id, null);
  assert.equal(unauthenticated.status, 403);
});

test('route: a malformed cursor is a typed validation error, never a silent replay', async () => {
  const id = await createRouteDraft('company');
  const bad = await getEvents(id, 'owner:alice', 'council-a.test', '?after=abc');
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error.code, 'SCHEMA_VALIDATION');
  const negative = await getEvents(id, 'owner:alice', 'council-a.test', '?after=-1');
  assert.equal(negative.status, 400);
  // A cursor ahead of the journal resyncs by snapshot instead.
  const ahead = await getEvents(id, 'owner:alice', 'council-a.test', '?after=999');
  assert.equal(ahead.status, 200);
  assert.equal(ahead.body.data.kind, 'snapshot');
});

test('route: stream mode opens with the committed catch-up for the owner', async () => {
  const id = await createRouteDraft('company');
  installRouteEnv();
  const response = await eventsRoute.GET(
    await routeRequest('council-a.test', 'owner:alice', `/api/council/sessions/${id}/events?stream=1`),
    { params: Promise.resolve({ id }) },
  );
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/);
  assert.ok(response.body);
  const collector = new FrameCollector();
  await collector.start(response.body!);
  const saw = await collector.waitFor((text) => text.includes('event: session_created'));
  assert.ok(saw, `expected the catch-up frame; got: ${collector.text}`);
  assert.ok(collector.text.includes(`"session_id":"${id}"`));
  await collector.stop();
});
