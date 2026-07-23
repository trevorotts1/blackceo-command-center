/**
 * Interview seam — the single server-side module every /api/interview/* route
 * uses to talk to the Skill-23 interview brain's file/state layer (P0-1).
 *
 * DOCTRINE (do not violate):
 *   • Files are the single source of truth. The three canonical artifacts
 *       - <workspace>/.workforce-build-state.json
 *       - <workspace>/company-discovery/workforce-interview-answers.md
 *       - <workspace>/company-discovery/interview-handoff.md
 *     are written ONLY through the Skill-23 shell scripts (update-interview-state.sh,
 *     record-dept-decision.sh). This module NEVER hand-writes interviewComplete
 *     and NEVER hand-writes a decision — those go exclusively through the scripts,
 *     so every anti-fabrication / provenance gate is inherited for free.
 *   • The ONLY thing this module ever writes to build-state directly is a benign,
 *     idempotent `interviewSessionId` string (added only if absent, via an atomic
 *     temp+rename that preserves every other field). It touches NO gate field.
 *   • Decline / coverage semantics MUST match the Python enforcers
 *     (build-workforce._canonical_decline_set, department-floor._norm). The
 *     expected canonical set is obtained by SHELLING to
 *     list-canonical-departments.py (never a hardcoded 28/29), so the floor can
 *     never drift; only the small, well-specified provenance + norm() checks are
 *     mirrored in TS here and are covered by the P3-7 shared-fixture parity test.
 *
 * Nothing in the read/parse layer throws — absent/garbage files degrade to a
 * null / empty-but-typed result. The execFile wrappers reject with a typed
 * InterviewScriptError carrying the real exit code and captured stderr/stdout.
 */

import { execFile } from 'child_process';
import fs from 'fs';
import { randomUUID } from 'crypto';
import path from 'path';
import { promisify } from 'util';
import {
  answersFilePath,
  buildStatePath,
  handoffFilePath,
  listCanonicalDepartmentsScript,
  recordDeptDecisionScript,
  scriptExists,
  updateInterviewStateScript,
  verticalDerivationGuardScript,
} from './paths';

const execFileAsync = promisify(execFile);

const SCRIPT_TIMEOUT_MS = 30_000;

/** U049: Single canonical current schema version for .workforce-build-state.json.
 *  Version 1 = every file that exists today with no `schemaVersion` field.
 *  Version 2 = adds `schemaVersion`, normalizes `interviewComplete` to strict
 *  boolean, and ensures core structure keys exist with safe defaults. */
export const WORKFORCE_BUILD_STATE_SCHEMA_VERSION = 2;


/** Header build_from_config() stamps on a SYNTHETIC (non-interactive) transcript.
 *  Its presence means the file is fabricated and does NOT count as a genuine
 *  interview (mirrors build-workforce.NON_INTERACTIVE_ANSWERS_HEADER). */
const NON_INTERACTIVE_ANSWERS_HEADER = '# Workforce Interview Answers (Non-Interactive)';

/* ────────────────────────────── Types ─────────────────────────────────────── */

/** A provenanced owner decision object, exactly as record-dept-decision.sh writes it. */
export interface DecisionObject {
  decision: 'yes' | 'no' | 'later';
  source: string;
  decidedAt: string;
  decidedBy: string;
  sessionId?: string;
}

/** A raw decisions map value can be the object form OR a legacy bare string. */
export type RawDecision = DecisionObject | string;

export interface InterviewProgress {
  lastQuestionNumber?: number | null;
  lastQuestionPhase?: string | null;
  lastQuestionAskedBy?: string | null;
  lastQuestionAt?: string | null;
  phasesComplete?: string[];
  status?: string | null;
  answersFilePath?: string | null;
  [k: string]: unknown;
}

export interface InterviewQc {
  status?: 'pending' | 'pass' | 'needs-review' | 'fail' | string;
  [k: string]: unknown;
}

export interface CanonicalReconciliation {
  decisions?: Record<string, RawDecision>;
  ownerDeclineConfirmed?: boolean;
  [k: string]: unknown;
}

/** One detected vertical pack, exactly as build-workforce.py's
 *  apply_vertical_packs()/_write_vertical_pack_record() writes it. */
export interface VerticalPackEntry {
  pack: string;
  matchedKeywords?: string[];
  [k: string]: unknown;
}

/** The `verticalPacks` build-state block U107's guard reads as the
 *  authoritative "what did the interview declare" record. */
export interface VerticalPacksRecord {
  detectedPacks?: VerticalPackEntry[];
  [k: string]: unknown;
}

export interface BuildState {
  /** U049: Schema version for .workforce-build-state.json. Defaults to 1 when absent. */
  schemaVersion?: number;
  interviewComplete?: boolean;
  interviewCompletedAt?: string;
  interviewSessionId?: string;
  interviewProgress?: InterviewProgress;
  interviewQc?: InterviewQc;
  canonicalReconciliation?: CanonicalReconciliation;
  buildCompletedAt?: string;
  /** U107 (E5-2, closes G2a): the interview-derived vertical packs record —
   *  written by build-workforce.py's apply_vertical_packs(), read here (never
   *  hand-written) as the sole "declared" signal for the CC-side derivation
   *  guard in src/lib/routing/departments.config.ts. */
  verticalPacks?: VerticalPacksRecord;
  [k: string]: unknown;
}

