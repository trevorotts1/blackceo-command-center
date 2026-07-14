/**
 * Cron scheduler registration for v4.0.1 P0-6.
 *
 * Registers all in-process recurring jobs via node-cron. Idempotent so it can
 * be invoked from `instrumentation.ts` on every boot and from the
 * `/api/cron/register` route without double-scheduling on Next.js hot reload
 * or repeated calls.
 *
 * Jobs:
 *   - model-refresh:  weekly, Sunday 03:00 (server local time)
 *   - usage-refresh:  every 6 hours
 *   - memory-index:   hourly, on the hour
 *
 * Each job is wrapped so a thrown error never crashes the scheduler. Errors
 * are logged and the next tick will run normally.
 */

import * as cron from 'node-cron';
import { refreshModels } from './refresh-models';
import { ALL_PROVIDERS } from '@/lib/model-providers';
import { resolveProviderApiKey } from '@/lib/provider-key-detection'; // MODEL-08 (usage-refresh key resolution)
import { runExecutionCompletionReconcile } from './execution-watcher';
import { runCeoDelegationSweep } from './ceo-delegation-sweep';
import { detectPatternsAndPropose } from '@/lib/sop-learning';
import {
  runWeeklyDoneClear,
  WEEKLY_DONE_CLEAR_CRON_EXPR,
  WEEKLY_DONE_CLEAR_CRON_TIMEZONE,
} from './weekly-done-clear';
import {
  runLssControlReview,
  LSS_CONTROL_REVIEW_CRON_EXPR,
  LSS_CONTROL_REVIEW_CRON_TIMEZONE,
} from './lss-control-review';
import { runGeneralTaskRecurrenceDetection } from './general-task-recurrence';
import { runQCReviewSweep } from './qc-review-sweep';
import { runStaleTaskSweep, STALE_TASK_SWEEP_CRON } from './stale-task-sweep';
import { runStuckInProgressSweep, STUCK_IN_PROGRESS_SWEEP_CRON } from './stuck-in-progress-sweep';
import { runInterviewNudgeSweep, INTERVIEW_NUDGE_SWEEP_CRON } from './interview-nudge-sweep';
import { runBacklogRedispatchSweep } from './backlog-redispatch-sweep';
import { runPersonaBackfillSweep } from './persona-backfill-sweep';
import { runIntakeAdvanceSweep } from './intake-advance-sweep';
import { runPortIntegrityCheck } from './port-integrity';
import { runTrustEngineSweep } from './trust-engine';
import { runBoardHygiene, BOARD_HYGIENE_CRON } from './board-hygiene';
import { runSweepLivenessSweep } from './sweep-liveness';
import { runEnvAudit } from '@/lib/env-auditor';
import { scoreTaskForQC } from '@/lib/qc-scorer';
import { queryAll, run } from '@/lib/db';
import type { QCScorerInput } from '@/lib/qc-scorer';

export interface RegisteredJob {
  name: string;
  cron: string;
  nextRun: string | null;
}

/**
 * Process-wide flag so multiple imports / hot reloads do not double-register.
 * Stored on `globalThis` so Next.js' module reloading does not lose it across
 * server-component refreshes in dev.
 */
const REGISTRY_KEY = '__BC_CRON_REGISTERED__';

interface CronGlobals {
  [REGISTRY_KEY]?: boolean;
}

type ScheduledHandle = {
  name?: string;
  getNextRun?: () => Date | null;
};

function alreadyRegistered(): boolean {
  return Boolean((globalThis as unknown as CronGlobals)[REGISTRY_KEY]);
}

function markRegistered(): void {
  (globalThis as unknown as CronGlobals)[REGISTRY_KEY] = true;
}

/**
 * C-09 / U40 — "watch the watchers". Persist a liveness tick for `name` into
 * `job_liveness` on EVERY invocation (success or failure — a tick is proof the
 * scheduler loop itself is alive, not proof the job's own logic succeeded;
 * failures are already logged separately below). Best-effort: a write failure
 * here must never affect the job's own outcome, so it is caught and logged,
 * never rethrown. src/lib/jobs/sweep-liveness.ts reads this table to detect an
 * advancer (intake-advance) or qc-review-sweep gone silent.
 */
