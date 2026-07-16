/**
 * U50 [HL/U62] (H+L.8) — sticky filter bar + deprecated/stale toggle (D14),
 * real render proof.
 *
 * THE GAP THIS LOCKS DOWN: `ModelFilterBar` was not sticky (scrolled away
 * over a multi-hundred-row grid) and had no way to inspect deprecated/stale
 * rows — they were simply excluded, uninspectable, which is exactly how the
 * Fish Audio stale-S1-marked-active defect stayed invisible. This suite
 * renders the REAL components (react-dom via @testing-library/react + jsdom
 * — see vitest.component.config.ts) and proves:
 *
 *   1. The filter bar's root element carries the sticky positioning class.
 *   2. `applyModelFilters` hides deprecated/unavailable rows by DEFAULT.
 *   3. The "Show deprecated/stale" toggle exists, is off by default, and
 *      flipping it reveals those rows via `applyModelFilters`.
 *   4. A deprecated/unavailable `ModelCard` renders a clearly VISIBLE badge
 *      (not just a disabled-button tooltip) and its assign actions stay
 *      disabled even when shown.
 *   5. The "Showing N of M models" count still renders (pre-existing
 *      behavior; must not regress).
 *
 * npx vitest run --config vitest.component.config.ts
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { useState } from 'react';

import {
  ModelFilterBar,
  applyModelFilters,
  EMPTY_FILTER_STATE,
  type ModelFilterState,
} from '../../src/components/settings/ModelFilterBar';
import { ModelCard, type ModelCardData } from '../../src/components/settings/ModelCard';

afterEach(() => cleanup());

const CATALOG: ModelCardData[] = [
  { id: 'anthropic/claude-x', label: 'Claude X', provider: 'anthropic', family: 'claude', status: 'active' },
  { id: 'fish-audio/s2', label: 'Fish Speech 2', provider: 'fish-audio', family: 'fish-speech-2', status: 'active' },
  {
    id: 'fish-audio/s1',
    label: 'Fish Speech 1.5 (retired)',
    provider: 'fish-audio',
    family: 'fish-speech-1.5',
    status: 'deprecated',
  },
  {
    id: 'fish-audio/s2.1-pro-unconfirmed',
    label: 'Fish Speech 2.1 Pro (reference)',
    provider: 'fish-audio',
    family: 'fish-speech-2',
    status: 'unavailable',
  },
];

/** Small controlled harness so the toggle's onChange loop is real, not mocked. */
function FilterBarHarness({ models }: { models: ModelCardData[] }) {
  const [state, setState] = useState<ModelFilterState>(EMPTY_FILTER_STATE);
  const filtered = applyModelFilters(models, state);
  return (
    <div>
      <ModelFilterBar models={models} state={state} onChange={setState} visibleCount={filtered.length} />
      <div data-testid="visible-ids">{filtered.map((m) => m.id).join(',')}</div>
    </div>
  );
}

describe('[U50] ModelFilterBar — sticky + deprecated/stale toggle (D14)', () => {
  it('the filter bar root is sticky above the grid', () => {
    render(
      <ModelFilterBar
        models={CATALOG}
        state={EMPTY_FILTER_STATE}
        onChange={() => {}}
        visibleCount={CATALOG.length}
      />
    );
    const toggle = screen.getByRole('checkbox', { name: /show deprecated\/stale/i });
    // Walk up to the component's root wrapper (the sticky container).
    let node: HTMLElement | null = toggle;
    let stickyRoot: HTMLElement | null = null;
    while (node) {
      if (node.className && typeof node.className === 'string' && node.className.includes('sticky')) {
        stickyRoot = node;
        break;
      }
      node = node.parentElement;
    }
    expect(stickyRoot).not.toBeNull();
    expect(stickyRoot!.className).toMatch(/\btop-0\b/);
  });

  it('deprecated/unavailable rows are excluded by default, and the toggle is off by default', () => {
    render(<FilterBarHarness models={CATALOG} />);
    const toggle = screen.getByRole('checkbox', { name: /show deprecated\/stale/i }) as HTMLInputElement;
    expect(toggle.checked).toBe(false);

    const visible = screen.getByTestId('visible-ids').textContent ?? '';
    expect(visible).toContain('anthropic/claude-x');
    expect(visible).toContain('fish-audio/s2');
    expect(visible).not.toContain('fish-audio/s1');
    expect(visible).not.toContain('fish-audio/s2.1-pro-unconfirmed');
  });

  it('flipping the toggle reveals deprecated/unavailable rows', () => {
    render(<FilterBarHarness models={CATALOG} />);
    const toggle = screen.getByRole('checkbox', { name: /show deprecated\/stale/i });
    fireEvent.click(toggle);

    const visible = screen.getByTestId('visible-ids').textContent ?? '';
    expect(visible).toContain('fish-audio/s1');
    expect(visible).toContain('fish-audio/s2.1-pro-unconfirmed');
    // Active rows must still be present — the toggle ADDS visibility, it
    // never hides the healthy catalog.
    expect(visible).toContain('anthropic/claude-x');
    expect(visible).toContain('fish-audio/s2');
  });

  it('the "Showing N of M models" count still renders (pre-existing behavior, must not regress)', () => {
    render(
      <ModelFilterBar models={CATALOG} state={EMPTY_FILTER_STATE} onChange={() => {}} visibleCount={2} />
    );
    expect(screen.getByText('2')).toBeTruthy();
    expect(screen.getByText(String(CATALOG.length))).toBeTruthy();
    expect(screen.getByText(/models/)).toBeTruthy();
  });
});

describe('[U50] ModelCard — deprecated/stale rows are clearly badged, never assignable', () => {
  it('a deprecated model renders a visible "Deprecated" badge and disables assign actions', () => {
    render(
      <ModelCard
        model={{ id: 'fish-audio/s1', label: 'Fish Speech 1.5 (retired)', status: 'deprecated' }}
        onSetDefault={() => {}}
      />
    );
    expect(screen.getByText('Deprecated')).toBeTruthy();
    const applyButton = screen.getByRole('button', { name: /apply to all/i }) as HTMLButtonElement;
    expect(applyButton.disabled).toBe(true);
  });

  it('an unavailable (never-confirmed) model renders a visible "Unavailable" badge', () => {
    render(
      <ModelCard
        model={{ id: 'fish-audio/s2.1-pro', label: 'Fish Speech 2.1 Pro (reference)', status: 'unavailable' }}
        onSetDefault={() => {}}
      />
    );
    expect(screen.getByText('Unavailable')).toBeTruthy();
    const applyButton = screen.getByRole('button', { name: /apply to all/i }) as HTMLButtonElement;
    expect(applyButton.disabled).toBe(true);
  });

  it('an active model carries no deprecated/unavailable badge and stays assignable', () => {
    render(
      <ModelCard model={{ id: 'fish-audio/s2', label: 'Fish Speech 2', status: 'active' }} onSetDefault={() => {}} />
    );
    expect(screen.queryByText('Deprecated')).toBeNull();
    expect(screen.queryByText('Unavailable')).toBeNull();
    const applyButton = screen.getByRole('button', { name: /apply to all/i }) as HTMLButtonElement;
    expect(applyButton.disabled).toBe(false);
  });
});
