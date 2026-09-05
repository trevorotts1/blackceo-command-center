import { resolveTenantContext, tenantRegistration, TenantAccessError } from '@/lib/auth/tenant-context';

/** Shared dashboards may only access the registered client's own installation. */
export async function proxyTenantBoard(request: Request, segments: string[]): Promise<Response> {
  try {
    const context = await resolveTenantContext(request);
    if (context.kind !== 'client') return Response.json({ error: 'client_target_required' }, { status: 403 });
    const registration = tenantRegistration(context.host) as ReturnType<typeof tenantRegistration> & { remoteApiToken?: string };
    if (!registration.remoteUrl || !registration.remoteApiToken) {
      return Response.json({ error: 'client_board_unavailable', message: 'Your own Command Center connection is not configured.' }, { status: 503 });
    }
    const target = new URL(registration.remoteUrl);
    if (target.hostname === context.host || target.username || target.password || target.search || target.hash ||
      (target.protocol !== 'https:' && !(process.env.NODE_ENV !== 'production' && target.protocol === 'http:'))) {
      return Response.json({ error: 'invalid_client_board_target' }, { status: 503 });
    }
    if (!segments.length || segments.some(p => p === '.' || p === '..' || p.includes('/') || p.includes('\\'))) {
      return Response.json({ error: 'invalid_board_path' }, { status: 400 });
    }
    target.pathname = `${target.pathname.replace(/\/$/, '')}/api/${segments.map(encodeURIComponent).join('/')}`;
    target.search = new URL(request.url).search;
    const headers = new Headers({ authorization: `Bearer ${registration.remoteApiToken}` });
    for (const name of ['content-type', 'accept', 'last-event-id', 'idempotency-key']) {
      const value = request.headers.get(name); if (value) headers.set(name, value);
    }
    headers.set('x-expected-installation-id', context.installationId);
    const response = await fetch(target, {
      method: request.method, headers, redirect: 'manual', cache: 'no-store',
      body: ['GET', 'HEAD'].includes(request.method) ? undefined : await request.arrayBuffer(),
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(90_000)]),
    });
    // Never follow or expose a redirect to another client's/login destination.
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      return Response.json({ error: 'client_board_redirect_refused' }, { status: 502 });
    }
    const returnedInstallation = response.headers.get('x-installation-id');
    if (returnedInstallation !== context.installationId) {
      await response.body?.cancel();
      return Response.json({ error: 'client_installation_identity_mismatch' }, { status: 502 });
    }
    const outgoing = new Headers({ 'cache-control': 'private, no-store' });
    for (const name of ['content-type', 'content-disposition', 'retry-after']) {
      const value = response.headers.get(name); if (value) outgoing.set(name, value);
    }
    return new Response(response.body, { status: response.status, headers: outgoing });
  } catch (error) {
    if (error instanceof TenantAccessError) return Response.json({ error: 'forbidden' }, { status: 403 });
    return Response.json({ error: 'client_board_unavailable', message: 'Your Command Center could not be reached. Retry when the connection is restored.' }, { status: 503 });
  }
}
