/**
 * Intelligence Settings "Persona Categories" checklist items. The category + domain browser is the
 * /personas screen (data from /api/personas, i.e. persona-categories.json); Intelligence Settings
 * links to it. This proves the link, and that /personas shows list, category filter, name,
 * description, domain tags and use cases.
 *
 * npx vitest run --config vitest.component.config.ts tests/unit/cc-persona-categories-link.test.tsx
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent, within } from '@testing-library/react';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), back: vi.fn() }),
  usePathname: () => '/personas',
}));
vi.mock('@/components/Header', () => ({ Header: () => null }));

import IntelligenceSettingsPage from '../../src/app/settings/intelligence/page';
import PersonasPage from '../../src/app/personas/page';

afterEach(() => cleanup());

const personas = [
  {
    id: 'allan-dib-the-1-page-marketing-plan', author: 'Allan Dib', book: 'The 1-Page Marketing Plan',
    domain: ['marketing'], perspective: ['direct-response'], custom: ['marketing-plan', 'lead-generation'],
    category: 'Marketing & Content', blueprint_preview: 'Allan Dib lens from the book. Domains: marketing.',
  },
  {
    id: 'grant-cardone-the-10x-rule', author: 'Grant Cardone', book: 'The 10X Rule',
    domain: ['sales'], perspective: [], custom: [],
    category: 'Sales & Revenue', blueprint_preview: 'Grant Cardone lens from the book. Domains: sales.',
  },
];

function stubFetch() {
  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as Response;
    if (url.startsWith('/api/personas')) return ok({ total: 2, personas });
    if (url.startsWith('/api/persona-selection-log')) return ok({ entries: [] });
    if (url.startsWith('/api/settings/intelligence')) {
      return ok({ departments: [], models: [], personas: [], defaults: { model: '', persona: '' } });
    }
    if (url.startsWith('/api/models')) return ok({ total: 0, models: [], providers: [], refresh_log: [] });
    throw new Error(`unexpected fetch ${url}`);
  }) as unknown as typeof fetch;
}

describe('Persona categories on Intelligence Settings', () => {
  it('has a labelled section whose link opens /personas', async () => {
    stubFetch();
    render(<IntelligenceSettingsPage />);
    const section = await waitFor(() => screen.getByTestId('persona-categories-section'));
    expect(within(section).getByText('Persona categories')).toBeTruthy();
    expect(screen.getByTestId('persona-categories-link').getAttribute('href')).toBe('/personas');
  });
});

describe('/personas, the screen that link opens', () => {
  it('lists personas, filters by category, and shows name, description, tags and use cases', async () => {
    stubFetch();
    render(<PersonasPage />);
    await waitFor(() => screen.getByText('Allan Dib'));
    expect(screen.getByText('Grant Cardone')).toBeTruthy();
    expect(screen.getByText(/Allan Dib lens from the book/)).toBeTruthy(); // description
    expect(screen.getByText('marketing')).toBeTruthy(); // domain tag
    const useCases = screen.getByTestId('persona-use-cases');
    expect(useCases.textContent).toContain('marketing-plan');
    expect(useCases.textContent).toContain('lead-generation');
    expect(screen.getAllByTestId('persona-use-cases')).toHaveLength(1); // none invented for Cardone

    fireEvent.click(screen.getByRole('button', { name: 'Sales & Revenue' }));
    expect(screen.queryByText('Allan Dib')).toBeNull();
    expect(screen.getByText('Grant Cardone')).toBeTruthy();
  });
});
