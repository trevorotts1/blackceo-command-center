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
import { queryOne, queryAll, run } from '@/lib/db';
import { latestExecution } from '@/lib/execution-attempts';
import { comparePersonaManifest, dispatchedPersonaShas, personaId, type PersonaManifest } from '@/lib/persona-conformance';
import { personaBundleHash } from '@/lib/persona-state';

export const PERSONA_MISMATCH_EVENT_TYPE = 'persona_mismatch';

/** The shape the producer posts as `task_activities.metadata` to report the
 * personas it ACTUALLY used at the copy step (B-U6). */
export interface PersonaUsedReport extends PersonaManifest {
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
  /** Which comparison diverged (comparePersonaManifest reason, or the
   * stored-vs-dispatched `persona_bundle_revision_mismatch`). The chip title
   * must not claim producer divergence when the producer was honest and the
   * STORED decision moved — reason is what tells the two apart. */
  reason?: string | null;
  /** Only for `persona_bundle_revision_mismatch`: 'stored' = the stored bundle
   * was rebuilt after dispatch; 'producer' = the producer reported a revision
   * other than the one it was handed. Never invented for other reasons. */
  revision_source?: 'stored' | 'producer' | null;
}

/** ONE normalisation rule, shared with the conformance comparator: blank, and
 * the literal texts "null"/"undefined", are non-declarations — never values to
 * compare against each other. */
