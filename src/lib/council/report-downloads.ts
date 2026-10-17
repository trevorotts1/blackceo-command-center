/**
 * Council report downloads, Command Center form (CWE-050,
 * CWE-038's CC remainder; directive Sections 24.1 to 24.4, 17.2;
 * binding B15).
 *
 * CWE-038 built and proved the report contracts in the portable
 * runtime: one report model built from the validated verdict
 * revision, the frozen brief, and the final cards; deterministic
 * Markdown, canonical record JSON, and print HTML rendered from
 * that model only; a registered deliverable per artifact bound to
 * the exact verdict revision and content hash. PDF was registered
 * NOT READY there because that runtime's dependency bill has no
 * renderer. In this Command Center composition the pdf format is
 * rendered through CWE-044's Playwright/Chromium renderer
 * (src/lib/council/report-pdf.ts, directive Section 24.3), whose
 * output is byte-pinned (volatile info-dictionary dates zeroed),
 * so a PDF artifact binds by SHA-256 exactly like the text formats:
 * journal record, deliverable row, and download bytes agree, and
 * the read path re-renders and verifies before serving. When the
 * Chromium capability is absent, a pdf request refuses
 * EXPORT_FORMAT_NOT_READY naming the missing piece; a render or
 * validation failure refuses EXPORT_RENDER_FAILED. No path
 * produces placeholder bytes. This module is the same contract
 * bound to the Command Center store and evidence path:
 *
 * - The model is built from the session's committed verdict (which
 *   the CWE-006 store admitted only after canonical validation),
 *   the frozen brief, and the committed final cards. A verdict
 *   whose recorded validation status is not 'valid', an incomplete
 *   scored verdict with no final cards, or a deleted session
 *   refuses with the CWE-038 typed codes; no partial output.
 * - Every export journals an operation_completed record with kind
 *   'report_export' (the frozen CWE-003 vocabulary has no export
 *   event type; CWE-038's accepted convention), carrying the
 *   artifact hash and the exact verdict identity. A replayed
 *   request re-renders, verifies the recorded hash, and writes no
 *   second record (T078).
 * - Each artifact also registers through the Command Center's
 *   standing evidence path (registerDeliverable into
 *   task_deliverables) against the session's kanban parent task
 *   when one exists, closing B15 on the CC side; the B15 proof is
 *   the hash chain export -> journal record -> deliverable row ->
 *   download bytes, exercised by the CWE-050 integration tests.
 * - Reads recheck authorization and session liveness on every
 *   request (the route authorizes; this service refuses a deleted
 *   session with EXPORT_SESSION_DELETED even mid-flow, T059), and
 *   re-render deterministically, verifying the bytes against the
 *   journaled hash before returning them.
 * - Download headers follow Section 24.4: safe ID-only filenames,
 *   Content-Disposition attachment, the registered media type, and
 *   no-cache for private reports.
 *
 * The provenance appendix lists evidence identifiers, kinds, and
 * locators only; no evidence body or source text exists in the
 * model, so no export path can carry raw source material.
 */

import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import {
  advisorProfileLabel,
  canonicalHash,
  canonicalStringify,
  CONTRACT_PACKAGE_VERSION,
  SEAT_IDS,
  SEAT_ROSTER,
  sha256Hex,
  type AdvisorCard,
  type CouncilCard,
  type DecisionBrief,
  type RatificationCard,
  type ScoredVerdict,
  type SeatId,
  type Verdict,
} from './contracts';
import type { CouncilEnvelope, CouncilRepositories, CouncilStoredSession } from './store';
import type { CouncilStore } from './persistence/council-store';
import { registerDeliverable } from '../task-lifecycle';
import { CouncilApiError } from './api/errors';
import { renderCouncilReportPdf, ReportPdfError } from './report-pdf';
import {
  formatCoverage,
  formatDisplayScore,
  formatScore,
  renderPrintHtml,
} from './report-print-template';

// ------------------------------------------------------------ formats

export const REPORT_FORMATS = ['record_json', 'markdown', 'print_html', 'pdf'] as const;
export type ReportFormat = (typeof REPORT_FORMATS)[number];

export interface ReportFormatDescriptor {
  format: ReportFormat;
  status: 'ready' | 'not_ready';
  media_type: string;
  file_extension: string;
  missing_piece: string | null;
}

export const REPORT_FORMAT_REGISTRY: Readonly<Record<ReportFormat, ReportFormatDescriptor>> = {
  record_json: {
    format: 'record_json',
    status: 'ready',
    media_type: 'application/json',
    file_extension: 'json',
    missing_piece: null,
  },
  markdown: {
    format: 'markdown',
    status: 'ready',
    media_type: 'text/markdown; charset=utf-8',
    file_extension: 'md',
    missing_piece: null,
  },
  print_html: {
    format: 'print_html',
    status: 'ready',
    media_type: 'text/html; charset=utf-8',
    file_extension: 'html',
    missing_piece: null,
  },
  pdf: {
    format: 'pdf',
    status: 'ready',
    media_type: 'application/pdf',
    file_extension: 'pdf',
    missing_piece: null,
  },
};

export function isReportFormat(value: string): value is ReportFormat {
  return (REPORT_FORMATS as readonly string[]).includes(value);
}

/** Client format names (Section 17 client) mapped to registry formats. */
export function resolveClientFormats(format: string): ReportFormat[] | null {
  switch (format) {
    case 'markdown':
      return ['markdown'];
    case 'json':
    case 'record_json':
      return ['record_json'];
    case 'print_html':
      return ['print_html'];
    case 'pdf':
      return ['pdf'];
    case 'all':
      return ['record_json', 'markdown', 'print_html', 'pdf'];
    default:
      return null;
  }
}

/** Safe download filename (Section 24.4): built from IDs only. */
export function reportFilename(args: {
  session_id: string;
  verdict_revision: number;
  format: ReportFormat;
  redacted: boolean;
}): string {
  const descriptor = REPORT_FORMAT_REGISTRY[args.format];
  const redactionSuffix = args.redacted ? '-redacted' : '';
  return `council-report-${args.session_id}-r${args.verdict_revision}${redactionSuffix}.${descriptor.file_extension}`;
}

export function sha256OfText(text: string): string {
  return sha256Hex(new TextEncoder().encode(text));
}

/** Artifact bytes are text for the deterministic formats and a
 * Buffer for the rendered PDF; hashing and sizing handle both. */
export function sha256OfArtifact(bytes: string | Buffer): string {
  return typeof bytes === 'string' ? sha256OfText(bytes) : sha256Hex(bytes);
}

export function byteSizeOfArtifact(bytes: string | Buffer): number {
  return typeof bytes === 'string' ? Buffer.byteLength(bytes, 'utf8') : bytes.length;
}

// -------------------------------------------------------------- model

export interface RedactionReplacement {
  match: string;
  replace_with?: string;
}

export interface RedactionProfile {
  profile_id: string;
  replacements: RedactionReplacement[];
}

export const DEFAULT_ROUTE_DISPLAY =
  'Selected route used; underlying model identity not independently exposed.';

