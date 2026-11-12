/**
 * "N approvals waiting": renders only when something waits, links to
 * /approvals, and is mounted in BOTH headers the owner can land on (the
 * dashboard home's inline header and the shared Header component).
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import fs from 'node:fs';
import path from 'node:path';
import { ApprovalsBadge } from '../../src/components/approvals/ApprovalsBadge';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const mockFetch = (count: number, ok = true) =>
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok, json: async () => ({ pending_count: count }) })));

describe('ApprovalsBadge', () => {
  it('shows the count and links to /approvals', async () => {
    mockFetch(3);
    render(<ApprovalsBadge />);
    const badge = await screen.findByTestId('approvals-badge');
    expect(badge.textContent).toContain('3 approvals waiting');
    expect(badge.getAttribute('href')).toBe('/approvals');
  });

  it('uses the singular for one', async () => {
    mockFetch(1);
    render(<ApprovalsBadge />);
    expect((await screen.findByTestId('approvals-badge')).textContent).toContain('1 approval waiting');
  });

  it('renders nothing when none wait, or when the count cannot be read', async () => {
    mockFetch(0);
    const { container, rerender } = render(<ApprovalsBadge />);
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalled());
    expect(container.querySelector('[data-testid="approvals-badge"]')).toBeNull();
    mockFetch(5, false);
    rerender(<ApprovalsBadge />);
    expect(container.querySelector('[data-testid="approvals-badge"]')).toBeNull();
  });
});

describe('mounted where the owner lands', () => {
  const src = (f: string) => fs.readFileSync(path.join(__dirname, '../../src', f), 'utf8');
  it('the dashboard home header renders the badge next to the health indicator', () => {
    const page = src('app/page.tsx');
    expect(page).toMatch(/<ApprovalsBadge \/>\s*<HealthIndicator viewerRole="client" \/>/);
  });
  it('the shared Header renders it too', () => {
    expect(src('components/Header.tsx')).toContain('<ApprovalsBadge />');
  });
});

describe('dashboard home page render', () => {
  it('renders the badge in the home header when approvals are waiting', async () => {
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).startsWith('/api/approval-requests')) return { ok: true, json: async () => ({ pending_count: 2 }) };
      return { ok: false, status: 503, json: async () => ({}) };
    }));
    vi.doMock('@/components/HealthIndicator', () => ({ HealthIndicator: () => <span data-testid="health-indicator" /> }));
    vi.doMock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }), usePathname: () => '/' }));
    const { default: HomePage } = await import('../../src/app/page');
    const { container } = render(<HomePage />);
    const badge = await screen.findByTestId('approvals-badge');
    expect(badge.textContent).toContain('2 approvals waiting');
    expect(badge.getAttribute('href')).toBe('/approvals');
    const header = container.querySelector('header');
    expect(header?.contains(badge)).toBe(true);
    expect(header?.contains(screen.getByTestId('health-indicator'))).toBe(true);
  });
});
