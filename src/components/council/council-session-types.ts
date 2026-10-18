/**
 * council-session-types.ts (CWE-034, Skill 77 Council of Wise Elders)
 *
 * View types and pure helpers for the live session, verdict, history,
 * source, and outcome screens (directive Sections 18, 21, 24).
 *
 * Everything here is a pure function of committed state handed to it:
 * the CWE-030 session projection, the CWE-029 safe-read payloads
 * (session detail, verdict read, session list), the frozen brief, and
 * committed cards. Nothing in this module fetches, invents a verdict,
 * upgrades a seat's recorded qualification, or presents a candidate
 * quotation as verified. A verdict that does not carry the recorded
 * validation status 'valid', or that fails the structural shape of
 * the canonical CWE-003 Verdict, classifies as 'invalid' here and the
 * screens render the explicit invalid-verdict state for it (Section
 * 21.3), never a polished fake.
 */

import type {
  CouncilSessionProjection,
} from '@/lib/council/events/types';
import type {
  CouncilCard,
  DecisionBrief,
  EvidenceManifestEntry,
  Verdict,
} from '@/lib/council/contracts';
import {
  seatIdentity,
  type CouncilRoomMode,
  type CouncilRoomView,
  type CouncilSeatCardView,
  type CouncilSeatId,
  type CouncilSeatView,
} from './council-room-types';

/* ── Safe-read payload shapes (CWE-029 routes, consumed verbatim) ────── */

/** One row of GET /api/council/sessions (committed store state only). */
export interface CouncilSessionSummaryView {
  session_id: string;
  mode: string;
  visibility: string;
  state: string;
  state_version: number;
  brief_revision: number;
  archived: boolean;
  owner_subject: string | null;
  created_at: string;
  updated_at: string;
}

/** GET /api/council/sessions/:id/verdict data payload. */
export interface CouncilVerdictReadData {
  session_id: string;
  verdict_state: 'not_ready' | 'validated' | string;
  verdict: Verdict | null;
}

/* ── Verdict classification (Section 21.3) ────────────────────────────── */

export type VerdictClassification =
  | { kind: 'not_ready' }
  | { kind: 'invalid'; reasons: string[]; recordedStatus: string | null }
  | { kind: 'valid'; verdict: Verdict };

const VERDICT_LABEL_SET: ReadonlySet<string> = new Set([
  'GO',
  'GO_WITH_CONDITIONS',
  'RESHAPE',
  'DONT_DO_IT',
  'WAIT',
  'INSUFFICIENT_EVIDENCE',
]);

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Classify a verdict read payload exactly as recorded. The committed
 * verdict is rendered only when it is structurally a canonical
 * verdict AND its recorded validation_status is 'valid'. Anything
 * else is the explicit invalid state, with the reasons listed so the
 * screen can say plainly what failed.
 */
export function classifyVerdictRead(data: unknown): VerdictClassification {
  if (!isRecord(data)) {
    return {
      kind: 'invalid',
      reasons: ['The verdict read did not return a verdict record.'],
      recordedStatus: null,
    };
  }
  if (data.verdict_state === 'not_ready' || data.verdict === null || data.verdict === undefined) {
    return { kind: 'not_ready' };
  }
  const verdict = data.verdict;
  if (!isRecord(verdict)) {
    return {
      kind: 'invalid',
      reasons: ['The committed verdict is not a verdict object.'],
      recordedStatus: null,
    };
  }
  const reasons: string[] = [];
  const recordedStatus =
    typeof verdict.validation_status === 'string' ? verdict.validation_status : null;
  if (verdict.result_kind !== 'scored' && verdict.result_kind !== 'consult') {
    reasons.push('The verdict record has no recognized result kind.');
  }
  if (
    typeof verdict.verdict_revision !== 'number' ||
    !Number.isInteger(verdict.verdict_revision) ||
    verdict.verdict_revision < 1
  ) {
    reasons.push('The verdict record has no valid verdict revision.');
  }
  if (!isSha256(verdict.content_sha256) || !isSha256(verdict.brief_sha256)) {
    reasons.push('The verdict record is missing its recorded content or brief hash.');
  }
  if (verdict.result_kind === 'scored') {
    if (typeof verdict.label !== 'string' || !VERDICT_LABEL_SET.has(verdict.label)) {
      reasons.push('The scored verdict has no recognized verdict label.');
    }
    if (!Array.isArray(verdict.option_scores)) {
      reasons.push('The scored verdict has no recorded option scores.');
    }
    if (!Array.isArray(verdict.main_reasons)) {
      reasons.push('The scored verdict has no recorded main reasons.');
    }
  }
  if (verdict.result_kind === 'consult' && !isRecord(verdict.consult_card)) {
    reasons.push('The consult result has no recorded consult card.');
  }
  if (recordedStatus !== 'valid') {
    reasons.push(
      recordedStatus === null
        ? 'The verdict record carries no validation status.'
        : `The verdict's recorded validation status is "${recordedStatus}", not "valid".`,
    );
  }
  if (reasons.length > 0) return { kind: 'invalid', reasons, recordedStatus };
  return { kind: 'valid', verdict: verdict as unknown as Verdict };
}