export const SIMULATION_LABEL =
  'Simulated advisory perspectives. Every advisor voice in this report is an AI perspective inspired by the published work of the named person. It is not the individual and not an endorsement.';

export const AUTHORIZATION_NOTICE =
  'Authorization boundary: this report records an advisory council verdict only. It is not an action-plan approval and not an execution authorization. Any action proposal listed here requires its own separate approvals before anything is executed; a council verdict is never an execution credential.';

const DISPLAY_NAME_BY_SEAT: Readonly<Record<SeatId, string>> = Object.fromEntries(
  SEAT_ROSTER.map((entry) => [entry.seat_id, entry.display_name]),
) as Record<SeatId, string>;

export function seatDisplayName(seatId: SeatId): string {
  return DISPLAY_NAME_BY_SEAT[seatId];
}

export function seatLabel(seatId: SeatId): string {
  return advisorProfileLabel(DISPLAY_NAME_BY_SEAT[seatId]);
}

export function scoringCardsOf(
  cards: readonly CouncilCard[],
): Array<AdvisorCard | RatificationCard> {
  const ratification = cards.filter(
    (c): c is RatificationCard => c.card_kind === 'ratification',
  );
  if (ratification.length > 0) return ratification;
  return cards.filter(
    (c): c is AdvisorCard => c.card_kind === 'advisor' && c.round === 2,
  );
}

export function abstentionsByOption(
  cards: readonly CouncilCard[],
): Map<string, SeatId[]> {
  const byOption = new Map<string, SeatId[]>();
  for (const card of scoringCardsOf(cards)) {
    for (const entry of card.option_scores) {
      if (entry.score !== null) continue;
      const list = byOption.get(entry.option_id) ?? [];
      if (!list.includes(card.seat_id)) list.push(card.seat_id);
      byOption.set(entry.option_id, list);
    }
  }
  for (const list of byOption.values()) {
    list.sort((a, b) => SEAT_IDS.indexOf(a) - SEAT_IDS.indexOf(b));
  }
  return byOption;
}

export function reportRevisionId(args: {
  session_id: string;
  verdict_content_sha256: string;
  redaction_profile_id: string | null;
}): string {
  const hash = canonicalHash({
    session_id: args.session_id,
    verdict_content_sha256: args.verdict_content_sha256,
    redaction_profile_id: args.redaction_profile_id,
  });
  return `report-${hash.slice(0, 32)}`;
}

const REDACTION_PROTECTED_KEYS: ReadonlySet<string> = new Set([
  'schema_version',
  'session_id',
  'seat_id',
  'option_id',
  'evidence_id',
  'constraint_id',
  'action_id',
  'amendment_id',
  'proposing_seat_id',
  'report_revision_id',
  'verdict_content_sha256',
  'brief_sha256',
  'content_sha256',
  'sha256',
  'resolution_sha256',
  'input_manifest_sha256',
  'draft_resolution_sha256',
]);

function redactValue(value: unknown, replacements: RedactionReplacement[]): unknown {
  if (typeof value === 'string') {
    let out = value;
    for (const replacement of replacements) {
      out = out.split(replacement.match).join(replacement.replace_with ?? '[redacted]');
    }
    return out;
  }
  if (Array.isArray(value)) return value.map((item) => redactValue(item, replacements));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      out[key] = REDACTION_PROTECTED_KEYS.has(key) ? inner : redactValue(inner, replacements);
    }
    return out;
  }
  return value;
}

export interface ReportModelInput {
  verdict: Verdict;
  brief: DecisionBrief;
  final_cards: readonly CouncilCard[];
  report_date: string;
  session_mode: string | null;
  redaction: RedactionProfile | null;
}

function scoredModel(input: ReportModelInput, verdict: ScoredVerdict) {
  const { brief, final_cards } = input;
  const abstentions = abstentionsByOption(final_cards);
  const optionLabel = new Map(brief.options.map((o) => [o.id, o]));
  const advisorCards = final_cards
    .filter((c): c is AdvisorCard => c.card_kind === 'advisor' && c.round === 2)
    .sort((a, b) => SEAT_IDS.indexOf(a.seat_id) - SEAT_IDS.indexOf(b.seat_id));
  const ratificationBySeat = new Map(
    final_cards
      .filter((c): c is RatificationCard => c.card_kind === 'ratification')
      .map((c) => [c.seat_id, c]),
  );
  const participatingSeatIds = SEAT_IDS.filter(
    (seatId) => brief.relevance_weights[seatId] !== undefined,
  );
  return {
    verdict_block: {
      result_kind: 'scored' as const,
      revision: verdict.verdict_revision,
      label: verdict.label,
      recommended_option_id: verdict.recommended_option_id,
      recommended_option_label:
        verdict.recommended_option_id !== null
          ? (optionLabel.get(verdict.recommended_option_id)?.label ?? null)
          : null,
      validation_status: verdict.validation_status,
      ratification_status: verdict.ratification_status,
      evidence_strength: verdict.evidence_strength,
      content_sha256: verdict.content_sha256,
      brief_sha256: verdict.brief_sha256,
    },
    score_table: verdict.option_scores.map((summary) => ({
      option_id: summary.option_id,
      option_label: optionLabel.get(summary.option_id)?.label ?? summary.option_id,
      option_kind: optionLabel.get(summary.option_id)?.kind ?? null,
      weighted_sum: summary.weighted_sum,
      denominator: summary.denominator,
      score: summary.score,
      display_score: summary.display_score,
      coverage: summary.coverage,
      spread: summary.spread,
      abstained_seat_ids: abstentions.get(summary.option_id) ?? [],
    })),
    main_reasons: [...verdict.main_reasons],
    strongest_dissent: verdict.strongest_dissent,
    prerequisites: [...verdict.prerequisites],
    hard_constraints: verdict.hard_constraint_findings.map((finding) => ({
      constraint_id: finding.constraint_id,
      option_id: finding.option_id,
      result: finding.result,
      checker: finding.checker,
      evidence_ids: [...finding.evidence_ids],
    })),
    amendments: {
      accepted: verdict.accepted_amendments,
      rejected: verdict.rejected_amendments,
    },
    ratification: {
      status: verdict.ratification_status,
      resolution_support: verdict.resolution_support,
    },
    action_proposals: verdict.action_proposals.map((proposal) => ({
      action_id: proposal.action_id,
      title: proposal.title,
      description: proposal.description,
      rationale: proposal.rationale,
      source_condition_ids: [...proposal.source_condition_ids],
      acceptance_criteria: [...proposal.acceptance_criteria],
      depends_on_action_ids: [...proposal.depends_on_action_ids],
      risk_class: proposal.risk_class,
      due_at: proposal.due_at,
      budget_limit: proposal.budget_limit,
      execution_authorization_required: proposal.execution_authorization_required,
    })),
    cheapest_informative_test: verdict.cheapest_informative_test,
    stop_criteria: [...verdict.stop_criteria],
    review_criteria: [...verdict.review_criteria],
    critical_unknowns: [...verdict.critical_unknowns],
    participating_seats: participatingSeatIds.map((seatId) => ({
      seat_id: seatId,
      display_name: seatDisplayName(seatId),
      label: seatLabel(seatId),
      qualification: null as string | null,
      weight: brief.relevance_weights[seatId] ?? null,
    })),
    seats: advisorCards.map((card) => ({
      seat_id: card.seat_id,
      display_name: seatDisplayName(card.seat_id),
      label: seatLabel(card.seat_id),
      qualification: null as string | null,
      stance: card.stance,
      preferred_option_id: card.preferred_option_id,
      decisive_arguments: [...card.decisive_arguments],
      strongest_objection: card.strongest_objection,
      change_my_mind: card.change_my_mind,
      minority_position: card.minority_position,
      evidence_strength: card.evidence_strength,
      conditions: card.conditions.map((condition) => ({
        id: condition.id,
        description: condition.description,
        kind: condition.kind,
        blocking: condition.blocking,
        status: condition.status,
      })),
      abstained_option_ids: card.option_scores
        .filter((entry) => entry.score === null)
        .map((entry) => entry.option_id),
      resolution_stance: ratificationBySeat.get(card.seat_id)?.resolution_stance ?? null,
    })),
    consult: null as null | Record<string, unknown>,
  };
}

