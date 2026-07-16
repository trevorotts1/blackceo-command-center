import { NextRequest, NextResponse } from 'next/server';
import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { execFileSync } from 'child_process';
import { randomBytes } from 'crypto';
import { existsSync, statSync } from 'fs';
import { getDb } from '@/lib/db';
import { findCanonicalWorkspaceId } from '@/lib/db/task-dedup';
import { getSession } from '@/lib/interview/store';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const DEPARTMENTS_CONFIG_PATH = join(process.cwd(), 'config', 'departments.json');

interface DepartmentEntry {
  id: string;
  emoji: string;
  name: string;
  headTitle: string;
}

async function readDepartments(): Promise<DepartmentEntry[]> {
  const raw = await readFile(DEPARTMENTS_CONFIG_PATH, 'utf-8');
  return JSON.parse(raw) as DepartmentEntry[];
}

// GET /api/departments — return current department list
export async function GET() {
  try {
    const departments = await readDepartments();
    return NextResponse.json({ success: true, departments });
  } catch {
    return NextResponse.json(
      { success: false, message: 'Failed to load departments configuration.' },
      { status: 500 }
    );
  }
}

// Locate the add-department.sh host script. The script ships in skill 32 under
// 32-command-center-setup/scripts/add-department.sh. When the dashboard runs
// inside the OpenClaw container, the skill payload lives under
// /data/.openclaw/skills/32-command-center-setup/scripts/. Fall back to a
// $HOME-relative path for Mac dev installs.
function findAddDepartmentScript(): string | null {
  const candidates = [
    '/data/.openclaw/skills/32-command-center-setup/scripts/add-department.sh',
    `${process.env.HOME}/.openclaw/skills/32-command-center-setup/scripts/add-department.sh`,
  ];
  for (const p of candidates) {
    if (existsSync(p) && statSync(p).isFile()) return p;
  }
  return null;
}

// Run the host add-department.sh script and parse its JSON summary line.
// Returns null if the script isn't present (caller will fall back to JS-only path).
function runAddDepartmentScript(args: {
  slug: string;
  name: string;
  icon?: string;
  headName?: string;
  description?: string;
}): { ok: boolean; payload?: Record<string, unknown>; stderr?: string } | null {
  const script = findAddDepartmentScript();
  if (!script) return null;

  const argv = [script, '--slug', args.slug, '--name', args.name];
  if (args.icon)        argv.push('--icon', args.icon);
  if (args.headName)    argv.push('--head-name', args.headName);
  if (args.description) argv.push('--description', args.description);

  try {
    const out = execFileSync('bash', argv, { encoding: 'utf-8', timeout: 30_000 });
    // The script prints a `---SUMMARY---` line followed by a JSON payload.
    const summaryIdx = out.lastIndexOf('---SUMMARY---');
    if (summaryIdx === -1) {
      return { ok: false, stderr: `no summary line in script output: ${out.slice(-200)}` };
    }
    const jsonLine = out.slice(summaryIdx + '---SUMMARY---'.length).trim().split('\n')[0];
    const payload = JSON.parse(jsonLine) as Record<string, unknown>;
    return { ok: true, payload };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, stderr: msg };
  }
}

