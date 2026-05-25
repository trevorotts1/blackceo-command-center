import { NextRequest, NextResponse } from 'next/server';
import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { execFileSync } from 'child_process';
import { randomBytes } from 'crypto';
import { existsSync, statSync } from 'fs';
import { getDb } from '@/lib/db';

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

// JS-only fallback for steps 1-3 (workspace + head agent + starter task) when
// the host add-department.sh isn't available. Mirrors the script's idempotent
// shape — if the slug already exists, returns status:already_exists.
function createDepartmentInDbDirect(args: {
  slug: string;
  name: string;
  icon: string;
  headName: string;
  description: string;
}): { status: 'created' | 'already_exists'; workspace_id: string; head_agent_id?: string; starter_task_id?: string } {
  const db = getDb();

  // Idempotency check
  const existing = db.prepare('SELECT id FROM workspaces WHERE slug = ? OR id = ?').get(args.slug, args.slug) as { id: string } | undefined;
  if (existing) {
    return { status: 'already_exists', workspace_id: existing.id };
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

    db.prepare(`
      INSERT INTO agents (id, workspace_id, name, role, description, specialist_type, status, avatar_emoji, is_master)
      VALUES (?, ?, ?, ?, ?, 'permanent', 'standby', ?, 0)
    `).run(
      headAgentId, wsId, args.headName,
      `${args.name} Department Head`,
      `Heads the ${args.name} department in your AI workforce.`,
      args.icon,
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
//   1. CREATE  — body = { create: true, slug, name, icon?, headName?, description? }
//                Adds a NEW department: workspace row + head agent + starter task
//                + role-library upsert + openclaw.json binding placeholder
//                + brand.css regen + persona-stale marker.
//                Calls the host add-department.sh script when available; falls
//                back to a JS-only path (steps 1-3) when not.
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
  if (b.create === true || (typeof b.slug === 'string' && typeof b.name === 'string' && !b.id)) {
    const rawSlug = (b.slug as string | undefined)?.trim() ?? '';
    const name    = (b.name as string | undefined)?.trim() ?? '';
    if (!rawSlug || !name) {
      return NextResponse.json(
        { success: false, message: 'CREATE mode requires both `slug` and `name`.' },
        { status: 400 }
      );
    }

    // Normalize slug (mirror add-department.sh)
    const slug = rawSlug.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    if (!slug) {
      return NextResponse.json(
        { success: false, message: 'slug normalized to empty. Provide a valid slug.' },
        { status: 400 }
      );
    }

    const icon        = (typeof b.icon === 'string'        && b.icon)        || '📁';
    const headName    = (typeof b.headName === 'string'    && b.headName)    || `${name} Lead`;
    const description = (typeof b.description === 'string' && b.description) || `${name} department workspace`;

    // Prefer the host script (does the full chain — role-library, openclaw.json,
    // brand.css, persona-stale marker). Fall back to JS-only steps 1-3 if not.
    const scriptResult = runAddDepartmentScript({ slug, name, icon, headName, description });

    if (scriptResult && scriptResult.ok) {
      return NextResponse.json(
        { success: true, mode: 'script', department: scriptResult.payload },
        { status: 201 }
      );
    }

    // Fall back to direct DB writes (steps 1-3 only — role-library and
    // openclaw.json binding aren't reachable from inside Next.js without the
    // host script). This still yields a usable dashboard entry.
    try {
      const result = createDepartmentInDbDirect({ slug, name, icon, headName, description });
      return NextResponse.json(
        {
          success: true,
          mode: 'direct',
          department: result,
          note: scriptResult
            ? `host script present but failed: ${scriptResult.stderr ?? 'unknown'}. Fell back to JS-only path (steps 1-3 only; role-library / openclaw.json / brand.css NOT updated).`
            : 'host add-department.sh not found at /data/.openclaw/skills/32-command-center-setup/scripts/add-department.sh. Fell back to JS-only path (steps 1-3 only).',
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
