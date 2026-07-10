/**
 * assembly-cockpit-logic.ts — the framework-free brain of the B12 Assembly
 * cockpit (SPEC §6; unit U13). No React, no DOM: every state derivation, every
 * gating predicate, every request/response shape lives here so it is unit-testable
 * with `node --test` (mock fetch) and the <AssemblyCockpit> component stays a thin
 * view over it.
 *
 * THE ONE WRITER RULE. This module NEVER re-implements the gate state machine. It
 * only talks to the SESSION-GATED board door `/api/anthology/gate` (SPEC B10 /
 * gap G8), which shells the single sole writer `gate_engine.py` with `--door
 * board`. The engine enforces every guard — own-producer auth, all-approved-or-
 * excluded, the ≥2-chapter floor, and the EXACT typed-name match. The UI enforces
 * nothing on its own; it renders what the engine returns and relays what it refuses.
 *
 * PRODUCER VOICE, NEVER "AI". Every operator-facing string here is producer
 * language ("editors", "the anthology", "sign off & deliver"). There is no client-
 * facing "AI" vocabulary anywhere in this file — a hard requirement of U13.
 *
 * STACKED ON U11 + U9. The two functional gates (arm, sign-off) map to engine
 * actions that exist TODAY. The ordering panel (drag order + "Confirm the finalized
 * set & order") consumes U9's `cockpit_view`. The Command Center RELAY for that
 * data (status passthrough of assembly_state/readiness/ordering, the confirm_order
 * board action + order/opener/closer route fields, and the anthology_id `Ref:`
 * surfacing) is now wired in the integration branch — so the panel lights up as
 * soon as the engine's `cmd_status` emits the data and the engine accepts the
 * `confirm_order` action, and otherwise still shows an honest "pending" state. See
 * PASSTHROUGH_GAPS below for the engine-side production this relay depends on.
 */

import { DEFAULT_FINALIZE_ACTION, isFinalizeAction } from './finalize-action';

/**
 * PASSTHROUGH_GAPS — the wiring this cockpit is stacked on. The COMMAND CENTER
 * RELAY side of each is now landed in the integration branch (documented here so
 * the remaining engine-side dependency stays explicit, never faked):
 *
 *  1. status passthrough — RELAY DONE: boardStatus() + GET /api/anthology/gate now
 *     pass `assembly_state` / `readiness` / `ordering` (U9 `cockpit_view` alias)
 *     verbatim to this module, which already reads them. ENGINE DEPENDENCY:
 *     `cmd_status` (gate_engine.py) must actually EMIT those fields for an assembly
 *     subject (anthology_state.py `_readiness` + U9 `build_ordering_view`). Until
 *     it does, the ticker + drag-order list stay in their honest "pending" state.
 *
 *  2. confirm_order — RELAY DONE: the route's DecideSchema accepts
 *     `order`/`opener`/`closer` and passes them to `decide --action confirm_order`.
 *     ENGINE DEPENDENCY: gate_engine.py must expose the `confirm_order` board
 *     action (the finalize+finale-write + adjusted-order persist that today lives
 *     in anthology_state.py's assembly-advance). Until it does, the confirm button
 *     posts the action and this module flags the engine's refusal honestly.
 *
 *  3. anthology_id — RELAY DONE: the ingest route now folds the anthology
 *     sole-writer subject key (`anthology:(card|assembly):<key>`, carried as the
 *     mc_board idempotency_key) into the card's `Ref:` description line, so
 *     `resolveAnthologyAssembly` (and U12's extractSubject) resolve the aid. When
 *     neither a source_ref nor an anthology-subject key is present it still returns
 *     a null aid (→ honest "not wired" state).
 */
export const PASSTHROUGH_GAPS = [
  'engine: cmd_status must EMIT assembly_state + readiness + ordering (U9 build_ordering_view) for an assembly subject (CC relay landed)',
  'engine: gate_engine.py must expose the confirm_order board action (CC route relay of order/opener/closer landed)',
] as const;

