/**
 * Installation capability snapshot (CTR-165; canonical 1.0.74 semantic
 * parity, Command Center implementation).
 *
 * This is the reader-facing inventory of skills and departments that are
 * installed on ONE installation. The snapshot is bound to the exact
 * installation the Command Center already resolved; the report refuses a
 * snapshot from another installation.
 *
 * Hard rules, mirrored from the canonical 1.0.74 report model:
 *   - strict schema: unknown fields are refused, every string is bounded,
 *     and the item count is capped so a catalog dump cannot ride into a
 *     client report;
 *   - no path, URL, prompt, memory, credential, database, or config value
 *     is part of the contract. Only a capability id, kind, display name,
 *     short description, availability, source, and recorded plan
 *     references are carried;
 *   - matching is EXACT: a recorded plan reference on the action proposal,
 *     or the capability's exact name/slug/id appearing as a whole phrase in
 *     the step text. Shared vocabulary is not task fit, so a backup skill is
 *     never suggested for a video step because both say "before" and "every";
 *   - "available" is an installation fact, never an operational promise.
 *     A matching installed skill is optional assistance, not a guarantee
 *     that the tool can execute the step.
 */

import { z } from 'zod';

export const CAPABILITY_SNAPSHOT_SCHEMA =
  'wise-elders.capability-snapshot/v1' as const;

export const CAPABILITY_SNAPSHOT_LIMITS = {
  max_items: 120,
  max_name: 90,
  max_description: 320,
  max_id: 140,
  max_reference_ids: 24,
  max_limitations: 24,
  max_limitation_text: 400,
  max_matched_steps: 6,
} as const;

export type CapabilityKind = 'skill' | 'department';
export type CapabilityAvailability = 'available_now' | 'available_at_sitting';
export type CapabilitySource =
  | 'openclaw.skills'
  | 'openclaw.departments'
  | 'claude.skills';

const nonEmpty = z.string().trim().min(1);
const bounded = (max: number) => nonEmpty.max(max);
const capabilityId = bounded(CAPABILITY_SNAPSHOT_LIMITS.max_id).regex(
  /^(skill|department):[a-z0-9][a-z0-9._-]*$/,
  'capability_id must be skill:<slug> or department:<slug>',
);

export const capabilitySnapshotItemSchema = z
  .strictObject({
    capability_id: capabilityId,
    kind: z.enum(['skill', 'department']),
    name: bounded(CAPABILITY_SNAPSHOT_LIMITS.max_name),
    description: bounded(CAPABILITY_SNAPSHOT_LIMITS.max_description)
      .nullable(),
    availability: z.enum(['available_now', 'available_at_sitting']),
    source: z.enum(['openclaw.skills', 'openclaw.departments', 'claude.skills']),
    recorded_reference_ids: z
      .array(bounded(CAPABILITY_SNAPSHOT_LIMITS.max_id))
      .max(CAPABILITY_SNAPSHOT_LIMITS.max_reference_ids),
  })
  .superRefine((item, ctx) => {
    const prefix = item.capability_id.split(':')[0];
    if (prefix !== item.kind) {
      ctx.addIssue({
        code: 'custom',
        path: ['capability_id'],
        message: 'kind must match the capability_id prefix',
      });
    }
    // A department is only ever reported from the department source. A
    // skill is only ever reported from a skills source. This prevents a
    // caller from relabelling one as the other to widen a match.
    if (
      item.kind === 'department' &&
      item.source !== 'openclaw.departments'
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['source'],
        message: 'a department entry must come from openclaw.departments',
      });
    }
    if (item.kind === 'skill' && item.source === 'openclaw.departments') {
      ctx.addIssue({
        code: 'custom',
        path: ['source'],
        message: 'a skill entry cannot come from openclaw.departments',
      });
    }
  });

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export const capabilitySnapshotSchema = z
  .strictObject({
    schema_version: z.literal(CAPABILITY_SNAPSHOT_SCHEMA),
    installation_id: bounded(200),
    captured_at: nonEmpty.max(10).regex(DATE_RE, 'captured_at must be YYYY-MM-DD'),
    basis: z.enum(['at_sitting', 'at_export']),
    items: z
      .array(capabilitySnapshotItemSchema)
      .max(CAPABILITY_SNAPSHOT_LIMITS.max_items),
    limitations: z
      .array(bounded(CAPABILITY_SNAPSHOT_LIMITS.max_limitation_text))
      .max(CAPABILITY_SNAPSHOT_LIMITS.max_limitations),
  })
  .superRefine((snapshot, ctx) => {
    const seen = new Set<string>();
    for (const [index, item] of snapshot.items.entries()) {
      if (seen.has(item.capability_id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['items', index, 'capability_id'],
          message: 'duplicate capability_id makes exact matching ambiguous',
        });
      }
      seen.add(item.capability_id);
    }
  });

