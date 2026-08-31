/**
 * completion-evidence.ts — the ONE definition of "this task produced something".
 *
 * ── WHY THIS MODULE EXISTS (T0-01 / T0-42) ────────────────────────────────────
 * `done` is the only terminal, durable state a task has. A `done` row plus its
 * `task_completed` event stand afterwards as evidence the work was performed —
 * they are read by the board, the owner report, grading, and every downstream
 * audit. So the ONE fact that must be true before that record is written is that
 * the work LANDED SOMEWHERE a human can go look at.
 *
 * Before this module, that fact was checked for exactly two task shapes (image
 * and deck) and assumed for every other. `deriveAcceptanceCriteria()` returned
 * `[]` for a document / book / report / operations / video / content task, which
 * made `isArtifactTask` false, which skipped the "no artifact registered"
 * invariant, which dropped scoring into a description-only mode where the judge
 * graded the same prose the executing agent had just written. A passing score
 * then wrote a durable completion for a deliverable that never existed.
 *
 * ── THE RULE ──────────────────────────────────────────────────────────────────
 * A task may be recorded `done` only if at least one deliverable is registered
 * against it and that deliverable is REACHABLE:
 *
 *   file | artifact | image  →  a filesystem path that exists and is non-empty
 *   url                      →  a syntactically valid http(s) URL
 *
 * This is deliberately an EXISTENCE check, not a quality check. Quality is the
 * QC scorer's job and is judged separately against acceptance criteria. This
 * gate answers only the question a language model must never be asked to
 * adjudicate about its own output: "is there anything here at all?"
 *
 * ── WHY FAIL-CLOSED, AND WHY THIS IS NOT A NEW BURDEN ─────────────────────────
 * Every dispatched task already receives this instruction verbatim, for every
 * task type, from `renderWriteBackInstructions()` (src/lib/mc-auth.ts):
 *
 *     "**IMPORTANT:** After completing work, you MUST call these APIs.
 *      ...
 *      2. Register deliverable: POST <url>/api/tasks/<id>/deliverables"
 *
 * So the contract was already stated to every agent on every dispatch; it was
 * simply never enforced. This module enforces the instruction the system already
 * gives. It does not invent a new requirement, and it needs no per-task-type
 * taxonomy to decide who it applies to — which is exactly why it cannot be
 * talked past by a persuasive task description.
 *
 * ── THE ARTIFACT-FREE TASK ────────────────────────────────────────────────────
 * Some work genuinely produces no FILE: a decision, a review, a conversation, an
 * account change made in someone else's system. Those are not exempted, because
 * an exemption is a hole and holes are what this module closes. They are served
 * by the `url` deliverable type, which already exists in the schema and in
 * `CreateDeliverableSchema`: register the link to the decision, the thread, the
 * record, the changed resource. That is a real, checkable criterion — "say where
 * it landed" — rather than a category that skips the check entirely.
 */

import { queryAll } from '@/lib/db';
import { existsSync, statSync, lstatSync, openSync, readSync, closeSync } from 'fs';

// ---------------------------------------------------------------------------
// FIX 28 — CC-side bundle re-verification (mirrors build_deck.py postflight)
// ---------------------------------------------------------------------------
//
// The strong postflight completeness gate in the client's build pipeline
// (build_deck.py `run_postflight_gate`, AF-BUNDLE-COMPLETE) verifies every
// DELIVERABLES_REQUIRED artifact exists in bundle_dir AND passes its per-artifact
// min_bytes floor AND carries the leading magic bytes its type implies (symlinks
// rejected, size via lstat never following a link, md size-only, webinar mp4
// skipped as produced_later). That gate runs CLIENT-SIDE; until FIX 28, CC
// trusted the certificate JSON / a bare "file exists and is non-empty" and never
// re-checked a single byte. A decoy — junk bytes renamed to FINAL.pptx at the
// right size, or an under-floor stub — validated as completion evidence.
//
// The table below mirrors the client authority (floors in bytes, magic
// signatures, size-only md, produced-later webinar skip). CC re-runs the
// equivalent probe against REGISTERED deliverables at the done gate. A file
// whose name is bundle-shaped must now actually BE the artifact it names to
// count as evidence; every other deliverable keeps its existing behavior, and
// PRESENTATION_BUNDLE_REVERIFY=0 restores the pre-fix semantics verbatim.

