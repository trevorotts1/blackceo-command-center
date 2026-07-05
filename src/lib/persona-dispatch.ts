/**
 * persona-dispatch.ts — the ONE place a dispatch message's persona block is built.
 *
 * FOUNDATION train FDN-3 / finding F4.1 (the single most valuable fix in the
 * persona system): both dispatch paths — `src/lib/task-dispatcher.ts`
 * (fast-loop auto-dispatch) and `src/app/api/tasks/[id]/dispatch/route.ts`
 * (operator-click dispatch) — used to render `settings.persona` and, when it was
 * the string `'auto'`, a block of prose telling the DOER to "AUTO-SELECT. Run the
 * 5-Layer Persona Matching Protocol before starting". That prose duplicated and
 * CONTRADICTED the persona the selector already matched and stored on the task
 * row (`tasks.persona_id / .persona_name / .persona_mode`). The computed match
 * never reached the doer.
 *
 * This module deletes that AUTO-SELECT prose and instead DELIVERS the matched
 * persona: it reads the task row's persona identity and emits the same Section-4
 * (A–D) + §7B load contract that `persona-matching-protocol.md` Step 5 defines —
 * but with the id already resolved, never self-selected.
 *
 * Fail-closed consumer (Skill-23 SOP-07 posture): every branch of
 * `buildPersonaBlock` returns a concrete persona OR an explicit governance
 * oversight pointer. It NEVER emits `'auto'`, NEVER emits a self-selection
 * protocol, and NEVER returns an empty block — a task is never dispatched
 * "naked". When selection has not landed yet, the doer is governed by the house
 * governance persona rather than told to invent one.
 *
 * Both callers import `buildPersonaBlock` so the two dispatch messages are
 * guaranteed byte-identical for the persona section (the message spec is
 * declared "identical spec to dispatch/route.ts" in task-dispatcher.ts).
 */

import type { ResolvedSettings } from './intelligence-resolver';

/**
 * Governance oversight pointer for mechanical / operational tasks
 * (`no_persona_required: true`). Mirrors `GOVERNANCE_PERSONA_FALLBACK` in
 * `persona-selector-v2.py` (q1 resolved decision). A `chmod` does not need
 * coaching — but it still runs under principle-centered operating discipline.
 * Resolution order for a mechanical task: the selector-supplied
 * `task.governance_persona_id` (which itself honors any per-client
 * `company-config.json.governance_persona_id` override) → this constant.
 */
export const GOVERNANCE_PERSONA_FALLBACK = 'covey-7-habits';

/** Interaction mode string used when the task row / settings carry none. */
const DEFAULT_PERSONA_MODE = 'leadership';

/**
 * Workspace-relative path to a persona's blueprint. Matches the coaching-personas
 * skill layout the doer's workspace installs (see the `coaching-personas/...`
 * resolution in `src/app/api/personas/route.ts`). Kept relative on purpose so the
 * doer resolves it against its OWN workspace, never an operator-absolute path.
 */
export function personaBlueprintPath(personaId: string): string {
  return `coaching-personas/personas/${personaId}/persona-blueprint.md`;
}

/**
 * Minimal task shape this module reads. All fields optional/nullable so it is
 * tolerant of older DB rows (persona columns absent) and of columns added by
 * sibling foundation trains (`no_persona_required`, `governance_persona_id`,
 * `secondary_persona_*`) that may not exist yet on every box.
 */
export interface PersonaDispatchTask {
  persona_id?: string | null;
  persona_name?: string | null;
  persona_mode?: string | null;
  /** Hybrid blend: supporting persona surfaced alongside the primary. */
  secondary_persona_id?: string | null;
  secondary_persona_name?: string | null;
  /** Selector flag: a mechanical/operational task that needs no full persona. */
  no_persona_required?: boolean | number | null;
  /** Selector-supplied governance oversight pointer for mechanical tasks. */
  governance_persona_id?: string | null;
}

type PersonaSettings = Pick<
  ResolvedSettings,
  'persona' | 'personaSource' | 'personaMode'
>;

/** SQLite stores booleans as 0/1; a JSON fixture may send a real boolean. */
function isTruthy(v: boolean | number | null | undefined): boolean {
  return v === true || v === 1;
}

/**
 * The mandatory Task-Mode load contract — identical to
 * `persona-matching-protocol.md` Step 5, but the id is already resolved so the
 * doer OPERATES as the persona instead of re-selecting one.
 */