function consultModel(input: ReportModelInput, verdict: Verdict) {
  if (verdict.result_kind !== 'consult') {
    throw new CouncilApiError(
      'EXPORT_VERDICT_INVALID',
      'The committed verdict is neither a scored verdict nor a consult result; nothing was exported.',
      { status: 409, action: 'check_verdict' },
    );
  }
  const card = verdict.consult_card;
  return {
    verdict_block: {
      result_kind: 'consult' as const,
      revision: verdict.verdict_revision,
      label: null as string | null,
      recommended_option_id: null as string | null,
      recommended_option_label: null as string | null,
      validation_status: verdict.validation_status,
      ratification_status: null as string | null,
      evidence_strength: null as string | null,
      content_sha256: verdict.content_sha256,
      brief_sha256: verdict.brief_sha256,
    },
    score_table: [] as unknown[],
    main_reasons: [] as string[],
    strongest_dissent: null as string | null,
    prerequisites: [] as string[],
    hard_constraints: [] as unknown[],
    amendments: { accepted: [] as unknown[], rejected: [] as unknown[] },
    ratification: { status: null as string | null, resolution_support: null as unknown },
    action_proposals: [] as unknown[],
    cheapest_informative_test: null as string | null,
    stop_criteria: [] as string[],
    review_criteria: [] as string[],
    critical_unknowns: [] as string[],
    participating_seats: [
      {
        seat_id: card.seat_id,
        display_name: seatDisplayName(card.seat_id),
        label: seatLabel(card.seat_id),
        qualification: null as string | null,
        weight: input.brief.relevance_weights[card.seat_id] ?? null,
      },
    ],
    seats: [] as unknown[],
    consult: {
      seat_id: card.seat_id,
      display_name: seatDisplayName(card.seat_id),
      label: seatLabel(card.seat_id),
      answer: card.answer,
      assumptions: [...card.assumptions],
      limits: [...card.limits],
      card_next_step: card.next_step,
      next_step: verdict.next_step,
    } as Record<string, unknown>,
  };
}

/**
 * Build the one report model. Pure and deterministic. Seat source
 * qualifications are not recorded in the Command Center (the seat
 * packs live in the portable runtime), so they render as 'not
 * recorded' here and are never upgraded.
 */
export function buildReportModel(input: ReportModelInput): Record<string, unknown> {
  const { verdict, brief, final_cards } = input;
  const packVersions = [...new Set(final_cards.map((card) => card.pack_version))].sort();
  const base =
    verdict.result_kind === 'scored' ? scoredModel(input, verdict) : consultModel(input, verdict);
  const model: Record<string, unknown> = {
    schema_version: 'wise-elders.report/v1',
    artifact_kind: 'council_decision_report',
    product: 'Council of Wise Elders',
    report_revision_id: reportRevisionId({
      session_id: verdict.session_id,
      verdict_content_sha256: verdict.content_sha256,
      redaction_profile_id: input.redaction?.profile_id ?? null,
    }),
    redacted: input.redaction !== null,
    redaction_profile_id: input.redaction?.profile_id ?? null,
    session_id: verdict.session_id,
    decision_title: brief.question,
    report_date: input.report_date,
    display_timezone: brief.display_timezone,
    session_mode: input.session_mode,
    route_display: DEFAULT_ROUTE_DISPLAY,
    protocol_version: CONTRACT_PACKAGE_VERSION,
    source_pack_versions: packVersions,
    simulation_label: SIMULATION_LABEL,
    authorization_notice: AUTHORIZATION_NOTICE,
    brief: {
      brief_id: brief.brief_id,
      revision: brief.revision,
      facts: brief.facts.map((fact) => ({
        id: fact.id,
        statement: fact.statement,
        evidence_ids: [...fact.evidence_ids],
      })),
      assumptions: brief.assumptions.map((fact) => fact.statement),
      unknowns: brief.unknowns.map((fact) => fact.statement),
    },
    ...base,
    provenance: {
      evidence_manifest: brief.evidence_manifest.map((entry) => ({
        evidence_id: entry.evidence_id,
        source_kind: entry.source_kind,
        locator: entry.locator,
        sha256: entry.sha256,
      })),
      note: 'Identifiers, kinds, locators, and hashes only. No source text is reproduced in this export.',
    },
  };
  if (input.redaction === null) return model;
  for (const replacement of input.redaction.replacements) {
    if (replacement.match.length === 0) {
      throw new CouncilApiError(
        'EXPORT_REQUEST_INVALID',
        'A redaction replacement match must not be empty; the export was refused.',
        { status: 400, action: 'fix_request' },
      );
    }
  }
  return redactValue(model, input.redaction.replacements) as Record<string, unknown>;
}

/** No redaction target may survive in final artifact bytes or filenames. */
export function assertRedactionComplete(
  artifacts: Array<{ filename: string; bytes: string }>,
  redaction: RedactionProfile,
): void {
  for (const artifact of artifacts) {
    for (const replacement of redaction.replacements) {
      if (
        replacement.match.length > 0 &&
        (artifact.bytes.includes(replacement.match) || artifact.filename.includes(replacement.match))
      ) {
        throw new CouncilApiError(
          'EXPORT_REDACTION_INCOMPLETE',
          'A redaction target survived into the rendered artifact; the export was refused rather than shipped with the leak.',
          { status: 500, action: 'contact_support' },
        );
      }
    }
  }
}

// ----------------------------------------------------------- markdown

function asRecord(value: unknown): Record<string, unknown> {
  return value as Record<string, unknown>;
}
function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}
function asStringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}
function asNumberOrNull(value: unknown): number | null {
  return typeof value === 'number' ? value : null;
}
function formatPlainNumber(value: number | null): string {
  if (value === null) return 'n/a';
  return String(Number(value.toFixed(4)));
}
function qualificationText(value: unknown): string {
  return typeof value === 'string' ? value : 'not recorded';
}
function mdList(items: unknown[]): string[] {
  return items.map((item) => `- ${asString(item)}`);
}