export type InstallationCapabilityEntry = z.infer<
  typeof capabilitySnapshotItemSchema
>;
export type InstallationCapabilitySnapshot = z.infer<
  typeof capabilitySnapshotSchema
>;

export type CapabilitySnapshotErrorCode =
  | 'CAPABILITY_SNAPSHOT_INVALID'
  | 'CAPABILITY_SNAPSHOT_MISMATCH'
  | 'CAPABILITY_SNAPSHOT_TOO_LARGE';

export class CapabilitySnapshotError extends Error {
  readonly code: CapabilitySnapshotErrorCode;

  constructor(code: CapabilitySnapshotErrorCode, message: string) {
    super(message);
    this.name = 'CapabilitySnapshotError';
    this.code = code;
  }
}

/** Parse an untrusted snapshot; a refusal names the exact contract error. */
export function validateCapabilitySnapshot(
  raw: unknown,
): InstallationCapabilitySnapshot {
  const parsed = capabilitySnapshotSchema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new CapabilitySnapshotError(
      'CAPABILITY_SNAPSHOT_INVALID',
      `The capability snapshot is not valid ${CAPABILITY_SNAPSHOT_SCHEMA}: ${
        first
          ? `${first.path.join('.') || 'payload'}: ${first.message}`
          : 'unknown validation failure'
      }`,
    );
  }
  return parsed.data;
}

/** The report refuses a snapshot from another installation (fail closed). */
export function assertSnapshotInstallation(
  snapshot: InstallationCapabilitySnapshot,
  installationId: string | null | undefined,
): void {
  if (!installationId) {
    throw new CapabilitySnapshotError(
      'CAPABILITY_SNAPSHOT_MISMATCH',
      'A capability snapshot was supplied without the report installation binding.',
    );
  }
  if (snapshot.installation_id !== installationId) {
    throw new CapabilitySnapshotError(
      'CAPABILITY_SNAPSHOT_MISMATCH',
      'The capability snapshot belongs to a different installation than this council scope; it was refused and no inventory was used.',
    );
  }
}

// ---------------------------------------------------------------------
// Grounded matching to the plan
// ---------------------------------------------------------------------

export interface PlanProposalReference {
  action_id: string;
  title: string;
  description: string;
  department_id?: string | null;
  assigned_agent_id?: string | null;
  sop_id?: string | null;
  persona_id?: string | null;
}

export type CapabilityMatchBasis =
  | 'recorded_reference'
  | 'named_in_step'
  | 'mixed';

export interface CapabilityMatchedAction {
  action_id: string;
  action_title: string;
  basis: 'recorded_reference' | 'named_in_step';
  evidence: string[];
}

export interface CapabilityPlanMatch extends InstallationCapabilityEntry {
  matched_action_ids: string[];
  matched_action_titles: string[];
  match_basis: CapabilityMatchBasis;
  match_evidence: string[];
  matched_actions: CapabilityMatchedAction[];
  recorded_reference_action_ids: string[];
  named_in_step_action_ids: string[];
}

/** A named match must be long enough to be a real capability name. */
const MIN_NAMED_CAPABILITY_CHARS = 8;

function normalizeName(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLowerCase();
}