/** Feature flag, read LIVE per call. Default ON; =0 rolls back to pre-fix. */
export function bundleReverifyEnabled(): boolean {
  return process.env.PRESENTATION_BUNDLE_REVERIFY !== '0';
}

interface BundleSpec {
  /** human key from the client table, for the refusal message */
  key: string;
  floor: number;
  /** leading magic signatures; undefined = size-only (plain text, per spec) */
  signatures?: Buffer[];
}

const SIG = (...stringsToBuffer: string[]): Buffer[] => stringsToBuffer.map((s) => Buffer.from(s, 'binary'));

/**
 * DELIVERABLES_REQUIRED ∩ DELIVERABLE_MAGIC from build_deck.py, verbatim
 * (floors + magics + md size-only). `webinar_mp4` (`*-WEBINAR.mp4`) is
 * deliberately ABSENT — produced_later in the client table, and its real
 * presence gate belongs to the phases that produce it.
 */
const BUNDLE_SPECS: Array<{ match: (base: string) => boolean; spec: BundleSpec }> = [
  { match: (b) => b === 'PRESENTER-GUIDE.pdf', spec: { key: 'guide_pdf', floor: 51_200, signatures: SIG('%PDF') } },
  { match: (b) => b === 'PRESENTERS-SPEECH.pdf', spec: { key: 'speech_pdf', floor: 3_000, signatures: SIG('%PDF') } },
  { match: (b) => b === 'PRESENTERS-SPEECH.md', spec: { key: 'speech_md', floor: 2_048 } },
  { match: (b) => b === 'PRESENTERS-SPEECH-FISH-TAGGED.md', spec: { key: 'speech_fish_md', floor: 2_048 } },
  { match: (b) => b === 'PRESENTER-AUDIO.mp3', spec: { key: 'audio_mp3', floor: 512_000, signatures: SIG('ID3', '\xff\xfb', '\xff\xf3', '\xff\xf2') } },
  { match: (b) => b === 'infographic.png', spec: { key: 'infographic_png', floor: 102_400, signatures: SIG('\x89PNG') } },
  {
    match: (b) => b === 'presenter-teleprompter.html',
    spec: {
      key: 'teleprompter_html',
      floor: 20_000,
      signatures: SIG('<!DOCTYPE', '<!doctype', '<!Doctype', '<html', '<HTML', '<!--'),
    },
  },
  { match: (b) => b.endsWith('-FINAL.pptx'), spec: { key: 'deck_pptx', floor: 1_048_576, signatures: SIG('PK\x03\x04') } },
  { match: (b) => b.endsWith('-FINAL.pdf'), spec: { key: 'deck_pdf', floor: 51_200, signatures: SIG('%PDF') } },
];

/** True when the path's basename is a bundle-managed artifact name. */
export function isBundleDeliverablePath(rawPath: string | null | undefined): boolean {
  if (!rawPath) return false;
  const base = rawPath.trim().split('/').pop() ?? '';
  return BUNDLE_SPECS.some((e) => e.match(base));
}

export interface BundleProbeVerdict {
  ok: boolean;
  /** named status mirroring build_deck.py's postflight statuses */
  status?: 'ABSENT' | 'SYMLINK' | 'NOT_REGULAR' | 'UNDER_THRESHOLD' | 'WRONG_TYPE';
  reason?: string;
  sizeBytes?: number;
  bundleKey?: string;
}

function magicOk(head: Buffer, signatures: Buffer[]): boolean {
  if (signatures.some((s) => head.subarray(0, s.length).equals(s))) return true;
  // Text-ish signatures ('<'-leading) tolerate a UTF-8 BOM + leading ASCII
  // whitespace, exactly like the client's _magic_ok; binary magics stay at 0.
  const want = Math.max(...signatures.map((s) => s.length));
  const trimmed = head.subarray(0, want + 8);
  let t = trimmed;
  if (t.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))) t = t.subarray(3);
  let start = 0;
  while (start < t.length && (t[start] === 0x20 || t[start] === 0x09 || t[start] === 0x0d || t[start] === 0x0a)) start += 1;
  const body = t.subarray(start);
  return signatures.filter((s) => s[0] === 0x3c).some((s) => body.subarray(0, s.length).equals(s));
}

