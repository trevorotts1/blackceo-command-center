/**
 * Planning Mode — real render proof that "Enable Planning Mode" keeps the
 * Create New Task modal open on the new task's Planning tab (it used to call
 * onClose() unconditionally), holds the task from creation via planning_mode,
 * resumes polling for an unanswered session, and sends "Other" free text.
 *
 *   npx vitest run --config vitest.component.config.ts tests/unit/planning-mode-modal.test.tsx
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { TaskModal } from '../../src/components/TaskModal';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const question = {
  question: 'What is the main goal?',
  options: [
    { id: 'A', label: 'Grow revenue' },
    { id: 'other', label: 'Other' },
  ],
};
const userMsg = { role: 'user', content: 'plan', timestamp: 1 };

function json(body: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));
}

describe('TaskModal Planning Mode', () => {
  it('stays open on the Planning tab, holds the task, polls for the first question and keeps Other text', async () => {
    const calls: Array<{ url: string; method: string; body?: any }> = [];
    let polls = 0;
    const saved = { id: 't1', title: 'Big project', status: 'backlog', priority: 'medium', workspace_id: 'ws', created_at: '', updated_at: '' };
    vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (url === '/api/tasks' && method === 'POST') return json(saved, 201);
      if (url === '/api/tasks/t1/planning' && method === 'POST') return json({ success: true, sessionKey: 'k', messages: [userMsg] });
      if (url === '/api/tasks/t1/planning') {
        // Started, but the first question has not arrived yet.
        return json({ taskId: 't1', messages: [userMsg], currentQuestion: null, isComplete: false, isStarted: true });
      }
      if (url === '/api/tasks/t1/planning/poll') {
        polls += 1;
        return json({ hasUpdates: true, complete: false, currentQuestion: question,
          messages: [userMsg, { role: 'assistant', content: JSON.stringify(question), timestamp: 2 }] });
      }
      if (url === '/api/tasks/t1/planning/answer') return json({ success: true });
      return json({});
    });

    const onClose = vi.fn();
    render(<TaskModal onClose={onClose} workspaceId="ws" />);
    fireEvent.change(screen.getByPlaceholderText('What needs to be done?'), { target: { value: 'Big project' } });
    fireEvent.click(screen.getByLabelText(/Enable Planning Mode/));
    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));

    // Modal stays open on the new task (heading is now its title) — onClose never fires.
    await screen.findByRole('heading', { name: 'Big project' });
    expect(onClose).not.toHaveBeenCalled();
    // The create call carried planning_mode so the server holds the task from creation.
    expect(calls.find((c) => c.url === '/api/tasks' && c.method === 'POST')?.body.planning_mode).toBe(true);

    // The tab resumed polling by itself (started, no question yet) and shows the question.
    await screen.findByText('What is the main goal?', undefined, { timeout: 6000 });
    expect(polls).toBeGreaterThan(0);

    // "Other" free text is sent with the answer.
    fireEvent.click(screen.getByRole('button', { name: /Other/ }));
    fireEvent.change(screen.getByPlaceholderText('Please specify...'), { target: { value: 'Something custom' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await waitFor(() => {
      const answer = calls.find((c) => c.url === '/api/tasks/t1/planning/answer');
      expect(answer?.body).toEqual({ answer: 'Other', otherText: 'Something custom' });
    });
  }, 15000);
});
