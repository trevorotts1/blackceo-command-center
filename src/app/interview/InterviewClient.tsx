'use client';

/**
 * InterviewClient — the orchestrator for the /interview surface (Wave 5 · P4,
 * continuity overhaul v4.63).
 *
 * It drives the seven interview components as ONE coherent flow, entirely from
 * server truth (GET /api/interview/state) and the canonical write routes. It
 * never writes a canonical file itself; every persistence path goes through an
 * API route (turn / answer / decision / complete), which press the exact same
 * scripts the Telegram interview agent presses.
 *
 * ── The phases it orchestrates ────────────────────────────────────────────────
 *   0  CONSENT       — three options, NONE auto-selected; Begin stays disabled
 *                      until an explicit choice (never auto-select). Shown ONLY
 *                      when nothing has ever been answered.
 *   RESUME           — whenever ANY answer exists (a structured card, a
 *                      conversational turn, or a Telegram-recorded block), the
 *                      owner lands on <WelcomeBack> and resumes EXACTLY where
 *                      they left off:
 *                        • structured set incomplete → the FIRST unanswered
 *                          card (structured.nextIndex, computed server-side
 *                          from the canonical transcript);
 *                        • structured set complete → the free-form conversation.
 *                      Resume is the only forward path — no "start over".
 *   1-5 Q&A          — structured cards one at a time (identity → branding →
 *                      operations), each POSTing /api/interview/answer with its
 *                      question number + phase so progress is stamped per
 *                      answer. Questions already answered are SKIPPED (never
 *                      re-asked); known facts are prefilled as confirm-or-
 *                      correct. Then the conversational depth over
 *                      /api/interview/turn, with pending-reply recovery polling.
 *   5.5 DEPARTMENTS  — <DepartmentBoard>; coverage gate (build gates #3 ∧ #8).
 *   6  REVIEW        — <ReviewScreen>: triple-gated "Build my company".
 *
 * ── Continuity guarantees (new in v4.63) ─────────────────────────────────────
 *   • The structured position is SERVER-derived (transcript → answeredIds →
 *     nextIndex): a refresh, a new browser, or a hop from Telegram all land on
 *     the exact next unanswered question with every prior answer intact.
 *   • The gateway conversation session id is persisted per interview
 *     (localStorage, keyed by the stable interviewSessionId), so a reload
 *     continues the SAME interviewer session instead of minting a fresh one.
 *   • A turn whose reply outlives the request window is no longer a dead-end:
 *     the client polls GET /api/interview/turn until the interviewer's reply
 *     lands.
 *
 * ── Clean client bundle ───────────────────────────────────────────────────────
 * Imports NOTHING from the Node-only interview seam. The structured set is the
 * shared client-safe base questions + the same vendored branding JSON the Node
 * module loads — one definition per question, zero drift.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AnimatePresence, MotionConfig, motion } from 'framer-motion';
import { ArrowRight, Info, Lock, Sparkles } from 'lucide-react';

import { iv, ivcx, ivScreenVariants } from '@/components/interview/interview-theme';
import {
  IDENTITY_QUESTIONS,
  OPERATIONS_QUESTIONS,
  type InterviewQuestion,
} from '@/lib/interview/base-questions';
import {
  nextStructuredIndex,
  personalizePrompt,
} from '@/lib/interview/structured-progress';
import brandingRaw from '@/lib/interview-questions.branding-questions.json';

import ProgressRail from '@/components/interview/ProgressRail';
import QuestionCard from '@/components/interview/QuestionCard';
import ConversationPane from '@/components/interview/ConversationPane';
import DepartmentBoard from '@/components/interview/DepartmentBoard';
import ReviewScreen from '@/components/interview/ReviewScreen';
import MilestoneScreen from '@/components/interview/MilestoneScreen';
import WelcomeBack from '@/components/interview/WelcomeBack';

import { useCompanyBrand } from '@/hooks/useCompanyBrand';
import { useLogoUrl } from '@/hooks/useLogoUrl';
import { skipInterviewForNow } from '@/components/interview/gate-actions';

/* -------------------------------------------------------------------------- */
/* structured question set (shared base + vendored branding JSON)              */
/* -------------------------------------------------------------------------- */

/** identity → branding → operations: the full ordered structured set. Mirrors
 *  INTERVIEW_QUESTIONS in src/lib/interview-questions.ts exactly — identity and
 *  operations come from the SAME shared module; branding from the SAME JSON. */
const STRUCTURED_QUESTIONS: InterviewQuestion[] = [
  ...IDENTITY_QUESTIONS,
  ...((brandingRaw as { questions: unknown }).questions as InterviewQuestion[]),
  ...OPERATIONS_QUESTIONS,
];

/** Jargon-free milestone name for a completed structured section. */
const SECTION_MILESTONE: Record<InterviewQuestion['section'], string> = {
  identity: 'Your company',
  branding: 'Your brand',
  operations: 'How you run',
};

