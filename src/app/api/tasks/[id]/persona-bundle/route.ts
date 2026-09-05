import { NextRequest, NextResponse } from 'next/server';
import { timingSafeEqual } from 'crypto';
import { requestHost, tenantRegistration, verifyTenantGrant, TENANT_SESSION_COOKIE } from '@/lib/auth/tenant-context';
import { getDb, queryOne } from '@/lib/db';
import { assertTaskCompany, TaskAgentAccessError } from '@/lib/task-agent-assignment';
import type { PersonaBundle, TaskPersonaBundleRow } from '@/lib/types';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/** Both producer bearer reads and browser sessions are tenant/company scoped.
 * Origin, Referer and unsigned identity headers never authenticate this route.
 * Shared-client reads belong at the registered receiver via tenant-board proxy.
 */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

async function authenticate(request: NextRequest): Promise<string | null> {
  try {
    const host = requestHost(request);
    const registration = tenantRegistration(host);
    const authorization = request.headers.get('authorization');
    if (authorization) {
      const token = process.env.MC_API_TOKEN;
      if (!token || !authorization.startsWith('Bearer ') || !safeEqual(authorization.slice(7), token)) return null;
    } else {
      const grant = await verifyTenantGrant(request.cookies.get(TENANT_SESSION_COOKIE)?.value ?? null, host, 'session');
      if (!grant) return null;
    }
    // Middleware proxies these requests; the local handler must not serve an
    // operator DB when called directly with a shared-client registration.
    return registration.kind === 'self' &&
      (!process.env.MC_INSTALLATION_ID || registration.installationId === process.env.MC_INSTALLATION_ID)
      ? registration.companyId : null;
  } catch {
    return null;
  }
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const companyId = await authenticate(request);
    if (!companyId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { id } = await params;

    assertTaskCompany(getDb(), id, companyId);

    const row = queryOne<TaskPersonaBundleRow>(
      'SELECT * FROM task_persona_bundle WHERE task_id = ?',
      [id],
    );

    // No bundle yet (task never ran through resolvePersonaAndPin /
    // pinProducerPersonaBundle) — a real, expected state, not an error. The
    // caller's fetch_persona_bundle() treats any falsy/absent bundle as "not
    // fetched" and falls through to its local rung, so 200 + null is exactly
    // as fail-soft as a 404 for that caller while staying more diagnosable
    // for a human hitting this route directly (distinguishes "no bundle yet"
    // from "unknown task id" / "route not shipped on this box").
    if (!row) {
      return NextResponse.json(
        { task_id: id, bundle: null, confirm_state: null, catalog_version: null, client_persona_id: null, client_persona_source: null, client_persona_set_at: null },
        { status: 200 },
      );
    }

    let bundle: PersonaBundle | null;
    try {
      bundle = JSON.parse(row.bundle_json) as PersonaBundle;
    } catch {
      // Stored JSON is corrupt — fail loud rather than handing the caller a
      // bundle it cannot trust.
      return NextResponse.json(
        { error: 'Stored persona bundle is malformed' },
        { status: 500 },
      );
    }

    return NextResponse.json(
      {
        task_id: id,
        bundle,
        confirm_state: row.confirm_state,
        catalog_version: row.catalog_version,
        client_persona_id: row.client_persona_id ?? null,
        client_persona_source: row.client_persona_source ?? null,
        client_persona_set_at: row.client_persona_set_at ?? null,
      },
      { status: 200 },
    );
  } catch (error) {
    if (error instanceof TaskAgentAccessError) return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    console.error('[tasks persona-bundle] Failed to read persona bundle:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
