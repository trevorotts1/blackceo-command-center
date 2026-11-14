import { queueInterviewOperation, tenantAnswers } from '@/lib/interview/remote-store';
import { deliverInterviewOperation } from '@/lib/interview/remote-protocol';
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
 * BU-13 (step gate): the SELF-tenant branch no longer decides whether an answer
 * is acceptable. `interview_gate.py answer` does — it is the only thing that may
 * say a question's answer was taken, needs one follow-up, or is out of order.
 * Every accepted block carries the registry question id as its first line
 * (`**QID:** <id>`), so every reader matches by id and never by wording.
 *
 * BU-17: the gate is an EXTERNAL skill script. When it is not installed on the
 * box at all the route keeps its pre-BU-13 contract (validate → append → 200,
 * `gate:'unavailable'`) rather than 503-ing the only write path; an installed
 * gate that fails is still a hard 503.
 *
 * Error mapping:
 *   400 invalid_request     — bad body (missing answer, unknown shape)
 *   400 missing_question    — no questionId, or no question text to record
 *   400 invalid_color       — brand-color answer that resolveBrandColor can't resolve
 *   400 invalid_logo_url    — logo answer that is not a valid http(s) URL
 *   409 out_of_order        — the gate refused: not this question's turn
 *   200 accepted:false      — the gate asks for ONE follow-up; nothing appended
 *   500 answers_write_failed — the transcript append itself failed
 *   503 script_unavailable  — update-interview-state.sh not installed on this box
 *   503 temporarily_unavailable — the gate is missing or could not run
 *   502 state_write_failed  — any other non-zero exit from the state script
 */

import { NextRequest, NextResponse } from 'next/server';
import { execFile } from 'child_process';
import { createRequire } from 'module';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import {
  runGate,
  getOrCreateInterviewSessionId,
  resolveInterviewWriteIdentity,
  InterviewScriptError,
  InterviewScriptMissingError,
} from '@/lib/interview/seam';
import {
  buildStatePath,
  interviewGateScript,
  scriptExists,
  updateInterviewStateScript,
} from '@/lib/interview/paths';
import { refreshInterviewMirror } from '@/lib/interview/mirror';
import { answersFilePath, answersEncFilePath } from '@/lib/interview/paths';
import { isEncryptedEnvelope, readEncryptedFile } from '@/lib/interview/crypto';
import { appendTranscriptTextAtomic, readTranscriptText } from '@/lib/interview/seam';
import { mirrorCompanyAnswer } from '@/lib/interview/company-mirror';
import {
  answerRequestSchema,
  isDataImageUrl,
  type AnswerRequestBody,
} from '@/lib/interview/answer-schema';
import { INTERVIEW_QUESTIONS, type InterviewQuestion } from '@/lib/interview-questions';
import { resolveBrandColor } from '@/lib/branding';
import { getClientContext, updateClient } from '@/lib/clients';
import { resolveInterviewTenant, refuseUnverifiedTenant } from '@/lib/interview/tenant';
import { recordAnsweredQuestion } from '@/lib/interview/client-interview-state';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

/** The fabricated-transcript header. NEVER emitted by this route — kept here only
 *  so the intent is explicit and greppable. Its presence would make the whole
 *  file count as non-genuine (mirrors seam.NON_INTERACTIVE_ANSWERS_HEADER). */
const SYNTHETIC_HEADER = '# Workforce Interview Answers (Non-Interactive)';
/** The GENUINE header the canonical writer (build-workforce.log_answer) stamps. */
const GENUINE_HEADER = '# Workforce Interview Answers';

/**
 * The request schema lives in src/lib/interview/answer-schema.ts so the
 * contract test (tests/unit/interview-answer-contract.test.ts) can parse the
 * exact bodies the client-side buildAnswerPayload() produces with the route's
 * REAL rules — any client/route drift fails CI instead of failing owners (the
 * pre-v4.63 `value` vs `answer` bug 400'd every structured card submit).
 */
type AnswerBody = AnswerRequestBody;

const execFileAsync = promisify(execFile);
const STATE_SYNC_TIMEOUT_MS = 30_000;

/**
 * The vendored registry v2 (a byte copy of the one installed with the skill).
 * Read ONLY to recover a question's wording when the client did not send one —
 * the transcript still records the real question that was asked, and the
 * `**QID:**` line (not the wording) is what later readers match on.
 */
