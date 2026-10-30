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
  CONSULT_NO_DEBATE_NOTE,
  formatCoverage,
  formatDisplayScore,
  formatScore,
  renderPrintHtml,
} from './report-print-template';
import { loadReportCoverAssets } from './report-cover-assets';
import {
  dedupeExact,
  readConsultVerdict,
  readScoredVerdict,
  summarizeConditions,
  type ConditionSummary,
} from './report-reading';
import {
  buildCapabilityReportSection,
  type InstallationCapabilitySnapshot,
  type PlanProposalReference,
} from './capability-snapshot';

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
  /**
   * The installation capability snapshot already validated and bound to
   * this session's exact installation by the store/service. Absent means
   * "not provided": the report then says the installed-capability match is
   * unverified and claims no inventory.
   */
  capability_snapshot?: InstallationCapabilitySnapshot | null;
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
      department_id: proposal.department_id,
      assigned_agent_id: proposal.assigned_agent_id,
      sop_id: proposal.sop_id,
      persona_id: proposal.persona_id,
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
    // CTR-168: a consult has no advisor rounds, so the record says so in
    // words and carries no debate object at all. The explicit note keeps
    // the record JSON export from reading like a debate with zero rounds.
    debate: null as null,
    debate_note: CONSULT_NO_DEBATE_NOTE,
  };
}

const STANCE_TEXT: Readonly<Record<string, string>> = {
  support: 'Supports',
  conditional: 'Supports with conditions',
  oppose: 'Opposes',
  abstain: 'Abstains',
};

function optionDisplayText(optionId: string | null, brief: DecisionBrief): string {
  if (optionId === null) return 'No stated preference';
  return brief.options.find((option) => option.id === optionId)?.label ?? optionId;
}

/**
 * The debate section: the ACTUAL saved advisor rounds, what changed between
 * them, whether the council split, and the explicit absence of a chair stop
 * note. Nothing here is inferred. CC has no chair-note field, so the stop
 * record says so instead of inventing a reason. A consult records one seat
 * and no rounds, so it reports zero rounds and no invented nine-seat debate.
 */
