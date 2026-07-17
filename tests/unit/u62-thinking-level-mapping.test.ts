/**
 * U62 (JM/U65, master E.2) — thinking-level UI-label -> gateway-value mapping.
 *
 * U61/S1 (spike evidence, `~/Downloads/skill6-u61-spike-S1-model-effort-
 * override-2026-07-16.md`) directly, verbatim-proved the accepted-AND-LANDING
 * effort set for `ollama/deepseek-v4-flash:cloud` on this gateway version
 * (2026.6.11) is exactly FOUR values: `off, low, medium, high` — each
 * confirmed by an isolated `thinking_level_change` event matching the
 * request. Two traps proved in the SAME pass:
 *   - `minimal` HARD-REJECTS (gateway error, verbatim).
 *   - `max` VALIDATES (no error, `requestShaping.thinking:"max"`) but the
 *     session's own persisted event silently records `"high"` — a user who
 *     picks "Max" silently gets "High" and is never told.
 *
 * This module is the ONE place the UI's four labels (Quick/Balanced/Deep/Max)
 * are translated to a gateway value, so gateway.ts can never accidentally
 * send the literal strings "max" or "minimal". Fail-first: this module does
 * not exist pre-U62.
 */
import { describe, it, expect } from 'vitest';
import {
  GATEWAY_THINKING_LEVELS,
  THINKING_LEVELS,
  toGatewayThinkingLevel,
  isValidGatewayThinkingLevel,
} from '../../src/lib/ceo-chat/thinking-level';

describe('GATEWAY_THINKING_LEVELS — the U61/S1-proven accepted-and-landing set', () => {
  it('is exactly the four directly-proven values, in ladder order', () => {
    expect(GATEWAY_THINKING_LEVELS).toEqual(['off', 'low', 'medium', 'high']);
  });

  it('never contains the hard-rejected value "minimal"', () => {
    expect(GATEWAY_THINKING_LEVELS).not.toContain('minimal');
  });

  it('never contains the silent-downgrade trap value "max"', () => {
    expect(GATEWAY_THINKING_LEVELS).not.toContain('max');
  });
});

describe('toGatewayThinkingLevel() — UI label -> proven gateway value', () => {
  it('maps every one of the four UI labels to a distinct proven gateway value', () => {
    const mapped = THINKING_LEVELS.map((label) => toGatewayThinkingLevel(label));
    expect(mapped).toEqual(['off', 'low', 'medium', 'high']);
    // Distinct — no two UI labels silently collapse onto the same gateway value.
    expect(new Set(mapped).size).toBe(4);
  });

  it('the "Max" label maps to "high" — never the literal broken string "max"', () => {
    expect(toGatewayThinkingLevel('Max')).toBe('high');
    expect(toGatewayThinkingLevel('Max')).not.toBe('max');
  });

  it('returns null for any label outside the known four (never guesses)', () => {
    expect(toGatewayThinkingLevel('Ultra')).toBeNull();
    expect(toGatewayThinkingLevel('')).toBeNull();
    expect(toGatewayThinkingLevel('max')).toBeNull(); // lowercase raw gateway string is not a UI label
  });
});

describe('isValidGatewayThinkingLevel() — API-boundary defense in depth', () => {
  it('accepts exactly the four proven values', () => {
    for (const v of GATEWAY_THINKING_LEVELS) {
      expect(isValidGatewayThinkingLevel(v)).toBe(true);
    }
  });

  it('rejects "minimal" (hard gateway rejection, verbatim-proved)', () => {
    expect(isValidGatewayThinkingLevel('minimal')).toBe(false);
  });

  it('rejects "max" (the silent-downgrade trap — must never reach the gateway from this app)', () => {
    expect(isValidGatewayThinkingLevel('max')).toBe(false);
  });

  it('rejects non-string and unrecognized values', () => {
    expect(isValidGatewayThinkingLevel(undefined)).toBe(false);
    expect(isValidGatewayThinkingLevel(null)).toBe(false);
    expect(isValidGatewayThinkingLevel(42)).toBe(false);
    expect(isValidGatewayThinkingLevel('xhigh')).toBe(false);
    expect(isValidGatewayThinkingLevel('adaptive')).toBe(false);
  });
});
