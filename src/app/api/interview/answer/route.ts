/**
 * POST /api/interview/answer  (P1-2)
 *
 * The STRUCTURED-CARD write path — how the web surface records a single
 * structured answer (a brand color, a logo URL, a validated text field) that the
 * client submitted from a QuestionCard (P1-1) instead of typing it into the
 * conversational pane. It presses the EXACT same buttons the Telegram interview
 * agent presses, in the EXACT same order, so every anti-fabrication / provenance
 * gate is inherited for free:
 *
 *   1) Append a REAL Q/A block to workforce-interview-answers.md — byte-for-byte
 *      the shape build-workforce.log_answer() writes ("**Q:** …\n**A:** …\n
 *      **Logged:** …\n\n---\n\n"). If the file does not yet exist it is created
 *      with the GENUINE header ("# Workforce Interview Answers"), NEVER the
 *      synthetic non-interactive header — so the transcript stays genuine and its
 *      **Q:** block count keeps growing toward the >=3 gate (#2).
 *   2) Stamp progress via update-interview-state.sh --phase --question-number
 *      --asked-by (seam.updateInterviewState → execFile). The script owns the
 *      build-state write; this route never touches build-state with TS/jq.
 *   3) Mirror branding answers onto the clients table so BrandTheme re-themes the
 *      whole Command Center live: client.brand_color (via resolveBrandColor) and
 *      client.logo_url — the EXACT storeOn columns declared in
 *      interview-questions.branding-questions.json. The DB mirror is best-effort:
 *      a mirror failure NEVER unwinds the canonical file/state writes (files win).
 *
 * DOCTRINE (do not violate):
 *   • Files are the single source of truth. The transcript append + the state
 *     stamp are the canonical writes; the clients-table columns are a derived
 *     mirror that only drives live theming.
 *   • This route NEVER writes interviewComplete, NEVER writes a decision, and
 *     NEVER hand-writes build-state — those go exclusively through the scripts.
 *   • The synthetic "(Non-Interactive)" header is NEVER emitted here.
 *
 * Error mapping:
 *   400 invalid_request     — bad body (missing answer, unknown shape)
 *   400 missing_question    — neither a known questionId nor a prompt was given
 *   400 invalid_color       — brand-color answer that resolveBrandColor can't resolve
 *   400 invalid_logo_url    — logo answer that is not a valid http(s) URL
 *   500 answers_write_failed — the transcript append itself failed
 *   503 script_unavailable  — update-interview-state.sh not installed on this box
 *   502 state_write_failed  — any other non-zero exit from the state script
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import {
  updateInterviewState,
  getOrCreateInterviewSessionId,
  InterviewScriptError,
  InterviewScriptMissingError,
} from '@/lib/interview/seam';
import { refreshInterviewMirror } from '@/lib/interview/mirror';
import { answersFilePath } from '@/lib/interview/paths';
import { INTERVIEW_QUESTIONS, type InterviewQuestion } from '@/lib/interview-questions';
import { resolveBrandColor } from '@/lib/branding';
import { getClientContext, updateClient } from '@/lib/clients';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

/** The fabricated-transcript header. NEVER emitted by this route — kept here only
 *  so the intent is explicit and greppable. Its presence would make the whole
 *  file count as non-genuine (mirrors seam.NON_INTERACTIVE_ANSWERS_HEADER). */
const SYNTHETIC_HEADER = '# Workforce Interview Answers (Non-Interactive)';
/** The GENUINE header the canonical writer (build-workforce.log_answer) stamps. */
const GENUINE_HEADER = '# Workforce Interview Answers';

const requestSchema = z.object({
  // Preferred: the stable interview-questions.ts id (resolves prompt + storeOn).
  questionId: z.string().min(1).max(128).optional(),
  // The question text actually shown to the client. Required only when questionId
  // is absent/unknown (so the transcript always records a real question line).
  prompt: z.string().min(1).max(2000).optional(),
  // The client's answer value (a color, a URL, or free text). Never empty.
  answer: z.string().min(1).max(20000),
  // Progress stamp inputs (pressed straight through to update-interview-state.sh).
  phase: z.string().min(1).max(64).optional(),
  questionNumber: z.number().int().min(0).max(100000).optional(),
  // Who asked — provenance for the state stamp. Defaults to the web surface.
  askedBy: z.string().min(1).max(128).optional(),
  // When this answer CONFIRMS a known-context fact, the source is recorded as a
  // `confirmed-from-context: <source>` provenance note inside the Q/A block, so
  // qc-interview-completion.py check #5 classifies it as confirmed, not fabricated.
  confirmedFromContext: z.string().min(1).max(256).optional(),
});

