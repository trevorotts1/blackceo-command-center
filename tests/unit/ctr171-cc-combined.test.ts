/**
 * CTR-171 — combined Command Center candidate regression
 * (UNEXECUTED here; Trevor owns the test run).
 *
 * One source regression for the three integration call chains this lane
 * combines:
 *   1. consult export chain — verdict -> buildReportModel -> renderMarkdown
 *      / renderPrintHtml carries the single no-debate statement, keeps the
 *      five-section consult numbering, and never claims a council debate;
 *   2. scored print chain with no saved debate object — renderRounds reads
 *      the model through readReportDebateInput and prints an explicit
 *      absence instead of reading highest_round off a bare cast;
 *   3. route chain — createExportRoute -> createCouncilExport -> export
 *      journal, where a replay reports the capability section the recorded
 *      artifact was rendered from, never a newer stored catalog.
 *
 * Run: node --import tsx --import ./tests/setup/no-owner-telegram.ts \
 *   --test tests/unit/ctr171-cc-combined.test.ts
 */
import './_isolated-db';
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';

import {
  CAPABILITY_SNAPSHOT_SCHEMA,
  validateCapabilitySnapshot,
} from '../../src/lib/council/capability-snapshot';
import {
  buildReportModel,
  renderMarkdown,
} from '../../src/lib/council/report-downloads';
import {
  CONSULT_NO_DEBATE_NOTE,
  renderPrintHtml,
} from '../../src/lib/council/report-print-template';
import { createExportRoute } from '../../src/lib/council/composed-services';
import { authorizeSessionRead, type CouncilRouteContext } from '../../src/lib/council/api/foundation';
import { saveCapabilitySnapshot } from '../../src/lib/council/persistence/capability-snapshot-store';
import type { CouncilPrincipal } from '../../src/lib/council/auth';

const ALICE = 'owner:alice';
const SCOPE = {
  tenant_id: 'tenant-a',
  company_id: 'company-a',
  installation_id: 'install-a',
  owner_subject: null as string | null,
};

let repositories: import('../../src/lib/council/store').CouncilRepositories;
let envelopeFromScope: typeof import('../../src/lib/council/store').envelopeFromScope;
let canonicalHash: typeof import('../../src/lib/council/contracts').canonicalHash;
let SCHEMA_VERSIONS: typeof import('../../src/lib/council/contracts').SCHEMA_VERSIONS;
let contractFixtures: typeof import('../../src/lib/council/contracts/fixtures/examples');
let closeDb: () => void;
let db: import('better-sqlite3').Database;

