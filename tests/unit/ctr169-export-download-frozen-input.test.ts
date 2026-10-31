/**
 * CTR-169 — report export/download frozen-input regression
 * (UNEXECUTED here; Trevor owns the test run).
 *
 * One source regression for the three CTR-169 changes:
 *   1. an export created with a capability snapshot round-trips through
 *      readCouncilExport, and a replay with a CHANGED catalog re-renders
 *      from the section frozen in the export journal (not the live
 *      snapshot), so the recorded artifact hash still matches;
 *   2. an open blocking condition reports canonical `blocked`, never
 *      `actionable_with_conditions`;
 *   3. a report model with no debate object renders an explicit
 *      no-saved-debate block instead of throwing on a bare cast.
 *
 * Run: node --import tsx --import ./tests/setup/no-owner-telegram.ts \
 *   --test tests/unit/ctr169-export-download-frozen-input.test.ts
 */
import './_isolated-db';
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';

import {
  CAPABILITY_SNAPSHOT_SCHEMA,
  validateCapabilitySnapshot,
} from '../../src/lib/council/capability-snapshot';
import {
  createCouncilExport,
  readCouncilExport,
  readReportDebateInput,
  renderMarkdown,
  type ReportDownloadsDeps,
} from '../../src/lib/council/report-downloads';
import { readScoredVerdict, summarizeConditions } from '../../src/lib/council/report-reading';

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

function seedSession(sessionId: string): void {
  const spec = JSON.parse(JSON.stringify(contractFixtures.validSessionSpec));
  const brief = JSON.parse(JSON.stringify(contractFixtures.validBrief));
  spec.session_id = sessionId;
  brief.session_id = sessionId;
  spec.visibility = 'company';
  spec.brief_sha256 = canonicalHash(brief);
  const scope = { ...SCOPE };
  const envelope = envelopeFromScope(scope as never, ALICE, 'owner', 'write');
  repositories.createSession(envelope, {
    spec,
    brief,
    scope,
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
    host: {
      scope: { ...SCOPE },
      operation_id: operationId,
      route_id: 'route-fixture-1',
      session_id: sessionId,
      stamped_at: '2026-10-14T12:00:00.000Z',
      source_status: 'unverified',
    },
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
  const session = repositories.getSession(envelope, sessionId);
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
    brief_sha256: session?.spec.brief_sha256,
  };
  const verdict = { ...base, content_sha256: canonicalHash(base) };
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

function deps(): ReportDownloadsDeps {
  return { repositories, store: { handle: () => db } as never };
}

test('export create/read keeps the snapshot frozen in the journal across a changed catalog and replay', async () => {
  const sessionId = 'sess-ctr169-1';
  seedSession(sessionId);
  commitVerdict(sessionId);
  const envelope = envelopeFromScope(SCOPE as never, ALICE, 'owner', 'read');

  const first = await createCouncilExport(deps(), envelope, {
    session_id: sessionId,
    formats: ['markdown'],
    request_id: 'ctr169-frozen-key',
    exporter_subject: ALICE,
    via: 'owner',
    exported_at: '2026-10-30T12:00:00.000Z',
    capability_snapshot: snapshot([department]),
  });
  const artifact = first.artifacts[0];

  const downloaded = await readCouncilExport(deps(), envelope, sessionId, artifact.export_id);
  assert.equal(typeof downloaded.bytes, 'string');
  assert.match(downloaded.bytes as string, /Marketing/);
  assert.equal(downloaded.record.artifact_sha256, artifact.sha256);
  assert.equal(downloaded.record.frozen_capability_section?.status, 'matched');

  // The live catalog changes (the second snapshot has no items). A replay
  // of the same logical request must still reproduce the recorded bytes
  // from the frozen section, not the changed snapshot.
  const replay = await createCouncilExport(deps(), envelope, {
    session_id: sessionId,
    formats: ['markdown'],
    request_id: 'ctr169-frozen-key',
    exporter_subject: ALICE,
    via: 'owner',
    exported_at: '2026-10-31T12:00:00.000Z',
    capability_snapshot: snapshot([]),
  });
  assert.equal(replay.artifacts[0].sha256, artifact.sha256);
  assert.equal(replay.artifacts[0].replayed, true);
});

test('an open blocking condition is canonical blocked, not actionable_with_conditions', () => {
  const conditions = summarizeConditions({
    prerequisites: ['Staff the pilot owner.'],
  });
  assert.equal(conditions.blocking_open, 1);
  const reading = readScoredVerdict({
    label: 'GO_WITH_CONDITIONS',
    recommended_option_label: 'Run the marketing launch',
    conditions,
  });
  assert.equal(reading.readiness_status, 'blocked');
  assert.ok(
    reading.blocked_reasons.some((reason) => /blocking condition/i.test(reason)),
    JSON.stringify(reading.blocked_reasons),
  );
});

test('a model without a debate object renders an explicit no-data block and does not throw', () => {
  assert.deepEqual(readReportDebateInput(undefined), { present: false, record: {} });
  assert.deepEqual(readReportDebateInput(null), { present: false, record: {} });
  assert.deepEqual(readReportDebateInput('debate'), { present: false, record: {} });

  const rendered = renderMarkdown({});
  assert.match(rendered, /No saved debate record is present/);
  assert.doesNotMatch(rendered, /Rounds saved:/);
});