type AnswerBody = z.infer<typeof requestSchema>;

/** Human timestamp in the same style as build-workforce.log_answer's "%B %d, %Y at %I:%M %p". */
function humanNow(): string {
  return new Date().toLocaleString('en-US', {
    month: 'long',
    day: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  });
}

/** Look up the structured question definition (for its prompt + storeOn column). */
function findQuestion(questionId?: string): InterviewQuestion | undefined {
  if (!questionId) return undefined;
  return INTERVIEW_QUESTIONS.find((q) => q.id === questionId);
}

/** Loose http(s) URL validation for a logo answer. */
function isHttpUrl(value: string): boolean {
  try {
    const u = new URL(value.trim());
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Append a genuine Q/A block to workforce-interview-answers.md, mirroring
 * build-workforce.log_answer() byte-shape. Creates the file with the GENUINE
 * header (never the synthetic one) if it is absent, and ensures the parent
 * company-discovery dir exists. The append uses fs flag 'a' (O_APPEND), so the
 * write of a single block is atomic even if the Telegram agent is appending
 * concurrently to the same transcript.
 *
 * Returns the resolved transcript path (for the response / logging).
 */
function appendAnswerBlock(args: {
  question: string;
  answer: string;
  confirmedFromContext?: string;
}): string {
  const p = answersFilePath();
  fs.mkdirSync(path.dirname(p), { recursive: true });

  if (!fs.existsSync(p)) {
    // Fresh transcript → GENUINE header only. Guard against ever writing the
    // synthetic header (it would poison the genuineness gate).
    const header = `${GENUINE_HEADER}\n\nStarted: ${humanNow()}\n\n---\n\n`;
    if (header.includes(SYNTHETIC_HEADER)) {
      throw new Error('refusing to write synthetic non-interactive header');
    }
    fs.appendFileSync(p, header, 'utf-8');
  }

  let block = `**Q:** ${args.question}\n**A:** ${args.answer}\n`;
  if (args.confirmedFromContext && args.confirmedFromContext.trim()) {
    block += `**Provenance:** confirmed-from-context: ${args.confirmedFromContext.trim()}\n`;
  }
  block += `**Logged:** ${humanNow()}\n\n---\n\n`;
  fs.appendFileSync(p, block, 'utf-8');
  return p;
}

export async function POST(req: NextRequest) {
  // 1) Validate the body.
  let body: AnswerBody;
  try {
    body = requestSchema.parse(await req.json());
  } catch (err) {
    return NextResponse.json(
      { error: 'invalid_request', detail: err instanceof Error ? err.message : 'bad body' },
      { status: 400 },
    );
  }

  const answer = body.answer.trim();
  if (!answer) {
    return NextResponse.json(
      { error: 'invalid_request', detail: 'answer is empty' },
      { status: 400 },
    );
  }

  // 2) Resolve the question text + its storeOn column.
  const question = findQuestion(body.questionId);
  const questionText = (body.prompt && body.prompt.trim()) || question?.prompt || '';
  if (!questionText) {
    return NextResponse.json(
      {
        error: 'missing_question',
        message:
          'A structured answer must carry either a known questionId or an explicit ' +
          'prompt, so the transcript records the real question that was asked.',
      },
      { status: 400 },
    );
  }
  const storeOn = question?.storeOn;

  // 3) Branding validation — BEFORE any write, so a junk color/URL is never
  //    recorded in the transcript or mirrored onto a client column.
  let brandColorHex: string | null = null;
  let logoUrl: string | null = null;
  let transcriptAnswer = answer;

  if (storeOn === 'client.brand_color') {
    const res = resolveBrandColor(answer);
    if (!res.hex) {
      return NextResponse.json(
        {
          error: 'invalid_color',
          message:
            `"${answer}" is not a color we recognize. Enter a hex code like ` +
            '#1E3A8A, or a common color name like "navy" or "forest green".',
        },
        { status: 400 },
      );
    }
    brandColorHex = res.hex;
    // Self-documenting transcript: record what the client said + the resolved hex.
    transcriptAnswer =
      res.source === 'hex' ? res.hex : `${answer} (resolved brand color: ${res.hex})`;
  } else if (storeOn === 'client.logo_url') {
    if (!isHttpUrl(answer)) {
      return NextResponse.json(
        {
          error: 'invalid_logo_url',
          message: 'Paste a public http(s) link to your logo (for example https://…/logo.png).',
        },
        { status: 400 },
      );
    }
    logoUrl = answer.trim();
  }

  // 4) CANONICAL WRITE #1 — append the genuine Q/A block to the transcript.
  let transcriptPath: string;
  try {
    transcriptPath = appendAnswerBlock({
      question: questionText,
      answer: transcriptAnswer,
      confirmedFromContext: body.confirmedFromContext,
    });
  } catch (err) {
    return NextResponse.json(
      {
        error: 'answers_write_failed',
        message: 'Your answer could not be saved to the interview transcript. Please try again.',
        detail: err instanceof Error ? err.message : 'unknown error',
      },
      { status: 500 },
    );
  }

  // 5) CANONICAL WRITE #2 — stamp progress via update-interview-state.sh.
  //    Same button the Telegram agent presses; the script owns the build-state
  //    write. The transcript is already saved, so a stamp failure is reported but
  //    the answer is NOT lost (appended:true).
  const askedBy =
    (body.askedBy && body.askedBy.trim()) ||
    req.headers.get('Cf-Access-Authenticated-User-Email') ||
    req.headers.get('x-operator-email') ||
    'interview-web';
  try {
    await updateInterviewState({
      phase: body.phase,
      questionNumber: body.questionNumber,
      askedBy,
    });
  } catch (err) {
    if (err instanceof InterviewScriptMissingError) {
      return NextResponse.json(
        {
          error: 'script_unavailable',
          message:
            'Your answer was saved, but the progress tracker is not installed on this ' +
            'box yet, so your position was not stamped.',
          appended: true,
          transcriptPath,
          script: err.script,
        },
        { status: 503 },
      );
    }
    if (err instanceof InterviewScriptError) {
      return NextResponse.json(
        {
          error: 'state_write_failed',
          message: 'Your answer was saved, but stamping your progress failed. Please try again.',
          appended: true,
          transcriptPath,
          exitCode: err.exitCode,
          detail: err.stderr.trim().split('\n').slice(-1)[0] || undefined,
        },
        { status: 502 },
      );
    }
    return NextResponse.json(
      {
        error: 'state_write_failed',
        message: err instanceof Error ? err.message : 'unknown error',
        appended: true,
        transcriptPath,
      },
      { status: 502 },
    );
  }

  // 6) DERIVED MIRROR — reflect branding answers onto the clients table so
  //    BrandTheme re-themes live. Best-effort: a mirror failure NEVER unwinds the
  //    canonical writes above (files win). Reports what landed / what warned.
  let mirror:
    | { column: 'brand_color' | 'logo_url'; value: string; ok: true }
    | { column: 'brand_color' | 'logo_url'; value: string; ok: false; warning: string }
    | null = null;

  if (brandColorHex || logoUrl) {
    const column: 'brand_color' | 'logo_url' = brandColorHex ? 'brand_color' : 'logo_url';
    const value = (brandColorHex ?? logoUrl) as string;
    try {
      const client = getClientContext();
      if (!client?.id) {
        mirror = {
          column,
          value,
          ok: false,
          warning: 'no client on record to mirror the branding answer onto (transcript still saved)',
        };
      } else {
        const patch =
          column === 'brand_color' ? { brand_color: value } : { logo_url: value };
        updateClient(client.id, patch);
        mirror = { column, value, ok: true };
      }
    } catch (err) {
      mirror = {
        column,
        value,
        ok: false,
        warning: err instanceof Error ? err.message : 'mirror upsert failed',
      };
    }
  }

  // 7) READ-MIRROR refresh (P2-2). Re-sync the interview_sessions/interview_answers
  //    index FROM the canonical files just written. Best-effort and READ-ONLY on
  //    the files: refreshInterviewMirror never throws and never gates — a mirror
  //    failure NEVER fails this request (the canonical writes already landed).
  //    getOrCreateInterviewSessionId gives the sync a stable key (the seam's sole
  //    benign build-state write; it touches no gate field).
  let dbMirror: { ok: boolean; answers?: number; skipped?: string } | null = null;
  try {
    const sessionId = getOrCreateInterviewSessionId();
    const res = refreshInterviewMirror({ sessionId, ownerId: askedBy });
    dbMirror = { ok: res.ok, answers: res.answersMirrored, skipped: res.skipped };
  } catch {
    dbMirror = { ok: false };
  }

  // 8) Success. Canonical writes landed; mirror reported (may be a soft warning).
  return NextResponse.json({
    ok: true,
    questionId: body.questionId ?? null,
    storeOn: storeOn ?? null,
    appended: true,
    stateStamped: true,
    transcriptPath,
    mirror,
    dbMirror,
  });
}
