/**
 * Planning Mode — a failed start is shown on the Planning tab in plain words
 * with a Try again that re-POSTs the start (it used to only console.error).
 *
 *   npx vitest run --config vitest.component.config.ts tests/unit/planning-mode-start-error.test.tsx
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { PlanningTab } from '../../src/components/PlanningTab';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const json = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));
const notStarted = { taskId: 't1', messages: [], isComplete: false, isStarted: false };

describe('PlanningTab start failure', () => {
  it('shows the reason in plain words and Try again re-POSTs the start', async () => {
    let posts = 0;
    vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
      if (url === '/api/tasks/t1/planning' && init?.method === 'POST') {
        posts += 1;
        return posts === 1 ? json({ error: 'x', reason: 'gateway_unreachable' }, 502) : json({ success: true, sessionKey: 'k', messages: [] });
      }
      return json(notStarted);
    });
    render(<PlanningTab taskId="t1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Start Planning' }));
    expect((await screen.findByTestId('planning-start-error')).textContent).toMatch(
      /Couldn't start planning: your AI assistant didn't respond/);
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(posts).toBe(2));
    await waitFor(() => expect(screen.queryByTestId('planning-start-error')).toBeNull());
  });

  it('shows a failure the modal already hit when it created the task', async () => {
    vi.stubGlobal('fetch', () => json(notStarted));
    render(<PlanningTab taskId="t1" initialStartError="Couldn't start planning: your AI assistant didn't respond." />);
    expect((await screen.findByTestId('planning-start-error')).textContent).toMatch(/didn't respond/);
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });

  it('shows "can\'t reach" with Try again on a gateway error, and the raw text for an unreadable reply', async () => {
    const started = { ...notStarted, isStarted: true, messages: [{ role: 'user', content: 'p', timestamp: 1 }] };
    vi.stubGlobal('fetch', (url: string) => {
      if (url.endsWith('/poll')) return json({ hasUpdates: false, gatewayError: true });
      return json(started);
    });
    render(<PlanningTab taskId="t1" />);
    expect((await screen.findByTestId('planning-wait-error', {}, { timeout: 5000 })).textContent)
      .toMatch(/Can't reach your AI assistant right now\./);
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
    cleanup();
    vi.stubGlobal('fetch', () => json({ ...started, malformedReply: 'blah blah not json' }));
    render(<PlanningTab taskId="t1" />);
    expect((await screen.findByTestId('planning-malformed-reply')).textContent).toMatch(/blah blah not json/);
  });
});