function buildDebateSection(
  cards: readonly CouncilCard[],
  brief: DecisionBrief,
  sessionMode: string | null,
): Record<string, unknown> {
  const byRound = new Map<number, AdvisorCard[]>();
  for (const card of cards) {
    if (card.card_kind !== 'advisor') continue;
    const seats = byRound.get(card.round) ?? [];
    seats.push(card);
    byRound.set(card.round, seats);
  }
  const rounds = [...byRound.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([round, seats]) => ({
      round,
      cards: [...seats].sort(
        (a, b) => SEAT_IDS.indexOf(a.seat_id) - SEAT_IDS.indexOf(b.seat_id),
      ),
    }));
  const highestRound = rounds.length > 0 ? rounds[rounds.length - 1].round : null;
  const notes: string[] = [];
  if (rounds.length === 0) {
    notes.push(
      'No advisor cards are saved in this record, so the debate cannot be reconstructed.',
    );
  } else if (rounds.length === 1) {
    notes.push(
      `Only one round of advisor cards is saved in this record (round ${rounds[0].round}), so a before-and-after comparison is not possible.`,
    );
  } else {
    notes.push(`${rounds.length} rounds of advisor cards are saved in this record.`);
  }
  if (sessionMode === 'consult') {
    notes.push(
      'A consultation records one seat and no advisor rounds; no nine-seat debate is claimed.',
    );
  }
  notes.push(
    'The saved record contains no chair note explaining a stop decision; only the cards above are recorded.',
  );

  const changes: Array<Record<string, unknown>> = [];
  for (let index = 1; index < rounds.length; index += 1) {
    const previous = new Map(
      rounds[index - 1].cards.map((card) => [card.seat_id, card]),
    );
    for (const card of rounds[index].cards) {
      const before = previous.get(card.seat_id);
      if (before === undefined) continue;
      const changedOption =
        before.preferred_option_id !== card.preferred_option_id;
      const changedStance = before.stance !== card.stance;
      if (!changedOption && !changedStance) continue;
      changes.push({
        round: rounds[index].round,
        seat_id: card.seat_id,
        display_name: seatDisplayName(card.seat_id),
        from_option_label: optionDisplayText(before.preferred_option_id, brief),
        to_option_label: optionDisplayText(card.preferred_option_id, brief),
        from_stance_text: STANCE_TEXT[before.stance] ?? before.stance,
        to_stance_text: STANCE_TEXT[card.stance] ?? card.stance,
        changed_option: changedOption,
        changed_stance: changedStance,
      });
    }
  }

  const latestBySeat = new Map<string, AdvisorCard>();
  for (const round of rounds) {
    for (const card of round.cards) latestBySeat.set(card.seat_id, card);
  }
  const latest = [...latestBySeat.values()].sort(
    (a, b) => SEAT_IDS.indexOf(a.seat_id) - SEAT_IDS.indexOf(b.seat_id),
  );
  const byOption = new Map<string, string[]>();
  const abstainedNames: string[] = [];
  for (const card of latest) {
    if (card.stance === 'abstain') abstainedNames.push(seatDisplayName(card.seat_id));
    const key = card.preferred_option_id ?? '';
    const names = byOption.get(key) ?? [];
    names.push(seatDisplayName(card.seat_id));
    byOption.set(key, names);
  }
  const positions = [...byOption.entries()]
    .sort((a, b) => {
      if (a[0] === '') return 1;
      if (b[0] === '') return -1;
      return a[0].localeCompare(b[0]);
    })
    .map(([optionId, names]) => ({
      option_id: optionId === '' ? null : optionId,
      option_label:
        optionId === '' ? 'No stated preference' : optionDisplayText(optionId, brief),
      seat_names: names,
    }));
  const split =
    positions.filter((entry) => entry.option_id !== null).length > 1;
  if (rounds.length > 0) {
    notes.push(
      split
        ? 'The council split on which option to prefer; the groups are listed below.'
        : 'The council did not split on which option to prefer; the disagreement is in the reasoning and objections each advisor recorded.',
    );
  }

  const roundSupport = rounds.map((entry, index) => {
    const counts: Record<'support' | 'conditional' | 'oppose' | 'abstain', number> = {
      support: 0,
      conditional: 0,
      oppose: 0,
      abstain: 0,
    };
    for (const card of entry.cards) counts[card.stance] += 1;
    const previous = index > 0 ? rounds[index - 1] : null;
    const identicalToPrevious =
      previous !== null &&
      previous.cards.length === entry.cards.length &&
      entry.cards.every((card) => {
        const before = previous.cards.find(
          (candidate) => candidate.seat_id === card.seat_id,
        );
        return (
          before !== undefined &&
          before.stance === card.stance &&
          before.preferred_option_id === card.preferred_option_id
        );
      });
    return {
      round: entry.round,
      support: counts.support,
      conditional: counts.conditional,
      oppose: counts.oppose,
      abstain: counts.abstain,
      identical_to_previous: identicalToPrevious,
    };
  });

  return {
    rounds_saved: rounds.length,
    highest_round: highestRound,
    session_mode: sessionMode,
    source: 'saved_advisor_cards_only',
    rounds: rounds.map((entry) => ({
      round: entry.round,
      seats: entry.cards.map((card) => ({
        seat_id: card.seat_id,
        display_name: seatDisplayName(card.seat_id),
        stance: card.stance,
        stance_text: STANCE_TEXT[card.stance] ?? card.stance,
        preferred_option_id: card.preferred_option_id,
        preferred_option_label: optionDisplayText(card.preferred_option_id, brief),
      })),
    })),
    round_support: roundSupport,
    condensed_note:
      rounds.length > 1 && changes.length === 0
        ? 'No advisor changed position between the saved rounds, so the earlier rounds repeat the same positions. Read the final positions below; the earlier rounds add no new stance.'
        : null,
    changes,
    positions,
    split: rounds.length > 0 ? split : null,
    abstained_names: abstainedNames,
    stop_record: {
      recorded: false,
      note: 'The saved record contains no chair note explaining a stop decision; no stop reason is invented.',
    },
    notes,
  };
}