// --------------------------------------------------------------------------- //
// Card → anthology reference.
// --------------------------------------------------------------------------- //

/** The minimum Task shape this module reads. Widened with the optional
 *  `source_ref` the ingest CARRIES but does not yet persist as a column — read
 *  it defensively so the cockpit lights up the moment the API surfaces it. */
export interface AssemblyTaskLike {
  source?: string | null;
  title?: string | null;
  description?: string | null;
  source_ref?: string | null;
}

/** A resolved anthology assembly card. `anthologyId === null` means the card IS an
 *  assembly card but its aid has not been surfaced to the board yet (gap #3). */
export interface AssemblyCardRef {
  anthologyId: string | null;
  /** Best-effort display name (a hint for the typed-name box). The ledger name is
   *  authoritative for the match — the engine, not the UI, validates it. */
  anthologyName: string;
}

const ASSEMBLY_IDEM_RE = /anthology:assembly:([^\s\]]+)/i;
// Card title minted by mc_board.py: "Anthology assembly — <name>" (separator may
// be an em dash, en dash, or hyphen depending on copy-QC).
const ASSEMBLY_TITLE_RE = /^\s*anthology assembly\s*[—–-]\s*(.+?)\s*$/i;

function sourceIsAnthology(task: AssemblyTaskLike): boolean {
  const stamped = (task.source ?? '').trim().toLowerCase();
  if (stamped === 'anthology') return true;
  // Legacy / event-folded provenance marker in the description.
  return /^Source:\s*anthology\s*$/im.test(task.description ?? '');
}

/**
 * Resolve the anthology assembly card behind a Task. Returns null when the Task is
 * NOT the anthology's Assembly card (a participant chapter card, or a non-anthology
 * card), so the cockpit is never rendered on the wrong card.
 */
export function resolveAnthologyAssembly(
  task: AssemblyTaskLike | null | undefined
): AssemblyCardRef | null {
  if (!task) return null;
  if (!sourceIsAnthology(task)) return null;

  const title = (task.title ?? '').trim();
  const titleMatch = ASSEMBLY_TITLE_RE.exec(title);
  // The idempotency key distinguishes the assembly card (anthology:assembly:<aid>)
  // from a participant card (anthology:card:<pk>). Prefer it wherever it appears.
  const idemSource = `${task.source_ref ?? ''}\n${task.description ?? ''}`;
  const idemMatch = ASSEMBLY_IDEM_RE.exec(idemSource);

  // It is the ASSEMBLY card iff its title has the assembly prefix OR an
  // anthology:assembly:<aid> key is present. (Participant cards match neither.)
  if (!titleMatch && !idemMatch) return null;

  const anthologyId = idemMatch ? idemMatch[1].trim() || null : null;
  const anthologyName = titleMatch ? titleMatch[1].trim() : anthologyId ?? '';
  return { anthologyId, anthologyName };
}

// --------------------------------------------------------------------------- //
// Status shape (the GET /api/anthology/gate response, plus optional passthrough).
// --------------------------------------------------------------------------- //

/** One slot of U9's ordering view (`build_ordering_view` / `cockpit_view`). */
export interface OrderSlot {
  participantKey: string;
  position: number;
  chapterTitle: string;
  contributorName: string;
  wordCount: number | null;
  tone: string | null;
  /** The engine's ONE-LINE per-slot rationale (never fabricated by the UI). */
  rationale: string;
  coverThumbUrl: string | null;
}

/** U9's ordering view, as (optionally) surfaced by a future status passthrough. */
export interface AssemblyOrdering {
  order: string[];
  slots: OrderSlot[];
  overallRationale: string;
}