/* -------------------------------------------------------------------------- */
/* JSON shapes (mirror the API routes — kept local so no Node import leaks in) */
/* -------------------------------------------------------------------------- */

interface GateFlags {
  genuineTranscriptReady: boolean;
  decisionCoverageComplete: boolean;
  noUnprovenancedDeclines: boolean;
}

interface InterviewStateResponse {
  ok: boolean;
  interviewComplete: boolean;
  buildCompleted: boolean;
  qcStatus: string;
  session?: { interviewSessionId: string | null };
  structured?: {
    total: number;
    answeredIds: string[];
    remainingIds: string[];
    nextIndex: number | null;
    complete: boolean;
  };
  knownContext?: Record<string, { value: string; source: string }>;
  progress: {
    lastQuestionNumber: number | null;
    phasesComplete: string[];
    percent: number;
  };
  resume: {
    status: string | null;
    nextQuestionNumber: number | null;
    skippedQuestions: number[];
    totalQuestionsAnswered: number | null;
    handoffExists: boolean;
  };
  transcript?: {
    exists: boolean;
    qBlockCount: number;
    sizeBytes: number;
    hasSyntheticHeader: boolean;
    genuine: boolean;
  };
  decisionCoverage: {
    complete: boolean;
    expected: string[];
    covered: string[];
    missing: string[];
    declined: string[];
    rejections: string[];
  };
  flags: GateFlags;
}

interface TurnResponse {
  sessionId?: string;
  reply?: string | null;
  pending?: boolean;
  agentCount?: number;
  error?: string;
  message?: string;
}

/* -------------------------------------------------------------------------- */
/* local UI state                                                              */
/* -------------------------------------------------------------------------- */

/** The three welcome/consent options. Null = nothing selected (the default). */
type Consent = 'full' | 'quick' | 'learn' | null;

/** The orchestrated phases (0-6, with the department board as 5.5). */
type Stage = 'consent' | 'welcome-back' | 'qa' | 'milestone' | 'departments' | 'review';

/** Within the Q&A stage: structured cards first, then free-form conversation. */
type QaMode = 'structured' | 'conversation';

interface PendingMilestone {
  phase: string;
  completed?: number;
  total?: number;
  unit?: string;
}

const ALL_GATES_FALSE: GateFlags = {
  genuineTranscriptReady: false,
  decisionCoverageComplete: false,
  noUnprovenancedDeclines: false,
};

/** How long the pending-reply recovery keeps polling before going quiet. */
const RECOVERY_WINDOW_MS = 90_000;
const RECOVERY_POLL_MS = 3_500;

/** Session-storage key for structured questions the owner skipped this device. */
const SKIPPED_KEY = 'iv-skipped-structured';

/** localStorage key for the persisted gateway conversation session. */
function gatewaySessionKey(interviewSessionId: string | null): string {
  return `iv-gw-session:${interviewSessionId ?? 'default'}`;
}

/* -------------------------------------------------------------------------- */
/* component                                                                   */
/* -------------------------------------------------------------------------- */