const V2_REGISTRY: { questions?: Array<{ id?: string; prompt?: string }> } =
  createRequire(import.meta.url)('../../../../lib/interview-questions.v2.json');

function registryPromptFor(questionId?: string): string | undefined {
  const id = (questionId ?? '').trim();
  if (!id) return undefined;
  const q = (V2_REGISTRY.questions ?? []).find((entry) => entry.id === id);
  return q?.prompt?.trim() || undefined;
}

/** The gate's `next` payload, or null when the gate could not answer. */
async function gateNext(): Promise<unknown> {
  const next = await runGate(['next']);
  return next.code === 0 ? next.json : null;
}

/**
 * Stamp progress from the gate — `update-interview-state.sh --state <file>
 * --sync-from-gate` (BU-12). Replaces the old `--question-number` stamp: the
 * gate's own counters are the only ones that may reach build-state.
 *
 * The script is invoked directly (rather than through seam.updateInterviewState,
 * which has no --sync-from-gate/--state flags) so it is pinned to the EXACT
 * build-state file this app reads. Its failures surface as the same typed errors
 * the route already maps, so the 503/429/502 handling below is unchanged.
 */
async function syncProgressFromGate(): Promise<void> {
  const script = updateInterviewStateScript();
  if (!scriptExists(script)) throw new InterviewScriptMissingError(script);
  try {
    await execFileAsync('bash', [script, '--state', buildStatePath(), '--sync-from-gate'], {
      encoding: 'utf-8',
      timeout: STATE_SYNC_TIMEOUT_MS,
      maxBuffer: 8 * 1024 * 1024,
    });
  } catch (err) {
    const e = err as NodeJS.ErrnoException & {
      code?: number | string;
      stderr?: string;
      stdout?: string;
    };
    throw new InterviewScriptError(
      script,
      typeof e.code === 'number' ? e.code : null,
      e.stderr ?? '',
      e.stdout ?? '',
    );
  }
}

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
 * Append a genuine Q/A block to the interview transcript, mirroring
 * build-workforce.log_answer() byte-shape. U048: the transcript is stored
 * ENCRYPTED at rest in the `.enc` file. The plaintext `.md` is never the
 * primary write target — it is only a derived export artifact.
 *
 * ILJ-003: the read (with tail-merge), append, and re-encrypt happen inside
 * one transcript lock hold (appendTranscriptTextAtomic), so parallel writers
 * serialize and no answer is lost to a read-modify-write race. A
 * present-but-undecryptable `.enc` store returns decrypt_failed and writes
 * nothing; the quarantine refusal below keeps the answers_unreadable (500)
 * response contract unchanged.
 *
 * Returns the resolved encrypted transcript path (for the response / logging).
 *
 * Item (1), in-lane half: quarantine a transcript whose encrypted store exists
 * but no longer decrypts, BEFORE appendAnswerBlock would append to a blank
 * slate and re-encrypt over it. A decrypt failure with an `.enc` file present
 * means either the key rotated under the data or the file is corrupt — in both
 * cases appending a fresh transcript and renaming over the old `.enc` would
 * destroy answers that are still recoverable (old key, backup, operator
 * repair). So the route refuses with `answers_unreadable` (500) and renames
 * the suspect file to `<enc>.quarantine-<epoch>` for forensics, leaving the
 * plaintext fallback path (no `.enc` at all) untouched. The seam.ts proper
 * fix (decrypt_failed distinct state) is ILF-005-owned, CROSS-LANE.
 */
function quarantineUnreadableTranscript(): string | null {
  try {
    const encPath = answersEncFilePath();
    const plainPath = answersFilePath();
    if (encPath === plainPath) return null;
    if (!fs.existsSync(encPath)) return null;
    let envelope: string;
    try {
      envelope = fs.readFileSync(encPath, 'utf-8');
    } catch {
      return null;
    }
    if (!isEncryptedEnvelope(envelope)) return null;
    if (readEncryptedFile(encPath) !== null) return null;
    const quarantined = `${encPath}.quarantine-${Date.now()}`;
    try {
      fs.renameSync(encPath, quarantined);
    } catch {
      return encPath;
    }
    return quarantined;
  } catch {
    return null;
  }
}

