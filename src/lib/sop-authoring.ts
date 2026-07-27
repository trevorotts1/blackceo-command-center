/**
 * PRD 2.12-cc — Dispatch-time SOP authoring fast loop (custom departments only).
 *
 * When a task dispatches with NO SOP match and its department is NOT in the
 * 24-slug canonical ZHC set (i.e. it is a CUSTOM department), this module:
 *   1. Guards against canonical departments (HARD REFUSAL — copy from library instead).
 *   2. Creates a linked "Author SOP" sub-task routed to the dept's research specialist.
 *   3. Researches via Tavily (Tier-1 mandate) and synthesizes via Gemini.
 *   4. Runs QC at the 8.5 gate (per-dept QC agent; heuristic → human review).
 *   5. Files the SOP to BOTH the `sops` table (source=NULL) AND the on-disk
 *      workspace layer (`<OPENCLAW_WORKSPACE_PATH>/departments/<dept>/<role>/how-to.md`).
 *   6. Attaches the new sop_id back to the original task and re-fires dispatch.
 *
 * QC gate contract (AF6):
 *   - dept-QC >= 8.5 (LLM-scored) → auto-file ('auto-authored-filed') with NO
 *     operator-approval step; original task is not blocked on a human.
 *   - heuristic (no LLM key)       → file as 'pending' proposal; dispatch
 *     proceeds SOP-less (loud event); operator can review quality later.
 *   - QC < 8.5 after redo          → same 'pending' / SOP-less dispatch behaviour.
 *   - parse fail (twice)            → same 'pending' / SOP-less dispatch behaviour.
 *   The 'pending' fallbacks do NOT block the original task — dispatch continues
 *   without a SOP while the proposal sits in the queue. Only the QC-pass path
 *   re-fires dispatch WITH the authored SOP attached.
 *
 * Build gate: qc-cc.sh §9 asserts the above in source (§9.10 = auto-authored-filed
 * on pass; §9.11 = proposeDraftFromTask absent from task-dispatcher.ts).
 *
 * Token-economics protection: canonical departments NEVER trigger generation.
 * The guard is absolute — the build gate (qc-cc.sh §9) asserts it in source.
 *
 * All side effects are fire-and-forget-safe (never throw into the dispatch hot-path).
 *
 * Related:
 *   - src/lib/routing/canonical-slug.ts — CANONICAL_SLUGS + canonicalDeptSlug
 *   - src/lib/sop-auto-replace.ts — shared helpers (buildSynthesisPrompt, etc.)
 *   - src/lib/qc-scorer.ts — scoreTaskForQC, resolveTrioAgents, QC_PASS_THRESHOLD
 *   - src/lib/db/migrations.ts — migration 066 (tasks.sop_authoring_for_task_id)
 */

import { v4 as uuidv4 } from 'uuid';
import fs from 'fs';
import path from 'path';
import { queryOne, queryAll, run } from '@/lib/db';
import { CANONICAL_SLUGS, canonicalDeptSlug } from '@/lib/routing/canonical-slug';
// ROLE_LIBRARY_SOURCE is the sentinel value for on-disk role-library SOPs.
// Defined inline to avoid pulling role-library-import.ts (with node: imports)
// into the webpack scheduler → task-dispatcher build path.
const ROLE_LIBRARY_SOURCE = 'role-library' as const;
import { scoreSOPForTask } from '@/lib/sops';
import type { SOP } from '@/lib/sops';
import type { Task } from '@/lib/types';
import { tavilySearch } from '@/lib/tavily';
import { geminiGenerate } from '@/lib/gemini';
import { assertNoFixtureDerivedServerWrite } from '@/lib/fixture-guard';
import {
  buildSynthesisPrompt,
  parseDraftedSOP,
  readSoulAndUser,
  findClientChatId,
  notifyTelegram,
  WORKSPACE_BASE,
  groundDraftedSOP,
} from '@/lib/sop-auto-replace';
import { scoreTaskForQC, resolveTrioAgents, QC_PASS_THRESHOLD } from '@/lib/qc-scorer';
import type { QCScorerInput } from '@/lib/qc-scorer';
import { recordStatusEvent } from '@/lib/task-lifecycle';
import { notifyOwnerDone } from '@/lib/owner-reports';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CanonicalContextResult {
  canonical: boolean;
  reason: string;
}

export type AuthorStatus =
  | 'authored'
  | 'deduped'
  | 'refused-canonical'
  | 'escalated'
  | 'no-research-specialist'
  | 'qc-heuristic-pending'
  | 'qc-fail-pending'
  | 'qc-ungrounded-pending'
  | 'parse-fail-pending'
  | 'error';

export interface AuthorResult {
  status: AuthorStatus;
  sop_id?: string;
  sub_task_id?: string;
  qc_score?: number;
  proposal_id?: string;
  reason?: string;
}

// ---------------------------------------------------------------------------
// §1.1 — Canonical-vs-custom boundary gate
// ---------------------------------------------------------------------------

/**
 * Returns { canonical: true } when:
 *   (a) the department slug is in CANONICAL_SLUGS (24 ZHC depts), OR
 *   (b) a `source='role-library'` row already exists for this dept (+optional role).
 *
 * Both conditions mean: copy from library, never author. The guard is the
 * token-economics protection — NEVER author for canonical contexts.
 */