function loadContract(personaId: string, mode: string): string {
  return `**Persona load contract (MANDATORY — before any work):**
1. Read the blueprint: ${personaBlueprintPath(personaId)}
2. Internalize Section 4 (A–D) and §7B — this is the voice, methodology, and decision lens you operate under for THIS task.
3. If PERSONA-ROUTER.md flags this persona for an appendix, ALSO load its [+APPENDIX] block.
Operate AS this persona (${mode} mode). Do NOT run any self-selection protocol — the persona is already assigned.`;
}

/** Full-persona block: header line + load contract + optional hybrid secondary. */
function primaryBlock(opts: {
  label: string;
  personaId: string;
  personaName: string;
  mode: string;
  secondaryId?: string | null;
  secondaryName?: string | null;
}): string {
  const { label, personaId, personaName, mode, secondaryId, secondaryName } = opts;
  let block = `**Persona (${label}):** ${personaName} (${personaId}, ${mode} mode)
${loadContract(personaId, mode)}`;
  if (secondaryId) {
    const secName = secondaryName || secondaryId;
    block += `
**Secondary persona (hybrid blend):** ${secName} (${secondaryId}) — supporting voice only; blend per §7B while ${personaName} leads.`;
  }
  return block;
}

/** Mechanical / unresolved block: a governance oversight pointer, never a load. */
function governanceBlock(governanceId: string, opts?: { unresolved?: boolean }): string {
  if (opts?.unresolved) {
    return `**Persona:** not yet resolved — governing under the house fallback.
**Governance oversight:** ${governanceId} — apply as a light operating-discipline pointer only; do NOT load a full Section-4 persona. Escalate if this task genuinely needs a specialist voice.`;
  }
  return `**Persona:** none required — this is a mechanical / operational task.
**Governance oversight:** ${governanceId} — apply as a light operating-discipline pointer only; do NOT load a full Section-4 persona.`;
}

/**
 * Build the persona section for a dispatch message.
 *
 * Precedence (highest first):
 *   1. Mechanical (`no_persona_required`)  → governance oversight pointer.
 *   2. Operator lock (agent_settings pinned a specific, non-`auto` persona via
 *      `role_override` / `department_default`) → that persona wins, hard.
 *   3. Matched persona on the task row (`persona_id`) → THE F4.1 fix; full load
 *      contract, plus a hybrid secondary when the selector surfaced one.
 *   4. Resolver-supplied persona with no task id (sticky assignment, etc.) →
 *      still a real, non-`auto` persona; render it with the load contract.
 *   5. Nothing resolved → governance fallback pointer (never naked, never
 *      `'auto'`, never a self-selection protocol).
 */
export function buildPersonaBlock(
  task: PersonaDispatchTask,
  settings: PersonaSettings,
): string {
  // 1. Mechanical task — truthful `no_persona_required` + governance pointer.
  if (isTruthy(task.no_persona_required)) {
    const governanceId = task.governance_persona_id || GOVERNANCE_PERSONA_FALLBACK;
    return governanceBlock(governanceId);
  }

  // 2. Operator lock — an operator explicitly pinned a persona in agent_settings.
  //    This is the ONLY role agent_settings.persona still plays: a hard override
  //    lock, never the default source. `'auto'` no longer means "self-select" —
  //    it means "defer to the task's matched persona" (branch 3+).
  const operatorLocked =
    !!settings.persona &&
    settings.persona !== 'auto' &&
    (settings.personaSource === 'role_override' ||
      settings.personaSource === 'department_default');
  if (operatorLocked) {
    return primaryBlock({
      label: 'operator-locked',
      personaId: settings.persona,
      personaName: settings.persona,
      mode: settings.personaMode || DEFAULT_PERSONA_MODE,
    });
  }

  // 3. THE F4.1 FIX — deliver the persona the selector matched onto the task row.
  if (task.persona_id) {
    return primaryBlock({
      label: 'assigned',
      personaId: task.persona_id,
      personaName: task.persona_name || task.persona_id,
      mode: task.persona_mode || settings.personaMode || DEFAULT_PERSONA_MODE,
      secondaryId: task.secondary_persona_id,
      secondaryName: task.secondary_persona_name,
    });
  }

  // 4. Resolver landed a real persona (e.g. sticky assignment) without a task id.
  if (settings.persona && settings.persona !== 'auto') {
    return primaryBlock({
      label: 'assigned',
      personaId: settings.persona,
      personaName: settings.persona,
      mode: settings.personaMode || DEFAULT_PERSONA_MODE,
    });
  }

  // 5. Never naked, never AUTO-SELECT — govern under the house fallback.
  return governanceBlock(GOVERNANCE_PERSONA_FALLBACK, { unresolved: true });
}