export function recordJobTick(name: string, ranAt: string, status: 'ok' | 'error', errorMessage?: string): void {
  try {
    run(
      `INSERT INTO job_liveness (job_name, last_ran_at, last_status, last_error)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(job_name) DO UPDATE SET
         last_ran_at = excluded.last_ran_at,
         last_status = excluded.last_status,
         last_error = excluded.last_error`,
      [name, ranAt, status, errorMessage ?? null],
    );
  } catch (err) {
    console.warn(`[cron] ${name}: failed to record liveness tick:`, (err as Error).message);
  }
}

/**
 * Wrap a task body so thrown errors are caught and logged. node-cron 4 will
 * surface them via the `execution:failed` event, but we want a single log line
 * regardless of the consumer.
 */
function wrap(name: string, fn: () => Promise<unknown> | unknown): () => Promise<void> {
  return async () => {
    const startedAt = new Date().toISOString();
    try {
      console.log(`[cron] ${name} starting at ${startedAt}`);
      await fn();
      console.log(`[cron] ${name} finished`);
      recordJobTick(name, startedAt, 'ok');
    } catch (error) {
      console.error(`[cron] ${name} failed:`, error);
      recordJobTick(name, startedAt, 'error', error instanceof Error ? error.message : String(error));
    }
  };
}

/**
 * Job: weekly model registry refresh. Sundays at 03:00 server local time.
 */
async function runModelRefresh(): Promise<void> {
  // MODEL-07 KILL SWITCH. Every other job in JOBS has one; this — the only job
  // that can DESTRUCTIVELY rewrite the model catalog — had none. The sole lever
  // was DISABLE_CRON, which kills *all* cron on the box and so was never a real
  // option. When the self-destruct bug was live, that meant there was no way to
  // stop the Sunday run from re-wiping the catalog short of disabling every job.
  // Disable with DISABLE_MODEL_REFRESH_CRON=1.
  if (
    process.env.DISABLE_MODEL_REFRESH_CRON === '1' ||
    process.env.DISABLE_MODEL_REFRESH_CRON === 'true'
  ) {
    console.log('[cron] model-refresh: DISABLE_MODEL_REFRESH_CRON set, skipping');
    return;
  }
  await refreshModels(ALL_PROVIDERS);
}

/**
 * P2-04 — Job: weekly LLM env-auditor ("Deep Scan"). Sundays at 04:00 server
 * local time (offset an hour past model-refresh so it runs after the catalog
 * is current, which the auditor's model-resolution step depends on). Reads
 * this box's OWN env surfaces, redacts every value before any LLM sees it,
 * and classifies with the box's own cheap/quick-tier model — never
 * Anthropic, never the operator's model (see env-auditor.ts). Only writes
 * SUGGESTION rows; never auto-wires a key. Disable with
 * DISABLE_ENV_AUDIT_CRON=1.
 */
async function runEnvAuditWeekly(): Promise<void> {
  if (
    process.env.DISABLE_ENV_AUDIT_CRON === '1' ||
    process.env.DISABLE_ENV_AUDIT_CRON === 'true'
  ) {
    console.log('[cron] env-audit: DISABLE_ENV_AUDIT_CRON set, skipping');
    return;
  }
  const result = await runEnvAudit();
  if (!result.ok) {
    console.log(`[cron] env-audit: skipped — ${result.skipped_reason}`);
    return;
  }
  console.log(
    `[cron] env-audit: ${result.candidates_found} candidate key(s) scanned, ` +
      `${result.suggestions_saved} suggestion(s) saved` +
      (result.unreadable_providers.length > 0
        ? `, unreadable providers flagged: ${result.unreadable_providers.join(', ')}`
        : ''),
  );
}

/**
 * Job: usage-quota refresh for connectors that expose `fetchUsage()`. Stub
 * until Track B6 (Usage dashboard) wires in the persistence layer. Walks any
 * connector with a `fetchUsage()` method and logs results.
 */