/** Parsed handoff frontmatter (the resume + progress contract). */
export interface HandoffInfo {
  exists: boolean;
  path: string;
  status: string | null;
  nextQuestionNumber: number | null;
  lastQuestionNumber: number | null;
  totalQuestionsAnswered: number | null;
  totalQuestionsEstimated: number | null;
  skippedQuestions: number[];
  startedDate: string | null;
  lastUpdated: string | null;
}

/** Structural facts about the answers transcript (gate #2 inputs). */
export interface AnswersInfo {
  exists: boolean;
  path: string;
  sizeBytes: number;
  qBlockCount: number;
  hasSyntheticHeader: boolean;
  /** genuine = !synthetic && qBlockCount >= 3 && sizeBytes > 512
   *  (byte-for-byte the build-workforce._genuine_interview_answers_file rule). */
  genuine: boolean;
}

export interface CanonicalDepartmentEntry {
  id: string;
  display_name: string;
  one_liner: string;
  pack?: string;
}

export interface CanonicalDepartments {
  source: string;
  naming_map_version: string;
  mandatory_count: number;
  mandatory: CanonicalDepartmentEntry[];
  universal_primary_count: number;
  universal_primary_vertical: CanonicalDepartmentEntry[];
  floor: number;
}

/** Result of comparing the expected decision set against recorded decisions. */
export interface DecisionCoverage {
  /** true only when every expected id carries a provenanced decision. */
  complete: boolean;
  /** expected dept ids (canonical + customs, minus implicit-YES customs). */
  expected: string[];
  /** expected ids that carry a provenanced decision object. */
  covered: string[];
  /** expected ids with NO provenanced decision yet (block the Build button). */
  missing: string[];
  /** un-provenanced declines — a "no" the enforcer would REJECT (gate #8).
   *  Empty on the UI path (all writes go through record-dept-decision.sh). */
  rejections: string[];
  /** ids the client explicitly + provenance-declined (honored "no"). */
  declined: string[];
}

export interface GateFlags {
  genuineTranscriptReady: boolean;
  decisionCoverageComplete: boolean;
  noUnprovenancedDeclines: boolean;
}

/** Typed error surfaced when a Skill-23 script exits non-zero. */
export class InterviewScriptError extends Error {
  readonly script: string;
  readonly exitCode: number | null;
  readonly stderr: string;
  readonly stdout: string;
  constructor(script: string, exitCode: number | null, stderr: string, stdout: string) {
    super(
      `${script} exited ${exitCode ?? 'null'}${stderr ? `: ${stderr.trim().split('\n').slice(-1)[0]}` : ''}`,
    );
    this.name = 'InterviewScriptError';
    this.script = script;
    this.exitCode = exitCode;
    this.stderr = stderr;
    this.stdout = stdout;
  }
}

/** Thrown when a required Skill-23 script is not installed on the box. */
export class InterviewScriptMissingError extends Error {
  readonly script: string;
  constructor(script: string) {
    super(`Skill-23 script not found on this box: ${script}`);
    this.name = 'InterviewScriptMissingError';
    this.script = script;
  }
}

/* ───────────────────────────── Read / parse ────────────────────────────────── */

/**
 * U049: Versioned read + parse of .workforce-build-state.json.
 *
 * Behaviour:
 *   - Missing file -> null (caller treats as empty).
 *   - Unparseable / corrupted JSON -> quarantines the file to
 *     .workforce-build-state.json.corrupt-<unixTs> and returns null.
 *   - Missing `schemaVersion` -> treated as version 1 and migrated to current.
 *   - `schemaVersion` > current -> returns null (refuses to parse a newer file
 *     with an older reader; prints the mismatch to stderr).
 *   - `schemaVersion` < current -> runs the migration transform to current,
 *     then proceeds. The migrated state is re-stamped on the NEXT write
 *     (the read path never auto-writes).
 */