function appendAnswerBlock(args: {
  qid: string;
  question: string;
  answer: string;
  confirmedFromContext?: string;
}): string {
  const encPath = answersEncFilePath();
  const plainPath = answersFilePath();
  fs.mkdirSync(path.dirname(encPath), { recursive: true });

  // Item (1): quarantine before read. File exists but decrypt fails = refuse
  // with 500 in the caller, never append-over-corrupt.
  const quarantined = quarantineUnreadableTranscript();
  if (quarantined) {
    throw new Error(`refusing to append: encrypted transcript unreadable, quarantined to ${quarantined}`);
  }

  // Build the Q/A block byte-shape (mirrors build-workforce.log_answer), with
  // the registry id as the block's FIRST line: registry v2 readers match an
  // answer by its id and never consult the wording.
  let block = `**QID:** ${args.qid}\n**Q:** ${args.question}\n**A:** ${args.answer}\n`;
  if (args.confirmedFromContext && args.confirmedFromContext.trim()) {
    block += `**Provenance:** confirmed-from-context: ${args.confirmedFromContext.trim()}\n`;
  }
  block += `**Logged:** ${humanNow()}\n\n---\n\n`;

  // Fresh transcript → GENUINE header only. Guard against ever writing the
  // synthetic header (it would poison the genuineness gate). The header vs
  // append decision happens INSIDE appendTranscriptTextAtomic's lock hold
  // (freshPrefix callback), so two concurrent first-writers cannot both see
  // "empty" and double-stamp or interleave the header.
  const header = `${GENUINE_HEADER}\n\nStarted: ${humanNow()}\n\n---\n\n`;
  if (header.includes(SYNTHETIC_HEADER)) {
    throw new Error('refusing to write synthetic non-interactive header');
  }

  // Atomic locked write: locked read (with tail-merge) + fresh-prefix-or-append
  // + re-encrypt inside one transcript lock hold, so parallel writers serialize
  // and no answer is lost. A present-but-undecryptable store returns
  // decrypt_failed and writes nothing — surfaced below as the unchanged
  // answers_unreadable refusal, never an append over a blank slate.
  const appended = appendTranscriptTextAtomic(block, undefined, { freshPrefix: header });
  if (appended.decrypt === 'decrypt_failed') {
    throw new Error(
      `refusing to append: encrypted transcript unreadable, quarantined to ${appended.path}`,
    );
  }
  if (!appended.exists) {
    throw new Error('refusing to append: transcript write did not persist');
  }

  return appended.path;
}