/** The S9 readiness report (`_readiness`), as (optionally) surfaced. */
export interface AssemblyReadiness {
  finalized: number; // frozen_chapter_count
  total: number; // active (non-excluded) members
  inRewrite: number;
  excluded: number;
  minChapters: number;
  ready: boolean; // all approved-or-excluded AND ≥ floor
  armed: boolean;
  belowFloor: boolean;
  /** A pre-rendered ticker line, when the engine supplies one. */
  label: string | null;
}

/** The normalized board status the cockpit renders. */
export type AssemblyStatus =
  | {
      ok: true;
      subjectKey: string;
      openGate: string | null;
      kind: 'participant' | 'anthology' | null;
      actor: string | null;
      doors: string[];
      actions: string[];
      // Optional passthrough (gap #1) — undefined until the engine surfaces it.
      assemblyState?: string | null;
      readiness?: AssemblyReadiness;
      ordering?: AssemblyOrdering;
    }
  | { ok: false; reason: string };

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}
function strArr(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

/** Parse one raw slot (accepts U9's python snake_case keys verbatim). */
function parseSlot(raw: unknown, index: number): OrderSlot | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const participantKey = str(r.participant_key ?? r.participantKey);
  if (!participantKey) return null;
  return {
    participantKey,
    position: num(r.position) ?? index + 1,
    chapterTitle: str(r.chapter_title ?? r.chapterTitle ?? r.title_locked),
    contributorName: str(r.contributor_name ?? r.contributorName),
    wordCount: num(r.word_count ?? r.wordCount),
    tone: str(r.tone) || null,
    rationale: str(r.rationale).trim(),
    coverThumbUrl: str(r.cover_thumb_url ?? r.coverThumbUrl ?? r.cover_thumb) || null,
  };
}

function parseOrdering(raw: unknown): AssemblyOrdering | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const rawSlots = Array.isArray(r.slots) ? r.slots : [];
  const slots = rawSlots
    .map((s, i) => parseSlot(s, i))
    .filter((s): s is OrderSlot => s !== null);
  if (slots.length === 0 && !Array.isArray(r.order)) return undefined;
  return {
    order: strArr(r.order).length ? strArr(r.order) : slots.map((s) => s.participantKey),
    slots,
    overallRationale: str(r.overall_rationale ?? r.overallRationale).trim(),
  };
}

function parseReadiness(raw: unknown): AssemblyReadiness | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const blocking = Array.isArray(r.blocking) ? r.blocking : [];
  const inRewriteFromBlocking = blocking.filter(
    (b) => b && typeof b === 'object' && (b as Record<string, unknown>).reason === 'not_approved'
  ).length;
  const finalized = num(r.frozen_chapter_count ?? r.finalized) ?? 0;
  const total = num(r.active_members ?? r.total) ?? 0;
  return {
    finalized,
    total,
    inRewrite: num(r.in_rewrite ?? r.inRewrite) ?? inRewriteFromBlocking,
    excluded: num(r.excluded) ?? 0,
    minChapters: num(r.min_chapters ?? r.minChapters) ?? 2,
    ready: r.ready === true,
    armed: r.armed === true,
    belowFloor: r.below_min_chapters === true || r.belowFloor === true,
    label: str(r.label).trim() || null,
  };
}

/** Normalize the raw GET /api/anthology/gate JSON into an AssemblyStatus. */
export function parseAssemblyStatus(raw: unknown): AssemblyStatus {
  if (!raw || typeof raw !== 'object') return { ok: false, reason: 'error' };
  const r = raw as Record<string, unknown>;
  if (r.ok !== true) {
    return { ok: false, reason: str(r.reason) || 'error' };
  }
  const kindRaw = str(r.kind);
  return {
    ok: true,
    subjectKey: str(r.subjectKey ?? r.subject_key),
    openGate: typeof r.openGate === 'string' ? r.openGate : typeof r.open_gate === 'string' ? r.open_gate : null,
    kind: kindRaw === 'participant' || kindRaw === 'anthology' ? kindRaw : null,
    actor: str(r.actor) || null,
    doors: strArr(r.doors),
    actions: strArr(r.actions),
    assemblyState:
      typeof r.assemblyState === 'string'
        ? r.assemblyState
        : typeof r.assembly_state === 'string'
          ? r.assembly_state
          : undefined,
    readiness: parseReadiness(r.readiness),
    ordering: parseOrdering(r.ordering ?? r.cockpit_view),
  };
}

