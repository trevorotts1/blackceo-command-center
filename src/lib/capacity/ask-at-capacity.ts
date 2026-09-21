/**
 * ask-at-capacity.ts — when a capacity decision is the OWNER's to make.
 *
 * WHAT THIS IS FOR
 * ----------------
 * v7.6.39 made a saturated pool overflow onto the agent's own next declared
 * model, silently. That is right almost always: the work gets done and nobody
 * is interrupted. It is wrong in exactly the cases where the alternative costs
 * the owner something they would have chosen differently about — real money, a
 * missed deadline, or the last of a balance — and in those cases the box has
 * been quietly spending their money on their behalf.
 *
 * So this module asks. Rarely, with the numbers, and with a default that runs
 * the work if nobody answers.
 *
 * THE BAR FOR ASKING IS DELIBERATELY HIGH
 * ---------------------------------------
 * A question that arrives for an ordinary queued card is worse than no question
 * at all — the owner stops reading them, and the one that mattered is lost in
 * the noise. So an ask requires ALL of:
 *
 *   1. The agent's own preferred model cannot serve this card (`askWorthy`).
 *   2. The card is not in the ROUTE lane. Ordinary work routes silently; the
 *      ask lives in the HEAVY lane. A card with no lane recorded (every card
 *      created before the intake contract) is still eligible, because the
 *      triggers below are what actually gate it.
 *   3. At least one MATERIAL trigger:
 *        • the overflow costs more than `ASK_COST_DELTA` (default 25%) more
 *          per million tokens than the primary — both prices known;
 *        • the overflow is more than `ASK_TIME_DELTA_MS` (default 30 min)
 *          slower — both medians measured;
 *        • some model in the chain has a KNOWN balance at or below the floor;
 *        • the card has a deadline the preferred provider cannot meet;
 *        • nothing in the chain can run at all;
 *        • the department is on the always-ask list.
 *
 * A trigger built on a comparison needs BOTH sides known. An unknown price or
 * an unmeasured provider produces no trigger — a question whose numbers the box
 * had to guess is not worth an owner's attention.
 *
 * THE BUDGET
 * ----------
 * At most `ASKS_PER_HOUR` (default 4) questions are SENT in any rolling hour.
 * Past that, further cards are attached to the most recent unanswered ask as a
 * BATCH and no new message goes out; answering that one ask applies to every
 * card attached to it. The cap is on messages, never on cards — a card is never
 * dropped for being the fifth.
 *
 * THE DEFAULT IS TO GET THE WORK DONE
 * -----------------------------------
 * A held card is deferred, not blocked: `next_dispatch_eligible_at` is set
 * `ASK_TIMEOUT_MIN` (default 15) ahead, exactly the way the audience-confirm
 * hold defers. If the owner does not answer, the deferral lapses, the ask is
 * read as taking the recommendation, and the card dispatches — overflow and
 * all. Silence never strands work.
 *
 * WHAT AN ANSWER CAN ACTUALLY DO
 * ------------------------------
 * Two things, and both are now REAL actions rather than shades of "proceed":
 *   • `overflow_now`  — place this run on the named declared fallback, now.
 *                      The session is created with that model pinned
 *                      (sessions.create {model}), so the run genuinely serves
 *                      there and the pool debit follows it.
 *   • `primary_only` — do NOT run while the agent's own primary is blocked;
 *                      keep waiting for that subscription, and never place.
 * Both are enforced on the dispatch path, and `primary_only` is remembered on
 * the card so it is honoured on every later tick without re-asking.
 *
 * `overflow_now` replaces the vaguer `overflow_ok` this module shipped with
 * before placement existed. That answer could only ever mean "stop asking and
 * carry on queueing", because `chat.send` takes no model and the box had no way
 * to put a run anywhere but the primary. It now names a model and moves the
 * work, which is what an owner was being asked to approve all along.
 */

