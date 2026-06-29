import { NextRequest, NextResponse } from 'next/server';
import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { execFileSync } from 'child_process';
import { randomBytes } from 'crypto';
import { existsSync, statSync } from 'fs';
import { getDb } from '@/lib/db';
import { findCanonicalWorkspaceId } from '@/lib/db/task-dedup';

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

    db.prepare(`
      INSERT INTO tasks (id, workspace_id, department, title, description, status, priority, assigned_agent_id, created_by_agent_id)
      VALUES (?, ?, ?, ?, ?, 'backlog', 'medium', ?, ?)
    `).run(
      taskId, wsId, args.slug,
      `Welcome to ${args.name}`,
      `This is your ${args.name} department's first task. Click to edit. Your AI workforce will populate real tasks as work comes in.`,
      headAgentId, headAgentId,
    );
  });
  tx();

  return { status: 'created', workspace_id: wsId, head_agent_id: headAgentId, starter_task_id: taskId };
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
      const result = createDepartmentInDbDirect({ slug, name, icon, headName, description });
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
