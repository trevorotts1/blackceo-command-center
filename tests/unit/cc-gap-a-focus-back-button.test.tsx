/**
 * Gap A - the focused single-department Kanban's large Back button used to go
 * to /ceo-board/departments (the performance overview), but the checklist says
 * it returns to the department board. Trevor decided (2026-10-19, option 1)
 * that the department board is /tasks/all, so the button must go there.
 *
 * npx vitest run --config vitest.component.config.ts tests/unit/cc-gap-a-focus-back-button.test.tsx
 */
// C8: the page statically reaches the DB singleton via resolve-department (mocked
// below); isolate DATABASE_PATH first so the C8 guard holds and nothing can open the live DB.
import './_isolated-db';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';

const push = vi.fn();
vi.mock('next/navigation', () => ({
  useParams: () => ({ dept: 'marketing' }),
  useRouter: () => ({ push }),
}));
vi.mock('@/lib/routing/resolve-department', () => ({
  resolveDepartment: async () => ({ id: 'marketing', name: 'Marketing', emoji: '📣' }),
}));

import FocusedDepartmentPage from '../../src/app/ceo-board/[dept]/focus/page';

afterEach(() => {
  cleanup();
  push.mockClear();
});

describe('focus view - the large Back button returns to the department board', () => {
  it('navigates to /tasks/all', async () => {
    global.fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => [] })) as unknown as typeof fetch;
    render(<FocusedDepartmentPage />);
    await waitFor(() => screen.getByRole('heading', { name: 'Marketing' }));

    fireEvent.click(screen.getByRole('button', { name: 'Back' }));

    expect(push).toHaveBeenCalledTimes(1);
    expect(push).toHaveBeenCalledWith('/tasks/all');
  });
});