export function renderMarkdown(model: Record<string, unknown>): string {
  const verdict = asRecord(model.verdict_block);
  const brief = asRecord(model.brief);
  const lines: string[] = [];
  lines.push(`# Council of Wise Elders: Decision Report`);
  lines.push('');
  lines.push(`Decision: ${asString(model.decision_title)}`);
  lines.push(`Date: ${asString(model.report_date)}`);
  lines.push(`Session: ${asString(model.session_id)}`);
  lines.push(`Mode: ${asStringOrNull(model.session_mode) ?? 'not recorded'}`);
  lines.push(`Route: ${asString(model.route_display)}`);
  lines.push(`Report revision: ${asString(model.report_revision_id)}`);
  lines.push(`Verdict revision: ${String(verdict.revision)}`);
  lines.push(`Verdict content SHA-256: ${asString(verdict.content_sha256)}`);
  lines.push(`Brief SHA-256: ${asString(verdict.brief_sha256)}`);
  lines.push(`Protocol version: ${asString(model.protocol_version)}`);
  lines.push(
    `Source pack versions: ${asArray(model.source_pack_versions).map(asString).join(', ') || 'none recorded'}`,
  );
  if (model.redacted === true) {
    lines.push(`Redacted report: yes (profile ${asString(model.redaction_profile_id)})`);
  }
  lines.push('');
  lines.push(`> ${asString(model.simulation_label)}`);
  lines.push('');
  lines.push(`> ${asString(model.authorization_notice)}`);
  lines.push('');

  const consult = model.consult as Record<string, unknown> | null;
  if (consult) {
    lines.push('## Consultation');
    lines.push('');
    lines.push(`${asString(consult.display_name)}: ${asString(consult.label)}`);
    lines.push('');
    lines.push(asString(consult.answer));
    lines.push('');
    lines.push('Assumptions:');
    lines.push(...mdList(asArray(consult.assumptions)));
    lines.push('');
    lines.push('Limits:');
    lines.push(...mdList(asArray(consult.limits)));
    lines.push('');
    lines.push(`Next step: ${asString(consult.next_step)}`);
    lines.push('');
    pushProvenanceMd(lines, model);
    return `${lines.join('\n')}\n`;
  }

  lines.push('## Executive decision');
  lines.push('');
  lines.push(`Verdict: ${asString(verdict.label)}`);
  const recommended = asStringOrNull(verdict.recommended_option_id);
  lines.push(
    `Recommendation: ${
      recommended === null
        ? 'none'
        : `${recommended} (${asString(verdict.recommended_option_label)})`
    }`,
  );
  lines.push('');
  lines.push('Prerequisites:');
  const prerequisites = asArray(model.prerequisites);
  lines.push(...(prerequisites.length > 0 ? mdList(prerequisites) : ['- none']));
  lines.push('');
  lines.push('Why:');
  lines.push(...mdList(asArray(model.main_reasons)));
  lines.push('');

  lines.push('## Alternatives and scores');
  lines.push('');
  lines.push(
    '| Option | Weighted sum | Denominator | Score | Display score | Coverage | Spread | Abstentions |',
  );
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const rowValue of asArray(model.score_table)) {
    const row = asRecord(rowValue);
    const abstained = asArray(row.abstained_seat_ids).map(asString).join(', ') || 'none';
    lines.push(
      `| ${asString(row.option_id)} (${asString(row.option_label)}) | ${formatPlainNumber(asNumberOrNull(row.weighted_sum))} | ${formatPlainNumber(asNumberOrNull(row.denominator))} | ${formatScore(asNumberOrNull(row.score))} | ${formatDisplayScore(asNumberOrNull(row.display_score))} | ${formatCoverage(asNumberOrNull(row.coverage))} | ${formatPlainNumber(asNumberOrNull(row.spread))} | ${abstained} |`,
    );
  }
  lines.push('');

  lines.push('## Main arguments and strongest dissent');
  lines.push('');
  lines.push('Main arguments:');
  lines.push(...mdList(asArray(model.main_reasons)));
  lines.push('');
  lines.push(`Strongest dissent: ${asStringOrNull(model.strongest_dissent) ?? 'none recorded'}`);
  lines.push('');

  lines.push('## Constraints, assumptions, and unknowns');
  lines.push('');
  lines.push('Hard constraints:');
  const findings = asArray(model.hard_constraints);
  if (findings.length === 0) lines.push('- none recorded');
  for (const findingValue of findings) {
    const finding = asRecord(findingValue);
    lines.push(
      `- ${asString(finding.constraint_id)} on option ${asString(finding.option_id)}: ${asString(finding.result)} (checker: ${asString(finding.checker)})`,
    );
  }
  lines.push('');
  lines.push('Assumptions:');
  const assumptions = asArray(brief.assumptions);
  lines.push(...(assumptions.length > 0 ? mdList(assumptions) : ['- none recorded']));
  lines.push('');
  lines.push('Unknowns:');
  const unknowns = [...asArray(brief.unknowns), ...asArray(model.critical_unknowns)];
  lines.push(...(unknowns.length > 0 ? mdList(unknowns) : ['- none recorded']));
  lines.push('');

  lines.push('## Amendments and ratification');
  lines.push('');
  const amendments = asRecord(model.amendments);
  const describeAmendment = (value: unknown): string => {
    const amendment = asRecord(value);
    return `${asString(amendment.amendment_id)} by ${asString(amendment.proposing_seat_id)}: ${asString(amendment.statement)} (${asString(amendment.materiality)}, ${asString(amendment.disposition)})`;
  };
  lines.push('Accepted amendments:');
  const accepted = asArray(amendments.accepted);
  lines.push(
    ...(accepted.length > 0 ? accepted.map((a) => `- ${describeAmendment(a)}`) : ['- none']),
  );
  lines.push('');
  lines.push('Rejected amendments:');
  const rejected = asArray(amendments.rejected);
  lines.push(
    ...(rejected.length > 0 ? rejected.map((a) => `- ${describeAmendment(a)}`) : ['- none']),
  );
  lines.push('');
  const ratification = asRecord(model.ratification);
  lines.push(`Ratification status: ${asStringOrNull(ratification.status) ?? 'not applicable'}`);
  const support = ratification.resolution_support as Record<string, unknown> | null;
  if (support) {
    lines.push(
      `Resolution support (weighted counts, not a probability): support ${formatPlainNumber(asNumberOrNull(support.support))}, conditional support ${formatPlainNumber(asNumberOrNull(support.conditional_support))}, opposition ${formatPlainNumber(asNumberOrNull(support.opposition))}, abstention ${formatPlainNumber(asNumberOrNull(support.abstention))}, bound to resolution ${asString(support.resolution_sha256)}.`,
    );
  }
  lines.push('');

  lines.push('## Action proposals and authorization boundaries');
  lines.push('');
  const proposals = asArray(model.action_proposals);
  if (proposals.length === 0) lines.push('- none');
  for (const proposalValue of proposals) {
    const proposal = asRecord(proposalValue);
    lines.push(`### ${asString(proposal.action_id)}: ${asString(proposal.title)}`);
    lines.push('');
    lines.push(asString(proposal.description));
    lines.push('');
    lines.push(`Rationale: ${asString(proposal.rationale)}`);
    lines.push('Acceptance criteria:');
    lines.push(...mdList(asArray(proposal.acceptance_criteria)));
    const depends = asArray(proposal.depends_on_action_ids).map(asString);
    lines.push(`Depends on: ${depends.length > 0 ? depends.join(', ') : 'none'}`);
    lines.push(`Risk class: ${asString(proposal.risk_class)}`);
    lines.push(
      'Execution authorization: separate execution authorization is required before this proposal may be acted on.',
    );
    lines.push('');
  }
  lines.push(`> ${asString(model.authorization_notice)}`);
  lines.push('');

  lines.push('## Test, stop conditions, and review criteria');
  lines.push('');
  lines.push(
    `Cheapest informative test: ${asStringOrNull(model.cheapest_informative_test) ?? 'none recorded'}`,
  );
  lines.push('');
  lines.push('Stop conditions:');
  const stop = asArray(model.stop_criteria);
  lines.push(...(stop.length > 0 ? mdList(stop) : ['- none recorded']));
  lines.push('');
  lines.push('Outcome review criteria:');
  const review = asArray(model.review_criteria);
  lines.push(...(review.length > 0 ? mdList(review) : ['- none recorded']));
  lines.push('');

  pushSeatsMd(lines, model);
  pushProvenanceMd(lines, model);
  return `${lines.join('\n')}\n`;
}

