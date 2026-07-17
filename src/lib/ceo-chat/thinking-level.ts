/**
 * U62 (JM/U65, master E.2) — the reasoning-effort ladder for the My AI CEO
 * chat's ThinkingSelector.
 *
 * PROVED (U61/S1, `~/Downloads/skill6-u61-spike-S1-model-effort-override-
 * 2026-07-16.md`), directly, by a literal `thinking_level_change` event for
 * each row, on the live gateway (2026.6.11), never inferred from
 * documentation: the accepted-AND-LANDING effort set for
 * `ollama/deepseek-v4-flash:cloud` is exactly FOUR values —
 * `off, low, medium, high`. Two traps proved in the same pass:
 *   - `minimal` HARD-REJECTS: `Error: Thinking level "minimal" is not
 *     supported for ollama/deepseek-v4-flash:cloud. Use one of: off, low,
 *     medium, high, max.`
 *   - `max` VALIDATES at the request layer (`status: ok`,
 *     `requestShaping.thinking: "max"`, no error) but the session's own
 *     persisted trajectory records `thinking_level_change: "high"` — the
 *     gateway's own rejection-message text nominally lists `max` as
 *     "supported" and it demonstrably is not; a user who picks "Max" would
 *     silently get "High" and never be told.
 *
 * This module is the ONE place a UI selection becomes a gateway parameter, so
 * neither the literal string `"max"` nor `"minimal"` can ever leave this app.
 * Spec M.2 directs the four labels "Quick · Balanced · Deep · Max" be
 * "trimmed to gateway-accepted values per spike S1" — this is that trim: each
 * label maps 1:1 onto one of the four PROVEN values, so "Max" is honestly the
 * best level actually available (`high`), never the broken literal `"max"`.
 */

/** The U61/S1-proven accepted-and-landing set, in ladder order. Never add
 *  'minimal' or 'max' here without a NEW spike proving they land verbatim —
 *  this array is what every other gateway-facing check in this module (and
 *  gateway.ts's outbound `thinking` param) is defended against. */
export const GATEWAY_THINKING_LEVELS = ['off', 'low', 'medium', 'high'] as const;
export type GatewayThinkingLevel = (typeof GATEWAY_THINKING_LEVELS)[number];

/** The UI's four segmented-control labels (ThinkingSelector). Order matches
 *  GATEWAY_THINKING_LEVELS — index-for-index, "Quick" is the lowest tier. */
export const THINKING_LEVELS = ['Quick', 'Balanced', 'Deep', 'Max'] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

const LABEL_TO_GATEWAY: Readonly<Record<ThinkingLevel, GatewayThinkingLevel>> = {
  Quick: 'off',
  Balanced: 'low',
  Deep: 'medium',
  Max: 'high',
};

/**
 * UI label -> the real, proven gateway value. Returns null for anything that
 * is not one of the four known UI labels — this function never guesses at an
 * unrecognized label, and it never returns the raw strings "max"/"minimal"
 * because those are not members of GatewayThinkingLevel.
 */
export function toGatewayThinkingLevel(label: string): GatewayThinkingLevel | null {
  return Object.prototype.hasOwnProperty.call(LABEL_TO_GATEWAY, label)
    ? LABEL_TO_GATEWAY[label as ThinkingLevel]
    : null;
}

/**
 * Defense in depth at any API boundary that accepts a gateway-facing
 * thinking-level value directly (not through toGatewayThinkingLevel()): is
 * this exactly one of the four proven values? Rejects 'minimal' (hard
 * gateway error) and 'max' (the silent-downgrade trap) even if a caller
 * sends them literally instead of going through the UI-label mapping above.
 */
export function isValidGatewayThinkingLevel(value: unknown): value is GatewayThinkingLevel {
  return (
    typeof value === 'string' &&
    (GATEWAY_THINKING_LEVELS as readonly string[]).includes(value)
  );
}