async function runUsageRefresh(): Promise<void> {
  const providersWithUsage = ALL_PROVIDERS.filter((p) => typeof p.fetchUsage === 'function');
  if (providersWithUsage.length === 0) {
    console.log('[cron] usage-refresh: no providers expose fetchUsage(), skipping');
    return;
  }
  // No persistence target exists yet for usage snapshots. Track B6 owns the
  // table + writer. For now we simply confirm the connector responds so a
  // missing API key surfaces in the logs.
  //
  // MODEL-08: the API key is resolved with resolveProviderApiKey(p) — the SAME
  // multi-store, multi-alias detection the model-refresh job uses
  // (refresh-models.ts). The previous manual derivation
  // (`SLUG.toUpperCase().replace(/-/g,'_') + '_API_KEY'`) only checked the ONE
  // canonical env var, so a provider whose key lives under an alias
  // (envCandidates), in an .env file, or in openclaw.json was wrongly reported
  // as "no key" and silently skipped.
  await Promise.allSettled(
    providersWithUsage.map(async (p) => {
      const slug = p.slug;
      const keyResult = resolveProviderApiKey(p);
      if ('localEndpoint' in keyResult) {
        // Local-endpoint providers authenticate via a daemon and are unmetered —
        // no usage quota to refresh.
        console.log(`[cron] usage-refresh: ${slug} skipped (local endpoint, no usage quota)`);
        return;
      }
      if (!keyResult.found) {
        console.log(`[cron] usage-refresh: ${slug} skipped (no key; checked ${keyResult.checked.join(', ')})`);
        return;
      }
      try {
        await p.fetchUsage?.(keyResult.value);
        console.log(`[cron] usage-refresh: ${slug} ok`);
      } catch (error) {
        console.warn(`[cron] usage-refresh: ${slug} failed:`, (error as Error).message);
      }
    })
  );
}

/**
 * Job: memory index rebuild. Stub until Track B2 (memory index) wires in the
 * rebuild routine. Logs a heartbeat so the System Status panel can confirm
 * the scheduler ticked.
 */
async function runMemoryIndexRebuild(): Promise<void> {
  console.log('[cron] memory-index: heartbeat (rebuild routine not yet wired)');
}

/**
 * Job: nightly SOP learning loop (the auto-SOP-writer). Clusters recent
 * un-SOP'd completed tasks and writes candidate `sop_proposals` for owner
 * review on /sops/proposals.
 *
 * Before this job existed, `detectPatternsAndPropose()` was only reachable by
 * something externally pinging /api/cron/sop-learning (or manually running
 * scripts/sop-learning-job.ts) — so on a box with no external cron the
 * proposals queue never populated on its own. This mirrors the in-process
 * model-refresh job so the loop runs every night with zero external setup.
 *
 * Idempotent on two levels: registration is guarded by the process-wide
 * REGISTRY_KEY (so we never double-schedule), and detectPatternsAndPropose
 * itself dedupes against existing pending proposals (sop-learning.ts:290-303),
 * so re-running it never creates duplicate drafts. Opt out per box with
 * DISABLE_SOP_LEARNING_CRON=1.
 */
/**
 * PRD 2.12: Run QC verdict tagging for pending sop_proposals from the slow loop.
 *
 * The slow loop (detectPatternsAndPropose) remains human-approval-gated — this
 * does NOT auto-file. It ONLY stamps each draft proposal with a
 * [QC-PASS <score>] or [QC-FAIL <score> — needs rework] tag in evidence_summary
 * so the /sops/proposals queue shows the operator an LLM quality signal before
 * they approve. Clustering/dedup logic is UNCHANGED.
 */
async function tagPendingProposalsWithQC(): Promise<void> {
  try {
    interface ProposalRow {
      id: string;
      proposed_name: string;
      proposed_department: string | null;
      draft_steps: string | null;
      evidence_summary: string | null;
    }
    const pending = queryAll<ProposalRow>(
      `SELECT id, proposed_name, proposed_department, draft_steps, evidence_summary
       FROM sop_proposals
       WHERE status = 'pending'
         AND (evidence_summary IS NULL OR (evidence_summary NOT LIKE '%[QC-PASS%' AND evidence_summary NOT LIKE '%[QC-FAIL%'))
       ORDER BY created_at DESC
       LIMIT 20`,
      [],
    );
    if (pending.length === 0) return;

    let tagged = 0;
    for (const proposal of pending) {
      try {
        const qcInput: QCScorerInput = {
          taskId: proposal.id,
          taskTitle: proposal.proposed_name,
          taskDescription: null,
          sopSuccessCriteria: null,
          sopName: proposal.proposed_name,
          sopSteps: proposal.draft_steps,
          departmentSlug: proposal.proposed_department ?? null,
          qcAgentId: null,
          qcAgentName: null,
          qcAgentModel: null,
        };
        const qcResult = await scoreTaskForQC(qcInput);
        const verdict =
          qcResult.scoringPath === 'heuristic'
            ? `[QC-HEURISTIC ${qcResult.score.toFixed(1)}/10 — human review required (no LLM key)]`
            : qcResult.pass
            ? `[QC-PASS ${qcResult.score.toFixed(1)}/10]`
            : `[QC-FAIL ${qcResult.score.toFixed(1)}/10 — needs rework: ${qcResult.gaps.slice(0, 2).join('; ')}]`;

        const updatedEvidence = proposal.evidence_summary
          ? `${verdict}\n\n${proposal.evidence_summary}`
          : verdict;
        run(
          `UPDATE sop_proposals SET evidence_summary = ? WHERE id = ? AND status = 'pending'`,
          [updatedEvidence, proposal.id],
        );
        tagged++;
      } catch {
        // Non-fatal per proposal — continue tagging others.
      }
    }
    if (tagged > 0) {
      console.log(`[cron] sop-learning: QC verdict tagged ${tagged} pending proposal(s)`);
    }
  } catch (err) {
    console.warn('[cron] sop-learning: QC verdict tagging failed (non-fatal):', (err as Error).message);
  }
}