/* ── Projection to room view (the CWE-030 to CWE-032 adapter) ───────── */

const PHASE_LABELS: Readonly<Record<string, string>> = {
  DRAFT: 'Draft, not started',
  READY: 'Ready to start',
  QUEUED: 'Waiting to start',
  PREPARING: 'Preparing the council',
  ROUND_1: 'Round 1 of 3: Independent openings',
  CRUX_REVIEW: 'Crux review: the chair names what could change the decision',
  ROUND_2: 'Round 2 of 3: Challenge',
  DRAFT_RESOLUTION: 'Draft resolution',
  ROUND_3: 'Round 3 of 3: Ratification',
  CONSULTING: 'Consultation in progress',
  VERIFYING: 'Verifying the verdict',
  COMPLETED: 'Session complete',
  PAUSE_REQUESTED: 'Pause requested',
  PAUSED: 'Paused',
  CANCEL_REQUESTED: 'Cancellation requested',
  CANCELLED: 'Cancelled',
  BLOCKED: 'Blocked',
  FAILED: 'Failed',
};

const STATE_ROUNDS: Readonly<Record<string, 1 | 2 | 3>> = {
  ROUND_1: 1,
  CRUX_REVIEW: 1,
  ROUND_2: 2,
  DRAFT_RESOLUTION: 2,
  ROUND_3: 3,
  VERIFYING: 3,
  COMPLETED: 3,
};

export function phaseLabelForState(state: string): string {
  return PHASE_LABELS[state] ?? `Session state: ${state}`;
}

/**
 * A hydrated card read is accepted by this view adapter only when it matches
 * the SAME scoped committed projection's latest card receipt. Actual API
 * scope authorization and body validation belong to the owning read route.
 * A stale, wrong-round, wrong-session or uncommitted card never renders.
 */
export interface HydratedCouncilRoomCard {
  sessionId: string;
  seatId: CouncilSeatId;
  round: number;
  cardHash: string;
  card: CouncilSeatCardView;
}

/**
 * Adapt an event projection plus optional already-authorized committed-card
 * detail reads. The journal itself carries only hashes, not body content.
 * Without valid matching hydrated data the seat remains honestly card:null.
 * An active state phase takes precedence over the last completed card round.
 */
export function projectionToRoomView(
  projection: CouncilSessionProjection,
  options: {
    decisionTitle: string;
    mode?: CouncilRoomMode;
    hydratedCards?: Readonly<Partial<Record<CouncilSeatId, HydratedCouncilRoomCard>>>;
    committedCrux?: string | null;
  },
): CouncilRoomView {
  const seats: CouncilSeatView[] = projection.seats.map((seat) => {
    const seatId = seat.seat_id as CouncilSeatId;
    const hydrated = options.hydratedCards?.[seatId] ?? null;
    const latest = seat.last_card;
    const matchesCommitted =
      seat.status === 'completed' &&
      latest !== null &&
      hydrated !== null &&
      hydrated.seatId === seatId &&
      hydrated.sessionId === projection.session_id &&
      hydrated.round === latest.round &&
      hydrated.cardHash === latest.card_hash;
    return {
      seatId,
      status: seat.status,
      card: matchesCommitted ? hydrated.card : null,
    };
  });
  const highestCardRound = projection.seats.reduce<number | null>(
    (acc, seat) =>
      seat.last_card ? Math.max(acc ?? 0, seat.last_card.round) : acc,
    null,
  );
  const stateRound = STATE_ROUNDS[projection.state] ?? null;
  const currentRound = (stateRound ?? highestCardRound) as 1 | 2 | 3 | null;
  return {
    decisionTitle: options.decisionTitle,
    phaseLabel: phaseLabelForState(projection.state),
    currentRound:
      currentRound !== null && currentRound >= 1 && currentRound <= 3
        ? (currentRound as 1 | 2 | 3)
        : null,
    cruxLabel: options.committedCrux ?? null,
    mode: options.mode ?? (projection.sample ? 'sample' : 'live'),
    seats,
  };
}

