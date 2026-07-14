/**
 * A-U5 (master spec v2 Section A.6) acceptance (b) — REAL render-level proof
 * that `PersonaScopeChips` renders the per-page/scope blend rows as chips,
 * reusing the `PersonaSlotChips` visual pattern verbatim (Section A.10
 * binary acceptance: "task_persona_bundle_scope rows persist per (task_id,
 * scope) and render as chips (snapshot test)").
 *
 * Renders the REAL component (react-dom via @testing-library/react + jsdom
 * — see vitest.component.config.ts), never a hand-rolled restatement.
 *
 *   npx vitest run --config vitest.component.config.ts
 */
import { describe, it, expect } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';
import { PersonaScopeChips } from '../../src/components/kanban/TaskCard';
import type { Task, TaskPersonaBundleScope } from '../../src/lib/types';

afterEach(() => cleanup());

function scopes(rows: TaskPersonaBundleScope[]): Pick<Task, 'persona_bundle_scopes'> {
  return { persona_bundle_scopes: rows };
}

describe('PersonaScopeChips', () => {
  it('renders nothing for a task with no scoped bundles (undefined)', () => {
    const { container } = render(<PersonaScopeChips task={{ persona_bundle_scopes: undefined }} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing for a task with exactly ONE scoped bundle (below the >=2 chip threshold)', () => {
    const { container } = render(
      <PersonaScopeChips
        task={scopes([
          { scope: 'sales', page_role: 'sales', persona_id: 'shonda-rhimes', persona_name: 'Shonda Rhimes' },
        ])}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders ONE chip per page for a real 3-page funnel, each naming its own persona', () => {
    render(
      <PersonaScopeChips
        task={scopes([
          {
            scope: 'opt-in',
            page_role: 'opt-in',
            page_slug: 'opt-in',
            conversion_goal: 'lead-capture',
            persona_id: 'aliche-get-good-with-money',
            persona_name: 'Aliche Get Good With Money',
            scope_reason: 'scope=opt-in — collapsed onto aliche-get-good-with-money',
          },
          {
            scope: 'sales',
            page_role: 'sales',
            page_slug: 'sales',
            conversion_goal: 'book-a-call',
            persona_id: 'shonda-rhimes',
            persona_name: 'Shonda Rhimes',
            scope_reason: 'scope=sales — distinct audience + topic personas (blend)',
          },
          {
            scope: 'thank-you',
            page_role: 'thank-you',
            page_slug: 'thank-you',
            conversion_goal: 'confirm-booking',
            persona_id: 'shonda-rhimes',
            persona_name: 'Shonda Rhimes',
            scope_reason: 'scope=thank-you — distinct audience + topic personas (blend)',
          },
        ])}
      />,
    );

    const row = screen.getByTestId('persona-scope-chips');
    expect(row).toBeTruthy();

    // The page-role labels render (uppercased via CSS, text content stays as-authored).
    expect(screen.getByText('opt-in')).toBeTruthy();
    expect(screen.getByText('sales')).toBeTruthy();
    expect(screen.getByText('thank-you')).toBeTruthy();

    // The persona names render — Shonda Rhimes appears twice (sales + thank-you
    // legitimately SHARE a blend; that is proven-legal, not a bug).
    expect(screen.getAllByText('Aliche Get Good With Money')).toHaveLength(1);
    expect(screen.getAllByText('Shonda Rhimes')).toHaveLength(2);
  });

  it('a page with no persona (no_persona_required-style) renders the muted "—" chip, never crashes', () => {
    render(
      <PersonaScopeChips
        task={scopes([
          { scope: 'legal', page_role: 'legal', persona_id: null, persona_name: null },
          { scope: 'sales', page_role: 'sales', persona_id: 'shonda-rhimes', persona_name: 'Shonda Rhimes' },
        ])}
      />,
    );
    expect(screen.getByText('—')).toBeTruthy();
    expect(screen.getByText('Shonda Rhimes')).toBeTruthy();
  });

  it('falls back to the bare scope key when neither page_role nor page_slug is set', () => {
    render(
      <PersonaScopeChips
        task={scopes([
          { scope: 'part-3-nurture', persona_id: 'shonda-rhimes', persona_name: 'Shonda Rhimes' },
          { scope: 'part-4-close', persona_id: 'russell-brunson', persona_name: 'Russell Brunson' },
        ])}
      />,
    );
    expect(screen.getByText('part-3-nurture')).toBeTruthy();
    expect(screen.getByText('part-4-close')).toBeTruthy();
  });

  it('caps rendered chips at max + shows an overflow "+N" affordance', () => {
    const rows: TaskPersonaBundleScope[] = Array.from({ length: 6 }, (_, i) => ({
      scope: `page-${i}`,
      page_role: `page-${i}`,
      persona_id: 'shonda-rhimes',
      persona_name: 'Shonda Rhimes',
    }));
    render(<PersonaScopeChips task={scopes(rows)} max={4} />);
    expect(screen.getByText('+2')).toBeTruthy();
    expect(screen.getAllByText('Shonda Rhimes')).toHaveLength(4);
  });
});
