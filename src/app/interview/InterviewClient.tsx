'use client';

/**
 * InterviewClient — the orchestrator for the /interview surface (Wave 5 · P4).
 *
 * This is the integration step: it takes the seven isolated, polished interview
 * components and drives them as ONE coherent 7-phase flow, entirely from server
 * truth (GET /api/interview/state → phase/progress/gate-flags) and the canonical
 * write routes. It never writes a canonical file itself; every persistence path
 * goes through an API route (turn / answer / decision / complete), which press the
 * exact same scripts the Telegram interview agent presses.
 *
 * ── The phases it orchestrates ────────────────────────────────────────────────
 *   0  CONSENT       — three options, NONE auto-selected; Begin stays disabled
 *                      until an explicit choice (never auto-select).
 *   RESUME           — when /state says status="in_progress", we skip consent,
 *                      show <WelcomeBack> at the owner's percent + answer count,
 *                      land them on next_question_number, and surface the
 *                      skipped-question circle-back queue. Resume is the only
 *                      forward path — there is deliberately no "start over".
 *   1-5 Q&A          — the <ProgressRail> is ALWAYS shown. A STRUCTURED question
 *                      (from interview-questions) renders the matching
 *                      QuestionCard / ColorPickerCard / LogoDropCard, one at a
 *                      time, POSTing /api/interview/answer. When the structured
 *                      set is exhausted, the free-form conversational depth runs
 *                      through <ConversationPane> (interviewer bubbles + the
 *                      "I don't know" research affordance) over /api/interview/turn.
 *                      A <MilestoneScreen> (words only) marks each phase boundary.
 *   5.5 DEPARTMENTS  — <DepartmentBoard>; its onCoverageChange drives the coverage
 *                      gate (mirrors build-side gates #3 ∧ #8).
 *   6  REVIEW        — <ReviewScreen>: synthesis, grouped + inline-editable
 *                      answers, the skipped circle-back queue, ending in the ONE
 *                      "Build my company" button, TRIPLE-gated on
 *                      genuineTranscriptReady ∧ decisionCoverageComplete ∧
 *                      noUnprovenancedDeclines. On QC pass → /onboarding/building.
 *
 * ── Clean client bundle ───────────────────────────────────────────────────────
 * Imports NOTHING from the Node-only interview seam. INTERVIEW_QUESTIONS in
 * src/lib/interview-questions.ts is a Node-only value (createRequire/node:module),
 * so the structured set is rebuilt here from the same vendored branding JSON plus
 * the two identity questions — a byte-for-byte mirror of INTERVIEW_QUESTIONS,
 * with only the InterviewQuestion TYPE imported (type-only, erased at build).
 *
 * P3-2 live-rebrand hooks (useCompanyBrand / useLogoUrl) and the P3-3 walkthrough
 * data-walkthrough targets are preserved.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AnimatePresence, motion } from 'framer-motion';
import { ArrowRight, Info, Lock, Sparkles } from 'lucide-react';

import { iv, ivcx, ivScreenVariants } from '@/components/interview/interview-theme';
import type { InterviewQuestion } from '@/lib/interview-questions';
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

/* -------------------------------------------------------------------------- */
/* structured question set (client mirror of INTERVIEW_QUESTIONS)              */
/* -------------------------------------------------------------------------- */

/**
 * The two identity questions that precede the branding set — kept inline (not
 * imported) so no Node-only module is pulled into this client bundle. This mirrors
 * the head of INTERVIEW_QUESTIONS in src/lib/interview-questions.ts exactly.
 */
const IDENTITY_QUESTIONS: InterviewQuestion[] = [
  {
    id: 'company_name',
    section: 'identity',
    prompt: 'What is your company name?',
    kind: 'text',
    storeOn: 'client.name',
    required: true,
  },
  {
    id: 'industry',
    section: 'identity',
    prompt: 'What industry are you in?',
    help: 'e.g. SaaS, e-commerce, healthcare, real estate.',
    kind: 'text',
    storeOn: 'company.industry',
    required: true,
  },
];

