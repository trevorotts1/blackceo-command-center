/**
 * E8: Persona-matcher feature naming.
 *
 * The persona-matcher (5-layer alignment that picks the best persona for a
 * department/role/task) is being rebranded. Until Trevor supplies the final
 * trademarked name, this PLACEHOLDER is the single source of truth for the
 * feature's display name across the Intelligence Settings UI.
 *
 * TODO(E8): replace PERSONA_MATCH_NAME with the final trademark name once
 * provided. Do NOT hardcode "Persona Match" anywhere else — import this
 * constant so the rename is a one-line change.
 */
export const PERSONA_MATCH_NAME = 'Persona Match™';

/** Short, copy-friendly description of what the feature does. */
export const PERSONA_MATCH_TAGLINE =
  'Automatically aligns each agent to the best coaching persona using company mission, goals, department objectives, task context, and agent role.';