export function isCanonicalContext(
  deptSlug: string | null | undefined,
  agentRoleSlug?: string | null,
): CanonicalContextResult {
  const canonical = canonicalDeptSlug(deptSlug ?? '');

  // (a) Is the dept slug in the canonical set?
  if (CANONICAL_SLUGS.has(canonical)) {
    return {
      canonical: true,
      reason: `department "${canonical}" is in the 24-slug ZHC canonical set`,
    };
  }

  // (b) Does a role-library SOP already exist for this dept (+role)?
  try {
    let row: { id: string } | null;
    if (agentRoleSlug) {
      row = queryOne<{ id: string }>(
        `SELECT id FROM sops
         WHERE source = ? AND department = ? AND role = ? AND deleted_at IS NULL
         LIMIT 1`,
        [ROLE_LIBRARY_SOURCE, canonical, agentRoleSlug],
      ) ?? null;
    } else {
      row = queryOne<{ id: string }>(
        `SELECT id FROM sops
         WHERE source = ? AND department = ? AND deleted_at IS NULL
         LIMIT 1`,
        [ROLE_LIBRARY_SOURCE, canonical],
      ) ?? null;
    }
    if (row) {
      return {
        canonical: true,
        reason: `source='role-library' SOP exists for dept "${canonical}"${agentRoleSlug ? ` / role "${agentRoleSlug}"` : ''}`,
      };
    }
  } catch {
    // DB error → conservative: treat as canonical (never over-author)
    return { canonical: true, reason: 'db-error-conservative' };
  }

  return { canonical: false, reason: `custom department "${canonical || deptSlug}" — no canonical match` };
}

// ---------------------------------------------------------------------------
// §1.2 — Copy-from-library fallback (canonical path, near-zero tokens)
// ---------------------------------------------------------------------------

/**
 * When a canonical context has NO SOP-score-above-0.5 match (the threshold
 * gate in getBestSOPForTask), find the best `source='role-library'` SOP for
 * the dept/role and return it. If no library row exists, return null (library gap).
 */