export function buildReportModel(input: ReportModelInput): Record<string, unknown> {
  const { verdict, brief, final_cards } = input;
  const packVersions = [...new Set(final_cards.map((card) => card.pack_version))].sort();
  const base =
    verdict.result_kind === 'scored' ? scoredModel(input, verdict) : consultModel(input, verdict);
  const advisorCards = final_cards.filter(
    (card): card is AdvisorCard => card.card_kind === 'advisor' && card.round === 2,
  );
  const conditions: ConditionSummary = summarizeConditions({
    prerequisites: verdict.result_kind === 'scored' ? verdict.prerequisites : [],
    hardFindings: verdict.result_kind === 'scored' ? verdict.hard_constraint_findings : [],
    cards: advisorCards,
  });
  const reading =
    verdict.result_kind === 'consult'
      ? readConsultVerdict({
          seat_display_name: seatDisplayName(verdict.consult_card.seat_id),
        })
      : readScoredVerdict({
          label: verdict.label,
          recommended_option_label: (base.verdict_block as Record<string, unknown>)
            .recommended_option_label as string | null,
          conditions,
          recommended_option_id: verdict.recommended_option_id,
          hard_findings: verdict.hard_constraint_findings,
          ratification_status: verdict.ratification_status,
        });
  const unknowns = dedupeExact([
    ...brief.unknowns.map((unknown) => unknown.statement),
    ...((base.critical_unknowns as string[] | undefined) ?? []),
  ]);
  const planProposals: PlanProposalReference[] =
    verdict.result_kind === 'scored'
      ? verdict.action_proposals.map((proposal) => ({
          action_id: proposal.action_id,
          title: proposal.title,
          description: proposal.description,
          department_id: proposal.department_id,
          assigned_agent_id: proposal.assigned_agent_id,
          sop_id: proposal.sop_id,
          persona_id: proposal.persona_id,
        }))
      : [];
  const safeTools = buildCapabilityReportSection(
    input.capability_snapshot ?? null,
    planProposals,
  );
  const readinessReasons: string[] = [...reading.blocked_reasons];
  if (verdict.result_kind === 'consult') {
    readinessReasons.push(
      'One seat answered; a consultation carries no score and no plan.',
    );
  } else {
    readinessReasons.push(`Recorded verdict label: ${verdict.label}.`);
    readinessReasons.push(
      `${conditions.total} condition(s) recorded; ${conditions.blocking_open} blocking and open.`,
    );
    readinessReasons.push(
      `Ratification status: ${verdict.ratification_status}.`,
    );
    readinessReasons.push(
      `${unknowns.recorded} unknown(s) recorded; ${unknowns.distinct} distinct.`,
    );
  }
  const conditionsDisplay =
    conditions.total === 0
      ? 'none recorded'
      : `${conditions.total} recorded, ${conditions.blocking_open} blocking and open`;
  const unknownsDisplay =
    unknowns.recorded === 0
      ? 'none recorded'
      : `${unknowns.recorded} recorded, ${unknowns.distinct} distinct`;
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
    summary: {
      label_plain: reading.label_plain,
      decision: reading.decision,
      reading: reading.reading,
      readiness_headline: reading.readiness_headline,
      evidence_strength:
        (base.verdict_block as Record<string, unknown>).evidence_strength ?? null,
      conditions_display: conditionsDisplay,
      unknowns_display: unknownsDisplay,
    },
    readiness: {
      status: reading.readiness_status,
      headline: reading.readiness_headline,
      reasons: readinessReasons,
    },
    question_and_context: {
      question: brief.question,
      facts: brief.facts.map((fact) => ({
        id: fact.id,
        statement: fact.statement,
        evidence_ids: [...fact.evidence_ids],
      })),
      assumptions: brief.assumptions.map((fact) => fact.statement),
      unknowns: {
        recorded: unknowns.recorded,
        distinct: unknowns.distinct,
        collapsed: unknowns.collapsed,
        items: unknowns.items,
        note: unknowns.note,
      },
      critical_domains: brief.critical_domains.map((domain) => ({
        domain: domain.domain,
        status: domain.status,
        unresolved_questions: [...domain.unresolved_questions],
      })),
    },
    conditions_summary: conditions,
    how_to_use: [
      'Start with the decision, the readiness line, and the plan. Part 2 holds the full member record.',
      'A recorded condition is a prerequisite, not a formality. A blocking condition that is open means do not act yet.',
      'An unrecorded value prints as "not recorded". It is never filled in, estimated, or upgraded.',
      'This report is advisory. Approving a plan and executing it are separate authorizations.',
    ],
    your_tools: safeTools,
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
    debate: buildDebateSection(final_cards, brief, input.session_mode),
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

  // CTR-163: the same reader projection the print/PDF renderer uses.
  const summary = asRecord(model.summary);
  const readiness = asRecord(model.readiness);
  const question = asRecord(model.question_and_context);
  lines.push('## What this means');
  lines.push('');
  lines.push(`Decision: ${asString(summary.decision) || 'not recorded'}`);
  lines.push(`Readiness: ${asString(summary.readiness_headline) || 'not recorded'}`);
  lines.push(`Evidence strength: ${asString(summary.evidence_strength) || 'not recorded'}`);
  lines.push(`Conditions: ${asString(summary.conditions_display) || 'none recorded'}`);
  lines.push(`Unknowns: ${asString(summary.unknowns_display) || 'none recorded'}`);
  lines.push('');
  lines.push(asString(summary.reading) || 'No reading sentence was recorded.');
  lines.push('');
  for (const reason of asArray(readiness.reasons)) {
    lines.push(`- ${asString(reason)}`);
  }
  lines.push('');
  lines.push('## The question and what was recorded');
  lines.push('');
  lines.push(`Question: ${asString(question.question) || asString(model.decision_title)}`);
  lines.push('');
  lines.push('Confirmed facts:');
  const facts = asArray(question.facts);
  lines.push(
    ...(facts.length > 0
      ? facts.map((factValue) => `- ${asString(asRecord(factValue).statement)}`)
      : ['- none recorded']),
  );
  lines.push('');
  lines.push('Assumptions:');
  lines.push(...(asArray(question.assumptions).length > 0 ? mdList(asArray(question.assumptions)) : ['- none recorded']));
  lines.push('');
  const unknownsRecord = asRecord(question.unknowns);
  lines.push('Unknowns:');
  lines.push(
    `- ${asString(unknownsRecord.note) || `${Number(unknownsRecord.recorded ?? 0)} recorded; ${Number(unknownsRecord.distinct ?? 0)} distinct.`}`,
  );
  lines.push(...mdList(asArray(unknownsRecord.items)));
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
    lines.push('## The debate');
    lines.push('');
    lines.push(
      asString(model.debate_note) || CONSULT_NO_DEBATE_NOTE,
    );
    lines.push('');
    pushHowToUseMd(lines, model);
    pushToolsMd(lines, model);
    pushProvenanceMd(lines, model);
    return `${lines.join('\n')}\n`;
  }

  pushPlanMd(lines, model);
  pushHowToUseMd(lines, model);
  pushToolsMd(lines, model);
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

  pushDebateMd(lines, model);

  lines.push('## Main arguments and strongest dissent');
  lines.push('');
  lines.push('Main arguments:');
  lines.push(...mdList(asArray(model.main_reasons)));
  lines.push('');
  lines.push(`Strongest dissent: ${asStringOrNull(model.strongest_dissent) ?? 'none recorded'}`);
  lines.push('');

  lines.push('## Constraints, assumptions, and conditions');
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
  const conditions = asRecord(model.conditions_summary);
  lines.push('Conditions and safeguards:');
  lines.push(
    `- ${Number(conditions.total ?? 0)} recorded; ${Number(conditions.open ?? 0)} open; ${Number(
      conditions.satisfied ?? 0,
    )} satisfied; ${Number(conditions.waived ?? 0)} waived by the owner; ${Number(
      conditions.unresolved ?? 0,
    )} unresolved; ${Number(conditions.blocking_open ?? 0)} blocking and open.`,
  );
  for (const itemValue of asArray(conditions.items)) {
    const item = asRecord(itemValue);
    lines.push(
      `- ${asString(item.description)} (${asString(item.kind)}, ${asString(item.status)}${item.blocking === true ? ', blocking' : ''}, source: ${asString(item.source)})`,
    );
  }
  lines.push('');
  lines.push('Unknowns were printed once, with their recorded/distinct counts, in the question section above; they are not repeated here.');
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
  lines.push('The plan, its acceptance criteria, its stop conditions, and its review criteria were printed once in "The plan" above; they are not repeated here.');
  lines.push('');
  lines.push(`> ${asString(model.authorization_notice)}`);
  lines.push('');

  pushSeatsMd(lines, model);
  pushProvenanceMd(lines, model);
  return `${lines.join('\n')}\n`;
}

