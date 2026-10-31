/**
 * CTR-163 — Command Center Council report corrections (unexecuted here;
 * Trevor owns the test run).
 *
 * One runnable regression for each non-trivial pattern in this lane:
 *   1. The shared reader projection: exact-duplicate unknowns, honest
 *      readiness mapping, and a condition tally that never upgrades an
 *      absent status.
 *   2. The capacity handoff: strict schema, owner/scope binding, and
 *      EXACT skill matching only (no shared-token false match).
 *   3. The print template: 14pt floor, exactly nine cover portraits,
 *      no portrait on a redacted cover, no blank "Done when:", and
 *      duplicates printed once with the count stated.
 *   4. The export menu's real same-origin link reader.
 *
 * Run: node --import tsx --test tests/unit/ctr163-report-reading.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  acceptanceCriteriaDisplay,
  dedupeExact,
  planListDisplay,
  readScoredVerdict,
  summarizeConditions,
  READINESS_HEADLINE,
} from '../../src/lib/council/report-reading';
import {
  bindCapabilityHandoff,
  CAPABILITY_HANDOFF_CONTRACT,
  CapabilityHandoffError,
  matchPlanCapabilities,
  matchSkillExactly,
  parseCapabilityHandoff,
  type CapabilityHandoff,
} from '../../src/lib/council/capability-handoff';
import {
  PRINT_CSS,
  PRINT_MIN_FONT_PT,
  renderPrintHtml,
  type ReportPrintCover,
} from '../../src/lib/council/report-print-template';
import { pickCouncilExportLink } from '../../src/components/council/council-export-link';
import { SEAT_ROSTER } from '../../src/lib/council/contracts';

test('exact duplicates collapse with stated counts and no rewording', () => {
  const deduped = dedupeExact(['same', ' same ', 'other', 'other', '']);
  assert.equal(deduped.recorded, 5);
  assert.equal(deduped.distinct, 2);
  assert.equal(deduped.collapsed, 3);
  assert.deepEqual(deduped.items, ['same', 'other']);
  assert.match(deduped.note ?? '', /5 unknown\(s\) were recorded; 2 distinct/);
});

test('readiness separates the decision from the reading and never prints WAIT - Wait', () => {
  const blocked = summarizeConditions({
    prerequisites: ['Secure the funding first.'],
    hardFindings: [],
  });
  const go = readScoredVerdict({
    label: 'GO',
    recommended_option_label: 'Run the small test',
    conditions: blocked,
  });
  assert.equal(go.decision, 'Proceed: Run the small test');
  assert.equal(go.readiness_status, 'blocked');
  assert.notEqual(go.reading, go.label_plain);

  const wait = readScoredVerdict({
    label: 'WAIT',
    recommended_option_label: 'Wait for the audit',
    conditions: summarizeConditions({}),
  });
  assert.equal(wait.decision, 'Wait for now: Wait for the audit');
  assert.notEqual(wait.reading, wait.label_plain);
  assert.equal(wait.readiness_status, 'waiting');
  assert.equal(wait.readiness_headline, READINESS_HEADLINE.waiting);

  const ready = readScoredVerdict({
    label: 'GO',
    recommended_option_label: 'A',
    conditions: summarizeConditions({}),
  });
  assert.equal(ready.readiness_status, 'ready_to_act');
});

test('condition tally counts every recorded status honestly', () => {
  const summary = summarizeConditions({
    prerequisites: ['Prerequisite one.'],
    hardFindings: [
      { constraint_id: 'c1', option_id: 'a', result: 'fail', checker: 'checker' },
      { constraint_id: 'c2', option_id: 'a', result: 'pass', checker: 'checker' },
    ],
    cards: [
      {
        conditions: [
          { id: 'k1', kind: 'evidence_required', status: 'satisfied', blocking: true, description: 'd1' },
          { id: 'k2', kind: 'safeguard', status: 'unresolved', blocking: true, description: 'd2' },
          { id: 'k3', kind: 'prerequisite', status: 'waived_by_owner', blocking: false, description: 'd3' },
        ],
      } as never,
    ],
  });
  assert.equal(summary.total, 5); // prerequisite + failed constraint + three seat conditions
  assert.equal(summary.open, 2); // prerequisite + failed constraint
  assert.equal(summary.satisfied, 1);
  assert.equal(summary.waived, 1);
  assert.equal(summary.unresolved, 1);
  assert.equal(summary.blocking_open, 3); // prerequisite, failed constraint, unresolved seat condition
});

test('empty acceptance and stop criteria print an explicit absence, never a blank label', () => {
  const acceptance = acceptanceCriteriaDisplay(['', '   ']);
  assert.equal(acceptance.not_ready, true);
  assert.match(acceptance.note ?? '', /No acceptance criterion was recorded/);
  const stop = planListDisplay([], 'stop criterion');
  assert.match(stop.note ?? '', /absence in the record/);
});

function handoff(overrides: Partial<CapabilityHandoff> = {}): CapabilityHandoff {
  return {
    contract: CAPABILITY_HANDOFF_CONTRACT,
    owner_subject: 'owner:fixture',
    tenant_id: 'tenant-a',
    company_id: 'company-a',
    installation_id: 'install-a',
    captured_at: '2026-10-30T00:00:00Z',
    source: 'cli_export',
    items: [
      { skill_id: 'skill-77', name: 'council-of-wise-elders', version: '1.0.74', path: null },
      { skill_id: null, name: 'KIE  Video', version: '2.0.0', path: null },
    ],
    ...overrides,
  };
}

test('capability matching is exact only and never a shared-token match', () => {
  const parsed = parseCapabilityHandoff(handoff());
  const exactId = matchSkillExactly({ skill_id: 'skill-77' }, parsed);
  assert.equal(exactId.matches.length, 1);

  const sharedToken = matchSkillExactly({ name: 'council-of-wise-elders-extra' }, parsed);
  assert.equal(sharedToken.matches.length, 0, 'a longer name must not match a prefix');

  const tokenOverlap = matchSkillExactly({ name: 'council wise' }, parsed);
  assert.equal(tokenOverlap.matches.length, 0, 'token overlap must not match');

  const normalized = matchSkillExactly({ name: '  kIE   video ' }, parsed);
  assert.equal(normalized.matches.length, 1, 'normalized full-name equality is the one name match');

  const report = matchPlanCapabilities(
    [{ skill_id: 'skill-77' }, { name: 'not-installed' }],
    parsed,
  );
  assert.equal(report.status, 'partial');
  assert.equal(report.unmatched.length, 1);

  const absent = matchPlanCapabilities([{ skill_id: 'skill-77' }], null);
  assert.equal(absent.status, 'not_provided');
  assert.equal(absent.matched_requirements, 0);
});

test('capability handoff refuses another owner, another scope, and duplicate entries', () => {
  const parsed = parseCapabilityHandoff(handoff());
  assert.throws(
    () =>
      bindCapabilityHandoff(
        { subject: 'owner:someone-else', scope: { tenant_id: 'tenant-a', company_id: 'company-a', installation_id: 'install-a' } },
        parsed,
      ),
    (error: unknown) =>
      error instanceof CapabilityHandoffError && error.code === 'CAPABILITY_HANDOFF_OWNER_MISMATCH',
  );
  assert.throws(
    () =>
      bindCapabilityHandoff(
        { subject: 'owner:fixture', scope: { tenant_id: 'tenant-b', company_id: 'company-a', installation_id: 'install-a' } },
        parsed,
      ),
    (error: unknown) =>
      error instanceof CapabilityHandoffError && error.code === 'CAPABILITY_HANDOFF_SCOPE_MISMATCH',
  );
  assert.throws(
    () =>
      parseCapabilityHandoff(
        handoff({
          items: [
            { skill_id: 'skill-77', name: 'one', version: null, path: null },
            { skill_id: 'skill-77', name: 'two', version: null, path: null },
          ],
        }),
      ),
    (error: unknown) =>
      error instanceof CapabilityHandoffError && error.code === 'CAPABILITY_HANDOFF_INVALID',
  );
  assert.throws(
    () => parseCapabilityHandoff({ ...handoff(), extra_field: true }),
    (error: unknown) =>
      error instanceof CapabilityHandoffError && error.code === 'CAPABILITY_HANDOFF_INVALID',
  );
});

test('print template enforces the 14pt floor and prints nine cover portraits once', () => {
  assert.equal(PRINT_MIN_FONT_PT, 14);
  assert.equal(/font-size:\s*(?:[0-9]|1[0-3])(?:\.[0-9]+)?pt/.test(PRINT_CSS), false);
  const cover: ReportPrintCover = {
    status: 'ready',
    portraits: SEAT_ROSTER.map((seat) => ({
      seat_id: seat.seat_id,
      display_name: seat.display_name,
      data_uri: 'data:image/webp;base64,AAAA',
    })),
  };
  const html = renderPrintHtml(modelFixture(), { cover });
  assert.equal((html.match(/class="seat-portrait"/g) ?? []).length, 9);
  assert.equal((html.match(/data:image\/webp;base64,AAAA/g) ?? []).length, 9 + 0);
  assert.equal(html.includes('http://') || html.includes('https://'), false);
  assert.match(html, /No acceptance criterion was recorded/);
  assert.match(html, /5 unknown\(s\) were recorded; 2 distinct/);
  assert.equal((html.match(/<li>Repeated unknown<\/li>/g) ?? []).length, 1);
  assert.match(PRINT_CSS, /content: "Page " counter\(page\) " of " counter\(pages\)/);
});

test('a redacted cover prints the redaction note and no image at all', () => {
  const html = renderPrintHtml(modelFixture({ redacted: true }));
  assert.match(html, /Redacted report\./);
  assert.equal(html.includes('data:image/webp'), false);
  assert.equal(/<img\b/.test(html), false);
});

test('the export menu reads the real artifacts[] link and refuses an external URL', () => {
  const record = {
    artifacts: [
      {
        format: 'record_json',
        filename: 'council-report-s-r1.json',
        sha256: 'a'.repeat(64),
        download_url: '/api/council/exports/export-1',
        replayed: false,
      },
      {
        format: 'pdf',
        filename: 'council-report-s-r1.pdf',
        sha256: 'b'.repeat(64),
        download_url: 'https://evil.example/x.pdf',
      },
    ],
  };
  const json = pickCouncilExportLink(record, 'json');
  assert.equal(json?.url, '/api/council/exports/export-1');
  assert.equal(json?.filename, 'council-report-s-r1.json');
  assert.equal(pickCouncilExportLink(record, 'pdf'), null, 'an external URL is never a download link');
  assert.equal(pickCouncilExportLink(record, 'markdown'), null);
});

function modelFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    session_id: 'session-fixture',
    decision_title: 'Should we run the small test?',
    report_date: '2026-10-30',
    session_mode: 'full',
    route_display: 'Selected route used; underlying model identity not independently exposed.',
    protocol_version: 'wise-elders.core/1.0.0',
    report_revision_id: 'report-abc',
    redacted: false,
    redaction_profile_id: null,
    simulation_label: 'Simulated advisory perspectives.',
    authorization_notice: 'Authorization boundary: advisory verdict only.',
    summary: {
      label_plain: 'Proceed',
      decision: 'Proceed: Run the small test',
      reading: 'The council judges the decision sound as briefed.',
      readiness_headline: READINESS_HEADLINE.ready_to_act,
      evidence_strength: 'high',
      conditions_display: 'none recorded',
      unknowns_display: '5 recorded, 2 distinct',
    },
    readiness: { status: 'ready_to_act', headline: READINESS_HEADLINE.ready_to_act, reasons: ['Recorded verdict label: GO.'] },
    question_and_context: {
      question: 'Should we run the small test?',
      facts: [{ id: 'f1', statement: 'A recorded fact.', evidence_ids: [] }],
      assumptions: ['An assumption.'],
      unknowns: {
        recorded: 5,
        distinct: 2,
        collapsed: 3,
        items: ['Repeated unknown', 'Second unknown'],
        note: '5 unknown(s) were recorded; 2 distinct unknown(s) are printed here. The remaining 3 repeat exactly and are not printed twice; nothing was removed or reworded.',
      },
      critical_domains: [],
    },
    conditions_summary: {
      total: 0,
      open: 0,
      satisfied: 0,
      waived: 0,
      unresolved: 0,
      blocking_open: 0,
      items: [],
    },
    how_to_use: ['Read the decision first.'],
    your_tools: {
      status: 'not_provided',
      note: 'No client capability handoff was provided.',
      exactness_note: 'Exact matches only.',
      matches: [],
    },
    verdict_block: {
      revision: 1,
      label: 'GO',
      recommended_option_id: 'a',
      recommended_option_label: 'Run the small test',
      evidence_strength: 'high',
      content_sha256: 'c'.repeat(64),
      brief_sha256: 'd'.repeat(64),
    },
    score_table: [],
    main_reasons: ['A recorded reason.'],
    strongest_dissent: 'A recorded concern.',
    prerequisites: [],
    hard_constraints: [],
    amendments: { accepted: [], rejected: [] },
    ratification: { status: 'ratified', resolution_support: null },
    action_proposals: [
      {
        action_id: 'a1',
        title: 'Run the small test',
        description: 'Run one bounded test.',
        rationale: 'It is the cheapest informative step.',
        acceptance_criteria: [],
        depends_on_action_ids: [],
        risk_class: 'low',
      },
    ],
    cheapest_informative_test: null,
    stop_criteria: [],
    review_criteria: [],
    seats: [],
    participating_seats: [],
    brief: { assumptions: [], unknowns: [] },
    provenance: { note: 'Identifiers only.', evidence_manifest: [] },
    consult: null,
    ...overrides,
  };
}