export async function POST(req: NextRequest) {
  // 1) Validate the body.
  let body: AnswerBody;
  try {
    body = answerRequestSchema.parse(await req.json());
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

  // 2) Resolve the question text + its storeOn column. The wording recorded in
  //    the block is, in order: what the client showed, the registry v2 prompt
  //    for that id, the Command Center deck's prompt. The id recorded in the
  //    `**QID:**` line is what every reader matches on.
  const question = findQuestion(body.questionId);
  const questionText =
    (body.prompt && body.prompt.trim()) ||
    registryPromptFor(body.questionId) ||
    question?.prompt ||
    '';
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
    if (isDataImageUrl(answer)) {
      // File-drop path: the card carries the image inline as a data: URL. The
      // FULL value mirrors onto clients.logo_url (so <BrandTheme/> renders it),
      // but the transcript records a short, human line instead of a megabyte of
      // base64 — the genuine answer is "uploaded a logo file", not the bytes.
      logoUrl = answer.trim();
      const mime = /^data:(image\/[a-z0-9.+-]+);/i.exec(logoUrl)?.[1] ?? 'image';
      const approxKb = Math.max(1, Math.round((logoUrl.length * 3) / 4 / 1024));
      transcriptAnswer = `Uploaded a logo file (${mime}, ~${approxKb} KB) — stored for the dashboard and brand materials.`;
    } else if (isHttpUrl(answer)) {
      logoUrl = answer.trim();
    } else {
      return NextResponse.json(
        {
          error: 'invalid_logo_url',
          message:
            'Paste a public http(s) link to your logo (for example https://…/logo.png), or drop an image file.',
        },
        { status: 400 },
      );
    }
  }

  // 3b) TENANT SPLIT (TENANT-INTERVIEW-FIX phase 2). Everything below this point
  //     — the transcript append, the update-interview-state.sh stamp, the
  //     company-config mirror — writes the OPERATOR's canonical state, of which
  //     there is exactly one set on this box. A remote client routed here by
  //     hostname must never reach any of it.
  //
  //     Observed live before this branch existed: a client's answers were
  //     appended to the OPERATOR's encrypted transcript, stamped onto the
  //     OPERATOR's build-state, and mirrored onto the OPERATOR's clients row —
  //     the operator's company name was overwritten with the client's.
  //
  //     A client tenant records its answer against its OWN row and its own
  //     resume state, and returns here. Validation above (empty answer, bad
  //     color, bad logo URL) has already run, so a client gets the same
  //     rejections; only the write targets differ.
  const tenant = await resolveInterviewTenant(req);
  const refusedTenant = refuseUnverifiedTenant(tenant);
  if (refusedTenant) return refusedTenant;
  if (tenant.kind === 'client' && tenant.client) {
    const clientId = tenant.client.id;
    let saved;
    try {
      saved = queueInterviewOperation(tenant.context!, 'answer', { ...body, prompt: questionText, answer: transcriptAnswer }, req.headers.get('idempotency-key') || undefined);
    } catch { return NextResponse.json({error:'answer_not_saved',message:'Your answer could not be saved. Please retry.'},{status:503}); }
    const delivery = await deliverInterviewOperation(tenant.context!, saved);


    // Resume position: remember WHICH question was answered (id only — the
    // answer text is never written to the operator's stores).
    let answeredIds: string[] | null = null;
    if (question?.id) {
      answeredIds = recordAnsweredQuestion(clientId, question.id);
    }

    // Branding mirror onto the CLIENT's own row, so her dashboard themes from
    // her answers. Never getClientContext() — that resolves to the operator.
    let mirrored: { column: string; ok: boolean; warning?: string } | null = null;
    const clientColumn: 'brand_color' | 'logo_url' | 'name' | null = brandColorHex
      ? 'brand_color'
      : logoUrl
        ? 'logo_url'
        : storeOn === 'client.name'
          ? 'name'
          : null;
    if (clientColumn) {
      const value = (brandColorHex ?? logoUrl ?? answer) as string;
      try {
        updateClient(clientId, { [clientColumn]: value });
        mirrored = { column: clientColumn, ok: true };
      } catch (err) {
        mirrored = {
          column: clientColumn,
          ok: false,
          warning: err instanceof Error ? err.message : 'mirror upsert failed',
        };
      }
    }

    return NextResponse.json({
      ok: true,
      tenant: 'client',
      clientId,
      questionId: question?.id ?? null,
      answeredCount: new Set(tenantAnswers(tenant.context!.tenantId).map(a=>a.question_id)).size,
      operationId: saved.operation_id,
      saveStatus: delivery.state === 'acknowledged' ? 'synced' : 'saved_waiting_sync',
      syncReason: delivery.reason,
      mirror: mirrored,
      // No operator transcript is written for a client tenant, so there is no
      // transcriptPath to report. Said plainly rather than faked.
      transcriptPath: null,
    });
  }

  // 3c) THE STEP GATE DECIDES (BU-13) — self tenant only; the client tenant
  //     returned above with its own store untouched.
  //
  //     `interview_gate.py answer` is the ONLY thing allowed to say that an
  //     answer was taken (exit 0), needs exactly one follow-up (exit 3, nothing
  //     written), or is for a question that is not current (exit 2). Answers are
  //     matched by question id, so an answer that cannot name its question id
  //     cannot be placed at all — it is refused here rather than guessed at from
  //     its wording.
  const questionId = (body.questionId ?? '').trim();
  if (!questionId) {
    return NextResponse.json(
      {
        error: 'missing_question',
        message:
          'A structured answer must carry the questionId it was asked under, so the ' +
          'step gate can place it.',
      },
      { status: 400 },
    );
  }
  const gateArgs = ['answer', '--qid', questionId, '--text', transcriptAnswer, '--source', 'web'];
  if (body.confirmedFromContext && body.confirmedFromContext.trim()) {
    gateArgs.push('--confirmed-from', body.confirmedFromContext.trim());
  }
  // BU-17 RED-FIX: the gate is an EXTERNAL skill script (23-ai-workforce-blueprint),
  // not something this app ships. When it is not installed on this box at all, the
  // structured write keeps the route's pre-BU-13 contract — validate, append the
  // canonical Q/A block, return the 200 receipt — instead of 503-ing the only write
  // path the web surface has. The transcript is still the source of truth and the
  // block still carries its `**QID:**`; the gate adds ORDERING/COUNTING, not
  // authenticity. A gate that IS installed but fails is still a hard 503 below —
  // a present-but-broken gate is never bypassed.
  const gateInstalled = scriptExists(interviewGateScript());
  const gate = gateInstalled ? await runGate(gateArgs) : null;

  if (gate && gate.code === 2) {
    // Wrong question, unknown question, or an edit that is not allowed: the gate
    // names the question that IS current.
    return NextResponse.json(
      { error: 'out_of_order', expected: gate.json?.expected ?? null },
      { status: 409 },
    );
  }
  if (gate && gate.code === 3) {
    // One follow-up only. The gate did not record anything, so neither do we.
    return NextResponse.json({
      ok: true,
      accepted: false,
      questionId,
      reason: gate.json?.reason ?? null,
      followUp: gate.json?.followUp ?? null,
      next: await gateNext(),
    });
  }
  if (gate && gate.code !== 0) {
    // Tooling failure: "temporarily unavailable", never "that answer was refused".
    return NextResponse.json({ error: 'temporarily_unavailable' }, { status: 503 });
  }

  // 4) CANONICAL WRITE #1 — append the genuine Q/A block to the transcript.
  let transcriptPath: string;
  try {
    transcriptPath = appendAnswerBlock({
      qid: questionId,
      question: questionText,
      answer: transcriptAnswer,
      confirmedFromContext: body.confirmedFromContext,
    });
  } catch (err) {
    // Item (1): quarantine refusal surfaces as a distinct code so the client
    // knows answers are preserved, not lost — retry after the operator repairs
    // the key/file, do not start over.
    const quarantined = err instanceof Error && err.message.startsWith('refusing to append: encrypted transcript unreadable');
    return NextResponse.json(
      quarantined
        ? {
          error: 'answers_unreadable',
          message: 'Your saved answers are temporarily unreadable, so this answer was not saved on top of them. They are preserved for repair — please retry later, do not start over.',
        }
        : {
          error: 'answers_write_failed',
          message: 'Your answer could not be saved to the interview transcript. Please try again.',
          detail: err instanceof Error ? err.message : 'unknown error',
        },
      { status: 500 },
    );
  }

  // 5) CANONICAL WRITE #2 — mirror the gate's own counters into build-state with
  //    `update-interview-state.sh --state <file> --sync-from-gate` (BU-12).
  //    `--question-number` is gone: the gate's answeredTotal/requiredTotal are
  //    the only counters that may reach build-state, so the two can never
  //    disagree. Same script the Telegram agent presses; the script owns the
  //    build-state write. The transcript is already saved, so a stamp failure is
  //    reported but the answer is NOT lost (appended:true).
  //
  //    P0 FIX (client incident, 2026-07): the caller identity is still resolved
  //    exactly as before (explicit askedBy → Cf-Access email → operator-email),
  //    defaults to the 'interview-web' sentinel and supplies the stable session
  //    id; --sync-from-gate carries no rate-limit charge, so neither value is a
  //    throttle key here — they key the read-mirror refresh at step 7.
  const { askedBy, rateLimitSessionId } = resolveInterviewWriteIdentity({
    bodyAskedBy: body.askedBy,
    cfAccessEmail: req.headers.get('Cf-Access-Authenticated-User-Email'),
    operatorEmail: req.headers.get('x-operator-email'),
  });
  try {
    await syncProgressFromGate();
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
      // 89 = rate-limited (lib-interview-rate-limit.sh). LOUD and distinct from
      // any other script failure: a real 429, a plain-language explanation, and
      // an explicit statement that nothing was lost — the transcript write in
      // step 4 already landed, and update-interview-state.sh has durably queued
      // this progress stamp for automatic replay (see .interview-state-deferred.jsonl
      // in its own doc comment). This is the fix for the incident where a rate-limit
      // trip was indistinguishable from any other failure and was silently dropped.
      if (err.exitCode === 89) {
        return NextResponse.json(
          {
            error: 'rate_limited',
            message:
              "Your answer was saved. You're submitting faster than this interview " +
              'session allows right now — your progress update is queued and will be ' +
              'applied automatically (or retry in a bit); nothing is lost.',
            appended: true,
            transcriptPath,
            exitCode: err.exitCode,
            detail: err.stderr.trim() || undefined,
          },
          { status: 429 },
        );
      }
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

  // 6) DERIVED MIRROR — reflect answers onto their display-facing stores so the
  //    Command Center the owner unlocks already carries what they said:
  //      client.brand_color / client.logo_url → clients row (BrandTheme re-theme)
  //      client.name                          → clients row (header / roster)
  //      company.industry / commandCenterName → config/company-config.json
  //    Best-effort: a mirror failure NEVER unwinds the canonical writes above
  //    (files win). Reports what landed / what warned.
  let mirror:
    | { column: string; value: string; ok: true }
    | { column: string; value: string; ok: false; warning: string }
    | null = null;

  const clientColumn: 'brand_color' | 'logo_url' | 'name' | null = brandColorHex
    ? 'brand_color'
    : logoUrl
      ? 'logo_url'
      : storeOn === 'client.name'
        ? 'name'
        : null;

  if (clientColumn) {
    const value = (brandColorHex ?? logoUrl ?? answer) as string;
    try {
      const client = await getClientContext();
      if (!client?.id) {
        mirror = {
          column: clientColumn,
          value,
          ok: false,
          warning: 'no client on record to mirror the answer onto (transcript still saved)',
        };
      } else {
        updateClient(client.id, { [clientColumn]: value });
        mirror = { column: clientColumn, value, ok: true };
      }
    } catch (err) {
      mirror = {
        column: clientColumn,
        value,
        ok: false,
        warning: err instanceof Error ? err.message : 'mirror upsert failed',
      };
    }
  } else if (
    storeOn === 'company.industry' ||
    storeOn === 'company.commandCenterName'
  ) {
    // Company-config mirror (atomic runtime write; tracked template untouched).
    const key = storeOn === 'company.industry' ? 'industry' : 'commandCenterName';
    try {
      const ok = mirrorCompanyAnswer({ [key]: answer });
      mirror = ok
        ? { column: key, value: answer, ok: true }
        : { column: key, value: answer, ok: false, warning: 'company-config mirror skipped' };
    } catch (err) {
      mirror = {
        column: key,
        value: answer,
        ok: false,
        warning: err instanceof Error ? err.message : 'company-config mirror failed',
      };
    }
  }
  // company_name additionally mirrors into company-config (the CEO Board title)
  // alongside the clients-row name above — still best-effort, never blocking.
  if (storeOn === 'client.name') {
    try {
      mirrorCompanyAnswer({ companyName: answer });
    } catch {
      /* non-fatal */
    }
  }

  // 7) READ-MIRROR refresh (P2-2). Re-sync the interview_sessions/interview_answers
  //    index FROM the canonical files just written. Best-effort and READ-ONLY on
  //    the files: refreshInterviewMirror never throws and never gates — a mirror
  //    failure NEVER fails this request (the canonical writes already landed).
  //    U013: the mirror is a derived index, NOT the canonical source — see
  //    docs/interview-state-source-of-truth.md.
  //    getOrCreateInterviewSessionId gives the sync a stable key (the seam's sole
  //    benign build-state write; it touches no gate field). Reuse the id already
  //    resolved above for the rate-limit key when we have it (identical value —
  //    the function is idempotent — this just avoids reading build-state twice).
  let dbMirror: { ok: boolean; answers?: number; skipped?: string } | null = null;
  try {
    const sessionId = rateLimitSessionId ?? getOrCreateInterviewSessionId();
    const res = refreshInterviewMirror({ sessionId, ownerId: askedBy });
    dbMirror = { ok: res.ok, answers: res.answersMirrored, skipped: res.skipped };
  } catch {
    dbMirror = { ok: false };
  }

  // 8) Success. Canonical writes landed; mirror reported (may be a soft warning).
  //    `accepted`/`shortAccepted`/`next` come from the gate, so the page renders
  //    the same decision the Telegram agent got. When the gate is not installed,
  //    `gate` is null: the answer is still accepted, and the receipt says plainly
  //    that its ORDER was not gate-verified rather than implying it was.
  return NextResponse.json({
    ok: true,
    accepted: true,
    shortAccepted: gate?.json?.shortAccepted === true,
    gate: gate ? 'verified' : 'unavailable',
    questionId,
    storeOn: storeOn ?? null,
    appended: true,
    stateStamped: true,
    transcriptPath,
    next: await gateNext(),
    mirror,
    dbMirror,
  });
}
