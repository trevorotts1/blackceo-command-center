/**
 * council-gauntlet-resync501.test.ts — CWE-044 gauntlet: the
 * 501-event resync branch, carried UNVERIFIED since CWE-030.
 *
 * Delivery rule (src/lib/council/events/delivery.ts, Section 18.3):
 * catch-up returns an exact gapless page when the cursor is within
 * RESYNC_PAGE_CAP (500) events of the journal head, and a full
 * snapshot when it is farther behind. CWE-030's suite exercised
 * pages, gaps, duplicates, and snapshots from invalid cursors, but
 * never a journal longer than 500 events, so the boundary itself
 * (exactly 500 behind = page; 501 behind = snapshot) was unproven.
 *
 * Fixture construction, disclosed: the session is created through
 * the real repositories (1 journal event). The remaining 501 events
 * are `brief_revised` appends written through the store adapter's
 * own appendEvent with the same canonical hash-chain inputs the
 * production draft path uses (src/lib/council/api/drafts.ts), each
 * bumping brief_revision. No production code path is stubbed: the
 * chain is then verified with repositories.verifyChain, and the
 * fold the snapshot carries is checked against the journal.
 *
 * Run:
 *   node --import tsx --import ./tests/setup/no-owner-telegram.ts \
 *     --test tests/unit/council-gauntlet-resync501.test.ts
 */

import './_isolated-db';
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import type { SessionStateRecord } from '../../src/lib/council/contracts';
import type {
  CouncilEnvelope,
  CouncilStoredSession,
} from '../../src/lib/council/store';
import type { CouncilEventAccess } from '../../src/lib/council/events/delivery';

let repositories: InstanceType<
  typeof import('../../src/lib/council/store').CouncilRepositories
>;
let delivery: InstanceType<
  typeof import('../../src/lib/council/events').CouncilEventDelivery
>;
let storeAdapter: import('../../src/lib/council/persistence/council-store').CouncilStore;
let envelopeFromScopeFn: typeof import('../../src/lib/council/store').envelopeFromScope;
let canonicalHashFn: typeof import('../../src/lib/council/contracts').canonicalHash;
let canonicalStringifyFn: typeof import('../../src/lib/council/contracts').canonicalStringify;
let eventsModule: typeof import('../../src/lib/council/events');
let fixtures: typeof import('../../src/lib/council/contracts/fixtures/examples');
let closeDb: () => void;

const now = '2026-10-14T12:00:00.000Z';
let idCounter = 0;
const newId = () => `cc044-id-${(idCounter += 1).toString().padStart(4, '0')}`;

const SCOPE = {
  tenant_id: 'tenant-gauntlet',
  company_id: 'company-gauntlet',
  installation_id: 'inst-gauntlet',
  owner_subject: null as string | null,
};

const SESSION_ID = 'sess-gauntlet-501';
const TOTAL_EVENTS = 502; // 1 session_created + 501 brief_revised
const FINAL_BRIEF_REVISION = 502;

let storedSession: CouncilStoredSession;

function makeStored(sessionId: string): CouncilStoredSession {
  const spec = JSON.parse(JSON.stringify(fixtures.validSessionSpec));
  const brief = JSON.parse(JSON.stringify(fixtures.validBrief));
  spec.session_id = sessionId;
  brief.session_id = sessionId;
  spec.visibility = 'company';
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
    scope: { ...SCOPE },
    state,
    sample: false,
  };
}

function envFor(stored: CouncilStoredSession, purpose: CouncilEnvelope['purpose']): CouncilEnvelope {
  return envelopeFromScopeFn(stored.scope, 'owner-1', 'owner', purpose);
}

