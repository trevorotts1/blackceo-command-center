/**
 * JEV-234 (CC D34) — decision-engine mode/compatibility adapters.
 *
 * Pure, offline policy interpretation over the existing schema and the
 * existing client policy. No spawn, no network, no database, no key reads:
 * callers pass capability state, standing policy gates, and revisions in.
 * This module never touches intake, department-router, auto-route, tasks,
 * dispatch, board, conformance, or release numbers.
 *
 * Spec sections 3.6 (mode semantics), 3.8 (capability is not permission),
 * 3.9 (shadow read-only), 14.8 (two-repo compatibility), 17.3/17.4
 * (activation/rollback). Acceptance A43, A53, A59-A63.
 */

import type { CapabilityReason, CapabilityState } from './capability';

/** Configured modes from spec 3.6. `off` and `legacy` share the SAME improved
 * no-JEV selection implementation; the names convey operational intent only. */
export type DecisionEngineMode = 'auto' | 'shadow' | 'legacy' | 'off';

/** Authoritative path for NEW work. `jev` means a JEV recommendation may be
 * committed; `no_jev` means the same improved no-JEV engine decides. */
export type EffectivePath = 'jev' | 'no_jev';

export type ModeSkipReason =
  | 'mode_off'
  | 'mode_legacy'
  | 'mode_shadow_assignment'
  | 'core_absent'
  | 'schema_major_mismatch'
  | 'handshake_failed'
  | 'not_authorized'
  | 'data_not_permitted'
  | 'no_shadow_allowance';

/**
 * Standing client policy gate, resolved from EXISTING policy facilities by
 * the caller. A usable credential answers neither question, so keys are
 * never an input here: spend and data permission arrive as explicit booleans.
 */
export interface PolicyGate {
  /** Standing spending/budget approval covers this operation. */
  spendAuthorized: boolean;
  /** This payload may go to this provider/path for this purpose. */
  dataPermitted: boolean;
  /** Existing policy revision, for fencing. */
  policyVersion: string;
}

export interface ModeResolutionInput {
  configuredMode: DecisionEngineMode;
  capability: CapabilityState;
  gate: PolicyGate;
  /** Caller-owned config revision, echoed through the D09 contract. */
  configRevision: string;
  /**
   * Explicit bounded evaluation allowance approved for shadow work (3.9).
   * No allowance means zero remote shadow calls, even in shadow mode.
   */
  shadowAllowanceApproved: boolean;
}

export interface ModeResolution {
  configuredMode: DecisionEngineMode;
  effectivePath: EffectivePath;
  /** True only when a JEV recommendation may commit for new work. */
  useJev: boolean;
  /** Any JEV evaluation call permitted (foreground or sampled shadow). */
  jevCallsAllowed: boolean;
  /** Capability probe spawn permitted. Probes are JEV traffic: off/legacy
   * allow zero, so callers must skip probeInstalledCore there too. */
  probeAllowed: boolean;
  /**
   * Sampled shadow comparison permitted. Diagnostic only: shadow results can
   * never commit, pin, weight, confirm, dispatch, or change QC verdicts.
   */
  shadowAllowed: boolean;
  skipReason: ModeSkipReason | null;
  /** Truthful one-line diagnostic. Auto denied by policy reports the true
   * no-JEV path, never "JEV active". */
  effectiveLabel: string;
  configRevision: string;
  policyVersion: string;
}

function coreReason(reason: CapabilityReason | undefined): ModeSkipReason {
  if (reason === 'core_absent') return 'core_absent';
  if (reason === 'schema_major_mismatch') return 'schema_major_mismatch';
  return 'handshake_failed';
}

function noJev(
  configuredMode: DecisionEngineMode,
  skipReason: ModeSkipReason,
  input: ModeResolutionInput,
  overrides: Partial<ModeResolution> = {},
): ModeResolution {
  return {
    configuredMode,
    effectivePath: 'no_jev',
    useJev: false,
    jevCallsAllowed: false,
    probeAllowed: false,
    shadowAllowed: false,
    skipReason,
    effectiveLabel: `no_jev (${configuredMode} denied: ${skipReason})`,
    configRevision: input.configRevision,
    policyVersion: input.gate.policyVersion,
    ...overrides,
  };
}

/**
 * Resolve configured mode + capability + standing policy to the effective
 * path. Permission/config denials yield the truthful no-JEV fallback; they
 * are never mislabeled as missing credentials (core_absent is only for an
 * actually absent/incompatible core).
 */
