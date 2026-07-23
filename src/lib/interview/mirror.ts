/**
 * Interview mirror-on-write sync (P2-2).
 *
 * Reads the canonical interview FILES (via the P0-1 seam's pure fs readers) and
 * upserts their contents into the `interview_sessions` + `interview_answers`
 * READ-MIRROR tables (migration 087, store.ts). This is the ONLY module that
 * turns the on-disk artifacts into mirror rows.
 *
 * DOCTRINE (do not violate):
 *   • The FILES are the single source of truth. This module NEVER writes a
 *     canonical artifact — it only READS
 *       - <workspace>/.workforce-build-state.json      (progress / decisions)
 *       - <workspace>/company-discovery/workforce-interview-answers.md (Q/A)
 *       - <workspace>/company-discovery/interview-handoff.md           (resume)
 *     and copies their derived, UI-facing shape into the mirror tables. It does
 *     NOT execFile any Skill-23 script (no update-interview-state.sh /
 *     record-dept-decision.sh / list-canonical-departments.py) — pure fs reads.
 *   • The mirror is NEVER a write authority for interviewComplete or for
 *     canonicalReconciliation.decisions and it NEVER gates anything. If the
 *     mirror and the files ever disagree, the FILES WIN — this module reconciles
 *     the mirror FROM the files, never the reverse.
 *   • Every entry point is BEST-EFFORT and NEVER throws: a mirror failure
 *     (DB locked, malformed transcript, missing table) is swallowed and reported
 *     in the return value, so a failure to mirror can never fail the request that
 *     triggered it. Callers may additionally wrap in try/catch; they don't need to.
 *
 * Idempotency: answers are keyed by (session_id, question_number) where
 * question_number is the 1-based POSITIONAL index of the Q/A block in the
 * transcript. The transcript is append-only (build-workforce.log_answer appends;
 * SKILL.md inline edits rewrite an answer IN PLACE within the same block, never
 * reorder), so a block's positional index is stable and re-running the sync
 * upserts the same rows instead of duplicating them. Stale rows beyond the
 * current block count are pruned so the mirror stays an exact reflection.
 */

import fs from 'fs';
import {
  readBuildState,
  readTranscriptText,
  readHandoff,
  readInterviewProgress,
  derivedPercent,
  type BuildState,
} from './seam';
import { mirrorSession, type UpsertAnswerInput } from './store';

/** One parsed Q/A block from workforce-interview-answers.md. */
interface ParsedBlock {
  question: string;
  answer: string;
  provenance: string | null;
}

/** Outcome of a best-effort mirror refresh. Never a thrown error. */
export interface MirrorRefreshResult {
  ok: boolean;
  /** Set when the refresh was intentionally a no-op (e.g. no stable session id). */
  skipped?: string;
  /** The session id the rows were keyed on (present on a successful sync). */
  sessionId?: string;
  /** How many Q/A blocks were mirrored. */
  answersMirrored?: number;
  /** Present only on a swallowed failure. */
  error?: string;
}

export interface RefreshMirrorOptions {
  /**
   * Pin the mirror to a specific session id (the write paths pass the stable
   * interviewSessionId here). When omitted, the id is read READ-ONLY from
   * build-state; if none exists yet the refresh is a no-op (never creates one —
   * this module performs no canonical writes).
   */
  sessionId?: string | null;
  /** Optional client id to stamp on the session mirror row. */
  clientId?: string | null;
  /** Optional owner id (e.g. the decidedBy / askedBy) to stamp on the row. */
  ownerId?: string | null;
}

/**
 * Split the transcript into Q/A blocks and extract question / answer / any
 * provenance note. The header chunk (no `**Q:**`) is skipped. Answers may span
 * multiple lines; capture stops at the next `**Provenance:**` / `**Logged:**` /
 * `**Updated:**` marker or the end of the block.
 */
