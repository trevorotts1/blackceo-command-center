import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import InterviewClient from '@/app/interview/InterviewClient';

// BU-25: a client tenant whose own box cannot be reached gets the spec sentence,
// not the reconnect hint that reads like "answer more".

const { router } = vi.hoisted(() => ({
  router: {
    replace: vi.fn(),
    push: vi.fn(),
    prefetch: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
  },
}));

vi.mock('next/navigation', () => ({ useRouter: () => router }));

// jsdom has no layout engine, and the interview chrome reaches for it.
beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  sessionStorage.clear();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

const BOX_UNREACHABLE =
  'We cannot reach your system right now. Your answers are saved. Please try again in a few minutes.';

describe('InterviewClient reads a box_unreachable reply', () => {
  it('shows the spec sentence instead of the lock hint', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/api/interview/next')) {
          return Response.json(
            { error: 'box_unreachable', message: BOX_UNREACHABLE },
            { status: 503 },
          );
        }
        return Response.json({ ok: true });
      }),
    );

    render(<InterviewClient />);

    const bar = await screen.findByRole('status');
    expect(bar.textContent).toContain(BOX_UNREACHABLE);
    expect(bar.textContent).not.toContain('Reconnecting… your answers are saved.');
  });

  it('keeps the reconnect hint for any other 503', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/api/interview/next')) {
          return Response.json({ error: 'temporarily_unavailable' }, { status: 503 });
        }
        return Response.json({ ok: true });
      }),
    );

    render(<InterviewClient />);

    const bar = await screen.findByRole('status');
    expect(bar.textContent).toContain('Reconnecting… your answers are saved.');
    expect(bar.textContent).not.toContain(BOX_UNREACHABLE);
  });
});