// JS-only path for steps 1-3 (workspace + head agent + starter task).
// Only used when allow_unwired=true is explicitly passed. Default behavior is
// to FAIL LOUD when the host add-department.sh is absent or fails (§2.4).
// Mirrors the script's idempotent shape — if the slug already exists, returns
// status:already_exists.
function createDepartmentInDbDirect(args: {
  slug: string;
  name: string;
  icon: string;
  headName: string;
  description: string;
  /**
   * U94 (X.2.3) — "interview flows" is one of three enumerated requester-
   * stamping doors. This JS-only fallback path is the ONLY department/
   * starter-task creation surface this repo owns (the primary path shells
   * out to add-department.sh, which lives in Skill 32 — outside this repo).
   * When the caller resolved a live interview session (see POST handler
   * below), the client identity that session captured is threaded through
   * here so the starter task can be reported on by the trust engine like any
   * other client-initiated task. Both null when no session was resolved —
   * the starter task then correctly stays unstamped (operator-digest
   * fallback), exactly like a producer-created task.
   */
  requesterChannel?: string | null;
  requesterChatId?: string | null;
}): { status: 'created' | 'already_exists'; workspace_id: string; head_agent_id?: string; starter_task_id?: string } {
  const db = getDb();

  // Idempotency check (exact slug/id).
  const existing = db.prepare('SELECT id FROM workspaces WHERE slug = ? OR id = ?').get(args.slug, args.slug) as { id: string } | undefined;
  if (existing) {
    return { status: 'already_exists', workspace_id: existing.id };
  }
  // Slug-uniqueness guard (FM-6): also treat a slug that CANONICALIZES to an
  // existing department as already-present (e.g. creating `ceo` when
  // `master-orchestrator` exists), so even the operator override path can never
  // split one department across two Kanban columns.
  const canonOwner = findCanonicalWorkspaceId(db, args.slug);
  if (canonOwner) {
    return { status: 'already_exists', workspace_id: canonOwner };
  }

  const wsId = args.slug;
  const headAgentId = randomBytes(8).toString('hex');
  const taskId      = randomBytes(8).toString('hex');

  const maxOrder = (db.prepare('SELECT MAX(sort_order) as max_order FROM workspaces').get() as { max_order: number | null }).max_order;
  const nextOrder = (maxOrder || 0) + 10;

  let starterTaskId = taskId;

  const tx = db.transaction(() => {
    db.prepare(`
      INSERT INTO workspaces (id, name, slug, description, icon, sort_order)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(wsId, args.name, args.slug, args.description, args.icon, nextOrder);

    // is_master=1 for the master-orchestrator / CEO department head; 0 for all others.
    // This ensures the master-fallback in comDispatch actually resolves.
    const isMasterOrchestrator =
      args.slug === 'master-orchestrator' ||
      args.slug === 'ceo' ||
      args.slug === 'ceo-com';
    db.prepare(`
      INSERT INTO agents (id, workspace_id, name, role, description, specialist_type, status, avatar_emoji, is_master)
      VALUES (?, ?, ?, ?, ?, 'permanent', 'standby', ?, ?)
    `).run(
      headAgentId, wsId, args.headName,
      `${args.name} Department Head`,
      `Heads the ${args.name} department in your AI workforce.`,
      args.icon,
      isMasterOrchestrator ? 1 : 0,
    );

    // FM-6: idempotency guard — skip the INSERT if a starter task already exists
    // for this workspace (e.g. a parallel request, an external script, or a
    // previous transaction that rolled back after the workspace was committed).
    // Matches on the deterministic title + workspace_id pair — the natural key
    // without requiring a schema change.
    const existingStarterTask = db.prepare(
      `SELECT id FROM tasks WHERE workspace_id = ? AND title = ? LIMIT 1`
    ).get(wsId, `Welcome to ${args.name}`) as { id: string } | undefined;
    if (existingStarterTask) {
      starterTaskId = existingStarterTask.id;
    } else {
      const requesterChannel = args.requesterChatId ? (args.requesterChannel || 'telegram') : null;
      const requesterChatId = args.requesterChatId || null;
      db.prepare(`
        INSERT INTO tasks (id, workspace_id, department, title, description, status, priority, assigned_agent_id, created_by_agent_id, requester_channel, requester_chat_id)
        VALUES (?, ?, ?, ?, ?, 'backlog', 'medium', ?, ?, ?, ?)
      `).run(
        taskId, wsId, args.slug,
        `Welcome to ${args.name}`,
        `This is your ${args.name} department's first task. Click to edit. Your AI workforce will populate real tasks as work comes in.`,
        headAgentId, headAgentId,
        requesterChannel, requesterChatId,
      );

      // U94 (X.2.3) — trust-coverage instrumentation, "interview flows" door.
      // Same non-circular signal createTaskCore writes for its own three
      // doors (see src/lib/tasks.ts): only recorded when this creation
      // ACTUALLY came through a resolved interview session (requesterChatId
      // set on the args this function received), independent of whether the
      // stamp above landed. A plain operator "add department" with no
      // session is a producer/operator create and is deliberately NOT
      // tagged — excluded from the coverage denominator, not counted
      // against it. Best-effort: never fails department creation.
      if (args.requesterChatId) {
        try {
          db.prepare(
            `INSERT INTO events (id, type, task_id, message, metadata, created_at)
             VALUES (?, 'requester_stamp_check', ?, ?, ?, datetime('now'))`
          ).run(
            randomBytes(8).toString('hex'),
            taskId,
            `requester_stamp_check: door=interview-department-provision hasRequester=${!!requesterChatId}`,
            JSON.stringify({ door: 'interview-department-provision', hasRequester: !!requesterChatId }),
          );
        } catch (err) {
          console.warn('[createDepartmentInDbDirect] requester_stamp_check telemetry failed (non-fatal):', err);
        }
      }
    }
  });
  tx();

  return { status: 'created', workspace_id: wsId, head_agent_id: headAgentId, starter_task_id: starterTaskId };
}

