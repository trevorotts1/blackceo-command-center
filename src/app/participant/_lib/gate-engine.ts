/**
 * Server-only bridge from the Command Center to the Anthology engine gate
 * endpoint (`gate_engine.py`). SPEC 11.3 "both-door rule": the participant token
 * page and the producer board card are TWO DOORS onto the SAME gate endpoint and
 * the SAME sole writer — no gate decision is ever verified or written from a
 * second code path. So this module NEVER re-implements the HMAC token/PIN scheme
 * or the gate state machine in TypeScript; it shells out to `gate_engine.py`
 * (which mints, verifies, and records under ANTHOLOGY_GATE_TOKEN_SECRET), exactly
 * the way `src/app/api/departments/route.ts` shells out to `add-department.sh`.
 *
 * This file imports `child_process`, so it can only ever be imported by server
 * code (the page's Server Component and the `'use server'` action). Pulling it
 * into a Client Component is a build-time error, which is the intended guard.
 *
 * SECRET DISCIPLINE: ANTHOLOGY_GATE_TOKEN_SECRET is resolved INSIDE the child
 * process (from the inherited env, by label). This module never reads it, never
 * logs it, and never puts it on a command line. Only SET / NOT-SET, surfaced by
 * the engine, ever crosses back.
 */

import { execFileSync } from 'child_process';
import { existsSync, statSync } from 'fs';

/** The engine participant gates a token/PIN may scope to (SPEC S3/S4/S5). */
export type ParticipantGateId = 's3_selection' | 's4_participant' | 's5_participant';

/** A visitor's credential, carried in their capability URL / nudge link. */
export type GateCredential =
  | { kind: 'token'; token: string }
  | { kind: 'pin'; subjectKey: string; pin: string; exp: string; gate?: string };

/** Raw JSON shapes the engine emits (only the fields we consume). */
interface EngineVerify {
  ok?: boolean;
  valid?: boolean;
  subject_key?: string;
  gate?: string;
  expires_at?: number;
  reason?: string;
  code?: string;
  secret_status?: string;
}
interface EngineStatus {
  ok?: boolean;
  open_gate?: string | null;
  actor?: string;
  doors?: string[];
  actions?: string[];
  reason?: string;
  note?: string;
  // Board-door addition (SPEC B10): `kind` discriminates participant vs
  // anthology (assembly) subjects so the operator panel can label the card.
  kind?: string;
  // ASSEMBLY passthrough (U9/U13). For an ASSEMBLY subject, cmd_status also
  // emits the S9 assembly_state, the readiness summary (anthology_state
  // `_readiness`), and U9's ordering view (`build_ordering_view` /
  // `cockpit_view`). These are OPERATOR-facing data (chapter titles,
  // contributor names, word counts, one-line rationale) and carry NO secret —
  // the board bridge RELAYS them verbatim to the Assembly cockpit, whose parser
  // (assembly-cockpit-logic.ts) is the source of truth for their shape. They are
  // absent for participant subjects and on engines that do not yet surface them.
  assembly_state?: string | null;
  readiness?: unknown;
  ordering?: unknown;
  cockpit_view?: unknown;
}
interface EngineDecide {
  ok?: boolean;
  committed?: boolean;
  gate?: string;
  decision?: string;
  base_queued?: boolean;
  noop?: boolean;
  reason?: string;
  code?: string;
  secret_status?: string;
  // Board-door additions (SPEC B10). All operator-facing and safe; NONE carry a
  // secret. `detail`/`writer_rc` are DELIBERATELY not consumed by the board
  // bridge below (they can echo a file path / raw writer error) — only the coarse
  // `reason` + these structured hints cross back.
  door?: string;
  approval_id?: string | number | null;
  stage_cursor?: string | number | null;
  open_gate?: string | null;
  fields?: unknown;
  allowed?: unknown;
}

/** Engine exit codes (gate_engine.py house convention). */
const EX_OK = 0;
const EX_ERR = 1;
const EX_REFUSE = 2;
const EX_GATE = 3;

/**
 * A normalized, still-internal result of loading a gate. The client-clean
 * serializer (serialize.ts) turns this into the visitor-facing view — this shape
 * itself is NEVER sent to the browser.
 */