/**
 * Re-run the bundle postflight probe for ONE registered deliverable path,
 * client-authority semantics: lexists-equivalent presence (a dangling symlink
 * is present-but-rejected), symlink rejection, non-regular-file rejection,
 * lstat size (never follow a link) against the floor, then leading magic bytes
 * (md size-only). Reads ONLY the header bytes needed — never the whole file.
 * Fail-closed: any error to probe is a rejection, never a pass.
 */
export function verifyPresentationBundleDeliverable(rawPath: string | null | undefined): BundleProbeVerdict {
  if (!rawPath || rawPath.trim() === '') {
    return { ok: false, status: 'ABSENT', reason: 'ABSENT: no path registered' };
  }
  const resolved = rawPath.replace(/^~/, process.env.HOME || '');
  const base = resolved.split('/').pop() ?? '';
  const entry = BUNDLE_SPECS.find((e) => e.match(base));
  if (!entry) {
    // Not a bundle-managed name — nothing to re-verify here.
    return { ok: true, reason: 'not bundle-managed', sizeBytes: undefined };
  }
  const { key, floor, signatures } = entry.spec;

  let lstat: ReturnType<typeof lstatSync>;
  try {
    lstat = lstatSync(resolved); // throws on absent/dangling; never follows a symlink
  } catch {
    return { ok: false, status: 'ABSENT', reason: `ABSENT: ${base} not found in registered location (${resolved})`, bundleKey: key };
  }
  if (lstat.isSymbolicLink()) {
    return { ok: false, status: 'SYMLINK', reason: `SYMLINK: ${base} is a symlink (rejected: a symlink can point at a large unrelated/decoy file)`, bundleKey: key };
  }
  if (!lstat.isFile()) {
    return { ok: false, status: 'NOT_REGULAR', reason: `NOT_REGULAR: ${base} is not a regular file`, bundleKey: key };
  }
  const actual = lstat.size;
  if (actual < floor) {
    return { ok: false, status: 'UNDER_THRESHOLD', reason: `UNDER_THRESHOLD: ${base} is ${actual} bytes (min ${floor})`, sizeBytes: actual, bundleKey: key };
  }
  if (signatures && signatures.length > 0) {
    const want = Math.max(...signatures.map((s) => s.length)) + 8; // +8 covers BOM + leading WS
    let head: Buffer;
    try {
      const fd = openSync(resolved, 'r');
      try {
        head = Buffer.alloc(want);
        const read = readSync(fd, head, 0, want, 0);
        head = head.subarray(0, read);
      } finally {
        closeSync(fd);
      }
    } catch (err) {
      // Fail-closed: unreadable leading bytes can never be claimed to match.
      return { ok: false, status: 'WRONG_TYPE', reason: `WRONG_TYPE: ${base} leading bytes unreadable (${(err as Error).message})`, sizeBytes: actual, bundleKey: key };
    }
    if (!magicOk(head, signatures)) {
      return { ok: false, status: 'WRONG_TYPE', reason: `WRONG_TYPE: ${base} is ${actual} bytes but leading bytes do not match expected magic for this deliverable type (decoy/wrong-type file)`, sizeBytes: actual, bundleKey: key };
    }
  }
  return { ok: true, reason: 'verified', sizeBytes: actual, bundleKey: key };
}

/**
 * Deliverable types that can serve as completion evidence.
 *
 * NOTE this is deliberately WIDER than the QC scorer's historical
 * `FILE_BACKED_DELIVERABLE_TYPES` (file/artifact/image), which omitted `url`.
 * That omission meant an agent which correctly registered a URL deliverable —
 * the right move for artifact-free work — still presented an empty manifest to
 * QC and fell through to description-only scoring. A URL is evidence.
 */
export const EVIDENCE_DELIVERABLE_TYPES = new Set(['file', 'artifact', 'image', 'url']);

export interface EvidenceRow {
  id: string;
  title: string;
  path: string | null;
  deliverable_type: string;
}

export interface CompletionEvidence {
  /** True when at least one registered deliverable is reachable. */
  hasEvidence: boolean;
  /** Deliverable rows of an evidence-bearing type (reachable or not). */
  rows: EvidenceRow[];
  /** Human-readable reasons each registered row failed to count, if any. */
  problems: string[];
}