export function readBuildState(): BuildState | null {
  const p = buildStatePath();
  let raw: string;
  try {
    if (!fs.existsSync(p)) return null;
    raw = fs.readFileSync(p, 'utf-8');
  } catch {
    return null;
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    // U049: Corrupted/unparseable JSON -> quarantine, never treat as empty.
    try {
      const corruptPath = `${p}.corrupt-${Math.floor(Date.now() / 1000)}`;
      fs.renameSync(p, corruptPath);
      console.error(
        `[build-state] CORRUPT JSON detected - quarantined ${p} -> ${corruptPath}. ` +
          `Emit a fresh build-state from Skill-23 scripts or restore from backup.`,
      );
    } catch {
      // Best-effort quarantine; if rename fails we still refuse to return data.
    }
    return null;
  }

  // Version detection: absent -> v1. Greater than current -> refuse.
  const fileVersion =
    typeof parsed.schemaVersion === 'number'
      ? parsed.schemaVersion
      : 1;

  if (fileVersion > WORKFORCE_BUILD_STATE_SCHEMA_VERSION) {
    console.error(
      `[build-state] REFUSING to parse ${p}: file schemaVersion=${fileVersion} > ` +
        `reader current=${WORKFORCE_BUILD_STATE_SCHEMA_VERSION}. ` +
        `Upgrade your reader or downgrade the file.`,
    );
    return null;
  }

  // Migrate from older versions to current.
  let state = parsed as unknown as BuildState;
  if (fileVersion < WORKFORCE_BUILD_STATE_SCHEMA_VERSION) {
    state = migrateBuildState(state, fileVersion, WORKFORCE_BUILD_STATE_SCHEMA_VERSION);
  }

  return state;
}

/**
 * U049: Migrate build-state from `fromVersion` to `toVersion`.
 *
 * v1 -> v2 transform (additive/normalizing):
 *   1. Stamp `schemaVersion: 2`.
 *   2. Normalize `interviewComplete` to strict boolean (truthy -> true,
 *      falsy/missing -> false). Pre-v2 files sometimes carried a string "true".
 *   3. Ensure `interviewProgress` exists (falls back to {}).
 *   4. Ensure `canonicalReconciliation` exists with a `decisions` map
 *      (falls back to { decisions: {} }).
 *   5. Ensure `interviewSessionId` is a string when present (coerce to
 *      String; drop null/undefined).
 */
export function migrateBuildState(
  state: BuildState,
  fromVersion: number,
  toVersion: number,
): BuildState {
  let s = { ...state };
  for (let v = fromVersion; v < toVersion; v++) {
    switch (v) {
      case 1:
        s = migrateV1toV2(s);
        break;
    }
  }
  s.schemaVersion = toVersion;
  return s;
}

/** v1 -> v2 migration steps. See `migrateBuildState` for field documentation. */
function migrateV1toV2(s: BuildState): BuildState {
  const out: BuildState = { ...s };

  // 1. Normalize interviewComplete to strict boolean.
  out.interviewComplete = s.interviewComplete === true || s.interviewComplete === ('true' as unknown)
    ? true
    : false;

  // 2. Ensure interviewProgress exists with safe defaults.
  if (!out.interviewProgress || typeof out.interviewProgress !== 'object') {
    out.interviewProgress = {};
  }

  // 3. Ensure canonicalReconciliation block exists.
  if (!out.canonicalReconciliation || typeof out.canonicalReconciliation !== 'object') {
    out.canonicalReconciliation = { decisions: {} };
  }
  if (!out.canonicalReconciliation.decisions || typeof out.canonicalReconciliation.decisions !== 'object') {
    out.canonicalReconciliation = { ...out.canonicalReconciliation, decisions: {} };
  }

  // 4. Coerce interviewSessionId to string or drop it.
  const sid = (out as Record<string, unknown>).interviewSessionId;
  if (sid !== undefined && sid !== null) {
    (out as Record<string, unknown>).interviewSessionId = String(sid);
  }

  // 5. Stamp version.
  out.schemaVersion = 2;

  return out;
}
}

/** Convenience: interviewProgress (or empty object) from the live build-state. */
export function readInterviewProgress(state?: BuildState | null): InterviewProgress {
  const s = state ?? readBuildState();
  return (s?.interviewProgress ?? {}) as InterviewProgress;
}

/** Convenience: interviewQc.status ('pending' when unknown). */
export function readInterviewQcStatus(state?: BuildState | null): string {
  const s = state ?? readBuildState();
  return (s?.interviewQc?.status as string) || 'pending';
}

/**
 * U107 (E5-2, closes G2a): the interview-declared vertical pack ids, read
 * SYNCHRONOUSLY and directly from build-state — no re-derivation, no keyword
 * matching here. Mirrors vertical-derivation-guard.py's
 * declared_packs_from_build_state() reading of `verticalPacks.detectedPacks`
 * (the record build-workforce.py's apply_vertical_packs() already writes).
 *
 * Absence of a record is NOT the same as an explicit empty record, but both
 * degrade to the same result here: an empty declared set. Per the guard's own
 * "FAIL CLOSED" doctrine (absence of information is never permission), a
 * missing/garbage build-state file never grants an implicit vertical.
 */
export function declaredVerticalPacks(state?: BuildState | null): string[] {
  const s = state ?? readBuildState();
  const detected = s?.verticalPacks?.detectedPacks;
  if (!Array.isArray(detected)) return [];
  const packs = new Set<string>();
  for (const entry of detected) {
    const pack = entry && typeof entry === 'object' ? (entry as VerticalPackEntry).pack : undefined;
    if (typeof pack === 'string' && pack.trim()) packs.add(pack.trim());
  }
  return Array.from(packs);
}