export type GateLoad =
  | {
      ok: true;
      gate: ParticipantGateId;
      actions: string[];
      expiresAt: number | null;
      credential: GateCredential;
    }
  | { ok: false; status: GateFailure };

/**
 * A normalized, still-internal decision result. Also serialized before it ever
 * reaches the browser.
 */
export type DecideResult =
  | { ok: true; queued: boolean; noop: boolean }
  | { ok: false; status: GateFailure };

/**
 * Coarse failure buckets. Deliberately COARSE so the serializer can map them to
 * honest-but-generic copy without ever echoing an engine reason code, an
 * internal id, or which of several refusal causes fired (no oracle for an
 * attacker probing tokens).
 */
export type GateFailure =
  | 'expired' // token/PIN past its hard expiry
  | 'invalid' // forged / foreign / replayed / malformed / no-credential
  | 'nothing_open' // subject known but not at an open gate, or unknown subject
  | 'not_ready' // engine held: secret unset, script/python absent, mirror held
  | 'error'; // unexpected

const PARTICIPANT_GATES: ReadonlySet<string> = new Set<ParticipantGateId>([
  's3_selection',
  's4_participant',
  's5_participant',
]);

// --------------------------------------------------------------------------- //
// Script + interpreter resolution (mirrors findAddDepartmentScript()).
// --------------------------------------------------------------------------- //

/**
 * Locate `gate_engine.py`. It ships in the Anthology engine skill (Skill 59).
 * When the Command Center runs inside the OpenClaw container the payload lives
 * under /data/.openclaw/skills/59-anthology-engine/scripts/; fall back to a
 * $HOME-relative path for Mac dev installs. An explicit ANTHOLOGY_GATE_ENGINE
 * override wins (used by the canary box / tests).
 */
function findGateEngineScript(): string | null {
  const candidates = [
    process.env.ANTHOLOGY_GATE_ENGINE,
    '/data/.openclaw/skills/59-anthology-engine/scripts/gate_engine.py',
    `${process.env.HOME}/.openclaw/skills/59-anthology-engine/scripts/gate_engine.py`,
  ].filter((p): p is string => typeof p === 'string' && p.length > 0);
  for (const p of candidates) {
    try {
      if (existsSync(p) && statSync(p).isFile()) return p;
    } catch {
      /* ignore and try the next candidate */
    }
  }
  return null;
}

function pythonBin(): string {
  return process.env.ANTHOLOGY_PYTHON_BIN || 'python3';
}

/**
 * Run one `gate_engine.py <subcmd> --json ...` invocation. Returns the exit code
 * and parsed JSON (or null when the process could not run / produced no JSON).
 * The child INHERITS this process's env so the engine resolves
 * ANTHOLOGY_GATE_TOKEN_SECRET / ANTHOLOGY_STATE_DIR itself — we never touch them.
 * FAIL-SOFT: any spawn/parse problem is reported as a held/error result, never
 * thrown up into the request, and never logged with argv (argv can carry a PIN).
 */
function runGateEngine(
  subcmd: 'verify' | 'status' | 'decide',
  args: string[],
  timeoutMs: number
): { code: number; json: unknown | null } {
  const script = findGateEngineScript();
  if (!script) return { code: EX_GATE, json: null }; // not provisioned → held

  const argv = [script, subcmd, '--json', ...args];
  try {
    const out = execFileSync(pythonBin(), argv, {
      encoding: 'utf-8',
      timeout: timeoutMs,
      // Inherit env for secret/state resolution; never surface stdout on error.
      env: process.env,
      maxBuffer: 4 * 1024 * 1024,
    });
    return { code: EX_OK, json: parseLastJsonLine(out) };
  } catch (err: unknown) {
    // execFileSync throws on a non-zero exit; the engine still prints its JSON
    // refusal on stdout in that case, so recover both the code and the payload.
    const e = err as { status?: number | null; stdout?: Buffer | string };
    const code = typeof e?.status === 'number' ? e.status : EX_ERR;
    const stdout =
      typeof e?.stdout === 'string'
        ? e.stdout
        : e?.stdout
          ? e.stdout.toString('utf-8')
          : '';
    return { code, json: stdout ? parseLastJsonLine(stdout) : null };
  }
}