function pushSeatsMd(lines: string[], model: Record<string, unknown>): void {
  lines.push('## Advisor detail');
  lines.push('');
  for (const seatValue of asArray(model.participating_seats)) {
    const seat = asRecord(seatValue);
    lines.push(
      `Participating seat: ${asString(seat.display_name)} (${asString(seat.seat_id)}), source qualification: ${qualificationText(seat.qualification)}`,
    );
  }
  lines.push('');
  for (const seatValue of asArray(model.seats)) {
    const seat = asRecord(seatValue);
    lines.push(`### ${asString(seat.display_name)}`);
    lines.push('');
    lines.push(asString(seat.label));
    lines.push('');
    lines.push(`Source qualification: ${qualificationText(seat.qualification)}`);
    lines.push(`Stance: ${asString(seat.stance)}`);
    lines.push(`Preferred option: ${asStringOrNull(seat.preferred_option_id) ?? 'none'}`);
    const abstained = asArray(seat.abstained_option_ids).map(asString);
    if (abstained.length > 0) {
      lines.push(`Abstained on: ${abstained.join(', ')}`);
    }
    lines.push('Decisive arguments:');
    lines.push(...mdList(asArray(seat.decisive_arguments)));
    lines.push(`Strongest objection: ${asString(seat.strongest_objection)}`);
    lines.push(`What would change my mind: ${asString(seat.change_my_mind)}`);
    const conditions = asArray(seat.conditions);
    if (conditions.length > 0) {
      lines.push('Conditions:');
      for (const conditionValue of conditions) {
        const condition = asRecord(conditionValue);
        lines.push(
          `- ${asString(condition.id)}: ${asString(condition.description)} (${asString(condition.kind)}, ${asString(condition.status)}${condition.blocking === true ? ', blocking' : ''})`,
        );
      }
    }
    const stance = asStringOrNull(seat.resolution_stance);
    if (stance !== null) lines.push(`Resolution stance: ${stance}`);
    lines.push('');
  }
}

function pushProvenanceMd(lines: string[], model: Record<string, unknown>): void {
  const provenance = asRecord(model.provenance);
  lines.push('## Source and provenance appendix');
  lines.push('');
  lines.push(asString(provenance.note));
  lines.push('');
  lines.push('| Evidence | Kind | Locator | SHA-256 |');
  lines.push('| --- | --- | --- | --- |');
  for (const entryValue of asArray(provenance.evidence_manifest)) {
    const entry = asRecord(entryValue);
    lines.push(
      `| ${asString(entry.evidence_id)} | ${asString(entry.source_kind)} | ${asString(entry.locator)} | ${asString(entry.sha256)} |`,
    );
  }
  lines.push('');
}

// --------------------------------------------------------- record JSON

export interface SiblingArtifact {
  format: string;
  filename: string | null;
  sha256: string | null;
  status: 'ready' | 'not_ready';
  missing_piece: string | null;
}

/**
 * The canonical record JSON: the full report model in canonical
 * serialized form, plus the sibling artifact index binding the
 * exact bytes of the Markdown and print HTML. The caller supplies
 * the complete sibling list, including the pdf entry: its hash and
 * filename are bound when the PDF was rendered in the same create
 * call (or resolved from the journal on the read path); otherwise
 * the entry names the ready pdf format with no hash bound in this
 * record.
 */
export function renderRecordJson(
  model: Record<string, unknown>,
  siblings: SiblingArtifact[],
): string {
  const record = {
    ...model,
    sibling_artifacts: [...siblings],
  };
  return `${canonicalStringify(record)}\n`;
}

// ------------------------------------------------------------- service

export const EXPORT_JOURNAL_KIND = 'report_export';

export interface CouncilExportRecord {
  export_id: string;
  request_id: string;
  session_id: string;
  format: ReportFormat;
  filename: string;
  media_type: string;
  verdict_revision: number;
  verdict_content_sha256: string;
  report_revision_id: string;
  artifact_sha256: string;
  byte_size: number;
  redacted: boolean;
  redaction_profile_id: string | null;
  exporter_subject: string;
  via: string;
  visibility: 'private' | 'company';
  deliverable_id: string | null;
  created_at: string;
}

export interface CouncilExportResult {
  report_revision_id: string;
  session_id: string;
  verdict_revision: number;
  verdict_content_sha256: string;
  artifacts: Array<{
    export_id: string;
    format: ReportFormat;
    filename: string;
    media_type: string;
    sha256: string;
    byte_size: number;
    redacted: boolean;
    replayed: boolean;
    deliverable_id: string | null;
    download_url: string;
  }>;
}

export interface ReportDownloadsDeps {
  repositories: CouncilRepositories;
  store: CouncilStore;
}

function exportIdFor(requestId: string, format: ReportFormat): string {
  return `export-${canonicalHash({ request_id: requestId, format }).slice(0, 32)}`;
}

