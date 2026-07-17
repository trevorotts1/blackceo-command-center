/**
 * U62 (JM/U65, master E.2) — ContextMeter exact-usage mode.
 *
 * Pre-U62 the meter was ALWAYS in estimate mode (characters ÷ 4), always
 * rendering the leading `≈`. BINARY acceptance: "in exact-usage mode the
 * meter never renders `≈` and the estimate->exact switchover happens on the
 * first usage frame with no layout shift." This suite renders the REAL
 * component (@testing-library/react + jsdom).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import ContextMeter from '../../src/components/ceo-chat/ContextMeter';

afterEach(() => cleanup());

describe('ContextMeter — exact-usage mode (U62)', () => {
  it('estimate mode (no exactTokens): renders the leading ≈ and an "estimated" tooltip — unchanged Phase-A behavior', () => {
    render(<ContextMeter charCount={4000} contextWindow={128_000} onStartFresh={() => {}} />);
    const meter = screen.getByTestId('context-meter');
    expect(meter.textContent).toMatch(/^≈/);
    expect(meter.getAttribute('title')).toMatch(/estimated/i);
  });

  it('exact-usage mode (exactTokens set): NEVER renders ≈, and the tooltip reads exact, not estimated', () => {
    render(<ContextMeter charCount={4000} contextWindow={128_000} exactTokens={16054} onStartFresh={() => {}} />);
    const meter = screen.getByTestId('context-meter');
    expect(meter.textContent).not.toMatch(/≈/);
    expect(meter.getAttribute('title')).not.toMatch(/estimated/i);
    expect(meter.getAttribute('title')).toMatch(/exact/i);
  });

  it('exact-usage mode uses the real token count for the ratio, not the character-based estimate', () => {
    // charCount alone would estimate ~1 token (4/4); a real usage total of
    // 64,000 against a 128,000 window must show ~50%, proving the exact
    // value — not the character estimate — drives the percentage.
    render(<ContextMeter charCount={4} contextWindow={128_000} exactTokens={64_000} onStartFresh={() => {}} />);
    const meter = screen.getByTestId('context-meter');
    expect(meter.textContent).toContain('50%');
  });
});