function parseLastJsonLine(out: string): unknown | null {
  const lines = out
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      return JSON.parse(lines[i]);
    } catch {
      /* keep scanning upward for the machine-readable line */
    }
  }
  return null;
}

// --------------------------------------------------------------------------- //
// Credential → engine argv. A token self-describes its subject (we decode the
// UNVERIFIED claim only to name the --subject-key; the engine's signature check
// binds it, so a forged pk dies as bad_signature). A PIN carries its scope in
// the URL; the engine's HMAC binds (subject, gate, exp) so tampering is caught.
// --------------------------------------------------------------------------- //

/**
 * Decode the token's payload segment WITHOUT verifying it, purely to learn the
 * claimed subject key so we can name it to the engine. NOT trusted: the engine
 * re-verifies the HMAC over the whole payload (subject + gate + expiry), so a
 * tampered subject fails there. Never rendered.
 */
export function claimedSubjectFromToken(token: string): string | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const pad = b64.length % 4 === 0 ? '' : '='.repeat(4 - (b64.length % 4));
    const json = Buffer.from(b64 + pad, 'base64').toString('utf-8');
    const claim = JSON.parse(json) as { pk?: unknown };
    return typeof claim.pk === 'string' && claim.pk.length > 0 ? claim.pk : null;
  } catch {
    return null;
  }
}

function credentialArgs(cred: GateCredential): { subjectKey: string; args: string[] } | null {
  if (cred.kind === 'token') {
    const subjectKey = claimedSubjectFromToken(cred.token);
    if (!subjectKey) return null;
    return { subjectKey, args: ['--subject-key', subjectKey, '--token', cred.token] };
  }
  // PIN credential.
  if (!cred.subjectKey || !cred.pin || !cred.exp) return null;
  const args = ['--subject-key', cred.subjectKey, '--pin', cred.pin, '--exp', cred.exp];
  if (cred.gate) args.push('--gate', cred.gate);
  return { subjectKey: cred.subjectKey, args };
}

function failureFromVerify(code: number, json: EngineVerify | null): GateFailure {
  if (json && typeof json.reason === 'string') {
    const r = json.reason;
    if (r === 'expired') return 'expired';
    if (r === 'secret_not_set' || r === 'secret_unavailable') return 'not_ready';
    if (r === 'no_open_gate' || r === 'unknown_subject') return 'nothing_open';
    // foreign_subject | foreign_gate | bad_signature | malformed | replayed |
    // no_credential → a single opaque "invalid".
    return 'invalid';
  }
  if (code === EX_GATE) return 'not_ready'; // held: script/python/secret/mirror absent
  if (code === EX_REFUSE) return 'invalid';
  return 'error';
}

// --------------------------------------------------------------------------- //
// Public bridge API (all still-internal shapes; serialize before the browser).
// --------------------------------------------------------------------------- //

/**
 * Authorize a visitor's credential and resolve the single gate their page may
 * serve. Two engine calls: `verify` (authorizes the credential; the engine
 * scopes it to the OPEN gate, so a token for a now-closed gate is refused) then
 * `status` (the authoritative action set for that open gate). Read-only; no
 * state is written.
 */
export function loadGate(cred: GateCredential): GateLoad {
  const resolved = credentialArgs(cred);
  if (!resolved) return { ok: false, status: 'invalid' };

  // 1. verify (non-consuming) — the credential must be valid AND for the open gate.
  const v = runGateEngine('verify', resolved.args, 10_000);
  const vjson = (v.json ?? null) as EngineVerify | null;
  if (v.code !== EX_OK || !vjson || vjson.valid !== true || typeof vjson.gate !== 'string') {
    return { ok: false, status: failureFromVerify(v.code, vjson) };
  }
  const gate = vjson.gate;
  if (!PARTICIPANT_GATES.has(gate)) {
    // A verified credential can only ever be for a participant gate, but guard
    // anyway so a producer/assembly gate never renders on the public page.
    return { ok: false, status: 'nothing_open' };
  }

  // 2. status — authoritative actions for the open gate (source of truth, no
  //    drift vs a hand-maintained TS table).
  const s = runGateEngine('status', ['--subject-key', resolved.subjectKey], 10_000);
  const sjson = (s.json ?? null) as EngineStatus | null;
  if (s.code !== EX_OK || !sjson || sjson.ok !== true) {
    return { ok: false, status: 'nothing_open' };
  }
  // The gate must still be the one we authorized (it could have advanced between
  // the two reads). If it moved, there is nothing for this credential to serve.
  if (sjson.open_gate !== gate || !Array.isArray(sjson.actions) || sjson.actions.length === 0) {
    return { ok: false, status: 'nothing_open' };
  }

  return {
    ok: true,
    gate: gate as ParticipantGateId,
    actions: sjson.actions.filter((a): a is string => typeof a === 'string'),
    expiresAt: typeof vjson.expires_at === 'number' ? vjson.expires_at : null,
    credential: cred,
  };
}

