'use client';

/**
 * InterviewClient — the client half of the /interview walking skeleton (P0-6).
 *
 * Responsibilities (P0 proof-of-wiring; polished panes arrive in P1/P2):
 *   1. WELCOME / CONSENT — three options, NONE auto-selected. The owner must make
 *      an explicit choice before the conversational pane opens (acceptance:
 *      "never auto-select").
 *   2. CONVERSATIONAL PANE — one message at a time, wired to POST
 *      /api/interview/turn. The client's own Skill-23 agent (the "brain") asks the
 *      questions and owns every file write; this UI only relays text and renders
 *      the agent's replies as interviewer bubbles. A 503 (gateway reconnecting)
 *      degrades gracefully to an inline notice.
 *   3. PROGRESS READOUT — a derived percent + the three gate flags from GET
 *      /api/interview/state, re-read after every turn so the Build button arms the
 *      instant the invariants are satisfied.
 *   4. GATED BUILD — "Build my company" is physically un-clickable (disabled AND
 *      guarded) until ALL THREE gate flags are true. On click it POSTs
 *      /api/interview/complete (the same script the Telegram agent presses) and:
 *        • pass         → refresh the shell-lock cookie, router.push('/onboarding/building')
 *        • needs-review → a distinct calm "we're reviewing your answers" screen
 *        • fail         → a distinct drill-back screen listing the QC reasons
 *        • 409 (incomplete) → surface exactly what is still missing, re-read state
 *
 * IMPORTANT: this file imports NOTHING from the Node-only interview seam
 * (src/lib/interview/seam.ts pulls node:child_process/fs). It talks only to the
 * API routes and mirrors their JSON shapes with local types, so it stays a clean
 * client bundle. refreshInterviewGate is a 'use server' action (safe to import).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AnimatePresence, motion } from 'framer-motion';
import {
  AlertTriangle,
  ArrowRight,
  Building2,
  CheckCircle2,
  ClipboardList,
  Info,
  Loader2,
  Lock,
  MessagesSquare,
  RotateCcw,
  Send,
  ShieldCheck,
  Sparkles,
} from 'lucide-react';
import { refreshInterviewGate } from '@/components/interview/gate-actions';

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

interface CompleteMissingItem {
  gate: 'transcript' | 'decision_coverage' | 'unprovenanced_declines';
  reason: string;
  departments?: string[];
  rejections?: string[];
}

interface CompleteResponse {
  ok?: boolean;
  status?: 'pass' | 'needs-review' | 'fail';
  redirect?: string;
  reasons?: string[];
  message?: string;
  error?: string;
  missing?: CompleteMissingItem[];
  operatorPing?: boolean;
}

/* -------------------------------------------------------------------------- */
/* local UI state                                                              */
/* -------------------------------------------------------------------------- */

type Role = 'owner' | 'interviewer' | 'system';

interface ChatMessage {
  id: string;
  role: Role;
  text: string;
}

/** One of the three welcome/consent options. Null = nothing selected (default). */
type Consent = 'full' | 'quick' | 'learn' | null;

/** Terminal screens the /complete verdict can route us to. */
type Outcome =
  | { kind: 'needs-review'; message: string }
  | { kind: 'fail'; reasons: string[] };

const ALL_GATES_FALSE: GateFlags = {
  genuineTranscriptReady: false,
  decisionCoverageComplete: false,
  noUnprovenancedDeclines: false,
};

let __mid = 0;
function nextId(): string {
  __mid += 1;
  return `m${__mid}-${Date.now()}`;
}

/* -------------------------------------------------------------------------- */
/* component                                                                   */
/* -------------------------------------------------------------------------- */

