/**
 * Pure, framework-free model for the Gate Panel's decision zone (SPEC B11 /
 * Unit U12). NO React. It owns two things and nothing else:
 *
 *   1. PRESENTATION of an engine action — the producer-voice label, the tone,
 *      and which single extra input the engine requires for it. This is a
 *      PRESENTATION registry, NOT a gate table: it never decides WHICH actions
 *      a gate offers. The authoritative action SET comes only from
 *      `GET /api/anthology/gate` (`status.actions`, produced by the one sole
 *      writer, gate_engine.py). We render exactly what status returns; an action
 *      we have no entry for still renders (as a humanized generic button), and
 *      an entry we have never appears unless status returned that action.
 *
 *   2. The two client fetches to the Unit-U11 board door: read the open gate
 *      (`fetchBoardStatus`) and record a decision (`postGateDecision`). `fetch`
 *      is injectable so the flow is unit-testable with a mock.
 *
 * ENGINE-GATED FACES (flag, never fake): the cover 2x2 grid (B8/U8) and the
 * producer "request rewrite with notes" control (B9/U9) depend on engine gates
 * that do not exist yet. Today gate_engine.py's `select` action is the S3
 * title-SELECTION gate (NOT a cover gate) and `request_rewrite_with_notes` is
 * the S5 chapter gate. We render each of those actions accurately for what it
 * IS today, and never dress `select` up as the four-style cover picker. The
 * cover 2x2 face is a SEPARATE forward-stub: a future producer cover gate (U8)
 * will register its own action carrying `engineGated: 'cover'` plus the four
 * cover-style images. Until it does, `status` carries no cover-style data, so
 * the grid has nothing to draw and stays absent. We do not manufacture it.
 */

// --------------------------------------------------------------------------- //
// Wire shapes — the exact JSON that Unit U11's route.ts returns (mirrors the
// BoardStatus / BoardDecide serializers in participant/_lib/gate-engine.ts).
// --------------------------------------------------------------------------- //

/** GET /api/anthology/gate?subjectKey=… success body. */
export interface BoardStatusOk {
  ok: true;
  subjectKey: string;
  openGate: string | null;
  kind: 'participant' | 'anthology' | null;
  actor: string | null;
  doors: string[];
  actions: string[];
}
export interface BoardStatusFail {
  ok: false;
  reason: 'unknown_subject' | 'not_ready' | 'error' | string;
}

export type BoardStatusResult =
  | (BoardStatusOk & { httpStatus: number })
  | (BoardStatusFail & { httpStatus: number });

/** POST /api/anthology/gate body → decideBoard() result. */
export interface BoardDecideOk {
  ok: true;
  committed: true;
  gate: string | null;
  decision: string | null;
  door: string | null;
  approvalId: string | null;
  stageCursor: string | null;
  queued: boolean;
  noop: boolean;
}
export interface BoardDecideFail {
  ok: false;
  committed: false;
  reason: string;
  held: boolean;
  openGate?: string | null;
  allowed?: string[];
  fields?: string[];
}
export type BoardDecideResult =
  | (BoardDecideOk & { httpStatus: number })
  | (BoardDecideFail & { httpStatus: number });

/** Extra fields a decision may carry. The engine enforces which are REQUIRED per
 *  action; we mirror only the single field a known action needs, for inline UX. */
export interface DecideFields {
  reason?: string;
  notes?: string;
  title?: string;
  subtitle?: string;
  confirmName?: string;
}

// --------------------------------------------------------------------------- //
// Action presentation registry (presentation only — see file header).
// --------------------------------------------------------------------------- //

export type ActionTone = 'primary' | 'secondary' | 'destructive';
/** Which engine gate this action's rich face is waiting on, if any. */
export type EngineGate = 'cover' | 'rewrite';

/** The single extra input a known action requires (the engine is the authority;
 *  this drives inline validation + which small control to render). */
export type ActionField = 'reason' | 'notes' | 'title' | 'confirmName';

export interface ActionPresentation {
  action: string;
  tone: ActionTone;
  /** Producer-voice button label. `firstName` fills the release copy. Never
   *  says "AI" — the doers are always "editors". No em-dashes. */
  label: (firstName: string | null) => string;
  /** The one input the engine requires for this action, if any. */
  field: ActionField | null;
  /** For `select`: an optional second (subtitle) input. */
  optionalSubtitle?: boolean;
  /** Set when the action's RICH face depends on an engine gate that may not be
   *  live yet (cover 2×2 / producer rewrite). The plain button still POSTs. */
  engineGated?: EngineGate;
}