/** Terminal or attention states the live screen must name explicitly. */
export function sessionStateNotice(
  state: string,
): { tone: 'blocked' | 'failed' | 'cancelled' | 'paused'; text: string } | null {
  switch (state) {
    case 'BLOCKED':
      return {
        tone: 'blocked',
        text: 'This session is blocked. Its recorded state has not advanced, and nothing shown here is a result.',
      };
    case 'FAILED':
      return {
        tone: 'failed',
        text: 'This session failed. The committed record above is all that was saved; no verdict was produced by this run.',
      };
    case 'CANCELLED':
      return {
        tone: 'cancelled',
        text: 'This session was cancelled. Cancellation is final: a late result cannot revive it, and usage is reconciled from the committed record.',
      };
    case 'PAUSED':
    case 'PAUSE_REQUESTED':
      return {
        tone: 'paused',
        text: 'This session is paused. The room shows the last committed state, not live progress.',
      };
    default:
      return null;
  }
}

/* ── Brief diff for rerun comparison (T024) ──────────────────────────── */

export interface BriefDiffEntry {
  field: string;
  before: string | null;
  after: string | null;
}

function diffStatements(
  field: string,
  before: ReadonlyArray<{ id: string; statement: string }>,
  after: ReadonlyArray<{ id: string; statement: string }>,
  entries: BriefDiffEntry[],
): void {
  const beforeById = new Map(before.map((f) => [f.id, f.statement]));
  const afterById = new Map(after.map((f) => [f.id, f.statement]));
  for (const [id, statement] of afterById) {
    if (!beforeById.has(id)) {
      entries.push({ field: `${field} added`, before: null, after: statement });
    } else if (beforeById.get(id) !== statement) {
      entries.push({
        field: `${field} changed`,
        before: beforeById.get(id) ?? null,
        after: statement,
      });
    }
  }
  for (const [id, statement] of beforeById) {
    if (!afterById.has(id)) {
      entries.push({ field: `${field} removed`, before: statement, after: null });
    }
  }
}

/**
 * The changed-input diff between a parent session's frozen brief and
 * its rerun child's brief. Pure and total: identical briefs produce
 * an empty diff, which the comparison screen states plainly rather
 * than dressing up as a change.
 */
export function diffBriefs(before: DecisionBrief, after: DecisionBrief): BriefDiffEntry[] {
  const entries: BriefDiffEntry[] = [];
  if (before.question !== after.question) {
    entries.push({ field: 'Decision question', before: before.question, after: after.question });
  }
  diffStatements('Fact', before.facts, after.facts, entries);
  diffStatements('Assumption', before.assumptions, after.assumptions, entries);
  diffStatements('Unknown', before.unknowns, after.unknowns, entries);

  const beforeOptions = new Map(before.options.map((o) => [o.id, o.label]));
  const afterOptions = new Map(after.options.map((o) => [o.id, o.label]));
  for (const [id, label] of afterOptions) {
    if (!beforeOptions.has(id)) {
      entries.push({ field: 'Option added', before: null, after: label });
    } else if (beforeOptions.get(id) !== label) {
      entries.push({ field: 'Option changed', before: beforeOptions.get(id) ?? null, after: label });
    }
  }
  for (const [id, label] of beforeOptions) {
    if (!afterOptions.has(id)) {
      entries.push({ field: 'Option removed', before: label, after: null });
    }
  }

  const beforeConstraints = new Map(before.constraints.map((c) => [c.id, c]));
  const afterConstraints = new Map(after.constraints.map((c) => [c.id, c]));
  for (const [id, constraint] of afterConstraints) {
    const prior = beforeConstraints.get(id);
    if (!prior) {
      entries.push({ field: 'Constraint added', before: null, after: constraint.description });
    } else if (
      prior.description !== constraint.description ||
      prior.hard !== constraint.hard
    ) {
      entries.push({
        field: 'Constraint changed',
        before: prior.description,
        after: constraint.description,
      });
    }
  }
  for (const [id, constraint] of beforeConstraints) {
    if (!afterConstraints.has(id)) {
      entries.push({ field: 'Constraint removed', before: constraint.description, after: null });
    }
  }
  return entries;
}

/* ── Per-seat recorded sources (Section 21 source drawer) ───────────── */

export interface SeatSourceEntry {
  evidenceId: string;
  sourceKind: EvidenceManifestEntry['source_kind'];
  locator: string;
  sha256: string;
}