/** identity + branding — the full ordered structured set the cards render. */
const STRUCTURED_QUESTIONS: InterviewQuestion[] = [
  ...IDENTITY_QUESTIONS,
  ...((brandingRaw as { questions: unknown }).questions as InterviewQuestion[]),
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
  completed: number;
  total: number;
}

const ALL_GATES_FALSE: GateFlags = {
  genuineTranscriptReady: false,
  decisionCoverageComplete: false,
  noUnprovenancedDeclines: false,
};

/** Total interview phases used for the milestone step counter (words only). */
const TOTAL_PHASES = 4; // company · brand · team · departments

/* -------------------------------------------------------------------------- */
/* component                                                                   */
/* -------------------------------------------------------------------------- */

export default function InterviewClient() {
  const router = useRouter();

  // P3-2 live-rebrand hooks — the surface re-themes the instant branding answers
  // land (BrandTheme rewrites the --brand-* vars the iv-* tokens point at); the
  // logo + accent below make that live rebrand visible in the header.
  const logoUrl = useLogoUrl();
  const brand = useCompanyBrand();

  // Phase machine.
  const [stage, setStage] = useState<Stage>('consent');
  const [consent, setConsent] = useState<Consent>(null);
  const [qaMode, setQaMode] = useState<QaMode>('structured');
  const [structIndex, setStructIndex] = useState(0);

  // Server truth (progress rail + resume + gate flags).
  const [state, setState] = useState<InterviewStateResponse | null>(null);

  // Conversation (free-form Q&A depth).
  const [currentQuestion, setCurrentQuestion] = useState('');
  const [currentReaction, setCurrentReaction] = useState('');
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);

  // Department board completeness (gates #3 ∧ #8), relayed via onCoverageChange.
  const [boardComplete, setBoardComplete] = useState(false);

  // Milestone interstitial (words only).
  const [milestone, setMilestone] = useState<PendingMilestone | null>(null);
  const afterMilestone = useRef<() => void>(() => {});

  // One-shot guards.
  const routedRef = useRef(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const flags = state?.flags ?? ALL_GATES_FALSE;
  const transcriptReady = flags.genuineTranscriptReady;

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

  // On mount: read state once and route resume → WelcomeBack (skipping consent).
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const data = await loadState();
      if (cancelled || routedRef.current || !data) return;
      routedRef.current = true;
      if (
        data.resume?.status === 'in_progress' &&
        (data.resume.totalQuestionsAnswered ?? 0) > 0
      ) {
        setStage('welcome-back');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [loadState]);

  /* ---- a single conversational turn (free-form depth) ---- */

  const sendTurn = useCallback(
    async (content: string) => {
      const text = content.trim();
      if (!text || sending) return;
      setSending(true);
      setCurrentReaction('');
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
    [loadState, sending, sessionId],
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
    void sendTurn(
      "I've shared my company's basics — I'm ready to talk through how my business actually runs day to day.",
    );
  }, [sendTurn]);

  /* ---- advancing the structured question set ---- */

  const advanceStructured = useCallback(
    (fromIndex: number) => {
      const q = STRUCTURED_QUESTIONS[fromIndex];
      const next = STRUCTURED_QUESTIONS[fromIndex + 1];
      const nextIndex = fromIndex + 1;
      setStructIndex(nextIndex);
      void loadState();

      const atSectionBoundary = !next || next.section !== q.section;
      if (!atSectionBoundary) return; // stay on the structured cards

      // Section complete → celebrate (words only), then continue.
      const sectionOrdinal =
        Array.from(new Set(STRUCTURED_QUESTIONS.slice(0, nextIndex).map((x) => x.section))).length;
      const done = nextIndex >= STRUCTURED_QUESTIONS.length;
      fireMilestone(
        { phase: SECTION_MILESTONE[q.section], completed: sectionOrdinal, total: TOTAL_PHASES },
        () => {
          if (done) startConversation();
          else setStage('qa');
        },
      );
    },
    [fireMilestone, loadState, startConversation],
  );

  /* ---- Q&A → departments (gated on a genuine transcript) ---- */

  const goToDepartments = useCallback(() => {
    fireMilestone(
      { phase: 'Your team', completed: 3, total: TOTAL_PHASES },
      () => setStage('departments'),
    );
  }, [fireMilestone]);

  /* ---- departments → review (celebrate with the REAL department counts) ---- */

  const goToReview = useCallback(async () => {
    const data = await loadState();
    const cov = data?.decisionCoverage;
    const completed = cov?.covered.length ?? 0;
    const total = cov?.expected.length ?? 0;
    fireMilestone(
      { phase: 'Your departments', completed, total },
      () => setStage('review'),
    );
  }, [fireMilestone, loadState]);

  /* ---- consent → begin (never proceed without an explicit choice) ---- */

  const beginInterview = useCallback(() => {
    if (consent === null) return;
    setQaMode('structured');
    setStructIndex(0);
    setStage('qa');
  }, [consent]);

  /* ---- resume (WelcomeBack) ---- */

  const resumeInterview = useCallback(() => {
    setQaMode('conversation');
    setStage('qa');
    setCurrentQuestion('');
    void sendTurn("I'm back — let's pick up right where we left off.");
  }, [sendTurn]);

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

  if (stage === 'milestone' && milestone) {
    return (
      <MilestoneScreen
        phase={milestone.phase}
        completed={milestone.completed}
        totalDepts={milestone.total}
        onDismiss={dismissMilestone}
      />
    );
  }

  if (stage === 'welcome-back') {
    return (
      <WelcomeBack
        percent={state?.progress.percent ?? 0}
        answersSaved={state?.resume.totalQuestionsAnswered ?? 0}
        nextQuestionNumber={state?.resume.nextQuestionNumber ?? null}
        skippedQuestions={state?.resume.skippedQuestions ?? []}
        onContinue={resumeInterview}
        onReviewSkipped={circleBack}
      />
    );
  }

  if (stage === 'departments') {
    return (
      <DepartmentsStage
        sessionId={sessionId}
        onCoverageChange={setBoardComplete}
        boardComplete={boardComplete}
        onContinue={() => void goToReview()}
      />
    );
  }

  if (stage === 'review') {
    return (
      <div style={brandStyle}>
        <ReviewScreen
          sessionId={sessionId ?? undefined}
          onCircleBack={circleBack}
        />
      </div>
    );
  }

  if (stage === 'qa') {
    const question = STRUCTURED_QUESTIONS[structIndex];
    return (
      <QaStage
        brandStyle={brandStyle}
        logoUrl={logoUrl}
        phasesComplete={state?.progress.phasesComplete ?? []}
        lastQuestionNumber={state?.progress.lastQuestionNumber ?? null}
        mode={qaMode}
        question={qaMode === 'structured' ? question : undefined}
        sessionId={sessionId}
        onAnswered={() => advanceStructured(structIndex)}
        onSkip={() => advanceStructured(structIndex)}
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
        sending={sending}
        scrollRef={scrollRef}
        transcriptReady={transcriptReady}
        onContinueToDepartments={goToDepartments}
      />
    );
  }

  // stage === 'consent'
  return (
    <ConsentScreen
      logoUrl={logoUrl}
      brandStyle={brandStyle}
      consent={consent}
      onSelect={setConsent}
      onBegin={beginInterview}
    />
  );
}

/* -------------------------------------------------------------------------- */
/* Q&A stage — ALWAYS shows the ProgressRail; structured card OR conversation  */
/* -------------------------------------------------------------------------- */

function QaStage({
  brandStyle,
  logoUrl,
  phasesComplete,
  lastQuestionNumber,
  mode,
  question,
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
  lastQuestionNumber: number | null;
  mode: QaMode;
  question?: InterviewQuestion;
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
            lastQuestionNumber={lastQuestionNumber}
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
  onSelect,
  onBegin,
}: {
  logoUrl: string;
  brandStyle?: React.CSSProperties;
  consent: Consent;
  onSelect: (c: Consent) => void;
  onBegin: () => void;
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
          Begin interview
          <ArrowRight className="h-5 w-5" aria-hidden />
        </button>
        {consent === null && (
          <p className={ivcx(iv.lede, 'mt-3 text-center')} style={{ fontSize: '0.78rem' }}>
            Choose an option above to start.
          </p>
        )}
      </motion.div>
    </div>
  );
}