/** True for a syntactically valid http(s) URL. */
export function isUsableUrl(value: string | null | undefined): boolean {
  if (!value) return false;
  try {
    const u = new URL(value.trim());
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/** True when a filesystem path exists and holds more than zero bytes. */
export function isUsableFile(rawPath: string | null | undefined): boolean {
  if (!rawPath) return false;
  const resolved = rawPath.replace(/^~/, process.env.HOME || '');
  if (!existsSync(resolved)) return false;
  try {
    return statSync(resolved).size > 0;
  } catch {
    return false;
  }
}

// FIX 28: bundle-shaped deliverable names get the byte-level re-verification;
// ordinary files keep the existence+non-empty rule unchanged.
function isUsableFileForEvidence(rawPath: string | null | undefined): { usable: boolean; problem?: string } {
  const resolved = rawPath ? rawPath.replace(/^~/, process.env.HOME || '') : '';
  if (bundleReverifyEnabled() && isBundleDeliverablePath(rawPath)) {
    const verdict = verifyPresentationBundleDeliverable(resolved);
    if (verdict.ok) return { usable: true };
    return { usable: false, problem: verdict.reason ?? 'bundle verification failed' };
  }
  return { usable: isUsableFile(rawPath) };
}

/**
 * Collect the completion evidence registered against a task.
 *
 * Never throws: a DB error yields `hasEvidence: false` with the error recorded
 * in `problems`. Fail-closed is the point — an evidence check that cannot run
 * has not proven anything, and "we could not check" must never read as "it is
 * fine". A transient DB fault therefore holds the task rather than completing
 * it; the task stays where it is and can be retried, which is recoverable,
 * whereas a false `done` is durable and is not.
 */
export function collectCompletionEvidence(taskId: string): CompletionEvidence {
  let rows: EvidenceRow[] = [];
  try {
    rows = queryAll<EvidenceRow>(
      `SELECT id, title, path, deliverable_type FROM task_deliverables WHERE task_id = ?`,
      [taskId],
    ).filter((d) => EVIDENCE_DELIVERABLE_TYPES.has(d.deliverable_type));
  } catch (err) {
    return {
      hasEvidence: false,
      rows: [],
      problems: [`could not read task_deliverables: ${(err as Error).message}`],
    };
  }

  if (rows.length === 0) {
    return { hasEvidence: false, rows: [], problems: [] };
  }

  const problems: string[] = [];
  let usable = 0;

  for (const row of rows) {
    if (row.deliverable_type === 'url') {
      if (isUsableUrl(row.path)) usable += 1;
      else problems.push(`"${row.title}": not a valid http(s) URL (${row.path ?? 'no path'})`);
      continue;
    }
    // file | artifact | image — FIX 28: bundle-shaped names re-verify bytes.
    const fileTry = isUsableFileForEvidence(row.path);
    if (fileTry.usable) usable += 1;
    else problems.push(`"${row.title}": ${fileTry.problem ?? `file missing or empty (${row.path ?? 'no path'})`}`);
  }

  return { hasEvidence: usable > 0, rows, problems };
}

/**
 * The operator-facing explanation for a refused completion. Written to be
 * ACTIONABLE: a gate that only says "no" gets routed around, so this states the
 * exact call that clears it. Same text on every path so the refusal reads
 * identically whichever door it came from.
 */
export function noEvidenceMessage(taskId: string, evidence: CompletionEvidence): string {
  const detail =
    evidence.rows.length === 0
      ? 'No deliverable of any kind is registered against this task.'
      : `Registered deliverables are all unreachable: ${evidence.problems.join('; ')}.`;

  return (
    `Cannot record this task as done: no completion evidence. ${detail} ` +
    `A task may only be completed once the work it produced is registered and reachable. ` +
    `Register it with POST /api/tasks/${taskId}/deliverables ` +
    `— {"deliverable_type":"file","title":"<name>","path":"<absolute path>"} for a produced file, ` +
    `or {"deliverable_type":"url","title":"<name>","path":"https://..."} for work that lives ` +
    `somewhere else (a decision, a review, a record or resource changed in another system). ` +
    `This requirement is the same one the dispatch brief already states for every task.`
  );
}