function appendExportJournalRecord(
  db: Database.Database,
  scope: { tenant_id: string; company_id: string },
  record: CouncilExportRecord,
  actorSubject: string,
): void {
  const payload: Record<string, unknown> = {
    kind: EXPORT_JOURNAL_KIND,
    export_id: record.export_id,
    request_id: record.request_id,
    session_id: record.session_id,
    format: record.format,
    filename: record.filename,
    verdict_revision: record.verdict_revision,
    verdict_content_sha256: record.verdict_content_sha256,
    report_revision_id: record.report_revision_id,
    artifact_sha256: record.artifact_sha256,
    exporter_subject: record.exporter_subject,
    via: record.via,
    actor: actorSubject === record.exporter_subject ? 'owner' : 'worker',
    redacted: record.redacted,
    redaction_profile_id: record.redaction_profile_id,
    deliverable_id: record.deliverable_id,
    created_at: record.created_at,
  };
  const last = db
    .prepare(
      `SELECT sequence, event_hash FROM council_events
        WHERE tenant_id = ? AND company_id = ? AND session_id = ?
        ORDER BY sequence DESC LIMIT 1`,
    )
    .get(scope.tenant_id, scope.company_id, record.session_id) as
    | { sequence: number; event_hash: string }
    | undefined;
  const sequence = (last?.sequence ?? 0) + 1;
  const prevHash = last?.event_hash ?? '';
  const payloadJson = canonicalStringify(payload);
  const eventHash = canonicalHash({
    tenant_id: scope.tenant_id,
    company_id: scope.company_id,
    session_id: record.session_id,
    sequence,
    type: 'operation_completed',
    payload_json: payloadJson,
    prev_hash: prevHash,
    created_at: record.created_at,
  });
  db.prepare(
    `INSERT INTO council_events
       (tenant_id, company_id, session_id, sequence, id, type, from_state, to_state,
        actor_subject, payload_json, prev_hash, event_hash, created_at)
     VALUES (?, ?, ?, ?, ?, 'operation_completed', NULL, NULL, ?, ?, ?, ?, ?)`,
  ).run(
    scope.tenant_id,
    scope.company_id,
    record.session_id,
    sequence,
    randomUUID(),
    actorSubject,
    payloadJson,
    prevHash,
    eventHash,
    record.created_at,
  );
}

/** All export journal records for a session, oldest first. */
export function listExportRecords(
  deps: ReportDownloadsDeps,
  envelope: CouncilEnvelope,
  sessionId: string,
): CouncilExportRecord[] {
  const session = deps.repositories.getSession(envelope, sessionId);
  const visibility = session?.spec.visibility ?? 'private';
  return deps.repositories
    .listEvents(envelope, sessionId, 0)
    .filter(
      (event) =>
        event.type === 'operation_completed' &&
        (event.payload as Record<string, unknown>).kind === EXPORT_JOURNAL_KIND,
    )
    .map((event) => {
      const payload = event.payload as Record<string, unknown>;
      const format = payload.format as ReportFormat;
      return {
        export_id: payload.export_id as string,
        request_id: payload.request_id as string,
        session_id: sessionId,
        format,
        filename: payload.filename as string,
        media_type: REPORT_FORMAT_REGISTRY[format].media_type,
        verdict_revision: payload.verdict_revision as number,
        verdict_content_sha256: payload.verdict_content_sha256 as string,
        report_revision_id: payload.report_revision_id as string,
        artifact_sha256: payload.artifact_sha256 as string,
        byte_size: 0,
        redacted: payload.redacted === true,
        redaction_profile_id: (payload.redaction_profile_id as string | null) ?? null,
        exporter_subject: payload.exporter_subject as string,
        via: payload.via as string,
        visibility,
        deliverable_id: (payload.deliverable_id as string | null) ?? null,
        created_at: payload.created_at as string,
      };
    });
}

function assertSessionAlive(deps: ReportDownloadsDeps, sessionId: string, tenantId: string): void {
  if (deps.repositories.isDeleted(tenantId, sessionId)) {
    throw new CouncilApiError(
      'EXPORT_SESSION_DELETED',
      `Session ${sessionId} has been deleted; its report artifacts are no longer downloadable.`,
      { status: 410, action: 'none' },
    );
  }
}

function loadExportableSession(
  deps: ReportDownloadsDeps,
  envelope: CouncilEnvelope,
  sessionId: string,
): { session: CouncilStoredSession; verdict: Verdict; cards: CouncilCard[] } {
  assertSessionAlive(deps, sessionId, envelope.tenant_id);
  const session = deps.repositories.getSession(envelope, sessionId);
  if (!session) {
    throw new CouncilApiError(
      'PERSISTENCE_SESSION_NOT_FOUND',
      `No council session ${sessionId} exists in this tenant and company scope.`,
      { status: 404, action: 'check_session_id' },
    );
  }
  const verdict = deps.repositories.getVerdict(envelope, sessionId);
  if (!verdict) {
    throw new CouncilApiError(
      'EXPORT_VERDICT_INCOMPLETE',
      `Session ${sessionId} has no committed verdict; there is no report to export.`,
      { status: 409, action: 'wait_for_verdict' },
    );
  }
  if (verdict.validation_status !== 'valid') {
    throw new CouncilApiError(
      'EXPORT_VERDICT_INVALID',
      `The committed verdict for session ${sessionId} carries validation status '${verdict.validation_status}', not 'valid'. Only a valid committed verdict may be exported; no partial output was produced.`,
      { status: 409, action: 'check_verdict' },
    );
  }
  const cards = deps.repositories.listCards(envelope, sessionId);
  if (verdict.result_kind === 'scored' && cards.length === 0) {
    throw new CouncilApiError(
      'EXPORT_VERDICT_INCOMPLETE',
      `Session ${sessionId} has a scored verdict but no committed final cards; the report cannot be built without them.`,
      { status: 409, action: 'check_verdict' },
    );
  }
  return { session, verdict, cards };
}

function parentTaskIdFor(deps: ReportDownloadsDeps, envelope: CouncilEnvelope, sessionId: string): string | null {
  const row = deps.store
    .handle()
    .prepare(
      `SELECT parent_session_task_id FROM council_task_links
        WHERE tenant_id = ? AND company_id = ? AND session_id = ?
          AND parent_session_task_id IS NOT NULL LIMIT 1`,
    )
    .get(envelope.tenant_id, envelope.company_id, sessionId) as
    | { parent_session_task_id: string }
    | undefined;
  return row ? row.parent_session_task_id : null;
}

/**
 * Render the pdf artifact from the model's print HTML through the
 * composed Chromium renderer, mapping the renderer's typed
 * refusals onto the export error shape: capability absent is
 * EXPORT_FORMAT_NOT_READY naming the missing piece; a render or
 * validation failure is EXPORT_RENDER_FAILED. Either way no bytes
 * are produced and nothing is journaled.
 */
async function renderPdfArtifact(printHtml: string): Promise<Buffer> {
  try {
    const rendered = await renderCouncilReportPdf(printHtml);
    return rendered.bytes;
  } catch (error) {
    if (error instanceof ReportPdfError && error.code === 'EXPORT_FORMAT_NOT_READY') {
      throw new CouncilApiError(
        'EXPORT_FORMAT_NOT_READY',
        `The pdf deliverable cannot be rendered in this environment: ${error.missingPiece ?? error.message}. No bytes were produced and nothing was journaled.`,
        { status: 501, action: 'choose_another_format' },
      );
    }
    if (error instanceof ReportPdfError) {
      throw new CouncilApiError(
        'EXPORT_RENDER_FAILED',
        `The pdf deliverable failed to render: ${error.message}. No bytes were produced and nothing was journaled.`,
        { status: 502, action: 'retry_export' },
      );
    }
    throw error;
  }
}

/** The pdf sibling entry for a record JSON: hash-bound when the
 * PDF bytes exist in this flow, an unbound ready entry otherwise. */