// --------------------------------------------------------------------------- //
// Phase + gating derivation.
// --------------------------------------------------------------------------- //

export type AssemblyPhase =
  | 'unresolved' // aid not surfaced to the card (gap #3) — cannot talk to the door
  | 'loading'
  | 'arm' // s9_ready: type the name to arm (assembly_state not_ready|armed)
  | 'ordering' // armed→compiled window: order the book / assembly underway
  | 'sign_off' // s9_producer: manuscript compiled, ready to deliver
  | 'delivered' // signed_off
  | 'not_ready' // engine held / not provisioned
  | 'error';

/**
 * Derive the cockpit phase from the status. Driven by the fields the engine
 * reliably surfaces TODAY (open_gate + actions), refined by assembly_state when a
 * passthrough provides it (gap #1). The engine's action set is authoritative — the
 * UI never invents an action it did not return.
 */
export function derivePhase(status: AssemblyStatus): AssemblyPhase {
  if (!status.ok) return status.reason === 'not_ready' ? 'not_ready' : 'error';

  const st = status.assemblyState;
  if (st === 'signed_off') return 'delivered';

  if (status.openGate === 's9_producer' || status.actions.includes('sign_off') || st === 'compiled') {
    return 'sign_off';
  }
  if (status.openGate === 's9_ready' || status.actions.includes('ready_to_assemble')) {
    // s9_ready covers not_ready AND armed. Once explicitly armed with ordering data
    // in hand, prefer the ordering panel; otherwise it is the arm step.
    if (st === 'armed' && status.ordering) return 'ordering';
    return 'arm';
  }
  // open_gate null with a fired assembly_state → the book is being ordered/compiled.
  if (st === 'ready_confirmed' || st === 'proposed' || st === 'adjusted' || st === 'armed') {
    return 'ordering';
  }
  if (status.openGate === null) return 'ordering'; // underway (state ambiguous without gap #1)
  return 'error';
}

/**
 * Sign-off is enabled ONLY when the manuscript is compiled — the engine surfaces
 * the `sign_off` action (gate s9_producer) exclusively at assembly_state
 * `compiled`, so the presence of that action IS the compiled gate. When a
 * passthrough surfaces assembly_state, require it to equal `compiled` too.
 */
export function signOffEnabled(status: AssemblyStatus): boolean {
  if (!status.ok) return false;
  if (typeof status.assemblyState === 'string') return status.assemblyState === 'compiled';
  return status.openGate === 's9_producer' || status.actions.includes('sign_off');
}

// --------------------------------------------------------------------------- //
// Typed-name + ordering helpers (pure).
// --------------------------------------------------------------------------- //

/** True when the typed text exactly matches the anthology name (trimmed). A UI
 *  affordance only — the engine performs the authoritative, guarded match. */
export function nameMatches(typed: string, anthologyName: string): boolean {
  return typed.trim().length > 0 && typed.trim() === anthologyName.trim();
}

/** Compose the readiness ticker line ("7 of 9 chapters finalized; 1 in rewrite;
 *  1 excluded"). Prefers an engine-supplied label; otherwise builds from counts. */
export function readinessLabel(readiness: AssemblyReadiness | undefined): string | null {
  if (!readiness) return null;
  if (readiness.label) return readiness.label;
  const parts = [`${readiness.finalized} of ${readiness.total} chapters finalized`];
  if (readiness.inRewrite > 0) parts.push(`${readiness.inRewrite} in rewrite`);
  if (readiness.excluded > 0) parts.push(`${readiness.excluded} excluded`);
  return parts.join('; ');
}

