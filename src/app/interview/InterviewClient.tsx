'use client';

/**
 * InterviewClient — the orchestrator for the /interview surface.
 *
 * The page is driven by the step gate. Three screens, nothing else:
 *
 *   welcome   → one "Start" button (wording from the question-set document)
 *   question  → ONE question at a time, straight from GET /api/interview/next.
 *               The page never decides order, never re-asks, never counts on
 *               its own; the department board is simply the question whose
 *               `kind` is 'board'.
 *   review    → <ReviewScreen>, after one celebration when the last required
 *               question is answered.
 *
 * Continuity: on load, if the gate already has accepted answers, the owner lands
 * on <WelcomeBack> ("Welcome back. You are N of M done. Next: …"), one button.
 *
 * Nothing here ever sends words in the owner's name. "I am not sure" asks the
 * helper for ideas; the owner picks or writes, and nothing is saved until the
 * owner presses Continue.
 *
 * Every persistence path goes through an API route (next / answer / skip /
 * complete) — the same ones the Telegram agent uses. This file never writes a
 * file or touches the database.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  recoverInterviewAccess,
  interviewDraftScope,
  INTERVIEW_SIGN_IN_HELP,
} from '@/lib/interview/browser-recovery';
import { AnimatePresence, MotionConfig, motion } from 'framer-motion';
import { ArrowRight, Info, Sparkles } from 'lucide-react';

import { iv, ivcx, ivScreenVariants } from '@/components/interview/interview-theme';
import QuestionCard, {
  isDone,
  type AnswerResponse,
  type GateNext,
  type NextQuestion,
} from '@/components/interview/QuestionCard';
import ReviewScreen from '@/components/interview/ReviewScreen';
import MilestoneScreen from '@/components/interview/MilestoneScreen';
import WelcomeBack from '@/components/interview/WelcomeBack';

import { useCompanyBrand } from '@/hooks/useCompanyBrand';
import { useLogoUrl } from '@/hooks/useLogoUrl';
import { canSkipInterview, skipInterviewForNow } from '@/components/interview/gate-actions';

import registryRaw from '@/lib/interview-questions.v2.json';

/* -------------------------------------------------------------------------- */
/* registry wording, used only to NAME a set-aside question (never a number)   */
/* -------------------------------------------------------------------------- */

const REGISTRY_PROMPTS: Record<string, string> = Object.fromEntries(
  ((registryRaw as { questions?: Array<{ id: string; prompt: string }> }).questions ?? []).map(
    (q) => [q.id, q.prompt],
  ),
);

/* -------------------------------------------------------------------------- */
/* JSON shapes (mirror the API routes — no Node import leaks in)              */
/* -------------------------------------------------------------------------- */

/** The little bit of `/api/interview/state` this page still needs. */
interface IdentityResponse {
  companyId?: string;
  installationId?: string;
  buildId?: string | null;
  interviewComplete?: boolean;
  buildCompleted?: boolean;
  session?: { interviewSessionId: string | null; gatewaySessionId?: string | null };
  gate?: { skippedOpen?: unknown } | null;
}

interface GateStatusResponse {
  interviewComplete?: boolean;
  buildCompleted?: boolean;
  standardReady?: boolean;
}

type Stage = 'welcome' | 'welcome-back' | 'question' | 'celebrate' | 'review';

const SOFT_READ_RETRY_MS = 5_000;
const SOFT_READ_MAX_RETRIES = 6;

/** BU-25: a client tenant whose own box cannot be reached (503 box_unreachable). */
const BOX_UNREACHABLE_MESSAGE =
  'We cannot reach your system right now. Your answers are saved. Please try again in a few minutes.';

/* -------------------------------------------------------------------------- */
/* component                                                                   */
/* -------------------------------------------------------------------------- */