function pushPlanMd(lines: string[], model: Record<string, unknown>): void {
  lines.push('## The plan');
  lines.push('');
  const proposals = asArray(model.action_proposals);
  if (proposals.length === 0) lines.push('- none recorded');
  proposals.forEach((proposalValue, index) => {
    const proposal = asRecord(proposalValue);
    lines.push(`### Step ${index + 1}: ${asString(proposal.title)}`);
    lines.push('');
    lines.push(asString(proposal.description));
    lines.push('');
    lines.push(`Why: ${asString(proposal.rationale) || 'not recorded'}`);
    const criteria = asArray(proposal.acceptance_criteria)
      .map(asString)
      .filter((criterion) => criterion.trim().length > 0);
    if (criteria.length > 0) {
      lines.push('Done when:');
      lines.push(...mdList(criteria));
    } else {
      lines.push(
        'Not ready to execute: no acceptance criterion was recorded for this step, so it cannot be started until one is recorded and approved. This is an absence in the record, not a pass.',
      );
    }
    const depends = asArray(proposal.depends_on_action_ids).map(asString);
    lines.push(`Depends on: ${depends.length > 0 ? depends.join(', ') : 'none'}`);
    lines.push(`Risk class: ${asString(proposal.risk_class)}`);
    lines.push(
      'Execution authorization: separate execution authorization is required before this step may be acted on.',
    );
    lines.push('');
  });
  lines.push(
    `Cheapest informative test: ${asStringOrNull(model.cheapest_informative_test) ?? 'none recorded'}`,
  );
  lines.push('');
  const stop = asArray(model.stop_criteria)
    .map(asString)
    .filter((value) => value.trim().length > 0);
  lines.push('Stop if:');
  lines.push(
    ...(stop.length > 0
      ? mdList(stop)
      : ['- no stop condition was recorded; that is an absence in the record, not permission to continue indefinitely.']),
  );
  lines.push('');
  const review = asArray(model.review_criteria)
    .map(asString)
    .filter((value) => value.trim().length > 0);
  lines.push('How you will know it worked:');
  lines.push(
    ...(review.length > 0
      ? mdList(review)
      : ['- no outcome review criterion was recorded; that is an absence in the record, not a pass.']),
  );
  lines.push('');
}