import { randomUUID } from 'crypto';
import { queryAll, queryOne, run } from '@/lib/db';
import { providerLabel } from '@/lib/capacity/provider-pools';
import { isBlocked, type RouteDecision, type ScoredCandidate } from '@/lib/capacity/route-scorer';

/** Relative price increase that makes an overflow worth asking about. */
export const ASK_COST_DELTA = Math.max(
  0,
  Number.parseFloat(process.env.ASK_COST_DELTA || '0.25') || 0.25,
);

/** Extra wall time that makes an overflow worth asking about. */
export const ASK_TIME_DELTA_MS = Math.max(
  60_000,
  Number.parseInt(process.env.ASK_TIME_DELTA_MS || '1800000', 10) || 1_800_000,
);

/** Questions SENT per rolling hour. Further cards batch onto the newest open ask. */
export const ASKS_PER_HOUR = Math.max(
  1,
  Number.parseInt(process.env.ASKS_PER_HOUR || '4', 10) || 4,
);

/** How long a card waits for an answer before taking the recommendation. */
export const ASK_TIMEOUT_MS = Math.max(
  60_000,
  Number.parseInt(process.env.ASK_TIMEOUT_MIN || '15', 10) * 60_000 || 900_000,
);

/** Departments whose capacity choices are ALWAYS the owner's, however small. */
export function alwaysAskDepartments(): string[] {
  return (process.env.ASK_ALWAYS_DEPARTMENTS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** What the owner decided for one card. */
export type ProviderChoice = 'overflow_now' | 'primary_only';

export interface AskTrigger {
  /** Short machine name, recorded on the ask row. */
  kind: 'cost' | 'time' | 'balance' | 'deadline' | 'nothing_available' | 'always_ask';
  /** One clause of the question, carrying the numbers that fired it. */
  detail: string;
}

export interface AskGateDecision {
  /** True when the card should be held and the owner asked (or batched). */
  hold: boolean;
  /** Why, in machine terms. Empty when `hold` is false. */
  triggers: AskTrigger[];
  /** The full owner-facing question. Null when nothing is being asked. */
  question: string | null;
  /** What happens if nobody answers. */
  recommendation: string | null;
  /** True when the budget was spent and this card joined an existing ask. */
  batched: boolean;
  /** Why no ask is being made, for the caller's log. Null when one is. */
  skipped: string | null;
}

/** Per-million-token price gap, or null when either side is unknown. */
function costGap(preferred: ScoredCandidate, overflow: ScoredCandidate): number | null {
  const a = preferred.pricePerMTokIn;
  const b = overflow.pricePerMTokIn;
  if (a === null || b === null) return null;
  if (a === 0) return b > 0 ? Number.POSITIVE_INFINITY : 0;
  return (b - a) / a;
}

/** Measured wall-time gap, or null when either side was never measured. */
function timeGap(preferred: ScoredCandidate, overflow: ScoredCandidate): number | null {
  const a = preferred.medianLatencyMs;
  const b = overflow.medianLatencyMs;
  if (a === null || b === null) return null;
  return b - a;
}

/**
 * Which material triggers fire for this decision. PURE — no DB, no sends — so
 * the rule can be read and tested on its own.
 */
export function askTriggers(decision: RouteDecision, department: string | null | undefined): AskTrigger[] {
  const triggers: AskTrigger[] = [];
  const { preferred, overflowTo, candidates, allBlocked } = decision;
  if (!preferred) return triggers;

  if (department && alwaysAskDepartments().includes(department)) {
    triggers.push({ kind: 'always_ask', detail: `${department} always asks before a provider change` });
  }
  if (allBlocked) {
    triggers.push({
      kind: 'nothing_available',
      detail: 'no model this agent declares can run right now',
    });
  }
  if (preferred.meetsDeadline === false) {
    triggers.push({
      kind: 'deadline',
      detail: `${providerLabel(preferred.provider)} cannot meet this card's deadline`,
    });
  }
  const broke = candidates.find((c) => c.affordable === false);
  if (broke) {
    triggers.push({
      kind: 'balance',
      detail: `${providerLabel(broke.provider)} is down to ${broke.balance}`,
    });
  }
  if (overflowTo) {
    const gap = costGap(preferred, overflowTo);
    if (gap !== null && gap > ASK_COST_DELTA) {
      triggers.push({
        kind: 'cost',
        detail:
          `${providerLabel(overflowTo.provider)} costs ${overflowTo.pricePerMTokIn} per million tokens ` +
          `against ${preferred.pricePerMTokIn} on ${providerLabel(preferred.provider)}`,
      });
    }
    const slower = timeGap(preferred, overflowTo);
    if (slower !== null && slower > ASK_TIME_DELTA_MS) {
      triggers.push({
        kind: 'time',
        detail:
          `${providerLabel(overflowTo.provider)} typically takes ${Math.round(slower / 60_000)} minutes ` +
          `longer than ${providerLabel(preferred.provider)}`,
      });
    }
  }
  return triggers;
}

/** The owner-facing question. Names the card, the numbers, and the two answers. */
export function buildQuestion(
  taskTitle: string,
  decision: RouteDecision,
  triggers: AskTrigger[],
): { question: string; recommendation: string } {
  const preferred = decision.preferred;
  const overflow = decision.overflowTo;
  const why = triggers.map((t) => t.detail).join('; ');
  // The recommendation is what silence buys. It names the model, not just the
  // provider, because that model is what will actually be pinned.
  const recommendation = overflow
    ? `place it on ${overflow.modelId} (${providerLabel(overflow.provider)})`
    : 'keep waiting for a slot';

  if (!overflow) {
    return {
      question:
        `"${taskTitle}" cannot start: ${why}. ` +
        `Reply GO to keep it queued and start it the moment a slot frees, or WAIT to leave it for you to look at. ` +
        `No answer in ${Math.round(ASK_TIMEOUT_MS / 60_000)} minutes and I will ${recommendation}.`,
      recommendation,
    };
  }
  return {
    question:
      `"${taskTitle}" is waiting on ${providerLabel(preferred?.provider ?? 'the primary provider')}. ` +
      `I can place it on ${overflow.modelId} (${providerLabel(overflow.provider)}) instead` +
      `${overflow.slotsFree !== null ? `, which has ${overflow.slotsFree} slot(s) free` : ''} — ${why}. ` +
      `Reply GO to place it there now, or WAIT to hold it for ${providerLabel(preferred?.provider ?? 'the primary')}. ` +
      `No answer in ${Math.round(ASK_TIMEOUT_MS / 60_000)} minutes and I will ${recommendation}.`,
    recommendation,
  };
}

export interface AskRow {
  id: string;
  task_id: string;
  batch_id: string;
  question: string;
  recommendation: string | null;
  triggers: string;
  asked_at: string;
  delivered: string | null;
  answered_at: string | null;
  answer: string | null;
}

/** This card's newest ask, answered or not. Null when it was never asked. */
export function latestAsk(taskId: string): AskRow | null {
  try {
    return (
      queryOne<AskRow>(
        'SELECT * FROM provider_choice_asks WHERE task_id = ? ORDER BY asked_at DESC LIMIT 1',
        [taskId],
      ) ?? null
    );
  } catch {
    return null;
  }
}

/** Questions actually SENT inside the rolling window. Batched rows do not count. */
export function asksSentSince(sinceIso: string): number {
  try {
    return (
      queryOne<{ n: number }>(
        "SELECT COUNT(*) AS n FROM provider_choice_asks WHERE asked_at >= ? AND delivered IS NOT NULL AND delivered <> 'batched'",
        [sinceIso],
      )?.n ?? 0
    );
  } catch {
    return 0;
  }
}

/** The newest ask nobody has answered yet, for a card to batch onto. */
export function newestOpenAsk(): AskRow | null {
  try {
    return (
      queryOne<AskRow>(
        "SELECT * FROM provider_choice_asks WHERE answered_at IS NULL AND delivered IS NOT NULL AND delivered <> 'batched' ORDER BY asked_at DESC LIMIT 1",
        [],
      ) ?? null
    );
  } catch {
    return null;
  }
}

/** True once a card's open ask has waited longer than the answer window. */
export function askExpired(ask: AskRow, nowMs = Date.now()): boolean {
  if (ask.answered_at) return false;
  const asked = Date.parse(ask.asked_at);
  return !Number.isFinite(asked) || nowMs - asked >= ASK_TIMEOUT_MS;
}

export interface AskGateInput {
  taskId: string;
  taskTitle: string;
  department?: string | null;
  /** `tasks.route_lane`. The ROUTE lane is never asked about. */
  routeLane?: string | null;
  /** `tasks.provider_choice` — an answer already on the card. */
  existingChoice?: string | null;
  decision: RouteDecision;
  nowMs?: number;
}

/**
 * Decide whether to ask. PURE apart from reading the ask ledger, so every
 * branch is testable without sending anything.
 */
export function evaluateAskGate(input: AskGateInput): AskGateDecision {
  const none = (skipped: string): AskGateDecision => ({
    hold: false,
    triggers: [],
    question: null,
    recommendation: null,
    batched: false,
    skipped,
  });
  const nowMs = input.nowMs ?? Date.now();

  if (input.existingChoice) return none(`owner already answered: ${input.existingChoice}`);
  if (!input.decision.askWorthy) return none('the agent\'s preferred model can serve this card');
  // Ordinary work routes silently. A card with NO lane recorded predates the
  // intake contract and is still eligible — the triggers gate it.
  if (input.routeLane === 'route') return none('route lane — ordinary work is never asked about');

  const existing = latestAsk(input.taskId);
  if (existing && !existing.answered_at) {
    if (askExpired(existing, nowMs)) return none('ask timed out — taking the recommendation');
    return { hold: true, triggers: [], question: null, recommendation: existing.recommendation, batched: true, skipped: null };
  }
  if (existing?.answered_at) return none(`already answered: ${existing.answer}`);

  const triggers = askTriggers(input.decision, input.department);
  if (triggers.length === 0) return none('queued, but nothing material to decide');

  const { question, recommendation } = buildQuestion(input.taskTitle, input.decision, triggers);
  const windowStart = new Date(nowMs - 3_600_000).toISOString();
  const batched = asksSentSince(windowStart) >= ASKS_PER_HOUR;
  return { hold: true, triggers, question, recommendation, batched, skipped: null };
}

/** Sends the owner-facing question. Injected so tests never reach a phone. */
export type AskSender = (taskId: string, question: string) => string;

/**
 * Record the ask and hold the card.
 *
 * The hold is a DEFERRAL, not a block: `next_dispatch_eligible_at` moves
 * `ASK_TIMEOUT_MS` ahead exactly as the audience-confirm hold does, so the
 * existing sweep re-selects the card when the window lapses and no new job is
 * needed to time an ask out. Best-effort throughout — an ask that cannot be
 * recorded must never fail a dispatch.
 */
export function holdForProviderChoice(
  taskId: string,
  gate: AskGateDecision,
  send: AskSender,
  nowMs = Date.now(),
): void {
  const now = new Date(nowMs).toISOString();
  try {
    run('UPDATE tasks SET next_dispatch_eligible_at = ? WHERE id = ?', [
      new Date(nowMs + ASK_TIMEOUT_MS).toISOString(),
      taskId,
    ]);
  } catch {
    /* pre-migration tolerant */
  }
  // A card that merely joined an open ask is already recorded; only a NEW ask
  // writes a row and sends a message.
  if (!gate.question) return;

  const open = gate.batched ? newestOpenAsk() : null;
  const batchId = open?.batch_id ?? randomUUID();
  let delivered = 'batched';
  if (!gate.batched) {
    try {
      delivered = send(taskId, gate.question);
    } catch {
      delivered = 'send_failed';
    }
  }
  try {
    run(
      `INSERT INTO provider_choice_asks (id, task_id, batch_id, question, recommendation, triggers, asked_at, delivered)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        randomUUID(),
        taskId,
        batchId,
        gate.question,
        gate.recommendation,
        JSON.stringify(gate.triggers.map((t) => t.kind)),
        now,
        delivered,
      ],
    );
  } catch {
    /* pre-migration tolerant */
  }
  try {
    run('INSERT INTO events (id, type, task_id, message, created_at) VALUES (?, ?, ?, ?, ?)', [
      randomUUID(),
      'provider_choice_pending',
      taskId,
      `[PROVIDER-CHOICE] ${gate.batched ? '(batched) ' : ''}${gate.question}`,
      now,
    ]);
  } catch {
    /* audit best-effort */
  }
}

/**
 * Apply an owner answer to one card AND to every card batched behind the same
 * question — the whole point of batching is that one answer clears the queue it
 * collected. Returns the task ids that changed.
 */
export function applyProviderChoice(taskId: string, choice: ProviderChoice, nowMs = Date.now()): string[] {
  const now = new Date(nowMs).toISOString();
  const ask = latestAsk(taskId);
  const ids = new Set<string>([taskId]);
  if (ask) {
    try {
      for (const row of queryAll<{ task_id: string }>(
        'SELECT task_id FROM provider_choice_asks WHERE batch_id = ? AND answered_at IS NULL',
        [ask.batch_id],
      )) {
        ids.add(row.task_id);
      }
    } catch {
      /* pre-migration tolerant — the named card still gets its answer */
    }
    try {
      run('UPDATE provider_choice_asks SET answered_at = ?, answer = ? WHERE batch_id = ? AND answered_at IS NULL', [
        now,
        choice,
        ask.batch_id,
      ]);
    } catch {
      /* pre-migration tolerant */
    }
  }
  for (const id of ids) {
    try {
      // `overflow_now` releases the card immediately; `primary_only` leaves it
      // deferred and is re-read on every later tick, so the owner is never
      // asked the same question twice.
      run('UPDATE tasks SET provider_choice = ?, next_dispatch_eligible_at = ? WHERE id = ?', [
        choice,
        choice === 'overflow_now' ? null : new Date(nowMs + ASK_TIMEOUT_MS).toISOString(),
        id,
      ]);
    } catch {
      /* pre-migration tolerant */
    }
    try {
      run('INSERT INTO events (id, type, task_id, message, created_at) VALUES (?, ?, ?, ?, ?)', [
        randomUUID(),
        'provider_choice_answered',
        id,
        `[PROVIDER-CHOICE] owner chose ${choice}${id === taskId ? '' : ' (batched with the card they answered)'}`,
        now,
      ]);
    } catch {
      /* audit best-effort */
    }
  }
  return [...ids];
}

/**
 * A lane correction the owner made in chat ("just answer that" / "route that").
 * Evidence for the intake's thresholds, never an instruction to this dispatch.
 */
export function recordRoutingCorrection(input: {
  taskId?: string | null;
  fromLane: string | null;
  toLane: string;
  note?: string | null;
  nowMs?: number;
}): boolean {
  try {
    run(
      'INSERT INTO routing_corrections (id, task_id, from_lane, to_lane, note, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      [
        randomUUID(),
        input.taskId ?? null,
        input.fromLane,
        input.toLane,
        input.note ?? null,
        new Date(input.nowMs ?? Date.now()).toISOString(),
      ],
    );
    return true;
  } catch {
    return false;
  }
}