export default function InterviewClient() {
  const router = useRouter();
  const enrollmentRef = useRef<Promise<string | null> | null>(null);
  const pendingEnrollmentRef = useRef<string | null>(null);

  const logoUrl = useLogoUrl();
  const brand = useCompanyBrand();

  const [stage, setStage] = useState<Stage>('welcome');
  /** The gate's current position. Null while booting or after a failed read. */
  const [next, setNext] = useState<GateNext | null>(null);
  /** Identity used for draft scoping (never for authority). */
  const [identity, setIdentity] = useState<IdentityResponse | null>(null);
  /** Skipped questions the gate still holds open, by their own wording. */
  const [skipped, setSkipped] = useState<Array<{ id: string; prompt: string }>>([]);

  const [booting, setBooting] = useState(true);
  const [accessError, setAccessError] = useState<string | null>(null);
  const [softError, setSoftError] = useState(false);
  const [boxUnreachable, setBoxUnreachable] = useState(false);
  const [softAttempts, setSoftAttempts] = useState(0);
  const [standardReady, setStandardReady] = useState(false);
  const [showSkip, setShowSkip] = useState(false);
  const [skipError, setSkipError] = useState<string | null>(null);

  const routedRef = useRef(false);

  const draftScope = interviewDraftScope(identity);
  const sessionId = identity?.session?.interviewSessionId ?? null;

  /* ---- the gate ---------------------------------------------------------- */

  const fetchNext = useCallback(async (): Promise<GateNext | null> => {
    try {
      const res = await fetch('/api/interview/next', { cache: 'no-store' });
      if (res.status === 401 || res.status === 403) {
        setAccessError(INTERVIEW_SIGN_IN_HELP);
        return null;
      }
      // BU-25: an unreachable client box is not a blip and not "answer more".
      if (res.status === 503) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        if (body?.error === 'box_unreachable') {
          setBoxUnreachable(true);
          return null;
        }
        throw new Error('next unavailable');
      }
      if (!res.ok) throw new Error('next unavailable');
      const data = (await res.json()) as GateNext;
      setAccessError(null);
      setBoxUnreachable(false);
      setSoftError(false);
      setSoftAttempts(0);
      return data;
    } catch {
      // A failed read is a blip, not an ejection: keep the screen, say so.
      setSoftError(true);
      setSoftAttempts((n) => n + 1);
      return null;
    }
  }, []);

  /** Identity + the gate's skipped list + the standard-first signal. */
  const loadContext = useCallback(async () => {
    try {
      const res = await fetch('/api/interview/state', { cache: 'no-store' });
      if (res.status === 401 || res.status === 403) setAccessError(INTERVIEW_SIGN_IN_HELP);
      if (res.ok) {
        const data = (await res.json()) as IdentityResponse;
        setIdentity(data);
        // A finished interview never shows the resume nag.
        if (data.interviewComplete === true || data.buildCompleted === true) {
          router.replace('/');
          return;
        }
        const open = data.gate?.skippedOpen;
        if (Array.isArray(open)) {
          setSkipped(
            open
              .filter((id): id is string => typeof id === 'string')
              .map((id) => ({ id, prompt: REGISTRY_PROMPTS[id] ?? id })),
          );
        }
      }
    } catch {
      /* the gate reads decide the screen; context is best-effort */
    }
    try {
      const gsRes = await fetch('/api/interview/gate-status', { cache: 'no-store' });
      if (gsRes.ok) {
        const gs = (await gsRes.json()) as GateStatusResponse;
        setStandardReady(gs.standardReady === true);
      }
    } catch {
      /* legacy framing stays */
    }
  }, [router]);

  // A soft failure re-reads a bounded number of times; the bar simply stays.
  useEffect(() => {
    if (!softError || softAttempts > SOFT_READ_MAX_RETRIES) return;
    const timer = setTimeout(() => {
      void fetchNext().then((data) => {
        if (!data) return;
        setNext(data);
        if (isDone(data) && stage !== 'review') setStage('review');
      });
    }, SOFT_READ_RETRY_MS);
    return () => clearTimeout(timer);
  }, [fetchNext, softAttempts, softError, stage]);

  // Clicks on another invitation reload into the normal bootstrap.
  useEffect(() => {
    const hasEnrollment = () =>
      new URLSearchParams(window.location.search).has('enroll') ||
      new URLSearchParams(window.location.hash.slice(1)).has('enroll');
    const onSearchChange = () => {
      if (hasEnrollment()) window.location.reload();
    };
    window.addEventListener('popstate', onSearchChange);
    window.addEventListener('hashchange', onSearchChange);
    return () => {
      window.removeEventListener('popstate', onSearchChange);
      window.removeEventListener('hashchange', onSearchChange);
    };
  }, []);

  // BU-05 (WF-013): "Skip for now" is operator-only. Presentation only — the
  // action itself refuses a non-operator anyway.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const allowed = await canSkipInterview();
        if (!cancelled) setShowSkip(allowed);
      } catch {
        if (!cancelled) setShowSkip(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // On mount: exchange the invitation, then read the gate ONCE and route.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const params = new URLSearchParams(window.location.search);
      const enrollment =
        params.get('enroll') ??
        new URLSearchParams(window.location.hash.slice(1)).get('enroll');
      if (enrollment && !enrollmentRef.current) {
        pendingEnrollmentRef.current = enrollment;
        enrollmentRef.current = (async () => {
          const error = await recoverInterviewAccess(enrollment);
          if (error) return error;
          const cleanUrl = window.location.pathname;
          window.history.replaceState(null, '', cleanUrl);
          window.location.replace(cleanUrl);
          return null;
        })();
      }
      if (enrollmentRef.current) {
        const enrollmentError = await enrollmentRef.current;
        if (cancelled) return;
        if (enrollmentError) {
          setAccessError(enrollmentError);
          setBooting(false);
        }
        return; // success hands off to the authenticated, query-free document
      }

      const data = await fetchNext();
      void loadContext();
      if (cancelled) return;
      setBooting(false);
      if (routedRef.current) return;
      routedRef.current = true;
      if (!data) return; // the welcome screen stays; the reconnecting bar shows
      setNext(data);
      if (isDone(data)) {
        setStage('review');
        return;
      }
      setStage((data.requiredAnswered ?? 0) > 0 ? 'welcome-back' : 'welcome');
    })();
    return () => {
      cancelled = true;
    };
  }, [fetchNext, loadContext]);

  /* ---- transitions ------------------------------------------------------- */

  const refreshNext = useCallback(async () => {
    const data = await fetchNext();
    if (!data) return;
    setNext(data);
    if (isDone(data) && stage !== 'review') setStage('celebrate');
  }, [fetchNext, stage]);

  const handleAnswered = useCallback(
    async (data: AnswerResponse) => {
      const fresh = data.next ?? (await fetchNext());
      void loadContext();
      if (!fresh) return;
      setNext(fresh);
      setStage(isDone(fresh) ? 'celebrate' : 'question');
    },
    [fetchNext, loadContext],
  );

  const handleSkipped = useCallback(
    async (fresh: GateNext | null) => {
      const target = fresh ?? (await fetchNext());
      void loadContext();
      if (!target) return;
      setNext(target);
      setStage(isDone(target) ? 'celebrate' : 'question');
    },
    [fetchNext, loadContext],
  );

  const start = useCallback(async () => {
    const data = next && !isDone(next) ? next : await fetchNext();
    if (!data) return;
    setNext(data);
    setStage(isDone(data) ? 'review' : 'question');
  }, [fetchNext, next]);

  const resume = useCallback(() => {
    const data = next && !isDone(next) ? next : null;
    if (data) {
      setStage('question');
      return;
    }
    void start();
  }, [next, start]);

  const handleSkipForNow = useCallback(async () => {
    setSkipError(null);
    try {
      await skipInterviewForNow();
    } catch {
      // BU-05: a refused skip is said plainly and never navigates.
      setSkipError('Skipping is not available for this account.');
      return;
    }
    router.push('/');
  }, [router]);

  const retryAccess = useCallback(async () => {
    const ticket = pendingEnrollmentRef.current;
    if (!ticket) {
      window.location.reload();
      return;
    }
    setBooting(true);
    const error = await recoverInterviewAccess(ticket);
    if (error) {
      setAccessError(error);
      setBooting(false);
      return;
    }
    pendingEnrollmentRef.current = null;
    window.location.replace(window.location.pathname);
  }, []);

  /* ---- renders ----------------------------------------------------------- */

  const brandStyle = brand.primaryColor
    ? ({ ['--iv-accent-strong' as string]: brand.primaryColor } as React.CSSProperties)
    : undefined;

  const question: NextQuestion | null = next && !isDone(next) ? next : null;

  let screen: React.ReactNode;

  if (accessError) {
    screen = (
      <div className={iv.root}>
        <div className={iv.stage} role="alert">
          <h1 className={iv.question}>Check your access</h1>
          <p className={iv.lede}>{accessError}</p>
          <button
            type="button"
            className={iv.btnPrimary}
            disabled={booting}
            onClick={() => void retryAccess()}
          >
            {booting ? 'Checking…' : 'Check sign-in and retry'}
          </button>
          <p className="mt-4 text-sm">
            Use this same interview page after signing in. Submitted answers stay saved; a fresh
            link does not start a new interview.
          </p>
        </div>
      </div>
    );
  } else if (stage === 'celebrate') {
    screen = (
      <MilestoneScreen
        phase="everything we need"
        headline="That's everything we need"
        onDismiss={() => setStage('review')}
        autoAdvanceMs={null}
      />
    );
  } else if (stage === 'welcome-back') {
    screen = (
      <WelcomeBack
        requiredAnswered={question?.requiredAnswered ?? 0}
        requiredTotal={question?.requiredTotal ?? 0}
        nextPrompt={question?.prompt ?? null}
        skipped={skipped}
        onContinue={resume}
      />
    );
  } else if (stage === 'review') {
    screen = (
      <div style={brandStyle}>
        <ReviewScreen sessionId={sessionId ?? undefined} standardReady={standardReady} />
      </div>
    );
  } else if (stage === 'question' && question) {
    screen = (
      <div className={iv.root} style={brandStyle}>
        <div className="mx-auto w-full max-w-3xl px-5 py-8">
          <BrandHeader logoUrl={logoUrl} />
          <p className="mb-4 text-sm" style={{ color: 'var(--iv-ink-soft)' }} aria-live="polite">
            {question.requiredAnswered ?? 0} of {question.requiredTotal ?? 0}
          </p>
          <AnimatePresence mode="wait">
            <QuestionCard
              key={question.id}
              question={question}
              draftScope={draftScope}
              sessionId={sessionId ?? undefined}
              standardReady={standardReady}
              onAnswered={(data) => void handleAnswered(data)}
              onSkipped={(fresh) => void handleSkipped(fresh)}
              onOutOfOrder={() => void refreshNext()}
              autoFocus
            />
          </AnimatePresence>
        </div>
      </div>
    );
  } else {
    screen = (
      <WelcomeScreen
        logoUrl={logoUrl}
        brandStyle={brandStyle}
        booting={booting}
        onStart={() => void start()}
        onSkip={handleSkipForNow}
        showSkip={showSkip}
        skipError={skipError}
      />
    );
  }

  return (
    <MotionConfig reducedMotion="user">
      {(boxUnreachable || softError) && (
        <p role="status" className="mx-auto w-full max-w-2xl px-5 pt-4 text-sm">
          {boxUnreachable ? BOX_UNREACHABLE_MESSAGE : 'Reconnecting… your answers are saved.'}
        </p>
      )}
      {screen}
    </MotionConfig>
  );
}

