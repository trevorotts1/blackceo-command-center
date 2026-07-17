/**
 * U62 (JM/U65, master E.2) — ThinkingSelector goes LIVE.
 *
 * Pre-U62 this control was permanently disabled (pending the U61 spike).
 * U61/S1 PASSed with the accepted-and-landing set {off, low, medium, high} —
 * BINARY acceptance: "thinking level ... disables with an explanatory
 * tooltip when the active model lacks the `reasoning` capability tag ...
 * survives reload ... all controls disable from first streamed token until
 * done/gateway_down." This suite renders the REAL component
 * (@testing-library/react + jsdom, vitest.component.config.ts).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import ThinkingSelector from '../../src/components/ceo-chat/ThinkingSelector';

afterEach(() => cleanup());

describe('ThinkingSelector — live (U62)', () => {
  it('renders all four labels, ENABLED, with the active one reflecting `value`', () => {
    render(<ThinkingSelector value="Balanced" onChange={() => {}} />);
    for (const label of ['Quick', 'Balanced', 'Deep', 'Max']) {
      const seg = screen.getByRole('tab', { name: label }) as HTMLButtonElement;
      expect(seg.disabled).toBe(false);
    }
    expect(screen.getByRole('tab', { name: 'Balanced' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('tab', { name: 'Quick' }).getAttribute('aria-selected')).toBe('false');
  });

  it('clicking a segment calls onChange with that UI label', () => {
    const onChange = vi.fn();
    render(<ThinkingSelector value="Quick" onChange={onChange} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Max' }));
    expect(onChange).toHaveBeenCalledWith('Max');
  });

  it('disabled=true (streaming, or the active model lacks the reasoning capability) disables every segment with the given reason as its tooltip', () => {
    const onChange = vi.fn();
    render(
      <ThinkingSelector
        value="Deep"
        onChange={onChange}
        disabled
        disabledReason="This model does not support adjustable reasoning effort."
      />,
    );
    for (const label of ['Quick', 'Balanced', 'Deep', 'Max']) {
      const seg = screen.getByRole('tab', { name: label }) as HTMLButtonElement;
      expect(seg.disabled).toBe(true);
      expect(seg.getAttribute('title')).toBe('This model does not support adjustable reasoning effort.');
    }
    fireEvent.click(screen.getByRole('tab', { name: 'Max' }));
    expect(onChange).not.toHaveBeenCalled();
  });
});