export function parseAnswerBlocks(text: string): ParsedBlock[] {
  if (!text) return [];
  const chunks = text.split(/\n\s*-{3,}\s*\n/);
  const blocks: ParsedBlock[] = [];

  for (const chunk of chunks) {
    const qMatch = chunk.match(/\*\*Q:\*\*\s*([\s\S]*?)(?=\n\*\*A:\*\*)/);
    const aMatch = chunk.match(
      /\*\*A:\*\*\s*([\s\S]*?)(?=\n\*\*(?:Provenance|Logged|Updated)\b|$)/,
    );
    if (!qMatch || !aMatch) continue;

    const question = qMatch[1].trim();
    if (!question) continue;
    const answer = aMatch[1].trim();

    // Provenance: an explicit **Provenance:** note (confirmed-from-context) and/or
    // any "Updated on … previous answer was …" inline-edit note (SKILL.md).
    const provParts: string[] = [];
    const provMatch = chunk.match(
      /\*\*Provenance:\*\*\s*([\s\S]*?)(?=\n\*\*(?:Logged|Updated)\b|$)/,
    );
    if (provMatch && provMatch[1].trim()) provParts.push(provMatch[1].trim());
    const updatedMatch = chunk.match(/Updated on[^\n]*previous answer was[^\n]*/i);
    if (updatedMatch) provParts.push(updatedMatch[0].trim());
    const provenance = provParts.length ? provParts.join(' | ') : null;

    blocks.push({ question, answer, provenance });
  }

  return blocks;
}

/** Read the transcript text at its resolved path, '' on absence / read error.
 *  U048: reads through the encrypted store (readTranscriptText). */
function readAnswersText(buildState: BuildState | null): string {
  const { text, exists } = readTranscriptText(buildState);
  return exists ? text : '';
}

/**
 * Best-effort refresh of the interview mirror FROM the canonical files. Reads
 * build-state + the transcript + handoff (pure fs, no scripts), then upserts one
 * session row and one row per Q/A block, pruning any stale rows so the mirror
 * exactly reflects the file. NEVER throws — returns a result describing what
 * happened (ok / skipped / error). Safe to call on every state read and every
 * answer/decision write.
 */
export function refreshInterviewMirror(
  opts: RefreshMirrorOptions = {},
): MirrorRefreshResult {
  try {
    const buildState = readBuildState();

    // Resolve the session key. Prefer an explicit id (write paths pass the stable
    // interviewSessionId); otherwise read it READ-ONLY from build-state. We never
    // mint or persist one here — that would be a canonical write.
    const sessionId =
      (opts.sessionId && opts.sessionId.trim()) ||
      (buildState?.interviewSessionId && String(buildState.interviewSessionId).trim()) ||
      '';
    if (!sessionId) {
      return { ok: true, skipped: 'no-session-id' };
    }

    const progress = readInterviewProgress(buildState);
    const handoff = readHandoff();
    const blocks = parseAnswerBlocks(readAnswersText(buildState));

    // Derive the UI-facing (non-authoritative) session mirror fields.
    const lastQuestionNumber =
      (typeof progress.lastQuestionNumber === 'number' ? progress.lastQuestionNumber : null) ??
      handoff.lastQuestionNumber ??
      (blocks.length > 0 ? blocks.length : null);
    const status = buildState?.interviewComplete === true ? 'complete' : 'in_progress';
    const phase =
      (typeof progress.lastQuestionPhase === 'string' ? progress.lastQuestionPhase : null) ??
      null;

    // One answer row per block, keyed by 1-based positional index (idempotent).
    const answers: UpsertAnswerInput[] = blocks.map((b, i) => ({
      sessionId,
      questionNumber: i + 1,
      phase: null,
      question: b.question,
      answer: b.answer,
      provenance: b.provenance,
      askedBy: null,
    }));

    mirrorSession(
      {
        id: sessionId,
        clientId: opts.clientId ?? null,
        ownerId: opts.ownerId ?? null,
        channel: 'web',
        status,
        phase,
        lastQuestionNumber,
        percent: derivedPercent(lastQuestionNumber),
      },
      answers,
      { pruneToAnswers: true },
    );

    return { ok: true, sessionId, answersMirrored: answers.length };
  } catch (err) {
    // Swallow: a mirror failure must NEVER surface to the request that triggered it.
    return { ok: false, error: err instanceof Error ? err.message : 'mirror refresh failed' };
  }
}