/** Extra fields an action may carry from the form (already trimmed). */
export interface DecideFields {
  title?: string;
  subtitle?: string;
  notes?: string;
}

/**
 * Record a decision through the SINGLE both-door endpoint (`decide --door
 * token`). The engine re-verifies the credential, enforces single-use (replay
 * refused even after the gate closes), checks the action is legal at the open
 * gate, and shells the sole writer. We pass `--door token` so the ledger records
 * the provenance as `nudge_link`, exactly as SPEC 11.2/11.3 require.
 */
export function decide(
  cred: GateCredential,
  action: string,
  fields: DecideFields
): DecideResult {
  const resolved = credentialArgs(cred);
  if (!resolved) return { ok: false, status: 'invalid' };

  const args = ['--door', 'token', '--action', action, ...resolved.args];
  if (fields.title) args.push('--title', fields.title);
  if (fields.subtitle) args.push('--subtitle', fields.subtitle);
  if (fields.notes) args.push('--notes', fields.notes);

  // decide shells the sole writer (25s internal budget); give it headroom.
  const d = runGateEngine('decide', args, 30_000);
  const djson = (d.json ?? null) as EngineDecide | null;

  if (d.code === EX_OK && djson && djson.ok === true && djson.committed === true) {
    return { ok: true, queued: djson.base_queued === true, noop: djson.noop === true };
  }
  // Map refusals to the same coarse buckets used for verify.
  if (djson && typeof djson.reason === 'string') {
    const r = djson.reason;
    if (r === 'expired') return { ok: false, status: 'expired' };
    if (r === 'secret_not_set' || r === 'sole_writer_held')
      return { ok: false, status: 'not_ready' };
    if (r === 'no_open_gate' || r === 'gate_not_open')
      return { ok: false, status: 'nothing_open' };
    // replayed | foreign_gate | bad_signature | action_not_allowed_at_gate |
    // missing_fields | validation_mismatch | no_credential → opaque invalid.
    return { ok: false, status: 'invalid' };
  }
  if (d.code === EX_GATE) return { ok: false, status: 'not_ready' };
  if (d.code === EX_REFUSE) return { ok: false, status: 'invalid' };
  return { ok: false, status: 'error' };
}

// --------------------------------------------------------------------------- //
// SPEC B10 — the SECOND door: the producer/assembly board.
//
// The board door is the exact same both-door endpoint (`gate_engine.py`, the one
// sole writer) reached with `--door board` instead of `--door token`. It carries
// NO participant credential — the Command Center session (same-origin passthrough
// in src/middleware.ts) authenticates the operator, and the engine records the
// provenance as `dashboard`. These two functions REUSE the private runGateEngine /
// findGateEngineScript / EX_* map above; they add no new script path and touch no
// secret (the board door never even resolves ANTHOLOGY_GATE_TOKEN_SECRET — only
// the token door does).
//
// Unlike the participant serializer, board results are OPERATOR-facing, so they
// surface the engine's own reason vocabulary (e.g. `missing_fields`,
// `validation_mismatch`, `action_not_allowed_at_gate`) — there is no token-oracle
// concern for a session-authenticated producer. What they NEVER surface is the
// secret, the argv, or the engine's raw `detail`/`writer_rc` plumbing.
// --------------------------------------------------------------------------- //