async function runSopLearning(): Promise<void> {
  if (process.env.DISABLE_SOP_LEARNING_CRON === '1' || process.env.DISABLE_SOP_LEARNING_CRON === 'true') {
    console.log('[cron] sop-learning: DISABLE_SOP_LEARNING_CRON set, skipping');
    return;
  }
  const result = detectPatternsAndPropose();
  console.log(
    `[cron] sop-learning: scanned ${result.scanned_tasks} completed tasks, ` +
      `${result.clusters_found} candidate clusters, ${result.proposals_created} new proposal(s)` +
      (result.proposal_ids.length > 0 ? ` [${result.proposal_ids.join(', ')}]` : '')
  );
  // PRD 2.12: Tag each pending proposal with a QC verdict (verdict-only, no auto-file).
  await tagPendingProposalsWithQC();
}

const JOBS: Array<{ name: string; expr: string; fn: () => Promise<void>; timezone?: string }> = [
  // model-refresh: Sundays 03:00 server local. DESTRUCTIVE — it can deprecate
  // catalog rows. Kill switch: DISABLE_MODEL_REFRESH_CRON=1 (see runModelRefresh).
  { name: 'model-refresh', expr: '0 3 * * 0', fn: runModelRefresh },
  // env-audit: Sundays 04:00 server local — the P2-04 LLM env-auditor "Deep
  // Scan". NON-destructive (only ever writes suggestion rows, never a key).
  // Kill switch: DISABLE_ENV_AUDIT_CRON=1.
  { name: 'env-audit', expr: '0 4 * * 0', fn: runEnvAuditWeekly },
  { name: 'usage-refresh', expr: '0 */6 * * *', fn: runUsageRefresh },
  { name: 'memory-index', expr: '0 * * * *', fn: runMemoryIndexRebuild },
  // sop-learning: nightly at 02:00 server local time — the auto-SOP-writer.
  // Mirrors the model-refresh wiring above so the proposals queue populates
  // without any external cron. Disable with DISABLE_SOP_LEARNING_CRON=1.
  { name: 'sop-learning', expr: '0 2 * * *', fn: runSopLearning },

  // --- OPTIONAL SAFETY NETS (B2 / B8) ----------------------------------------
  // These two are NOT the primary mechanism. The primary B2 path is the instant
  // agent-completion webhook (which now broadcasts task_updated immediately),
  // and the primary B4/B8 path is in-process routing in createTaskCore. These
  // crons only catch DROPPED events / pre-existing backlog. Kept low-frequency
  // on purpose. Their JOBS entries stay registered but the two legacy ADVANCERS
  // (ceo-delegation + backlog-redispatch) are PAUSED BY DEFAULT (SWEEP-01) — they
  // return immediately unless opted in per box (CEO_DELEGATION_SWEEP_ENABLED=1 /
  // BACKLOG_REDISPATCH_SWEEP_ENABLED=1). intake-advance is the single live advancer.
  //
  // execution-reconcile: every 2 minutes, catch in_progress tasks whose
  // TASK_COMPLETE report never reached the webhook.
  { name: 'execution-reconcile', expr: '*/2 * * * *', fn: runExecutionCompletionReconcile },
  // qc-review-sweep: every 2 minutes, score any review-column task that has
  // not received a qc_review event in the last 10 minutes. Catches tasks that
  // arrived in review before the scorer was wired to the completion paths.
  // Disable with DISABLE_QC_REVIEW_SWEEP=1.
  {
    name: 'qc-review-sweep',
    expr: '*/2 * * * *',
    fn: async () => {
      const result = await runQCReviewSweep();
      if (result.skippedReason) {
        console.log(`[cron] qc-review-sweep: skipped — ${result.skippedReason}`);
      } else if (result.scanned > 0) {
        console.log(`[cron] qc-review-sweep: scanned ${result.scanned} task(s), scored ${result.scored}`);
      }
    },
  },
  // ceo-delegation: every 5 minutes, push CEO-stranded backlog tasks down to
  // the right department (mostly relevant for tasks created before in-process
  // routing shipped). PAUSED BY DEFAULT (SWEEP-01) — opt in with
  // CEO_DELEGATION_SWEEP_ENABLED=1; intake-advance is the live advancer.
  { name: 'ceo-delegation', expr: '*/5 * * * *', fn: () => runCeoDelegationSweep() },

  // intake-advance: every 2 minutes — THE single board-advancement authority
  // (W8.1). Drains every intake lane (inbox/backlog/planning/pending_dispatch/
  // assigned): routes unassigned tasks, feeds the campaign board, and fires
  // autoDispatchTask so cards actually move instead of freezing in `inbox`.
  // Furnace-proof by construction — it only selects tasks under the QC cap, under
  // the dispatch attempt cap, and past their backoff window. This REPLACES the
  // backlog-redispatch + ceo-delegation sweeps as the live advancer — those two
  // are now PAUSED BY DEFAULT in-repo (SWEEP-01): each returns immediately unless
  // opted in with its *_ENABLED=1 flag (no longer relying on an env override to
  // stay off). Disable this one with INTAKE_ADVANCE_SWEEP_ENABLED=0.
  {
    name: 'intake-advance',
    expr: '*/2 * * * *',
    fn: async () => {
      const result = await runIntakeAdvanceSweep();
      if (result.skippedReason) {
        console.log(`[cron] intake-advance: skipped — ${result.skippedReason}`);
      } else if (result.scanned > 0) {
        console.log(
          `[cron] intake-advance: scanned ${result.scanned}, routed ${result.routed}, dispatched ${result.dispatched}`,
        );
      }
    },
  },

  // sweep-liveness: every 2 minutes — C-09 / U40 "watch the watchers". Reads
  // the job_liveness ticks wrap() persists for every job and, when the
  // intake-advance or qc-review-sweep advancer has gone silent for 3x its own
  // cadence, fires ONE cooldown-guarded notifySystem() alert (SYSTEM audience
  // only). The same underlying computation is exposed read-only, non-gating,
  // via /api/health/deep's advisory.sweep_liveness (checkSweepLiveness in
  // sweep-liveness.ts) so the board stays green overall while this chip goes
  // red — same posture as the anthology board-projection drift banner (A7).
  // Disable with DISABLE_SWEEP_LIVENESS=1.
  {
    name: 'sweep-liveness',
    expr: '*/2 * * * *',
    fn: async () => {
      const result = await runSweepLivenessSweep();
      if (result.skippedReason) {
        console.log(`[cron] sweep-liveness: skipped — ${result.skippedReason}`);
      } else if (result.staleJobs.length > 0) {
        console.warn(
          `[cron] sweep-liveness: STALE — ${result.staleJobs.join(', ')}${result.alerted ? ' (alerted)' : ' (cooldown, already alerted)'}`,
        );
      }
    },
  },

  // trust-engine: every 2 minutes — THE report-back loop (P1-04, the #1 client
  // complaint). Reports acknowledge -> in-progress -> done back to the client's
  // originating channel for every task that carries a requester_chat_id. Crash-
  // safe by construction (CLAIM-then-dispatch; the durable *_sent_at stamp is the
  // sole idempotency guard, so a re-run never double-sends) and furnace-proof (it
  // only selects tasks with a client chat id AND a pending, unstamped message).
  // Disable with DISABLE_TRUST_ENGINE=1.
  {
    name: 'trust-engine',
    expr: '*/2 * * * *',
    fn: async () => {
      const result = runTrustEngineSweep();
      if (result.skippedReason) {
        console.log(`[cron] trust-engine: skipped — ${result.skippedReason}`);
      } else if (result.scanned > 0) {
        console.log(
          `[cron] trust-engine: scanned ${result.scanned}, claimed ${result.claimed}, ` +
            `sent ${result.sent}, skipped ${result.skipped}`,
        );
      }
    },
  },

  // backlog-redispatch: every 2 minutes, rescue tasks that were ASSIGNED a
  // specialist but never left backlog because their single autoDispatchTask
  // attempt aborted (gateway down / model sovereignty / SOP hold). Selects
  // status='backlog' AND assigned_agent_id IS NOT NULL under the QC re-route cap
  // and re-fires autoDispatchTask. Self-limiting: a task drops out the instant
  // it flips to in_progress (SKIP_STATUSES), and the failing path burns no
  // tokens (guards return before chat.send). A 120s grace window + batch cap
  // prevent a re-dispatch storm / double-invocation of just-assigned tasks.
  // PAUSED BY DEFAULT (SWEEP-01) — opt in with BACKLOG_REDISPATCH_SWEEP_ENABLED=1.
  {
    name: 'backlog-redispatch',
    expr: '*/2 * * * *',
    fn: async () => {
      const result = await runBacklogRedispatchSweep();
      if (result.skippedReason) {
        console.log(`[cron] backlog-redispatch: skipped — ${result.skippedReason}`);
      } else if (result.scanned > 0) {
        console.log(
          `[cron] backlog-redispatch: scanned ${result.scanned} stuck task(s), re-dispatched ${result.dispatched}`,
        );
      }
    },
  },

  // persona-backfill: every 5 minutes, HEAL any non-terminal task still carrying
  // no persona (F3.1 no-naked-tasks invariant). Re-runs resolvePersonaAndPin,
  // which pins a matched persona, pins the deterministic fallback chain, or (for a
  // genuine mechanical task) records the governance pointer and leaves it NULL by
  // design. Furnace/loop-proof: one attempt per task ever (guarded by a
  // persona_backfill_attempt event), a 120s grace window, and a batch cap.
  // Disable with PERSONA_BACKFILL_SWEEP_ENABLED=0.
  {
    name: 'persona-backfill',
    expr: '*/5 * * * *',
    fn: async () => {
      const result = await runPersonaBackfillSweep();
      if (result.skippedReason) {
        console.log(`[cron] persona-backfill: skipped — ${result.skippedReason}`);
      } else if (result.scanned > 0) {
        console.log(
          `[cron] persona-backfill: scanned ${result.scanned} naked task(s), ` +
            `pinned ${result.pinned}, left ${result.leftPersonaless} personaless (mechanical)`,
        );
      }
    },
  },

  // stale-task-sweep: every 10 minutes, return stale tasks to the orchestrator
  // for re-routing (N36 / SOP-01-Blocked-vs-Return). Non-Blocked stale tasks
  // are returned to backlog; Blocked stale tasks are re-pinged then returned.
  // Disable with DISABLE_STALE_TASK_SWEEP=1.
  {
    name: 'stale-task-sweep',
    expr: STALE_TASK_SWEEP_CRON,
    fn: async () => {
      if (
        process.env.DISABLE_STALE_TASK_SWEEP === '1' ||
        process.env.DISABLE_STALE_TASK_SWEEP === 'true'
      ) {
        console.log('[cron] stale-task-sweep: DISABLE_STALE_TASK_SWEEP set, skipping');
        return;
      }
      const result = await runStaleTaskSweep();
      if (result.skippedReason) {
        console.log(`[cron] stale-task-sweep: skipped -- ${result.skippedReason}`);
      } else if (result.scanned > 0 || result.returned > 0 || result.repinged > 0 || (result.recovered ?? 0) > 0) {
        const rec = result.recovered ?? 0;
        console.log(
          `[cron] stale-task-sweep: scanned ${result.scanned}, returned ${result.returned}, ` +
          `repinged ${result.repinged}, recovered ${rec}${rec > 0 ? ` (${(result.recoveredIds ?? []).join(', ')})` : ''}`,
        );
      }
    },
  },

  // stuck-in-progress-sweep: every 5 minutes, catch a task that was dispatched
  // to in_progress and then died silently mid-turn (agent looped/aborted without
  // reporting TASK_COMPLETE or any terminal status). The success reconcile
  // (execution-watcher) and the 24h stale-task-sweep never mark such a task
  // blocked nor alert the operator within a useful window — this is that missing
  // supervisor: block + free the agent + alert the operator once. Tune with
  // STUCK_IN_PROGRESS_MINUTES (default 45); disable with
  // DISABLE_STUCK_IN_PROGRESS_SWEEP=1.
  {
    name: 'stuck-in-progress-sweep',
    expr: STUCK_IN_PROGRESS_SWEEP_CRON,
    fn: async () => {
      const result = await runStuckInProgressSweep();
      if (result.blocked > 0 || result.recovered > 0) {
        console.log(
          `[cron] stuck-in-progress-sweep: scanned ${result.scanned}, ` +
          `recovered ${result.recovered}${result.recovered > 0 ? ` (${result.recoveredIds.join(', ')})` : ''}, ` +
          `blocked ${result.blocked}${result.blocked > 0 ? ` (${result.blockedIds.join(', ')})` : ''}`,
        );
      }
    },
  },


  // interview-nudge: hourly (:23) — re-engage an owner who STARTED the Skill-23
  // interview and went quiet, with ONE Telegram resume link matching the P0-7
  // slug contract (${OPENCLAW_DASHBOARD_URL}/onboarding/resume/<slug>). Reads
  // interview progress from the canonical files only (never writes
  // interviewComplete); idempotent per (session, tier) via an events ledger row;
  // silent/operator-safe (owner-only send). OPT-IN: dormant unless
  // INTERVIEW_NUDGE_SWEEP_ENABLED=1 (repo-only until fleet rollout is released).
  // Disable outright with DISABLE_INTERVIEW_NUDGE_SWEEP=1.
  {
    name: 'interview-nudge',
    expr: INTERVIEW_NUDGE_SWEEP_CRON,
    fn: async () => {
      const result = await runInterviewNudgeSweep();
      if (result.skippedReason) {
        // Quiet by design — only log the interesting (would-have-sent) skips.
        if (result.tier) {
          console.log(`[cron] interview-nudge: skipped — ${result.skippedReason}`);
        }
      } else if (result.nudged > 0) {
        console.log(`[cron] interview-nudge: sent tier ${result.tier}h resume nudge`);
      }
    },
  },

  // weekly-done-clear: Sunday 07:00 America/New_York — soft-archive all done
  // tasks (sets archived_at, never hard-deletes). Idempotent: a second run in
  // the same week is a no-op. Disable with DISABLE_WEEKLY_DONE_CLEAR=1.
  {
    name: 'weekly-done-clear',
    expr: WEEKLY_DONE_CLEAR_CRON_EXPR,
    timezone: WEEKLY_DONE_CLEAR_CRON_TIMEZONE,
    fn: async () => {
      const result = await runWeeklyDoneClear();
      console.log(
        result.skippedReason
          ? `[cron] weekly-done-clear: skipped — ${result.skippedReason}`
          : `[cron] weekly-done-clear: archived ${result.archivedCount} done task(s)`,
      );
    },
  },

  // lss-control-review: 1st of each month at 08:00 America/New_York — monthly
  // Lean Six Sigma control-style review: defect/rework/waste summary + narrative
  // written to lss_control_reviews + Live Feed event + recommendations on grade drop.
  // Idempotent per calendar month. Disable with DISABLE_LSS_CONTROL_REVIEW=1.
  {
    name: 'lss-control-review',
    expr: LSS_CONTROL_REVIEW_CRON_EXPR,
    timezone: LSS_CONTROL_REVIEW_CRON_TIMEZONE,
    fn: async () => {
      const result = await runLssControlReview();
      console.log(
        result.skippedReason
          ? `[cron] lss-control-review: skipped — ${result.skippedReason}`
          : `[cron] lss-control-review: review ${result.reviewId} written (score=${result.companyScore})`,
      );
    },
  },

  // general-task-recurrence: Sunday 04:30 — cluster tasks that landed in the
  // General Task catch-all dept over the past 30 days. Any cluster ≥4 tasks
  // (>3/month) upserts a 'try' recommendation to stand up a dedicated dept.
  // Idempotent on cluster-signature hash; suppresses dismissed clusters.
  // Disable with DISABLE_GENERAL_TASK_RECURRENCE=1.
  {
    name: 'general-task-recurrence',
    expr: '30 4 * * 0',
    fn: async () => {
      if (
        process.env.DISABLE_GENERAL_TASK_RECURRENCE === '1' ||
        process.env.DISABLE_GENERAL_TASK_RECURRENCE === 'true'
      ) {
        console.log('[cron] general-task-recurrence: DISABLE_GENERAL_TASK_RECURRENCE set, skipping');
        return;
      }
      const result = runGeneralTaskRecurrenceDetection();
      console.log(
        `[cron] general-task-recurrence: scanned ${result.scanned_tasks} tasks, ` +
          `${result.clusters_found} clusters, ` +
          `${result.recommendations_upserted} recommendation(s) upserted ` +
          `(${result.recommendations_created} new)`,
      );
    },
  },

  // port-integrity: daily at 05:15 server local — P1-02 Unit B, item 5.
  // Belt-and-suspenders alongside the launch-time ACK guard in cc-start.sh:
  // that guard stops a NEW drift from ever booting; this catches an ALREADY
  // running process that drifted after boot (e.g. a manually-launched
  // `next start -p 3000` that bypassed cc-start.sh entirely — the residual
  // bypass risk P1-02(b).3 names explicitly). Asserts the actual listen port
  // is the canonical 4000 (live self-probe, not just the env var) and, when
  // the Cloudflare tunnel ingress is readable on this box, that it targets
  // :4000 too. Any mismatch alerts the OPERATOR lane only (MOVE-IN-SILENCE —
  // never the client). Disable with DISABLE_PORT_INTEGRITY_CHECK=1.
  {
    name: 'port-integrity',
    expr: '15 5 * * *',
    fn: async () => {
      if (
        process.env.DISABLE_PORT_INTEGRITY_CHECK === '1' ||
        process.env.DISABLE_PORT_INTEGRITY_CHECK === 'true'
      ) {
        console.log('[cron] port-integrity: DISABLE_PORT_INTEGRITY_CHECK set, skipping');
        return;
      }
      const result = await runPortIntegrityCheck();
      if (result.alerted) {
        console.warn(
          `[cron] port-integrity: DRIFT — listenPort=${result.listenPort} listenPortOk=${result.listenPortOk} ` +
            `tunnelChecked=${result.tunnelChecked} tunnelOk=${result.tunnelOk} (${result.tunnelDetail ?? 'n/a'})`,
        );
      } else {
        console.log(
          `[cron] port-integrity: ok — listenPort=${result.listenPort}, tunnelChecked=${result.tunnelChecked}`,
        );
      }
    },
  },

  // board-hygiene: hourly — P1-06 "nothing stuck on the board". Codifies the
  // five lane SLAs (blocked owner re-ping/escalate, review force-score +
  // qc_starved, done > 30d soft-archive, stale backlog/inbox > 21d nudge +
  // 7d-no-reply soft-archive). NEVER auto-archives a blocked task at any age
  // — see board-hygiene.ts rule 2. Disable with DISABLE_BOARD_HYGIENE=1.
  {
    name: 'board-hygiene',
    expr: BOARD_HYGIENE_CRON,
    fn: async () => {
      const result = await runBoardHygiene();
      if (result.skippedReason) {
        console.log(`[cron] board-hygiene: skipped — ${result.skippedReason}`);
      } else {
        console.log(
          `[cron] board-hygiene: owner-repinged=${result.ownerRepinged}, operator-escalated=${result.operatorEscalated}, ` +
            `review-force-scored=${result.reviewForceScored}, qc-starved=${result.qcStarved}, ` +
            `done-archived=${result.doneArchived}, stale-nudged=${result.staleNudged}, stale-archived=${result.staleArchived}`,
        );
      }
    },
  },
];