/**
 * Parse a single `key: value` line out of the handoff markdown, mirroring the
 * nudge worker's `re.search(rf"^\s*{key}\s*:\s*(.+)$", MULTILINE)` contract so
 * the web path and the Python nudge builder read handoff frontmatter identically.
 */
function matchFrontmatter(content: string, key: string): string | null {
  const re = new RegExp(`^\\s*${key}\\s*:\\s*(.+)$`, 'm');
  const m = re.exec(content);
  return m ? m[1].trim() : null;
}

function toInt(v: string | null): number | null {
  if (v == null) return null;
  const n = parseInt(v.replace(/[^0-9-]/g, ''), 10);
  return Number.isFinite(n) ? n : null;
}

/** Parse a `[1, 2, 3]` / `1,2,3` style list into a number[] (question numbers). */
function parseSkipped(v: string | null): number[] {
  if (!v) return [];
  return v
    .replace(/^\[|\]$/g, '')
    .split(',')
    .map((s) => parseInt(s.replace(/[^0-9-]/g, ''), 10))
    .filter((n) => Number.isFinite(n));
}

/** Read + parse interview-handoff.md frontmatter. Never throws. */
export function readHandoff(): HandoffInfo {
  const p = handoffFilePath();
  const base: HandoffInfo = {
    exists: false,
    path: p,
    status: null,
    nextQuestionNumber: null,
    lastQuestionNumber: null,
    totalQuestionsAnswered: null,
    totalQuestionsEstimated: null,
    skippedQuestions: [],
    startedDate: null,
    lastUpdated: null,
  };
  let content = '';
  try {
    if (!fs.existsSync(p)) return base;
    content = fs.readFileSync(p, 'utf-8');
  } catch {
    return base;
  }
  return {
    ...base,
    exists: true,
    status: matchFrontmatter(content, 'status'),
    nextQuestionNumber: toInt(matchFrontmatter(content, 'next_question_number')),
    lastQuestionNumber: toInt(matchFrontmatter(content, 'last_question_number')),
    totalQuestionsAnswered: toInt(matchFrontmatter(content, 'total_questions_answered')),
    totalQuestionsEstimated: toInt(matchFrontmatter(content, 'total_questions_estimated')),
    skippedQuestions: parseSkipped(matchFrontmatter(content, 'skipped_questions')),
    startedDate: matchFrontmatter(content, 'started_date'),
    lastUpdated: matchFrontmatter(content, 'last_updated'),
  };
}

/**
 * Inspect the answers transcript for the gate-#2 (anti-fabrication) signals.
 * Q-block count = lines whose trimmed form startsWith "**Q:**" — the EXACT
 * predicate build-workforce._genuine_interview_answers_file uses. `genuine`
 * reproduces its full rule (no synthetic header, >=3 blocks, >512 bytes).
 */
export function readAnswers(state?: BuildState | null): AnswersInfo {
  const recorded = readInterviewProgress(state).answersFilePath;
  const p = answersFilePath(recorded);
  const base: AnswersInfo = {
    exists: false,
    path: p,
    sizeBytes: 0,
    qBlockCount: 0,
    hasSyntheticHeader: false,
    genuine: false,
  };
  let text = '';
  let size = 0;
  try {
    if (!fs.existsSync(p)) return base;
    size = fs.statSync(p).size;
    text = fs.readFileSync(p, 'utf-8');
  } catch {
    return base;
  }
  const hasSyntheticHeader = text.includes(NON_INTERACTIVE_ANSWERS_HEADER);
  const qBlockCount = text
    .split('\n')
    .filter((ln) => ln.trim().startsWith('**Q:**')).length;
  const genuine = !hasSyntheticHeader && qBlockCount >= 3 && size > 512;
  return { exists: true, path: p, sizeBytes: size, qBlockCount, hasSyntheticHeader, genuine };
}

/** One parsed Q/A block from workforce-interview-answers.md, content-level. */
export interface AnswerBlock {
  /** The question text exactly as it was asked (verbatim). */
  question: string;
  /** The current answer text (may span multiple lines). */
  answer: string;
  /** Any provenance note on the block (confirmed-from-context / updated-on), joined. */
  provenance: string | null;
  /** The `**Logged:** …` human timestamp, when the block carries one. */
  loggedAt: string | null;
}

/**
 * Split the transcript into content-level Q/A blocks. This is the READ-ONLY
 * content reader the review surface uses; it is intentionally a sibling of (not a
 * dependency on) mirror.parseAnswerBlocks — the seam is the lower layer and must
 * not import the mirror. The Q/A/Provenance capture is byte-identical to the
 * mirror's parser so the two never drift; this reader additionally captures the
 * `**Logged:**` stamp. The header chunk (no `**Q:**`) is skipped. Never throws.
 */
export function parseAnswerBlocks(text: string): AnswerBlock[] {
  if (!text) return [];
  const chunks = text.split(/\n\s*-{3,}\s*\n/);
  const blocks: AnswerBlock[] = [];

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

    const loggedMatch = chunk.match(/\*\*Logged:\*\*\s*([^\n]+)/);
    const loggedAt = loggedMatch && loggedMatch[1].trim() ? loggedMatch[1].trim() : null;

    blocks.push({ question, answer, provenance, loggedAt });
  }

  return blocks;
}