/** Producer/assembly board status (operator-facing; NOT the coarse public view). */
export type BoardStatus =
  | {
      ok: true;
      subjectKey: string;
      /** The single open gate id (e.g. `s1_producer`, `s9_ready`), or null when
       *  the subject is known but not currently at a gate (a writing stage). */
      openGate: string | null;
      kind: 'participant' | 'anthology' | null;
      actor: string | null;
      doors: string[];
      /** The AUTHORITATIVE action set for the open gate — the panel renders
       *  exactly these, never a hand-maintained table. */
      actions: string[];
      /** ASSEMBLY passthrough (U9/U13) — RELAYED verbatim from cmd_status for an
       *  assembly subject, undefined otherwise. The board bridge does not reshape
       *  them; the Assembly cockpit's parser (assembly-cockpit-logic.ts) is the
       *  source of truth for their shape. None carries a secret. */
      assemblyState?: string | null;
      readiness?: unknown;
      ordering?: unknown;
    }
  | { ok: false; reason: BoardStatusFailure };

/** Board status failure buckets (operator-facing). */
export type BoardStatusFailure =
  | 'unknown_subject' // no such participant/anthology in the mirror
  | 'not_ready' // engine not provisioned / mirror held
  | 'error';

/**
 * Read-only: the open gate + its authoritative action set for a board subject.
 * `subjectKey` is a participant_key (contains `::`) or an anthology_id — the
 * engine discriminates it itself. Never writes; no credential; no secret.
 */
export function boardStatus(subjectKey: string): BoardStatus {
  const key = subjectKey.trim();
  if (!key) return { ok: false, reason: 'unknown_subject' };

  const s = runGateEngine('status', ['--subject-key', key], 10_000);
  const j = (s.json ?? null) as EngineStatus | null;

  if (s.code === EX_OK && j && j.ok === true) {
    const kind = j.kind === 'participant' || j.kind === 'anthology' ? j.kind : null;
    const out: BoardStatus = {
      ok: true,
      subjectKey: key,
      openGate: typeof j.open_gate === 'string' ? j.open_gate : null,
      kind,
      actor: typeof j.actor === 'string' ? j.actor : null,
      doors: Array.isArray(j.doors) ? j.doors.filter((d): d is string => typeof d === 'string') : [],
      actions: Array.isArray(j.actions)
        ? j.actions.filter((a): a is string => typeof a === 'string')
        : [],
    };
    // RELAY the ASSEMBLY passthrough verbatim (U9/U13) — never stripped, never
    // reshaped. Only these three named, operator-facing fields cross back; the
    // cockpit re-parses them. Attached only when present so a participant/plain
    // status stays byte-identical to before. `ordering` accepts the engine's
    // `cockpit_view` alias (U9's original key).
    if (typeof j.assembly_state === 'string') out.assemblyState = j.assembly_state;
    if (j.readiness && typeof j.readiness === 'object') out.readiness = j.readiness;
    const ordering = j.ordering ?? j.cockpit_view;
    if (ordering && typeof ordering === 'object') out.ordering = ordering;
    return out;
  }
  // cmd_status emits EX_GATE + reason:"unknown_subject" for an absent subject, and
  // runGateEngine returns EX_GATE + null json when the engine is not provisioned.
  if (j && j.reason === 'unknown_subject') return { ok: false, reason: 'unknown_subject' };
  if (s.code === EX_GATE) return { ok: false, reason: 'not_ready' };
  return { ok: false, reason: 'error' };
}

/** Extra fields a board decision may carry. All optional; the engine enforces
 *  which are required per action (no field-requirement table is duplicated here). */
export interface BoardDecideFields {
  /** hold reason (engine requires it for `hold`). */
  reason?: string;
  /** rewrite notes (engine requires them for `request_rewrite_with_notes`). */
  notes?: string;
  title?: string;
  subtitle?: string;
  /** typed anthology name confirming `ready_to_assemble`. */
  confirmName?: string;
  /** operator identity for the S9 gates; the route sources it from
   *  `x-operator-email`. Harmlessly ignored by the engine for non-S9 gates. */
  producerId?: string;
  /** CONFIRM-ORDER (U9/U13). The producer's finalized running order (participant
   *  keys / chapter ids in sequence) plus the explicit opener + last co-author.
   *  Passed to `decide --action <finalize action>` (confirm_order / finalize_order
   *  / …); the engine persists the adjusted order and triggers the finale write.
   *  Ignored by the engine for other actions. `order` is JSON-encoded onto the
   *  argv; opener/closer are ids. */
  order?: string[];
  opener?: string | null;
  closer?: string | null;
}