export default function InterviewClient() {
  const router = useRouter();

  // P3-2 live-rebrand hooks — the surface re-themes the instant branding answers
  // land (BrandTheme rewrites the --brand-* vars the iv-* tokens point at).
  const logoUrl = useLogoUrl();
  const brand = useCompanyBrand();

  // Phase machine.
  const [stage, setStage] = useState<Stage>('consent');
  const [consent, setConsent] = useState<Consent>(null);
  const [qaMode, setQaMode] = useState<QaMode>('structured');
  const [structIndex, setStructIndex] = useState(0);

  // Server truth (progress rail + resume + gate flags + structured position).
  const [state, setState] = useState<InterviewStateResponse | null>(null);
  const [booting, setBooting] = useState(true);

  // Structured answers recorded THIS session (merged with the server's set so a
  // just-answered card is skipped even before the next /state read lands).
  const [locallyAnswered, setLocallyAnswered] = useState<Set<string>>(new Set());
  // Structured questions the owner skipped (persisted per device; optional Qs only).
  const [skippedIds, setSkippedIds] = useState<Set<string>>(new Set());
  // Saved-ticker: when the last successful answer save landed.
  const [lastSavedAt, setLastSavedAt] = useState<number | null>(null);

  // Conversation (free-form Q&A depth).
  const [currentQuestion, setCurrentQuestion] = useState('');
  const [currentReaction, setCurrentReaction] = useState('');
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [awaitingReply, setAwaitingReply] = useState(false);
  const [sessionId, setSessionIdState] = useState<string | null>(null);

  // Department board completeness (gates #3 ∧ #8), relayed via onCoverageChange.
  const [boardComplete, setBoardComplete] = useState(false);

  // Milestone interstitial (words only).
  const [milestone, setMilestone] = useState<PendingMilestone | null>(null);
  const afterMilestone = useRef<() => void>(() => {});

  // One-shot guards + recovery-poll bookkeeping.
  const routedRef = useRef(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const recoveryRef = useRef<{ token: number }>({ token: 0 });

  const flags = state?.flags ?? ALL_GATES_FALSE;
  const transcriptReady = flags.genuineTranscriptReady;
  const interviewSessionId = state?.session?.interviewSessionId ?? null;
  const knownContext = state?.knownContext ?? {};
  const companyName = knownContext.company_name?.value ?? null;

  /* ---- answered/skipped bookkeeping ---- */

  const answeredIds = useMemo(() => {
    const ids = new Set(state?.structured?.answeredIds ?? []);
    locallyAnswered.forEach((id) => ids.add(id));
    return ids;
  }, [locallyAnswered, state?.structured?.answeredIds]);

  /** Structured questions skipped AND still unanswered (the circle-back queue). */
  const skippedQueue = useMemo(
    () => STRUCTURED_QUESTIONS.filter((q) => skippedIds.has(q.id) && !answeredIds.has(q.id)),
    [answeredIds, skippedIds],
  );

  const persistSkipped = useCallback((ids: Set<string>) => {
    try {
      sessionStorage.setItem(SKIPPED_KEY, JSON.stringify(Array.from(ids)));
    } catch {
      /* private mode — chips simply don't survive this tab */
    }
  }, []);

  /* ---- gateway-session persistence (continuity across reloads) ---- */

  const setSessionId = useCallback(
    (id: string | null) => {
      setSessionIdState(id);
      try {
        const key = gatewaySessionKey(interviewSessionId);
        if (id) localStorage.setItem(key, id);
        else localStorage.removeItem(key);
      } catch {
        /* storage unavailable — the session just won't survive a reload */
      }
    },
    [interviewSessionId],
  );

  /* ---- state (progress + resume + gate flags) ---- */

  const loadState = useCallback(async (): Promise<InterviewStateResponse | null> => {
    try {
      const res = await fetch('/api/interview/state', { cache: 'no-store' });
      const data = (await res.json()) as InterviewStateResponse;
      setState(data);
      return data;
    } catch {
      // Non-fatal: the rail stays as-is and gates stay fail-closed until the next
      // successful read.
      return null;
    }
  }, []);

  // On mount: read state once and route to the right screen. ANY prior answer —
  // structured card, conversational turn, or a Telegram block — routes to
  // WelcomeBack (never consent, never question 1).
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const data = await loadState();
      if (cancelled) return;
      setBooting(false);
      if (routedRef.current) return;
      routedRef.current = true;

      // Restore per-device skipped chips.
      try {
        const raw = sessionStorage.getItem(SKIPPED_KEY);
        if (raw) setSkippedIds(new Set(JSON.parse(raw) as string[]));
      } catch {
        /* ignore */
      }

      if (!data) return;

      // A COMPLETED interview never shows the resume nag, regardless of answer
      // counts — the owner is done; route straight to the dashboard (already
      // unlocked by the gate cookie once interviewComplete is true). Checked
      // FIRST, ahead of the answeredCount branch below.
      if (data.interviewComplete === true) {
        router.replace('/');
        return;
      }

      // Restore the gateway conversation session for this interview.
      try {
        const stored = localStorage.getItem(
          gatewaySessionKey(data.session?.interviewSessionId ?? null),
        );
        if (stored) setSessionIdState(stored);
      } catch {
        /* ignore */
      }

      const answeredCount =
        (data.structured?.answeredIds.length ?? 0) ||
        (data.transcript?.qBlockCount ?? 0) ||
        (data.resume?.totalQuestionsAnswered ?? 0);

      if (answeredCount > 0) {
        setStage('welcome-back');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [loadState, router]);

  /* ---- pending-reply recovery (a slow interviewer is not a dead-end) ---- */

  const startRecoveryPoll = useCallback(
    (sid: string, after: number) => {
      const token = ++recoveryRef.current.token;
      const deadline = Date.now() + RECOVERY_WINDOW_MS;
      setAwaitingReply(true);

      const poll = async () => {
        if (recoveryRef.current.token !== token) return; // superseded
        if (Date.now() > deadline) {
          setAwaitingReply(false);
          setCurrentReaction(
            'Your interviewer is taking a moment. Your answers are safe — send another message whenever you like.',
          );
          return;
        }
        try {
          const res = await fetch(
            `/api/interview/turn?sessionId=${encodeURIComponent(sid)}&after=${after}`,
            { cache: 'no-store' },
          );
          if (res.ok) {
            const data = (await res.json()) as TurnResponse;
            if (recoveryRef.current.token !== token) return;
            if (data.reply && data.reply.trim()) {
              setAwaitingReply(false);
              setCurrentReaction('');
              setCurrentQuestion(data.reply);
              void loadState();
              return;
            }
          }
        } catch {
          /* transient — keep polling until the deadline */
        }
        setTimeout(() => void poll(), RECOVERY_POLL_MS);
      };
      setTimeout(() => void poll(), RECOVERY_POLL_MS);
    },
    [loadState],
  );

  /* ---- a single conversational turn (free-form depth) ---- */

  const sendTurn = useCallback(
    async (content: string) => {
      const text = content.trim();
      if (!text || sending) return;
      setSending(true);
      setCurrentReaction('');
      recoveryRef.current.token++; // cancel any in-flight recovery poll
      setAwaitingReply(false);
      try {
        const res = await fetch('/api/interview/turn', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ content: text, sessionId: sessionId ?? undefined }),
        });

        if (res.status === 503) {
          const data = (await res.json().catch(() => ({}))) as TurnResponse;
          setCurrentReaction(
            data.message ??
              'Your interviewer is reconnecting. Your answers are safe — try again in a moment.',
          );
          return;
        }

        const data = (await res.json().catch(() => ({}))) as TurnResponse;
        if (data.sessionId) setSessionId(data.sessionId);

        if (!res.ok) {
          setCurrentReaction(
            data.message ?? 'Something went wrong sending that. Please try again.',
          );
          return;
        }

        if (data.reply && data.reply.trim()) {
          setCurrentQuestion(data.reply);
        } else if (data.pending) {
          setCurrentReaction(
            'Your interviewer is thinking — their next question will appear here shortly.',
          );
          if (data.sessionId) {
            startRecoveryPoll(data.sessionId, data.agentCount ?? 0);
          }
        }
      } catch {
        setCurrentReaction('Network hiccup — that message did not send. Please try again.');
      } finally {
        setSending(false);
        // Re-read progress + gate flags after every turn so the continue affordance
        // arms the instant the transcript gate is satisfied.
        void loadState();
      }
    },
    [loadState, sending, sessionId, setSessionId, startRecoveryPoll],
  );

  /* ---- milestone helper (words only) ---- */

  const fireMilestone = useCallback((m: PendingMilestone, next: () => void) => {
    afterMilestone.current = next;
    setMilestone(m);
    setStage('milestone');
  }, []);

  const dismissMilestone = useCallback(() => {
    const next = afterMilestone.current;
    afterMilestone.current = () => {};
    setMilestone(null);
    next();
  }, []);

  /* ---- entering the conversational (free-form) sub-phase ---- */

  const startConversation = useCallback(() => {
    setQaMode('conversation');
    setStage('qa');
    setCurrentQuestion('');
    // Ground the interviewer with what the cards already captured (memory): the
    // agent reads the transcript, and this opening keeps the in-session context
    // aligned with it so nothing is re-asked.
    const intro = companyName
      ? `I've shared my company's basics — I'm ${companyName}'s owner, and I'm ready to talk through how my business actually runs day to day. Please don't re-ask anything I've already answered.`
      : "I've shared my company's basics — I'm ready to talk through how my business actually runs day to day. Please don't re-ask anything I've already answered.";
    void sendTurn(intro);
  }, [companyName, sendTurn]);

  /* ---- advancing the structured question set ---- */

  const advanceStructured = useCallback(
    (fromIndex: number, opts: { skipped?: boolean } = {}) => {
      const q = STRUCTURED_QUESTIONS[fromIndex];

      let nextAnswered = answeredIds;
      if (opts.skipped) {
        setSkippedIds((prev) => {
          const next = new Set(prev);
          next.add(q.id);
          persistSkipped(next);
          return next;
        });
      } else {
        setLocallyAnswered((prev) => new Set(prev).add(q.id));
        nextAnswered = new Set(answeredIds).add(q.id);
        setLastSavedAt(Date.now());
      }
      void loadState();

      const skipSet = new Set(skippedIds);
      if (opts.skipped) skipSet.add(q.id);

      const nextIdx = nextStructuredIndex(
        STRUCTURED_QUESTIONS,
        fromIndex + 1,
        nextAnswered,
        skipSet,
      );

      const done = nextIdx === null;
      const next = done ? undefined : STRUCTURED_QUESTIONS[nextIdx];
      const atSectionBoundary = done || (next && next.section !== q.section);

      if (!done) setStructIndex(nextIdx);
      if (!atSectionBoundary) return; // stay on the structured cards

      // Section complete → celebrate (words only), then continue.
      fireMilestone({ phase: SECTION_MILESTONE[q.section] }, () => {
        if (done) startConversation();
        else setStage('qa');
      });
    },
    [
      answeredIds,
      fireMilestone,
      loadState,
      persistSkipped,
      skippedIds,
      startConversation,
    ],
  );

  /* ---- Q&A → departments (gated on a genuine transcript) ---- */

  const goToDepartments = useCallback(() => {
    fireMilestone({ phase: 'Your team' }, () => setStage('departments'));
  }, [fireMilestone]);

  /* ---- departments → review (celebrate with the REAL department counts) ---- */

  const goToReview = useCallback(async () => {
    const data = await loadState();
    const cov = data?.decisionCoverage;
    const completed = cov?.covered.length ?? 0;
    const total = cov?.expected.length ?? 0;
    fireMilestone(
      { phase: 'Your departments', completed, total, unit: 'department' },
      () => setStage('review'),
    );
  }, [fireMilestone, loadState]);

  /* ---- U057 skip-for-now handler ---- */

  const handleSkipForNow = useCallback(async () => {
    try { await skipInterviewForNow(); } catch { /* non-fatal */ }
    router.push('/');
  }, [router]);

  /* ---- consent → begin (never proceed without an explicit choice) ---- */

  const beginInterview = useCallback(() => {
    if (consent === null) return;
    setQaMode('structured');
    setStructIndex(
      nextStructuredIndex(STRUCTURED_QUESTIONS, 0, answeredIds, skippedIds) ?? 0,
    );
    setStage('qa');
  }, [answeredIds, consent, skippedIds]);

  /* ---- resume (WelcomeBack) — land EXACTLY where the owner left off ---- */

  const resumeInterview = useCallback(() => {
    const nextIdx = nextStructuredIndex(STRUCTURED_QUESTIONS, 0, answeredIds, skippedIds);
    if (nextIdx !== null) {
      // Structured set unfinished → back to the first unanswered card.
      setQaMode('structured');
      setStructIndex(nextIdx);
      setStage('qa');
      return;
    }
    // Structured set done → continue the conversation where it left off.
    setQaMode('conversation');
    setStage('qa');
    setCurrentQuestion('');
    void sendTurn(
      companyName
        ? `I'm back to continue ${companyName}'s interview — let's pick up right where we left off. Please don't re-ask anything I've already answered.`
        : "I'm back — let's pick up right where we left off. Please don't re-ask anything I've already answered.",
    );
  }, [answeredIds, companyName, sendTurn, skippedIds]);

  /** Circle back to a SKIPPED STRUCTURED question — re-opens that exact card. */
  const circleBackStructured = useCallback((questionId: string) => {
    const idx = STRUCTURED_QUESTIONS.findIndex((q) => q.id === questionId);
    if (idx < 0) return;
    setSkippedIds((prev) => {
      const next = new Set(prev);
      next.delete(questionId);
      persistSkipped(next);
      return next;
    });
    setQaMode('structured');
    setStructIndex(idx);
    setStage('qa');
  }, [persistSkipped]);

  /** Circle back to a numbered CONVERSATIONAL question (agent-owned queue). */
  const circleBack = useCallback(
    (questionNumber: number | null) => {
      setQaMode('conversation');
      setStage('qa');
      setCurrentQuestion('');
      void sendTurn(
        questionNumber != null
          ? `I'd like to go back and answer question ${questionNumber} now.`
          : "I'd like to revisit a question I skipped earlier.",
      );
    },
    [sendTurn],
  );

  /* ---- renders ---- */

  const brandStyle = brand.primaryColor
    ? ({ ['--iv-accent-strong' as string]: brand.primaryColor } as React.CSSProperties)
    : undefined;

  const answersSaved =
    state?.transcript?.qBlockCount ??
    Math.max(answeredIds.size, state?.resume.totalQuestionsAnswered ?? 0);

  let screen: React.ReactNode;

  if (stage === 'milestone' && milestone) {
    screen = (
      <MilestoneScreen
        phase={milestone.phase}
        unit={milestone.unit}
        completed={milestone.completed}
        totalDepts={milestone.total}
        onDismiss={dismissMilestone}
      />
    );
  } else if (stage === 'welcome-back') {
    const nextIdx = nextStructuredIndex(STRUCTURED_QUESTIONS, 0, answeredIds, skippedIds);
    const nextPrompt =
      nextIdx !== null
        ? personalizePrompt(STRUCTURED_QUESTIONS[nextIdx].prompt, companyName)
        : null;
    screen = (
      <WelcomeBack
        percent={state?.progress.percent ?? 0}
        answersSaved={answersSaved}
        nextQuestionNumber={state?.resume.nextQuestionNumber ?? null}
        nextUpPrompt={nextPrompt}
        skippedQuestions={state?.resume.skippedQuestions ?? []}
        skippedStructured={skippedQueue.map((q) => ({
          id: q.id,
          prompt: personalizePrompt(q.prompt, companyName),
        }))}
        onContinue={resumeInterview}
        onReviewSkipped={circleBack}
        onReviewSkippedStructured={circleBackStructured}
      />
    );
  } else if (stage === 'departments') {
    screen = (
      <DepartmentsStage
        sessionId={sessionId}
        onCoverageChange={setBoardComplete}
        boardComplete={boardComplete}
        onContinue={() => void goToReview()}
      />
    );
  } else if (stage === 'review') {
    screen = (
      <div style={brandStyle}>
        <ReviewScreen sessionId={sessionId ?? undefined} onCircleBack={circleBack} />
      </div>
    );
  } else if (stage === 'qa') {
    const question = STRUCTURED_QUESTIONS[structIndex];
    const known = question ? knownContext[question.id] : undefined;
    screen = (
      <QaStage
        brandStyle={brandStyle}
        logoUrl={logoUrl}
        phasesComplete={state?.progress.phasesComplete ?? []}
        percent={state?.progress.percent ?? 0}
        answersSaved={answersSaved}
        lastSavedAt={lastSavedAt}
        mode={qaMode}
        question={qaMode === 'structured' ? question : undefined}
        questionNumber={structIndex + 1}
        knownValue={known?.value}
        knownSource={known?.source}
        companyName={companyName}
        sessionId={sessionId}
        onAnswered={() => advanceStructured(structIndex)}
        onSkip={() => advanceStructured(structIndex, { skipped: true })}
        // conversation props
        currentQuestion={currentQuestion}
        currentReaction={currentReaction}
        input={input}
        onInput={setInput}
        onSend={() => {
          const text = input;
          setInput('');
          void sendTurn(text);
        }}
        onIDontKnow={(msg) => void sendTurn(msg)}
        sending={sending || awaitingReply}
        scrollRef={scrollRef}
        transcriptReady={transcriptReady}
        onContinueToDepartments={goToDepartments}
      />
    );
  } else {
    // stage === 'consent'
    screen = (
      <ConsentScreen
        logoUrl={logoUrl}
        brandStyle={brandStyle}
        consent={consent}
        booting={booting}
        onSelect={setConsent}
        onBegin={beginInterview}
        onSkip={handleSkipForNow}
      />
    );
  }

  // Respect the OS reduced-motion preference across every interview animation.
  return <MotionConfig reducedMotion="user">{screen}</MotionConfig>;
}