function nameSlug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function bareId(capabilityId: string): string {
  return capabilityId.split(':')[1] ?? capabilityId;
}

/**
 * Recorded-reference matching is deliberately KIND-SCOPED. A plan's
 * department or assigned-agent reference may only name a department
 * capability; it can never be satisfied by a same-named skill. SOP and
 * persona ids are recorded plan references but have no capability kind in
 * this contract, so they never produce a recorded match.
 */
function referenceCandidates(proposal: PlanProposalReference): string[] {
  return [proposal.department_id, proposal.assigned_agent_id].filter(
    (value): value is string =>
      typeof value === 'string' && value.trim().length > 0,
  );
}

function referencesEntry(
  proposal: PlanProposalReference,
  entry: InstallationCapabilityEntry,
): string[] {
  if (entry.kind !== 'department') return [];
  const slug = nameSlug(entry.name);
  const id = entry.capability_id.toLowerCase();
  const bare = bareId(id);
  const hits: string[] = [];
  for (const ref of referenceCandidates(proposal)) {
    const normalized = ref.trim().toLowerCase();
    if (
      normalized === id ||
      normalized === bare ||
      normalized === slug ||
      normalized === `dept-${slug}` ||
      normalized === `dept-${bare}`
    ) {
      hits.push(ref);
    }
  }
  return hits;
}

/**
 * Whole-phrase, case-insensitive presence: the capability's exact name or
 * id appears in the step text with a non-alphanumeric boundary on each
 * side. A stem, a partial word, or a shared adjective never counts.
 */
function containsExactPhrase(haystack: string, needle: string): boolean {
  const phrase = needle.trim().toLowerCase();
  if (phrase.length < MIN_NAMED_CAPABILITY_CHARS) return false;
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, 'i').test(haystack);
}

function namedEntryInStep(
  proposal: PlanProposalReference,
  entry: InstallationCapabilityEntry,
): string | null {
  const stepText = `${proposal.title} ${proposal.description}`;
  const candidates = [
    entry.name,
    bareId(entry.capability_id),
    entry.capability_id,
  ].filter((value) => value.trim() !== '');
  for (const candidate of candidates) {
    if (containsExactPhrase(stepText, candidate)) return candidate;
  }
  return null;
}

/**
 * Match installed capabilities to plan steps. Two verified bases only:
 * a recorded reference on the action proposal, or the exact capability
 * name/slug/id as a whole phrase in the step text. The basis is recorded
 * PER STEP; a capability whose steps split between the two bases reports
 * `mixed`. There is no token overlap, no scoring, and no model call.
 */
export function matchCapabilitiesToPlan(
  snapshot: InstallationCapabilitySnapshot,
  proposals: readonly PlanProposalReference[],
): CapabilityPlanMatch[] {
  if (proposals.length === 0) return [];
  const matches: CapabilityPlanMatch[] = [];
  for (const entry of snapshot.items) {
    const matchedActions: CapabilityMatchedAction[] = [];
    const evidence = new Set<string>();
    for (const proposal of proposals) {
      const refs = referencesEntry(proposal, entry);
      const named = namedEntryInStep(proposal, entry);
      if (refs.length === 0 && named === null) continue;
      const basis: CapabilityMatchedAction['basis'] =
        refs.length > 0 ? 'recorded_reference' : 'named_in_step';
      const actionEvidence = refs.map(
        (ref) => `${proposal.action_id}: recorded reference ${ref}`,
      );
      if (named !== null) {
        actionEvidence.push(`${proposal.action_id}: step names "${named}"`);
      }
      for (const line of actionEvidence) evidence.add(line);
      matchedActions.push({
        action_id: proposal.action_id,
        action_title: proposal.title,
        basis,
        evidence: actionEvidence,
      });
    }
    if (matchedActions.length === 0) continue;
    const recorded = matchedActions
      .filter((action) => action.basis === 'recorded_reference')
      .map((action) => action.action_id);
    const namedOnly = matchedActions
      .filter((action) => action.basis === 'named_in_step')
      .map((action) => action.action_id);
    const basis: CapabilityMatchBasis =
      recorded.length > 0 && namedOnly.length > 0
        ? 'mixed'
        : recorded.length > 0
          ? 'recorded_reference'
          : 'named_in_step';
    matches.push({
      ...entry,
      matched_action_ids: matchedActions.map((action) => action.action_id),
      matched_action_titles: matchedActions.map((action) => action.action_title),
      match_basis: basis,
      match_evidence: [...evidence].sort(),
      matched_actions: matchedActions,
      recorded_reference_action_ids: recorded,
      named_in_step_action_ids: namedOnly,
    });
  }
  const rank: Record<CapabilityMatchBasis, number> = {
    recorded_reference: 0,
    mixed: 1,
    named_in_step: 2,
  };
  matches.sort((a, b) => {
    if (a.match_basis !== b.match_basis) {
      return rank[a.match_basis] - rank[b.match_basis];
    }
    if (a.matched_action_ids.length !== b.matched_action_ids.length) {
      return b.matched_action_ids.length - a.matched_action_ids.length;
    }
    if (a.kind !== b.kind) return a.kind === 'department' ? -1 : 1;
    const byName = a.name.localeCompare(b.name);
    return byName !== 0 ? byName : a.capability_id.localeCompare(b.capability_id);
  });
  return matches;
}

