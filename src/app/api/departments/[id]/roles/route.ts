/**
 * POST /api/departments/[id]/roles
 *
 * Add a new role to an existing department by invoking the host
 * add-role.sh script (Skill 23). FAILS LOUD if the script is absent —
 * no JS-only role insert, as a role added without _index.json/converge
 * is exactly the broken state this feature fixes.
 *
 * Body: { role: "<name>", description?: string, dept_slug?: string }
 *
 * The [id] path param is the department workspace id (e.g. "podcast").
 * dept_slug overrides it if provided (e.g. when the workspace id has a
 * dept- prefix but the script slug is plain).
 *
 * Response: { success: true, role_slug, dept, agent_id, status }
 *
 * The ---SUMMARY--- parse contract (§3.7) is reused from departments/route.ts.
 */

import { NextRequest, NextResponse } from 'next/server';
import { execFileSync } from 'child_process';
import { existsSync, statSync } from 'fs';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// Locate add-role.sh — mirrors the add-department.sh finder shape (§2.5).
function findAddRoleScript(): string | null {
  const candidates = [
    '/data/.openclaw/skills/23-ai-workforce-blueprint/scripts/add-role.sh',
    `${process.env.HOME}/.openclaw/skills/23-ai-workforce-blueprint/scripts/add-role.sh`,
  ];
  for (const p of candidates) {
    if (existsSync(p) && statSync(p).isFile()) return p;
  }
  return null;
}

// Run add-role.sh and parse its ---SUMMARY--- JSON line.
function runAddRoleScript(args: {
  deptSlug: string;
  role: string;
  description?: string;
}): { ok: boolean; payload?: Record<string, unknown>; stderr?: string } | null {
  const script = findAddRoleScript();
  if (!script) return null;

  const argv = [script, '--dept', args.deptSlug, '--role', args.role];
  if (args.description) argv.push('--description', args.description);

  try {
    const out = execFileSync('bash', argv, { encoding: 'utf-8', timeout: 30_000 });
    const summaryIdx = out.lastIndexOf('---SUMMARY---');
    if (summaryIdx === -1) {
      return { ok: false, stderr: `no ---SUMMARY--- line in script output: ${out.slice(-200)}` };
    }
    const jsonLine = out.slice(summaryIdx + '---SUMMARY---'.length).trim().split('\n')[0];
    const payload = JSON.parse(jsonLine) as Record<string, unknown>;
    return { ok: true, payload };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, stderr: msg };
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const { id } = await params;

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
  const role = (b.role as string | undefined)?.trim() ?? '';
  if (!role) {
    return NextResponse.json(
      { success: false, message: '`role` field is required.' },
      { status: 400 }
    );
  }

  // Resolve dept slug: prefer explicit dept_slug, fall back to [id] param.
  // Normalize away any "dept-" prefix the workspace id may carry.
  const rawDeptSlug = (b.dept_slug as string | undefined)?.trim() || id;
  const deptSlug = rawDeptSlug.replace(/^dept-/, '');

  const description = (b.description as string | undefined)?.trim();

  const scriptResult = runAddRoleScript({ deptSlug, role, description });

  if (scriptResult === null) {
    // Script not found
    return NextResponse.json(
      {
        success: false,
        mode: 'no-host-script',
        message:
          'add-role.sh not found at ' +
          '/data/.openclaw/skills/23-ai-workforce-blueprint/scripts/add-role.sh ' +
          `or ${process.env.HOME}/.openclaw/skills/23-ai-workforce-blueprint/scripts/add-role.sh. ` +
          'A role cannot be added without the full-wire host script. ' +
          'Install Skill 23 on the box or run from the box agent.',
      },
      { status: 503 }
    );
  }

  if (!scriptResult.ok) {
    return NextResponse.json(
      {
        success: false,
        mode: 'script-failed',
        message: scriptResult.stderr ?? 'add-role.sh exited non-zero (no stderr captured).',
      },
      { status: 500 }
    );
  }

  return NextResponse.json(
    { success: true, mode: 'script', ...scriptResult.payload },
    { status: 201 }
  );
}
