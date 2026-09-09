/**
 * src/lib/social-theme/cycles.ts — F27 durable data layer for the weekly
 * theme mini app. All queries are company-bound: every function takes the
 * verified companyId and never accepts it from client input.
 *
 * Invariants (QC-F27 / SPEC "weekly mini app data and API"):
 *   - unique(company_id, week_start_local) — week 2 cannot overwrite week 1;
 *     a duplicate cycle insert is refused, never upserted.
 *   - ONE current draft per cycle (unique company_id+cycle_id).
 *   - Revisions are monotonic; PATCH carries an expected revision and a
 *     mismatch answers 409 with both sides preserved.
 *   - submit() is idempotent and transactional: seals the answer revision,
 *     flips the cycle to 'responded', and writes the canonical dispatch
 *     outbox row in the SAME transaction. A replay or double submit returns
 *     the original receipt and never writes a second outbox row
 *     (UNIQUE(company_id, dedupe_key)).
 *   - skip closes ONLY this week's cycle; pause/resume is an explicit
 *     social_policies preference and leaves future scheduling intact.
 */

import { randomUUID } from 'crypto';
import { getDb, run, queryOne, queryAll, transaction } from '@/lib/db';

export type CycleState = 'draft' | 'invited' | 'responded' | 'closed' | 'skipped';
export type SessionStatus = 'draft' | 'submitted' | 'closed';

export interface SocialCycle {
  id: string;
  company_id: string;
  week_start_local: string;
  timezone: string;
  policy_revision: number;
  state: CycleState;
  next_action_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ThemeSession {
  id: string;
  company_id: string;
  cycle_id: string;
  questionnaire_version: string;
  answers_json: string;
  revision: number;
  status: SessionStatus;
  saved_at: string | null;
  submitted_at: string | null;
}

const ANSWER_MAX_BYTES = 64 * 1024;

/** JSON schema validation for answer payloads (strings only, bounded size). */
export function validateAnswers(answers: unknown): { ok: true; normalized: Record<string, string> } | { ok: false; error: string } {
  if (answers === null || answers === undefined) return { ok: true, normalized: {} };
  if (typeof answers !== 'object' || Array.isArray(answers)) {
    return { ok: false, error: 'answers must be an object of field -> string' };
  }
  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(answers as Record<string, unknown>)) {
    if (!/^[a-zA-Z0-9_]{1,64}$/.test(key)) {
      return { ok: false, error: `invalid answer field name: ${key}` };
    }
    if (value === null) continue; // cleared field
    if (typeof value === 'number' && Number.isFinite(value)) {
      normalized[key] = String(value);
      continue;
    }
    if (typeof value !== 'string') {
      return { ok: false, error: `answer field ${key} must be a string` };
    }
    if (value.length > 10_000) {
      return { ok: false, error: `answer field ${key} exceeds 10000 characters` };
    }
    normalized[key] = value;
  }
  if (JSON.stringify(normalized).length > ANSWER_MAX_BYTES) {
    return { ok: false, error: 'answers payload too large' };
  }
  return { ok: true, normalized };
}

