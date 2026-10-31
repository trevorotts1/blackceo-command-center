/**
 * Client capability handoff contract (CTR-163; audit rows FX-042,
 * FX-035, FX-056).
 *
 * The Command Center server runs in the tenant's host. It cannot read
 * the operator's or client's own box to discover which skills and
 * tools are installed there, and it must never pretend it can. This
 * module is the typed boundary for the client to hand its own
 * installation facts over:
 *
 *   - the payload is strict (unknown fields are refused);
 *   - it is bound to the authenticated owner and to the exact
 *     tenant/company/installation the server already resolved — a
 *     client cannot claim another box's inventory;
 *   - matching is EXACT. A requirement matches one item only when the
 *     skill id is identical, or (when no id is recorded) the normalized
 *     name is identical. Shared tokens, prefixes, and fuzzy overlap are
 *     never matches;
 *   - an empty or absent handoff yields "not verified", never an
 *     assumed inventory and never a fabricated tool list.
 *
 * There is no upload route yet: the capabilities endpoint advertises
 * this contract with integration status 'not_integrated' so the gap is
 * visible rather than papered over.
 */

import { z } from 'zod';

export const CAPABILITY_HANDOFF_CONTRACT =
  'wise-elders.client-capability-handoff/v1' as const;

const nonEmpty = z.string().trim().min(1).max(512);

export const capabilityHandoffItemSchema = z.strictObject({
  /** Stable skill id when the client records one; null when it has none. */
  skill_id: nonEmpty.nullable(),
  name: nonEmpty,
  version: nonEmpty.nullable(),
  /** Client-side path, recorded for the owner only; never dereferenced here. */
  path: nonEmpty.nullable(),
});

export const capabilityHandoffSchema = z
  .strictObject({
    contract: z.literal(CAPABILITY_HANDOFF_CONTRACT),
    owner_subject: nonEmpty,
    tenant_id: nonEmpty,
    company_id: nonEmpty,
    installation_id: nonEmpty,
    captured_at: z.string().trim().min(1).max(64),
    source: z.enum(['client_upload', 'cli_export', 'manual']),
    items: z.array(capabilityHandoffItemSchema).max(2000),
  })
  .superRefine((value, ctx) => {
    const seen = new Set<string>();
    for (const [index, item] of value.items.entries()) {
      const key = `${item.skill_id ?? ''}\u0000${item.name.toLowerCase()}`;
      if (seen.has(key)) {
        ctx.addIssue({
          code: 'custom',
          path: ['items', index],
          message:
            'Duplicate skill entries make exact matching ambiguous; record each installed skill once.',
        });
      }
      seen.add(key);
    }
  });

export type CapabilityHandoff = z.infer<typeof capabilityHandoffSchema>;
export type CapabilityHandoffItem = z.infer<typeof capabilityHandoffItemSchema>;

export type CapabilityHandoffErrorCode =
  | 'CAPABILITY_HANDOFF_INVALID'
  | 'CAPABILITY_HANDOFF_SCOPE_MISMATCH'
  | 'CAPABILITY_HANDOFF_OWNER_MISMATCH';

export class CapabilityHandoffError extends Error {
  readonly code: CapabilityHandoffErrorCode;

  constructor(code: CapabilityHandoffErrorCode, message: string) {
    super(message);
    this.name = 'CapabilityHandoffError';
    this.code = code;
  }
}

export interface HandoffPrincipal {
  subject?: string | null;
  scope?: {
    tenant_id?: string | null;
    company_id?: string | null;
    installation_id?: string | null;
  } | null;
}

/** Parse an untrusted handoff payload; a refusal names the contract error. */
export function parseCapabilityHandoff(raw: unknown): CapabilityHandoff {
  const parsed = capabilityHandoffSchema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new CapabilityHandoffError(
      'CAPABILITY_HANDOFF_INVALID',
      `The capability handoff is not valid ${CAPABILITY_HANDOFF_CONTRACT}: ${
        first ? `${first.path.join('.') || 'payload'}: ${first.message}` : 'unknown validation failure'
      }`,
    );
  }
  return parsed.data;
}

/**
 * Bind a parsed handoff to the authenticated principal. The server's
 * resolved scope is authoritative; the handoff may only confirm it.
 */