export function resolveEffectivePath(input: ModeResolutionInput): ModeResolution {
  const { configuredMode, capability, gate } = input;

  if (configuredMode === 'off') {
    return noJev('off', 'mode_off', input, { effectiveLabel: 'no_jev (mode: off)' });
  }
  if (configuredMode === 'legacy') {
    return noJev('legacy', 'mode_legacy', input, { effectiveLabel: 'no_jev (mode: legacy)' });
  }

  if (configuredMode === 'shadow') {
    // Shadow authoritative decisions ALWAYS come from the no-JEV engine;
    // JEV output is diagnostic-only and can never become an assignment.
    if (!capability.compatible) {
      return noJev('shadow', coreReason(capability.reason), input);
    }
    if (!gate.spendAuthorized) {
      return noJev('shadow', 'not_authorized', input);
    }
    if (!gate.dataPermitted) {
      return noJev('shadow', 'data_not_permitted', input);
    }
    if (!input.shadowAllowanceApproved) {
      return noJev('shadow', 'no_shadow_allowance', input);
    }
    return {
      configuredMode,
      effectivePath: 'no_jev',
      useJev: false,
      jevCallsAllowed: true,
      probeAllowed: true,
      shadowAllowed: true,
      skipReason: 'mode_shadow_assignment',
      effectiveLabel: 'no_jev (mode: shadow; sampled JEV comparison diagnostic-only)',
      configRevision: input.configRevision,
      policyVersion: gate.policyVersion,
    };
  }

  // auto: JEV only where compatible, authorized, data-permitted, budgeted.
  // Otherwise the same improved no-JEV engine, with the honest reason.
  if (!capability.compatible) {
    return noJev('auto', coreReason(capability.reason), input);
  }
  if (!gate.spendAuthorized) {
    return noJev('auto', 'not_authorized', input);
  }
  if (!gate.dataPermitted) {
    return noJev('auto', 'data_not_permitted', input);
  }
  return {
    configuredMode: 'auto',
    effectivePath: 'jev',
    useJev: true,
    jevCallsAllowed: true,
    probeAllowed: true,
    shadowAllowed: false,
    skipReason: null,
    effectiveLabel: 'jev (auto)',
    configRevision: input.configRevision,
    policyVersion: gate.policyVersion,
  };
}

/**
 * Parse a configured mode from client configuration. Explicit client
 * off/legacy/shadow settings survive through updates: valid values always
 * win over the fallback, and a release default (fallback) never overwrites
 * them. Unknown values fall back rather than crash.
 */
export function parseConfiguredMode(raw: unknown, fallback: DecisionEngineMode = 'auto'): DecisionEngineMode {
  if (typeof raw === 'string') {
    const v = raw.trim().toLowerCase();
    if (v === 'auto' || v === 'shadow' || v === 'legacy' || v === 'off') return v;
  }
  return fallback;
}

/**
 * A mode/policy change fences uncommitted recommendations from the old
 * revision. Already committed decisions and running execution snapshots stay
 * intact: this predicate only ever runs against UNCOMMITTED recommendations,
 * so a fenced recommendation is dropped, never rewritten into history.
 */
export function isRecommendationFenced(
  recommendationConfigRevision: string,
  currentConfigRevision: string,
  recommendationPolicyVersion?: string,
  currentPolicyVersion?: string,
): boolean {
  if (recommendationConfigRevision !== currentConfigRevision) return true;
  if (
    recommendationPolicyVersion !== undefined &&
    currentPolicyVersion !== undefined &&
    recommendationPolicyVersion !== currentPolicyVersion
  ) {
    return true;
  }
  return false;
}

export interface FencedSplit<T> {
  kept: T[];
  fenced: T[];
}

/**
 * Partition uncommitted JEV recommendations against the current
 * config/policy revision. Committed/running snapshots are not inputs here
 * and are therefore never rewritten by a fence.
 */
export function fenceStaleRecommendations<
  T extends { configRevision: string; policyVersion?: string },
>(
  recommendations: T[],
  currentConfigRevision: string,
  currentPolicyVersion?: string,
): FencedSplit<T> {
  const kept: T[] = [];
  const fenced: T[] = [];
  for (const rec of recommendations) {
    if (isRecommendationFenced(rec.configRevision, currentConfigRevision, rec.policyVersion, currentPolicyVersion)) {
      fenced.push(rec);
    } else {
      kept.push(rec);
    }
  }
  return { kept, fenced };
}

/**
 * Paired ONB/CC release-cohort activation check (14.8, A53). Git provides no
 * atomic transaction across two repositories, so the enhanced paired release
 * activates only when the EXACT tested candidate pair matches, both sides
 * report compatible, and the cohort evidence exists. A half-promoted pair or
 * external main advancement blocks activation; nothing is overwritten.
 */
export interface CohortPair {
  ccSha: string;
  onbSha: string;
  ccExpectedSha: string;
  onbExpectedSha: string;
  ccCompatible: boolean;
  onbCompatible: boolean;
  ccCompatDetail?: string;
  onbCompatDetail?: string;
  cohortEvidencePresent: boolean;
}

export interface CohortActivation {
  activatable: boolean;
  reasons: string[];
}

export function checkPairedCohortActivation(pair: CohortPair): CohortActivation {
  const reasons: string[] = [];
  if (pair.ccSha !== pair.ccExpectedSha) {
    reasons.push(`cc SHA drift: got ${pair.ccSha}, tested cohort expects ${pair.ccExpectedSha}`);
  }
  if (pair.onbSha !== pair.onbExpectedSha) {
    reasons.push(`onb SHA drift: got ${pair.onbSha}, tested cohort expects ${pair.onbExpectedSha}`);
  }
  if (!pair.ccCompatible) {
    reasons.push(`cc side incompatible${pair.ccCompatDetail ? `: ${pair.ccCompatDetail}` : ''}`);
  }
  if (!pair.onbCompatible) {
    reasons.push(`onb side incompatible${pair.onbCompatDetail ? `: ${pair.onbCompatDetail}` : ''}`);
  }
  if (!pair.cohortEvidencePresent) {
    reasons.push('cohort evidence absent: half-promoted pair must not activate');
  }
  return { activatable: reasons.length === 0, reasons };
}