export interface CapabilityReportSection {
  status: 'matched' | 'unmatched' | 'not_provided';
  schema_version: typeof CAPABILITY_SNAPSHOT_SCHEMA;
  snapshot: {
    installation_id: string;
    captured_at: string;
    basis: 'at_sitting' | 'at_export';
    item_count: number;
  } | null;
  matches: CapabilityPlanMatch[];
  matched_count: number;
  no_match_note: string | null;
  availability_note: string;
  limitations: string[];
  exactness_note: string;
  note: string;
}

/**
 * The one projection both the client screens and every report format use.
 * With no snapshot the answer is an explicit `not_provided` state, never a
 * zero-match result that reads like "the client has none of these".
 */
export function buildCapabilityReportSection(
  snapshot: InstallationCapabilitySnapshot | null,
  proposals: readonly PlanProposalReference[],
): CapabilityReportSection {
  const exactnessNote =
    'Only a recorded plan reference or the capability exact name, slug, or id as a whole phrase counts. Shared words, prefixes, and fuzzy similarity are never matches.';
  if (snapshot === null) {
    return {
      status: 'not_provided',
      schema_version: CAPABILITY_SNAPSHOT_SCHEMA,
      snapshot: null,
      matches: [],
      matched_count: 0,
      no_match_note: null,
      availability_note:
        'No installed capability snapshot was recorded for this installation, so no installed skill or department is claimed.',
      limitations: [],
      exactness_note: exactnessNote,
      note:
        'No installation capability snapshot was recorded. The Command Center does not read another box and does not guess an inventory; this section is unverified.',
    };
  }
  const matches = matchCapabilitiesToPlan(snapshot, proposals);
  return {
    status: matches.length > 0 ? 'matched' : 'unmatched',
    schema_version: CAPABILITY_SNAPSHOT_SCHEMA,
    snapshot: {
      installation_id: snapshot.installation_id,
      captured_at: snapshot.captured_at,
      basis: snapshot.basis,
      item_count: snapshot.items.length,
    },
    matches,
    matched_count: matches.length,
    no_match_note:
      matches.length === 0
        ? 'No installed skill or department matched any plan step by exact reference, exact name, exact slug, or exact id. This is an absence of an exact match, not a judgement that the work cannot be done.'
        : null,
    availability_note:
      'Available means installed on this installation. It is not an operational claim: a matching capability is optional assistance, never a promise that it can execute the step.',
    limitations: [...snapshot.limitations],
    exactness_note: exactnessNote,
    note:
      matches.length > 0
        ? `${matches.length} installed capability match(es) were found by exact reference or exact whole-phrase name. Nothing was inferred from shared vocabulary.`
        : 'The snapshot is present, but no exact match was found. No capability is claimed.',
  };
}
