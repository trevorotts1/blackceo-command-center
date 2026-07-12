/**
 * "My AI CEO" BETA feature flag + shared config (P5-01).
 *
 * BETA posture (spec (b)/(c) step 5): feature-flagged, clearly labeled, and it
 * degrades to "use Telegram meanwhile" — it must never present a broken-looking
 * core dashboard. The flag is `MY_AI_CEO_BETA`.
 *
 * Default: ON. Per the spec, `MY_AI_CEO_BETA=true` is "default ON for the
 * operator box, rolled fleet-wide with P6-01 or the next CC release per
 * readiness (autonomous call per 2.5)." Because a repo change only reaches a
 * client box through the P6-01 roll anyway, defaulting ON here means the
 * operator box (where dev happens) gets it immediately, and the fleet gets it
 * only when the operator rolls — matching the ratified default. An operator can
 * hard-disable it on any box with `MY_AI_CEO_BETA=false`.
 */
export function isMyAiCeoBetaEnabled(): boolean {
  // Explicit opt-out only. Any value other than the literal 'false' (including
  // unset) leaves the BETA enabled.
  return process.env.MY_AI_CEO_BETA !== 'false';
}

/** The `requester_channel` value stamped on every task a ceo-chat request spawns. */
export const CEO_CHAT_CHANNEL = 'ceo-chat';
