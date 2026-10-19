/**
 * Departments rail on /tasks/all: each department shows emoji + name + a badge
 * with its OPEN task count (every task whose status is not `done`).
 *
 * npx vitest run --config vitest.component.config.ts tests/unit/cc-dept-task-count-badge.test.tsx
 */
import './_isolated-db';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));

import { AgentsSidebar } from '../../src/components/AgentsSidebar';

afterEach(cleanup);

const ws = (id: string, name: string, icon: string, total: number, done: number) => ({
  id, name, icon, slug: id, head_agent_name: null,
  taskCounts: { backlog: 0, in_progress: 0, review: 0, blocked: 0, done, total },
});

describe('departments rail - open task count badge', () => {
  it('shows total minus done per department, with emoji and name', async () => {
    const urls: string[] = [];
    global.fetch = vi.fn(async (url: string) => {
      urls.push(url);
      const json = url.startsWith('/api/workspaces')
        ? [ws('marketing', 'Marketing', '📣', 7, 3), ws('sales', 'Sales', '💰', 2, 2), ws('ops', 'Operations', '⚙️', 5, 0)]
        : [];
      return { ok: true, status: 200, json: async () => json };
    }) as unknown as typeof fetch;

    render(<AgentsSidebar navigateOnSelect isOpen />);

    await waitFor(() => screen.getByTestId('dept-task-count-marketing'));
    expect(screen.getByTestId('dept-task-count-marketing').textContent).toBe('4'); // 7 - 3 done
    expect(screen.getByTestId('dept-task-count-sales').textContent).toBe('0'); // all done
    expect(screen.getByTestId('dept-task-count-ops').textContent).toBe('5');
    expect(screen.getByText('Marketing')).toBeTruthy();
    expect(screen.getByText('📣')).toBeTruthy();
    expect(urls).toContain('/api/workspaces?stats=true');
  });
});
