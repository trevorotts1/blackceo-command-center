/**
 * B-U6 / U20 — Producer reports USED personas back to the card
 * (declared-vs-used, never silent).
 *
 * Master spec `skill6-blended-persona-kanban-MASTER-SPEC-v2-2026-07-13.md`
 * §B-U6: "a bundle-carrying task can never have its blend silently ignored —
 * QC verifies the blend landed (B-U5), the card shows declared-vs-used (B-U6)."
 *
 * DECLARED = `tasks.voice_persona_id` — the resolved VOICE decision mirror
 * column (migration 090) the Command Center itself pinned onto the card.
 *
 * USED = the voice persona the PRODUCER reports it actually wrote copy with,
 * carried in a `task_activities.metadata` payload of shape:
 *   { kind: 'persona_used', page, voice_persona_id, topic_persona_id,
 *     task_persona_id, blend_directive_sha, goal }
 * — posted by the onboarding-side `cc_board.BuildPhaseDriver.persona_used()`
 * (06-ghl-install-pages/tools/cc_board.py) via the existing
 * `POST /api/tasks/:id/activities` rail (see route.ts, which calls
 * `recordPersonaUsedAndCompare` right after a successful activity insert).
 *
 * Agreement renders nothing. A divergence writes exactly ONE `persona_mismatch`
 * row onto the `events` feed-of-record per distinct (task, declared, used)
 * pair — dedup-checked first, so repeat reports of the SAME divergence never
 * re-fire (idempotent across retries/repeat runs). Fail-soft throughout: a
 * pre-migration-090 box (no `voice_persona_id` column), a task that never
 * blended (declared is NULL), or a malformed report never throws and never
 * fabricates a mismatch — it just skips the comparison.
 */
import { v4 as uuidv4 } from 'uuid';
import { queryOne, run } from '@/lib/db';

export const PERSONA_MISMATCH_EVENT_TYPE = 'persona_mismatch';

/** The shape the producer posts as `task_activities.metadata` to report the
 * personas it ACTUALLY used at the copy step (B-U6). */
export interface PersonaUsedReport {
  kind: 'persona_used';
  page?: string | null;
  voice_persona_id?: string | null;
  topic_persona_id?: string | null;
  task_persona_id?: string | null;
  blend_directive_sha?: string | null;
  goal?: string | null;
}

/** Declared-vs-used chip payload — mirrors the `persona_mismatch` field the
 * tasks GET routes attach to each row (src/lib/types.ts). */
export interface PersonaMismatchInfo {
  declared_voice_persona_id: string | null;
  used_voice_persona_id: string | null;
  page: string | null;
}

function clean(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

/** True when an activity's parsed metadata carries the B-U6 producer-report
 * contract (the explicit `kind` discriminator avoids sniffing arbitrary
 * metadata shapes that might incidentally carry a `voice_persona_id` key). */
export function isPersonaUsedReport(metadata: unknown): metadata is PersonaUsedReport {
  return (
    !!metadata &&
    typeof metadata === 'object' &&
    (metadata as Record<string, unknown>).kind === 'persona_used'
  );
}

/**
 * Compare the task's DECLARED voice persona against a producer-reported USED
 * report and, on divergence, write exactly one `persona_mismatch` event
 * (dedup'd on the (task, declared, used) triple). Called synchronously from
 * the activities POST route right after the activity itself is persisted.
 * Never throws — a failure here must never fail the activity write it rides on.
 */
export function recordPersonaUsedAndCompare(
  taskId: string,
  report: PersonaUsedReport,
): PersonaMismatchInfo | null {
  try {
    const task = queryOne<{ voice_persona_id: string | null }>(
      'SELECT voice_persona_id FROM tasks WHERE id = ?',
      [taskId],
    );
    const declared = clean(task?.voice_persona_id);
    const used = clean(report.voice_persona_id);
    const page = clean(report.page);

    // Fail-soft: no declared voice (pre-090 box, or a task that never
    // blended) or no reported voice -> nothing to compare, never a
    // fabricated mismatch.
    if (!declared || !used) return null;
    if (declared === used) return null; // agreement renders nothing

    const existing = queryOne<{ id: string }>(
      `SELECT id FROM events
        WHERE type = ?
          AND task_id = ?
          AND json_extract(metadata, '$.declared_voice_persona_id') = ?
          AND json_extract(metadata, '$.used_voice_persona_id') = ?`,
      [PERSONA_MISMATCH_EVENT_TYPE, taskId, declared, used],
    );

    if (!existing) {
      run(
        `INSERT INTO events (id, type, task_id, message, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
        [
          uuidv4(),
          PERSONA_MISMATCH_EVENT_TYPE,
          taskId,
          `[PERSONA-MISMATCH] declared voice "${declared}" but the producer reported writing ` +
            `with "${used}"${page ? ` on page "${page}"` : ''} — declared-vs-used divergence, never silent.`,
          JSON.stringify({
            page,
            declared_voice_persona_id: declared,
            used_voice_persona_id: used,
            topic_persona_id: clean(report.topic_persona_id),
            task_persona_id: clean(report.task_persona_id),
            blend_directive_sha: clean(report.blend_directive_sha),
            goal: clean(report.goal),
          }),
          new Date().toISOString(),
        ],
      );
    }

    return { declared_voice_persona_id: declared, used_voice_persona_id: used, page };
  } catch (err) {
    console.warn(`[persona-mismatch] comparator skipped for task ${taskId} (non-fatal):`, (err as Error).message);
    return null;
  }
}

/**
 * Read-path: the newest OPEN `persona_mismatch` event for this task, if any.
 * Powers the kanban-card `persona_mismatch` chip (B-U6). Fail-soft: any query
 * error (pre-migration box, missing `events` table) returns null rather than
 * breaking the board.
 */
export function getOpenPersonaMismatch(taskId: string): PersonaMismatchInfo | null {
  try {
    const row = queryOne<{ metadata: string | null }>(
      `SELECT metadata FROM events WHERE type = ? AND task_id = ? ORDER BY created_at DESC LIMIT 1`,
      [PERSONA_MISMATCH_EVENT_TYPE, taskId],
    );
    if (!row || !row.metadata) return null;
    const parsed = JSON.parse(row.metadata) as Record<string, unknown>;
    return {
      declared_voice_persona_id: clean(parsed.declared_voice_persona_id),
      used_voice_persona_id: clean(parsed.used_voice_persona_id),
      page: clean(parsed.page),
    };
  } catch {
    return null;
  }
}