export function bindCapabilityHandoff(
  principal: HandoffPrincipal,
  handoff: CapabilityHandoff,
): CapabilityHandoff {
  const scope = principal.scope ?? {};
  if (
    handoff.tenant_id !== scope.tenant_id ||
    handoff.company_id !== scope.company_id ||
    handoff.installation_id !== scope.installation_id
  ) {
    throw new CapabilityHandoffError(
      'CAPABILITY_HANDOFF_SCOPE_MISMATCH',
      'The capability handoff names a different tenant, company, or installation than the authenticated caller. It was refused and no inventory was used.',
    );
  }
  if (
    typeof principal.subject === 'string' &&
    principal.subject.length > 0 &&
    handoff.owner_subject !== principal.subject
  ) {
    throw new CapabilityHandoffError(
      'CAPABILITY_HANDOFF_OWNER_MISMATCH',
      'The capability handoff is bound to a different owner than the authenticated caller. It was refused and no inventory was used.',
    );
  }
  return handoff;
}

export interface SkillRequirement {
  /** Exact skill id, when the plan recorded one. */
  skill_id?: string | null;
  /** Exact skill name, used only when no id was recorded. */
  name?: string | null;
}

export interface ExactMatchResult {
  requirement: SkillRequirement;
  matches: CapabilityHandoffItem[];
  exact: true;
}

function normalizeName(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * Match one requirement against the handed-over inventory. Exact id
 * equality wins; otherwise the normalized names must be equal. A
 * requirement with neither id nor name is refused rather than matched
 * against everything.
 */
export function matchSkillExactly(
  requirement: SkillRequirement,
  handoff: CapabilityHandoff,
): ExactMatchResult {
  const skillId =
    typeof requirement.skill_id === 'string' && requirement.skill_id.trim().length > 0
      ? requirement.skill_id.trim()
      : null;
  const name =
    typeof requirement.name === 'string' && requirement.name.trim().length > 0
      ? requirement.name
      : null;
  if (skillId === null && name === null) {
    throw new CapabilityHandoffError(
      'CAPABILITY_HANDOFF_INVALID',
      'A skill requirement must record a skill id or a name; an empty requirement cannot be matched.',
    );
  }
  const matches = handoff.items.filter((item) => {
    if (skillId !== null) return item.skill_id === skillId;
    return normalizeName(item.name) === normalizeName(name as string);
  });
  return {
    requirement: {
      skill_id: skillId,
      name: skillId === null ? (name as string) : null,
    },
    matches,
    exact: true,
  };
}

export interface CapabilityMatchReport {
  status: 'matched' | 'partial' | 'unmatched' | 'not_provided';
  exact_only: true;
  requirements: number;
  matched_requirements: number;
  matches: ExactMatchResult[];
  unmatched: SkillRequirement[];
  note: string;
}

/**
 * Match every plan requirement. With no handoff the answer is an
 * explicit 'not_provided' state, never a zero-match result that reads
 * like "the client has none of these".
 */
export function matchPlanCapabilities(
  requirements: readonly SkillRequirement[],
  handoff: CapabilityHandoff | null,
): CapabilityMatchReport {
  if (handoff === null) {
    return {
      status: 'not_provided',
      exact_only: true,
      requirements: requirements.length,
      matched_requirements: 0,
      matches: [],
      unmatched: [...requirements],
      note:
        'No client capability handoff was provided. The server cannot read the client installation, so installed-skill matches are unverified and no inventory is claimed.',
    };
  }
  const matches: ExactMatchResult[] = [];
  const unmatched: SkillRequirement[] = [];
  for (const requirement of requirements) {
    const result = matchSkillExactly(requirement, handoff);
    if (result.matches.length > 0) matches.push(result);
    else unmatched.push(requirement);
  }
  const status =
    unmatched.length === 0
      ? 'matched'
      : matches.length > 0
        ? 'partial'
        : 'unmatched';
  return {
    status,
    exact_only: true,
    requirements: requirements.length,
    matched_requirements: matches.length,
    matches,
    unmatched,
    note:
      status === 'matched'
        ? 'Every requirement matched an exact installed skill in the client handoff. Exact id or normalized full-name equality only.'
        : 'Only exact id or normalized full-name equality counts. Token overlap, prefixes, and fuzzy similarity are not matches.',
  };
}
