/**
 * P5-01 — My AI CEO BETA feature flag.
 *
 * Default ON (per spec (c) step 5, MY_AI_CEO_BETA default ON for the operator
 * box); hard-disable only on the literal 'false'. Read at call time (never a
 * module const) so a route re-reads the current env.
 *
 * Fail-first: src/lib/ceo-chat/config.ts does not exist pre-P5-01.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { isMyAiCeoBetaEnabled, CEO_CHAT_CHANNEL } from '@/lib/ceo-chat/config';

const saved = process.env.MY_AI_CEO_BETA;
afterEach(() => {
  if (saved === undefined) delete process.env.MY_AI_CEO_BETA;
  else process.env.MY_AI_CEO_BETA = saved;
});

describe('isMyAiCeoBetaEnabled', () => {
  it('defaults ON when the var is unset', () => {
    delete process.env.MY_AI_CEO_BETA;
    expect(isMyAiCeoBetaEnabled()).toBe(true);
  });

  it('is ON for MY_AI_CEO_BETA=true', () => {
    process.env.MY_AI_CEO_BETA = 'true';
    expect(isMyAiCeoBetaEnabled()).toBe(true);
  });

  it('is OFF for the literal "false"', () => {
    process.env.MY_AI_CEO_BETA = 'false';
    expect(isMyAiCeoBetaEnabled()).toBe(false);
  });

  it('exposes the ceo-chat channel constant used by the trust engine', () => {
    expect(CEO_CHAT_CHANNEL).toBe('ceo-chat');
  });
});
