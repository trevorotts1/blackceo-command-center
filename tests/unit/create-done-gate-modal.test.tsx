/**
 * Create-done gate — real TaskModal render proof (Gap 1 of the 8b2b4a2728 QC).
 *
 * POST /api/tasks refuses done/review at create. The modal must therefore:
 *   (a) never OFFER done/review in a create dropdown (editing keeps them),
 *   (b) take a "+" from the board's Review/Done column, seed a non-terminal
 *       status, and SHOW that downgrade instead of silently doing it —
 *       i.e. submit a non-terminal status, never a 403-producing one, and
 *   (c) surface the server's `hint` in the submit-error banner, so a refused
 *       create explains what to do instead of dead-ending.
 *
 *   npx vitest run --config vitest.component.config.ts tests/unit/create-done-gate-modal.test.tsx
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { TaskModal } from '../../src/components/TaskModal';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function json(body: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));
}

// The form's Status label is not wired with htmlFor, so find the select by the
// status option it always renders rather than by accessible name.
function statusSelect(): HTMLSelectElement {
  const select = Array.from(document.querySelectorAll('select')).find((s) =>
    Array.from(s.options).some((o) => o.textContent?.trim() === 'In Progress'),
  );
  if (!select) throw new Error('status select not found');
  return select;
}

function offeredLabels(select: HTMLSelectElement): string[] {
  return Array.from(select.querySelectorAll('option')).map((o) => o.textContent?.trim() ?? '');
}

describe('TaskModal — creation cannot claim done/review', () => {
  it('create dropdown does NOT offer Done or Review; every other status is present', () => {
    render(<TaskModal onClose={vi.fn()} workspaceId="ws" />);
    const select = statusSelect();
    const labels = offeredLabels(select);
    expect(labels).not.toContain('Done');
    expect(labels).not.toContain('Review / QC');
    for (const l of ['Backlog', 'Inbox (new)', 'Planning', 'Assigned (queued)', 'In Progress', 'Testing', 'Blocked']) {
      expect(labels).toContain(l);
    }
  });

  it('editing an existing REVIEW task still offers Done and Review (no regression on the edit path)', () => {
    const reviewTask = { id: 't1', title: 'Existing card', status: 'review', priority: 'medium', workspace_id: 'ws', created_at: '', updated_at: '' } as never;
    render(<TaskModal task={reviewTask} onClose={vi.fn()} workspaceId="ws" />);
    const labels = offeredLabels(statusSelect());
    expect(labels).toContain('Done');
    expect(labels).toContain('Review / QC');
  });

  it('a "+" from the Review column seeds a non-terminal status, says so, and submits a status the API accepts', async () => {
    const calls: Array<{ url: string; method?: string; body?: any }> = [];
    const saved = { id: 't9', title: 'From review column', status: 'assigned', priority: 'medium', workspace_id: 'ws', created_at: '', updated_at: '' };
    vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (url === '/api/tasks' && init?.method === 'POST') return json(saved, 201);
      return json({});
    });

    render(<TaskModal onClose={vi.fn()} workspaceId="ws" initialStatus={'review' as never} />);

    const select = statusSelect();
    expect(select.value).not.toBe('review');
    expect(select.value).not.toBe('done');

    const notice = screen.getByTestId('create-status-downgraded-notice');
    expect(notice.textContent).toMatch(/can't start in Review \/ QC/i);
    expect(notice.textContent).toMatch(/register a deliverable/i);

    fireEvent.change(screen.getByPlaceholderText('What needs to be done?'), { target: { value: 'From review column' } });
    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));

    await vi.waitFor(() => expect(calls.some((c) => c.url === '/api/tasks' && c.method === 'POST')).toBe(true));
    const post = calls.find((c) => c.url === '/api/tasks' && c.method === 'POST')!;
    expect(['done', 'review']).not.toContain(post.body.status);
    expect(post.body.status).toBe('assigned');
  });

  it('a refused create shows the server `hint` in the error banner (no dead-end 403)', async () => {
    vi.stubGlobal('fetch', () =>
      json(
        {
          error: 'Forbidden: cannot create a task already done or in review with no completion evidence.',
          hint: 'Create the task in a work state, register a deliverable, then move it.',
        },
        403,
      ),
    );
    render(<TaskModal onClose={vi.fn()} workspaceId="ws" />);
    fireEvent.change(screen.getByPlaceholderText('What needs to be done?'), { target: { value: 'Refused create' } });
    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));

    const banner = await screen.findByTestId('task-save-error');
    expect(banner.textContent).toMatch(/cannot create a task already done or in review/i);
    expect(banner.textContent).toMatch(/register a deliverable, then move it/i);
  });
});