function pushHowToUseMd(lines: string[], model: Record<string, unknown>): void {
  lines.push('## How to use this report');
  lines.push('');
  const howToUse = asArray(model.how_to_use).map(asString);
  lines.push(...(howToUse.length > 0 ? mdList(howToUse) : ['- no reading guide was recorded.']));
  lines.push('');
}

function pushToolsMd(lines: string[], model: Record<string, unknown>): void {
  const tools = asRecord(model.your_tools);
  lines.push('## Helpers that fit the plan');
  lines.push('');
  lines.push(
    asString(tools.note) || 'No installation capability snapshot was recorded.',
  );
  lines.push('');
  if (asString(tools.status) === 'matched') {
    for (const matchValue of asArray(tools.matches)) {
      const match = asRecord(matchValue);
      const actions =
        asArray(match.matched_action_titles).map(asString).join(', ') ||
        'the plan';
      lines.push(
        `- **${asString(match.name)}** (${asString(match.kind)}, ${asString(
          match.capability_id,
        )}, ${asString(match.availability)}): exact ${asString(
          match.match_basis,
        )} match for ${actions}`,
      );
    }
    lines.push('');
  }
  if (tools.no_match_note) {
    lines.push(asString(tools.no_match_note));
    lines.push('');
  }
  const limitations = asArray(tools.limitations).map(asString);
  if (limitations.length > 0) {
    lines.push('What was read, and what was not:');
    lines.push(...mdList(limitations));
    lines.push('');
  }
  lines.push(asString(tools.availability_note));
  lines.push('');
  lines.push(
    asString(tools.exactness_note) ||
      'Only a recorded plan reference or an exact whole-phrase name counts.',
  );
  lines.push('');
}