/* -------------------------------------------------------------------------- */
/* brand header                                                               */
/* -------------------------------------------------------------------------- */

function BrandHeader({ logoUrl }: { logoUrl: string }) {
  const isImageUrl = /^(https?:|data:image\/)/i.test(logoUrl);
  return (
    <div className="mb-6 flex items-center gap-3">
      {isImageUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={logoUrl} alt="Your logo" style={{ height: 32, maxWidth: 160, objectFit: 'contain' }} />
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
/* welcome (one Start button; the three old choices are gone)                 */
/* -------------------------------------------------------------------------- */

function WelcomeScreen({
  logoUrl,
  brandStyle,
  booting,
  onStart,
  onSkip,
  showSkip,
  skipError,
}: {
  logoUrl: string;
  brandStyle?: React.CSSProperties;
  booting: boolean;
  onStart: () => void;
  onSkip: () => void;
  /** BU-05 (WF-013): operator-only. False hides "Skip for now" entirely. */
  showSkip: boolean;
  skipError: string | null;
}) {
  const [explain, setExplain] = useState(false);
  return (
    <div className={iv.root} style={brandStyle}>
      <motion.div variants={ivScreenVariants} initial="initial" animate="animate" className={iv.stage}>
        <div className="mb-8 text-center" data-walkthrough="interview-welcome">
          <div className="mb-4 flex justify-center">
            <BrandHeader logoUrl={logoUrl} />
          </div>
          <h1 className={iv.question}>Let&apos;s set up your company</h1>
          <p className={ivcx(iv.lede, 'mt-2')}>
            About 12 minutes. 15 short questions, most of them one tap. Your answers are saved as you
            go, so you can stop and come back.
          </p>
          <p className={ivcx(iv.lede, 'mt-2')} style={{ fontSize: '0.82rem' }}>
            Your dashboard opens as soon as you finish these questions.
          </p>
          {booting && (
            <p className={iv.lede} style={{ fontSize: '0.78rem', marginTop: '0.5rem' }} aria-live="polite">
              Checking for saved progress…
            </p>
          )}
        </div>

        <button
          type="button"
          onClick={onStart}
          disabled={booting}
          aria-disabled={booting}
          data-walkthrough="interview-begin-button"
          className={ivcx(iv.btnPrimary, booting && 'is-busy')}
          style={{ width: '100%', justifyContent: 'center', opacity: booting ? 0.55 : 1 }}
        >
          Start
          <ArrowRight className="h-5 w-5" aria-hidden />
        </button>

        <p className="mt-3 text-center">
          <button
            type="button"
            onClick={() => setExplain((v) => !v)}
            style={{
              fontSize: '0.85rem',
              color: 'var(--iv-accent-strong)',
              textDecoration: 'underline',
              textUnderlineOffset: '0.15em',
              background: 'none',
              border: 0,
              cursor: 'pointer',
            }}
          >
            What happens with my answers?
          </button>
        </p>

        <AnimatePresence>
          {explain && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              className="overflow-hidden"
            >
              <div className={iv.card} style={{ marginTop: '1rem', display: 'flex', gap: '0.6rem' }}>
                <Info
                  className="h-4 w-4"
                  aria-hidden
                  style={{ color: 'var(--iv-accent-strong)', flexShrink: 0, marginTop: '0.15rem' }}
                />
                <p style={{ margin: 0, fontSize: '0.9rem', color: 'var(--iv-ink-soft)' }}>
                  Your answers are saved on your own box and used only to design your departments,
                  roles, and playbooks. Nothing is shared. When you finish, we assemble everything
                  and start building — you can keep going whenever you’re ready.
                </p>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {showSkip && (
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
              Go straight to your dashboard. A reminder will stay at the top until you finish the
              interview.
            </p>
          </div>
        )}
        {skipError && (
          <p role="alert" className={ivcx(iv.lede, 'mt-2 text-center')} style={{ fontSize: '0.78rem' }}>
            {skipError}
          </p>
        )}
      </motion.div>
    </div>
  );
}