/** Move the item from `fromIndex` to `toIndex` (immutable). Out-of-range indices
 *  return the list unchanged. Backs the drag-to-reorder interaction. */
export function reorder<T>(list: readonly T[], fromIndex: number, toIndex: number): T[] {
  const next = list.slice();
  if (fromIndex < 0 || fromIndex >= next.length || toIndex < 0 || toIndex >= next.length) {
    return next;
  }
  const [moved] = next.splice(fromIndex, 1);
  next.splice(toIndex, 0, moved);
  return next;
}

/** Make `participantKey` the OPENER (first slot). Producer's explicit pick. */
export function moveToFront(order: readonly string[], participantKey: string): string[] {
  const idx = order.indexOf(participantKey);
  if (idx < 0) return order.slice();
  return reorder(order, idx, 0);
}

/** Make `participantKey` the LAST co-author (last slot). Producer's explicit pick. */
export function moveToEnd(order: readonly string[], participantKey: string): string[] {
  const idx = order.indexOf(participantKey);
  if (idx < 0) return order.slice();
  return reorder(order, idx, order.length - 1);
}

// --------------------------------------------------------------------------- //
// Request bodies + decision result.
// --------------------------------------------------------------------------- //

/** Arm body. NOTE: producer-id is NOT sent — the route derives it from the
 *  session (Cf-Access email), never a body field, so it cannot be forged. */
export interface ArmBody {
  subjectKey: string;
  action: 'ready_to_assemble';
  confirmName: string;
}
export function buildArmBody(anthologyId: string, confirmName: string): ArmBody {
  return { subjectKey: anthologyId, action: 'ready_to_assemble', confirmName: confirmName.trim() };
}

/** Sign-off body (compiled manuscript). Producer-id from session, as above. */
export interface SignOffBody {
  subjectKey: string;
  action: 'sign_off';
}
export function buildSignOffBody(anthologyId: string): SignOffBody {
  return { subjectKey: anthologyId, action: 'sign_off' };
}

/**
 * "Confirm the finalized set & order" body. Carries the producer's finalized
 * order + opener + last co-author under the SHARED board contract keys
 * `{order, opener, closer}` — the route's DecideSchema and the engine's
 * `confirm_order` action consume exactly these (gap #2 closed). `action` is taken
 * from the engine's surfaced action set when it offers a finalize action,
 * defaulting to `confirm_order`.
 */
export interface ConfirmOrderBody {
  subjectKey: string;
  action: string;
  order: string[];
  opener: string | null;
  closer: string | null;
}
export function pickConfirmOrderAction(actions: readonly string[]): string {
  // Uses the SHARED finalize-action predicate (finalize-action.ts) — the exact
  // same matcher the board-door route uses to decide when to relay the order
  // payload, so the picker and the relay can never drift.
  const found = actions.find((a) => isFinalizeAction(a));
  return found ?? DEFAULT_FINALIZE_ACTION;
}
export function buildConfirmOrderBody(
  anthologyId: string,
  order: readonly string[],
  action = DEFAULT_FINALIZE_ACTION
): ConfirmOrderBody {
  return {
    subjectKey: anthologyId,
    action,
    order: order.slice(),
    opener: order.length ? order[0] : null,
    closer: order.length ? order[order.length - 1] : null,
  };
}

/** A normalized decision result the component renders directly. */
export type DecideResult =
  | { ok: true; gate: string | null; decision: string | null; queued: boolean }
  | { ok: false; reason: string; message: string; needsRetry: boolean };

/**
 * Map an engine refusal reason → a friendly, PRODUCER-VOICE message. No "AI"
 * language anywhere. `needsRetry` marks the user-correctable cases (a bad typed
 * name, a missing field) so the UI keeps the form open instead of dead-ending.
 */