const clean = personaId;

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
    const task = queryOne<{ voice_persona_id:string|null;persona_contract_version:number }>('SELECT voice_persona_id,persona_contract_version FROM tasks WHERE id=?',[taskId]);
    const declared=clean(task?.voice_persona_id),used=clean(report.voice_persona_id);
    const page=clean(report.scope) ?? clean(report.page);
    let mismatch=declared && used && declared!==used ? 'persona_voice_mismatch' : null;
    // Hoisted: the event message and the chip payload below are built OUTSIDE
    // the persona-contract branch and need these.
    let rebuilt=false;
    let producerRevisionDrift=false;
    let dispatchedRoot:string|null=null;
    let revisionSource:'stored'|'producer'|null=null;
    if(task?.persona_contract_version){
      const execution=latestExecution(taskId);
      if(!execution || report.execution_id!==execution.id)return null;
      const row=page?queryOne<{bundle_json:string}>('SELECT bundle_json FROM task_persona_bundle_scope WHERE task_id=? AND scope=?',[taskId,page]):queryOne<{bundle_json:string}>('SELECT bundle_json FROM task_persona_bundle WHERE task_id=?',[taskId]);
      // ONE rule, one comparison: the chip and the QC gap both come from
      // comparePersonaManifest, measured against the bundle sha THIS execution
      // was handed at dispatch. Never a second, differently-spelled comparison.
      const dispatched=dispatchedPersonaShas(report.execution_id);
      // A39 stored-vs-dispatched: the STORED bundle must still be the one this
      // execution was handed at dispatch. A rebuild in between (a QC re-route
      // that re-persisted a different decision) is a mismatch, never silence —
      // the producer's `used` leg alone cannot see it. Fail-soft: no recorded
      // snapshot (a pre-upgrade execution) skips, exactly like the revision
      // check in comparePersonaManifest.
      // ponytail: root reports only; the scope leg keeps its own checks.
      const storedSha=!page&&row?personaBundleHash(JSON.parse(row.bundle_json)):null;
      dispatchedRoot=dispatched?.root ?? null;
      rebuilt=!!(storedSha&&dispatchedRoot&&storedSha!==dispatchedRoot);
      mismatch=rebuilt?'persona_bundle_revision_mismatch':(row?comparePersonaManifest(JSON.parse(row.bundle_json),report,page?dispatched?.scopes[page]:dispatchedRoot):'persona_scope_unregistered');
      // Stored == dispatched, yet the revision check moved: the producer
      // reported a revision other than the one it was handed (leg (b)).
      producerRevisionDrift = !rebuilt && mismatch === 'persona_bundle_revision_mismatch';
      revisionSource = rebuilt ? 'stored' : producerRevisionDrift ? 'producer' : null;
    } else if(!declared||!used)return null;
    const mismatchKey=JSON.stringify([report.execution_id??'legacy',page??'root']);
    if(!mismatch){
      const open=queryOne<{id:string}>("SELECT id FROM events WHERE task_id=? AND type='persona_mismatch' AND COALESCE(json_extract(metadata,'$.mismatch_key'),'legacy')=?",[taskId,mismatchKey]);
      if(open)run('INSERT INTO events(id,type,task_id,message,metadata,created_at) VALUES(?,?,?,?,?,?)',[uuidv4(),'persona_mismatch_resolved',taskId,'Current persona declaration agrees with the stored decision.',JSON.stringify({mismatch_key:mismatchKey,page,execution_id:report.execution_id}),new Date().toISOString()]);
      return null;
    }

    const existing = queryOne<{ id: string }>(
      `SELECT id FROM events
        WHERE type = ?
          AND task_id = ?
          AND json_extract(metadata, '$.declared_voice_persona_id') = ?
          AND json_extract(metadata, '$.used_voice_persona_id') = ?
          AND json_extract(metadata, '$.mismatch_key') = ?
          AND json_extract(metadata, '$.reason') = ?
          AND NOT EXISTS (SELECT 1 FROM events resolved WHERE resolved.task_id=events.task_id AND resolved.type='persona_mismatch_resolved' AND json_extract(resolved.metadata,'$.mismatch_key')=? AND resolved.rowid>events.rowid)`,
      [PERSONA_MISMATCH_EVENT_TYPE, taskId, declared, used, mismatchKey, mismatch, mismatchKey],
    );

    if (!existing) {
      // The chip title/feeds read this text, so it must name the comparison
      // that actually diverged. Three distinct situations hid behind one
      // wording: (a) the STORED decision moved after dispatch; (b) the producer
      // ran a different revision than it was handed; (c) genuine voice/topic/
      // roles divergence. (a) and (b) must never be worded as producer
      // divergence from the declared voice — that was the live false-failure
      // class this furnace closed.
      const message = rebuilt
        ? `[PERSONA-MISMATCH] stored decision revision changed after dispatch for execution ` +
          `"${report.execution_id}" — the bundle the producer was handed is no longer the stored one. ` +
          `Re-dispatch or restore the decision; never silent.`
        : producerRevisionDrift
          ? `[PERSONA-MISMATCH] producer reported bundle revision "${clean(report.bundle_sha)}" but execution ` +
            `"${report.execution_id}" was dispatched "${dispatchedRoot}" — assigned-vs-used revision ` +
            `divergence, never silent.`
          : `[PERSONA-MISMATCH] declared voice "${declared}" but the producer reported writing ` +
            `with "${used}"${page ? ` on page "${page}"` : ''} — declared-vs-used divergence, never silent.`;
      run(
        `INSERT INTO events (id, type, task_id, message, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
        [
          uuidv4(),
          PERSONA_MISMATCH_EVENT_TYPE,
          taskId,
          message,
          JSON.stringify({
            page, mismatch_key:mismatchKey, reason:mismatch, execution_id:report.execution_id,
            revision_source: revisionSource,
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

    // Historical payload for the classic declared-vs-used divergences (the
    // board chip shape other units pin); the revision discriminator rides ONLY
    // on revision mismatches — the A39 stored-vs-dispatched case must be
    // distinguishable from producer divergence, everything else keeps its shape.
    const baseInfo = { declared_voice_persona_id: declared, used_voice_persona_id: used, page };
    return revisionSource ? { ...baseInfo, reason: mismatch, revision_source: revisionSource } : baseInfo;
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
    const rows=queryAll<{type:string;metadata:string|null}>("SELECT type,metadata FROM events WHERE task_id=? AND type IN ('persona_mismatch','persona_mismatch_resolved') ORDER BY created_at DESC,rowid DESC",[taskId]);
    const seen=new Set<string>();
    const execution=latestExecution(taskId);
    for(const row of rows){
      if(!row.metadata)continue;
      const parsed=JSON.parse(row.metadata);
      if(execution && parsed.execution_id!==execution.id)continue;
      const key=parsed.mismatch_key??'legacy';if(seen.has(key))continue;seen.add(key);
      if(row.type==='persona_mismatch_resolved')continue;
      const revisionSource = clean(parsed.revision_source);
      const baseInfo = {declared_voice_persona_id:clean(parsed.declared_voice_persona_id),used_voice_persona_id:clean(parsed.used_voice_persona_id),page:clean(parsed.page)};
      return revisionSource ? {...baseInfo, reason:clean(parsed.reason), revision_source:revisionSource as 'stored'|'producer'} : baseInfo;
    }
    return null;
  } catch {
    return null;
  }
}