/** Board decision result (operator-facing). */
export type BoardDecide =
  | {
      ok: true;
      committed: true;
      gate: string | null;
      decision: string | null;
      /** Ledger provenance — always `dashboard` for the board door. */
      door: string | null;
      approvalId: string | null;
      stageCursor: string | null;
      /** base ledger unreachable → durably queued to the local mirror. */
      queued: boolean;
      noop: boolean;
    }
  | {
      ok: false;
      committed: false;
      /** the engine's own reason code (operator-facing, secret-free). */
      reason: string;
      /** true for an EX_GATE-class result (gate not open / engine held). */
      held: boolean;
      openGate?: string | null;
      /** the allowed action set, when the reason is `action_not_allowed_at_gate`. */
      allowed?: string[];
      /** the missing field names, when the reason is `missing_fields`. */
      fields?: string[];
    };

function coerceIdish(v: string | number | null | undefined): string | null {
  if (v === null || v === undefined) return null;
  return typeof v === 'string' ? v : String(v);
}

/**
 * Record a producer/assembly decision through the board door of the single
 * both-door endpoint (`decide --door board`). The engine is the authority: it
 * resolves the open gate, checks the action is legal there, enforces the S9
 * own-producer/typed-name guards, and shells the sole ledger writer. This bridge
 * only constructs argv and maps the exit-code contract — it re-derives no gate
 * truth and touches no secret. The secret NEVER appears on the argv it builds.
 */
export function decideBoard(
  subjectKey: string,
  action: string,
  fields: BoardDecideFields
): BoardDecide {
  const key = subjectKey.trim();
  const act = action.trim();
  if (!key || !act) {
    return { ok: false, committed: false, reason: 'invalid_request', held: false };
  }

  const args = ['--door', 'board', '--subject-key', key, '--action', act];
  if (fields.reason) args.push('--reason', fields.reason);
  if (fields.notes) args.push('--notes', fields.notes);
  if (fields.title) args.push('--title', fields.title);
  if (fields.subtitle) args.push('--subtitle', fields.subtitle);
  if (fields.confirmName) args.push('--confirm-name', fields.confirmName);
  if (fields.producerId) args.push('--producer-id', fields.producerId);
  // CONFIRM-ORDER fields (U9/U13). Only present for the finalize-action set (the
  // route gates on isFinalizeAction before populating them). The finalized order
  // is JSON-encoded so a single argv token carries the whole sequence; opener /
  // closer are single ids. The engine validates them against the finalized set.
  if (fields.order && fields.order.length) args.push('--order', JSON.stringify(fields.order));
  if (fields.opener) args.push('--opener', fields.opener);
  if (fields.closer) args.push('--closer', fields.closer);

  // decide shells the sole writer (25s internal budget); give it headroom.
  const d = runGateEngine('decide', args, 30_000);
  const j = (d.json ?? null) as EngineDecide | null;

  if (d.code === EX_OK && j && j.ok === true && j.committed === true) {
    return {
      ok: true,
      committed: true,
      gate: typeof j.gate === 'string' ? j.gate : null,
      decision: typeof j.decision === 'string' ? j.decision : null,
      door: typeof j.door === 'string' ? j.door : null,
      approvalId: coerceIdish(j.approval_id),
      stageCursor: coerceIdish(j.stage_cursor),
      queued: j.base_queued === true,
      noop: j.noop === true,
    };
  }

  // Refusal / held. Surface the engine's coarse reason (never `detail`/argv), the
  // exit-code class (EX_GATE ⇒ held), and the two structured hints the panel uses.
  const reason =
    j && typeof j.reason === 'string' ? j.reason : d.code === EX_GATE ? 'not_ready' : 'error';
  const out: BoardDecide = {
    ok: false,
    committed: false,
    reason,
    held: d.code === EX_GATE,
  };
  if (j && typeof j.open_gate === 'string') out.openGate = j.open_gate;
  if (j && Array.isArray(j.allowed)) {
    out.allowed = (j.allowed as unknown[]).filter((a): a is string => typeof a === 'string');
  }
  if (j && Array.isArray(j.fields)) {
    out.fields = (j.fields as unknown[]).filter((f): f is string => typeof f === 'string');
  }
  return out;
}
