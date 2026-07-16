/**
 * U115 (E6-1, closes G7) acceptance (c) — REAL render-level proof that
 * `PersonaScopeChips` renders one per-part persona-assignment row per part,
 * naming its blend AND its audience — the audience half that was absent from
 * every CC layer before this unit (spec line 2467: "the board card AND the
 * task-detail modal each render one per-part persona-assignment row per
 * part, naming its blend + audience").
 *
 * `PersonaScopeChips` is the SAME component the kanban card AND (via
 * `PersonaPlanPanel`, TaskOverviewPanels.tsx — see u42-task-detail-modal-
 * populated.test.tsx) the task-detail modal both render — proving it here
 * proves both surfaces render identically, single source, no divergence.
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

describe('PersonaScopeChips — U115 per-part governance (part_role fallback + audience)', () => {
  it('falls back to part_role when neither page_role nor page_slug is set (per-PART row, no page concept)', () => {
    render(
      <PersonaScopeChips
        task={scopes([
          { scope: 'sales-page', part_role: 'sales-page', persona_id: 'shonda-rhimes', persona_name: 'Shonda Rhimes' },
          { scope: 'nurture-email-1', part_role: 'nurture-email', persona_id: 'russell-brunson', persona_name: 'Russell Brunson' },
        ])}
      />,
    );
    // The part_role, not the bare scope key, is what renders.
    expect(screen.getByText('sales-page')).toBeTruthy();
    expect(screen.getByText('nurture-email')).toBeTruthy();
  });

  it('page_role still wins over part_role when a row somehow carries both (page precedence unchanged)', () => {
    render(
      <PersonaScopeChips
        task={scopes([
          { scope: 'sales', page_role: 'sales', part_role: 'sales-page', persona_id: 'shonda-rhimes', persona_name: 'Shonda Rhimes' },
          { scope: 'thank-you', page_role: 'thank-you', part_role: 'confirmation', persona_id: 'russell-brunson', persona_name: 'Russell Brunson' },
        ])}
      />,
    );
    expect(screen.getByText('sales')).toBeTruthy();
    expect(screen.queryByText('sales-page')).toBeNull();
  });

  it('(c) renders the AUDIENCE alongside the blend for each of >=2 parts, distinct per part', () => {
    render(
      <PersonaScopeChips
        task={scopes([
          {
            scope: 'sales-page',
            part_role: 'sales-page',
            persona_id: 'shonda-rhimes',
            persona_name: 'Shonda Rhimes',
            audience_label: 'early-stage SaaS founders',
            audience_source: 'onboarding_icp',
          },
          {
            scope: 'social-post-1',
            part_role: 'social-post',
            persona_id: 'edwards-copywriting-secrets',
            persona_name: 'Edwards Copywriting Secrets',
            audience_label: 'cold social audience',
            audience_source: 'operator_confirmed',
          },
        ])}
      />,
    );
    const row = screen.getByTestId('persona-scope-chips');
    expect(row).toBeTruthy();

    // Both the blend (persona name) AND the audience are visibly named.
    expect(screen.getByText('Shonda Rhimes')).toBeTruthy();
    expect(screen.getByText('Edwards Copywriting Secrets')).toBeTruthy();
    expect(screen.getByText('for early-stage SaaS founders')).toBeTruthy();
    expect(screen.getByText('for cold social audience')).toBeTruthy();
  });

  it('a part with NO resolved audience_label renders the blend with no audience text — never fabricates one', () => {
    render(
      <PersonaScopeChips
        task={scopes([
          { scope: 'sales-page', part_role: 'sales-page', persona_id: 'shonda-rhimes', persona_name: 'Shonda Rhimes', audience_label: null },
          { scope: 'social-post-1', part_role: 'social-post', persona_id: 'russell-brunson', persona_name: 'Russell Brunson', audience_label: null },
        ])}
      />,
    );
    expect(screen.getByText('Shonda Rhimes')).toBeTruthy();
    expect(screen.getByText('Russell Brunson')).toBeTruthy();
    expect(screen.queryByText(/^for /)).toBeNull();
  });

  it('a shared blend across 2 nurture-email parts still names its OWN audience on each row (no collapsing)', () => {
    render(
      <PersonaScopeChips
        task={scopes([
          {
            scope: 'nurture-email-1',
            part_role: 'nurture-email',
            persona_id: 'aliche-get-good-with-money',
            persona_name: 'Aliche Get Good With Money',
            audience_label: 'existing newsletter subscribers',
          },
          {
            scope: 'nurture-email-2',
            part_role: 'nurture-email',
            persona_id: 'aliche-get-good-with-money',
            persona_name: 'Aliche Get Good With Money',
            audience_label: 'existing newsletter subscribers',
          },
        ])}
      />,
    );
    expect(screen.getAllByText('Aliche Get Good With Money')).toHaveLength(2);
    expect(screen.getAllByText('for existing newsletter subscribers')).toHaveLength(2);
  });

  it('back-compat: a plain A-U5 per-page fixture with no audience/part fields at all renders exactly as before (no "for ..." text, no crash)', () => {
    render(
      <PersonaScopeChips
        task={scopes([
          { scope: 'opt-in', page_role: 'opt-in', persona_id: 'aliche-get-good-with-money', persona_name: 'Aliche Get Good With Money' },
          { scope: 'sales', page_role: 'sales', persona_id: 'shonda-rhimes', persona_name: 'Shonda Rhimes' },
        ])}
      />,
    );
    expect(screen.getByText('Aliche Get Good With Money')).toBeTruthy();
    expect(screen.getByText('Shonda Rhimes')).toBeTruthy();
    expect(screen.queryByText(/^for /)).toBeNull();
  });
});