export function copyCanonicalSOPForTask(
  task: Pick<Task, 'title' | 'description'> & {
    department?: string | null;
    workspace_id?: string | null;
  },
  agentRoleSlug?: string | null,
): SOP | null {
  const canonical = canonicalDeptSlug(task.department ?? task.workspace_id ?? '');

  let candidates: SOP[];
  try {
    if (agentRoleSlug) {
      candidates = queryAll<SOP>(
        `SELECT * FROM sops
         WHERE source = ? AND department = ? AND role = ? AND deleted_at IS NULL`,
        [ROLE_LIBRARY_SOURCE, canonical, agentRoleSlug],
      );
    } else {
      candidates = queryAll<SOP>(
        `SELECT * FROM sops
         WHERE source = ? AND department = ? AND deleted_at IS NULL`,
        [ROLE_LIBRARY_SOURCE, canonical],
      );
    }
  } catch {
    return null;
  }

  if (candidates.length === 0) return null;

  // Score each candidate against the task and return the best.
  const scored = candidates
    .map((sop) => {
      const { score } = scoreSOPForTask(sop, { ...task, agentRoleSlug });
      return { sop, score };
    })
    .sort((a, b) => b.score - a.score);

  return scored[0].sop;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Recursive-safety cap: count recent authoring attempts for the same dept/keywords. */
function getRecentAuthoringAttemptCount(deptSlug: string, titleKeyword: string): number {
  const namePattern = `%${titleKeyword.split(/\s+/).slice(0, 3).join(' ')}%`;
  try {
    const row = queryOne<{ n: number }>(
      `SELECT COUNT(*) AS n FROM sop_proposals
         WHERE proposed_department = ?
           AND proposed_name LIKE ?
           AND created_at > datetime('now', '-7 days')
           AND status IN ('auto-authored-filed', 'auto-generated-pending-review', 'escalated', 'rejected')`,
      [deptSlug, namePattern],
    );
    return row?.n ?? 0;
  } catch {
    return 0;
  }
}

/** Write a loud event to the events table. */
function emitEvent(type: string, message: string, taskId?: string): void {
  try {
    run(
      `INSERT INTO events (id, type, task_id, message, created_at) VALUES (?, ?, ?, ?, ?)`,
      [uuidv4(), type, taskId ?? null, message, new Date().toISOString()],
    );
  } catch {
    console.error(`[sop-authoring] failed to emit event ${type}: ${message}`);
  }
}

/** Safely write a file to disk, creating directories as needed. */
function safeDiskWrite(filePath: string, content: string): { ok: boolean; error?: string } {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf8');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

/** Generate the on-disk how-to.md content from a drafted SOP. */
function sopToHowToMd(opts: {
  name: string;
  department: string;
  role?: string;
  success_criteria?: string;
  steps: Array<{ name: string; checklist?: string[]; success_criteria?: string }>;
  sources?: Array<{ title: string; url: string }>;
}): string {
  const lines: string[] = [
    `# ${opts.name}`,
    ``,
    `**Department:** ${opts.department}`,
    opts.role ? `**Role:** ${opts.role}` : '',
    ``,
    `## Success Criteria`,
    opts.success_criteria || '(see steps below)',
    ``,
    `## Steps`,
    ``,
  ].filter((l) => l !== undefined);

  for (let i = 0; i < opts.steps.length; i++) {
    const s = opts.steps[i];
    lines.push(`### ${i + 1}. ${s.name}`);
    if (s.checklist?.length) {
      for (const item of s.checklist) lines.push(`- ${item}`);
    }
    if (s.success_criteria) lines.push(``, `**Criteria:** ${s.success_criteria}`);
    lines.push('');
  }

  if (opts.sources?.length) {
    lines.push(`## Research Sources`);
    for (const src of opts.sources) lines.push(`- [${src.title}](${src.url})`);
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// §1.3 — The authoring entry point (custom path only)
// ---------------------------------------------------------------------------

// ─── F3.9 — PERSONA SLOT EMISSION (authored multi-craft SOPs) ────────────────
// An authored SOP that spans multiple crafts (e.g. a website build: CONTENT copy,
// CODE build, IMAGE hero) declares one `persona_slot` per craft STEP so the
// matcher fills each slot with a distinct best-fit persona (F3.7 `--combined`).
// Slot vocabulary is the EXISTING taxonomy — `infer-task-category` slugs +
// `CRAFT_PRIMARY_DOMAINS` families — never a new taxonomy.
//
// Q3 (ratified): the CODE family resolves to the `software-craft` domain
// (hunt-thomas-pragmatic-programmer, added matcher-side by F3.8/DEP-6); the IMAGE
// family resolves to `visual-storytelling` (budelmann-brand-identity-essentials +
// opara-color-works, surfaced matcher-side). CONTENT resolves to `copywriting`.

interface AuthoredStepSlot {
  slot: string;
  task_category: string;
  domains: string[];
  audience_from: 'task' | 'none';
  required: boolean;
}

const _SLOT_FAMILIES: Array<{ family: string; keywords: RegExp; slot: AuthoredStepSlot }> = [
  {
    family: 'content',
    keywords: /\b(copy|copywrit|content|headline|messaging|caption|script|voice|narrative)\b/i,
    slot: { slot: 'content', task_category: 'content-write', domains: ['copywriting'], audience_from: 'task', required: true },
  },
  {
    family: 'code',
    keywords: /\b(code|build the (site|page|funnel|app)|develop|implement|frontend|back[- ]?end|api|deploy the (site|app)|engineer|program)\b/i,
    slot: { slot: 'code', task_category: 'code', domains: ['software-craft'], audience_from: 'none', required: true },
  },
  {
    family: 'image',
    keywords: /\b(image|hero shot|visual|graphic|illustration|photo|art\s?direction|design the (hero|banner|graphic))\b/i,
    slot: { slot: 'image', task_category: 'design', domains: ['visual-storytelling'], audience_from: 'task', required: false },
  },
];

/**
 * Annotate drafted SOP steps with `persona_slot` for a MULTI-CRAFT SOP. Returns a
 * NEW steps array (never mutates the input); a step that already declares a slot
 * or matches no craft family is passed through untouched. Slots are emitted ONLY
 * when ≥2 DISTINCT craft families are detected across the steps — a single-craft
 * SOP is left alone (it will match a single persona the normal way).
 *
 * Exported for the contract test.
 */
export function emitPersonaSlots<T extends { name: string; persona_slot?: unknown }>(
  steps: T[],
): T[] {
  if (!Array.isArray(steps) || steps.length === 0) return steps;

  // First pass: which family (if any) does each step map to?
  const perStepFamily = steps.map((s) => {
    const name = s?.name || '';
    return _SLOT_FAMILIES.find((f) => f.keywords.test(name)) ?? null;
  });
  const distinctFamilies = new Set(perStepFamily.filter(Boolean).map((f) => f!.family));
  if (distinctFamilies.size < 2) return steps; // not multi-craft — leave untouched

  return steps.map((step, i) => {
    const fam = perStepFamily[i];
    if (!fam) return step;
    if (step.persona_slot) return step; // author already declared one — respect it
    return { ...step, persona_slot: { ...fam.slot } };
  });
}

export interface AuthorSOPInput {
  originalTaskId: string;
  title: string;
  description?: string | null;
  department: string | null;
  agentRoleSlug?: string | null;
  workspaceId: string | null;
}

/**
 * Author a new SOP for a custom-department task that has no SOP match.
 *
 * Gate: canonical → refused.
 * Flow: safety cap → sub-task → Tavily research → Gemini synthesis → QC@8.5 → file (DB + disk) → attach → re-dispatch.
 *
 * NEVER throws — all side effects are fire-and-forget-safe.
 */
export async function authorSOPForTask(input: AuthorSOPInput): Promise<AuthorResult> {
  try {
    // §1.1 HARD REFUSAL: canonical departments never enter generation.
    const ctx = isCanonicalContext(input.department, input.agentRoleSlug);
    if (ctx.canonical) {
      console.log(`[sop-authoring] REFUSED canonical: ${ctx.reason}`);
      return { status: 'refused-canonical', reason: ctx.reason };
    }

    const deptSlug = canonicalDeptSlug(input.department ?? '');

    // §1.3 Step 2: recursive-safety cap (≥3 attempts in 7 days → escalate).
    const recentAttempts = getRecentAuthoringAttemptCount(deptSlug, input.title);
    if (recentAttempts >= 3) {
      const evidence = `[SOP-AUTHORING-ESCALATED] Safety cap (${recentAttempts} attempts) for dept "${deptSlug}" / "${input.title}" in 7 days. Manual authoring required.`;
      const proposalId = uuidv4();
      const now = new Date().toISOString();
      try {
        run(
          `INSERT INTO sop_proposals
             (id, proposed_name, proposed_department, draft_steps, based_on_task_ids,
              evidence_summary, status, created_at, confidence, auto_research_attempts)
           VALUES (?, ?, ?, ?, ?, ?, 'escalated', ?, NULL, ?)`,
          [
            proposalId,
            `[ESCALATED] ${input.title}`,
            deptSlug,
            '[]',
            JSON.stringify([input.originalTaskId]),
            evidence,
            now,
            recentAttempts + 1,
          ],
        );
      } catch { /* non-fatal */ }
      emitEvent('sop_authoring_escalated', evidence, input.originalTaskId);
      const chatId = findClientChatId();
      if (chatId) {
        notifyTelegram({
          chatId,
          message: `SOP authoring escalation: dept "${deptSlug}" hit the 3-attempt safety cap. Task "${input.title}" needs manual SOP authoring.`,
        });
      }
      return { status: 'escalated', proposal_id: proposalId, reason: evidence };
    }

    // §3: Resolve the research specialist for this dept.
    const trio = resolveTrioAgents(input.workspaceId, deptSlug);
    if (!trio.research) {
      const msg = `[sop-authoring] No research specialist for dept "${deptSlug}" (workspace: ${input.workspaceId}). Escalating.`;
      console.error(msg);
      emitEvent('sop_authoring_no_research_specialist', msg, input.originalTaskId);
      const chatId = findClientChatId();
      if (chatId) {
        notifyTelegram({
          chatId,
          message: `SOP authoring blocked: no research specialist found for department "${deptSlug}". Task "${input.title}" needs manual SOP assignment.`,
        });
      }
      return { status: 'no-research-specialist', reason: msg };
    }

    // ── FM-6b / F2 — IDEMPOTENCY GUARD (exactly ONE authoring card per natural key) ──
    //
    // The dispatch sweep re-enters authorSOPForTask every ~2 min for an un-authored
    // backlog task. Without a guard each pass INSERTED a fresh "Author SOP: X"
    // sub-task, flooding the board with hundreds of identical clones.
    //
    // NATURAL KEY = (workspace_id, department, title), plus the explicit
    // `sop_authoring_for_task_id` back-link to the original task. `title` alone is
    // NOT the key: two workspaces legitimately hold a same-titled card, and the
    // authoring card's whole identity is "the SOP-authoring run for THIS task in
    // THIS workspace".
    //
    // F2 — the hole this closes: the FM-6b guard only looked at OPEN rows
    // (`status != 'done'` AND not archived). The moment an authoring card
    // COMPLETED — or was ARCHIVED by a board-cleanup / dedup pass — the guard went
    // blind again. And because §6 below only attaches the authored sop_id
    // `WHERE status = 'backlog'`, an original task that has since left backlog stays
    // SOP-less forever, so the sweep re-enters on EVERY tick: mint a card, close it,
    // go blind, mint another. That is the observed furnace (hundreds of identical
    // `Author SOP: <title>` cards per workspace on a live board). Keying on the
    // natural key REGARDLESS of status/archived_at makes the card mint exactly-once,
    // and — critically — means ARCHIVING the historical clones can never restart it.
    //
    // Enforcement is a single atomic `INSERT … SELECT … WHERE NOT EXISTS`, so two
    // concurrent sweeps (or two processes sharing the SQLite file) cannot both win a
    // check-then-insert race. NO DB UNIQUE constraint is added: live boards already
    // carry hundreds of duplicate rows that hold REAL deliverables and must be
    // ARCHIVED, never deleted — a UNIQUE index could not be built over them (and an
    // archived row still occupies an index). The atomic INSERT gives the same
    // exactly-once property with no destructive migration.
    //
    // The guard NEVER silences authoring: an OPEN card means a run is already in
    // flight (reuse + return `deduped`, unchanged FM-6b behaviour); a CLOSED/archived
    // card means the card already exists but this task still needs a SOP, so the
    // authoring run PROCEEDS against the existing card (still capped by the
    // 3-attempt safety cap above, which escalates to a human).
    const authorTitle = `Author SOP: ${input.title}`;
    const wsKey = input.workspaceId ?? '';
    const deptKey = deptSlug ?? '';
    // Matches an authoring card for the same original task OR the same natural key.
    const AUTHORING_KEY_MATCH = `(
        sop_authoring_for_task_id = ?
        OR (title = ?
            AND COALESCE(department, '') = ?
            AND COALESCE(workspace_id, '') = ?)
      )`;
    const AUTHORING_KEY_PARAMS = [input.originalTaskId, authorTitle, deptKey, wsKey];

    // Prefer an OPEN card when one exists; otherwise surface the closed/archived one.
    let existingAuthoring: { id: string; status: string; archived_at: string | null } | undefined;
    try {
      existingAuthoring = queryOne<{ id: string; status: string; archived_at: string | null }>(
        `SELECT id, status, archived_at FROM tasks
          WHERE ${AUTHORING_KEY_MATCH}
          ORDER BY (CASE WHEN status != 'done' AND (archived_at IS NULL OR archived_at = '')
                         THEN 0 ELSE 1 END) ASC,
                   created_at ASC, rowid ASC
          LIMIT 1`,
        AUTHORING_KEY_PARAMS,
      );
    } catch (lookupErr) {
      // FAIL-OPEN: a lookup failure must never stall authoring. The atomic INSERT
      // below is itself idempotent, so correctness does not depend on this read.
      console.warn(
        '[sop-authoring] Idempotency lookup failed (non-fatal, falling through to the atomic insert):',
        (lookupErr as Error).message,
      );
    }

    const existingIsOpen =
      !!existingAuthoring &&
      existingAuthoring.status !== 'done' &&
      (existingAuthoring.archived_at === null || existingAuthoring.archived_at === '');

    if (existingAuthoring && existingIsOpen) {
      console.log(
        `[sop-authoring] Idempotency guard: open authoring sub-task ${existingAuthoring.id} already exists ` +
          `for "${input.title}" (ws ${wsKey || '-'} / dept ${deptKey || '-'}) — NOT creating a duplicate.`,
      );
      return {
        status: 'deduped',
        sub_task_id: existingAuthoring.id,
        reason: 'reused existing open authoring sub-task (idempotency guard)',
      };
    }

    // §2: Create the linked authoring sub-task — exactly once per natural key.
    let subTaskId = existingAuthoring?.id ?? uuidv4();
    const now = new Date().toISOString();

    if (existingAuthoring) {
      // A CLOSED (done) or ARCHIVED card already exists for this natural key. Do NOT
      // mint another — that is the F2 furnace. Reuse it and let the authoring run
      // continue, and say so LOUDLY (console + events row): a skip is never silent.
      const skipMsg =
        `[sop-authoring] Idempotency guard: authoring sub-task ${existingAuthoring.id} already exists for ` +
        `"${authorTitle}" (ws ${wsKey || '-'} / dept ${deptKey || '-'}, status=${existingAuthoring.status}` +
        `${existingAuthoring.archived_at ? ', archived' : ''}) — SKIPPING duplicate card creation, reusing it. ` +
        `Authoring proceeds against the existing card.`;
      console.log(skipMsg);
      emitEvent('sop_authoring_subtask_deduped', skipMsg, input.originalTaskId);
    } else {
      try {
        const res = run(
          `INSERT INTO tasks
             (id, title, department, workspace_id, assigned_agent_id, status,
              sop_authoring_for_task_id, created_at, updated_at,
              priority, created_by_agent_id)
           SELECT ?, ?, ?, ?, ?, 'in_progress', ?, ?, ?, 'medium', NULL
            WHERE NOT EXISTS (SELECT 1 FROM tasks WHERE ${AUTHORING_KEY_MATCH})`,
          [
            subTaskId,
            authorTitle,
            deptSlug,
            input.workspaceId,
            trio.research.id,
            input.originalTaskId,
            now,
            now,
            ...AUTHORING_KEY_PARAMS,
          ],
        );

        if (res.changes === 0) {
          // Lost a concurrent race — another sweep inserted the card between our
          // lookup and this statement. Adopt the winner; never insert a second card.
          const winner = queryOne<{ id: string }>(
            `SELECT id FROM tasks WHERE ${AUTHORING_KEY_MATCH} ORDER BY created_at ASC, rowid ASC LIMIT 1`,
            AUTHORING_KEY_PARAMS,
          );
          const raceMsg =
            `[sop-authoring] Idempotency guard: concurrent sweep already created authoring sub-task ` +
            `${winner?.id ?? '(unknown)'} for "${authorTitle}" (ws ${wsKey || '-'} / dept ${deptKey || '-'}) ` +
            `— SKIPPING duplicate card creation.`;
          console.log(raceMsg);
          emitEvent('sop_authoring_subtask_deduped', raceMsg, input.originalTaskId);
          if (winner) subTaskId = winner.id;
        } else {
          run(
            `INSERT INTO events (id, type, agent_id, task_id, message, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
            [
              uuidv4(),
              'task_created',
              trio.research.id,
              subTaskId,
              `[sop-authoring] Sub-task created for SOP authoring of "${input.title}"`,
              now,
            ],
          );
          run(
            `INSERT INTO events (id, type, agent_id, task_id, message, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
            [
              uuidv4(),
              'task_dispatched',
              trio.research.id,
              subTaskId,
              `[sop-authoring] Sub-task dispatched to research specialist ${trio.research.name}`,
              now,
            ],
          );
        }
      } catch (subTaskErr) {
        console.error('[sop-authoring] Failed to create sub-task:', (subTaskErr as Error).message);
        // Continue — sub-task creation is best-effort; authoring can still proceed.
      }
    }

    // §4: Research (Tavily, fixture-gated).
    const year = new Date().getFullYear();
    const researchQuery = `${deptSlug} ${input.title} best practices ${year}`.trim();
    const tavily = await tavilySearch(researchQuery, { max_results: 5 });

    // §5: Synthesize (Gemini, fixture-gated).
    const { soul, user } = readSoulAndUser();
    const synthesisPrompt = buildSynthesisPrompt({
      soul,
      user,
      tavilyResults: tavily.results,
      tavilyAnswer: tavily.answer,
      noV1: true,
      deptSlug,
      agentRoleSlug: input.agentRoleSlug ?? undefined,
      taskTitle: input.title,
    });

    let draftRaw: string;
    try {
      draftRaw = await geminiGenerate(synthesisPrompt, { response_mime_type: 'application/json' });
    } catch (genErr) {
      const msg = `[sop-authoring] Gemini generation failed for "${input.title}": ${(genErr as Error).message}`;
      console.error(msg);
      emitEvent('sop_authoring_generation_failed', msg, input.originalTaskId);
      return { status: 'error', reason: msg };
    }

    // Parse — attempt 1.
    let drafted;
    try {
      drafted = parseDraftedSOP(draftRaw);
    } catch (parseErr) {
      // One redo with gap note.
      const gapNote = `Previous output failed JSON parsing: ${(parseErr as Error).message}. Output ONLY valid JSON.`;
      const redoPrompt = synthesisPrompt + '\n\n' + gapNote;
      let redoRaw: string;
      try {
        redoRaw = await geminiGenerate(redoPrompt, { response_mime_type: 'application/json' });
        drafted = parseDraftedSOP(redoRaw);
      } catch (redoErr) {
        // Both attempts failed — file nothing, escalate.
        const msg = `[sop-authoring] Draft JSON failed twice for "${input.title}": ${(redoErr as Error).message}`;
        console.error(msg);
        emitEvent('sop_authoring_parse_failed_twice', msg, input.originalTaskId);
        // Create a pending proposal with the raw text so a human can review.
        const failProposalId = uuidv4();
        const sources = tavily.results.slice(0, 5).map((r) => ({ title: r.title, url: r.url }));
        try {
          run(
            `INSERT INTO sop_proposals
               (id, proposed_name, proposed_department, draft_steps, based_on_task_ids,
                evidence_summary, status, created_at, confidence, auto_research_attempts, research_sources)
             VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, NULL, ?, ?)`,
            [
              failProposalId,
              `[NEEDS REVIEW] ${input.title}`,
              deptSlug,
              '[]',
              JSON.stringify([input.originalTaskId]),
              `Parse failed twice. Raw output: ${draftRaw.slice(0, 2000)}`,
              new Date().toISOString(),
              recentAttempts + 1,
              JSON.stringify(sources),
            ],
          );
        } catch { /* non-fatal */ }
        return { status: 'parse-fail-pending', proposal_id: failProposalId, reason: msg };
      }
    }

    // §4: QC gate at 8.5.
    const sopStepsJson = JSON.stringify(drafted.steps);
    const qcCriteria = drafted.success_criteria || `Complete, Tier-1-cited, actionable SOP for ${deptSlug}${input.agentRoleSlug ? ' / ' + input.agentRoleSlug : ''}`;

    // Resolve the dept's QC agent.
    const qcAgent = trio.qc;

    const qcInput: QCScorerInput = {
      taskId: input.originalTaskId,
      taskTitle: `SOP Draft: ${drafted.name}`,
      taskDescription: drafted.description ?? null,
      sopSuccessCriteria: qcCriteria,
      sopName: drafted.name,
      sopSteps: sopStepsJson,
      departmentSlug: deptSlug,
      qcAgentId: qcAgent?.id ?? null,
      qcAgentName: qcAgent?.name ?? null,
      qcAgentModel: qcAgent?.model ?? null,
    };

    const qcResult = await scoreTaskForQC(qcInput);

    // §4 Heuristic guard: no auto-file — file as pending for human review.
    if (qcResult.scoringPath === 'heuristic') {
      const heuristicProposalId = uuidv4();
      const sources = tavily.results.slice(0, 5).map((r) => ({ title: r.title, url: r.url }));
      const evidence = [
        `[QC-HEURISTIC] SOP draft needs human review (heuristic score: ${qcResult.score.toFixed(1)}/10).`,
        `No LLM key configured — cannot auto-file. Please review and approve manually.`,
        `Research query: ${researchQuery}`,
        `Top sources:`,
        ...sources.map((s, i) => `  [${i + 1}] ${s.title} (${s.url})`),
      ].join('\n');
      try {
        run(
          `INSERT INTO sop_proposals
             (id, proposed_name, proposed_department, draft_steps, based_on_task_ids,
              evidence_summary, status, created_at, confidence, auto_research_attempts, research_sources)
           VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`,
          [
            heuristicProposalId,
            drafted.name,
            drafted.department || deptSlug,
            sopStepsJson,
            JSON.stringify([input.originalTaskId]),
            evidence,
            new Date().toISOString(),
            drafted.confidence ?? null,
            recentAttempts + 1,
            JSON.stringify(sources),
          ],
        );
      } catch { /* non-fatal */ }
      emitEvent('sop_authoring_heuristic_pending', evidence, input.originalTaskId);
      return {
        status: 'qc-heuristic-pending',
        proposal_id: heuristicProposalId,
        qc_score: qcResult.score,
        reason: '[QC-HEURISTIC] Filed as pending for human review',
      };
    }

    // LLM QC: if score < 8.5, one redo with gap notes.
    let finalDrafted = drafted;
    let finalQcResult = qcResult;
    if (!qcResult.pass) {
      const gapText = qcResult.gaps.length > 0 ? qcResult.gaps.join('; ') : qcResult.reason;
      const redoPrompt = synthesisPrompt + `\n\n### QC gaps to address in this revision:\n${gapText}\nAddress ALL gaps in the output.`;
      try {
        const redoRaw2 = await geminiGenerate(redoPrompt, { response_mime_type: 'application/json' });
        finalDrafted = parseDraftedSOP(redoRaw2);
        // Re-score.
        const redoQcInput: QCScorerInput = {
          ...qcInput,
          taskDescription: finalDrafted.description ?? null,
          sopSuccessCriteria: finalDrafted.success_criteria || qcCriteria,
          sopSteps: JSON.stringify(finalDrafted.steps),
        };
        finalQcResult = await scoreTaskForQC(redoQcInput);
      } catch {
        // If redo fails, proceed with original draft and file as pending.
        finalDrafted = drafted;
        finalQcResult = qcResult;
      }
    }

    // After redo: still < 8.5 AND not heuristic → file as pending proposal.
    if (!finalQcResult.pass && finalQcResult.scoringPath !== 'heuristic') {
      const failedProposalId = uuidv4();
      const sources2 = tavily.results.slice(0, 5).map((r) => ({ title: r.title, url: r.url }));
      const failEvidence = [
        `[QC-FAIL ${finalQcResult.score.toFixed(1)}/10 — needs rework]`,
        `Score: ${finalQcResult.score.toFixed(1)}/10 after redo. Gaps: ${finalQcResult.gaps.join('; ') || finalQcResult.reason}`,
        `Research query: ${researchQuery}`,
        ...sources2.map((s, i) => `  [${i + 1}] ${s.title} (${s.url})`),
      ].join('\n');
      try {
        run(
          `INSERT INTO sop_proposals
             (id, proposed_name, proposed_department, draft_steps, based_on_task_ids,
              evidence_summary, status, created_at, confidence, auto_research_attempts, research_sources)
           VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`,
          [
            failedProposalId,
            finalDrafted.name,
            finalDrafted.department || deptSlug,
            JSON.stringify(finalDrafted.steps),
            JSON.stringify([input.originalTaskId]),
            failEvidence,
            new Date().toISOString(),
            finalDrafted.confidence ?? null,
            recentAttempts + 1,
            JSON.stringify(sources2),
          ],
        );
      } catch { /* non-fatal */ }
      emitEvent('sop_authoring_qc_fail_pending', failEvidence, input.originalTaskId);
      return {
        status: 'qc-fail-pending',
        proposal_id: failedProposalId,
        qc_score: finalQcResult.score,
        sub_task_id: subTaskId,
        reason: failEvidence,
      };
    }

    // QC-07: grounding gate BEFORE auto-file. A fluent LLM draft can pass the
    // 8.5 self-score while being ungrounded in the actual research (or produced
    // with no research / sub-floor confidence). Such a draft must never become
    // QC-authoritative ('auto-authored-filed'). If it fails the grounding gate,
    // file it as a pending proposal for human review instead of auto-filing.
    const grounding = groundDraftedSOP(finalDrafted, tavily.results);
    if (!grounding.grounded) {
      const ungroundedProposalId = uuidv4();
      const sourcesG = tavily.results.slice(0, 5).map((r) => ({ title: r.title, url: r.url }));
      const ungroundedEvidence = [
        `[QC-UNGROUNDED — needs human review]`,
        `QC score ${finalQcResult.score.toFixed(1)}/10 passed, but the draft failed the grounding gate.`,
        `Grounding: ${grounding.reason}`,
        grounding.ungroundedSteps.length > 0
          ? `Ungrounded steps: ${grounding.ungroundedSteps.join('; ')}`
          : '',
        `Research query: ${researchQuery}`,
        ...sourcesG.map((s, i) => `  [${i + 1}] ${s.title} (${s.url})`),
      ].filter(Boolean).join('\n');
      try {
        run(
          `INSERT INTO sop_proposals
             (id, proposed_name, proposed_department, draft_steps, based_on_task_ids,
              evidence_summary, status, created_at, confidence, auto_research_attempts, research_sources)
           VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`,
          [
            ungroundedProposalId,
            finalDrafted.name,
            finalDrafted.department || deptSlug,
            JSON.stringify(finalDrafted.steps),
            JSON.stringify([input.originalTaskId]),
            ungroundedEvidence,
            new Date().toISOString(),
            finalDrafted.confidence ?? null,
            recentAttempts + 1,
            JSON.stringify(sourcesG),
          ],
        );
      } catch { /* non-fatal */ }
      emitEvent('sop_authoring_ungrounded_pending', ungroundedEvidence, input.originalTaskId);
      return {
        status: 'qc-ungrounded-pending',
        proposal_id: ungroundedProposalId,
        qc_score: finalQcResult.score,
        sub_task_id: subTaskId,
        reason: ungroundedEvidence,
      };
    }

    // §5: QC passed AND grounded — file to BOTH stores.
    const sopId = uuidv4();
    const fileNow = new Date().toISOString();

    const finalDept = canonicalDeptSlug(finalDrafted.department || deptSlug);
    const finalName = finalDrafted.name.trim();
    const baseSlug =
      finalName
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 60) || `authored-${sopId.slice(0, 8)}`;
    const collision = queryOne<{ id: string }>('SELECT id FROM sops WHERE slug = ? AND deleted_at IS NULL', [baseSlug]);
    const finalSlug = collision ? `${baseSlug}-${sopId.slice(0, 6)}` : baseSlug;

    // F3.9 — emit per-step persona slots for a multi-craft authored SOP so the
    // matcher fills each craft slot with a distinct best-fit persona at task time.
    const stepsWithSlots = emitPersonaSlots(
      finalDrafted.steps as Array<{ name: string; persona_slot?: unknown }>,
    );
    const stepsJson = JSON.stringify(stepsWithSlots);

    const sources3 = tavily.results.slice(0, 5).map((r) => ({ title: r.title, url: r.url }));
    const evidenceSummary = [
      `[QC-PASS ${finalQcResult.score.toFixed(1)}/10]`,
      `Auto-authored SOP for task "${input.title}" (dept: ${finalDept}).`,
      `Research query: ${researchQuery}`,
      `Top sources:`,
      ...sources3.map((s, i) => `  [${i + 1}] ${s.title} (${s.url})`),
    ].join('\n');

    // CC-fixture-002 — this is the highest-trust durable artifact in the system:
    // a row in the canonical `sops` table, filed with source=NULL so it looks
    // organically produced, auto-authored with NO operator approval, after which
    // live tasks are re-pointed at it. Its steps and `evidenceSummary` come from
    // geminiGenerate() + tavilySearch(); with a fixture env var active in the
    // live server process those are canned. Refuse the write.
    //
    // Deliberately OUTSIDE the try below — that catch swallows insert errors
    // into a log line and continues, which would silently defeat the guard.
    assertNoFixtureDerivedServerWrite('a sops row (auto-authored SOP)');

    // §5a: Insert into `sops` table with source=NULL (critical — not 'role-library').
    try {
      run(
        `INSERT INTO sops
           (id, name, slug, description, version, department, role, task_keywords,
            steps, success_criteria, persona_hints, source, created_at, updated_at)
         VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)`,
        [
          sopId,
          finalName,
          finalSlug,
          finalDrafted.description ?? evidenceSummary,
          finalDept,
          input.agentRoleSlug ?? null,
          finalDrafted.task_keywords ?? null,
          stepsJson,
          finalDrafted.success_criteria ?? null,
          fileNow,
          fileNow,
        ],
      );
    } catch (insertErr) {
      const msg = `[sop-authoring] Failed to insert SOP row: ${(insertErr as Error).message}`;
      console.error(msg);
      emitEvent('sop_authoring_db_insert_failed', msg, input.originalTaskId);
      return { status: 'error', reason: msg };
    }

    // §5a: Write an audit trail `sop_proposals` row with status 'auto-authored-filed'.
    const proposalId = uuidv4();
    try {
      run(
        `INSERT INTO sop_proposals
           (id, proposed_name, proposed_department, draft_steps, based_on_task_ids,
            evidence_summary, status, created_at, approved_sop_id, confidence,
            auto_research_attempts, research_sources)
         VALUES (?, ?, ?, ?, ?, ?, 'auto-authored-filed', ?, ?, ?, ?, ?)`,
        [
          proposalId,
          finalName,
          finalDept,
          stepsJson,
          JSON.stringify([input.originalTaskId]),
          evidenceSummary,
          fileNow,
          sopId,
          finalDrafted.confidence ?? null,
          recentAttempts + 1,
          JSON.stringify(sources3),
        ],
      );
    } catch { /* audit trail is non-fatal */ }

    // §5b: Write to on-disk SOP library (custom dept folder).
    if (process.env.SOP_AUTHORING_WRITE_DISK !== '0') {
      const roleSlug = input.agentRoleSlug ?? finalSlug;
      const diskPath = path.join(
        WORKSPACE_BASE,
        'departments',
        finalDept || 'custom',
        roleSlug,
        'how-to.md',
      );
      const howTo = sopToHowToMd({
        name: finalName,
        department: finalDept,
        role: input.agentRoleSlug ?? undefined,
        success_criteria: finalDrafted.success_criteria,
        steps: finalDrafted.steps,
        sources: sources3,
      });
      const diskWrite = safeDiskWrite(diskPath, howTo);
      if (!diskWrite.ok) {
        // Loud warning but DB row already filed — the agent can still use the DB SOP.
        const warnMsg = `[sop-authoring] Disk write failed for ${diskPath}: ${diskWrite.error}`;
        console.warn(warnMsg);
        emitEvent('sop_disk_write_failed', warnMsg, input.originalTaskId);
      }
    }

    // §6: Attach the new sop_id back to the original task.
    try {
      run(
        `UPDATE tasks SET sop_id = ?, updated_at = ? WHERE id = ? AND status = 'backlog'`,
        [sopId, fileNow, input.originalTaskId],
      );
    } catch { /* non-fatal */ }

    // §2: Mark the authoring sub-task as done.
    // DISP-10: this synthetic "Author SOP" sub-task completes from `in_progress`
    // — an edge the lifecycle state machine does NOT model (in_progress→done is
    // not a legal transition, and this write sets `completed_at`), so routing it
    // through transition() would throw ILLEGAL_TRANSITION. We instead use the
    // spec-sanctioned raw-write alternative: a compare-and-swap on the current
    // status, the structured `task_events` audit row (so the audit sink is
    // COMPLETE), and the owner DONE report.
    if (subTaskId) {
      try {
        const subFrom =
          queryOne<{ status: string }>('SELECT status FROM tasks WHERE id = ?', [subTaskId])?.status ??
          'in_progress';
        // U99-RAW-STATUS-WRITER: in_progress→done is not a legal transition()
        // edge (see the DISP-10 note just above) and this write also sets
        // completed_at atomically; audited immediately below via
        // recordStatusEvent.
        const res = run(
          `UPDATE tasks SET status = 'done', completed_at = ?, updated_at = ? WHERE id = ? AND status NOT IN ('done')`,
          [fileNow, fileNow, subTaskId],
        );
        if (res.changes > 0) {
          recordStatusEvent(subTaskId, subFrom, 'done', {
            actor: 'sop-authoring',
            reason: `SOP "${finalName}" authored and filed (QC ${finalQcResult.score.toFixed(1)}/10 PASS)`,
          });
          run(
            `INSERT INTO events (id, type, task_id, message, created_at) VALUES (?, ?, ?, ?, ?)`,
            [
              uuidv4(),
              'task_completed',
              subTaskId,
              `[sop-authoring] SOP "${finalName}" authored and filed. QC: ${finalQcResult.score.toFixed(1)}/10 PASS.`,
              fileNow,
            ],
          );
          // DONE owner report (5-field). Best-effort; gateway-routed; never throws.
          try {
            notifyOwnerDone(subTaskId);
          } catch { /* non-fatal */ }
        }
      } catch { /* non-fatal */ }
    }

    // §6: Re-fire dispatch on the original task now that it has a SOP.
    // Import is deferred to avoid circular dependency at module init time.
    try {
      const { autoDispatchTask } = await import('@/lib/task-dispatcher');
      void autoDispatchTask(input.originalTaskId, 'sop-authored-resume');
    } catch { /* non-fatal */ }

    console.log(
      `[sop-authoring] SOP "${finalName}" (${sopId}) authored and filed for task "${input.title}" (${input.originalTaskId}) — QC ${finalQcResult.score.toFixed(1)}/10 PASS`,
    );

    return {
      status: 'authored',
      sop_id: sopId,
      sub_task_id: subTaskId,
      qc_score: finalQcResult.score,
      proposal_id: proposalId,
    };
  } catch (err) {
    // Fire-and-forget contract: NEVER throw.
    const msg = `[sop-authoring] Unexpected error for task ${input.originalTaskId}: ${(err as Error).message}`;
    console.error(msg);
    return { status: 'error', reason: msg };
  }
}