function pdfSibling(args: {
  session_id: string;
  verdict_revision: number;
  redacted: boolean;
  filename: string | null;
  sha256: string | null;
}): SiblingArtifact {
  return {
    format: 'pdf',
    filename:
      args.sha256 !== null
        ? (args.filename ??
          reportFilename({
            session_id: args.session_id,
            verdict_revision: args.verdict_revision,
            format: 'pdf',
            redacted: args.redacted,
          }))
        : null,
    sha256: args.sha256,
    status: 'ready',
    missing_piece: null,
  };
}

/**
 * Create an export: validate, render every ready format from the one
 * model, journal one record per requested ready artifact, register
 * each through the CC evidence path when a parent task exists, and
 * return the artifact descriptors. A request naming a not-ready
 * format refuses EXPORT_FORMAT_NOT_READY before any rendering.
 */
export async function createCouncilExport(
  deps: ReportDownloadsDeps,
  envelope: CouncilEnvelope,
  input: {
    session_id: string;
    formats: ReportFormat[];
    redaction?: RedactionProfile | null;
    request_id: string;
    exporter_subject: string;
    via: string;
    exported_at?: string;
  },
): Promise<CouncilExportResult> {
  for (const format of input.formats) {
    const descriptor = REPORT_FORMAT_REGISTRY[format];
    if (descriptor.status === 'not_ready') {
      throw new CouncilApiError(
        'EXPORT_FORMAT_NOT_READY',
        `The ${format} deliverable is registered but not ready: ${descriptor.missing_piece}. No bytes were produced and nothing was journaled.`,
        { status: 501, action: 'choose_another_format' },
      );
    }
  }
  const { session, verdict, cards } = loadExportableSession(deps, envelope, input.session_id);
  const exportedAt = input.exported_at ?? new Date().toISOString();
  const redaction = input.redaction ?? null;
  const model = buildReportModel({
    verdict,
    brief: session.brief,
    final_cards: cards,
    report_date: exportedAt.slice(0, 10),
    session_mode: session.spec.mode,
    redaction,
  });
  const reportRevision = String(model.report_revision_id);
  const redacted = redaction !== null;

  const markdown = renderMarkdown(model);
  const printHtml = renderPrintHtml(model);
  // The pdf artifact renders from the same print HTML through the
  // composed Chromium renderer, but only when the pdf format was
  // requested: a record JSON created without pdf binds an unbound
  // pdf sibling entry rather than paying a render it does not need.
  const pdfBytes = input.formats.includes('pdf')
    ? await renderPdfArtifact(printHtml)
    : null;
  const siblings: SiblingArtifact[] = [
    {
      format: 'markdown',
      filename: reportFilename({
        session_id: input.session_id,
        verdict_revision: verdict.verdict_revision,
        format: 'markdown',
        redacted,
      }),
      sha256: sha256OfText(markdown),
      status: 'ready',
      missing_piece: null,
    },
    {
      format: 'print_html',
      filename: reportFilename({
        session_id: input.session_id,
        verdict_revision: verdict.verdict_revision,
        format: 'print_html',
        redacted,
      }),
      sha256: sha256OfText(printHtml),
      status: 'ready',
      missing_piece: null,
    },
    pdfSibling({
      session_id: input.session_id,
      verdict_revision: verdict.verdict_revision,
      redacted,
      filename: null,
      sha256: pdfBytes !== null ? sha256Hex(pdfBytes) : null,
    }),
  ];
  const bytesByFormat = new Map<ReportFormat, string | Buffer>([
    ['markdown', markdown],
    ['print_html', printHtml],
  ]);
  if (pdfBytes !== null) bytesByFormat.set('pdf', pdfBytes);
  if (input.formats.includes('record_json')) {
    bytesByFormat.set('record_json', renderRecordJson(model, siblings));
  }

  const rendered = input.formats.map((format) => {
    const bytes = bytesByFormat.get(format);
    if (bytes === undefined) {
      throw new CouncilApiError(
        'EXPORT_REQUEST_INVALID',
        `Format ${format} was requested but not rendered; the export was refused.`,
        { status: 400, action: 'fix_request' },
      );
    }
    return {
      format,
      bytes,
      filename: reportFilename({
        session_id: input.session_id,
        verdict_revision: verdict.verdict_revision,
        format,
        redacted,
      }),
      sha256: sha256OfArtifact(bytes),
      byte_size: byteSizeOfArtifact(bytes),
    };
  });
  if (redaction !== null) {
    // The text artifacts carry the redaction assertion directly.
    // The pdf artifact inherits the redacted model: it renders from
    // the redacted print HTML, whose bytes are asserted here.
    assertRedactionComplete(
      rendered
        .filter((a) => typeof a.bytes === 'string')
        .map((a) => ({ filename: a.filename, bytes: a.bytes as string })),
      redaction,
    );
  }

  // Deletion race recheck (T059): after rendering, before exposure.
  assertSessionAlive(deps, input.session_id, envelope.tenant_id);

  const existing = listExportRecords(deps, envelope, input.session_id);
  const parentTaskId = parentTaskIdFor(deps, envelope, input.session_id);
  const artifacts: CouncilExportResult['artifacts'] = [];
  for (const artifact of rendered) {
    const exportId = exportIdFor(input.request_id, artifact.format);
    const prior = existing.find((record) => record.export_id === exportId);
    if (prior) {
      if (
        prior.artifact_sha256 !== artifact.sha256 ||
        prior.verdict_content_sha256 !== verdict.content_sha256 ||
        prior.verdict_revision !== verdict.verdict_revision
      ) {
        throw new CouncilApiError(
          'EXPORT_JOURNAL_MISMATCH',
          `Request ${input.request_id} was already journaled for format ${artifact.format} with different content; refusing to attach this export to that record.`,
          { status: 409, action: 'use_a_new_request' },
        );
      }
      artifacts.push({
        export_id: exportId,
        format: artifact.format,
        filename: prior.filename,
        media_type: REPORT_FORMAT_REGISTRY[artifact.format].media_type,
        sha256: artifact.sha256,
        byte_size: artifact.byte_size,
        redacted,
        replayed: true,
        deliverable_id: prior.deliverable_id,
        download_url: `/api/council/exports/${exportId}`,
      });
      continue;
    }
    let deliverableId: string | null = null;
    if (parentTaskId !== null) {
      deliverableId = registerDeliverable(parentTaskId, {
        path: artifact.filename,
        mime: REPORT_FORMAT_REGISTRY[artifact.format].media_type,
        bytes: artifact.byte_size,
        sha256: artifact.sha256,
        title: `Council decision report: session ${input.session_id}, verdict revision ${verdict.verdict_revision} (${artifact.format})`,
      });
    }
    const record: CouncilExportRecord = {
      export_id: exportId,
      request_id: input.request_id,
      session_id: input.session_id,
      format: artifact.format,
      filename: artifact.filename,
      media_type: REPORT_FORMAT_REGISTRY[artifact.format].media_type,
      verdict_revision: verdict.verdict_revision,
      verdict_content_sha256: verdict.content_sha256,
      report_revision_id: reportRevision,
      artifact_sha256: artifact.sha256,
      byte_size: artifact.byte_size,
      redacted,
      redaction_profile_id: redaction?.profile_id ?? null,
      exporter_subject: input.exporter_subject,
      via: input.via,
      visibility: session.spec.visibility,
      deliverable_id: deliverableId,
      created_at: exportedAt,
    };
    appendExportJournalRecord(
      deps.store.handle(),
      { tenant_id: envelope.tenant_id, company_id: envelope.company_id },
      record,
      input.exporter_subject,
    );
    artifacts.push({
      export_id: exportId,
      format: artifact.format,
      filename: artifact.filename,
      media_type: record.media_type,
      sha256: artifact.sha256,
      byte_size: record.byte_size,
      redacted,
      replayed: false,
      deliverable_id: deliverableId,
      download_url: `/api/council/exports/${exportId}`,
    });
  }
  return {
    report_revision_id: reportRevision,
    session_id: input.session_id,
    verdict_revision: verdict.verdict_revision,
    verdict_content_sha256: verdict.content_sha256,
    artifacts,
  };
}