// POST /api/departments
//
// TWO modes (dispatched on body shape):
//   1. CREATE  — body = { create: true, name, slug?, icon?, headName?, description? }
//                Adds a NEW department: workspace row + head agent + starter task
//                + role-library upsert + openclaw.json binding placeholder
//                + brand.css regen + persona-stale marker.
//                Requires the host add-department.sh script (Skill 32). FAILS LOUD
//                (409/500) if the script is absent or fails — no unwired JS fallback.
//
//                Optional: { allow_unwired: true } enables the legacy JS-only path
//                (steps 1-3 only, role-library/openclaw.json/brand.css NOT updated).
//                Off by default — only for explicit operator override.
//
//   2. UPDATE  — body = { id, name?, emoji?, headTitle? }
//                Pre-existing behavior — edits an entry in config/departments.json.
export async function POST(request: NextRequest) {
  let body: unknown;

  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { success: false, message: 'Invalid JSON body.' },
      { status: 400 }
    );
  }

  const b = body as Record<string, unknown>;

  // ─── CREATE mode ──────────────────────────────────────────────────────────
  if (b.create === true || (typeof b.name === 'string' && !b.id && (b.create === true || typeof b.slug === 'string'))) {
    const name = (b.name as string | undefined)?.trim() ?? '';
    if (!name) {
      return NextResponse.json(
        { success: false, message: 'CREATE mode requires `name`.' },
        { status: 400 }
      );
    }

    // Normalize slug — derive from name if not provided (mirror add-department.sh)
    const rawSlug = ((b.slug as string | undefined)?.trim()) || name;
    const slug = rawSlug.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    if (!slug) {
      return NextResponse.json(
        { success: false, message: 'slug normalized to empty. Provide a valid name or slug.' },
        { status: 400 }
      );
    }

    const icon        = (typeof b.icon === 'string'        && b.icon)        || '📁';
    const headName    = (typeof b.headName === 'string'    && b.headName)    || `${name} Lead`;
    const description = (typeof b.description === 'string' && b.description) || `${name} department workspace`;
    const allowUnwired = b.allow_unwired === true;

    // U94 (X.2.3) — "interview flows" requester-stamping door. Optional:
    // when the caller (the interview-completion flow) names the live
    // interview session this provisioning call is acting on behalf of, we
    // resolve the client identity that session already captured (owner_id +
    // channel — the exact fields interview-nudge-sweep.ts already reuses for
    // its own owner re-engagement send) so the starter task this creates can
    // be reported on by the trust engine. Best-effort: an unresolvable /
    // absent session id leaves the starter task correctly unstamped, never
    // blocks department creation.
    const interviewSessionId =
      typeof b.interviewSessionId === 'string' ? b.interviewSessionId.trim() : '';
    let sessionRequesterChannel: string | null = null;
    let sessionRequesterChatId: string | null = null;
    if (interviewSessionId) {
      try {
        const session = getSession(interviewSessionId);
        if (session?.owner_id) {
          sessionRequesterChatId = session.owner_id;
          sessionRequesterChannel = session.channel || 'telegram';
        }
      } catch (err) {
        console.warn('[/api/departments] interview session lookup failed (non-fatal):', err);
      }
    }

    // Require the host script (full-wire path). FAIL LOUD if absent.
    const scriptResult = runAddDepartmentScript({ slug, name, icon, headName, description });

    if (scriptResult && scriptResult.ok) {
      return NextResponse.json(
        { success: true, mode: 'script', department: scriptResult.payload },
        { status: 201 }
      );
    }

    // Script absent or failed — FAIL LOUD unless allow_unwired is explicitly set.
    if (!allowUnwired) {
      if (!scriptResult) {
        // Script not found at any candidate path
        const candidates = [
          '/data/.openclaw/skills/32-command-center-setup/scripts/add-department.sh',
          `${process.env.HOME}/.openclaw/skills/32-command-center-setup/scripts/add-department.sh`,
        ];
        return NextResponse.json(
          {
            success: false,
            mode: 'no-host-script',
            message:
              `add-department.sh not found at ${candidates.join(' or ')}. ` +
              'A department cannot be created without the full-wire host script. ' +
              'Run from the box agent or install Skill 32. ' +
              'To bypass (not recommended), pass { allow_unwired: true } in the request body.',
          },
          { status: 503 }
        );
      } else {
        // Script was found but exited non-zero
        return NextResponse.json(
          {
            success: false,
            mode: 'script-failed',
            message: scriptResult.stderr ?? 'add-department.sh exited non-zero (no stderr captured).',
          },
          { status: 500 }
        );
      }
    }

    // allow_unwired=true: legacy JS-only path (explicit operator override only)
    try {
      const result = createDepartmentInDbDirect({
        slug, name, icon, headName, description,
        requesterChannel: sessionRequesterChannel,
        requesterChatId: sessionRequesterChatId,
      });
      return NextResponse.json(
        {
          success: true,
          mode: 'direct',
          department: result,
          note: scriptResult
            ? `host script present but failed: ${scriptResult.stderr ?? 'unknown'}. allow_unwired=true: fell back to JS-only path (steps 1-3 only; role-library / openclaw.json / brand.css NOT updated).`
            : 'host add-department.sh not found. allow_unwired=true: fell back to JS-only path (steps 1-3 only).',
        },
        { status: 201 }
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return NextResponse.json(
        { success: false, message: `Failed to create department: ${msg}` },
        { status: 500 }
      );
    }
  }

  // ─── UPDATE mode (pre-existing behavior) ──────────────────────────────────
  const { id, name, emoji, headTitle } = b as Partial<DepartmentEntry>;

  if (!id || typeof id !== 'string') {
    return NextResponse.json(
      { success: false, message: 'Missing required field: id' },
      { status: 400 }
    );
  }

  if (name !== undefined && typeof name !== 'string') {
    return NextResponse.json(
      { success: false, message: 'Field "name" must be a string.' },
      { status: 400 }
    );
  }

  if (emoji !== undefined && typeof emoji !== 'string') {
    return NextResponse.json(
      { success: false, message: 'Field "emoji" must be a string.' },
      { status: 400 }
    );
  }

  if (headTitle !== undefined && typeof headTitle !== 'string') {
    return NextResponse.json(
      { success: false, message: 'Field "headTitle" must be a string.' },
      { status: 400 }
    );
  }

  try {
    const departments = await readDepartments();
    const index = departments.findIndex((d) => d.id === id);

    if (index === -1) {
      return NextResponse.json(
        { success: false, message: `Department with id "${id}" not found.` },
        { status: 404 }
      );
    }

    // Apply updates
    if (name !== undefined) departments[index].name = name.trim();
    if (emoji !== undefined) departments[index].emoji = emoji.trim();
    if (headTitle !== undefined) departments[index].headTitle = headTitle.trim();

    await writeFile(DEPARTMENTS_CONFIG_PATH, JSON.stringify(departments, null, 2), 'utf-8');

    return NextResponse.json({
      success: true,
      message: 'Department updated successfully.',
      department: departments[index],
    });
  } catch {
    return NextResponse.json(
      { success: false, message: 'Failed to save departments configuration.' },
      { status: 500 }
    );
  }
}
