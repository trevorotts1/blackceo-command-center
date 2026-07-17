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
 *
 * SCOPE (added after U61 closed, root-caused independently): the ceiling
 * above and the minimal/max traps were proved SPECIFICALLY for Ollama
 * reasoning models. Root cause (openclaw's own bundled dist, read-only,
 * never this repo's code): the Ollama provider-policy plugin profile
 * DECLARES a 5th `max` tier (and is also what generates the gateway's
 * misleading rejection-message text, which nominally lists `max` as
 * "supported") — but the real wire transport (`resolveOllamaThinkValue()`)
 * and an independent `thinkingLevelMap`-driven resolver BOTH collapse
 * `max`/`xhigh`/`adaptive` to `high`, because Ollama's own `/api/chat`
 * surface has nothing above `high` for any of them to mean. That plugin
 * profile lives in the `openclaw` npm package (not this repo) and is not
 * fixed by this unit. `isOllamaReasoningFamily()` below is the gate that
 * keeps the LIVE ThinkingSelector scoped to what was actually verified —
 * nothing was proved for any other provider's reasoning models, so a
 * 'reasoning'-tagged non-Ollama model gets an honest "not yet verified"
 * degrade (`computeThinkingDisabledState()`) instead of silently inheriting
 * an unproven ceiling. CC has no dependency on the `openclaw` npm package
 * and no import path to its `listThinkingLevelOptions()`/
 * `formatThinkingLevels()` catalog functions (verified: `package.json` has
 * no `openclaw` dependency) — this module's four-value set is NOT filtered
 * from that catalog (which lies for Ollama) because CC cannot reach it at
 * all; it is derived directly from U61's live-proven evidence instead. CC's
 * OWN model_registry.capabilities vocabulary (`model-registry-types.ts`) has
 * no thinking-level granularity either — 'reasoning' is a flat boolean tag,
 * not a per-model value list — so there is no local "lying catalog" risk to
 * filter against here.
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

/**
 * Is this model id from the Ollama family? Mirrors the SAME prefix
 * vocabulary `src/lib/model-selector.ts`'s `tierOf()` already uses for the
 * identical family (not imported — `tierOf()` is a private, unexported
 * helper; duplicating three prefix checks is cheaper and less coupling than
 * exporting an internal sovereignty-filter helper for an unrelated purpose).
 * This is the ONLY class of model U61/S1 (+ the independent root-cause
 * read above) actually verified the {off,low,medium,high} ceiling for.
 */
export function isOllamaReasoningFamily(modelId: string): boolean {
  return (
    modelId.startsWith('ollama-cloud/') ||
    modelId.startsWith('ollama-local/') ||
    modelId.startsWith('ollama/')
  );
}

/** Shown whenever a control is locked because a reply is streaming — shared
 *  across ThinkingSelector/ModelPicker/AgentPicker so the copy never drifts
 *  between the three. */
export const STREAMING_LOCK_REASON = 'Locked while your AI CEO is replying.';

export interface ThinkingDisabledState {
  disabled: boolean;
  reason?: string;
}

/** Minimal structural shape this function needs from a ModelOption
 *  (`src/components/ceo-chat/types.ts`) — declared locally rather than
 *  imported to avoid a circular import (types.ts already re-exports
 *  THINKING_LEVELS from this module). Any real ModelOption satisfies this
 *  structurally. */
interface ThinkingCapableModel {
  model_id: string;
  capabilities: string[];
}

/**
 * The ONE place ThinkingSelector's disabled/reason pair is decided, so
 * page.tsx never re-derives this logic untested. Precedence, most specific
 * degrade first:
 *   1. streaming — locked mid-reply (spec M.3: "all controls disable from
 *      first streamed token until done/gateway_down").
 *   2. no model resolved yet (mount-time loading window) — enabled by
 *      default; a brief loading state must never read as a false-negative
 *      degrade.
 *   3. the model has no `reasoning` capability tag at all.
 *   4. the model has `reasoning` but is NOT Ollama-family — the proven
 *      ceiling was never verified for it; degrade honestly rather than
 *      assume.
 *   5. otherwise (Ollama-family, `reasoning`-tagged, not streaming): enabled.
 */
export function computeThinkingDisabledState(
  model: ThinkingCapableModel | null,
  streaming: boolean,
): ThinkingDisabledState {
  if (streaming) return { disabled: true, reason: STREAMING_LOCK_REASON };
  if (!model) return { disabled: false, reason: undefined };
  if (!model.capabilities.includes('reasoning')) {
    return { disabled: true, reason: 'This model does not support adjustable reasoning effort.' };
  }
  if (!isOllamaReasoningFamily(model.model_id)) {
    return {
      disabled: true,
      reason: "This model's reasoning-effort levels have not been verified against the live gateway.",
    };
  }
  return { disabled: false, reason: undefined };
}
