/**
 * U016 — Fleet dashboard structural template tests.
 *
 * Renders the REAL fleet components (react-dom via @testing-library/react +
 * jsdom — see vitest.component.config.ts), never a hand-rolled restatement.
 *
 * Acceptance criteria:
 *   (a) Every exported component (StatusBadge, HealthIndicator, StatCard,
 *       EntityCard, CardGrid) renders without crashing.
 *   (b) Barrel exports work from @/components/fleet.
 *   (c) StatusBadge renders correct tone dot colors for each StatusTone variant.
 *   (d) StatCard with null value renders '–'.
 *   (e) CardGrid renders children.
 *
 *   npx vitest run --config vitest.component.config.ts
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import {
  StatusBadge,
  HealthIndicator,
  CardGrid,
  StatCard,
  EntityCard,
} from '@/components/fleet';

afterEach(() => cleanup());

/* ── (a) Render-each-component probes ────────────────────────────────────── */

describe('StatusBadge', () => {
  it('renders without crashing', () => {
    render(<StatusBadge tone="ok" label="Live" />);
    expect(screen.getByRole('status')).toBeDefined();
    expect(screen.getByText('Live')).toBeDefined();
  });

  it('renders an accessible role and aria-label', () => {
    render(<StatusBadge tone="info" label="Working" ariaLabel="Status: Working" />);
    const el = screen.getByRole('status');
    expect(el.getAttribute('aria-label')).toBe('Status: Working');
  });

  it('renders the pulse dot when pulse is true', () => {
    render(<StatusBadge tone="ok" label="Live" pulse />);
    const el = screen.getByRole('status');
    const dot = el.querySelector('.animate-pulse');
    expect(dot).toBeTruthy();
  });
});

describe('HealthIndicator', () => {
  it('renders without crashing', () => {
    render(
      <HealthIndicator
        title="Fleet"
        rows={[
          { label: 'Gateway', status: 'ok' },
          { label: 'Agents', status: 'error', statusText: '3 down' },
        ]}
      />,
    );
    expect(screen.getByText('Fleet')).toBeDefined();
    expect(screen.getByText('Gateway')).toBeDefined();
    expect(screen.getByText('Agents')).toBeDefined();
  });

  it('renders unknown status correctly', () => {
    render(
      <HealthIndicator
        rows={[{ label: 'Last heartbeat', status: 'unknown' }]}
      />,
    );
    expect(screen.getByText('Unknown')).toBeDefined();
  });

  it('renders footer content when provided', () => {
    render(
      <HealthIndicator
        rows={[{ label: 'Uptime', value: '99.9%' }]}
        footer={<span data-testid="footer">View all</span>}
      />,
    );
    expect(screen.getByTestId('footer')).toBeDefined();
    expect(screen.getByText('View all')).toBeDefined();
  });
});

describe('StatCard', () => {
  it('renders without crashing', () => {
    render(<StatCard label="Active Boxes" value={42} />);
    expect(screen.getByText('Active Boxes')).toBeDefined();
    expect(screen.getByText('42')).toBeDefined();
  });

  it('renders alert state', () => {
    render(<StatCard label="Blocked" value={3} alert />);
    // alert state → red text class present
    const container = screen.getByText('Blocked').closest('div');
    expect(container).toBeDefined();
    // The value div should have text-red-600 class
    const valDiv = screen.getByText('3');
    expect(valDiv.className).toContain('text-red-600');
  });
});

describe('EntityCard', () => {
  it('renders without crashing', () => {
    render(<EntityCard title="Box 1" description="Production" />);
    expect(screen.getByText('Box 1')).toBeDefined();
    expect(screen.getByText('Production')).toBeDefined();
  });

  it('renders a badge when badge > 0', () => {
    render(<EntityCard title="Agents" badge={5} />);
    expect(screen.getByText('5')).toBeDefined();
  });

  it('does NOT render badge when badge is 0', () => {
    render(<EntityCard title="Agents" badge={0} />);
    expect(screen.queryByText('0')).toBeNull();
  });

  it('renders an icon chip when icon is provided', () => {
    render(<EntityCard title="Box" icon={<span data-testid="my-icon">I</span>} chip="bg-blue-50 text-blue-600" />);
    expect(screen.getByTestId('my-icon')).toBeDefined();
  });
});

