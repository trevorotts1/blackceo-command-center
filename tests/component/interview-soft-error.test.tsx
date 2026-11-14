import '../unit/_isolated-db'; // MUST be first: points DATABASE_PATH at a throwaway DB (C8 guard).
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import InterviewClient from '@/app/interview/InterviewClient';

// WF-012: a failed progress read must never eject the owner from the interview.
// Only a 401/403 (a real access refusal) may replace the screen.

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

/** A verified /api/interview/state body (verifiedProgress: ok + session + resume + structured). */
const READY_STATE = {
  ok: true,
  companyId: 'company-one',
  installationId: 'install-one',
  buildId: null,
  interviewComplete: false,
  buildCompleted: false,
  qcStatus: 'pending',
  session: { interviewSessionId: 'session-one', gatewaySessionId: null },
  structured: { total: 3, answeredIds: [], remainingIds: [], nextIndex: 0, complete: false, skippedIds: [] },
  knownContext: {},
  progress: { lastQuestionNumber: 0, phasesComplete: [], percent: 0 },
  resume: {
    status: null,
    nextQuestionNumber: null,
    skippedQuestions: [],
    totalQuestionsAnswered: 0,
    handoffExists: false,
  },
  transcript: { exists: false, qBlockCount: 0, sizeBytes: 0, hasSyntheticHeader: false, genuine: false },
  decisionCoverage: { complete: false, expected: [], covered: [], missing: [], declined: [], rejections: [] },
  flags: { genuineTranscriptReady: false, decisionCoverageComplete: false, noUnprovenancedDeclines: false },
};

/** The gate's first question, shaped exactly like GET /api/interview/next. */
const FIRST_QUESTION = {
  done: false,
  id: 'company_name',
  section: 'company',
  kind: 'text',
  prompt: 'What name should we put on everything we build for you?',
  help: 'Use the name your customers know you by. You can change it later.',
  example: 'Bright Path Coaching',
  required: true,
  allowSkip: false,
  allowUnsure: false,
  allowOther: false,
  minChars: 2,
  minWords: 1,
  requiredTotal: 15,
  requiredAnswered: 0,
  answeredTotal: 0,
  percent: 0,
  attempt: 1,
};

describe('InterviewClient survives a failed progress read', () => {
  it('keeps the question card on screen and says it is reconnecting', async () => {
    let gateReads = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/api/interview/next')) {
          gateReads += 1;
          // The first read succeeds; the re-read after the answer is a server error.
          return gateReads === 1
            ? Response.json(FIRST_QUESTION)
            : Response.json({ error: 'server_error' }, { status: 500 });
        }
        if (url.includes('/api/interview/state')) return Response.json(READY_STATE);
        if (url.includes('/api/interview/gate-status')) return Response.json({ standardReady: false });
        if (url.includes('/api/interview/answer')) {
          return Response.json({ ok: true, appended: true, accepted: true, questionId: 'company_name' });
        }
        return Response.json({ ok: true });
      }),
    );

    render(<InterviewClient />);

    // The first gate read landed and the welcome screen is up.
    fireEvent.click(await screen.findByRole('button', { name: 'Start' }));

    // The current question card.
    const box = (await screen.findByPlaceholderText(
      'Type or speak your answer…',
    )) as HTMLInputElement | HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: 'Acme Co' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

    // The re-read after the answer failed — the card stays, the bar appears.
    const bar = await screen.findByRole('status');
    expect(bar.textContent).toContain('Reconnecting… your answers are saved.');
    expect(screen.getByPlaceholderText('Type or speak your answer…')).toBeTruthy();
    expect(screen.queryByText('Check your access')).toBeNull();
  });

  it('keeps the full-screen access view when the read is refused', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/api/interview/next')) {
          return Response.json({ error: 'forbidden' }, { status: 403 });
        }
        return Response.json({ ok: true });
      }),
    );

    render(<InterviewClient />);

    expect(await screen.findByText('Check your access')).toBeTruthy();
  });
});