/* -------------------------------------------------------------------------- */
/* Q&A stage — ALWAYS shows the ProgressRail; structured card OR conversation  */
/* -------------------------------------------------------------------------- */

function QaStage({
  brandStyle,
  logoUrl,
  phasesComplete,
  percent,
  answersSaved,
  lastSavedAt,
  mode,
  question,
  questionNumber,
  knownValue,
  knownSource,
  companyName,
  sessionId,
  onAnswered,
  onSkip,
  currentQuestion,
  currentReaction,
  input,
  onInput,
  onSend,
  onIDontKnow,
  sending,
  scrollRef,
  transcriptReady,
  onContinueToDepartments,
}: {
  brandStyle?: React.CSSProperties;
  logoUrl: string;
  phasesComplete: string[];
  percent: number;
  answersSaved: number;
  lastSavedAt: number | null;
  mode: QaMode;
  question?: InterviewQuestion;
  questionNumber: number;
  knownValue?: string;
  knownSource?: string;
  companyName: string | null;
  sessionId: string | null;
  onAnswered: () => void;
  onSkip: () => void;
  currentQuestion: string;
  currentReaction: string;
  input: string;
  onInput: (v: string) => void;
  onSend: () => void;
  onIDontKnow: (msg: string) => void;
  sending: boolean;
  scrollRef: React.RefObject<HTMLDivElement>;
  transcriptReady: boolean;
  onContinueToDepartments: () => void;
}) {
  return (
    <div className={iv.root} style={brandStyle}>
      <div className="mx-auto grid w-full max-w-5xl grid-cols-1 gap-8 px-5 py-8 lg:grid-cols-[1fr_260px]">
        {/* ── main column ─────────────────────────────────────────────────── */}
        <main className={iv.stage} style={{ width: '100%' }}>
          <BrandHeader logoUrl={logoUrl} />

          {mode === 'structured' && question ? (
            <AnimatePresence mode="wait">
              <QuestionCard
                key={question.id}
                question={question}
                questionNumber={questionNumber}
                knownValue={knownValue}
                knownSource={knownSource}
                companyName={companyName}
                sessionId={sessionId ?? undefined}
                onAnswered={onAnswered}
                onSkip={onSkip}
                autoFocus
              />
            </AnimatePresence>
          ) : (
            <div>
              <ConversationPane
                currentReaction={currentReaction}
                currentQuestion={currentQuestion}
                input={input}
                onInput={onInput}
                onSend={onSend}
                onIDontKnow={onIDontKnow}
                sending={sending}
                sessionId={sessionId}
                scrollRef={scrollRef}
              />

              {/* Advance to the department board once the transcript gate (a
                  genuine, non-fabricated transcript) is satisfied. */}
              <div className="mt-8 flex flex-col items-start gap-2">
                <button
                  type="button"
                  onClick={onContinueToDepartments}
                  disabled={!transcriptReady}
                  aria-disabled={!transcriptReady}
                  className={ivcx(iv.btnPrimary, !transcriptReady && 'is-busy')}
                  style={{
                    opacity: transcriptReady ? 1 : 0.55,
                    cursor: transcriptReady ? 'pointer' : 'not-allowed',
                  }}
                >
                  {transcriptReady ? (
                    <ArrowRight className="h-4 w-4" aria-hidden />
                  ) : (
                    <Lock className="h-4 w-4" aria-hidden />
                  )}
                  Continue to your departments
                </button>
                {!transcriptReady && (
                  <p className={iv.lede} style={{ fontSize: '0.8rem' }}>
                    Answer a few more questions and this will unlock.
                  </p>
                )}
              </div>
            </div>
          )}
        </main>

        {/* ── progress rail (ALWAYS shown in Q&A) ─────────────────────────── */}
        <aside data-walkthrough="interview-progress-rail">
          <ProgressRail
            phasesComplete={phasesComplete}
            percent={percent}
            answersSaved={answersSaved}
            lastSavedAt={lastSavedAt}
          />
        </aside>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Departments stage — DepartmentBoard + a coverage-gated continue             */
/* -------------------------------------------------------------------------- */

function DepartmentsStage({
  sessionId,
  onCoverageChange,
  boardComplete,
  onContinue,
}: {
  sessionId: string | null;
  onCoverageChange: (complete: boolean) => void;
  boardComplete: boolean;
  onContinue: () => void;
}) {
  return (
    <div className={iv.dark} style={{ minHeight: '100vh' }}>
      <DepartmentBoard
        sessionId={sessionId ?? undefined}
        onCoverageChange={onCoverageChange}
      />
      {/* Coverage-gated continue: arms only when the board reports every expected
          department decided AND zero un-provenanced declines. */}
      <div
        style={{
          position: 'sticky',
          bottom: 0,
          display: 'flex',
          justifyContent: 'center',
          padding: '1rem',
          background: 'linear-gradient(to top, var(--iv-canvas), transparent)',
        }}
      >
        <button
          type="button"
          onClick={onContinue}
          disabled={!boardComplete}
          aria-disabled={!boardComplete}
          className={ivcx(iv.btnPrimary, !boardComplete && 'is-busy')}
          style={{
            opacity: boardComplete ? 1 : 0.55,
            cursor: boardComplete ? 'pointer' : 'not-allowed',
          }}
        >
          {boardComplete ? (
            <ArrowRight className="h-4 w-4" aria-hidden />
          ) : (
            <Lock className="h-4 w-4" aria-hidden />
          )}
          Review &amp; build
        </button>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* brand header (live rebrand: logo swaps in as soon as it's answered)         */
/* -------------------------------------------------------------------------- */

function BrandHeader({ logoUrl }: { logoUrl: string }) {
  const isImageUrl = /^(https?:|data:image\/)/i.test(logoUrl);
  return (
    <div className="mb-6 flex items-center gap-3">
      {isImageUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={logoUrl}
          alt="Your logo"
          style={{ height: 32, maxWidth: 160, objectFit: 'contain' }}
        />
      ) : (
        <span
          className="inline-flex items-center gap-2"
          style={{ color: 'var(--iv-accent-strong)', fontWeight: 600 }}
        >
          <Sparkles className="h-5 w-5" aria-hidden />
          {logoUrl}
        </span>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* consent / welcome (phase 0) — three options, NONE auto-selected             */
/* -------------------------------------------------------------------------- */

const CONSENT_OPTIONS: Array<{ id: Exclude<Consent, null>; title: string; desc: string }> = [
  {
    id: 'full',
    title: 'Yes — interview me now',
    desc: 'Answer in your own words, one question at a time. About 15–20 minutes.',
  },
  {
    id: 'quick',
    title: "I've only got a few minutes",
    desc: 'Start now and pick up later — every answer is saved and we can send you a link to continue.',
  },
  {
    id: 'learn',
    title: 'What happens with my answers?',
    desc: 'See how your interview becomes your AI workforce before you begin.',
  },
];

function ConsentScreen({
  logoUrl,
  brandStyle,
  consent,
  booting,
  onSelect,
  onBegin,
}: {
  logoUrl: string;
  brandStyle?: React.CSSProperties;
  consent: Consent;
  booting: boolean;
  onSelect: (c: Consent) => void;
  onBegin: () => void;
  onSkip: () => void;
}) {
  return (
    <div className={iv.root} style={brandStyle}>
      <motion.div
        variants={ivScreenVariants}
        initial="initial"
        animate="animate"
        className={iv.stage}
      >
        <div className="mb-8 text-center" data-walkthrough="interview-welcome">
          <div className="mb-4 flex justify-center">
            <BrandHeader logoUrl={logoUrl} />
          </div>
          <h1 className={iv.question}>Let&apos;s build your company</h1>
          <p className={ivcx(iv.lede, 'mt-2')}>
            A short conversation about your business. We turn your answers into a full AI
            workforce — no jargon, just your own words.
          </p>
          {/* P1-03 c.4 (interview-lock clarity): a client redirected here by the
              middleware's interview shell-lock (src/middleware.ts) was landing
              with no explanation of WHY, which got reported as an outage rather
              than a locked-until-complete state. One line of copy closes that. */}
          <p className={ivcx(iv.lede, 'mt-2')} style={{ fontSize: '0.82rem' }}>
            Your Command Center unlocks when the AI Workforce Interview is complete.
          </p>
          {booting && (
            <p className={iv.lede} style={{ fontSize: '0.78rem', marginTop: '0.5rem' }} aria-live="polite">
              Checking for saved progress…
            </p>
          )}
        </div>

        <div
          role="radiogroup"
          aria-label="How would you like to begin?"
          className="mb-6 space-y-3"
          data-walkthrough="interview-consent-options"
        >
          {CONSENT_OPTIONS.map((opt) => {
            const selected = consent === opt.id;
            return (
              <button
                key={opt.id}
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() => onSelect(opt.id)}
                className={ivcx(iv.choice, selected && 'is-selected')}
                style={{ width: '100%', textAlign: 'left' }}
              >
                <span className="flex items-start gap-3">
                  <span
                    aria-hidden
                    className="mt-0.5 flex h-5 w-5 items-center justify-center rounded-full border-2"
                    style={{
                      borderColor: selected
                        ? 'var(--iv-accent-strong)'
                        : 'var(--iv-line-strong)',
                    }}
                  >
                    {selected && (
                      <span
                        className="h-2.5 w-2.5 rounded-full"
                        style={{ background: 'var(--iv-accent-strong)' }}
                      />
                    )}
                  </span>
                  <span>
                    <span className="block font-semibold" style={{ color: 'var(--iv-ink)' }}>
                      {opt.title}
                    </span>
                    <span
                      className="mt-0.5 block text-sm"
                      style={{ color: 'var(--iv-ink-soft)' }}
                    >
                      {opt.desc}
                    </span>
                  </span>
                </span>
              </button>
            );
          })}
        </div>

        <AnimatePresence>
          {consent === 'learn' && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              className="overflow-hidden"
            >
              <div
                className={iv.card}
                style={{ marginBottom: '1.5rem', display: 'flex', gap: '0.6rem' }}
              >
                <Info
                  className="h-4 w-4"
                  aria-hidden
                  style={{ color: 'var(--iv-accent-strong)', flexShrink: 0, marginTop: '0.15rem' }}
                />
                <p style={{ margin: 0, fontSize: '0.9rem', color: 'var(--iv-ink-soft)' }}>
                  Your answers are saved on your own box and used only to design your
                  departments, roles, and playbooks. Nothing is shared. When you finish, we
                  assemble everything and start building — you can keep going whenever
                  you&apos;re ready.
                </p>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        <button
          type="button"
          onClick={onBegin}
          disabled={consent === null}
          aria-disabled={consent === null}
          data-walkthrough="interview-begin-button"
          className={ivcx(iv.btnPrimary, consent === null && 'is-busy')}
          style={{
            width: '100%',
            justifyContent: 'center',
            opacity: consent === null ? 0.55 : 1,
            cursor: consent === null ? 'not-allowed' : 'pointer',
          }}
        >
          {consent === 'learn' ? "I'm ready — begin interview" : 'Begin interview'}
          <ArrowRight className="h-5 w-5" aria-hidden />
        </button>
        {consent === null && (
          <p className={ivcx(iv.lede, 'mt-3 text-center')} style={{ fontSize: '0.78rem' }}>
            Choose an option above to start.
          </p>
        )}

        {/* U057: "Skip for now" — sets a 1-hour bypass cookie for urgent dashboard access. */}
        <div className="mt-4 pt-4" style={{ borderTop: '1px solid var(--iv-line)' }}>
          <button
            type="button"
            onClick={onSkip}
            className={ivcx(iv.btnSecondary)}
            style={{ width: '100%', justifyContent: 'center' }}
            data-walkthrough="interview-skip-button"
          >
            Skip for now
          </button>
          <p className={ivcx(iv.lede, 'mt-2 text-center')} style={{ fontSize: '0.72rem' }}>
            Go straight to your dashboard. A reminder will stay at the top until you finish the interview.
          </p>
        </div>
      </motion.div>
    </div>
  );
}