/**
 * Find one export record by export ID for a session the caller can
 * already read, or null. Export IDs are unguessable hashes, but the
 * read path still requires the session read authorization first.
 */
export function findExportRecord(
  deps: ReportDownloadsDeps,
  envelope: CouncilEnvelope,
  sessionId: string,
  exportId: string,
): CouncilExportRecord | null {
  return listExportRecords(deps, envelope, sessionId).find((r) => r.export_id === exportId) ?? null;
}

/** Locate the session owning an export ID within the caller's scope. */
export function findExportSession(
  deps: ReportDownloadsDeps,
  scope: { tenant_id: string; company_id: string },
  exportId: string,
): string | null {
  const row = deps.store
    .handle()
    .prepare(
      `SELECT session_id FROM council_events
        WHERE tenant_id = ? AND company_id = ? AND type = 'operation_completed'
          AND json_extract(payload_json, '$.kind') = ? AND json_extract(payload_json, '$.export_id') = ?
        LIMIT 1`,
    )
    .get(scope.tenant_id, scope.company_id, EXPORT_JOURNAL_KIND, exportId) as
    | { session_id: string }
    | undefined;
  return row?.session_id ?? null;
}

export interface CouncilExportDownload {
  record: CouncilExportRecord;
  bytes: string | Buffer;
  headers: Record<string, string>;
}

/**
 * Read one registered export: re-render from committed state,
 * verify the bytes hash to the journaled artifact hash, and build
 * the Section 24.4 download headers. Refuses deleted sessions
 * (T059) and hash drift; never returns unrecorded bytes. The pdf
 * format re-renders through the composed Chromium renderer; its
 * byte-pinned output verifies against the journaled hash exactly
 * like the deterministic text formats.
 */
export async function readCouncilExport(
  deps: ReportDownloadsDeps,
  envelope: CouncilEnvelope,
  sessionId: string,
  exportId: string,
): Promise<CouncilExportDownload> {
  assertSessionAlive(deps, sessionId, envelope.tenant_id);
  const record = findExportRecord(deps, envelope, sessionId, exportId);
  if (!record) {
    throw new CouncilApiError(
      'EXPORT_DELIVERABLE_NOT_FOUND',
      `Export ${exportId} is not a registered deliverable for session ${sessionId}.`,
      { status: 404, action: 'check_export_id' },
    );
  }
  const { session, verdict, cards } = loadExportableSession(deps, envelope, sessionId);
  if (
    record.verdict_content_sha256 !== verdict.content_sha256 ||
    record.verdict_revision !== verdict.verdict_revision
  ) {
    throw new CouncilApiError(
      'EXPORT_JOURNAL_MISMATCH',
      `Export ${exportId} binds verdict revision ${record.verdict_revision} (${record.verdict_content_sha256}), but the session's committed verdict is now revision ${verdict.verdict_revision}. The recorded bytes are not served against a different verdict.`,
      { status: 409, action: 'create_a_new_export' },
    );
  }
  if (record.redacted) {
    // Redaction replacement literals are never persisted (they may
    // carry the sensitive strings themselves), so a redacted
    // artifact's exact bytes cannot be re-derived on a later read.
    // The CC route surface therefore does not accept redaction
    // profiles yet (see build report); any redacted record refuses
    // here honestly instead of serving unredacted bytes under a
    // redacted identity.
    throw new CouncilApiError(
      'EXPORT_REQUEST_INVALID',
      `Export ${exportId} is a redacted artifact. Redaction replacement literals are never persisted, so the exact recorded bytes cannot be re-derived; create a new export with the redaction profile to download it.`,
      { status: 409, action: 'create_a_new_export' },
    );
  }
  const model = buildReportModel({
    verdict,
    brief: session.brief,
    final_cards: cards,
    report_date: record.created_at.slice(0, 10),
    session_mode: session.spec.mode,
    redaction: null,
  });
  const markdown = renderMarkdown(model);
  const printHtml = renderPrintHtml(model);
  // A record JSON binds its pdf sibling from the journal: the pdf
  // artifact created under the same request carries the hash this
  // record was created with. Without one, the entry stays unbound.
  const pdfRecord =
    listExportRecords(deps, envelope, sessionId).find(
      (r) => r.format === 'pdf' && r.request_id === record.request_id,
    ) ?? null;
  const siblings: SiblingArtifact[] = [
    {
      format: 'markdown',
      filename: reportFilename({
        session_id: sessionId,
        verdict_revision: verdict.verdict_revision,
        format: 'markdown',
        redacted: false,
      }),
      sha256: sha256OfText(markdown),
      status: 'ready',
      missing_piece: null,
    },
    {
      format: 'print_html',
      filename: reportFilename({
        session_id: sessionId,
        verdict_revision: verdict.verdict_revision,
        format: 'print_html',
        redacted: false,
      }),
      sha256: sha256OfText(printHtml),
      status: 'ready',
      missing_piece: null,
    },
    pdfSibling({
      session_id: sessionId,
      verdict_revision: verdict.verdict_revision,
      redacted: false,
      filename: pdfRecord?.filename ?? null,
      sha256: pdfRecord?.artifact_sha256 ?? null,
    }),
  ];
  const bytes: string | Buffer =
    record.format === 'markdown'
      ? markdown
      : record.format === 'print_html'
        ? printHtml
        : record.format === 'pdf'
          ? await renderPdfArtifact(printHtml)
          : renderRecordJson(model, siblings);
  const digest = sha256OfArtifact(bytes);
  if (digest !== record.artifact_sha256) {
    throw new CouncilApiError(
      'EXPORT_JOURNAL_MISMATCH',
      `Export ${exportId} re-rendered to hash ${digest}, which does not match the journaled artifact hash ${record.artifact_sha256}. The bytes were not served.`,
      { status: 500, action: 'contact_support' },
    );
  }
  const cacheControl =
    record.visibility === 'private' ? 'private, no-store' : 'no-cache';
  return {
    record: { ...record, byte_size: byteSizeOfArtifact(bytes) },
    bytes,
    headers: {
      'Content-Type': record.media_type,
      'Content-Disposition': `attachment; filename="${record.filename}"`,
      'Cache-Control': cacheControl,
      'X-Council-Export-Sha256': record.artifact_sha256,
      'X-Council-Verdict-Sha256': record.verdict_content_sha256,
    },
  };
}
