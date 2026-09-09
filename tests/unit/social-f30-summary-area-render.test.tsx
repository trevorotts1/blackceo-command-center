/**
 * social-f30-summary-area-render.test.tsx — F30 component acceptance.
 *
 * "A queued job says queued; an unanswered theme says awaiting theme; scheduled
 * posts say scheduled." Real render proof of the button status area
 * (PublishSummaryArea) + the MarketingPublishButton summary wiring.
 *
 *   npx vitest run --config vitest.component.config.ts tests/unit/social-f30-summary-area-render.test.tsx
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import {
  MarketingPublishButton,
  PublishSummaryArea,
} from '../../src/components/MarketingPublishButton';
import type { SocialSummaryMessage } from '../../src/lib/social/summary';
import type { Task } from '../../src/lib/types';

function marketingTask(): Task {
  return {
    id: 'task-f30-render',
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

const queuedSummary: SocialSummaryMessage = {
  stage: 'queued',
  lastVerified: 'queued as of Sep 8',
  nextAction: 'The publishing worker will pick this up automatically.',
  owner: 'system',
  retryDeadline: null,
  evidence: [{ kind: 'publish_queue', id: 'pq-1', at: '2026-09-08T00:00:00Z' }],
  failures: [],
};

const themeSummary: SocialSummaryMessage = {
  stage: 'awaiting theme',
  lastVerified: null,
  nextAction: 'This week is waiting for your theme answer.',
  owner: 'client',
  retryDeadline: null,
  evidence: [],
  failures: [],
};

const retrySummary: SocialSummaryMessage = {
  stage: 'retrying',
  lastVerified: 'dispatch failed 09:00',
  nextAction: 'The system retries automatically by 09:02.',
  owner: 'system',
  retryDeadline: '2026-09-08T09:02:00.000Z',
  evidence: [],
  failures: ['dispatch held: no healthy worker'],
};

describe('F30 summary area (persisted-state client messages)', () => {
  it('queued says queued — never a fabricated completion', () => {
    render(<PublishSummaryArea summary={queuedSummary} />);
    expect(screen.getByTestId('publish-summary-area').textContent).toContain('queued');
    expect(screen.getByTestId('publish-summary-area').textContent).toContain('System');
  });

  it('awaiting theme renders with the client-owner callout', () => {
    render(<PublishSummaryArea summary={themeSummary} />);
    const area = screen.getByTestId('publish-summary-area');
    expect(area.textContent).toContain('awaiting theme');
    expect(area.textContent).toContain('Your move');
  });

  it('retrying renders the retry deadline and the visible failure', () => {
    render(<PublishSummaryArea summary={retrySummary} />);
    const area = screen.getByTestId('publish-summary-area');
    expect(area.textContent).toContain('retrying');
    expect(area.textContent).toContain('retry by');
    expect(area.textContent).toContain('dispatch held');
  });

  it('no summary renders nothing (a plain task never gets a fabricated status)', () => {
    const { container } = render(<PublishSummaryArea summary={null} />);
    expect(container.textContent).toBe('');
  });

  it('MarketingPublishButton renders the summary area under the button when given', () => {
    render(<MarketingPublishButton task={marketingTask()} summary={queuedSummary} />);
    const area = screen.getByTestId('publish-summary-area');
    expect(area.textContent).toContain('queued');
    expect(screen.getByRole('button', { name: /publish/i })).toBeTruthy();
  });

  it('MarketingPublishButton without summary renders the bare button (F06 path unchanged)', () => {
    render(<MarketingPublishButton task={marketingTask()} />);
    expect(screen.getByRole('button', { name: /publish/i })).toBeTruthy();
    expect(screen.queryByTestId('publish-summary-area')).toBeNull();
  });
});