/**
 * The saved-round debate. Counts, changes, positions, and the explicit
 * absence of a chair stop note come from the record only.
 */
function pushDebateMd(lines: string[], model: Record<string, unknown>): void {
  const debate = asRecord(model.debate);
  const highest = asNumberOrNull(debate.highest_round);
  lines.push('## The debate');
  lines.push('');
  lines.push(
    `Rounds saved: ${Number(debate.rounds_saved ?? 0)}; highest round: ${
      highest === null ? 'none' : String(highest)
    }; split: ${debate.split === true ? 'yes' : debate.split === false ? 'no' : 'not available'}.`,
  );
  lines.push('');
  lines.push(...mdList(asArray(debate.notes)));
  lines.push('');
  for (const roundValue of asArray(debate.rounds)) {
    const round = asRecord(roundValue);
    lines.push(`### Round ${Number(round.round ?? 0)}`);
    lines.push('');
    for (const seatValue of asArray(round.seats)) {
      const seat = asRecord(seatValue);
      lines.push(
        `- ${asString(seat.display_name)}: ${asString(seat.stance_text) || asString(
          seat.stance,
        )} — ${asString(seat.preferred_option_label)}`,
      );
    }
    lines.push('');
  }
  lines.push('What changed between saved rounds:');
  const changes = asArray(debate.changes);
  if (changes.length === 0) {
    lines.push(
      '- No seat changed its stance or preferred option between the saved rounds.',
    );
  } else {
    for (const changeValue of changes) {
      const change = asRecord(changeValue);
      lines.push(
        `- Round ${Number(change.round ?? 0)} — ${asString(
          change.display_name,
        )}: ${asString(change.from_stance_text)} / ${asString(
          change.from_option_label,
        )} → ${asString(change.to_stance_text)} / ${asString(
          change.to_option_label,
        )}`,
      );
    }
  }
  lines.push('');
  const positions = asArray(debate.positions);
  if (positions.length > 0) {
    lines.push('Final positions:');
    for (const positionValue of positions) {
      const position = asRecord(positionValue);
      lines.push(
        `- ${asString(position.option_label)}: ${asArray(position.seat_names)
          .map(asString)
          .join(', ')}`,
      );
    }
    lines.push('');
  }
  lines.push(
    asString(asRecord(debate.stop_record ?? {}).note) ||
      'The saved record contains no chair stop note.',
  );
  lines.push('');
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
    /**
     * Optional, already validated and installation-bound snapshot from
     * the scope store. The report prints an explicit "not provided"
     * tools section when no snapshot exists.
     */
    capability_snapshot?: InstallationCapabilitySnapshot | null;
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
    capability_snapshot: input.capability_snapshot ?? null,
  });
  const reportRevision = String(model.report_revision_id);
  const redacted = redaction !== null;

  const cover = loadReportCoverAssets();
  const markdown = renderMarkdown(model);
  const printHtml = renderPrintHtml(model, { cover });
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
  const printHtml = renderPrintHtml(model, { cover: loadReportCoverAssets() });
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