/**
 * Register every job. Safe to call multiple times.
 */
export function registerCronJobs(): RegisteredJob[] {
  if (alreadyRegistered()) {
    return listJobs();
  }

  for (const job of JOBS) {
    if (!cron.validate(job.expr)) {
      console.error(`[cron] invalid expression for ${job.name}: ${job.expr}`);
      continue;
    }
    const scheduleOptions: { name: string; timezone?: string } = { name: job.name };
    if (job.timezone) scheduleOptions.timezone = job.timezone;
    cron.schedule(job.expr, wrap(job.name, job.fn), scheduleOptions);
  }

  markRegistered();
  const registered = listJobs();
  console.log(
    '[cron] Cron jobs registered:',
    registered.map((j) => j.name).join(', ')
  );
  return registered;
}

/**
 * List currently registered jobs with their next-run timestamps. Returns the
 * jobs in the order they were defined regardless of node-cron's internal map
 * ordering.
 */
export function listJobs(): RegisteredJob[] {
  const tasks = cron.getTasks();
  const byName = new Map<string, ScheduledHandle>();
  tasks.forEach((task) => {
    const handle = task as unknown as ScheduledHandle;
    if (handle.name) byName.set(handle.name, handle);
  });

  return JOBS.map((j) => {
    const handle = byName.get(j.name);
    let nextRun: string | null = null;
    try {
      const next = handle?.getNextRun?.() ?? null;
      nextRun = next ? next.toISOString() : null;
    } catch {
      nextRun = null;
    }
    return { name: j.name, cron: j.expr, nextRun };
  });
}