/**
 * READ-ONLY: read the resolved transcript file and parse its Q/A blocks. Returns
 * an empty array on absence / read error (never throws). This is the reader the
 * /api/interview/answers route uses to render the review read-back — it performs
 * no writes and shells to no Skill-23 script.
 */
export function readAnswerBlocks(state?: BuildState | null): AnswerBlock[] {
  const info = readAnswers(state);
  if (!info.exists) return [];
  try {
    return parseAnswerBlocks(fs.readFileSync(info.path, 'utf-8'));
  } catch {
    return [];
  }
}

/**
 * READ-ONLY: extract the agent's plain-English synthesis / read-back paragraph
 * from interview-handoff.md, when present. Probes (in order):
 *   1. a single-line `synthesis:` frontmatter value, then
 *   2. the body under a heading whose text starts with synthesis / summary /
 *      read-back / "what we heard" / "about you", captured until the next
 *      heading or `---` rule.
 * Returns null when the handoff is absent or carries no synthesis. Never throws.
 */
export function readInterviewSynthesis(): string | null {
  const p = handoffFilePath();
  let content = '';
  try {
    if (!fs.existsSync(p)) return null;
    content = fs.readFileSync(p, 'utf-8');
  } catch {
    return null;
  }

  const fm = matchFrontmatter(content, 'synthesis');
  if (fm && fm.trim()) return fm.trim();

  const lines = content.split('\n');
  const headingRe = /^#{1,6}\s*(synthesis|summary|read[-\s]?back|what we heard|about you)\b/i;
  for (let i = 0; i < lines.length; i++) {
    if (!headingRe.test(lines[i].trim())) continue;
    const body: string[] = [];
    for (let j = i + 1; j < lines.length; j++) {
      const ln = lines[j];
      const t = ln.trim();
      if (/^#{1,6}\s/.test(t)) break; // next heading
      if (/^-{3,}\s*$/.test(t)) break; // horizontal rule
      body.push(ln);
    }
    const text = body.join('\n').trim();
    if (text) return text;
  }
  return null;
}

/* ────────────────────────── Session id (benign write) ──────────────────────── */

/**
 * Return a STABLE interviewSessionId, generating + persisting one into build-state
 * on first call so record-dept-decision.sh --session always has a non-empty value
 * with zero DB dependency.
 *
 * This is the ONLY direct build-state write in the seam. It:
 *   • adds `interviewSessionId` ONLY when absent (idempotent — never rotates it),
 *   • preserves every other field (read-modify-write of the parsed object),
 *   • writes atomically (temp file + rename) so it can never corrupt a
 *     concurrent script write mid-flight,
 *   • touches NO gate field (interviewComplete / decisions / interviewQc).
 *
 * If build-state is missing or unwritable it falls back to an in-memory UUID so a
 * decision write still carries a session id (the script re-checks provenance).
 */
export function getOrCreateInterviewSessionId(): string {
  const state = readBuildState();
  const existing = state?.interviewSessionId;
  if (existing && String(existing).trim()) return String(existing);

  const sessionId = randomUUID();
  const p = buildStatePath();
  try {
    // Re-read raw to preserve exact bytes/fields we don't model in BuildState.
    const raw = JSON.parse(fs.readFileSync(p, 'utf-8')) as Record<string, unknown>;
    if (raw.interviewSessionId && String(raw.interviewSessionId).trim()) {
      return String(raw.interviewSessionId); // set by a concurrent writer
    }
    raw.interviewSessionId = sessionId;
    // U049: Stamp the current schema version on every write.
    raw.schemaVersion = WORKFORCE_BUILD_STATE_SCHEMA_VERSION;
    const tmp = `${p}.ts.tmp.${process.pid}.${Date.now()}`;
    fs.writeFileSync(tmp, `${JSON.stringify(raw, null, 2)}\n`, 'utf-8');
    fs.renameSync(tmp, p);
  } catch {
    // Non-fatal: return the generated id anyway (better a live decision write
    // with a fresh id than a dropped decline). Persistence retries next call.
  }
  return sessionId;
}

/* ─────────────────────────── execFile wrappers ─────────────────────────────── */

async function runScript(
  script: string,
  runner: 'bash' | 'python3',
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  if (!scriptExists(script)) throw new InterviewScriptMissingError(script);
  try {
    const { stdout, stderr } = await execFileAsync(runner, [script, ...args], {
      encoding: 'utf-8',
      timeout: SCRIPT_TIMEOUT_MS,
      maxBuffer: 8 * 1024 * 1024,
    });
    return { stdout: stdout ?? '', stderr: stderr ?? '' };
  } catch (err) {
    // execFile rejects with an Error augmented with code/stderr/stdout on non-zero.
    const e = err as NodeJS.ErrnoException & {
      code?: number | string;
      stderr?: string;
      stdout?: string;
    };
    const exitCode = typeof e.code === 'number' ? e.code : null;
    throw new InterviewScriptError(script, exitCode, e.stderr ?? '', e.stdout ?? '');
  }
}

export interface UpdateInterviewStateArgs {
  phase?: string;
  questionNumber?: number;
  askedBy?: string;
  phasesComplete?: string[];
  /** true → runs `--complete` (marks interviewComplete + seeds gates + auto-QC). */
  complete?: boolean;
}

/**
 * execFile update-interview-state.sh with exactly the flags the Telegram agent
 * presses. Non-zero exit → InterviewScriptError (carries exitCode so callers can
 * branch on 87/88/2/3). Returns the script's stdout/stderr for logging.
 *
 * NOTE: `--complete` is the SAME button the agent presses; the script (not this
 * wrapper) owns setting interviewComplete, auto-running qc-interview-completion.py,
 * and firing the single [WORKFORCE-RESUME] kick ONLY when interviewQc.status==pass.
 * This wrapper adds no trigger path and never hand-writes interviewComplete.
 */
export async function updateInterviewState(
  args: UpdateInterviewStateArgs,
): Promise<{ stdout: string; stderr: string }> {
  const argv: string[] = [];
  if (args.phase) argv.push('--phase', args.phase);
  if (typeof args.questionNumber === 'number') {
    argv.push('--question-number', String(args.questionNumber));
  }
  if (args.askedBy) argv.push('--asked-by', args.askedBy);
  if (args.phasesComplete && args.phasesComplete.length) {
    argv.push('--phases-complete', args.phasesComplete.join(','));
  }
  if (args.complete) argv.push('--complete');
  return runScript(updateInterviewStateScript(), 'bash', argv);
}

export interface RecordDeptDecisionArgs {
  dept: string;
  decision: 'yes' | 'no' | 'later';
  /** ownerId — REQUIRED and non-empty; an empty decidedBy makes a "no" unhonored. */
  by: string;
  session?: string;
  source?: string;
}

/**
 * execFile record-dept-decision.sh — the ONLY sanctioned decision writer. Writes
 * the provenanced object {decision,source,decidedAt,decidedBy,sessionId}. When
 * `session` is omitted, the stable interviewSessionId is resolved/persisted.
 *
 * Rejects an empty `by` up front (the script also enforces this; we fail fast so a
 * decline can never be recorded in an un-honorable shape). Unknown/invalid dept or
 * decision surfaces as InterviewScriptError (exit 1) for the route to map to 400.
 */
export async function recordDeptDecision(
  args: RecordDeptDecisionArgs,
): Promise<{ stdout: string; stderr: string }> {
  const by = (args.by ?? '').trim();
  if (!by) {
    throw new InterviewScriptError(
      recordDeptDecisionScript(),
      1,
      'refusing to record a decision with an empty --by (decidedBy): a "no" with empty ' +
        'provenance is IGNORED by the build enforcer and the dept is force-added back.',
      '',
    );
  }
  const session = (args.session && args.session.trim()) || getOrCreateInterviewSessionId();
  const argv = [
    '--dept',
    args.dept,
    '--decision',
    args.decision,
    '--source',
    args.source || 'owner-interview',
    '--by',
    by,
    '--session',
    session,
    // Pin the writer to the EXACT file paths.ts resolves. record-dept-decision.sh
    // supports --state; in production (no OPENCLAW_WORKSPACE_ROOT override) this
    // equals the script's own /data-else-$HOME resolution, so it is a no-op there —
    // but it guarantees the decision lands in the same file the app reads and makes
    // the write path testable in isolation. (update-interview-state.sh has no --state
    // flag, so it always uses its own /data-else-$HOME resolution.)
    '--state',
    buildStatePath(),
  ];
  return runScript(recordDeptDecisionScript(), 'bash', argv);
}

/**
 * Proxy list-canonical-departments.py --json at runtime → the LIVE floor. NEVER
 * hardcode 28/29 — the count is version-dependent. Exit 1 (missing/broken naming
 * map) surfaces as InterviewScriptError.
 */
export async function listCanonicalDepartments(): Promise<CanonicalDepartments> {
  const { stdout } = await runScript(listCanonicalDepartmentsScript(), 'python3', ['--json']);
  return JSON.parse(stdout) as CanonicalDepartments;
}

/** Shape of vertical-derivation-guard.py --check-add --json's stdout. */
interface CheckAddResult {
  deptId: string;
  declaredPacks: string[];
  allowed: boolean;
  error: string | null;
}

/**
 * U107 (E5-2, closes G2a) REFUSAL primitive: proxy vertical-derivation-guard.py
 * --check-add DEPT_ID --declared <packs> --json at runtime. This is the LIVE,
 * independently-shelled verdict — the same authority
 * departments.config.ts's synchronous checkAddDepartmentSync() mirrors so the
 * hot fallback path never blocks on a subprocess. A drift between the two is
 * exactly what the parity fixture (src/lib/routing/__fixtures__/vertical-derivation)
 * exists to catch.
 *
 * FAIL CLOSED: any failure to resolve/run the script (missing on this box,
 * non-zero exit with unparseable stdout, timeout) returns refused with a named
 * VERTICAL_NOT_DECLARED error — never silently allows an add this module
 * could not verify.
 */
export async function checkAddDepartment(
  deptId: string,
  declaredPacks?: string[],
): Promise<{ allowed: boolean; error: string | null }> {
  const packs = declaredPacks ?? declaredVerticalPacks();
  const argv = ['--check-add', deptId, '--declared', packs.join(','), '--json'];
  try {
    const { stdout } = await runScript(verticalDerivationGuardScript(), 'python3', argv);
    const parsed = JSON.parse(stdout) as CheckAddResult;
    return { allowed: parsed.allowed, error: parsed.error };
  } catch (err) {
    // check_add() exits 1 (refused) with --json output still on stdout — the
    // script prints its verdict on BOTH exit codes. Recover the real verdict
    // when present rather than treating a refusal as a script failure.
    if (err instanceof InterviewScriptError && err.stdout) {
      try {
        const parsed = JSON.parse(err.stdout) as CheckAddResult;
        return { allowed: parsed.allowed, error: parsed.error };
      } catch {
        // fall through to fail-closed below
      }
    }
    const reason = err instanceof Error ? err.message : String(err);
    return {
      allowed: false,
      error: `VERTICAL_NOT_DECLARED: could not evaluate '${deptId}' — guard unavailable or failed (${reason}). Fail-closed.`,
    };
  }
}

/* ───────────────── Decline / coverage semantics (mirror the Python) ─────────── */

/**
 * Normalize a slug for membership comparison. EXACT mirror of
 * department-floor.py `_norm`: `re.sub(r"[^a-z0-9]", "", s.lower())`
 * (lowercase, then strip everything that is not a-z0-9). Keep byte-identical
 * with the Python — a divergence here is a coverage-gate drift.
 */
export function norm(s: string): string {
  return String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Is this decisions[] value a fully-provenanced object? Mirrors
 * build-workforce._canonical_decline_set's required tuple exactly:
 * decision / source / decidedAt / decidedBy all present AND truthy. (sessionId
 * is written by the script but NOT required by the enforcer.)
 */
export function isProvenanced(d: RawDecision | undefined | null): d is DecisionObject {
  if (!d || typeof d !== 'object') return false;
  const o = d as unknown as Record<string, unknown>;
  return (['decision', 'source', 'decidedAt', 'decidedBy'] as const).every(
    (k) => !!o[k] && String(o[k]).trim() !== '',
  );
}

/** Lowercased decision verb of a raw value ('yes' | 'no' | 'later' | other). */
function decisionVerb(d: RawDecision): string {
  if (typeof d === 'object' && d) return String((d as DecisionObject).decision ?? '').trim().toLowerCase();
  return String(d).trim().toLowerCase();
}

/**
 * Compute the expected decision-id set. Mirrors the plan's
 * `_expected_decision_ids`: canonical floor (mandatory + universal-primary) ∪
 * custom dept ids, MINUS configured customs treated as implicit-YES.
 *
 * @param canonical  result of listCanonicalDepartments()
 * @param opts.customDeptIds          owner-added custom depts that need a decision
 * @param opts.implicitYesCustomIds   configured customs auto-treated as YES (excluded)
 */
export function computeExpectedDecisionIds(
  canonical: CanonicalDepartments,
  opts: { customDeptIds?: string[]; implicitYesCustomIds?: string[] } = {},
): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  const add = (id: string) => {
    const key = norm(id);
    if (!key || seen.has(key)) return;
    seen.add(key);
    ids.push(id);
  };
  for (const d of canonical.mandatory || []) add(d.id);
  for (const d of canonical.universal_primary_vertical || []) add(d.id);
  for (const id of opts.customDeptIds || []) add(id);
  const implicitYes = new Set((opts.implicitYesCustomIds || []).map(norm));
  return ids.filter((id) => !implicitYes.has(norm(id)));
}

/**
 * Compute decision coverage against the expected set, matching the enforcer's
 * provenance rules. An expected dept is COVERED only when a norm-matched decision
 * entry is a fully-provenanced object (any of yes/no/later). A "no" that is NOT
 * provenanced (bare string, or object missing fields) is a REJECTION (gate #8) —
 * it never shrinks the floor and never counts as coverage. `complete` is true
 * only when every expected id is covered.
 */
export function computeDecisionCoverage(
  buildState: BuildState | null,
  expectedIds: string[],
): DecisionCoverage {
  const decisions = (buildState?.canonicalReconciliation?.decisions ?? {}) as Record<
    string,
    RawDecision
  >;

  // Index recorded decisions by normalized id for membership matching.
  const byNorm = new Map<string, RawDecision>();
  const rejections = new Set<string>();
  const declined: string[] = [];
  for (const [rawId, val] of Object.entries(decisions)) {
    const key = norm(rawId);
    byNorm.set(key, val);
    const verb = decisionVerb(val);
    if (verb === 'no') {
      if (isProvenanced(val)) declined.push(rawId);
      else rejections.add(rawId); // un-provenanced decline → enforcer rejects it
    }
  }

  const covered: string[] = [];
  const missing: string[] = [];
  for (const id of expectedIds) {
    const val = byNorm.get(norm(id));
    if (val !== undefined && isProvenanced(val)) covered.push(id);
    else missing.push(id);
  }

  return {
    complete: missing.length === 0,
    expected: expectedIds,
    covered,
    missing,
    rejections: Array.from(rejections),
    declined,
  };
}

/**
 * True when there are ZERO un-provenanced declines anywhere in the decisions map
 * (gate #8 — rejections[] empty). Independent of the expected set: even a decline
 * for a non-expected id, if un-provenanced, is a fabrication vector.
 */
export function noUnprovenancedDeclines(buildState: BuildState | null): boolean {
  const decisions = (buildState?.canonicalReconciliation?.decisions ?? {}) as Record<
    string,
    RawDecision
  >;
  for (const val of Object.values(decisions)) {
    if (decisionVerb(val) === 'no' && !isProvenanced(val)) return false;
  }
  return true;
}

/* ─────────────────────────── Composite gate snapshot ───────────────────────── */

export interface InterviewGateSnapshot {
  buildState: BuildState | null;
  answers: AnswersInfo;
  handoff: HandoffInfo;
  progress: InterviewProgress;
  qcStatus: string;
  interviewComplete: boolean;
  buildCompleted: boolean;
  canonical: CanonicalDepartments | null;
  coverage: DecisionCoverage;
  flags: GateFlags;
}

/**
 * One-call readiness snapshot for the /api/interview/state route + the gated
 * Build button. Reads the canonical FILES (never a divergent DB copy) and shells
 * to list-canonical-departments.py for the live floor. The three UI gate flags
 * mirror the server gates #2/#3/#8:
 *   genuineTranscriptReady       — genuine transcript (gate #2)
 *   decisionCoverageComplete     — every expected dept decided (gate #3)
 *   noUnprovenancedDeclines      — zero un-provenanced declines (gate #8)
 *
 * If the canonical script is unavailable, coverage is reported incomplete
 * (fail-closed) and the flag is false, so the Build button stays disabled rather
 * than green-lighting an unverifiable board.
 */
export async function getInterviewGateSnapshot(
  opts: { customDeptIds?: string[]; implicitYesCustomIds?: string[] } = {},
): Promise<InterviewGateSnapshot> {
  const buildState = readBuildState();
  const answers = readAnswers(buildState);
  const handoff = readHandoff();
  const progress = readInterviewProgress(buildState);
  const qcStatus = readInterviewQcStatus(buildState);
  const interviewComplete = buildState?.interviewComplete === true;
  const buildCompleted = !!buildState?.buildCompletedAt;

  let canonical: CanonicalDepartments | null = null;
  try {
    canonical = await listCanonicalDepartments();
  } catch {
    canonical = null;
  }

  let coverage: DecisionCoverage;
  if (canonical) {
    const expected = computeExpectedDecisionIds(canonical, opts);
    coverage = computeDecisionCoverage(buildState, expected);
  } else {
    // Fail-closed: without the live floor we cannot prove coverage.
    coverage = {
      complete: false,
      expected: [],
      covered: [],
      missing: [],
      rejections: computeDecisionCoverage(buildState, []).rejections,
      declined: computeDecisionCoverage(buildState, []).declined,
    };
  }

  const flags: GateFlags = {
    genuineTranscriptReady: answers.genuine,
    decisionCoverageComplete: coverage.complete,
    noUnprovenancedDeclines: noUnprovenancedDeclines(buildState),
  };

  return {
    buildState,
    answers,
    handoff,
    progress,
    qcStatus,
    interviewComplete,
    buildCompleted,
    canonical,
    coverage,
    flags,
  };
}

/**
 * Derived progress percent — capped at 100 (schema stores none). Denominator is
 * the interview's OWN planned question count (interviewProgress.questionCountPlanned,
 * e.g. a tailored 9-question founder track), falling back to 30 only when that
 * count is unknown. Callers whose interview is already complete should report
 * 100% directly rather than pass a possibly-mismatched count through here — a
 * tailored short track that finished all its questions must never be stuck
 * showing a fraction of a generic 30-question denominator.
 */
export function derivedPercent(
  lastQuestionNumber: number | null | undefined,
  questionCountPlanned?: number | null,
): number {
  const q = typeof lastQuestionNumber === 'number' && lastQuestionNumber > 0 ? lastQuestionNumber : 0;
  const total =
    typeof questionCountPlanned === 'number' && questionCountPlanned > 0
      ? questionCountPlanned
      : 30;
  return Math.min(100, Math.round((q / total) * 100));
}