/** ISO Monday week-start (client-local date, no time component). */
export function normalizeWeekStart(weekStart: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(weekStart)) return null;
  const d = new Date(`${weekStart}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  const dow = d.getUTCDay(); // 0 Sun .. 6 Sat
  const delta = dow === 0 ? -6 : 1 - dow;
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

/** Create (or return existing) cycle. Duplicate → { created:false, cycle }. */
export function ensureCycle(input: {
  companyId: string;
  weekStartLocal: string;
  timezone: string;
  policyRevision?: number;
}): { created: boolean; cycle: SocialCycle } {
  const week = normalizeWeekStart(input.weekStartLocal);
  if (!week) throw new Error('invalid week_start_local');
  const existing = getCycleByWeek(input.companyId, week);
  if (existing) return { created: false, cycle: existing };
  const now = new Date().toISOString();
  const id = randomUUID();
  run(
    `INSERT INTO social_cycles (id, company_id, week_start_local, timezone, policy_revision, state, next_action_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'draft', NULL, ?, ?)`,
    [id, input.companyId, week, input.timezone, input.policyRevision ?? 1, now, now],
  );
  return { created: true, cycle: getCycle(id, input.companyId)! };
}

export function getCycle(cycleId: string, companyId: string): SocialCycle | null {
  return (
    queryOne<SocialCycle>(
      `SELECT * FROM social_cycles WHERE id = ? AND company_id = ?`,
      [cycleId, companyId],
    ) || null
  );
}

export function getCycleByWeek(companyId: string, weekStartLocal: string): SocialCycle | null {
  return (
    queryOne<SocialCycle>(
      `SELECT * FROM social_cycles WHERE company_id = ? AND week_start_local = ?`,
      [companyId, weekStartLocal],
    ) || null
  );
}

export function listCycles(companyId: string, limit = 26): SocialCycle[] {
  return queryAll<SocialCycle>(
    `SELECT * FROM social_cycles WHERE company_id = ? ORDER BY week_start_local DESC LIMIT ?`,
    [companyId, limit],
  );
}

export function markCycleState(cycleId: string, companyId: string, state: CycleState): boolean {
  const res = run(
    `UPDATE social_cycles SET state = ?, updated_at = ? WHERE id = ? AND company_id = ? AND state != 'closed'`,
    [state, new Date().toISOString(), cycleId, companyId],
  );
  return res.changes > 0;
}

/**
 * Get-or-create THE draft session for a cycle. A submitted session is
 * returned as-is (no new draft after submit — double submit is refused at
 * the API layer with the original receipt).
 */
export function ensureDraftSession(cycle: SocialCycle): ThemeSession {
  const existing = queryOne<ThemeSession>(
    `SELECT * FROM social_theme_sessions WHERE company_id = ? AND cycle_id = ?`,
    [cycle.company_id, cycle.id],
  );
  if (existing) return existing;
  const now = new Date().toISOString();
  const id = randomUUID();
  run(
    `INSERT INTO social_theme_sessions (id, company_id, cycle_id, questionnaire_version, answers_json, revision, status, saved_at, submitted_at, created_at, updated_at)
     VALUES (?, ?, ?, '1', '{}', 0, 'draft', NULL, NULL, ?, ?)`,
    [id, cycle.company_id, cycle.id, now, now],
  );
  // Cycle moves draft → invited once an entry draft exists for it.
  markCycleState(cycle.id, cycle.company_id, 'invited');
  return queryOne<ThemeSession>(
    `SELECT * FROM social_theme_sessions WHERE id = ?`,
    [id],
  )!;
}

export interface PatchOutcome {
  kind: 'saved';
  session: ThemeSession;
}
export interface PatchConflict {
  kind: 'conflict';
  session: ThemeSession; // the SERVER's current version — neither answer lost
  clientRevision: number;
}
export type PatchResult = PatchOutcome | PatchConflict | { kind: 'not_found' } | { kind: 'immutable' } | { kind: 'invalid'; error: string };

/**
 * Revision-checked autosave. expectedRevision must match the stored
 * revision; a mismatch returns the server row (conflict information WITHOUT
 * losing either answer) and 409s at the API layer.
 */
export function patchDraftAnswers(
  sessionId: string,
  companyId: string,
  expectedRevision: number,
  answers: Record<string, string>,
): PatchResult {
  const validate = validateAnswers(answers);
  if (!validate.ok) return { kind: 'invalid', error: validate.error };
  return transaction<PatchResult>(() => {
    const row = queryOne<ThemeSession>(
      `SELECT * FROM social_theme_sessions WHERE id = ? AND company_id = ?`,
      [sessionId, companyId],
    );
    if (!row) return { kind: 'not_found' };
    if (row.status !== 'draft') return { kind: 'immutable' };
    if (row.revision !== expectedRevision) {
      return { kind: 'conflict', session: row, clientRevision: expectedRevision };
    }
    const now = new Date().toISOString();
    const merged = { ...(JSON.parse(row.answers_json || '{}') as Record<string, string>), ...answers };
    run(
      `UPDATE social_theme_sessions
          SET answers_json = ?, revision = revision + 1, saved_at = ?, updated_at = ?
        WHERE id = ? AND company_id = ? AND revision = ? AND status = 'draft'`,
      [JSON.stringify(merged), now, now, sessionId, companyId, expectedRevision],
    );
    return {
      kind: 'saved',
      session: queryOne<ThemeSession>(
        `SELECT * FROM social_theme_sessions WHERE id = ?`,
        [sessionId],
      )!,
    };
  });
}

export interface SubmitReceipt {
  receiptId: string;
  sessionId: string;
  cycleId: string;
  companyId: string;
  revision: number;
  submittedAt: string;
  alreadySubmitted: boolean;
}

export interface SubmitInput {
  companyId: string;
  cycleId: string;
  sessionId: string;
  expectedRevision: number;
  answers: Record<string, string>;
  destinationRef: string;
  policy: { mode: string; budgetUsd: number | null; approvalPolicy: string };
}

/**
 * Idempotent, transactional submit. Idempotency lives in the DB, not in a
 * process-local cache: an already-submitted session replays its receipt
 * (alreadySubmitted: true) from the sealed row, and the outbox record's
 * UNIQUE(company_id, dedupe_key) makes double dispatch impossible.
 *   1. already submitted → replay the ORIGINAL receipt, no new writes
 *      (double submit → ONE cycle, ONE outbox record).
 *   2. revision mismatch → 409-shaped conflict, server version returned.
 *   3. success → within ONE transaction: seal answers_json at expected
 *      revision (status submitted, submitted_at stamped), cycle → 'responded'
 *      with next_action_at, canonical dispatch outbox row.
 */
export function submitThemeSession(input: SubmitInput): SubmitReceipt | { kind: 'conflict'; session: ThemeSession } | { kind: 'not_found' } | { kind: 'invalid' } {
  const validate = validateAnswers(input.answers);
  if (!validate.ok) return { kind: 'invalid' };

  return transaction<
    SubmitReceipt | { kind: 'conflict'; session: ThemeSession } | { kind: 'not_found' }
  >(() => {
    const row = queryOne<ThemeSession>(
      `SELECT * FROM social_theme_sessions WHERE id = ? AND company_id = ? AND cycle_id = ?`,
      [input.sessionId, input.companyId, input.cycleId],
    );
    if (!row) return { kind: 'not_found' };
    if (row.status === 'submitted') {
      const receipt: SubmitReceipt = {
        receiptId: `sub_${row.id}_${row.revision}`,
        sessionId: row.id,
        cycleId: row.cycle_id,
        companyId: row.company_id,
        revision: row.revision,
        submittedAt: row.submitted_at || new Date().toISOString(),
        alreadySubmitted: true,
      };
      return receipt;
    }
    if (row.revision !== input.expectedRevision) {
      return { kind: 'conflict', session: row };
    }
    const now = new Date().toISOString();
    // Seal the answers.
    run(
      `UPDATE social_theme_sessions
          SET answers_json = ?, revision = revision + 1, status = 'submitted', submitted_at = ?, saved_at = ?, updated_at = ?
        WHERE id = ? AND company_id = ? AND revision = ? AND status = 'draft'`,
      [JSON.stringify(validate.normalized), now, now, now, input.sessionId, input.companyId, input.expectedRevision],
    );
    const sealed = queryOne<ThemeSession>(`SELECT * FROM social_theme_sessions WHERE id = ?`, [input.sessionId])!;
    // Cycle flips to responded with a next action.
    run(
      `UPDATE social_cycles
          SET state = 'responded', next_action_at = ?, updated_at = ?
        WHERE id = ? AND company_id = ?`,
      [now, now, input.cycleId, input.companyId],
    );
    // Canonical dispatch outbox record — same transaction. The UNIQUE
    // (company_id, dedupe_key) index makes a concurrent second submit throw
    // inside this transaction rather than double-dispatch; SQLite serializes
    // writers so exactly one submit wins.
    const dedupeKey = `cycle-submit:${input.cycleId}`;
    run(
      `INSERT INTO social_notification_outbox
         (id, company_id, event_id, dedupe_key, destination_ref, subject, body, delivery_state, attempt_count, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)`,
      [
        randomUUID(),
        input.companyId,
        `social-theme-submit:${input.cycleId}:${sealed.revision}`,
        dedupeKeyFor(input.companyId, dedupeKey),
        input.destinationRef,
        'Weekly social plan submitted',
        JSON.stringify({
          cycle_id: input.cycleId,
          session_id: input.sessionId,
          revision: sealed.revision,
          mode: input.policy.mode,
          budget_usd: input.policy.budgetUsd,
          approval_policy: input.policy.approvalPolicy,
        }),
        now,
        now,
      ],
    );
    const receipt: SubmitReceipt = {
      receiptId: `sub_${sealed.id}_${sealed.revision}`,
      sessionId: sealed.id,
      cycleId: sealed.cycle_id,
      companyId: sealed.company_id,
      revision: sealed.revision,
      submittedAt: now,
      alreadySubmitted: false,
    };
    return receipt;
  });
}

export function dedupeKeyFor(companyId: string, key: string): string {
  // Per-company namespace happens at the UNIQUE(company_id, dedupe_key) level;
  // the stored key stays human-readable for the operator outbox view.
  return key;
}

/** Outbox lookup for tests/verify + the F30 summary surface. */
export function outboxForCycle(companyId: string, cycleId: string) {
  return queryOne(
    `SELECT * FROM social_notification_outbox
      WHERE company_id = ? AND dedupe_key = ?`,
    [companyId, `cycle-submit:${cycleId}`],
  );
}

/* ── Skip / preferences ─────────────────────────────────────────────────── */

/** Skip closes ONLY this week's cycle (state 'skipped'); other weeks untouched. */
export function skipCycle(companyId: string, cycleId: string): boolean {
  const cycle = getCycle(cycleId, companyId);
  if (!cycle || cycle.state === 'responded' || cycle.state === 'closed') return false;
  run(
    `UPDATE social_cycles SET state = 'skipped', next_action_at = NULL, updated_at = ? WHERE id = ? AND company_id = ?`,
    [new Date().toISOString(), cycleId, companyId],
  );
  return true;
}

export interface SocialPolicy {
  company_id: string;
  policy_revision: number;
  role_model: string | null;
  provider: string | null;
  mode: string;
  budget_usd: number | null;
  reminder_day: string | null;
  reminder_time: string | null;
  reminders_paused: number;
  enabled_account_ids: string;
  approval_policy: string;
  evergreen_policy: string;
}

/** Explicit pause/resume preference — never touches cycle rows. */
export function setRemindersPaused(companyId: string, paused: boolean): boolean {
  ensurePolicyRow(companyId);
  run(
    `UPDATE social_policies SET reminders_paused = ?, updated_at = ? WHERE company_id = ?`,
    [paused ? 1 : 0, new Date().toISOString(), companyId],
  );
  return true;
}

export function getPolicy(companyId: string): SocialPolicy | null {
  ensurePolicyRow(companyId);
  return queryOne<SocialPolicy>(`SELECT * FROM social_policies WHERE company_id = ?`, [companyId]) || null;
}

export function ensurePolicyRow(companyId: string): SocialPolicy {
  const existing = queryOne<SocialPolicy>(`SELECT * FROM social_policies WHERE company_id = ?`, [companyId]);
  if (existing) return existing;
  const now = new Date().toISOString();
  run(
    `INSERT OR IGNORE INTO social_policies (company_id, policy_revision, mode, updated_at) VALUES (?, 1, 'standard', ?)`,
    [companyId, now],
  );
  return queryOne<SocialPolicy>(`SELECT * FROM social_policies WHERE company_id = ?`, [companyId])!;
}

/**
 * Bump the policy revision (choices changed) — new cycles stamp this
 * revision, preserving the audit trail per the social_cycles contract.
 */
export function updatePolicy(companyId: string, patch: Partial<Omit<SocialPolicy, 'company_id' | 'policy_revision'>>): SocialPolicy {
  ensurePolicyRow(companyId);
  const allowed = [
    'role_model', 'provider', 'mode', 'budget_usd', 'reminder_day', 'reminder_time',
    'enabled_account_ids', 'approval_policy', 'evergreen_policy',
  ] as const;
  const sets: string[] = [];
  const params: unknown[] = [];
  for (const key of allowed) {
    if (key in patch && patch[key] !== undefined) {
      sets.push(`${key} = ?`);
      params.push(patch[key]);
    }
  }
  if (sets.length) {
    params.push(new Date().toISOString(), companyId);
    run(
      `UPDATE social_policies SET ${sets.join(', ')}, policy_revision = policy_revision + 1, updated_at = ? WHERE company_id = ?`,
      params,
    );
  }
  return getPolicy(companyId)!;
}

/** Suggested themes: ONLY this client's approved/answered history. */
export function themeSuggestions(companyId: string, limit = 5): string[] {
  const rows = queryAll<{ answers_json: string }>(
    `SELECT answers_json FROM social_theme_sessions
      WHERE company_id = ? AND status = 'submitted'
      ORDER BY submitted_at DESC LIMIT ?`,
    [companyId, limit * 3],
  );
  const seen = new Set<string>();
  const out: string[] = [];
  for (const row of rows) {
    try {
      const answers = JSON.parse(row.answers_json || '{}') as Record<string, string>;
      const theme = (answers['theme'] || '').trim();
      if (theme && !seen.has(theme.toLowerCase())) {
        seen.add(theme.toLowerCase());
        out.push(theme);
      }
    } catch { /* malformed stored answers are skipped, never crash the screen */ }
    if (out.length >= limit) break;
  }
  return out;
}

/** Connection count helper for the assets-and-accounts screen health note. */
export function tableExists(name: string): boolean {
  return !!getDb()
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(name);
}