function titleCase(action: string): string {
  return action
    .split('_')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

const REGISTRY: Record<string, Omit<ActionPresentation, 'action'>> = {
  approve: {
    tone: 'primary',
    label: (n) => `Approve & Release to ${n || 'the author'}`,
    field: null,
  },
  approve_as_is: {
    tone: 'primary',
    label: (n) => `Approve as-is & release to ${n || 'the author'}`,
    field: null,
  },
  sign_off: {
    tone: 'primary',
    label: () => 'Sign off & deliver the anthology',
    field: null,
  },
  ready_to_assemble: {
    tone: 'primary',
    label: () => "I'm ready to assemble",
    field: 'confirmName',
  },
  // `select` is the S3 TITLE-selection gate today (the client confirms a title;
  // requires `title`, optional `subtitle`). It is deliberately NOT labelled as
  // the cover gate: the four-named-cover 2×2 grid is a SEPARATE future producer
  // gate (SPEC B8/U8) that will register its OWN action carrying
  // `engineGated: 'cover'` and cover-style data. Conflating the two here would
  // fake a cover face the engine does not yet expose.
  select: {
    tone: 'primary',
    label: (n) => `Approve the selected title & release to ${n || 'the author'}`,
    field: 'title',
    optionalSubtitle: true,
  },
  hold: {
    tone: 'secondary',
    label: () => 'Hold',
    field: 'reason',
  },
  escalate: {
    tone: 'secondary',
    label: () => 'Escalate to me',
    field: null,
  },
  request_rewrite_with_notes: {
    tone: 'secondary',
    label: () => 'Request rewrite with notes',
    field: 'notes',
    engineGated: 'rewrite',
  },
  exclude: {
    tone: 'destructive',
    label: () => 'Exclude from this anthology',
    // The engine does not require a reason for exclude, but the panel offers an
    // optional one; it is passed through as `reason` when present.
    field: null,
  },
};

/** Resolve an action's presentation. An UNKNOWN action still renders — as a
 *  humanized secondary button with no extra field — so the panel can never
 *  silently drop an action `status` returned. */
export function presentAction(action: string): ActionPresentation {
  const known = REGISTRY[action];
  if (known) return { action, ...known };
  return { action, tone: 'secondary', label: () => titleCase(action), field: null };
}

const TONE_RANK: Record<ActionTone, number> = { primary: 0, secondary: 1, destructive: 2 };

/** Actions the panel refuses to render even if `status` somehow returns them.
 *  `done` is owned SOLELY by the QC auto-scorer (≥ 8.5) and the U11 route 403s
 *  it — a producer must never see a Done control here. The engine has no `done`
 *  action so this never fires today; it is a belt-and-suspenders invariant that
 *  keeps "never show a done action" testable rather than incidental. */
const FORBIDDEN_DISPLAY_ACTIONS: ReadonlySet<string> = new Set(['done']);

/** Order the status-returned actions for display: primaries first (the whole
 *  point), then secondaries, then the destructive exclude — preserving the
 *  engine's order within each tone. Input is ALWAYS `status.actions`; this only
 *  DROPS forbidden actions (done) and orders the rest — it never INVENTS one. */
export function orderedActions(actions: string[]): ActionPresentation[] {
  return actions
    .filter((a) => !FORBIDDEN_DISPLAY_ACTIONS.has(a))
    .map((a, i) => ({ p: presentAction(a), i }))
    .sort((x, y) => {
      const t = TONE_RANK[x.p.tone] - TONE_RANK[y.p.tone];
      return t !== 0 ? t : x.i - y.i;
    })
    .map((e) => e.p);
}

// --------------------------------------------------------------------------- //
// The two board-door fetches (Unit U11).
// --------------------------------------------------------------------------- //

export type FetchLike = typeof fetch;

const GATE_URL = '/api/anthology/gate';

/** Read the open gate + its authoritative action set for a subject. */
export async function fetchBoardStatus(
  subjectKey: string,
  fetchImpl: FetchLike = fetch
): Promise<BoardStatusResult> {
  try {
    const res = await fetchImpl(`${GATE_URL}?subjectKey=${encodeURIComponent(subjectKey)}`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
    const body = (await res.json().catch(() => null)) as
      | (BoardStatusOk | BoardStatusFail)
      | null;
    if (body && body.ok === true) {
      return {
        ok: true,
        httpStatus: res.status,
        subjectKey: body.subjectKey,
        openGate: body.openGate ?? null,
        kind: body.kind ?? null,
        actor: body.actor ?? null,
        doors: Array.isArray(body.doors) ? body.doors : [],
        actions: Array.isArray(body.actions) ? body.actions.filter((a) => typeof a === 'string') : [],
      };
    }
    return {
      ok: false,
      httpStatus: res.status,
      reason: body && typeof body.reason === 'string' ? body.reason : 'error',
    };
  } catch {
    return { ok: false, httpStatus: 0, reason: 'error' };
  }
}

/** Record a producer decision through the board door. Omits absent fields so we
 *  never send empty strings the engine would misread. */
export async function postGateDecision(
  subjectKey: string,
  action: string,
  fields: DecideFields = {},
  fetchImpl: FetchLike = fetch
): Promise<BoardDecideResult> {
  const body: Record<string, string> = { subjectKey, action };
  for (const k of ['reason', 'notes', 'title', 'subtitle', 'confirmName'] as const) {
    const v = fields[k];
    if (typeof v === 'string' && v.trim()) body[k] = v.trim();
  }
  try {
    const res = await fetchImpl(GATE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
    });
    const parsed = (await res.json().catch(() => null)) as
      | (BoardDecideOk | BoardDecideFail)
      | null;
    if (parsed && parsed.ok === true && parsed.committed === true) {
      return {
        ok: true,
        httpStatus: res.status,
        committed: true,
        gate: parsed.gate ?? null,
        decision: parsed.decision ?? null,
        door: parsed.door ?? null,
        approvalId: parsed.approvalId ?? null,
        stageCursor: parsed.stageCursor ?? null,
        queued: parsed.queued === true,
        noop: parsed.noop === true,
      };
    }
    return {
      ok: false,
      httpStatus: res.status,
      committed: false,
      reason: parsed && typeof parsed.reason === 'string' ? parsed.reason : 'error',
      held: !!(parsed && (parsed as BoardDecideFail).held),
      openGate: parsed ? (parsed as BoardDecideFail).openGate ?? null : null,
      allowed: parsed && Array.isArray((parsed as BoardDecideFail).allowed)
        ? (parsed as BoardDecideFail).allowed
        : undefined,
      fields: parsed && Array.isArray((parsed as BoardDecideFail).fields)
        ? (parsed as BoardDecideFail).fields
        : undefined,
    };
  } catch {
    return { ok: false, httpStatus: 0, committed: false, reason: 'error', held: false };
  }
}

/** Turn an engine refusal reason into producer-facing copy (no jargon, no
 *  "AI", no em-dashes). The engine stays the authority; this is presentation. */
export function decisionErrorCopy(result: BoardDecideFail): string {
  switch (result.reason) {
    case 'missing_fields':
      return result.fields && result.fields.length
        ? `Please add: ${result.fields.map(friendlyField).join(', ')}.`
        : 'A required field is missing.';
    case 'validation_mismatch':
      return 'The typed name does not match the anthology. Retype it exactly to confirm.';
    case 'action_not_allowed_at_gate':
      return 'That decision is no longer available at this gate. The card just moved; reopen it for the current options.';
    case 'no_open_gate':
    case 'gate_not_open':
      return 'There is no open decision on this card right now.';
    case 'sole_writer_held':
    case 'secret_not_set':
    case 'not_ready':
      return 'The anthology engine is not reachable from this box yet. Try again once it is provisioned.';
    default:
      return result.held
        ? 'The engine is not ready to record this decision yet.'
        : 'That decision could not be recorded. Please retry.';
  }
}

function friendlyField(field: string): string {
  switch (field) {
    case 'reason':
      return 'a hold reason';
    case 'notes':
      return 'rewrite notes';
    case 'confirm_name':
    case 'confirmName':
      return 'the typed anthology name';
    case 'title':
      return 'a title';
    case 'producer_id':
    case 'producerId':
      return 'a signed-in producer (open this from your Command Center)';
    default:
      return field;
  }
}