export default function InterviewClient() {
  const router = useRouter();

  // Phase.
  const [consent, setConsent] = useState<Consent>(null);
  const [started, setStarted] = useState(false);

  // Conversation.
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);

  // Progress + gate.
  const [state, setState] = useState<InterviewStateResponse | null>(null);

  // Build trigger.
  const [submitting, setSubmitting] = useState(false);
  const [completeError, setCompleteError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  // One-shot guards.
  const seededRef = useRef(false);
  const kickedRef = useRef(false);

  const scrollRef = useRef<HTMLDivElement | null>(null);

  const flags = state?.flags ?? ALL_GATES_FALSE;
  const allGatesPass =
    flags.genuineTranscriptReady &&
    flags.decisionCoverageComplete &&
    flags.noUnprovenancedDeclines;

  const addMessage = useCallback((role: Role, text: string) => {
    setMessages((prev) => [...prev, { id: nextId(), role, text }]);
  }, []);

  /* ---- state (progress + gate flags) ---- */

  const loadState = useCallback(async () => {
    try {
      const res = await fetch('/api/interview/state', { cache: 'no-store' });
      const data = (await res.json()) as InterviewStateResponse;
      setState(data);

      // Welcome-back seed: only on the very first successful load, and only when
      // the handoff says the interview is already in progress.
      if (
        !seededRef.current &&
        data.resume?.status === 'in_progress' &&
        (data.resume.totalQuestionsAnswered ?? 0) > 0
      ) {
        seededRef.current = true;
        kickedRef.current = true; // don't auto-kick a resumed interview
        const pct = data.progress?.percent ?? 0;
        const n = data.resume.totalQuestionsAnswered ?? 0;
        addMessage(
          'interviewer',
          `Welcome back — you're ${pct}% done, ${n} answer${n === 1 ? '' : 's'} saved. Whenever you're ready, let's pick up where we left off.`,
        );
      } else {
        seededRef.current = true;
      }
    } catch {
      // Non-fatal: the rail simply stays empty and the Build button stays
      // disabled (fail-closed) until the next successful read.
    }
  }, [addMessage]);

  /* ---- a single conversational turn ---- */

  const sendTurn = useCallback(
    async (content: string, asOwner = true) => {
      const text = content.trim();
      if (!text || sending) return;
      if (asOwner) addMessage('owner', text);
      setSending(true);
      try {
        const res = await fetch('/api/interview/turn', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ content: text, sessionId: sessionId ?? undefined }),
        });

        if (res.status === 503) {
          const data = (await res.json().catch(() => ({}))) as TurnResponse;
          addMessage(
            'system',
            data.message ??
              'Your interviewer is reconnecting. Your answers are safe — try again in a moment.',
          );
          return;
        }

        const data = (await res.json().catch(() => ({}))) as TurnResponse;

        if (!res.ok) {
          addMessage(
            'system',
            data.message ?? 'Something went wrong sending that. Please try again.',
          );
          return;
        }

        if (data.sessionId) setSessionId(data.sessionId);

        if (data.reply && data.reply.trim()) {
          addMessage('interviewer', data.reply);
        } else if (data.pending) {
          addMessage(
            'system',
            'Your interviewer is thinking — their reply will appear here shortly.',
          );
        }
      } catch {
        addMessage('system', 'Network hiccup — that message did not send. Please try again.');
      } finally {
        setSending(false);
        // Re-read progress + gate flags after every turn so the Build button arms
        // the moment the transcript + board invariants are satisfied.
        void loadState();
      }
    },
    [addMessage, loadState, sending, sessionId],
  );

  /* ---- entering the conversation from consent ---- */

  const beginInterview = useCallback(() => {
    if (consent === null) return; // never proceed without an explicit choice
    setStarted(true);
  }, [consent]);

  // On entering the conversation: load state, then (for a fresh interview only)
  // send one kickoff turn so the agent asks the first question. A resumed
  // interview is NOT auto-kicked (kickedRef is set inside loadState).
  useEffect(() => {
    if (!started) return;
    let cancelled = false;
    (async () => {
      await loadState();
      if (cancelled) return;
      if (!kickedRef.current) {
        kickedRef.current = true;
        void sendTurn("I'm ready to begin my AI workforce interview.", true);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [started]);

  // Auto-scroll the transcript as it grows.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, sending]);

  /* ---- the gated build trigger ---- */

  const submitComplete = useCallback(async () => {
    // Belt-and-suspenders: never fire while any gate flag is false, even if a
    // caller bypasses the disabled attribute.
    if (!allGatesPass || submitting) return;
    setSubmitting(true);
    setCompleteError(null);
    try {
      const res = await fetch('/api/interview/complete', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      const data = (await res.json().catch(() => ({}))) as CompleteResponse;

      if (res.ok && data.status === 'pass') {
        // Warm the Edge shell-lock cookie so the dashboard unlocks, then redirect
        // to the (already-live) build screen.
        try {
          await refreshInterviewGate();
        } catch {
          /* non-fatal — the layout's InterviewGateSync refreshes it too */
        }
        router.push(data.redirect || '/onboarding/building');
        return;
      }

      if (res.ok && data.status === 'needs-review') {
        setOutcome({
          kind: 'needs-review',
          message:
            data.message ??
            "Thanks — we're reviewing your answers. Your workforce will start building shortly; no action is needed from you.",
        });
        return;
      }

      if (res.ok && data.status === 'fail') {
        setOutcome({ kind: 'fail', reasons: data.reasons ?? [] });
        return;
      }

      // 409 incomplete / pending / reconciliation, or a 5xx.
      if (res.status === 409) {
        setCompleteError(formatMissing(data));
        void loadState(); // re-sync the flags so the button reflects reality
        return;
      }
      setCompleteError(
        data.message ?? "We couldn't complete the interview just yet. Please try again.",
      );
    } catch {
      setCompleteError('Network error — please try again.');
    } finally {
      setSubmitting(false);
    }
  }, [allGatesPass, loadState, router, submitting]);

  /* ---- renders ---- */

  if (outcome?.kind === 'fail') {
    return (
      <FailScreen
        reasons={outcome.reasons}
        onReview={() => {
          setOutcome(null);
          void loadState();
        }}
      />
    );
  }

  if (outcome?.kind === 'needs-review') {
    return <NeedsReviewScreen message={outcome.message} />;
  }

  if (!started) {
    return (
      <ConsentScreen
        consent={consent}
        onSelect={setConsent}
        onBegin={beginInterview}
      />
    );
  }

  return (
    <ConversationScreen
      messages={messages}
      input={input}
      onInput={setInput}
      onSend={() => {
        const text = input;
        setInput('');
        void sendTurn(text, true);
      }}
      sending={sending}
      state={state}
      flags={flags}
      allGatesPass={allGatesPass}
      submitting={submitting}
      completeError={completeError}
      onBuild={submitComplete}
      scrollRef={scrollRef}
    />
  );
}

/* -------------------------------------------------------------------------- */
/* helpers                                                                     */
/* -------------------------------------------------------------------------- */

/** Turn a 409 /complete body into a single human sentence for the owner. */
function formatMissing(data: CompleteResponse): string {
  const items = data.missing ?? [];
  if (items.length === 0) {
    return (
      data.message ??
      'A few things still need finishing before we can build. Keep answering and the button will light up.'
    );
  }
  const parts = items.map((m) => {
    if (m.gate === 'decision_coverage' && m.departments?.length) {
      return `${m.reason} (${m.departments.length} left)`;
    }
    return m.reason;
  });
  return parts.join(' ');
}

/* -------------------------------------------------------------------------- */
/* consent / welcome                                                           */
/* -------------------------------------------------------------------------- */

const CONSENT_OPTIONS: Array<{
  id: Exclude<Consent, null>;
  title: string;
  desc: string;
}> = [
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
  consent,
  onSelect,
  onBegin,
}: {
  consent: Consent;
  onSelect: (c: Consent) => void;
  onBegin: () => void;
}) {
  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-indigo-50 p-6 sm:p-8">
      <div className="max-w-2xl mx-auto">
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center h-16 w-16 rounded-2xl bg-indigo-100 mb-4">
            <Sparkles className="h-9 w-9 text-indigo-600" />
          </div>
          <h1 className="text-3xl font-bold text-gray-900 mb-2">
            Let&apos;s build your company
          </h1>
          <p className="text-gray-600">
            A short conversation about your business. We turn your answers into a full AI
            workforce — no jargon, just your own words.
          </p>
        </div>

        <div
          role="radiogroup"
          aria-label="How would you like to begin?"
          className="space-y-3 mb-6"
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
                className={`w-full text-left rounded-2xl border p-5 transition-colors ${
                  selected
                    ? 'border-indigo-500 bg-white ring-2 ring-indigo-200 shadow-sm'
                    : 'border-gray-200 bg-white hover:border-indigo-300'
                }`}
              >
                <div className="flex items-start gap-3">
                  <span
                    className={`mt-0.5 flex h-5 w-5 items-center justify-center rounded-full border-2 ${
                      selected ? 'border-indigo-600' : 'border-gray-300'
                    }`}
                    aria-hidden
                  >
                    {selected && <span className="h-2.5 w-2.5 rounded-full bg-indigo-600" />}
                  </span>
                  <span>
                    <span className="block font-semibold text-gray-900">{opt.title}</span>
                    <span className="block text-sm text-gray-600 mt-0.5">{opt.desc}</span>
                  </span>
                </div>
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
              <div className="rounded-2xl border border-indigo-100 bg-indigo-50/60 p-5 mb-6 text-sm text-gray-700">
                <div className="flex items-start gap-2">
                  <Info className="h-4 w-4 text-indigo-600 mt-0.5 shrink-0" />
                  <p>
                    Your answers are saved on your own box and used only to design your
                    departments, roles, and playbooks. Nothing is shared. When you finish,
                    we assemble everything and start building — you can keep going below
                    whenever you&apos;re ready.
                  </p>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        <button
          type="button"
          onClick={onBegin}
          disabled={consent === null}
          className={`w-full inline-flex items-center justify-center gap-2 px-6 py-3.5 rounded-xl font-semibold transition-colors ${
            consent === null
              ? 'bg-gray-200 text-gray-400 cursor-not-allowed'
              : 'bg-indigo-600 text-white hover:bg-indigo-700'
          }`}
        >
          Begin interview
          <ArrowRight className="h-5 w-5" />
        </button>
        {consent === null && (
          <p className="text-center text-xs text-gray-400 mt-3">
            Choose an option above to start.
          </p>
        )}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* conversation + progress rail + gated build                                  */
/* -------------------------------------------------------------------------- */

function ConversationScreen({
  messages,
  input,
  onInput,
  onSend,
  sending,
  state,
  flags,
  allGatesPass,
  submitting,
  completeError,
  onBuild,
  scrollRef,
}: {
  messages: ChatMessage[];
  input: string;
  onInput: (v: string) => void;
  onSend: () => void;
  sending: boolean;
  state: InterviewStateResponse | null;
  flags: GateFlags;
  allGatesPass: boolean;
  submitting: boolean;
  completeError: string | null;
  onBuild: () => void;
  scrollRef: React.RefObject<HTMLDivElement>;
}) {
  const percent = state?.progress?.percent ?? 0;
  const qNum = state?.progress?.lastQuestionNumber ?? null;
  const missingDepts = state?.decisionCoverage?.missing?.length ?? 0;

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-indigo-50 p-4 sm:p-6">
      <div className="max-w-5xl mx-auto grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-6">
        {/* ── conversational pane ─────────────────────────────────────────── */}
        <div className="flex flex-col bg-white rounded-2xl shadow-sm border overflow-hidden min-h-[70vh]">
          <div className="flex items-center gap-2 px-5 py-4 border-b">
            <MessagesSquare className="h-5 w-5 text-indigo-600" />
            <h2 className="font-semibold text-gray-900">Your interview</h2>
          </div>

          <div ref={scrollRef} className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
            {messages.length === 0 && !sending && (
              <p className="text-sm text-gray-400 text-center mt-8">
                Your interviewer is getting ready…
              </p>
            )}
            <AnimatePresence initial={false}>
              {messages.map((m) => (
                <MessageBubble key={m.id} message={m} />
              ))}
            </AnimatePresence>
            {sending && (
              <div className="flex items-center gap-2 text-sm text-gray-400">
                <Loader2 className="h-4 w-4 animate-spin" />
                Sending…
              </div>
            )}
          </div>

          <div className="border-t p-3">
            <div className="flex items-end gap-2">
              <textarea
                value={input}
                onChange={(e) => onInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    if (input.trim() && !sending) onSend();
                  }
                }}
                rows={1}
                placeholder="Type your answer…"
                className="flex-1 resize-none rounded-xl border border-gray-200 px-3 py-2.5 text-sm text-gray-900 placeholder:text-gray-400 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-100 max-h-40"
              />
              <button
                type="button"
                onClick={onSend}
                disabled={!input.trim() || sending}
                aria-label="Send answer"
                className={`shrink-0 inline-flex items-center justify-center h-11 w-11 rounded-xl transition-colors ${
                  !input.trim() || sending
                    ? 'bg-gray-100 text-gray-400 cursor-not-allowed'
                    : 'bg-indigo-600 text-white hover:bg-indigo-700'
                }`}
              >
                <Send className="h-5 w-5" />
              </button>
            </div>
          </div>
        </div>

        {/* ── progress rail + gated build ─────────────────────────────────── */}
        <aside className="space-y-4">
          <div className="bg-white rounded-2xl shadow-sm border p-5">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm font-medium text-gray-700">Progress</span>
              <span className="text-sm font-semibold text-indigo-600">{percent}%</span>
            </div>
            <div className="w-full h-2.5 bg-gray-100 rounded-full overflow-hidden">
              <div
                className="h-full bg-gradient-to-r from-indigo-500 to-emerald-500 rounded-full transition-all duration-500"
                style={{ width: `${percent}%` }}
              />
            </div>
            {qNum != null && (
              <p className="text-xs text-gray-500 mt-2">Question {qNum}</p>
            )}
            {state?.progress?.phasesComplete && state.progress.phasesComplete.length > 0 && (
              <div className="flex flex-wrap gap-1.5 mt-3">
                {state.progress.phasesComplete.map((p) => (
                  <span
                    key={p}
                    className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700"
                  >
                    <CheckCircle2 className="h-3 w-3" />
                    {p}
                  </span>
                ))}
              </div>
            )}
          </div>

          {/* Gate checklist — makes the disabled Build button self-explaining. */}
          <div className="bg-white rounded-2xl shadow-sm border p-5">
            <h3 className="flex items-center gap-2 text-sm font-semibold text-gray-700 mb-3">
              <ShieldCheck className="h-4 w-4 text-indigo-600" />
              Before we can build
            </h3>
            <ul className="space-y-2.5">
              <GateRow
                done={flags.genuineTranscriptReady}
                label="Interview recorded"
              />
              <GateRow
                done={flags.decisionCoverageComplete}
                label={
                  flags.decisionCoverageComplete
                    ? 'Departments decided'
                    : `Departments decided${missingDepts ? ` (${missingDepts} left)` : ''}`
                }
              />
              <GateRow
                done={flags.noUnprovenancedDeclines}
                label="Choices confirmed"
              />
            </ul>
          </div>

          {completeError && (
            <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
              <div className="flex items-start gap-2">
                <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
                <p>{completeError}</p>
              </div>
            </div>
          )}

          <button
            type="button"
            onClick={onBuild}
            disabled={!allGatesPass || submitting}
            aria-disabled={!allGatesPass || submitting}
            className={`w-full inline-flex items-center justify-center gap-2 px-6 py-3.5 rounded-xl font-semibold transition-colors ${
              !allGatesPass || submitting
                ? 'bg-gray-200 text-gray-400 cursor-not-allowed'
                : 'bg-emerald-600 text-white hover:bg-emerald-700'
            }`}
          >
            {submitting ? (
              <>
                <Loader2 className="h-5 w-5 animate-spin" />
                Building…
              </>
            ) : allGatesPass ? (
              <>
                <Building2 className="h-5 w-5" />
                Build my company
              </>
            ) : (
              <>
                <Lock className="h-4 w-4" />
                Build my company
              </>
            )}
          </button>
          {!allGatesPass && (
            <p className="text-center text-xs text-gray-400">
              Finish the checklist above to unlock.
            </p>
          )}
        </aside>
      </div>
    </div>
  );
}

function GateRow({ done, label }: { done: boolean; label: string }) {
  return (
    <li className="flex items-center gap-2.5 text-sm">
      {done ? (
        <CheckCircle2 className="h-4 w-4 text-emerald-600 shrink-0" />
      ) : (
        <Lock className="h-4 w-4 text-gray-300 shrink-0" />
      )}
      <span className={done ? 'text-gray-800' : 'text-gray-400'}>{label}</span>
    </li>
  );
}

function MessageBubble({ message }: { message: ChatMessage }) {
  if (message.role === 'system') {
    return (
      <motion.div
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        className="flex justify-center"
      >
        <span className="inline-flex items-center gap-1.5 rounded-full bg-gray-100 px-3 py-1 text-xs text-gray-500">
          <Info className="h-3 w-3" />
          {message.text}
        </span>
      </motion.div>
    );
  }

  const isOwner = message.role === 'owner';
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      className={`flex ${isOwner ? 'justify-end' : 'justify-start'}`}
    >
      <div
        className={`max-w-[85%] rounded-2xl px-4 py-2.5 text-sm whitespace-pre-wrap ${
          isOwner
            ? 'bg-indigo-600 text-white rounded-br-sm'
            : 'bg-gray-100 text-gray-900 rounded-bl-sm'
        }`}
      >
        {message.text}
      </div>
    </motion.div>
  );
}

