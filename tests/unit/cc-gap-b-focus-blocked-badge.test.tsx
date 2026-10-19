/**
 * Gap B — the focused single-department Kanban (/ceo-board/[dept]/focus,
 * reached from the Blockers panel's "View board") folded `blocked` tasks into
 * the Review column with nothing marking them blocked, so a task waiting on a
 * human looked identical to finished work awaiting review. The PRD fixes this
 * view at five columns, so the fix keeps the column and labels the card.
 *
 * npx vitest run --config vitest.component.config.ts tests/unit/cc-gap-b-focus-blocked-badge.test.tsx
 */
// C8: the page statically reaches the DB singleton via resolve-department (mocked
// below); isolate DATABASE_PATH first so the C8 guard holds and nothing can open the live DB.
import './_isolated-db';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, within } from '@testing-library/react';

vi.mock('next/navigation', () => ({
  useParams: () => ({ dept: 'marketing' }),
  useRouter: () => ({ push: vi.fn() }),
}));
vi.mock('@/lib/routing/resolve-department', () => ({
  resolveDepartment: async () => ({ id: 'marketing', name: 'Marketing', emoji: '📣' }),
}));

import FocusedDepartmentPage from '../../src/app/ceo-board/[dept]/focus/page';

afterEach(() => cleanup());

function task(id: string, title: string, status: string) {
  return { id, title, status, priority: 'medium', assigned_agent: null };
}

describe('focus view — blocked tasks are labelled, never passed off as review', () => {
  it('stamps a Blocked badge on blocked cards and on no other card', async () => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => [
        task('t1', 'Needs the client password', 'blocked'),
        task('t2', 'Draft ready for sign-off', 'review'),
        task('t3', 'Writing the email', 'in_progress'),
      ],
    })) as unknown as typeof fetch;

    render(<FocusedDepartmentPage />);
    await waitFor(() => screen.getByText('Needs the client password'));

    const blockedCard = screen.getByText('Needs the client password').closest('div')!;
    expect(within(blockedCard).queryByTestId('blocked-badge')).not.toBeNull();

    for (const title of ['Draft ready for sign-off', 'Writing the email']) {
      const card = screen.getByText(title).closest('div')!;
      expect(within(card).queryByTestId('blocked-badge')).toBeNull();
    }
    expect(screen.getAllByTestId('blocked-badge')).toHaveLength(1);
  });
});