function accessFor(stored: CouncilStoredSession): CouncilEventAccess {
  return {
    envelope: envFor(stored, 'read'),
    accessVia: 'owner',
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

/** Append one brief_revised event through the store adapter with the
 * production hash-chain inputs (drafts.ts pattern). */
function appendBriefRevised(revision: number): void {
  const envelope = envFor(storedSession, 'write');
  const events = repositories.listEvents(envelope, SESSION_ID, 0);
  const last = events[events.length - 1];
  const sequence = last.sequence + 1;
  const payload = {
    brief_revision: revision,
    previous_brief_revision: revision - 1,
    brief_sha256: canonicalHashFn({ gauntlet_revision: revision }),
  };
  const payloadJson = canonicalStringifyFn(payload);
  const eventHash = canonicalHashFn({
    tenant_id: SCOPE.tenant_id,
    company_id: SCOPE.company_id,
    session_id: SESSION_ID,
    sequence,
    type: 'brief_revised',
    payload_json: payloadJson,
    prev_hash: last.event_hash,
    created_at: now,
  });
  const assigned = storeAdapter.appendEvent({
    scope: { tenantId: SCOPE.tenant_id, companyId: SCOPE.company_id },
    sessionId: SESSION_ID,
    id: newId(),
    type: 'brief_revised',
    fromState: null,
    toState: null,
    actorSubject: 'owner-1',
    payloadJson,
    prevHash: last.event_hash,
    eventHash,
    createdAt: now,
  });
  assert.equal(assigned, sequence);
}

before(async () => {
  const storeModule = await import('../../src/lib/council/store');
  const adapterModule = await import('../../src/lib/council/persistence/council-store');
  const contractsModule = await import('../../src/lib/council/contracts');
  const dbModule = await import('../../src/lib/db');
  fixtures = await import('../../src/lib/council/contracts/fixtures/examples');
  eventsModule = await import('../../src/lib/council/events');
  envelopeFromScopeFn = storeModule.envelopeFromScope;
  canonicalHashFn = contractsModule.canonicalHash;
  canonicalStringifyFn = contractsModule.canonicalStringify;
  closeDb = dbModule.closeDb;
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  storeAdapter = adapterModule.openCouncilStore();
  repositories = new storeModule.CouncilRepositories({
    adapter: storeAdapter,
    diagnosticsDir: mkdtempSync(join(tmpdir(), 'cwe044-diag-')),
    now: () => now,
    newId,
  });
  delivery = new eventsModule.CouncilEventDelivery({
    repositories,
    store: storeAdapter,
  });

  storedSession = makeStored(SESSION_ID);
  repositories.createSession(envFor(storedSession, 'write'), storedSession);
  for (let revision = 2; revision <= FINAL_BRIEF_REVISION; revision++) {
    appendBriefRevised(revision);
  }
});

after(() => {
  closeDb();
});

test('the journal holds 502 events and its hash chain verifies end to end', () => {
  const envelope = envFor(storedSession, 'read');
  const events = repositories.listEvents(envelope, SESSION_ID, 0);
  assert.equal(events.length, TOTAL_EVENTS);
  assert.equal(events[events.length - 1].sequence, TOTAL_EVENTS);
  const chain = repositories.verifyChain(envelope, SESSION_ID);
  assert.deepEqual(chain, {
    ok: true,
    checked: TOTAL_EVENTS,
    first_bad_sequence: null,
  });
});

test('exactly 500 behind the head: catch-up returns pages, and draining them is exact and gapless', () => {
  const access = accessFor(storedSession);
  const first = delivery.catchUp(access, 2);
  assert.equal(first.kind, 'page');
  if (first.kind !== 'page') return;
  // Pages come at the delivery default size; the boundary question
  // is the page/snapshot branch, and that the drain is exact.
  assert.equal(first.page.events[0].sequence, 3);
  const seen: number[] = [];
  let cursor = 2;
  for (let hops = 0; hops < 10; hops++) {
    const result = delivery.catchUp(access, cursor);
    assert.equal(result.kind, 'page', 'within the cap every hop stays a page');
    if (result.kind !== 'page') return;
    for (const event of result.page.events) seen.push(event.sequence);
    if (!result.page.has_more) break;
    cursor = result.page.events[result.page.events.length - 1].sequence;
  }
  assert.equal(seen.length, 500);
  assert.equal(seen[0], 3);
  assert.equal(seen[seen.length - 1], TOTAL_EVENTS);
  for (let i = 1; i < seen.length; i++) {
    assert.equal(seen[i], seen[i - 1] + 1, 'gapless drain');
  }
});

test('501 behind the head: catch-up returns a snapshot folded from the full journal', () => {
  const started = performance.now();
  const result = delivery.catchUp(accessFor(storedSession), 1);
  const elapsedMs = performance.now() - started;
  assert.equal(result.kind, 'snapshot');
  if (result.kind !== 'snapshot') return;
  assert.equal(result.snapshot.session_id, SESSION_ID);
  assert.equal(result.snapshot.last_sequence, TOTAL_EVENTS);
  // The fold ran over ALL 502 events: the last brief_revised wins.
  assert.equal(result.snapshot.projection.brief_revision, FINAL_BRIEF_REVISION);
  assert.equal(result.snapshot.projection.state, 'DRAFT');
  assert.ok(
    elapsedMs < 2000,
    `snapshot catch-up for a 501-event gap took ${elapsedMs.toFixed(1)}ms (Section 32.6 catch-up budget 2000ms)`,
  );
});

test('reconnection catch-up for a 200-event gap completes within 2 s (Section 32.6)', () => {
  const access = accessFor(storedSession);
  const started = performance.now();
  let cursor = TOTAL_EVENTS - 200;
  let drained = 0;
  for (let hops = 0; hops < 10; hops++) {
    const result = delivery.catchUp(access, cursor);
    assert.equal(result.kind, 'page');
    if (result.kind !== 'page') return;
    drained += result.page.events.length;
    if (!result.page.has_more) break;
    cursor = result.page.events[result.page.events.length - 1].sequence;
  }
  const elapsedMs = performance.now() - started;
  assert.equal(drained, 200);
  assert.ok(
    elapsedMs < 2000,
    `200-event catch-up took ${elapsedMs.toFixed(1)}ms (budget 2000ms)`,
  );
});

test('the client reducer resyncs from the 501-gap snapshot and clears its resync flag', () => {
  const access = accessFor(storedSession);
  const page = delivery.page(access, 0);
  assert.equal(page.kind, 'events');
  if (page.kind !== 'events') return;
  const reducer = new eventsModule.CouncilClientReducer(SESSION_ID);
  // Jump straight to sequence 5: a gap the reducer must flag.
  const fifth = page.events.find((e) => e.sequence === 5);
  assert.ok(fifth);
  assert.equal(reducer.applyEvent(fifth), 'gap');
  assert.equal(reducer.needsResync, true);

  const result = delivery.catchUp(access, 1);
  assert.equal(result.kind, 'snapshot');
  if (result.kind !== 'snapshot') return;
  reducer.applySnapshot(result.snapshot);
  assert.equal(reducer.needsResync, false);
  assert.equal(reducer.cursor, TOTAL_EVENTS);
  assert.equal(reducer.currentProjection?.brief_revision, FINAL_BRIEF_REVISION);
});