/* -------------------------------------------------------------------------- */
/* terminal screens: needs-review + fail (distinct renders)                    */
/* -------------------------------------------------------------------------- */

function NeedsReviewScreen({ message }: { message: string }) {
  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-amber-50 flex items-center justify-center p-6">
      <div className="max-w-md w-full text-center">
        <div className="inline-flex items-center justify-center h-16 w-16 rounded-2xl bg-amber-100 mb-4">
          <ClipboardList className="h-9 w-9 text-amber-600" />
        </div>
        <h1 className="text-2xl font-bold text-gray-900 mb-2">
          Thanks — we&apos;re reviewing your answers
        </h1>
        <p className="text-gray-600">{message}</p>
        <p className="text-sm text-gray-400 mt-6">
          You can close this tab. We&apos;ll be in touch shortly — no action needed.
        </p>
      </div>
    </div>
  );
}

function FailScreen({
  reasons,
  onReview,
}: {
  reasons: string[];
  onReview: () => void;
}) {
  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-rose-50 flex items-center justify-center p-6">
      <div className="max-w-lg w-full">
        <div className="text-center mb-6">
          <div className="inline-flex items-center justify-center h-16 w-16 rounded-2xl bg-rose-100 mb-4">
            <AlertTriangle className="h-9 w-9 text-rose-600" />
          </div>
          <h1 className="text-2xl font-bold text-gray-900 mb-2">
            A few answers need another look
          </h1>
          <p className="text-gray-600">
            We couldn&apos;t start the build yet. Here&apos;s what to revisit, then try again.
          </p>
        </div>

        {reasons.length > 0 && (
          <div className="bg-white rounded-2xl shadow-sm border p-5 mb-6">
            <ul className="space-y-2.5">
              {reasons.map((r, i) => (
                <li key={i} className="flex items-start gap-2.5 text-sm text-gray-700">
                  <AlertTriangle className="h-4 w-4 text-rose-500 mt-0.5 shrink-0" />
                  <span>{r}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        <button
          type="button"
          onClick={onReview}
          className="w-full inline-flex items-center justify-center gap-2 px-6 py-3.5 rounded-xl font-semibold bg-indigo-600 text-white hover:bg-indigo-700 transition-colors"
        >
          <RotateCcw className="h-5 w-5" />
          Review my answers
        </button>
      </div>
    </div>
  );
}
