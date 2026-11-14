import '../unit/_isolated-db'; // MUST be first: points DATABASE_PATH at a throwaway DB (C8 guard).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import ReviewScreen, { type ReviewAnswer } from '@/components/interview/ReviewScreen';

// WF-030 / WF-003 (BU-16): an inline edit REPLACES that question's answer. The
// POST body is {questionId, answer} — the typed text is the answer, with no
// "Updated on …" note and no verbatim `prompt` in it. A row with no questionId
// is read-only, and the trigger is armed only when the gate reports no required
// question still open.

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
    prefetch: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
  }),
}));

// The screen imports one server action for the shell-lock cookie; it is never
// exercised by these renders and it pulls Node-only modules.
vi.mock('@/components/interview/gate-actions', () => ({
  refreshInterviewGate: vi.fn(async () => undefined),
}));

const ROWS: ReviewAnswer[] = [
  {
    id: 'row-company-name',
    questionId: 'company_name',
    question: 'What name should we put on everything we build for you?',
    answer: 'Old Name Co',
    phase: 'About you',
    editable: true,
  },
  {
    // No questionId: the gate cannot address it, so it renders read-only.
    id: 'row-without-id',
    question: 'What industry are you in?',
    answer: 'Life coaching',
    phase: 'About you',
  },
];

type FetchCall = { url: string; init?: RequestInit };

function mockFetch(state: Record<string, unknown>) {
  const calls: FetchCall[] = [];
  const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.includes('/api/interview/answer')) {
      return { ok: true, status: 200, json: async () => ({ ok: true, accepted: true }) };
    }
    return { ok: true, status: 200, json: async () => state };
  });
  vi.stubGlobal('fetch', fetchMock);
  return { calls };
}

function stateBody(gate: unknown, flags?: Record<string, boolean>) {
  return {
    ok: true,
    flags: flags ?? {
      genuineTranscriptReady: true,
      decisionCoverageComplete: true,
      noUnprovenancedDeclines: true,
    },
    gate,
    resume: {
      status: null,
      nextQuestionNumber: null,
      skippedQuestions: [],
      totalQuestionsAnswered: 1,
      handoffExists: false,
    },
    decisionCoverage: { complete: true, missing: [], rejections: [] },
    progress: { lastQuestionNumber: 1, phasesComplete: [], percent: 100 },
  };
}

afterEach(() => {
  cleanup();
  localStorage.clear();
  sessionStorage.clear();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('BU-16 — a review-screen edit replaces the answer', () => {
  it('posts exactly the typed text as the answer, addressed by question id', async () => {
    const { calls } = mockFetch(stateBody({ missingRequired: [], requiredTotal: 1, requiredAnswered: 1, percent: 100 }));
    render(<ReviewScreen answers={ROWS} autoLoad={false} />);

    fireEvent.click(
      screen.getByLabelText('Edit answer: What name should we put on everything we build for you?'),
    );
    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: 'Bright Path Coaching' },
    });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => {
      expect(calls.some((c) => c.url.includes('/api/interview/answer'))).toBe(true);
    });

    const post = calls.find((c) => c.url.includes('/api/interview/answer'))!;
    const body = JSON.parse(String(post.init?.body));

    // The acceptance line: answer is exactly the typed text, questionId is the id.
    expect(body.answer).toBe('Bright Path Coaching');
    expect(body.questionId).toBe('company_name');
    // No "Updated on" note, no verbatim prompt, no other fields sent.
    expect(body.prompt).toBeUndefined();
    expect(body.answer).not.toContain('Updated on');
    expect(Object.keys(body).sort()).toEqual(['answer', 'questionId']);
  });

  it('shows a row with no question id read-only', () => {
    mockFetch(stateBody({ missingRequired: [], requiredTotal: 1, requiredAnswered: 1, percent: 100 }));
    render(<ReviewScreen answers={ROWS} autoLoad={false} />);

    expect(screen.getByText('Life coaching')).toBeTruthy();
    expect(screen.queryByLabelText('Edit answer: What industry are you in?')).toBeNull();
    // The addressed row still offers its editor.
    expect(
      screen.getByLabelText('Edit answer: What name should we put on everything we build for you?'),
    ).toBeTruthy();
  });
});

describe('BU-16 — the trigger follows the gate, not only the three flags', () => {
  it('stays locked while the gate reports a required question still open', async () => {
    mockFetch(
      stateBody({ missingRequired: ['industry'], requiredTotal: 2, requiredAnswered: 1, percent: 50 }),
    );
    render(<ReviewScreen answers={ROWS} />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Build my company/i })).toBeTruthy();
    });
    const build = screen.getByRole('button', { name: /Build my company/i }) as HTMLButtonElement;
    expect(build.disabled).toBe(true);
    expect(screen.getByRole('button', { name: 'Answer now' })).toBeTruthy();
  });

  it('arms once the gate reports nothing required still open', async () => {
    mockFetch(
      stateBody({ missingRequired: [], requiredTotal: 2, requiredAnswered: 2, percent: 100 }),
    );
    render(<ReviewScreen answers={ROWS} />);

    await waitFor(() => {
      const build = screen.getByRole('button', {
        name: /Build my company/i,
      }) as HTMLButtonElement;
      expect(build.disabled).toBe(false);
    });
    expect(screen.queryByRole('button', { name: 'Answer now' })).toBeNull();
  });
});