export interface VerifiedQuoteView {
  text: string;
  locator: string;
  evidenceId: string;
}

export interface SeatSources {
  seatId: string;
  displayName: string;
  /** The Section 7 profile label, verbatim from the roster record. */
  profileLabel: string;
  /**
   * The seat pack's recorded source qualification. In this build every
   * pack stands at 'bibliographic_only' (accepted CWE-011 to CWE-019
   * state); the value is passed in, never upgraded here.
   */
  qualification: string;
  sources: SeatSourceEntry[];
  /** Only quotations whose recorded verification status is 'verified'. */
  verifiedQuotes: VerifiedQuoteView[];
  /** Candidate or rejected quotations are counted, never displayed as quotes. */
  unverifiedQuoteCount: number;
}

export function qualificationLabel(qualification: string): string {
  switch (qualification) {
    case 'bibliographic_only':
      return 'Bibliographic only: sources are recorded at publisher and bibliography level. No quotation from this seat has been verified against a checked source text.';
    default:
      return `Recorded qualification: ${qualification}.`;
  }
}

/**
 * Build one seat's source view from committed records only: the
 * seat's committed cards name evidence IDs through their framework
 * applications; the frozen brief's evidence manifest resolves those
 * IDs to recorded sources with locators. A quotation is returned as
 * a quotation only when its recorded verification status is
 * 'verified' (Section 8); anything else is counted and withheld.
 */
export function buildSeatSources(
  seatId: string,
  cards: readonly CouncilCard[],
  brief: DecisionBrief,
  qualification: string,
): SeatSources {
  const identity = seatIdentity(seatId as CouncilSeatId);
  const manifest = new Map(brief.evidence_manifest.map((e) => [e.evidence_id, e]));
  const sourceIds = new Set<string>();
  const verifiedQuotes: VerifiedQuoteView[] = [];
  let unverifiedQuoteCount = 0;

  for (const card of cards) {
    if (card.card_kind === 'ratification') continue;
    if (card.seat_id !== seatId) continue;
    for (const application of card.framework_applications) {
      for (const id of application.source_evidence_ids) sourceIds.add(id);
      for (const id of application.case_evidence_ids) sourceIds.add(id);
    }
    if (card.card_kind === 'consult') {
      for (const id of card.evidence_ids) sourceIds.add(id);
    }
    if (card.card_kind === 'advisor') {
      for (const quote of card.quotes) {
        if (quote.verification_status === 'verified') {
          verifiedQuotes.push({
            text: quote.text,
            locator: quote.locator,
            evidenceId: quote.evidence_id,
          });
        } else {
          unverifiedQuoteCount += 1;
        }
      }
    }
  }

  const sources: SeatSourceEntry[] = [];
  for (const id of sourceIds) {
    const entry = manifest.get(id);
    if (entry) {
      sources.push({
        evidenceId: entry.evidence_id,
        sourceKind: entry.source_kind,
        locator: entry.locator,
        sha256: entry.sha256,
      });
    }
  }
  sources.sort((a, b) => a.evidenceId.localeCompare(b.evidenceId));

  return {
    seatId,
    displayName: identity.displayName,
    profileLabel: identity.profileLabel,
    qualification,
    sources,
    verifiedQuotes,
    unverifiedQuoteCount,
  };
}

/* ── Scope-partitioned client cache (T081, Section 28) ──────────────── */

/**
 * Client cache partitioned by the trusted scope key (tenant, company,
 * principal). Switching scope drops every other partition's entries
 * synchronously, before any render can observe them: after a company
 * switch, no prior company's session, source, or model data can
 * render, even briefly from cache.
 */
export class CouncilScopeCache {
  private scopeKey: string | null = null;
  private readonly entries = new Map<string, unknown>();

  get currentScopeKey(): string | null {
    return this.scopeKey;
  }

  setScope(scopeKey: string): void {
    if (scopeKey !== this.scopeKey) {
      this.scopeKey = scopeKey;
      this.entries.clear();
    }
  }

  get<T>(key: string): T | undefined {
    return this.entries.get(key) as T | undefined;
  }

  set(key: string, value: unknown): void {
    this.entries.set(key, value);
  }

  clear(): void {
    this.entries.clear();
  }
}

export function councilScopeKey(scope: {
  tenant_id: string;
  company_id: string;
  principal_subject: string;
}): string {
  return `${scope.tenant_id}|${scope.company_id}|${scope.principal_subject}`;
}