describe('CardGrid', () => {
  it('renders without crashing', () => {
    render(
      <CardGrid ariaLabel="Fleet boxes">
        <div>Child</div>
      </CardGrid>,
    );
    const grid = screen.getByLabelText('Fleet boxes');
    expect(grid).toBeDefined();
  });
});

/* ── (b) Barrel export verification ──────────────────────────────────────── */

describe('barrel exports', () => {
  it('exports all five components from @/components/fleet', () => {
    // If the barrel is broken, the import at the top of this file would fail
    // at module load time. This test just confirms the names resolve.
    expect(StatusBadge).toBeDefined();
    expect(HealthIndicator).toBeDefined();
    expect(CardGrid).toBeDefined();
    expect(StatCard).toBeDefined();
    expect(EntityCard).toBeDefined();
  });
});

/* ── (c) StatusBadge tone rendering ──────────────────────────────────────── */

describe('StatusBadge tone colors', () => {
  it('renders ok tone with emerald dot', () => {
    render(<StatusBadge tone="ok" label="Live" />);
    const el = screen.getByRole('status');
    const dot = el.querySelector('span[aria-hidden="true"]')!;
    expect(dot.className).toContain('bg-emerald-500');
  });

  it('renders error tone with red dot', () => {
    render(<StatusBadge tone="error" label="Offline" />);
    const el = screen.getByRole('status');
    const dot = el.querySelector('span[aria-hidden="true"]')!;
    expect(dot.className).toContain('bg-red-500');
  });

  it('renders info tone with blue dot', () => {
    render(<StatusBadge tone="info" label="Working" />);
    const el = screen.getByRole('status');
    const dot = el.querySelector('span[aria-hidden="true"]')!;
    expect(dot.className).toContain('bg-blue-500');
  });

  it('renders warn tone with amber dot', () => {
    render(<StatusBadge tone="warn" label="Degraded" />);
    const el = screen.getByRole('status');
    const dot = el.querySelector('span[aria-hidden="true"]')!;
    expect(dot.className).toContain('bg-amber-500');
  });

  it('renders neutral tone with gray dot', () => {
    render(<StatusBadge tone="neutral" label="Idle" />);
    const el = screen.getByRole('status');
    const dot = el.querySelector('span[aria-hidden="true"]')!;
    expect(dot.className).toContain('bg-gray-400');
  });
});

/* ── (d) StatCard null value → '–' ──────────────────────────────────────── */

describe('StatCard null value', () => {
  it('renders "–" when value is null', () => {
    render(<StatCard label="Sessions" value={null} />);
    expect(screen.getByText('–')).toBeDefined();
  });

  it('renders "–" when value is undefined', () => {
    render(<StatCard label="Sessions" value={undefined} />);
    expect(screen.getByText('–')).toBeDefined();
  });
});

/* ── (e) CardGrid renders children ───────────────────────────────────────── */

describe('CardGrid children', () => {
  it('renders children', () => {
    render(
      <CardGrid ariaLabel="Fleet grid">
        <div data-testid="child-a">A</div>
        <div data-testid="child-b">B</div>
      </CardGrid>,
    );
    expect(screen.getByTestId('child-a')).toBeDefined();
    expect(screen.getByTestId('child-b')).toBeDefined();
  });

  it('applies default grid classes', () => {
    render(
      <CardGrid ariaLabel="Grid">
        <div>X</div>
      </CardGrid>,
    );
    const grid = screen.getByLabelText('Grid');
    expect(grid.className).toContain('grid-cols-1');
    expect(grid.className).toContain('sm:grid-cols-2');
    expect(grid.className).toContain('lg:grid-cols-3');
    expect(grid.className).toContain('xl:grid-cols-4');
  });
});
