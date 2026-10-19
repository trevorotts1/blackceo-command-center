/**
 * Gap E - PRD section 6 requires a persona selection log in Intelligence
 * Settings (history of assignments, per-layer reasoning, filter by
 * department / date). GET /api/persona-selection-log existed and had no UI
 * caller, so the history was written but never visible.
 *
 * npx vitest run --config vitest.component.config.ts tests/unit/cc-gap-e-persona-selection-log.test.tsx
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent, within } from '@testing-library/react';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), back: vi.fn() }),
  usePathname: () => '/settings/intelligence',
}));

import IntelligenceSettingsPage from '../../src/app/settings/intelligence/page';
import { PersonaSelectionLog } from '../../src/components/settings/PersonaSelectionLog';

afterEach(() => cleanup());

const entries = [
  {
    id: 'e1', task_id: 't1', task_title: 'Spring launch email', persona_id: 'p-hormozi',
    persona_name: 'Alex Hormozi', mode: 'auto', score: 0.87,
    layer_scores: { company_mission: 0.9, owner_values: 0.8, task_category: 'copywriting' },
    department_id: 'marketing', selected_at: '2026-10-01T10:00:00.000Z',
  },
  {
    id: 'e2', task_id: 't2', task_title: 'Pipeline review', persona_id: 'p-cardone',
    persona_name: 'Grant Cardone', mode: 'manual', score: null,
    layer_scores: { task_category: 'sales-strategy' },
    department_id: 'sales', selected_at: '2026-10-10T10:00:00.000Z',
  },
];

function stubFetch(logResponse: { ok: boolean; status?: number; body?: unknown }) {
  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.startsWith('/api/persona-selection-log')) {
      return { ok: logResponse.ok, status: logResponse.status ?? 200, json: async () => logResponse.body } as Response;
    }
    if (url.startsWith('/api/settings/intelligence')) {
      return {
        ok: true, status: 200,
        json: async () => ({ departments: [{ id: 'marketing', name: 'Marketing', roles: [] }], models: [], personas: [], defaults: { model: '', persona: '' } }),
      } as Response;
    }
    if (url.startsWith('/api/models')) {
      return { ok: true, status: 200, json: async () => ({ total: 0, models: [], providers: [], refresh_log: [] }) } as Response;
    }
    throw new Error(`unexpected fetch ${url}`);
  }) as unknown as typeof fetch;
}

describe('Persona selection log (gap E)', () => {
  it('is mounted on the Intelligence Settings page and shows the history with per-layer reasoning', async () => {
    stubFetch({ ok: true, body: { entries } });
    render(<IntelligenceSettingsPage />);

    const log = await waitFor(() => screen.getByTestId('persona-selection-log'));
    await waitFor(() => expect(within(log).getAllByTestId('persona-log-row')).toHaveLength(2));
    expect(within(log).getByText('Alex Hormozi')).toBeTruthy();
    expect(within(log).getByText('Spring launch email')).toBeTruthy();
    // Layer reasoning is rendered, not just the headline score.
    expect(log.textContent).toContain('company mission:');
    expect(log.textContent).toContain('0.90');
    // The department id is shown by the name Intelligence Settings already knows.
    expect(within(log).getAllByText('Marketing').length).toBeGreaterThan(0);
  });

  it('filters by department and by date, and says so when nothing matches', async () => {
    stubFetch({ ok: true, body: { entries } });
    render(<PersonaSelectionLog />);
    await waitFor(() => expect(screen.getAllByTestId('persona-log-row')).toHaveLength(2));

    fireEvent.change(screen.getByLabelText('Department'), { target: { value: 'sales' } });
    expect(screen.getAllByTestId('persona-log-row')).toHaveLength(1);
    expect(screen.getByText('Grant Cardone')).toBeTruthy();
    expect(screen.getByText('None recorded')).toBeTruthy(); // no layer scores, nothing invented

    // Task type comes from layer_scores.task_category and filters on its own.
    fireEvent.change(screen.getByLabelText('Department'), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText('Task type'), { target: { value: 'copywriting' } });
    expect(screen.getAllByTestId('persona-log-row')).toHaveLength(1);
    expect(screen.getByText('Alex Hormozi')).toBeTruthy();
    // ...and is not repeated as if it were a reasoning score.
    expect(screen.queryByText('task category:')).toBeNull();
    fireEvent.change(screen.getByLabelText('Task type'), { target: { value: '' } });

    fireEvent.change(screen.getByLabelText('Department'), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-10-05' } });
    expect(screen.getAllByTestId('persona-log-row')).toHaveLength(1);

    fireEvent.change(screen.getByLabelText('To'), { target: { value: '2026-10-06' } });
    expect(screen.queryAllByTestId('persona-log-row')).toHaveLength(0);
    expect(screen.getByText('No selections match these filters.')).toBeTruthy();
  });

  it('shows honest empty and error states', async () => {
    stubFetch({ ok: true, body: { entries: [] } });
    render(<PersonaSelectionLog />);
    await waitFor(() => screen.getByText('No persona selections have been recorded yet.'));
    cleanup();

    stubFetch({ ok: false, status: 500, body: {} });
    render(<PersonaSelectionLog />);
    await waitFor(() => screen.getByRole('alert'));
    expect(screen.getByRole('alert').textContent).toContain('500');
  });

  // The selector (persona-selector-v2.py write_persona_selection_log_row) stores the five layer scores nested
  // under layer_scores.layers, not flat. Each must show by its checklist name with its score, never "[object Object]".
  it('shows the five alignment layers by name from the selector\'s real layer_scores shape', async () => {
    stubFetch({
      ok: true,
      body: {
        entries: [{
          id: 'e3', task_id: 't3', task_title: 'Offer page', persona_id: 'p-miller', persona_name: 'Donald Miller',
          mode: 'leadership', score: 0.71, department_id: 'marketing', selected_at: '2026-10-12T10:00:00.000Z',
          layer_scores: {
            task_category: 'copywriting', variety_applied: false,
            layers: { mission: 0.91, owner_values: 0.82, company_kpis: 0.73, dept_kpis: 0.64, task_fit: 0.55, _task_fit_method: 'semantic', _llm_reasoning: { mission: 'fits' } },
          },
        }],
      },
    });
    render(<PersonaSelectionLog />);
    const row = await waitFor(() => screen.getByTestId('persona-log-row'));
    const text = row.textContent ?? '';
    for (const [label, v] of [
      ['Layer 1: Company Mission match:', '0.91'], ['Layer 2: Owner Values alignment:', '0.82'],
      ['Layer 3: Company Goals relevance:', '0.73'], ['Layer 4: Department Goals fit:', '0.64'],
      ['Layer 5: Task-specific suitability:', '0.55'],
    ]) expect(text).toContain(`${label} ${v}`);
    expect(text).not.toContain('[object Object]');
  });
});