export function friendlyDecideError(reason: string): { message: string; needsRetry: boolean } {
  switch (reason) {
    case 'validation_mismatch':
      return {
        message:
          "That name did not match. Type the anthology's exact title to arm assembly.",
        needsRetry: true,
      };
    case 'missing_fields':
      return {
        message:
          'We could not confirm you as the producer for this anthology from your session. Reload the board and try again.',
        needsRetry: true,
      };
    case 'action_not_allowed_at_gate':
    case 'gate_not_open':
    case 'no_open_gate':
      return {
        message:
          'This step is not open yet. Refresh the card to see where the anthology stands.',
        needsRetry: false,
      };
    case 'not_ready':
    case 'sole_writer_held':
    case 'secret_not_set':
      return {
        message:
          'The editors are not able to record this right now. Please try again in a moment.',
        needsRetry: false,
      };
    default:
      return {
        message: 'We could not record that decision. Please try again.',
        needsRetry: false,
      };
  }
}

function normalizeDecide(raw: unknown): DecideResult {
  if (raw && typeof raw === 'object') {
    const r = raw as Record<string, unknown>;
    if (r.ok === true && r.committed === true) {
      return {
        ok: true,
        gate: str(r.gate) || null,
        decision: str(r.decision) || null,
        queued: r.queued === true || r.base_queued === true,
      };
    }
    const reason = str(r.reason) || 'error';
    const friendly = friendlyDecideError(reason);
    return { ok: false, reason, ...friendly };
  }
  const friendly = friendlyDecideError('error');
  return { ok: false, reason: 'error', ...friendly };
}

// --------------------------------------------------------------------------- //
// Network calls (fetch injected for tests; defaults to the global fetch).
// --------------------------------------------------------------------------- //

export type FetchLike = (input: string, init?: RequestInit) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}>;

const GATE_ENDPOINT = '/api/anthology/gate';

export type StatusResult =
  | { ok: true; status: AssemblyStatus }
  | { ok: false; reason: string };

/** GET the open gate + (when surfaced) readiness/ordering for the anthology. */
export async function loadAssemblyStatus(
  anthologyId: string,
  fetchImpl: FetchLike = fetch as unknown as FetchLike
): Promise<StatusResult> {
  try {
    const res = await fetchImpl(
      `${GATE_ENDPOINT}?subjectKey=${encodeURIComponent(anthologyId)}`,
      { method: 'GET', headers: { accept: 'application/json' } }
    );
    const body = await res.json().catch(() => null);
    const parsed = parseAssemblyStatus(body);
    if (parsed.ok) return { ok: true, status: parsed };
    return { ok: false, reason: parsed.reason };
  } catch {
    return { ok: false, reason: 'error' };
  }
}

async function postDecide(body: unknown, fetchImpl: FetchLike): Promise<DecideResult> {
  try {
    const res = await fetchImpl(GATE_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => null);
    return normalizeDecide(json);
  } catch {
    return { ok: false, reason: 'error', ...friendlyDecideError('error') };
  }
}

/** Arm assembly with the typed anthology name (one-way; engine-guarded). */
export function submitArm(
  anthologyId: string,
  confirmName: string,
  fetchImpl: FetchLike = fetch as unknown as FetchLike
): Promise<DecideResult> {
  return postDecide(buildArmBody(anthologyId, confirmName), fetchImpl);
}

/** Confirm the finalized set & order (triggers the finale write, gap #2). */
export function submitConfirmOrder(
  anthologyId: string,
  order: readonly string[],
  action = DEFAULT_FINALIZE_ACTION,
  fetchImpl: FetchLike = fetch as unknown as FetchLike
): Promise<DecideResult> {
  return postDecide(buildConfirmOrderBody(anthologyId, order, action), fetchImpl);
}

/** Sign off & deliver the compiled anthology (fires U1 downstream). */
export function submitSignOff(
  anthologyId: string,
  fetchImpl: FetchLike = fetch as unknown as FetchLike
): Promise<DecideResult> {
  return postDecide(buildSignOffBody(anthologyId), fetchImpl);
}
