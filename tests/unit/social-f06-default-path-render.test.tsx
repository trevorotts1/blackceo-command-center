/**
 * social-f06-default-path-render.test.tsx — D-F06-01 repair proof (CC half).
 *
 * "No production caller passes `accounts` to the button — DEFAULT path
 * broken." The repair: the button fetches the per-account plan itself
 * (GET /api/company/config → connectedSystems.social) when the caller passes
 * none, derives platforms from the plan, and NEVER POSTs platforms:[] (the
 * publish route 400s on empty). Required by the packet:
 *   - default render with no accounts prop → empty platforms + a hint, NOT
 *     the old hardcoded linkedin/medium/x/wordpress defaults;
 *   - render with accounts → enabled platforms derived from the plan.
 *
 * REAL render proof (react-dom via @testing-library/react + jsdom — the same
 * rig as the other *.render.test.tsx suites), never a restatement.
 *
 *   npx vitest run --config vitest.component.config.ts tests/unit/social-f06-default-path-render.test.tsx
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { MarketingPublishButton } from '../../src/components/MarketingPublishButton';
import type { Task } from '../../src/lib/types';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function marketingTask(): Task {
  return {
    id: 'task-f06',
    title: 'Launch post',
    status: 'backlog',
    priority: 'medium',
    assigned_agent_id: null,
    created_by_agent_id: null,
    workspace_id: 'ws-marketing',
    business_id: 'biz-1',
    created_at: '2026-09-08T00:00:00.000Z',
    updated_at: '2026-09-08T00:00:00.000Z',
    dependencies: [],
    parallel_candidates: [],
    department: 'marketing',
  } as unknown as Task;
}

describe('F06 default path (D-F06-01)', () => {
  it('default render with no accounts prop: empty platforms + a hint, never the hardcoded quartet', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ connectedSystems: { social: 'none' } }) }),
    );
    const { container } = render(<MarketingPublishButton task={marketingTask()} />);
    const button = container.querySelector('button') as HTMLButtonElement;
    expect(button).toBeTruthy();
    // Disabled until a plan resolves platforms — never a blind POST of [].
    expect(button.disabled).toBe(true);
    await waitFor(() => {
      expect(button.title).toMatch(/No social accounts connected/);
    });
    expect(button.title).not.toMatch(/linkedin/);
    expect(button.title).not.toMatch(/medium/);
    expect(button.title).not.toMatch(/wordpress/);
    // Empty-plan hint visible in the title, not a silent queue.
    expect(screen.getByRole('button', { name: 'Publish' })).toBeTruthy();
  });

  it('render with accounts: enabled platforms derived from the plan', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { container } = render(
      <MarketingPublishButton
        task={marketingTask()}
        accounts={[
          { platform: 'facebook', account_id: 'fb-1', health: 'ready' },
          { platform: 'instagram', account_id: 'ig-1', health: 'needs_reconnect' },
        ]}
      />,
    );
    const button = container.querySelector('button') as HTMLButtonElement;
    expect(button).toBeTruthy();
    expect(button.disabled).toBe(false);
    expect(button.title).toMatch(/facebook/);
    expect(button.title).not.toMatch(/instagram/);
    // Caller-supplied plan: no self-fetch needed.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('self-fetch: connected system resolves its platform without a caller plan', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ connectedSystems: { social: 'ghl' } }) }),
    );
    const { container } = render(<MarketingPublishButton task={marketingTask()} />);
    const button = container.querySelector('button') as HTMLButtonElement;
    await waitFor(() => {
      expect(button.title).toMatch(/ghl/);
    });
    expect(button.disabled).toBe(false);
  });
});
