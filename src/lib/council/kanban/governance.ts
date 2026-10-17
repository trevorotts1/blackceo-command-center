/**
 * CWE-035 governance registration (Section 19.4, T086).
 *
 * The council parent and its plan tasks sit behind the board's existing
 * preparation and Triad gates, so the SOP and persona they name must be
 * real, resolvable records, never invented strings:
 *
 * - The Council deliberation SOP is registered in the host `sops` table
 *   through the same idempotent slug-keyed insert the starter-SOP seed
 *   procedure uses (src/lib/sops-seed.ts). The sops registry is
 *   installation-wide (its slug is globally unique; the table carries no
 *   company column), so a registered SOP resolves for every company on
 *   the installation, including the parent task's company.
 * - The Council chair governance persona lives in the persona catalog
 *   (persona-categories.json) owned by the Skill 22 persona system and
 *   loaded by src/lib/persona-library.ts from machine-level paths. This
 *   layer cannot honestly write that catalog, so registration here means
 *   RESOLUTION: the status reports whether the persona id is known to
 *   the installed catalog. Adding the catalog entry on a target
 *   installation is a named CWE-050 step (see the CWE-035 build report).
 *   Nothing in this layer fabricates a persona or pins one to a task.
 */
import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { isKnownPersonaId } from '@/lib/persona-library';

export const COUNCIL_DELIBERATION_SOP_SLUG = 'council-deliberation';
export const COUNCIL_DELIBERATION_SOP_NAME = 'Council deliberation';
export const COUNCIL_CHAIR_GOVERNANCE_PERSONA_ID = 'council-chair-governance';

const COUNCIL_DELIBERATION_STEPS = [
  {
    name: 'Convene the session',
    checklist: [
      'Decision brief frozen and hashed before openings',
      'Seats and model route resolved from the client selection or configured default',
      'Single canonical parent task linked for company sessions',
    ],
    success_criteria: 'Session exists with a frozen brief and a linked parent task',
  },
  {
    name: 'Collect advisor cards',
    checklist: [
      'Every seated advisor submits a schema-valid card',
      'Cards bind to the frozen brief revision and input manifest hash',
    ],
    success_criteria: 'All seated cards accepted or the session visibly blocks',
  },
  {
    name: 'Cross-examination and crux review',
    checklist: [
      'Challenges answered or carried as critical unknowns',
      'Cruxes identified before any resolution is drafted',
    ],
    success_criteria: 'No unresolved challenge is silently dropped',
  },
  {
    name: 'Draft and ratify the resolution',
    checklist: [
      'Draft resolution frozen by hash before ratification',
      'Ratification cards bind to the exact frozen draft',
    ],
    success_criteria: 'Ratified resolution hash matches the frozen draft',
  },
  {
    name: 'Validate the verdict and propose actions',
    checklist: [
      'Verdict passes deterministic validation',
      'Action proposals cite conditions and carry explicit budgets',
      'No action executes under the advisory verdict',
    ],
    success_criteria: 'Validated verdict with hash-bound action proposals',
  },
  {
    name: 'Deliver the advisory',
    checklist: [
      'Parent task projection reflects the delivered state',
      'Plan approval and execution remain separate owner authorizations',
    ],
    success_criteria: 'Advisory delivered; nothing dispatched by the council itself',
  },
];

export interface CouncilSopRegistration {
  sop_id: string;
  slug: string;
  created: boolean;
}

export interface CouncilPersonaRegistration {
  persona_id: string;
  /** True only when the installed persona catalog contains the id. */
  registered: boolean;
}

export interface CouncilGovernanceRegistration {
  sop: CouncilSopRegistration;
  persona: CouncilPersonaRegistration;
}

/**
 * Idempotently register the Council deliberation SOP in the host sops
 * registry, following the starter-seed pattern (slug existence check,
 * then insert). Safe to call on every parent creation.
 */
export function ensureCouncilDeliberationSop(
  db: Database.Database,
  now: string = new Date().toISOString(),
): CouncilSopRegistration {
  const existing = db
    .prepare('SELECT id FROM sops WHERE slug = ?')
    .get(COUNCIL_DELIBERATION_SOP_SLUG) as { id: string } | undefined;
  if (existing) {
    return { sop_id: existing.id, slug: COUNCIL_DELIBERATION_SOP_SLUG, created: false };
  }
  const id = randomUUID();
  db.prepare(
    `INSERT INTO sops (id, name, slug, description, version, department, task_keywords, steps, success_criteria, persona_hints, created_at, updated_at)
     VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    COUNCIL_DELIBERATION_SOP_NAME,
    COUNCIL_DELIBERATION_SOP_SLUG,
    'Chair-governed deliberation of a Council of Wise Elders session: convene, collect advisor cards, cross-examine, ratify, validate the verdict, and deliver the advisory. Process governance only; it never replaces a department SOP for downstream action work.',
    null,
    'council,deliberation,wise elders,advisory,verdict',
    JSON.stringify(COUNCIL_DELIBERATION_STEPS),
    'A validated verdict is delivered as advice; action plans stay held until the owner approves them and a separate execution grant exists.',
    JSON.stringify([COUNCIL_CHAIR_GOVERNANCE_PERSONA_ID]),
    now,
    now,
  );
  return { sop_id: id, slug: COUNCIL_DELIBERATION_SOP_SLUG, created: true };
}

/** Resolve (never fabricate) the Council chair governance persona. */
export function councilGovernancePersonaStatus(): CouncilPersonaRegistration {
  return {
    persona_id: COUNCIL_CHAIR_GOVERNANCE_PERSONA_ID,
    registered: isKnownPersonaId(COUNCIL_CHAIR_GOVERNANCE_PERSONA_ID),
  };
}

/** Register the SOP and resolve the governance persona in one call. */
export function ensureCouncilGovernance(
  db: Database.Database,
  now: string = new Date().toISOString(),
): CouncilGovernanceRegistration {
  return {
    sop: ensureCouncilDeliberationSop(db, now),
    persona: councilGovernancePersonaStatus(),
  };
}