before(async () => {
  const store = await import('../../src/lib/council/store');
  repositories = new store.CouncilRepositories();
  envelopeFromScope = store.envelopeFromScope;
  const contracts = await import('../../src/lib/council/contracts');
  canonicalHash = contracts.canonicalHash;
  SCHEMA_VERSIONS = contracts.SCHEMA_VERSIONS;
  contractFixtures = await import('../../src/lib/council/contracts/fixtures/examples');
  const dbModule = await import('../../src/lib/db');
  closeDb = dbModule.closeDb;
  db = dbModule.getDb();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT OR IGNORE INTO companies (id, name, slug, config, created_at, updated_at)
     VALUES (?, ?, ?, '{}', ?, ?)`,
  ).run('company-a', 'Company A', 'company-a', now, now);
});

after(() => {
  closeDb();
});

function brief() {
  return JSON.parse(JSON.stringify(contractFixtures.validBrief));
}

function hostStamp(sessionId: string, seatId: string) {
  return {
    scope: { ...SCOPE },
    operation_id: `op-${sessionId}-${seatId}`,
    route_id: 'route-fixture-1',
    session_id: sessionId,
    stamped_at: '2026-10-14T12:00:00.000Z',
    source_status: 'unverified' as const,
  };
}

function consultVerdict(sessionId: string) {
  const card = {
    schema_version: SCHEMA_VERSIONS.card,
    session_id: sessionId,
    brief_revision: 1,
    seat_id: 'simon-sinek',
    input_manifest_sha256: canonicalHash({ manifest: 'consult' }),
    pack_version: 'pack-fixture-1.0.0',
    card_kind: 'consult' as const,
    answer: 'Pilot the revised offer with one cohort.',
    framework_applications: [],
    evidence_ids: [],
    assumptions: ['Pilot capacity exists for one cohort.'],
    limits: ['Retention is unmeasured.'],
    next_step: 'Staff the pilot owner.',
    host: hostStamp(sessionId, 'simon-sinek'),
  };
  const base = {
    schema_version: SCHEMA_VERSIONS.verdict,
    result_kind: 'consult' as const,
    session_id: sessionId,
    verdict_revision: 1,
    consult_card: card,
    next_step: 'Staff the pilot owner.',
    validation_status: 'valid' as const,
    brief_sha256: canonicalHash(brief()),
  };
  return { ...base, content_sha256: canonicalHash(base) };
}

function scoredVerdict(sessionId: string) {
  const action = {
    action_id: 'act-1',
    session_id: sessionId,
    verdict_revision: 1,
    title: 'Run the marketing launch',
    description: 'Coordinate the recorded launch.',
    rationale: 'The council advised this bounded step.',
    source_condition_ids: [],
    department_id: 'dept-marketing',
    assigned_agent_id: null,
    sop_id: null,
    persona_id: null,
    acceptance_criteria: ['The step is complete and evidenced.'],
    budget_limit: { amount_minor: 5000, currency: 'USD' },
    due_at: null,
    depends_on_action_ids: [],
    risk_class: 'medium',
    execution_authorization_required: true,
  };
  const base = {
    schema_version: SCHEMA_VERSIONS.verdict,
    result_kind: 'scored' as const,
    session_id: sessionId,
    verdict_revision: 1,
    recommended_option_id: 'B',
    label: 'GO_WITH_CONDITIONS' as const,
    option_scores: [
      { option_id: 'A', score: 6, display_score: 6, weighted_sum: 132, denominator: 22, coverage: 1, spread: 0 },
      { option_id: 'B', score: 168 / 22, display_score: 7.6, weighted_sum: 168, denominator: 22, coverage: 1, spread: 3 },
    ],
    active_weights: { 'simon-sinek': 2 },
    evidence_strength: 'medium' as const,
    hard_constraint_findings: [],
    main_reasons: ['The bounded pilot dominates on the recorded weights.'],
    strongest_dissent: 'Retention is unmeasured.',
    accepted_amendments: [],
    rejected_amendments: [],
    critical_unknowns: [],
    prerequisites: ['Staff the pilot owner.'],
    action_proposals: [action],
    cheapest_informative_test: null,
    stop_criteria: [],
    review_criteria: [],
    resolution_support: null,
    validation_status: 'valid' as const,
    ratification_status: 'ratified' as const,
    brief_sha256: canonicalHash(brief()),
  };
  return { ...base, content_sha256: canonicalHash(base) };
}

test('a consult export states the absence of a debate in Markdown and print, and never throws', () => {
  const sessionId = 'sess-ctr171-consult';
  const model = buildReportModel({
    verdict: consultVerdict(sessionId) as never,
    brief: brief() as never,
    final_cards: [] as never,
  });

  // The committed consult model carries no debate object at all.
  assert.equal(model.debate, null);
  assert.equal(model.debate_note, CONSULT_NO_DEBATE_NOTE);

  const markdown = renderMarkdown(model);
  assert.ok(markdown.includes(CONSULT_NO_DEBATE_NOTE));
  assert.doesNotMatch(markdown, /Rounds saved:/);

  // The print/PDF path renders from the same model; a bare highest_round
  // read here would throw on the null debate object.
  const html = renderPrintHtml(model);
  assert.ok(html.includes(CONSULT_NO_DEBATE_NOTE));
  assert.doesNotMatch(html, /The debate/);
  assert.doesNotMatch(html, /Highest round:/);
  // Section numbering is unchanged: 2 consultation, 3 how to use, 4 helpers,
  // 5 records, and no section 7 for a consult.
  assert.match(html, /The consultation/);
  assert.match(html, /For your records/);
});

test('a scored report with no saved debate object prints an explicit absence instead of throwing', () => {
  const sessionId = 'sess-ctr171-nodebate';
  const model = buildReportModel({
    verdict: scoredVerdict(sessionId) as never,
    brief: brief() as never,
    final_cards: [] as never,
  });
  delete (model as Record<string, unknown>).debate;

  const html = renderPrintHtml(model);
  assert.match(html, /The debate/);
  assert.match(html, /No saved debate record is present/);
  assert.doesNotMatch(html, /Highest round:/);

  const markdown = renderMarkdown(model);
  assert.match(markdown, /No saved debate record is present/);
});

function seedSession(sessionId: string): void {
  const spec = JSON.parse(JSON.stringify(contractFixtures.validSessionSpec));
  const seededBrief = brief();
  spec.session_id = sessionId;
  seededBrief.session_id = sessionId;
  spec.visibility = 'company';
  spec.brief_sha256 = canonicalHash(seededBrief);
  const scope = { ...SCOPE };
  const envelope = envelopeFromScope(scope as never, ALICE, 'owner', 'write');
  repositories.createSession(envelope, {
    spec,
    brief: seededBrief,
    scope,
    state: {
      schema_version: 'wise-elders.session-state/v1',
      session_id: sessionId,
      mode: spec.mode,
      state: 'DRAFT',
      state_version: 0,
      brief_revision: seededBrief.revision,
      resume_phase: null,
      cancel_generation: 0,
      revocation_generation: 0,
      attempt: 1,
      lease_epoch: 0,
      archived: false,
      updated_at: spec.created_at,
    },
    sample: false,
  } as never);
}

function advisorCard(sessionId: string, seatId: string, operationId: string): Record<string, unknown> {
  return {
    schema_version: 'wise-elders.card/v1',
    session_id: sessionId,
    brief_revision: 1,
    seat_id: seatId,
    input_manifest_sha256: canonicalHash({ manifest: operationId }),
    pack_version: 'pack-fixture-1.0.0',
    card_kind: 'advisor',
    round: 2,
    stance: 'support',
    preferred_option_id: 'B',
    option_scores: [
      { option_id: 'A', score: 5, rationale: 'Fixture rationale.', evidence_ids: ['ev-1'] },
      { option_id: 'B', score: 8, rationale: 'Fixture rationale.', evidence_ids: ['ev-1'] },
    ],
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
    host: hostStamp(sessionId, seatId),
  };
}

function commitVerdict(sessionId: string): void {
  const envelope = envelopeFromScope(SCOPE as never, ALICE, 'owner', 'write');
  const fence = { expected_state_version: 0, cancel_generation: 0, lease_epoch: 0 };
  repositories.acceptCard(
    envelope,
    advisorCard(sessionId, 'simon-sinek', `op-${sessionId}-1`) as never,
    fence,
  );
  const verdict = scoredVerdict(sessionId);
  repositories.saveVerdict(envelope, verdict as never);
}

function snapshot(items: unknown[]) {
  return validateCapabilitySnapshot({
    schema_version: CAPABILITY_SNAPSHOT_SCHEMA,
    installation_id: 'install-a',
    captured_at: '2026-10-30',
    basis: 'at_export',
    items,
    limitations: ['Read from this installation only.'],
  });
}

const department = {
  capability_id: 'department:dept-marketing',
  kind: 'department',
  name: 'Marketing',
  description: 'Runs marketing.',
  availability: 'available_now',
  source: 'openclaw.departments',
  recorded_reference_ids: [],
};

function principal(): CouncilPrincipal {
  return {
    subject: ALICE,
    tenantKind: 'client',
    channel: 'browser',
    supportAccess: false,
    scope: { ...SCOPE },
    tenant: {
      tenantId: 'tenant-a',
      companyId: 'company-a',
      clientId: 'client-a',
      kind: 'client',
      subject: ALICE,
      host: 'council-a.test',
      installationId: 'install-a',
    },
  };
}

function ctxFor(): CouncilRouteContext {
  return {
    principal: principal(),
    requestId: 'fixture-request',
    repositories,
    store: { handle: () => db } as CouncilRouteContext['store'],
  };
}

test('createExportRoute reports the frozen artifact section on replay, not a newer stored catalog', async () => {
  const sessionId = 'sess-ctr171-route';
  seedSession(sessionId);
  commitVerdict(sessionId);
  const ctx = ctxFor();
  const authorized = authorizeSessionRead(ctx, sessionId);

  saveCapabilitySnapshot(db, SCOPE, {
    snapshot: snapshot([department]),
    source: 'client_push',
    owner_subject: ALICE,
    now: '2026-10-30T12:00:00.000Z',
  });
  const first = await createExportRoute(
    ctx,
    authorized,
    { session_id: sessionId, format: 'markdown' },
    'ctr171-route-key',
  );
  assert.equal(first.capability_snapshot.status, 'matched');
  assert.equal(first.capability_snapshot.item_count, 1);
  assert.equal(first.capability_snapshot.matched_count, 1);

  // The stored catalog is replaced with an empty one. The replay re-renders
  // the recorded artifact from its frozen section, so the route must keep
  // describing that section — never the newer catalog it just loaded.
  saveCapabilitySnapshot(db, SCOPE, {
    snapshot: snapshot([]),
    source: 'client_push',
    owner_subject: ALICE,
    now: '2026-10-31T12:00:00.000Z',
  });
  const replay = await createExportRoute(
    ctx,
    authorized,
    { session_id: sessionId, format: 'markdown' },
    'ctr171-route-key',
  );
  assert.equal(replay.artifacts[0].replayed, true);
  assert.equal(replay.artifacts[0].sha256, first.artifacts[0].sha256);
  assert.equal(replay.capability_snapshot.status, 'matched');
  assert.equal(replay.capability_snapshot.item_count, 1);
  assert.equal(replay.capability_snapshot.matched_count, 1);
  assert.equal(replay.capability_snapshot.captured_at, '2026-10-30');
});
